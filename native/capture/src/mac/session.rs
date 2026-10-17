//! One recording on macOS: an `SCStream` started at `prepare` hands its frames and sound to the shared core
//! (core.rs), which decides what is encoded and when the recording ends. Preparing first is what lets main count down
//! without capturing (plan 040) while the permission prompt, the display and both encoders are already checked.
//!
//! ScreenCaptureKit delivers a frame only when the screen changes, and hands audio over a few tens of milliseconds
//! late; capture is asked for four times the frame rate and `Pacer` keeps one frame per slot (see pacing.rs).

use std::fs::OpenOptions;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
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
    SCContentFilter, SCFrameStatus, SCStream, SCStreamConfiguration, SCStreamDelegate, SCStreamFrameInfoStatus, SCStreamOutput, SCStreamOutputType,
};

use super::audio::AacEncoder;
use super::camera::CameraCapture;
use super::compositor::Compositor;
use super::content::{self, describe};
use super::video::VideoEncoder;
use super::{CaptureError, Unsent, host_ns, now_ns};
use super::microphone::MicrophoneCapture;
use crate::camera_layout::{CameraPrototype, PREVIEW_FPS};
use crate::core::{self, AudioEncode, CHANNELS, Core, Platform, SAMPLE_RATE, Source, SystemAudio, VideoEncode};
use crate::pacing::Pacer;

pub use crate::core::{Events, Finished, Finishing, PrepareRequest, Prepared, Stopped};

const START_TIMEOUT: Duration = Duration::from_secs(10);
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(3);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, what VideoToolbox encodes without converting.
const PIXEL_FORMAT_420V: u32 = u32::from_be_bytes(*b"420v");

/// The source's size in pixels, for choosing the output size before `prepare`.
pub fn probe(display_id: u32, _display_point: Option<(i32, i32)>, source: &Source) -> Result<(u32, u32), CaptureError> {
    let content = content::shareable_content()?;
    // Kept for the `prepare` that follows.
    content::remember(&content);
    let display = content::find_display(&content, display_id)?;
    content::source_size(&content, &display, source)
}

#[derive(Clone)]
pub struct Frame {
    image: CFRetained<CVImageBuffer>,
}
unsafe impl Send for Frame {}

pub struct Mac;

impl Platform for Mac {
    type Frame = Frame;
    type Video = Video;
    type Audio = AacEncoder;

    fn now_ns() -> u64 {
        now_ns()
    }
}

/// The H.264 encoder, with the camera composed into each frame it encodes when one is on (plan 075): at encoding
/// time, so a frame encoded again on a still screen holds the camera's newest picture.
pub struct Video {
    encoder: VideoEncoder,
    compositor: Option<Arc<Compositor>>,
}

impl VideoEncode<Frame> for Video {
    fn encode(&self, frame: &Frame, pts_ns: u64, key_frame: bool) -> Result<(), String> {
        match self.compositor.as_ref() {
            Some(compositor) => {
                let composed = compositor.compose(&frame.image).map_err(|detail| format!("composing the camera failed: {detail}"))?;
                self.encoder.encode(&composed, pts_ns, key_frame)
            }
            None => self.encoder.encode(&frame.image, pts_ns, key_frame),
        }
    }

    fn flush(&self) {
        self.encoder.flush()
    }
}

