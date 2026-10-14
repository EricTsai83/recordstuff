//! One recording on macOS: an `SCStream` started at `prepare`, whose frames are only kept (the newest one) until
//! `record`, then encoded and written until `stop`. Preparing first is what lets main count down without capturing
//! (plan 040) while the permission prompt, the display and both encoders are already checked.
//!
//! ScreenCaptureKit delivers a frame only when the screen changes. At `record` the newest frame is encoded at the
//! recording's start, so the file starts with a picture however still the screen is, and while nothing changes the
//! last frame is encoded again every second, so a key frame still comes every second and fragments keep closing.
//! Capture is asked for four times the frame rate and `Pacer` keeps one frame per slot (see pacing.rs).
//!
//! `stop` ends both tracks at the moment it is called: frames after it are left out, and capture keeps running until
//! the sound up to that moment has arrived (ScreenCaptureKit hands audio over a few tens of milliseconds late), so the
//! audio track is exactly as long as the video's.

use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicU64, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_core_audio_types::{kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved};
use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_media::{CMAudioFormatDescriptionGetStreamBasicDescription, CMSampleBuffer, CMTime, CMTimeFlags};
use objc2_core_video::CVImageBuffer;
use objc2_foundation::{NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCFrameStatus, SCStream, SCStreamConfiguration, SCStreamDelegate, SCStreamFrameInfoStatus, SCStreamOutput, SCStreamOutputType,
};

use super::audio::AacEncoder;
use super::content::{self, describe};
use super::video::{VideoEncoder, VideoSink};
use super::{CaptureError, Unsent, host_ns, now_ns};
use crate::pacing::Pacer;
use crate::timing::{AudioAligner, NANOS_PER_SECOND};
use crate::writer::{self, AudioSpec, Media, WriteFailure, WriterConfig, WriterEvent};

const PREPARED: u8 = 0;
const RECORDING: u8 = 1;
/// `stop` was called: capture still runs until the sound before the stop has arrived; nothing after it is kept.
const DRAINING: u8 = 3;
const STOPPING: u8 = 2;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
/// 10 ms: how far an audio buffer's time may disagree with the sample count before it is corrected.
const AUDIO_TOLERANCE_FRAMES: u64 = 480;
/// While the screen stays still, the last frame is encoded again this often.
const REFRESH_NS: u64 = NANOS_PER_SECOND;
const START_TIMEOUT: Duration = Duration::from_secs(10);
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(3);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `stop` waits for the sound up to the stop; what has not come by then is silence.
const DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const FINISH_TIMEOUT: Duration = Duration::from_secs(120);
/// kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, what VideoToolbox encodes without converting.
const PIXEL_FORMAT_420V: u32 = u32::from_be_bytes(*b"420v");

