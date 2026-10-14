//! One recording on macOS: an `SCStream` started at `prepare` hands its frames and sound to the shared core
//! (core.rs), which decides what is encoded and when the recording ends. Preparing first is what lets main count down
//! without capturing (plan 040) while the permission prompt, the display and both encoders are already checked.
//!
//! ScreenCaptureKit delivers a frame only when the screen changes, and hands audio over a few tens of milliseconds
//! late; capture is asked for four times the frame rate and `Pacer` keeps one frame per slot (see pacing.rs).

use std::fs::OpenOptions;
use std::sync::Arc;
use std::sync::mpsc::channel;
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
use super::video::VideoEncoder;
use super::{CaptureError, Unsent, host_ns, now_ns};
use crate::core::{self, AudioEncode, CHANNELS, Core, Platform, SAMPLE_RATE, VideoEncode};
use crate::pacing::Pacer;
use crate::writer::WriteFailure;

pub use crate::core::{Events, PrepareRequest, Prepared, Stopped};

const START_TIMEOUT: Duration = Duration::from_secs(10);
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(3);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, what VideoToolbox encodes without converting.
const PIXEL_FORMAT_420V: u32 = u32::from_be_bytes(*b"420v");

/// The source's size in pixels, for choosing the output size before `prepare`.
pub fn probe(display_id: u32, _display_point: Option<(i32, i32)>) -> Result<(u32, u32), CaptureError> {
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

pub struct Frame {
    image: CFRetained<CVImageBuffer>,
}
unsafe impl Send for Frame {}

pub struct Mac;

impl Platform for Mac {
    type Frame = Frame;
    type Video = VideoEncoder;
    type Audio = AacEncoder;

    fn now_ns() -> u64 {
        now_ns()
    }
}

impl VideoEncode<Frame> for VideoEncoder {
    fn encode(&self, frame: &Frame, pts_ns: u64, key_frame: bool) -> Result<(), String> {
        VideoEncoder::encode(self, &frame.image, pts_ns, key_frame)
    }

    fn flush(&self) {
        VideoEncoder::flush(self)
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

type Shared = core::Shared<Mac>;

fn deliver(shared: &Shared, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
    if kind == SCStreamOutputType::Screen {
        if unsafe { frame_status(sample) } != Some(SCFrameStatus::Complete.0) {
            return;
        }
        let Some(image) = (unsafe { sample.image_buffer() }) else { return };
        shared.frame(Frame { image }, host_ns(unsafe { sample.presentation_time_stamp() }));
    } else if kind == SCStreamOutputType::Audio && shared.wants_sound() {
        if let Err(detail) = sound(shared, sample) {
            shared.fail(detail);
        }
    }
}

fn sound(shared: &Shared, sample: &CMSampleBuffer) -> Result<(), String> {
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
    shared.sound(pts, frames, |frame, which| {
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
}

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl SCStreamOutput for Delegate {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_did_output(&self, _stream: &SCStream, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
            deliver(&self.ivars().shared, sample, kind);
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
        let filter = content::filter(&content, &display, &request.own_pids, request.hide_system_ui);
        mark("filter");

        let file = OpenOptions::new()
            .write(true)
            .open(&request.path)
            .map_err(|e| CaptureError::new("capture_start_failed", format!("recording file could not be opened: {e}")))?;
        let core = Core::<Mac>::new(events, request.frame_rate, request.audio_bitrate, file);
        // The encoders are made while the stream starts, so preparing takes the longer of the two instead of their sum.
        let (width, height, frame_rate, video_bitrate, audio_bitrate) =
            (request.width, request.height, request.frame_rate, request.video_bitrate, request.audio_bitrate);
        let encoders = core.make_encoders(move |sink| {
            let video = VideoEncoder::new(width, height, frame_rate, video_bitrate, sink)?;
            let audio = AacEncoder::new(SAMPLE_RATE, CHANNELS, audio_bitrate)?;
            Ok((video, audio))
        })?;

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

        let delegate = Delegate::new(core.shared());
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
        let mut session = Session { stream: Unsent(stream), _delegate: Unsent(delegate), _queues: (screen_queue, audio_queue), core };
        wait_for(START_TIMEOUT, "starting capture", |block| unsafe { session.stream.0.startCaptureWithCompletionHandler(Some(block)) })
            .map_err(|detail| {
                let code = if detail.contains("-3801") { "permission_denied" } else { "capture_start_failed" };
                CaptureError::new(code, format!("starting capture: {detail}"))
            })?;
        mark("stream start");
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
        let prepared = Prepared {
            width: request.width,
            height: request.height,
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            priming_frames: session.core.priming(),
            excluded_apps: filter.excluded_apps,
            hidden_windows: filter.hidden_windows,
            warnings: filter.warnings,
            timings: format!("{}; total {} ms", timings.join(", "), began.elapsed().as_millis()),
        };
        Ok((session, prepared))
    }

    /// Starts the file at this moment: the newest frame is its first, a key frame at time zero.
    pub fn record(&mut self) -> Result<(), CaptureError> {
        self.core.record()
    }

    /// Stops capture and the encoders, and finishes the file. Blocks until the file is plain or why it is not is known.
    pub fn stop(mut self) -> Result<Stopped, WriteFailure> {
        let stop_ns = now_ns();
        let drained = self.core.drain(stop_ns);
        self.halt();
        self.core.finish(stop_ns, drained)
    }

    /// Ends capture and frame refreshes; frames and sound arriving afterwards are ignored.
    fn halt(&mut self) {
        self.core.halt();
        let _ = wait_for(STOP_TIMEOUT, "stopping capture", |block| unsafe { self.stream.0.stopCaptureWithCompletionHandler(Some(block)) });
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
