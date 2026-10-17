//! One recording on Windows: capture of the display, a window or an area, and the sound inputs (system audio or chosen
//! processes', and the microphone), started at `prepare`, hand their frames and sound to the shared core (core.rs),
//! which decides what is encoded and when the recording ends, as on macOS. Windows.Graphics.Capture has no way to show
//! only chosen apps' windows, so that source is refused.
//!
//! RecordStuff's own windows are not left out here: Windows.Graphics.Capture cannot leave out another process's
//! windows, so main marks its windows excluded from capture (`WDA_EXCLUDEFROMCAPTURE`) for the session.

use std::fs::OpenOptions;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::aac::{AacEncoder, supported_bitrate};
use super::audio::{Sound, SoundCapture};
use super::capture::{self, Area, DisplayCapture, Frame, Gpu};
use super::video::H264Encoder;
use super::{CaptureError, com, now_ns};
use crate::core::{AudioRequest, CHANNELS, Core, Platform, SAMPLE_RATE, Source, SystemAudio};
use crate::pacing::Pacer;

pub use crate::core::{Events, Finished, Finishing, PrepareRequest, Prepared, Stopped};

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

/// What captures `source`, and the area of it recorded.
fn capture_item(source: &Source, display_point: Option<(i32, i32)>) -> Result<(windows::Graphics::Capture::GraphicsCaptureItem, Option<Area>), CaptureError> {
    match source {
        Source::Display => Ok((capture::item(capture::monitor(display_point)?)?, None)),
        Source::Window(id) => Ok((capture::window_item(*id)?, None)),
        Source::Area { x, y, width, height } => {
            let item = capture::item(capture::monitor(display_point)?)?;
            let size = item.Size().map_err(|e| super::start_failed("the display's size", e))?;
            if u64::from(*x) + u64::from(*width) > size.Width.max(0) as u64 || u64::from(*y) + u64::from(*height) > size.Height.max(0) as u64 {
                return Err(CaptureError::new(
                    "capture_start_failed",
                    format!("the area {width}x{height} at {x},{y} does not lie on the {}x{} display", size.Width, size.Height),
                ));
            }
            Ok((item, Some(Area { x: *x, y: *y, width: *width, height: *height })))
        }
        Source::Apps(_) => Err(CaptureError::new(
            "capture_start_failed",
            "Windows cannot record only chosen apps' windows: record one window or the display",
        )),
    }
}

/// The sound inputs, in the core's order: the system's or chosen processes', then the microphone.
fn sounds(audio: &AudioRequest, own_pids: &[i32]) -> Vec<Sound> {
    let main = own_pids.first().copied().unwrap_or(std::process::id() as i32) as u32;
    let mut sounds: Vec<Sound> = match &audio.system {
        SystemAudio::All => vec![Sound::AllExcept(main)],
        SystemAudio::Apps(pids) => pids.iter().map(|&pid| Sound::Only(pid as u32)).collect(),
        SystemAudio::Off => Vec::new(),
    };
    if let Some(device) = &audio.microphone {
        sounds.push(Sound::Microphone(device.clone()));
    }
    sounds
}

/// The source's size in pixels, for choosing the output size before `prepare`.
pub fn probe(_display_id: u32, display_point: Option<(i32, i32)>, source: &Source) -> Result<(u32, u32), CaptureError> {
    com();
    let (item, area) = capture_item(source, display_point)?;
    if let Some(area) = area {
        return Ok((area.width, area.height));
    }
    let size = item.Size().map_err(|e| super::start_failed("the source's size", e))?;
    Ok((size.Width.max(0) as u32, size.Height.max(0) as u32))
}

pub struct Session {
    display: DisplayCapture,
    sounds: Vec<SoundCapture>,
    core: Core<Win>,
}