/// What the session tells its owner while it runs. Called from capture, encoder and writer threads.
pub trait Events: Send + Sync {
    fn progress(&self, bytes: u64);
    fn write_failed(&self, failure: WriteFailure);
    /// Capture ended without a stop: `capture_failed` while recording, `capture_start_failed` while prepared.
    fn capture_failed(&self, code: &'static str, detail: String);
}

pub struct PrepareRequest {
    pub display_id: u32,
    pub width: u32,
    pub height: u32,
    /// The frame rate setting: the encoder's rate control and `Pacer`'s grid.
    pub frame_rate: u32,
    pub video_bitrate: u32,
    pub audio_bitrate: u32,
    pub own_pids: Vec<i32>,
    pub hide_system_ui: bool,
    pub path: PathBuf,
}

pub struct Prepared {
    pub width: u32,
    pub height: u32,
    pub sample_rate: u32,
    pub channels: u32,
    pub priming_frames: u32,
    pub excluded_apps: usize,
    pub hidden_windows: usize,
    pub warnings: Vec<String>,
    /// Where preparing spent its time, for the log.
    pub timings: String,
}

pub struct Stopped {
    pub bytes: u64,
    pub fragmented: Option<String>,
    pub finalize_ms: f64,
    /// How long the sound up to the stop took to arrive, and how much of it was filled with silence.
    pub drain_ms: f64,
    pub drain_padded_frames: u64,
    /// How far ahead of the host clock frames were stamped when handed over, on average and at most.
    pub frame_lead_ms: (f64, f64),
}

/// The source's size in pixels, for choosing the output size before `prepare`.
pub fn probe(display_id: u32) -> Result<(u32, u32), CaptureError> {
    let content = content::shareable_content()?;
    // Kept for the `prepare` that follows.
    content::remember(&content);
    let display = content::find_display(&content, display_id)?;
    let filter = content::filter(&content, &display, &[], false);
    let scale = content::point_pixel_scale(&filter.filter).max(1.0);
    let width = (unsafe { display.width() } as f64 * scale).round() as u32;
    let height = (unsafe { display.height() } as f64 * scale).round() as u32;
    Ok((width, height))
}

struct Frame {
    image: CFRetained<CVImageBuffer>,
}
unsafe impl Send for Frame {}

struct VideoState {
    encoder: Option<VideoEncoder>,
    last: Option<Frame>,
    last_encoded_ns: u64,
    /// Set once the first frame is encoded; until then no captured frame is.
    pacer: Option<Pacer>,
    /// The newest frame was left out by the pacer and is still to be encoded at its slot.
    pending: bool,
    /// When the newest frame was captured.
    last_pts: u64,
}

struct AudioState {
    encoder: Option<AacEncoder>,
    aligner: Option<AudioAligner>,
    priming: u32,
    scratch: Vec<f32>,
}

impl AudioState {
    /// Changes the cutoff; taking `&mut self` means the audio lock is held.
    fn audio_target_set(&mut self, target: &AtomicU64, frames: u64) {
        target.store(frames, Ordering::Release);
    }
}

struct Shared {
    events: Arc<dyn Events>,
    phase: AtomicU8,
    t0_ns: AtomicU64,
    failed: AtomicBool,
    video: Mutex<VideoState>,
    audio: Mutex<AudioState>,
    writer: Mutex<Option<writer::MediaSender>>,
    frames_seen: AtomicU64,
    frame_rate: u32,
    /// Host time of `stop`; nothing captured after it is kept. `u64::MAX` until then.
    stop_ns: AtomicU64,
    /// Audio frames the recording holds up to the stop, counted from t0; `u64::MAX` until then.
    audio_target: AtomicU64,
    /// How far ahead of the host clock frames are stamped when handed over, in microseconds, while recording.
    lead_sum_us: AtomicI64,
    lead_count: AtomicU64,
    lead_max_us: AtomicI64,
}

impl Shared {
    fn send(&self, media: Media) {
        if let Some(writer) = self.writer.lock().unwrap().as_ref() {
            writer.send(media);
        }
    }

    fn fail(&self, detail: String) {
        if self.failed.swap(true, Ordering::AcqRel) || self.phase.load(Ordering::Acquire) == STOPPING {
            return;
        }
        let code = if matches!(self.phase.load(Ordering::Acquire), RECORDING | DRAINING) { "capture_failed" } else { "capture_start_failed" };
        self.events.capture_failed(code, detail);
    }

    fn sample(&self, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
        if kind == SCStreamOutputType::Screen {
            self.screen(sample);
        } else if kind == SCStreamOutputType::Audio {
            if let Err(detail) = self.sound(sample) {
                self.fail(detail);
            }
        }
    }

