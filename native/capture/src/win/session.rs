//! One recording on Windows: capture of the display, a window or an area, and the sound inputs (system audio or chosen
//! processes', and the microphone), started at `prepare`, hand their frames and sound to the shared core (core.rs),
//! which decides what is encoded and when the recording ends, as on macOS. Windows.Graphics.Capture has no way to show
//! only chosen apps' windows, so that source is refused.
//!
//! RecordStuff's own windows are not left out here: Windows.Graphics.Capture cannot leave out another process's
//! windows, so main marks its windows excluded from capture (`WDA_EXCLUDEFROMCAPTURE`) for the session.

use std::fs::OpenOptions;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::aac::{AacEncoder, supported_bitrate};
use super::audio::{Sound, SoundCapture};
use super::camera::CameraCapture;
use super::capture::{self, Area, DisplayCapture, Frame, Gpu};
use super::compositor::{Compositor, Feed};
use super::video::H264Encoder;
use super::{CaptureError, Mta, com, now_ns};
use crate::camera_layout::PREVIEW_FPS;
use crate::core::{self, AudioRequest, CHANNELS, Core, Platform, SAMPLE_RATE, Shared, Source, SystemAudio, VideoEncode};
use crate::pacing::Pacer;

pub use crate::core::{Events, Finished, Finishing, PrepareRequest, Prepared, Stopped};

const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(3);
/// The preview stream's average bit rate: enough for 640 pixels at 10 fps.
const PREVIEW_BITRATE: u32 = 1_000_000;

pub struct Win;

impl Platform for Win {
    type Frame = Frame;
    type Video = Video;
    type Audio = AacEncoder;

    fn now_ns() -> u64 {
        now_ns()
    }
}

/// The H.264 encoder, with the camera composed into each frame it encodes when one is on (plan 075): at encoding time,
/// so a frame encoded again on a still screen holds the camera's newest picture.
pub struct Video {
    encoder: H264Encoder,
    compositor: Option<Arc<Compositor>>,
}

impl VideoEncode<Frame> for Video {
    fn encode(&self, frame: &Frame, pts_ns: u64, key_frame: bool) -> Result<(), String> {
        // Hidden (D13): the screen's own frame, exactly as with the camera off.
        match self.compositor.as_ref().filter(|compositor| !compositor.hidden()) {
            Some(compositor) => {
                let composed = compositor.compose(frame).map_err(|detail| format!("composing the camera failed: {detail}"))?;
                self.encoder.encode(&composed, pts_ns, key_frame)
            }
            None => self.encoder.encode(frame, pts_ns, key_frame),
        }
    }

    fn flush(&self) {
        self.encoder.flush()
    }
}

/// The preview (D17), as on macOS: the composed picture at preview size, `PREVIEW_FPS` times a second, encoded by
/// Microsoft's software encoder (the GPU's is the recording's) and told to the session's events while someone watches;
/// unwatched it composes and encodes nothing, and it starts again at a key frame.
struct Preview {
    stopped: Arc<AtomicBool>,
    watching: Arc<AtomicBool>,
    /// Counts each start of watching, so one that comes between two of the thread's ticks still starts at a key frame.
    watches: Arc<AtomicU64>,
    thread: Option<JoinHandle<()>>,
}

impl Preview {
    fn start(gpu: Arc<Mta<Gpu>>, shared: Arc<Shared<Win>>, compositor: Arc<Compositor>, watching: bool) -> Result<Self, CaptureError> {
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let watching = Arc::new(AtomicBool::new(watching));
        let watched = watching.clone();
        let watches = Arc::new(AtomicU64::new(0));
        let started = watches.clone();
        let (width, height) = compositor.preview_size();
        let sink = Arc::new(core::PreviewSink::new(shared.events()));
        let encoder = H264Encoder::for_preview(gpu, width, height, PREVIEW_FPS, PREVIEW_BITRATE, sink)?;
        let thread = std::thread::Builder::new()
            .name("recordstuff-preview".into())
            .spawn(move || {
                com();
                let interval = Duration::from_nanos(1_000_000_000 / u64::from(PREVIEW_FPS));
                let mut next = Instant::now();
                let mut first = true;
                let mut seen = 0;
                while !stop.load(Ordering::Acquire) && !shared.halted() {
                    let now_started = started.load(Ordering::Acquire);
                    if now_started != seen {
                        seen = now_started;
                        first = true;
                    }
                    if !watched.load(Ordering::Acquire) {
                        first = true;
                    } else if let Some(frame) = shared.newest() {
                        // A preview is a convenience: one that fails ends, the recording does not.
                        let Ok(picture) = compositor.preview(&frame) else { return };
                        if encoder.encode(&picture, now_ns(), first).is_err() {
                            return;
                        }
                        first = false;
                    }
                    next += interval;
                    let now = Instant::now();
                    if next > now {
                        std::thread::sleep(next - now);
                    } else {
                        next = now;
                    }
                }
                encoder.flush();
            })
            .map_err(|e| CaptureError::new("capture_start_failed", format!("preview thread: {e}")))?;
        Ok(Self { stopped, watching, watches, thread: Some(thread) })
    }

