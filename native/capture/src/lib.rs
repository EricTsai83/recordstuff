//! RecordStuff's native capture engine (plan 076): capture, encoding and the hybrid MP4 file, loaded by the capture
//! host in an Electron `utilityProcess` (src/main/recording/native-host-process.ts). Its JavaScript interface is
//! `NativeCapture`: `probe` the display, `prepare` capture into the file main created, `record`, then `stop` (or
//! `cancel` before recording), which answers once capture has ended, and `finish`, which answers once the file is
//! plain or why it is not is known: a slow volume's save is no part of the stop. Events arrive on the callback given
//! to the constructor.
//!
//! A failure rejects with a message `code|detail`, where `code` is one of the capture host's error codes.

pub mod core;
pub mod edit;
mod export_api;
pub mod mux;
pub mod pacing;
pub mod timing;
pub mod writer;

pub mod aac;
pub mod async_encoder;
pub mod avc;
pub mod camera_layout;
pub mod encoder_choice;
pub mod nv12;

#[cfg(target_os = "macos")]
pub mod mac;
#[cfg(target_os = "macos")]
use mac as platform;
#[cfg(windows)]
pub mod win;
#[cfg(windows)]
use win as platform;

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{AsyncTask, Buffer, Function};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;

#[napi(object)]
pub struct ProbeResult {
    /// The display's size in pixels.
    pub width: u32,
    pub height: u32,
}

/// A point in physical screen pixels.
#[napi(object)]
#[derive(Clone, Copy)]
pub struct DisplayPoint {
    pub x: i32,
    pub y: i32,
}

/// What the picture shows; absent is the whole display.
#[napi(object)]
pub struct CaptureSource {
    /// `display`, `window`, `area` or `apps`.
    pub kind: String,
    /// `window`: its CGWindowID on macOS, its HWND on Windows.
    pub window_id: Option<i64>,
    /// `area`: in the display's pixels from its top-left corner.
    pub area: Option<Area>,
    /// `apps`: the processes whose windows are shown (macOS).
    pub pids: Option<Vec<i32>>,
}