    fn screen(&self, sample: &CMSampleBuffer) {
        if unsafe { frame_status(sample) } != Some(SCFrameStatus::Complete.0) {
            return;
        }
        let Some(image) = (unsafe { sample.image_buffer() }) else { return };
        let pts = host_ns(unsafe { sample.presentation_time_stamp() });
        self.frames_seen.fetch_add(1, Ordering::Relaxed);
        if self.phase.load(Ordering::Acquire) == RECORDING {
            let lead = (pts as i64 - now_ns() as i64) / 1000;
            self.lead_sum_us.fetch_add(lead, Ordering::Relaxed);
            self.lead_count.fetch_add(1, Ordering::Relaxed);
            self.lead_max_us.fetch_max(lead, Ordering::Relaxed);
        }
        let mut guard = self.video.lock().unwrap();
        let video = &mut *guard;
        let phase = self.phase.load(Ordering::Acquire);
        let eligible = matches!(phase, RECORDING | DRAINING) && pts > video.last_encoded_ns && pts <= self.stop_ns.load(Ordering::Acquire);
        let wanted = eligible && video.pacer.as_mut().is_some_and(|pacer| pacer.admit(pts));
        video.pending = eligible && !wanted && video.pacer.is_some();
        if wanted {
            if let Some(encoder) = video.encoder.as_ref() {
                if let Err(detail) = encoder.encode(&image, pts, false) {
                    drop(guard);
                    self.fail(detail);
                    return;
                }
            }
            video.last_encoded_ns = pts;
        }
        video.last = Some(Frame { image });
        video.last_pts = pts;
    }

    fn sound(&self, sample: &CMSampleBuffer) -> Result<(), String> {
        if !matches!(self.phase.load(Ordering::Acquire), RECORDING | DRAINING) {
            return Ok(());
        }
        let format = unsafe { sample.format_description() }.ok_or("audio without a format")?;
        let asbd = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&format).as_ref() }.ok_or("audio without a stream description")?;
        if asbd.mFormatFlags & kAudioFormatFlagIsFloat == 0 || asbd.mBitsPerChannel != 32 {
            return Err(format!("unexpected audio sample format (flags {:#x}, {} bits)", asbd.mFormatFlags, asbd.mBitsPerChannel));
        }
        if asbd.mSampleRate as u32 != SAMPLE_RATE {
            return Err(format!("audio arrived at {} Hz instead of {SAMPLE_RATE}", asbd.mSampleRate));
        }
        let channels = asbd.mChannelsPerFrame.max(1) as usize;
        let planar = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0;
        let frames = unsafe { sample.num_samples() }.max(0) as usize;
        if frames == 0 {
            return Ok(());
        }
        let pts = host_ns(unsafe { sample.presentation_time_stamp() });

        // Copied out of the block buffer, as OBS does: planar data holds each channel's frames in turn.
        // (CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer refused ScreenCaptureKit's buffers with -12737.)
        let block = unsafe { sample.data_buffer() }.ok_or("audio without data")?;
        let bytes = unsafe { block.data_length() };
        if bytes != frames * channels * 4 {
            return Err(format!("audio holds {bytes} bytes for {frames} frames of {channels} channel(s)"));
        }
        let mut samples = vec![0f32; frames * channels];
        let status = unsafe { block.copy_data_bytes(0, bytes, std::ptr::NonNull::new_unchecked(samples.as_mut_ptr().cast())) };
        if status != 0 {
            return Err(format!("audio could not be read: {status}"));
        }
        let second = usize::from(channels > 1);
        let channel = |frame: usize, which: usize| if planar { samples[which * frames + frame] } else { samples[frame * channels + which] };

        let mut guard = self.audio.lock().unwrap();
        let audio = &mut *guard;
        let t0 = self.t0_ns.load(Ordering::Acquire);
        // Input frame n is what played at t0 + n / rate; the file's edit list skips the encoder's priming, so sound at
        // presentation time t is what played at t0 + t.
        let aligner = audio.aligner.get_or_insert_with(|| AudioAligner::new(SAMPLE_RATE, t0, AUDIO_TOLERANCE_FRAMES));
        let placement = aligner.place(pts, frames as u64);
        let Some(encoder) = audio.encoder.as_mut() else { return Ok(()) };
        // After `stop`, sound only up to it: the track ends where the video does. `audio_target` is only changed under
        // this lock, so a buffer is cut by the target in force while it is placed.
        let room = self.audio_target.load(Ordering::Acquire).saturating_sub(encoder.frames_in);
        let silence = placement.silence.min(room);
        encoder.push_silence(silence as usize);
        let start = (placement.skip as usize).min(frames);
        let end = start + ((frames - start) as u64).min(room - silence) as usize;
        audio.scratch.clear();
        for frame in start..end {
            audio.scratch.push(channel(frame, 0));
            audio.scratch.push(channel(frame, second));
        }
        encoder.push(&audio.scratch);
        let mut packets = Vec::new();
        encoder.drain(&mut |packet| packets.push(packet))?;
        drop(guard);
        for data in packets {
            self.send(Media::Audio { data });
        }
        Ok(())
    }
}