    fn stop(mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
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
    /// The camera composed into the frames (plan 075), which the core closes, its compositor and the preview.
    camera: Option<Arc<CameraCapture>>,
    compositor: Option<Arc<Compositor>>,
    preview: Option<Preview>,
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
        // The camera (plan 075): only main's request, which comes only while the Camera switch is on. Opened before the
        // screen, so a camera that cannot open refuses the start (camera_unavailable, D11) before anything else runs.
        let camera_request = request.camera.clone();
        let (mut camera, mut compositor, mut camera_note) = (None, None, None);
        if let Some(wanted) = camera_request.as_ref() {
            let shared = core.shared();
            let opened = CameraCapture::start(gpu.clone(), wanted.device.as_deref(), shared.events(), move || shared.recording())?;
            let made = Compositor::new(gpu.clone(), width, height, wanted.layout, opened.feed.clone())
                .map_err(|detail| CaptureError::new("capture_start_failed", format!("camera compositor: {detail}")))?;
            camera_note = Some(format!("camera: {}, {:?}, preview {}", opened.name, wanted.layout, wanted.preview));
            compositor = Some(Arc::new(made));
            core.watch_camera(opened.clone());
            camera = Some(opened);
            core.encode_every_slot(true);
            mark("camera start");
        }
        let (frame_rate, video_bitrate, audio_bitrate) = (request.frame_rate, request.video_bitrate, request.audio_bitrate);
        let encoder_gpu = gpu.clone();
        let encoder_compositor = compositor.clone();
        // Which H.264 encoder records and why (plan 078 step 4), for the log.
        let encoder_note = Arc::new(std::sync::Mutex::new(None::<String>));
        let note = encoder_note.clone();
        let encoders = core.make_encoders(move |sink| {
            com();
            let video = H264Encoder::new(encoder_gpu, width, height, frame_rate, video_bitrate, sink)?;
            *note.lock().unwrap() = Some(video.description.clone());
            let video = Video { encoder: video, compositor: encoder_compositor };
            let audio = AacEncoder::new(SAMPLE_RATE, CHANNELS, audio_bitrate)?;
            Ok((video, audio))
        })?;

        let software = gpu.0.software;
        let (display, borderless, cpu) =
            DisplayCapture::start(gpu.clone(), &item, area, width, height, Pacer::capture_interval_ns(request.frame_rate), core.shared())?;
        mark("display capture start");
        let mut session = Session { display, sounds: Vec::new(), camera, compositor: compositor.clone(), preview: None, core };
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
        if let Some(camera) = session.camera.as_ref() {
            eprintln!("camera: after preparing {}", camera.state());
        }
        // Every session has its preview (plan 075, D19/D20), watched only when asked; without a camera it renders the
        // screen alone through a compositor of its own, hidden, which the recording's frames never use.
        let preview_compositor = compositor.or_else(|| match Compositor::new(gpu.clone(), width, height, crate::camera_layout::Layout::default(), Arc::new(Feed::default())) {
            Ok(made) => {
                made.set_hidden(true);
                Some(Arc::new(made))
            }
            Err(detail) => {
                eprintln!("preview: no compositor ({detail})");
                None
            }
        });
        if let Some(compositor) = preview_compositor {
            // A preview is a convenience: without one Settings shows no picture, and the recording goes on.
            match Preview::start(gpu.clone(), session.core.shared(), compositor, camera_request.as_ref().is_some_and(|wanted| wanted.preview)) {
                Ok(preview) => session.preview = Some(preview),
                Err(error) => eprintln!("camera: no preview ({}: {})", error.code, error.detail),
            }
        }

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
        warnings.extend(camera_note);
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

    /// The camera's bubble and whether it is shown, from the next frame on (plan 075, D7 and D13); while it is hidden
    /// the screen alone is encoded, at today's pace for a still screen. Answers false without a camera.
    pub fn set_camera(&self, layout: crate::camera_layout::Layout, hidden: bool) -> bool {
        let Some(compositor) = self.compositor.as_ref() else { return false };
        compositor.set_layout(layout);
        compositor.set_hidden(hidden);
        self.core.encode_every_slot(!hidden);
        eprintln!("camera: layout {:?}, {}", compositor.layout(), if hidden { "hidden" } else { "shown" });
        true
    }

    /// Whether the preview is watched (plan 075 step 7): Settings shows it, or no longer does. False without one.
    pub fn set_preview(&self, watching: bool) -> bool {
        let Some(preview) = self.preview.as_ref() else { return false };
        if watching {
            // A new watcher has a new decoder, which can start only at a key frame.
            preview.watches.fetch_add(1, Ordering::AcqRel);
        }
        preview.watching.store(watching, Ordering::Release);
        eprintln!("camera: preview {}", if watching { "watched" } else { "not watched" });
        true
    }

    /// Whether the inputs' levels are told (plan 075, D19).
    pub fn watch_levels(&self, watching: bool) -> bool {
        self.core.watch_levels(watching);
        true
    }

    /// Mutes system audio and the microphone, or not, from their next sound on (D19).
    pub fn set_muted(&self, system: bool, microphone: bool) -> bool {
        self.core.set_muted(system, microphone);
        eprintln!("audio: system {}, microphone {}", if system { "muted" } else { "on" }, if microphone { "muted" } else { "on" });
        true
    }

    /// The inputs' volumes in dB from their next sound on (plan 075, D21).
    pub fn set_gains(&self, system_db: f64, microphone_db: f64) -> bool {
        self.core.set_gains(system_db, microphone_db);
        true
    }

    /// Starts the file at this moment: the newest frame is its first, a key frame at time zero.
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
        if let Some(preview) = self.preview.take() {
            preview.stop();
        }
        if let Some(camera) = self.camera.take() {
            // The capture host's stderr reaches main's log; the core closes the camera in `halted`, below.
            eprintln!("camera: at the stop {}", camera.state());
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

    #[derive(Default)]
    struct Chunks(std::sync::Mutex<Vec<core::PreviewChunk>>);

    impl Events for Chunks {
        fn progress(&self, _bytes: u64) {}
        fn write_failed(&self, _failure: crate::writer::WriteFailure) {}
        fn capture_failed(&self, _code: &'static str, _detail: String) {}
        fn microphone_lost(&self, _detail: String) {}
        fn microphone_resumed(&self, _detail: String) {}
        fn preview(&self, chunk: core::PreviewChunk) {
            self.0.lock().unwrap().push(chunk);
        }
    }

    #[test]
    fn the_preview_is_an_h264_stream_whose_key_frames_carry_the_avcc_record() {
        com();
        let gpu = Gpu::new().unwrap();
        let compositor = Compositor::new(gpu.clone(), 1280, 720, crate::camera_layout::Layout::default(), Arc::new(Feed::default())).unwrap();
        let chunks = Arc::new(Chunks::default());
        let (width, height) = compositor.preview_size();
        let encoder = H264Encoder::for_preview(gpu.clone(), width, height, PREVIEW_FPS, PREVIEW_BITRATE, Arc::new(core::PreviewSink::new(chunks.clone()))).unwrap();
        // A grey screen as capture makes it.
        let data = vec![128u8; 1280 * 720 * 3 / 2];
        let initial = windows::Win32::Graphics::Direct3D11::D3D11_SUBRESOURCE_DATA { pSysMem: data.as_ptr().cast(), SysMemPitch: 1280, SysMemSlicePitch: 0 };
        let desc = windows::Win32::Graphics::Direct3D11::D3D11_TEXTURE2D_DESC {
            Width: 1280,
            Height: 720,
            MipLevels: 1,
            ArraySize: 1,
            Format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12,
            SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: windows::Win32::Graphics::Direct3D11::D3D11_USAGE_DEFAULT,
            BindFlags: windows::Win32::Graphics::Direct3D11::D3D11_BIND_RENDER_TARGET.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe { gpu.0.device.CreateTexture2D(&desc, Some(&initial), Some(&mut texture)) }.unwrap();
        let screen: Frame = Arc::new(Mta(capture::Captured::detached(texture.unwrap(), capture::Image::Nv12)));
        for n in 0..5u64 {
            let picture = compositor.preview(&screen).unwrap();
            encoder.encode(&picture, 1_000_000_000 + n * 100_000_000, n == 0).unwrap();
        }
        encoder.flush();
        let chunks = chunks.0.lock().unwrap();
        assert!(chunks.len() >= 4, "{} chunks", chunks.len());
        let first = &chunks[0];
        assert!(first.key && (first.width, first.height) == (640, 360), "{first:?}");
        // An avcC record starts with version 1.
        assert_eq!(first.description.as_ref().map(|d| d[0]), Some(1));
        assert!(chunks[1..].iter().all(|chunk| chunk.description.is_none() || chunk.key));
        // AVCC: the first NAL unit's 4-byte length fits in the chunk.
        let length = u32::from_be_bytes(first.data[..4].try_into().unwrap()) as usize;
        assert!(length + 4 <= first.data.len());
    }

    #[test]
    fn without_a_camera_connected_none_is_listed_and_opening_one_is_refused() {
        // A runner has no camera; a machine with one checks only that it is listed with a name.
        let cameras = super::super::camera::list();
        if let Some(camera) = cameras.first() {
            assert!(camera.default && !camera.name.is_empty() && !camera.id.is_empty());
            return;
        }
        com();
        let gpu = Gpu::new().unwrap();
        let error = CameraCapture::start(gpu, None, Arc::new(Chunks::default()), || false).err().expect("refused");
        assert_eq!(error.code, "camera_unavailable");
        assert!(error.detail.contains("no camera is connected"), "{}", error.detail);
    }

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
