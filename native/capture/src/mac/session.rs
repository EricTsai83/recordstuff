//! One recording on macOS: an `SCStream` started at `prepare`, whose frames are only kept (the newest one) until
//! `record`, then encoded and written until `stop`. Preparing first is what lets main count down without capturing
//! (plan 040) while the permission prompt, the display and both encoders are already checked.
//!
//! ScreenCaptureKit delivers a frame only when the screen changes. At `record` the newest frame is encoded at the
//! recording's start, so the file starts with a picture however still the screen is, and while nothing changes the
//! last frame is encoded again every second, so a key frame still comes every second and fragments keep closing.

use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
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
use crate::timing::{AudioAligner, NANOS_PER_SECOND};
use crate::writer::{self, AudioSpec, Media, WriteFailure, WriterConfig, WriterEvent};

const PREPARED: u8 = 0;
const RECORDING: u8 = 1;
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
    /// The frame rate setting, for the encoder's rate control.
    pub frame_rate: u32,
    /// The rate asked of ScreenCaptureKit as a minimum frame interval, slightly above the setting (`CAPTURE_FRAME_RATE`).
    pub capture_rate: f64,
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
}

pub struct Stopped {
    pub bytes: u64,
    pub fragmented: Option<String>,
    pub finalize_ms: f64,
}

/// The source's size in pixels, for choosing the output size before `prepare`.
pub fn probe(display_id: u32) -> Result<(u32, u32), CaptureError> {
    let content = content::shareable_content()?;
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
}

struct AudioState {
    encoder: Option<AacEncoder>,
    aligner: Option<AudioAligner>,
    priming: u32,
    scratch: Vec<f32>,
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
        let code = if self.phase.load(Ordering::Acquire) == RECORDING { "capture_failed" } else { "capture_start_failed" };
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
        let mut video = self.video.lock().unwrap();
        if self.phase.load(Ordering::Acquire) == RECORDING && pts > video.last_encoded_ns {
            if let Some(encoder) = video.encoder.as_ref() {
                if let Err(detail) = encoder.encode(&image, pts, false) {
                    drop(video);
                    self.fail(detail);
                    return;
                }
            }
            video.last_encoded_ns = pts;
        }
        video.last = Some(Frame { image });
    }

    fn sound(&self, sample: &CMSampleBuffer) -> Result<(), String> {
        if self.phase.load(Ordering::Acquire) != RECORDING {
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
        encoder.push_silence(placement.silence as usize);
        audio.scratch.clear();
        for frame in placement.skip as usize..frames {
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
        let content = content::shareable_content()?;
        let display = content::find_display(&content, request.display_id)?;
        let filter = content::filter(&content, &display, &request.own_pids, request.hide_system_ui);

        let file = OpenOptions::new()
            .write(true)
            .open(&request.path)
            .map_err(|e| CaptureError::new("capture_start_failed", format!("recording file could not be opened: {e}")))?;

        let shared = Arc::new(Shared {
            events,
            phase: AtomicU8::new(PREPARED),
            t0_ns: AtomicU64::new(0),
            failed: AtomicBool::new(false),
            video: Mutex::new(VideoState { encoder: None, last: None, last_encoded_ns: 0 }),
            audio: Mutex::new(AudioState { encoder: None, aligner: None, priming: 0, scratch: Vec::new() }),
            writer: Mutex::new(None),
            frames_seen: AtomicU64::new(0),
        });
        let video = VideoEncoder::new(request.width, request.height, request.frame_rate, request.video_bitrate, shared.clone())?;
        let audio = AacEncoder::new(SAMPLE_RATE, CHANNELS, request.audio_bitrate)?;
        let priming = audio.priming;
        shared.video.lock().unwrap().encoder = Some(video);
        {
            let mut state = shared.audio.lock().unwrap();
            state.priming = priming;
            state.encoder = Some(audio);
        }

        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setWidth(request.width as usize);
            config.setHeight(request.height as usize);
            let interval = (1e9 / request.capture_rate.max(1.0)).round() as i64;
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
        // The stream is checked once it has delivered a picture; `record` starts the file with it.
        let deadline = Instant::now() + FIRST_FRAME_TIMEOUT;
        while session.shared.video.lock().unwrap().last.is_none() {
            if session.shared.failed.load(Ordering::Acquire) || Instant::now() > deadline {
                session.halt();
                return Err(CaptureError::new("capture_start_failed", "the display delivered no frame within 3 s"));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let prepared = Prepared {
            width: request.width,
            height: request.height,
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            priming_frames: priming,
            excluded_apps: filter.excluded_apps,
            hidden_windows: filter.hidden_windows,
            warnings: filter.warnings,
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

        {
            let mut video = self.shared.video.lock().unwrap();
            let video = &mut *video;
            let (Some(encoder), Some(frame)) = (video.encoder.as_ref(), video.last.as_ref()) else {
                return Err(CaptureError::new("capture_start_failed", "no frame to start the recording with"));
            };
            encoder.encode(&frame.image, t0, true).map_err(|detail| CaptureError::new("capture_start_failed", detail))?;
            video.last_encoded_ns = t0;
            // Under the video lock: no captured frame can be encoded before the first one.
            self.shared.phase.store(RECORDING, Ordering::Release);
        }

        let shared = self.shared.clone();
        self.refresher = Some(
            std::thread::Builder::new()
                .name("recordstuff-refresh".into())
                .spawn(move || {
                    while shared.phase.load(Ordering::Acquire) == RECORDING {
                        std::thread::sleep(Duration::from_millis(100));
                        let now = now_ns();
                        let mut video = shared.video.lock().unwrap();
                        if shared.phase.load(Ordering::Acquire) != RECORDING || now < video.last_encoded_ns + REFRESH_NS {
                            continue;
                        }
                        let result = match (video.encoder.as_ref(), video.last.as_ref()) {
                            (Some(encoder), Some(frame)) => encoder.encode(&frame.image, now, false),
                            _ => Ok(()),
                        };
                        video.last_encoded_ns = now;
                        drop(video);
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
                    audio_frames = Some(encoder.frames_in);
                }
            }
        }
        for data in packets {
            self.shared.send(Media::Audio { data });
        }
        let Some(sender) = self.shared.writer.lock().unwrap().take() else {
            return Ok(Stopped { bytes: 0, fragmented: None, finalize_ms: 0.0 });
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
        Ok(Stopped { bytes: report.bytes, fragmented: report.fragmented, finalize_ms: began.elapsed().as_secs_f64() * 1000.0 })
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