/// Step 2's preview: the composed picture at preview size, `PREVIEW_FPS` times a second, to the session's events,
/// from `prepare` until capture ends.
struct Preview {
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Preview {
    fn start(shared: Arc<Shared>, compositor: Arc<Compositor>) -> Result<Self, CaptureError> {
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let thread = std::thread::Builder::new()
            .name("recordstuff-preview".into())
            .spawn(move || {
                let interval = Duration::from_nanos(1_000_000_000 / u64::from(PREVIEW_FPS));
                let events = shared.events();
                let mut next = Instant::now();
                while !stop.load(Ordering::Acquire) && !shared.halted() {
                    if let Some(frame) = shared.newest() {
                        match compositor.preview(&frame.image) {
                            Ok(preview) => events.preview(preview.width, preview.height, preview.data),
                            // A preview is a convenience: one that fails ends, the recording does not.
                            Err(_) => return,
                        }
                    }
                    next += interval;
                    let now = Instant::now();
                    if next > now {
                        std::thread::sleep(next - now);
                    } else {
                        next = now;
                    }
                }
            })
            .map_err(|e| CaptureError::new("capture_start_failed", format!("preview thread: {e}")))?;
        Ok(Self { stopped, thread: Some(thread) })
    }

    fn stop(mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl AudioEncode for AacEncoder {
    fn frames_in(&self) -> u64 {
        self.frames_in
    }
    fn priming(&self) -> u32 {
        self.priming
    }
    fn audio_specific_config(&self) -> Vec<u8> {
        AacEncoder::audio_specific_config(self)
    }
    fn push(&mut self, interleaved: &[f32]) {
        AacEncoder::push(self, interleaved)
    }
    fn push_silence(&mut self, frames: usize) {
        AacEncoder::push_silence(self, frames)
    }
    fn drain(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
        AacEncoder::drain(self, out)
    }
    fn finish(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
        AacEncoder::finish(self, out)
    }
}

pub(super) type Shared = core::Shared<Mac>;

/// A stream's sample: `video` says whether its frames are the recording's, `sound` which input its sound is, if any.
fn deliver(shared: &Shared, sample: &CMSampleBuffer, kind: SCStreamOutputType, video: bool, sound_input: Option<usize>) {
    if kind == SCStreamOutputType::Screen && video {
        let status = unsafe { frame_status(sample) };
        if status == Some(SCFrameStatus::Idle.0) {
            // The screen did not change at this refresh: its newest picture stands.
            shared.frame_unchanged(host_ns(unsafe { sample.presentation_time_stamp() }));
            return;
        }
        if status != Some(SCFrameStatus::Complete.0) {
            shared.frame_without_picture(host_ns(unsafe { sample.presentation_time_stamp() }));
            return;
        }
        let Some(image) = (unsafe { sample.image_buffer() }) else { return };
        shared.frame(Frame { image }, host_ns(unsafe { sample.presentation_time_stamp() }));
    } else if kind == SCStreamOutputType::Audio && shared.wants_sound() {
        let Some(input) = sound_input else { return };
        if let Err(detail) = sound(shared, input, sample, host_ns(unsafe { sample.presentation_time_stamp() })) {
            shared.fail(detail);
        }
    }
}

/// Hands a sample buffer of 32-bit float sound at 48 kHz, captured at `pts` host time, to the core as `input`.
pub(super) fn sound(shared: &Shared, input: usize, sample: &CMSampleBuffer, pts: u64) -> Result<(), String> {
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
    shared.sound(input, pts, frames, |frame, which| {
        let which = if which == 0 { 0 } else { second };
        if planar { samples[which * frames + frame] } else { samples[frame * channels + which] }
    })
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
    /// Whether this stream's frames are the recording's picture (an audio-only stream's are not).
    video: bool,
    /// The core input this stream's sound is, if it carries any.
    sound: Option<usize>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl SCStreamOutput for Delegate {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_did_output(&self, _stream: &SCStream, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
            let ivars = self.ivars();
            deliver(&ivars.shared, sample, kind, ivars.video, ivars.sound);
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
    fn new(shared: Arc<Shared>, video: bool, sound: Option<usize>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { shared, video, sound });
        unsafe { msg_send![super(this), init] }
    }
}

/// One `SCStream` with its outputs.
struct Stream {
    stream: Unsent<SCStream>,
    _delegate: Unsent<Delegate>,
    _queues: (dispatch2::DispatchRetained<DispatchQueue>, dispatch2::DispatchRetained<DispatchQueue>),
}

impl Stream {
    /// A stream of `filter` with `config`, its frames the picture when `video`, its sound `sound`'s input if any.
    fn new(filter: &SCContentFilter, config: &SCStreamConfiguration, shared: Arc<Shared>, video: bool, sound: Option<usize>, name: &str) -> Result<Self, CaptureError> {
        let delegate = Delegate::new(shared, video, sound);
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), filter, config, Some(ProtocolObject::from_ref(&*delegate)))
        };
        let screen_queue = DispatchQueue::new(&format!("com.ericts.record.capture.{name}.screen"), None);
        let audio_queue = DispatchQueue::new(&format!("com.ericts.record.capture.{name}.audio"), None);
        let output: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*delegate);
        unsafe {
            // A screen output even on an audio-only stream, whose frames are ignored: without one ScreenCaptureKit
            // logs every frame it drops.
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(output, SCStreamOutputType::Screen, Some(&screen_queue))
                .map_err(|e| CaptureError::new("capture_start_failed", format!("{name} screen output: {}", describe(&e))))?;
            if sound.is_some() {
                stream
                    .addStreamOutput_type_sampleHandlerQueue_error(output, SCStreamOutputType::Audio, Some(&audio_queue))
                    .map_err(|e| CaptureError::new("capture_start_failed", format!("{name} audio output: {}", describe(&e))))?;
            }
        }
        Ok(Self { stream: Unsent(stream), _delegate: Unsent(delegate), _queues: (screen_queue, audio_queue) })
    }