impl VideoSink for Shared {
    fn media(&self, media: Media) {
        self.send(media);
    }

    fn failed(&self, detail: String) {
        self.fail(detail);
    }
}

/// SCStreamFrameInfoStatus of a screen sample, when it says.
unsafe fn frame_status(sample: &CMSampleBuffer) -> Option<isize> {
    let attachments = unsafe { sample.sample_attachments_array(false) }?;
    let first = unsafe { attachments.cast_unchecked::<CFType>() }.get(0)?;
    let dictionary = first.downcast::<CFDictionary>().ok()?;
    let dictionary = unsafe { dictionary.cast_unchecked::<CFString, CFType>() };
    // SCStreamFrameInfo keys are NSStrings, toll-free bridged to CFString.
    let key: &CFString = unsafe { &*(SCStreamFrameInfoStatus as *const _ as *const CFString) };
    let value = dictionary.get(key)?.downcast::<CFNumber>().ok()?;
    value.as_i64().map(|v| v as isize)
}

pub struct DelegateIvars {
    shared: Arc<Shared>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl SCStreamOutput for Delegate {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_did_output(&self, _stream: &SCStream, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
            self.ivars().shared.sample(sample, kind);
        }
    }

    unsafe impl SCStreamDelegate for Delegate {
        #[unsafe(method(stream:didStopWithError:))]
        fn stream_did_stop(&self, _stream: &SCStream, error: &NSError) {
            self.ivars().shared.fail(format!("capture stopped: {}", describe(error)));
        }
    }
);

impl Delegate {
    fn new(shared: Arc<Shared>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { shared });
        unsafe { msg_send![super(this), init] }
    }
}

pub struct Session {
    stream: Unsent<SCStream>,
    _delegate: Unsent<Delegate>,
    _queues: (dispatch2::DispatchRetained<DispatchQueue>, dispatch2::DispatchRetained<DispatchQueue>),
    shared: Arc<Shared>,
    file: Option<File>,
    audio_bitrate: u32,
    writer: Option<JoinHandle<()>>,
    refresher: Option<JoinHandle<()>>,
}

unsafe impl Send for Session {}

/// Runs a completion-handler API and waits for its error, if any.
fn wait_for(timeout: Duration, what: &str, start: impl FnOnce(&block2::DynBlock<dyn Fn(*mut NSError)>)) -> Result<(), String> {
    let (sender, receiver) = channel::<Option<String>>();
    let block = RcBlock::new(move |error: *mut NSError| {
        let _ = sender.send(unsafe { error.as_ref() }.map(describe));
    });
    start(&block);
    match receiver.recv_timeout(timeout) {
        Ok(None) => Ok(()),
        Ok(Some(error)) => Err(error),
        Err(_) => Err(format!("{what} did not complete within {} s", timeout.as_secs())),
    }
}

