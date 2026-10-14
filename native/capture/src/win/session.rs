//! One recording on Windows: display capture and system audio started at `prepare` hand their frames and sound to
//! the shared core (core.rs), which decides what is encoded and when the recording ends, as on macOS.
//!
//! RecordStuff's own windows are not left out here: Windows.Graphics.Capture cannot leave out another process's
//! windows, so main marks its windows excluded from capture (`WDA_EXCLUDEFROMCAPTURE`) for the session.

use std::fs::OpenOptions;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::aac::{AacEncoder, supported_bitrate};
use super::audio::SoundCapture;
use super::capture::{self, DisplayCapture, Frame, Gpu};
use super::video::H264Encoder;
use super::{CaptureError, com, now_ns};
use crate::core::{CHANNELS, Core, Platform, SAMPLE_RATE};
use crate::pacing::Pacer;
use crate::writer::WriteFailure;

pub use crate::core::{Events, PrepareRequest, Prepared, Stopped};

const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(3);

pub struct Win;

impl Platform for Win {
    type Frame = Frame;
    type Video = H264Encoder;
    type Audio = AacEncoder;

    fn now_ns() -> u64 {
        now_ns()
    }
}

/// The display's size in pixels, for choosing the output size before `prepare`.
pub fn probe(_display_id: u32, display_point: Option<(i32, i32)>) -> Result<(u32, u32), CaptureError> {
    com();
    let item = capture::item(capture::monitor(display_point)?)?;
    let size = item.Size().map_err(|e| super::start_failed("the display's size", e))?;
    Ok((size.Width.max(0) as u32, size.Height.max(0) as u32))
}

pub struct Session {
    display: DisplayCapture,
    sound: SoundCapture,
    core: Core<Win>,
}

impl Session {
    pub fn prepare(request: PrepareRequest, events: Arc<dyn Events>) -> Result<(Session, Prepared), CaptureError> {
        com();
        let began = Instant::now();
        let mut lap = began;
        let mut timings = Vec::new();
        let mut mark = |what: &str| {
            timings.push(format!("{what} {} ms", lap.elapsed().as_millis()));
            lap = Instant::now();
        };
        let item = capture::item(capture::monitor(request.display_point)?)?;
        // NV12 needs even dimensions.
        let (width, height) = (request.width & !1, request.height & !1);
        let gpu = Gpu::new()?;
        mark("display and device");

        let file = OpenOptions::new()
            .write(true)
            .open(&request.path)
            .map_err(|e| CaptureError::new("capture_start_failed", format!("recording file could not be opened: {e}")))?;
        let core = Core::<Win>::new(events, request.frame_rate, supported_bitrate(request.audio_bitrate), file);
        let (frame_rate, video_bitrate, audio_bitrate) = (request.frame_rate, request.video_bitrate, request.audio_bitrate);
        let encoder_gpu = gpu.clone();
        let encoders = core.make_encoders(move |sink| {
            com();
            let video = H264Encoder::new(encoder_gpu, width, height, frame_rate, video_bitrate, sink)?;
            let audio = AacEncoder::new(SAMPLE_RATE, CHANNELS, audio_bitrate)?;
            Ok((video, audio))
        })?;

        let software = gpu.0.software;
        let (display, borderless, cpu) =
            DisplayCapture::start(gpu, &item, width, height, Pacer::capture_interval_ns(request.frame_rate), core.shared())?;
        mark("display capture start");
        let exclude = request.own_pids.first().copied().unwrap_or(std::process::id() as i32) as u32;
        let sound = match SoundCapture::start(exclude, core.shared()) {
            Ok(sound) => sound,
            Err(error) => {
                display.stop();
                return Err(error);
            }
        };
        mark("audio capture start");
        let mut session = Session { display, sound, core };
        if let Err(error) = Core::<Win>::encoders_made(encoders) {
            session.halt();
            return Err(error);
        }
        mark("encoders (made alongside)");
        if let Err(error) = session.core.first_frame(FIRST_FRAME_TIMEOUT) {
            session.halt();
            return Err(error);
        }
        mark("first frame");

        let mut warnings = Vec::new();
        let audio_bitrate_used = supported_bitrate(request.audio_bitrate);
        if audio_bitrate_used != request.audio_bitrate {
            warnings.push(format!(
                "system audio is encoded at {} kbps: Windows's AAC encoder takes at most 192 kbps",
                audio_bitrate_used / 1000
            ));
        }
        if !borderless {
            warnings.push("Windows draws a border around the recorded display (Windows 10 cannot turn it off)".into());
        }
        if software {
            warnings.push("no Direct3D hardware device: frames are converted by WARP, Windows's software renderer".into());
        }
        if let Some(reason) = cpu {
            warnings.push(format!("frames are converted to NV12 on the CPU ({reason})"));
        }
        if (width, height) != (request.width, request.height) {
            warnings.push(format!("recorded at {width}x{height}: H.264 in NV12 needs even dimensions"));
        }
        let prepared = Prepared {
            width,
            height,
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            priming_frames: session.core.priming(),
            excluded_apps: 0,
            hidden_windows: 0,
            warnings,
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
        com();
        let stop_ns = now_ns();
        let drained = self.core.drain(stop_ns);
        self.halt();
        self.core.finish(stop_ns, drained)
    }

    /// Ends capture and frame refreshes; frames and sound arriving afterwards are ignored.
    fn halt(&mut self) {
        self.core.halt();
        self.display.stop();
        self.sound.stop();
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