    fn start(&self, what: &str) -> Result<(), CaptureError> {
        wait_for(START_TIMEOUT, what, |block| unsafe { self.stream.0.startCaptureWithCompletionHandler(Some(block)) }).map_err(|detail| {
            let code = if detail.contains("-3801") { "permission_denied" } else { "capture_start_failed" };
            CaptureError::new(code, format!("{what}: {detail}"))
        })
    }

    fn stop(&self) {
        let _ = wait_for(STOP_TIMEOUT, "stopping capture", |block| unsafe { self.stream.0.stopCaptureWithCompletionHandler(Some(block)) });
    }
}

/// The audio-only stream's configuration: sound as the picture's stream takes it, and the smallest, rarest frames.
fn audio_only_config() -> Retained<SCStreamConfiguration> {
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(2);
        config.setHeight(2);
        config.setMinimumFrameInterval(CMTime { value: 1, timescale: 1, flags: CMTimeFlags::Valid, epoch: 0 });
        config.setQueueDepth(3);
        config.setCapturesAudio(true);
        config.setSampleRate(SAMPLE_RATE as isize);
        config.setChannelCount(CHANNELS as isize);
        config.setExcludesCurrentProcessAudio(true);
    }
    config
}

pub struct Session {
    /// The picture's stream first, then the sound's when it has its own.
    streams: Vec<Stream>,
    microphone: Option<MicrophoneCapture>,
    /// The camera composed into the frames (plan 075's prototype), and its preview.
    camera: Option<CameraCapture>,
    preview: Option<Preview>,
    core: Core<Mac>,
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
        let filter = content::video_filter(&content, &display, &request.source, &request.own_pids, request.hide_system_ui)?;
        let audio_filter = content::audio_filter(&content, &display, &request.source, &request.audio.system, &request.own_pids)?;
        let source_rect = match request.source {
            Source::Area { x, y, width, height } => {
                Some(content::area_rect(&display, content::point_pixel_scale(&filter.filter).max(1.0), (x, y, width, height))?)
            }
            _ => None,
        };
        mark("filter");

        // The core's sound inputs: the system's (or chosen apps'), then the microphone.
        let system_input = (request.audio.system != SystemAudio::Off).then_some(0);
        let microphone_input = request.audio.microphone.as_ref().map(|_| usize::from(system_input.is_some()));
        let inputs = usize::from(system_input.is_some()) + usize::from(microphone_input.is_some());

        let file = OpenOptions::new()
            .write(true)
            .open(&request.path)
            .map_err(|e| CaptureError::new("capture_start_failed", format!("recording file could not be opened: {e}")))?;
        let core = Core::<Mac>::new(events, request.frame_rate, request.audio_bitrate, inputs, file);
        let frame_log = core.log_frames(&request.path);
        if let Some(input) = microphone_input {
            core.watch_microphone(input);
        }
        // Step 2's camera prototype, behind its development switch: opened before the screen, so a camera that cannot
        // open refuses the start before anything else runs.
        let prototype = CameraPrototype::from_env();
        let mut camera = None;
        let mut compositor = None;
        let mut camera_note = None;
        if let Some(prototype) = prototype.as_ref() {
            let opened = CameraCapture::start(prototype.device.as_deref())?;
            let made = Compositor::new(request.width, request.height, prototype.layout, opened.shared.clone())
                .map_err(|detail| CaptureError::new("capture_start_failed", format!("camera compositor: {detail}")))?;
            camera_note = Some(format!("camera prototype: {:?}, preview {}", prototype.layout, prototype.preview));
            compositor = Some(Arc::new(made));
            camera = Some(opened);
            core.encode_every_slot(true);
            mark("camera start");
        }
        // The encoders are made while the stream starts, so preparing takes the longer of the two instead of their sum.
        let (width, height, frame_rate, video_bitrate, audio_bitrate) =
            (request.width, request.height, request.frame_rate, request.video_bitrate, request.audio_bitrate);
        let encoding_compositor = compositor.clone();
        let encoders = core.make_encoders(move |sink| {
            let encoder = VideoEncoder::new(width, height, frame_rate, video_bitrate, sink)?;
            let audio = AacEncoder::new(SAMPLE_RATE, CHANNELS, audio_bitrate)?;
            Ok((Video { encoder, compositor: encoding_compositor }, audio))
        })?;