impl Session {
    pub fn prepare(request: PrepareRequest, events: Arc<dyn Events>) -> Result<(Session, Prepared), CaptureError> {
        let began = Instant::now();
        let mut lap = began;
        let mut timings = Vec::new();
        let mut mark = |what: &str| {
            timings.push(format!("{what} {} ms", lap.elapsed().as_millis()));
            lap = Instant::now();
        };
        let content = content::recent_or_fetch()?;
        mark("content");
        let display = content::find_display(&content, request.display_id)?;
        let filter = content::filter(&content, &display, &request.own_pids, request.hide_system_ui);
        mark("filter");

        let file = OpenOptions::new()
            .write(true)
            .open(&request.path)
            .map_err(|e| CaptureError::new("capture_start_failed", format!("recording file could not be opened: {e}")))?;

        let shared = Arc::new(Shared {
            events,
            phase: AtomicU8::new(PREPARED),
            t0_ns: AtomicU64::new(0),
            failed: AtomicBool::new(false),
            video: Mutex::new(VideoState { encoder: None, last: None, last_encoded_ns: 0, pacer: None, pending: false, last_pts: 0 }),
            audio: Mutex::new(AudioState { encoder: None, aligner: None, priming: 0, scratch: Vec::new() }),
            writer: Mutex::new(None),
            frames_seen: AtomicU64::new(0),
            frame_rate: request.frame_rate,
            stop_ns: AtomicU64::new(u64::MAX),
            audio_target: AtomicU64::new(u64::MAX),
            lead_sum_us: AtomicI64::new(0),
            lead_count: AtomicU64::new(0),
            lead_max_us: AtomicI64::new(i64::MIN),
        });
        // The encoders are made while the stream starts: until `record` capture only keeps the newest frame, so
        // nothing needs them before then, and preparing takes the longer of the two instead of their sum.
        let encoders = {
            let shared = shared.clone();
            let (width, height, frame_rate, video_bitrate, audio_bitrate) =
                (request.width, request.height, request.frame_rate, request.video_bitrate, request.audio_bitrate);
            std::thread::Builder::new()
                .name("recordstuff-encoders".into())
                .spawn(move || -> Result<(), CaptureError> {
                    let video = VideoEncoder::new(width, height, frame_rate, video_bitrate, shared.clone())?;
                    let audio = AacEncoder::new(SAMPLE_RATE, CHANNELS, audio_bitrate)?;
                    shared.video.lock().unwrap().encoder = Some(video);
                    let mut state = shared.audio.lock().unwrap();
                    state.priming = audio.priming;
                    state.encoder = Some(audio);
                    Ok(())
                })
                .map_err(|e| CaptureError::new("capture_start_failed", format!("encoder thread: {e}")))?
        };

        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setWidth(request.width as usize);
            config.setHeight(request.height as usize);
            let interval = Pacer::capture_interval_ns(request.frame_rate) as i64;
            config.setMinimumFrameInterval(CMTime { value: interval, timescale: 1_000_000_000, flags: CMTimeFlags::Valid, epoch: 0 });
            config.setPixelFormat(PIXEL_FORMAT_420V);
            config.setShowsCursor(true);
            config.setQueueDepth(6);
            config.setCapturesAudio(true);
            config.setSampleRate(SAMPLE_RATE as isize);
            config.setChannelCount(CHANNELS as isize);
            config.setExcludesCurrentProcessAudio(true);
        }