impl Session {
    pub fn prepare(request: PrepareRequest, events: Arc<dyn Events>) -> Result<(Session, Prepared), CaptureError> {
        // The camera on Windows (Media Foundation's source reader into the Direct3D 11 compositor) is plan 075 step 6's.
        if request.camera.is_some() {
            return Err(CaptureError::new("camera_unavailable", "camera: Windows does not compose the camera yet"));
        }
        com();
        let began = Instant::now();
        let mut lap = began;
        let mut timings = Vec::new();
        let mut mark = |what: &str| {
            timings.push(format!("{what} {} ms", lap.elapsed().as_millis()));
            lap = Instant::now();
        };
        let (item, area) = capture_item(&request.source, request.display_point)?;
        let sound_inputs = sounds(&request.audio, &request.own_pids);
        // NV12 needs even dimensions.
        let (width, height) = (request.width & !1, request.height & !1);
        let gpu = Gpu::new()?;
        mark("display and device");

        let file = OpenOptions::new()
            .write(true)
            .open(&request.path)
            .map_err(|e| CaptureError::new("capture_start_failed", format!("recording file could not be opened: {e}")))?;
        let core = Core::<Win>::new(events, request.frame_rate, supported_bitrate(request.audio_bitrate), sound_inputs.len(), file);
        let frame_log = core.log_frames(&request.path);
        if let Some(input) = sound_inputs.iter().position(|sound| matches!(sound, Sound::Microphone(_))) {
            core.watch_microphone(input);
        }
        let (frame_rate, video_bitrate, audio_bitrate) = (request.frame_rate, request.video_bitrate, request.audio_bitrate);
        let encoder_gpu = gpu.clone();
        // Which H.264 encoder records and why (plan 078 step 4), for the log.
        let encoder_note = Arc::new(std::sync::Mutex::new(None::<String>));
        let note = encoder_note.clone();
        let encoders = core.make_encoders(move |sink| {
            com();
            let video = H264Encoder::new(encoder_gpu, width, height, frame_rate, video_bitrate, sink)?;
            *note.lock().unwrap() = Some(video.description.clone());
            let audio = AacEncoder::new(SAMPLE_RATE, CHANNELS, audio_bitrate)?;
            Ok((video, audio))
        })?;

        let software = gpu.0.software;
        let (display, borderless, cpu) =
            DisplayCapture::start(gpu, &item, area, width, height, Pacer::capture_interval_ns(request.frame_rate), core.shared())?;
        mark("display capture start");
        let mut session = Session { display, sounds: Vec::new(), core };
        for (input, sound) in sound_inputs.iter().enumerate() {
            match SoundCapture::start(sound, input, session.core.shared()) {
                Ok(capture) => session.sounds.push(capture),
                Err(error) => {
                    session.halt();
                    return Err(error);
                }
            }
        }
        mark("audio capture start");
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
        warnings.extend(session.sounds.iter().filter_map(|sound| sound.note.clone()));
        warnings.extend(encoder_note.lock().unwrap().take());
        warnings.extend(frame_log.map(|path| format!("per-frame log: {}", path.display())));
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
            microphone: session.sounds.iter().find_map(|sound| sound.name.clone()),
        };
        Ok((session, prepared))
    }

    /// Starts the file at this moment: the newest frame is its first, a key frame at time zero.
    /// No camera on Windows yet (plan 075 step 6's Windows part).
    pub fn set_camera(&self, _layout: crate::camera_layout::Layout, _hidden: bool) -> bool {
        false
    }

    pub fn record(&mut self) -> Result<(), CaptureError> {
        self.core.record()
    }

    /// Stops capture and the encoders; the file is finished in the background (`Finishing::wait`).
    pub fn stop(mut self) -> (Stopped, Finishing) {
        com();
        let stop_ns = now_ns();
        let drained = self.core.drain(stop_ns);
        self.halt();
        self.core.end(stop_ns, drained)
    }

    /// Ends capture and frame refreshes; frames and sound arriving afterwards are ignored.
    fn halt(&mut self) {
        self.core.halt();
        self.display.stop();
        for sound in &mut self.sounds {
            sound.stop();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chosen_apps_windows_are_refused_with_the_reason() {
        let error = capture_item(&Source::Apps(vec![4]), None).expect_err("refused");
        assert_eq!(error.code, "capture_start_failed");
        assert!(error.detail.contains("cannot record only chosen apps' windows"), "{}", error.detail);
    }

    #[test]
    fn the_sound_inputs_are_the_system_or_chosen_processes_then_the_microphone() {
        let own = [10, 11];
        assert_eq!(sounds(&AudioRequest::default(), &own), [Sound::AllExcept(10)]);
        let request = AudioRequest { system: SystemAudio::Apps(vec![20, 21]), microphone: Some(Some("mic".into())) };
        assert_eq!(sounds(&request, &own), [Sound::Only(20), Sound::Only(21), Sound::Microphone(Some("mic".into()))]);
        let request = AudioRequest { system: SystemAudio::Off, microphone: Some(None) };
        assert_eq!(sounds(&request, &own), [Sound::Microphone(None)]);
    }
}