        // The picture's stream carries the sound too when its filter is the sound's.
        let picture_sound = if audio_filter.is_none() { system_input } else { None };
        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setWidth(request.width as usize);
            config.setHeight(request.height as usize);
            let interval = Pacer::capture_interval_ns(request.frame_rate) as i64;
            config.setMinimumFrameInterval(CMTime { value: interval, timescale: 1_000_000_000, flags: CMTimeFlags::Valid, epoch: 0 });
            config.setPixelFormat(PIXEL_FORMAT_420V);
            config.setShowsCursor(true);
            config.setQueueDepth(6);
            if let Some(rect) = source_rect {
                config.setSourceRect(rect);
            }
            config.setCapturesAudio(picture_sound.is_some());
            if picture_sound.is_some() {
                config.setSampleRate(SAMPLE_RATE as isize);
                config.setChannelCount(CHANNELS as isize);
                config.setExcludesCurrentProcessAudio(true);
            }
        }
        let mut streams = vec![Stream::new(&filter.filter, &config, core.shared(), true, picture_sound, "picture")?];
        if let (Some(audio_filter), Some(input)) = (audio_filter.as_ref(), system_input) {
            streams.push(Stream::new(audio_filter, &audio_only_config(), core.shared(), false, Some(input), "sound")?);
        }
        let mut session = Session { streams, microphone: None, camera, preview: None, core };
        for (index, stream) in session.streams.iter().enumerate() {
            let what = if index == 0 { "starting capture" } else { "starting the sound's capture" };
            if let Err(error) = stream.start(what) {
                session.halt();
                return Err(error);
            }
        }
        mark("stream start");
        if let (Some(device), Some(input)) = (request.audio.microphone.as_ref(), microphone_input) {
            match MicrophoneCapture::start(device.as_deref(), session.core.shared(), input) {
                Ok(microphone) => session.microphone = Some(microphone),
                Err(error) => {
                    session.halt();
                    return Err(error);
                }
            }
            mark("microphone start");
        }
        if let Err(error) = Core::<Mac>::encoders_made(encoders) {
            session.halt();
            return Err(error);
        }
        mark("encoders (made alongside)");
        if let Err(error) = session.core.first_frame(FIRST_FRAME_TIMEOUT) {
            session.halt();
            return Err(error);
        }
        mark("first frame");
        if let Some(camera) = session.camera.as_ref() {
            eprintln!("camera prototype: after preparing {}", camera.state());
        }
        if let (Some(compositor), true) = (compositor, prototype.as_ref().is_some_and(|prototype| prototype.preview)) {
            match Preview::start(session.core.shared(), compositor) {
                Ok(preview) => session.preview = Some(preview),
                Err(error) => {
                    session.halt();
                    return Err(error);
                }
            }
        }
        let prepared = Prepared {
            width: request.width,
            height: request.height,
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            priming_frames: session.core.priming(),
            excluded_apps: filter.excluded_apps,
            hidden_windows: filter.hidden_windows,
            warnings: filter
                .warnings
                .into_iter()
                .chain(session.microphone.as_ref().and_then(|microphone| microphone.note.clone()))
                .chain(camera_note)
                .chain(frame_log.map(|path| format!("per-frame log: {}", path.display())))
                .collect(),
            timings: format!("{}; total {} ms", timings.join(", "), began.elapsed().as_millis()),
            microphone: session.microphone.as_ref().map(|microphone| microphone.name.clone()),
        };
        Ok((session, prepared))
    }

    /// Starts the file at this moment: the newest frame is its first, a key frame at time zero.
    pub fn record(&mut self) -> Result<(), CaptureError> {
        self.core.record()
    }

    /// Stops capture and the encoders; the file is finished in the background (`Finishing::wait`).
    pub fn stop(mut self) -> (Stopped, Finishing) {
        let stop_ns = now_ns();
        let drained = self.core.drain(stop_ns);
        self.halt();
        self.core.end(stop_ns, drained)
    }

    /// Ends capture and frame refreshes; frames and sound arriving afterwards are ignored.
    fn halt(&mut self) {
        self.core.halt();
        for stream in &self.streams {
            stream.stop();
        }
        if let Some(microphone) = self.microphone.take() {
            microphone.stop();
        }
        if let Some(preview) = self.preview.take() {
            preview.stop();
        }
        if let Some(camera) = self.camera.take() {
            // The capture host's stderr reaches main's log (step 2's prototype).
            eprintln!("camera prototype: at the stop {}", camera.state());
            camera.stop();
        }
        self.core.halted();
    }

    /// Releases a prepared session that never recorded: the file stays empty and main removes it.
    pub fn cancel(mut self) {
        self.halt();
        self.core.release();
    }

    pub fn frames_seen(&self) -> u64 {
        self.core.frames_seen()
    }
}

impl Drop for Session {
    /// A session dropped without `stop` or `cancel` (its owner went away) still ends capture.
    fn drop(&mut self) {
        if !self.core.stopping() {
            self.halt();
        }
    }
}