        let delegate = Delegate::new(shared.clone());
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter.filter,
                &config,
                Some(ProtocolObject::from_ref(&*delegate)),
            )
        };
        let screen_queue = DispatchQueue::new("com.ericts.record.capture.screen", None);
        let audio_queue = DispatchQueue::new("com.ericts.record.capture.audio", None);
        let output: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*delegate);
        unsafe {
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(output, SCStreamOutputType::Screen, Some(&screen_queue))
                .map_err(|e| CaptureError::new("capture_start_failed", format!("screen output: {}", describe(&e))))?;
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(output, SCStreamOutputType::Audio, Some(&audio_queue))
                .map_err(|e| CaptureError::new("capture_start_failed", format!("audio output: {}", describe(&e))))?;
        }
        let mut session = Session {
            stream: Unsent(stream),
            _delegate: Unsent(delegate),
            _queues: (screen_queue, audio_queue),
            shared,
            file: Some(file),
            audio_bitrate: request.audio_bitrate,
            writer: None,
            refresher: None,
        };
        wait_for(START_TIMEOUT, "starting capture", |block| unsafe { session.stream.0.startCaptureWithCompletionHandler(Some(block)) })
            .map_err(|detail| {
                let code = if detail.contains("-3801") { "permission_denied" } else { "capture_start_failed" };
                CaptureError::new(code, format!("starting capture: {detail}"))
            })?;
        mark("stream start");
        let made = encoders.join().unwrap_or_else(|_| Err(CaptureError::new("capture_start_failed", "making the encoders failed")));
        if let Err(error) = made {
            session.halt();
            return Err(error);
        }
        mark("encoders (made alongside)");
        let priming = session.shared.audio.lock().unwrap().priming;
        // The stream is checked once it has delivered a picture; `record` starts the file with it.
        let deadline = Instant::now() + FIRST_FRAME_TIMEOUT;
        while session.shared.video.lock().unwrap().last.is_none() {
            if session.shared.failed.load(Ordering::Acquire) || Instant::now() > deadline {
                session.halt();
                return Err(CaptureError::new("capture_start_failed", "the display delivered no frame within 3 s"));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        mark("first frame");
        let prepared = Prepared {
            width: request.width,
            height: request.height,
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            priming_frames: priming,
            excluded_apps: filter.excluded_apps,
            hidden_windows: filter.hidden_windows,
            warnings: filter.warnings,
            timings: format!("{}; total {} ms", timings.join(", "), began.elapsed().as_millis()),
        };
        Ok((session, prepared))
    }

    /// Starts the file at this moment: the newest frame is its first, a key frame at time zero.
    pub fn record(&mut self) -> Result<(), CaptureError> {
        let file = self.file.take().ok_or_else(|| CaptureError::new("capture_start_failed", "record called twice"))?;
        let t0 = now_ns();
        self.shared.t0_ns.store(t0, Ordering::Release);
        let config = {
            let audio = self.shared.audio.lock().unwrap();
            let encoder = audio.encoder.as_ref().expect("prepared without an audio encoder");
            AudioSpec { config: encoder.audio_specific_config(), priming: encoder.priming, sample_rate: SAMPLE_RATE, channels: CHANNELS as u16, bitrate: self.audio_bitrate }
        };
        let events = self.shared.events.clone();
        let writer = writer::spawn(WriterConfig { file, t0_ns: t0, audio: Some(config) }, move |event| match event {
            WriterEvent::Progress { bytes } => events.progress(bytes),
            WriterEvent::Failed(failure) => events.write_failed(failure),
        })
        .map_err(|e| CaptureError::new("capture_start_failed", format!("writer thread: {e}")))?;
        *self.shared.writer.lock().unwrap() = Some(writer.sender);
        self.writer = Some(writer.thread);

        // The first frame is encoded on the refresh thread, so `record` answers at once; until it is, the phase
        // stays PREPARED and no captured frame or sound is taken, and the file's time zero is still t0.
        let shared = self.shared.clone();
        self.refresher = Some(
            std::thread::Builder::new()
                .name("recordstuff-refresh".into())
                .spawn(move || {
                    {
                        let mut guard = shared.video.lock().unwrap();
                        let video = &mut *guard;
                        let first = match (video.encoder.as_ref(), video.last.as_ref()) {
                            (Some(encoder), Some(frame)) => encoder.encode(&frame.image, t0, true),
                            _ => Err("no frame to start the recording with".into()),
                        };
                        if let Err(detail) = first {
                            drop(guard);
                            shared.fail(detail);
                            return;
                        }
                        video.last_encoded_ns = t0;
                        video.pacer = Some(Pacer::new(t0, shared.frame_rate));
                        // Under the video lock: no captured frame can be encoded before the first one. A stop that
                        // came first keeps its phase.
                        if shared.phase.compare_exchange(PREPARED, RECORDING, Ordering::AcqRel, Ordering::Acquire).is_err() {
                            return;
                        }
                    }
                    let mut wake = Duration::from_millis(100);
                    while shared.phase.load(Ordering::Acquire) == RECORDING {
                        std::thread::sleep(wake);
                        wake = Duration::from_millis(100);
                        let now = now_ns();
                        let mut guard = shared.video.lock().unwrap();
                        let video = &mut *guard;
                        if shared.phase.load(Ordering::Acquire) != RECORDING {
                            continue;
                        }
                        // A frame the pacer left out, on a screen that has since stood still: due at its slot.
                        let at = if video.pending {
                            match video.pacer.as_mut().and_then(|pacer| pacer.due(now)) {
                                Some(slot) => Some(slot.max(video.last_encoded_ns + 1)),
                                None => {
                                    let slot = video.pacer.as_ref().map_or(now, |pacer| pacer.next_slot());
                                    wake = Duration::from_nanos(slot.saturating_sub(now).clamp(1_000_000, 100_000_000));
                                    None
                                }
                            }
                        } else if now >= video.last_encoded_ns + REFRESH_NS {
                            Some(now)
                        } else {
                            None
                        };
                        let Some(at) = at else { continue };
                        video.pending = false;
                        let result = match (video.encoder.as_ref(), video.last.as_ref()) {
                            (Some(encoder), Some(frame)) => encoder.encode(&frame.image, at, false),
                            _ => Ok(()),
                        };
                        video.last_encoded_ns = at;
                        drop(guard);
                        if let Err(detail) = result {
                            shared.fail(detail);
                        }
                    }
                })
                .map_err(|e| CaptureError::new("capture_start_failed", format!("refresh thread: {e}")))?,
        );
        Ok(())
    }

    /// Stops capture and the encoders, and finishes the file. Blocks until the file is plain or why it is not is known.
    pub fn stop(mut self) -> Result<Stopped, WriteFailure> {
        let stop_ns = now_ns();
        let (drain_ms, drain_padded_frames) = self.drain(stop_ns);
        self.halt();
        {
            // Encoded samples reach the writer before the flush returns, and before the file is finished below.
            let mut video = self.shared.video.lock().unwrap();
            if let Some(encoder) = video.encoder.take() {
                encoder.flush();
            }
            video.last = None;
        }
        let mut packets = Vec::new();
        let mut audio_frames = None;
        {
            let mut audio = self.shared.audio.lock().unwrap();
            if let Some(mut encoder) = audio.encoder.take() {
                if audio.aligner.is_some() {
                    let _ = encoder.finish(&mut |packet| packets.push(packet));
                    audio_frames = Some(encoder.frames_in.min(self.shared.audio_target.load(Ordering::Acquire)));
                }
            }
        }
        for data in packets {
            self.shared.send(Media::Audio { data });
        }
        let Some(sender) = self.shared.writer.lock().unwrap().take() else {
            return Ok(Stopped { bytes: 0, fragmented: None, finalize_ms: 0.0, drain_ms, drain_padded_frames, frame_lead_ms: (0.0, 0.0) });
        };
        let began = Instant::now();
        let outcome = sender
            .finish(stop_ns, audio_frames)
            .recv_timeout(FINISH_TIMEOUT)
            .map_err(|_| WriteFailure { code: "output_write_failed", detail: "finishing the file did not complete within 120 s".into() })?;
        if let Some(thread) = self.writer.take() {
            let _ = thread.join();
        }
        let report = outcome?;
        let count = self.shared.lead_count.load(Ordering::Relaxed).max(1) as f64;
        let frame_lead_ms = (
            self.shared.lead_sum_us.load(Ordering::Relaxed) as f64 / count / 1000.0,
            self.shared.lead_max_us.load(Ordering::Relaxed).max(i64::MIN / 2) as f64 / 1000.0,
        );
        Ok(Stopped {
            frame_lead_ms,
            bytes: report.bytes,
            fragmented: report.fragmented,
            finalize_ms: began.elapsed().as_secs_f64() * 1000.0,
            drain_ms,
            drain_padded_frames,
        })
    }

    /// Ends the recording at `stop_ns`: no later frame is encoded, and capture runs on until the sound up to it has
    /// been encoded, or for `DRAIN_TIMEOUT`, after which the rest of it is silence. Returns how long that took and how
    /// many frames were silence.
    fn drain(&mut self, stop_ns: u64) -> (f64, u64) {
        let began = Instant::now();
        // Not recorded: nothing to end.
        if self.writer.is_none() {
            return (0.0, 0);
        }
        let t0 = self.shared.t0_ns.load(Ordering::Acquire);
        let target = u64::try_from(u128::from(stop_ns.saturating_sub(t0)) * u128::from(SAMPLE_RATE) / u128::from(NANOS_PER_SECOND))
            .unwrap_or(u64::MAX);
        // The cutoff first, under the audio lock that placement holds: no sound after the stop is taken from here on.
        self.shared.audio.lock().unwrap().audio_target_set(&self.shared.audio_target, target);
        {
            // Under the video lock, so no frame after the stop is encoded once this returns. A record whose first frame
            // is still being encoded (PREPARED) drains too, and its refresh thread then never moves to RECORDING.
            let mut guard = self.shared.video.lock().unwrap();
            let video = &mut *guard;
            self.shared.stop_ns.store(stop_ns, Ordering::Release);
            let moved = [RECORDING, PREPARED].iter().any(|&from| {
                self.shared.phase.compare_exchange(from, DRAINING, Ordering::AcqRel, Ordering::Acquire).is_ok()
            });
            if !moved {
                return (0.0, 0);
            }
            // The newest change, left out by the pacer, is the picture until the stop: at its own capture time, which
            // is after the last encoded frame and before the stop, so it lasts until the video's end.
            if video.pending {
                video.pending = false;
                let at = video.last_pts.max(video.last_encoded_ns + 1);
                if at >= stop_ns {
                    // No time left before the stop to show it.
                } else if let (Some(encoder), Some(frame)) = (video.encoder.as_ref(), video.last.as_ref()) {
                    if encoder.encode(&frame.image, at, false).is_ok() {
                        video.last_encoded_ns = at;
                    }
                }
            }
        }
        let deadline = began + DRAIN_TIMEOUT;
        loop {
            let mut audio = self.shared.audio.lock().unwrap();
            let started = audio.aligner.is_some();
            let Some(encoder) = audio.encoder.as_mut() else { return (0.0, 0) };
            let missing = target.saturating_sub(encoder.frames_in);
            if missing == 0 || Instant::now() >= deadline {
                // No sound at all yet: the track is empty and `stop` leaves it so.
                if !started {
                    return (began.elapsed().as_secs_f64() * 1000.0, 0);
                }
                encoder.push_silence(missing as usize);
                return (began.elapsed().as_secs_f64() * 1000.0, missing);
            }
            drop(audio);
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Ends capture and frame refreshes; frames and sound arriving afterwards are ignored.
    fn halt(&mut self) {
        self.shared.phase.store(STOPPING, Ordering::Release);
        let _ = wait_for(STOP_TIMEOUT, "stopping capture", |block| unsafe { self.stream.0.stopCaptureWithCompletionHandler(Some(block)) });
        if let Some(thread) = self.refresher.take() {
            let _ = thread.join();
        }
    }

    /// Releases a prepared session that never recorded: the file stays empty and main removes it.
    pub fn cancel(mut self) {
        self.halt();
        self.shared.video.lock().unwrap().encoder.take();
        self.shared.audio.lock().unwrap().encoder.take();
    }

    pub fn frames_seen(&self) -> u64 {
        self.shared.frames_seen.load(Ordering::Relaxed)
    }
}

impl Drop for Session {
    /// A session dropped without `stop` or `cancel` (its owner went away) still ends capture.
    fn drop(&mut self) {
        if self.shared.phase.load(Ordering::Acquire) != STOPPING {
            self.halt();
        }
    }
}