#[napi(object)]
#[derive(Clone, Copy)]
pub struct Area {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// The track's sound; absent is today's: everything the system plays except RecordStuff, and no microphone.
#[napi(object)]
pub struct AudioOptions {
    /// `all`, `apps` or `off`.
    pub system: String,
    /// `apps`: whose sound.
    pub pids: Option<Vec<i32>>,
    /// Mixes the microphone in.
    pub microphone: bool,
    /// The device `microphones` listed; absent is the system's default input.
    pub microphone_id: Option<String>,
}

/// A camera the engine can open (plan 075, D9).
#[napi(object)]
pub struct CameraInfo {
    pub id: String,
    pub name: String,
    pub default: bool,
}

#[napi(object)]
pub struct MicrophoneInfo {
    pub id: String,
    pub name: String,
    pub default: bool,
    /// Built into a MacBook whose lid is closed (plan 089): it records only digital silence.
    pub lid_closed: bool,
}

#[cfg(any(target_os = "macos", windows))]
fn source(source: Option<CaptureSource>) -> Result<core::Source> {
    let Some(source) = source else { return Ok(core::Source::Display) };
    let missing = |what: &str| failure("capture_start_failed", format!("a {} source needs its {what}", source.kind));
    Ok(match source.kind.as_str() {
        "display" => core::Source::Display,
        "window" => core::Source::Window(u64::try_from(source.window_id.ok_or_else(|| missing("windowId"))?).map_err(|_| missing("windowId"))?),
        "area" => {
            let area = source.area.ok_or_else(|| missing("area"))?;
            if area.width < 2 || area.height < 2 {
                return Err(failure("capture_start_failed", format!("an area of {}x{} pixels is too small to record", area.width, area.height)));
            }
            core::Source::Area { x: area.x, y: area.y, width: area.width, height: area.height }
        }
        "apps" => core::Source::Apps(source.pids.clone().filter(|pids| !pids.is_empty()).ok_or_else(|| missing("pids"))?),
        other => return Err(failure("capture_start_failed", format!("unknown capture source {other:?}"))),
    })
}

#[cfg(any(target_os = "macos", windows))]
fn audio(audio: Option<AudioOptions>) -> Result<core::AudioRequest> {
    let Some(audio) = audio else { return Ok(core::AudioRequest::default()) };
    let system = match audio.system.as_str() {
        "all" => core::SystemAudio::All,
        "apps" => core::SystemAudio::Apps(
            audio.pids.clone().filter(|pids| !pids.is_empty()).ok_or_else(|| failure("capture_start_failed", "app audio needs its pids"))?,
        ),
        "off" => core::SystemAudio::Off,
        other => return Err(failure("capture_start_failed", format!("unknown system audio {other:?}"))),
    };
    Ok(core::AudioRequest { system, microphone: audio.microphone.then_some(audio.microphone_id) })
}

/// The camera composed into the recording (plan 075): which one, and its bubble on the recorded display.
#[napi(object)]
pub struct CameraOptions {
    /// AVCaptureDevice's unique ID on macOS, Media Foundation's symbolic link on Windows; absent is the system's default camera.
    pub device_id: Option<String>,
    /// Fractions of the frame's shorter side, 0.05 to 0.6 (src/shared/camera-layout.ts).
    pub width: f64,
    pub height: f64,
    /// 0 to 1, 1 being half the bubble's shorter side.
    pub rounding: f64,
    /// The position as a fraction of the free space on each axis.
    pub x: f64,
    pub y: f64,
    pub mirror: bool,
    /// Whether the preview is watched from the start (`setCameraPreview` changes it); absent is not.
    pub preview: Option<bool>,
}

#[napi(object)]
pub struct PrepareOptions {
    /// The display's CGDirectDisplayID on macOS; unused on Windows.
    pub display_id: u32,
    /// A point on the display: how Windows finds it. Unused on macOS.
    pub display_point: Option<DisplayPoint>,
    pub width: u32,
    pub height: u32,
    pub frame_rate: u32,
    pub video_bitrate: u32,
    pub audio_bitrate: u32,
    /// RecordStuff's processes, main first; their windows and sound are left out.
    pub own_pids: Vec<i32>,
    pub hide_system_ui: bool,
    /// The temporary recording file main created; the engine writes it from the start.
    pub path: String,
    pub source: Option<CaptureSource>,
    pub audio: Option<AudioOptions>,
    pub camera: Option<CameraOptions>,
}

#[napi(object)]
pub struct PreparedInfo {
    pub width: u32,
    pub height: u32,
    pub sample_rate: u32,
    pub channel_count: u32,
    pub priming_frames: u32,
    pub excluded_apps: u32,
    pub hidden_windows: u32,
    pub warnings: Vec<String>,
    /// Where preparing spent its time, for the log.
    pub timings: String,
    /// The microphone actually opened (074), by name; absent without one.
    pub microphone: Option<String>,
}

#[napi(object)]
pub struct StopReport {
    /// How long the sound up to the stop took to arrive, and how many of its frames were filled with silence.
    pub drain_ms: f64,
    pub drain_padded_frames: f64,
    /// How far ahead of the host clock frames were stamped when handed over: average and maximum, in ms.
    pub frame_lead_avg_ms: f64,
    pub frame_lead_max_ms: f64,
    /// Frames each audio input delivered too late to be mixed.
    pub late_audio_frames: Vec<f64>,
    /// Frames of silence inserted, and frames dropped, to keep each audio input on the clock (drift and gaps).
    pub inserted_audio_frames: Vec<f64>,
    pub dropped_audio_frames: Vec<f64>,
    /// Samples where two inputs summed past -1 dBFS and were limited.
    pub limited_audio_samples: f64,
    /// While recording: frames capture delivered with a picture and without one, and the longest gap between pictures.
    pub captured_pictures: f64,
    pub captured_without_picture: f64,
    pub captured_longest_gap_ms: f64,
}

#[napi(object)]
pub struct FinishReport {
    pub bytes: f64,
    /// Why the file stayed fragmented, when it did.
    pub fragmented: Option<String>,
    /// From the stop's end to the file's.
    pub finalize_ms: f64,
}

#[napi(object)]
#[derive(Clone, Default)]
pub struct EngineEvent {
    /// `progress`, `writeError`, `captureError`, `microphoneLost` (074: the recording goes on without it), `cameraLost`
    /// and `cameraResumed` (plan 075, the same for the camera), `cameraReady` and `cameraNotReady` (plan 090: the first frame, or none in time), `levels` (plan 075, D19: the inputs' peaks), and plan
    /// 079's `microphoneSwitched`, `microphoneSwitchFailed`, `meter`, `meterLost` and `devices` (the list changed).
    pub kind: String,
    pub bytes: Option<f64>,
    pub code: Option<String>,
    pub detail: Option<String>,
    /// With `levels`: system audio's and the microphone's loudest sample since the last, linear, 1 full scale.
    pub system: Option<f64>,
    pub microphone: Option<f64>,
    /// With `meter` (plan 079, D1): Settings' meter's peak and RMS over the last 50 ms, linear.
    pub peak: Option<f64>,
    pub rms: Option<f64>,
    /// With `microphoneSwitched` (plan 079, D3): the device recorded before and the one recorded now.
    pub from: Option<String>,
    pub to: Option<String>,
}

type EventCallback = ThreadsafeFunction<EngineEvent, (), EngineEvent, Status, false>;

/// A preview chunk of the composed picture (plan 075, step 2's prototype; D17's second option): H.264 in AVCC form for
/// WebCodecs' `VideoDecoder`, the `avcC` record (`description`) with every key frame.
#[napi(object)]
pub struct PreviewFrame {
    pub width: u32,
    pub height: u32,
    pub data: Buffer,
    pub key: bool,
    /// Host time it was captured, in microseconds.
    pub timestamp: f64,
    pub description: Option<Buffer>,
}

type PreviewCallback = ThreadsafeFunction<PreviewFrame, (), PreviewFrame, Status, false, true>;

/// At most this many preview chunks wait for the JavaScript thread; newer ones are dropped before they are queued.
/// The queue itself is unbounded: a call napi refuses as full leaks its chunk (napi 3.14's `call` does not take it back).
const PREVIEW_IN_FLIGHT: usize = 2;

/// Which preview chunks go to the JavaScript thread. A chunk that does not fit is dropped, and so is every chunk after
/// it until the next key frame: H.264's delta frames refer to the frames before them, so a decoder given one after a
/// gap shows corruption or fails until a key frame comes (the encoder makes one every second).
#[derive(Default)]
pub struct PreviewGate {
    in_flight: std::sync::atomic::AtomicUsize,
    awaiting_key: std::sync::atomic::AtomicBool,
    /// Chunks sent and dropped (refused or never queued) by this process (plan 083), which runs one session.
    sent: std::sync::atomic::AtomicU64,
    dropped: std::sync::atomic::AtomicU64,
}

impl PreviewGate {
    /// Whether a chunk, a key frame or not, is sent; a sent chunk is `done` once the JavaScript thread has taken it.
    pub fn admit(&self, key: bool) -> bool {
        use std::sync::atomic::Ordering;
        if !key && self.awaiting_key.load(Ordering::Acquire) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        if self.in_flight.fetch_add(1, Ordering::AcqRel) >= PREVIEW_IN_FLIGHT {
            self.in_flight.fetch_sub(1, Ordering::AcqRel);
            self.awaiting_key.store(true, Ordering::Release);
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        self.awaiting_key.store(false, Ordering::Release);
        self.sent.fetch_add(1, Ordering::Relaxed);
        true
    }

    /// Chunks sent and dropped so far.
    pub fn counts(&self) -> (u64, u64) {
        use std::sync::atomic::Ordering;
        (self.sent.load(Ordering::Relaxed), self.dropped.load(Ordering::Relaxed))
    }

    pub fn done(&self) {
        self.in_flight.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }

    /// A sent chunk napi did not queue: never taken, and the stream has a gap.
    pub fn lost(&self) {
        self.done();
        self.awaiting_key.store(true, std::sync::atomic::Ordering::Release);
        // Counted as sent by `admit`: it is a drop after all.
        self.sent.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        self.dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

struct PreviewSink {
    callback: PreviewCallback,
    gate: Arc<PreviewGate>,
}

fn failure(code: &str, detail: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{code}|{detail}"))
}

struct Emitter(Arc<EventCallback>, Arc<Mutex<Option<PreviewSink>>>);

impl Emitter {
    fn emit(&self, event: EngineEvent) {
        self.0.call(event, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

#[cfg(any(target_os = "macos", windows))]
impl core::Events for Emitter {
    fn progress(&self, bytes: u64) {
        self.emit(EngineEvent { kind: "progress".into(), bytes: Some(bytes as f64), code: None, detail: None, ..Default::default() });
    }

    fn write_failed(&self, failure: writer::WriteFailure) {
        self.emit(EngineEvent { kind: "writeError".into(), bytes: None, code: Some(failure.code.into()), detail: Some(failure.detail), ..Default::default() });
    }

    fn capture_failed(&self, code: &'static str, detail: String) {
        self.emit(EngineEvent { kind: "captureError".into(), bytes: None, code: Some(code.into()), detail: Some(detail), ..Default::default() });
    }

    fn microphone_lost(&self, detail: String) {
        self.emit(EngineEvent { kind: "microphoneLost".into(), bytes: None, code: None, detail: Some(detail), ..Default::default() });
    }
    fn microphone_resumed(&self, detail: String) {
        self.emit(EngineEvent { kind: "microphoneResumed".into(), bytes: None, code: None, detail: Some(detail), ..Default::default() });
    }
    fn microphone_switched(&self, from: String, to: String) {
        self.emit(EngineEvent { kind: "microphoneSwitched".into(), from: Some(from), to: Some(to), ..Default::default() });
    }
    fn microphone_switch_failed(&self, detail: String) {
        self.emit(EngineEvent { kind: "microphoneSwitchFailed".into(), detail: Some(detail), ..Default::default() });
    }

    fn camera_lost(&self, detail: String) {
        self.emit(EngineEvent { kind: "cameraLost".into(), bytes: None, code: None, detail: Some(detail), ..Default::default() });
    }
    fn camera_ready(&self, detail: String) {
        self.emit(EngineEvent { kind: "cameraReady".into(), bytes: None, code: None, detail: Some(detail), ..Default::default() });
    }
    fn camera_not_ready(&self, detail: String) {
        self.emit(EngineEvent { kind: "cameraNotReady".into(), bytes: None, code: None, detail: Some(detail), ..Default::default() });
    }
    fn camera_resumed(&self, detail: String) {
        self.emit(EngineEvent { kind: "cameraResumed".into(), bytes: None, code: None, detail: Some(detail), ..Default::default() });
    }
    fn levels(&self, levels: core::Levels) {
        self.emit(EngineEvent {
            kind: "levels".into(),
            system: Some(f64::from(levels.system)),
            microphone: levels.microphone.map(f64::from),
            ..Default::default()
        });
    }

    fn preview(&self, chunk: core::PreviewChunk) {
        let guard = self.1.lock().unwrap();
        let Some(sink) = guard.as_ref() else { return };
        if !sink.gate.admit(chunk.key) {
            return;
        }
        let gate = sink.gate.clone();
        let done = gate.clone();
        let status = sink.callback.call_with_return_value(
            PreviewFrame {
                width: chunk.width,
                height: chunk.height,
                data: chunk.data.into(),
                key: chunk.key,
                timestamp: chunk.timestamp_us as f64,
                description: chunk.description.map(Buffer::from),
            },
            ThreadsafeFunctionCallMode::NonBlocking,
            move |_, _| {
                done.done();
                Ok(())
            },
        );
        // Not queued (the callback is closing): it will never answer.
        if status != Status::Ok {
            gate.lost();
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
type Session = platform::session::Session;
#[cfg(any(target_os = "macos", windows))]
type Meter = platform::meter::Meter;
#[cfg(not(any(target_os = "macos", windows)))]
type Meter = ();
#[cfg(any(target_os = "macos", windows))]
type DeviceWatch = platform::meter::DeviceWatch;
#[cfg(not(any(target_os = "macos", windows)))]
type DeviceWatch = ();
#[cfg(not(any(target_os = "macos", windows)))]
type Session = ();
#[cfg(any(target_os = "macos", windows))]
type Finishing = core::Finishing;
#[cfg(not(any(target_os = "macos", windows)))]
type Finishing = ();
#[cfg(any(target_os = "macos", windows))]
type SessionDiagnostics = Arc<core::Diagnostics>;
#[cfg(not(any(target_os = "macos", windows)))]
type SessionDiagnostics = ();

#[napi]
pub struct NativeCapture {
    session: Arc<Mutex<Option<Session>>>,
    /// The stopped session's file, until `finish` takes it.
    finishing: Arc<Mutex<Option<Finishing>>>,
    events: Arc<EventCallback>,
    /// Where preview frames go, when a preview is wanted (plan 075's prototype).
    preview: Arc<Mutex<Option<PreviewSink>>>,
    /// Settings' input level meter (plan 079, D1), in the process that lists the inputs, never a recording's.
    meter: Arc<Mutex<Option<Meter>>>,
    /// The device list followed while Settings is open (D2).
    devices: Mutex<Option<DeviceWatch>>,
    /// The last prepared session's stage figures (plan 083), until the next session is prepared.
    diagnostics: Arc<Mutex<Option<SessionDiagnostics>>>,
}

#[napi]
impl NativeCapture {
    #[napi(constructor)]
    pub fn new(on_event: Function<EngineEvent, ()>) -> Result<Self> {
        let events = on_event.build_threadsafe_function().callee_handled::<false>().build()?;
        Ok(Self {
            session: Arc::new(Mutex::new(None)),
            finishing: Arc::new(Mutex::new(None)),
            events: Arc::new(events),
            preview: Arc::new(Mutex::new(None)),
            meter: Arc::new(Mutex::new(None)),
            devices: Mutex::new(None),
            diagnostics: Arc::new(Mutex::new(None)),
        })
    }

    /// The latest session's stage figures so far as JSON (plan 083, core/diagnostics.rs), with the preview chunks this
    /// process sent to and dropped before the JavaScript thread; null unless the session keeps figures
    /// (`RECORDSTUFF_DIAGNOSTICS=1`). Cumulative and read as often as wanted: the capture host reads them while the
    /// session runs, since main ends a Live preview by ending the process, and once more when the session has ended.
    #[napi]
    pub fn diagnostics(&self) -> Option<String> {
        let current = self.diagnostics.lock().unwrap().clone();
        #[cfg(any(target_os = "macos", windows))]
        {
            let diagnostics = current?;
            let (sent, dropped) = self.preview.lock().unwrap().as_ref().map_or((0, 0), |sink| sink.gate.counts());
            Some(diagnostics.json(&[("preview_gate_sent", sent), ("preview_gate_dropped", dropped)]))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = current;
            None
        }
    }

    /// Sends preview frames of the composed picture to `on_frame` while a session with the camera prototype runs.
    /// Kept for the sessions after; while `PREVIEW_IN_FLIGHT` frames wait for the JavaScript thread, newer ones are
    /// dropped rather than queued behind them.
    #[napi]
    pub fn on_preview(&self, on_frame: Function<PreviewFrame, ()>) -> Result<()> {
        let callback = on_frame.build_threadsafe_function().callee_handled::<false>().weak::<true>().build()?;
        *self.preview.lock().unwrap() = Some(PreviewSink { callback, gate: Arc::new(PreviewGate::default()) });
        Ok(())
    }

    /// The source's size in pixels, for choosing the output size: the display's, the window's or the area's.
    #[napi(ts_return_type = "Promise<ProbeResult>")]
    pub fn probe(&self, display_id: u32, display_point: Option<DisplayPoint>, source: Option<CaptureSource>) -> AsyncTask<ProbeTask> {
        AsyncTask::new(ProbeTask { display_id, display_point: display_point.map(|p| (p.x, p.y)), source: Some(source) })
    }

    /// The cameras, for choosing one (plan 075).
    #[napi(ts_return_type = "Promise<CameraInfo[]>")]
    pub fn cameras(&self) -> AsyncTask<CamerasTask> {
        AsyncTask::new(CamerasTask)
    }

    /// The audio input devices, for choosing the microphone.
    #[napi(ts_return_type = "Promise<MicrophoneInfo[]>")]
    pub fn microphones(&self) -> AsyncTask<MicrophonesTask> {
        AsyncTask::new(MicrophonesTask)
    }

    /// Follows the device list, or stops following it (plan 079, D2): a `devices` event whenever an input is connected
    /// or leaves, or the default input changes. Rejects when the system will not tell.
    #[napi]
    pub fn watch_devices(&self, watching: bool) -> Result<()> {
        let mut devices = self.devices.lock().unwrap();
        if !watching {
            *devices = None;
            return Ok(());
        }
        if devices.is_some() {
            return Ok(());
        }
        #[cfg(any(target_os = "macos", windows))]
        {
            let events = self.events.clone();
            let changed = move || {
                events.call(EngineEvent { kind: "devices".into(), ..Default::default() }, ThreadsafeFunctionCallMode::NonBlocking);
            };
            *devices = Some(platform::meter::DeviceWatch::start(changed).map_err(|detail| failure("capture_start_failed", detail))?);
        }
        Ok(())
    }

    /// Settings' input level meter (plan 079, D1): reads `device_id`, or the system's default input, as a recording
    /// would, and tells `meter` events 20 times a second until `stop_meter`; a meter already running is replaced.
    /// Answers the name of the device read; rejects with `microphone_unavailable` when it cannot be read.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn start_meter(&self, device_id: Option<String>) -> AsyncTask<MeterTask> {
        AsyncTask::new(MeterTask { device: device_id.filter(|id| !id.is_empty()), meter: self.meter.clone(), events: self.events.clone() })
    }

    #[napi]
    pub fn stop_meter(&self) {
        let stopped = self.meter.lock().unwrap().take();
        drop(stopped);
    }

    /// Records another microphone from now on (plan 079, D3; absent is the system's default input); the outcome is told
    /// as `microphoneSwitched` or `microphoneSwitchFailed`. False when no session records a microphone.
    #[napi]
    pub fn set_microphone(&self, device_id: Option<String>) -> Result<bool> {
        #[cfg(any(target_os = "macos", windows))]
        {
            let device = device_id.filter(|id| !id.is_empty());
            Ok(self.session.lock().unwrap().as_ref().is_some_and(|session| session.switch_microphone(device)))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = device_id;
            Ok(false)
        }
    }

    #[napi(ts_return_type = "Promise<PreparedInfo>")]
    pub fn prepare(&self, options: PrepareOptions) -> AsyncTask<PrepareTask> {
        AsyncTask::new(PrepareTask {
            options: Some(options),
            session: self.session.clone(),
            events: self.events.clone(),
            preview: self.preview.clone(),
            diagnostics: self.diagnostics.clone(),
        })
    }

    /// The camera's bubble and whether it is shown (plan 075, D7 and D13), from the next frame on; answers false when
    /// no session composes a camera. `device_id` and `preview` are ignored here.
    #[napi]
    pub fn set_camera_layout(&self, options: CameraOptions, hidden: bool) -> Result<bool> {
        #[cfg(any(target_os = "macos", windows))]
        {
            let layout = camera_layout::Layout {
                width: options.width,
                height: options.height,
                rounding: options.rounding,
                x: options.x,
                y: options.y,
                mirror: options.mirror,
            };
            Ok(self.session.lock().unwrap().as_ref().is_some_and(|session| session.set_camera(layout, hidden)))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = (options, hidden);
            Ok(false)
        }
    }

    /// Whether the session's preview is watched (plan 075 step 7): its frames are composed and encoded only then, and
    /// start at a key frame. Answers false when no session composes a camera.
    #[napi]
    pub fn set_camera_preview(&self, watching: bool) -> Result<bool> {
        #[cfg(any(target_os = "macos", windows))]
        {
            Ok(self.session.lock().unwrap().as_ref().is_some_and(|session| session.set_preview(watching)))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = watching;
            Ok(false)
        }
    }

    /// The preview's frames a second (plan 092, D1): 5, 10 or 15, from a frame made at once. Answers false without a
    /// preview or for another rate.
    #[napi]
    pub fn set_preview_rate(&self, fps: u32) -> Result<bool> {
        #[cfg(any(target_os = "macos", windows))]
        {
            Ok(self.session.lock().unwrap().as_ref().is_some_and(|session| session.set_preview_rate(fps)))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = fps;
            Ok(false)
        }
    }

    /// What the preview shows (plan 092, D3; plan 094): `composed`, `screen` or `camera`, from a key frame made at once;
    /// the recording is always the composed picture. Answers false without a preview or for another view.
    #[napi]
    pub fn set_preview_view(&self, view: String) -> Result<bool> {
        #[cfg(any(target_os = "macos", windows))]
        {
            let Some(view) = camera_layout::PreviewView::parse(&view) else { return Ok(false) };
            Ok(self.session.lock().unwrap().as_ref().is_some_and(|session| session.set_preview_view(view)))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = view;
            Ok(false)
        }
    }

    /// A key frame at the preview's next frame time (plan 084): the Studio's page caught up after the capture host
    /// dropped chunks it could not take. Answers false without a preview or while it is not watched, when nothing is
    /// asked.
    #[napi]
    pub fn request_preview_key(&self) -> Result<bool> {
        #[cfg(any(target_os = "macos", windows))]
        {
            Ok(self.session.lock().unwrap().as_ref().is_some_and(|session| session.request_preview_key()))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            Ok(false)
        }
    }

    /// Whether the inputs' levels are told (plan 075, D19): `levels` events 10 times a second while sound is read.
    #[napi]
    pub fn watch_levels(&self, watching: bool) -> Result<bool> {
        #[cfg(any(target_os = "macos", windows))]
        {
            Ok(self.session.lock().unwrap().as_ref().is_some_and(|session| session.watch_levels(watching)))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = watching;
            Ok(false)
        }
    }

    /// Mutes system audio and the microphone, or not, from their next sound on (D19); false without a session.
    #[napi]
    pub fn set_muted(&self, system: bool, microphone: bool) -> Result<bool> {
        #[cfg(any(target_os = "macos", windows))]
        {
            Ok(self.session.lock().unwrap().as_ref().is_some_and(|session| session.set_muted(system, microphone)))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = (system, microphone);
            Ok(false)
        }
    }

    /// System audio's and the microphone's volumes in dB from their next sound on (D21); false without a session.
    #[napi]
    pub fn set_gains(&self, system_db: f64, microphone_db: f64) -> Result<bool> {
        #[cfg(any(target_os = "macos", windows))]
        {
            Ok(self.session.lock().unwrap().as_ref().is_some_and(|session| session.set_gains(system_db, microphone_db)))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = (system_db, microphone_db);
            Ok(false)
        }
    }

    /// Starts writing the prepared session; returns at once.
    #[napi]
    pub fn record(&self) -> Result<()> {
        #[cfg(any(target_os = "macos", windows))]
        {
            let mut guard = self.session.lock().unwrap();
            let session = guard.as_mut().ok_or_else(|| failure("capture_start_failed", "record refused: nothing is prepared"))?;
            session.record().map_err(|e| failure(e.code, e.detail))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        Err(failure("capture_start_failed", "native capture is not available on this platform yet"))
    }

    /// Ends capture and encoding; the file is then finished in the background, until `finish` answers.
    #[napi(ts_return_type = "Promise<StopReport>")]
    pub fn stop(&self) -> AsyncTask<StopTask> {
        AsyncTask::new(StopTask { session: self.session.clone(), finishing: self.finishing.clone() })
    }

    /// Waits for the stopped session's file. Rejects with `disk_full` or `output_write_failed` when it could not be
    /// finished; nothing stopped is an empty report.
    #[napi(ts_return_type = "Promise<FinishReport>")]
    pub fn finish(&self) -> AsyncTask<FinishTask> {
        AsyncTask::new(FinishTask { finishing: self.finishing.clone() })
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn cancel(&self) -> AsyncTask<CancelTask> {
        AsyncTask::new(CancelTask { session: self.session.clone() })
    }
}

pub struct ProbeTask {
    display_id: u32,
    display_point: Option<(i32, i32)>,
    source: Option<Option<CaptureSource>>,
}

impl Task for ProbeTask {
    type Output = (u32, u32);
    type JsValue = ProbeResult;

    fn compute(&mut self) -> Result<Self::Output> {
        #[cfg(any(target_os = "macos", windows))]
        {
            let source = source(self.source.take().flatten())?;
            platform::session::probe(self.display_id, self.display_point, &source).map_err(|e| failure(e.code, e.detail))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        Err(failure("capture_start_failed", "native capture is not available on this platform yet"))
    }

    fn resolve(&mut self, _env: Env, (width, height): Self::Output) -> Result<Self::JsValue> {
        Ok(ProbeResult { width, height })
    }
}

pub struct CamerasTask;

impl Task for CamerasTask {
    type Output = Vec<CameraInfo>;
    type JsValue = Vec<CameraInfo>;

    fn compute(&mut self) -> Result<Self::Output> {
        #[cfg(target_os = "macos")]
        {
            Ok(mac::camera::list().into_iter().map(|c| CameraInfo { id: c.id, name: c.name, default: c.default }).collect())
        }
        #[cfg(windows)]
        {
            Ok(win::camera::list().into_iter().map(|c| CameraInfo { id: c.id, name: c.name, default: c.default }).collect())
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        Ok(Vec::new())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct MicrophonesTask;

impl Task for MicrophonesTask {
    type Output = Vec<MicrophoneInfo>;
    type JsValue = Vec<MicrophoneInfo>;

    fn compute(&mut self) -> Result<Self::Output> {
        #[cfg(any(target_os = "macos", windows))]
        {
            let found = platform::microphone::list().map_err(|e| failure(e.code, e.detail))?;
            Ok(found.into_iter().map(|m| MicrophoneInfo { id: m.id, name: m.name, default: m.default, lid_closed: m.lid_closed }).collect())
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        Ok(Vec::new())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct MeterTask {
    device: Option<String>,
    meter: Arc<Mutex<Option<Meter>>>,
    events: Arc<EventCallback>,
}

impl Task for MeterTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        // The one running first: two units on one device are no use, and its levels must not follow the new one's.
        let previous = self.meter.lock().unwrap().take();
        drop(previous);
        #[cfg(any(target_os = "macos", windows))]
        {
            use platform::meter::MeterEvent;
            let events = self.events.clone();
            let tell = move |event: MeterEvent| {
                let event = match event {
                    MeterEvent::Level(level) => {
                        EngineEvent { kind: "meter".into(), peak: Some(f64::from(level.peak)), rms: Some(f64::from(level.rms)), ..Default::default() }
                    }
                    MeterEvent::Lost(detail) => EngineEvent { kind: "meterLost".into(), detail: Some(detail), ..Default::default() },
                };
                events.call(event, ThreadsafeFunctionCallMode::NonBlocking);
            };
            let meter = Meter::start(self.device.as_deref(), tell).map_err(|e| failure(e.code, e.detail))?;
            let name = meter.name.clone();
            *self.meter.lock().unwrap() = Some(meter);
            Ok(name)
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = (&self.device, &self.events);
            Err(failure("microphone_unavailable", "there is no meter on this platform"))
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct PrepareTask {
    options: Option<PrepareOptions>,
    session: Arc<Mutex<Option<Session>>>,
    events: Arc<EventCallback>,
    preview: Arc<Mutex<Option<PreviewSink>>>,
    diagnostics: Arc<Mutex<Option<SessionDiagnostics>>>,
}

impl Task for PrepareTask {
    type Output = PreparedInfo;
    type JsValue = PreparedInfo;

    fn compute(&mut self) -> Result<Self::Output> {
        let options = self.options.take().ok_or_else(|| failure("capture_start_failed", "prepare ran twice"))?;
        if self.session.lock().unwrap().is_some() {
            return Err(failure("capture_start_failed", "a recording is already in progress"));
        }
        #[cfg(any(target_os = "macos", windows))]
        {
            let request = core::PrepareRequest {
                display_id: options.display_id,
                display_point: options.display_point.map(|p| (p.x, p.y)),
                width: options.width,
                height: options.height,
                frame_rate: options.frame_rate,
                video_bitrate: options.video_bitrate,
                audio_bitrate: options.audio_bitrate,
                own_pids: options.own_pids,
                hide_system_ui: options.hide_system_ui,
                path: options.path.into(),
                source: source(options.source)?,
                audio: audio(options.audio)?,
                camera: options.camera.map(|camera| core::CameraRequest {
                    device: camera.device_id.filter(|id| !id.is_empty()),
                    layout: camera_layout::Layout {
                        width: camera.width,
                        height: camera.height,
                        rounding: camera.rounding,
                        x: camera.x,
                        y: camera.y,
                        mirror: camera.mirror,
                    }
                    .clamped(),
                    preview: camera.preview.unwrap_or(false),
                }),
            };
            let (session, prepared) =
                Session::prepare(request, Arc::new(Emitter(self.events.clone(), self.preview.clone()))).map_err(|e| failure(e.code, e.detail))?;
            *self.diagnostics.lock().unwrap() = session.diagnostics();
            *self.session.lock().unwrap() = Some(session);
            Ok(PreparedInfo {
                width: prepared.width,
                height: prepared.height,
                sample_rate: prepared.sample_rate,
                channel_count: prepared.channels,
                priming_frames: prepared.priming_frames,
                excluded_apps: prepared.excluded_apps as u32,
                hidden_windows: prepared.hidden_windows as u32,
                warnings: prepared.warnings,
                timings: prepared.timings,
                microphone: prepared.microphone,
            })
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = (options, &self.events, &self.preview);
            Err(failure("capture_start_failed", "native capture is not available on this platform yet"))
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct StopTask {
    session: Arc<Mutex<Option<Session>>>,
    finishing: Arc<Mutex<Option<Finishing>>>,
}

fn nothing_stopped() -> StopReport {
    StopReport {
        drain_ms: 0.0,
        drain_padded_frames: 0.0,
        frame_lead_avg_ms: 0.0,
        frame_lead_max_ms: 0.0,
        late_audio_frames: Vec::new(),
        inserted_audio_frames: Vec::new(),
        dropped_audio_frames: Vec::new(),
        limited_audio_samples: 0.0,
        captured_pictures: 0.0,
        captured_without_picture: 0.0,
        captured_longest_gap_ms: 0.0,
    }
}

impl Task for StopTask {
    type Output = StopReport;
    type JsValue = StopReport;

    fn compute(&mut self) -> Result<Self::Output> {
        let Some(session) = self.session.lock().unwrap().take() else {
            return Ok(nothing_stopped());
        };
        #[cfg(any(target_os = "macos", windows))]
        {
            let (stopped, finishing) = session.stop();
            *self.finishing.lock().unwrap() = Some(finishing);
            Ok(StopReport {
                drain_ms: stopped.drain_ms,
                drain_padded_frames: stopped.drain_padded_frames as f64,
                frame_lead_avg_ms: stopped.frame_lead_ms.0,
                frame_lead_max_ms: stopped.frame_lead_ms.1,
                late_audio_frames: stopped.late_audio_frames.iter().map(|&frames| frames as f64).collect(),
                inserted_audio_frames: stopped.audio_corrections.iter().map(|&(inserted, _)| inserted as f64).collect(),
                dropped_audio_frames: stopped.audio_corrections.iter().map(|&(_, dropped)| dropped as f64).collect(),
                limited_audio_samples: stopped.limited_audio_samples as f64,
                captured_pictures: stopped.captured.pictures as f64,
                captured_without_picture: stopped.captured.without_picture as f64,
                captured_longest_gap_ms: stopped.captured.longest_gap_ms,
            })
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let () = session;
            let _ = &self.finishing;
            Ok(nothing_stopped())
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct FinishTask {
    finishing: Arc<Mutex<Option<Finishing>>>,
}

impl Task for FinishTask {
    type Output = FinishReport;
    type JsValue = FinishReport;

    fn compute(&mut self) -> Result<Self::Output> {
        let nothing = FinishReport { bytes: 0.0, fragmented: None, finalize_ms: 0.0 };
        let Some(finishing) = self.finishing.lock().unwrap().take() else {
            return Ok(nothing);
        };
        #[cfg(any(target_os = "macos", windows))]
        {
            let finished = finishing.wait().map_err(|e| failure(e.code, e.detail))?;
            Ok(FinishReport { bytes: finished.bytes as f64, fragmented: finished.fragmented, finalize_ms: finished.finalize_ms })
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let () = finishing;
            Ok(nothing)
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct CancelTask {
    session: Arc<Mutex<Option<Session>>>,
}

impl Task for CancelTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        #[cfg(any(target_os = "macos", windows))]
        if let Some(session) = self.session.lock().unwrap().take() {
            session.cancel();
        }
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

#[cfg(test)]
mod preview_gate_tests {
    use super::PreviewGate;

    #[test]
    fn the_preview_gate_drops_the_rest_of_a_group_once_a_chunk_did_not_fit() {
        let gate = PreviewGate::default();
        assert!(gate.admit(true));
        assert!(gate.admit(false));
        // Two wait for the JavaScript thread: the third does not fit.
        assert!(!gate.admit(false));
        gate.done();
        gate.done();
        // Room again, but these refer to the frame that was dropped.
        assert!(!gate.admit(false));
        assert!(!gate.admit(false));
        // A key frame starts the stream again.
        assert!(gate.admit(true));
        assert!(gate.admit(false));
    }

    #[test]
    fn a_chunk_napi_did_not_queue_is_a_gap_too() {
        let gate = PreviewGate::default();
        assert!(gate.admit(true));
        gate.lost();
        assert!(!gate.admit(false));
        assert!(gate.admit(true));
    }

    #[test]
    fn the_gate_counts_what_it_sent_and_dropped_until_read() {
        let gate = PreviewGate::default();
        assert!(gate.admit(true));
        assert!(gate.admit(false));
        assert!(!gate.admit(false));
        gate.done();
        gate.lost();
        assert_eq!(gate.counts(), (1, 2));
        assert!(gate.admit(true));
        assert_eq!(gate.counts(), (2, 2));
    }
}
