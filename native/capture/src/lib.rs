//! RecordStuff's native capture engine (plan 076): capture, encoding and the hybrid MP4 file, loaded by the capture
//! host in an Electron `utilityProcess` (src/main/recording/native-host-process.ts). Its JavaScript interface is
//! `NativeCapture`: `probe` the display, `prepare` capture into the file main created, `record`, then `stop` (or
//! `cancel` before recording), which answers once capture has ended, and `finish`, which answers once the file is
//! plain or why it is not is known: a slow volume's save is no part of the stop. Events arrive on the callback given
//! to the constructor.
//!
//! A failure rejects with a message `code|detail`, where `code` is one of the capture host's error codes.

pub mod core;
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

#[napi(object)]
pub struct MicrophoneInfo {
    pub id: String,
    pub name: String,
    pub default: bool,
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
#[derive(Clone)]
pub struct EngineEvent {
    /// `progress`, `writeError`, `captureError` or `microphoneLost` (074: the recording goes on without it).
    pub kind: String,
    pub bytes: Option<f64>,
    pub code: Option<String>,
    pub detail: Option<String>,
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
}

impl PreviewGate {
    /// Whether a chunk, a key frame or not, is sent; a sent chunk is `done` once the JavaScript thread has taken it.
    pub fn admit(&self, key: bool) -> bool {
        use std::sync::atomic::Ordering;
        if !key && self.awaiting_key.load(Ordering::Acquire) {
            return false;
        }
        if self.in_flight.fetch_add(1, Ordering::AcqRel) >= PREVIEW_IN_FLIGHT {
            self.in_flight.fetch_sub(1, Ordering::AcqRel);
            self.awaiting_key.store(true, Ordering::Release);
            return false;
        }
        self.awaiting_key.store(false, Ordering::Release);
        true
    }

    pub fn done(&self) {
        self.in_flight.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }

    /// A sent chunk napi did not queue: never taken, and the stream has a gap.
    pub fn lost(&self) {
        self.done();
        self.awaiting_key.store(true, std::sync::atomic::Ordering::Release);
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
        self.emit(EngineEvent { kind: "progress".into(), bytes: Some(bytes as f64), code: None, detail: None });
    }

    fn write_failed(&self, failure: writer::WriteFailure) {
        self.emit(EngineEvent { kind: "writeError".into(), bytes: None, code: Some(failure.code.into()), detail: Some(failure.detail) });
    }

    fn capture_failed(&self, code: &'static str, detail: String) {
        self.emit(EngineEvent { kind: "captureError".into(), bytes: None, code: Some(code.into()), detail: Some(detail) });
    }

    fn microphone_lost(&self, detail: String) {
        self.emit(EngineEvent { kind: "microphoneLost".into(), bytes: None, code: None, detail: Some(detail) });
    }
    fn microphone_resumed(&self, detail: String) {
        self.emit(EngineEvent { kind: "microphoneResumed".into(), bytes: None, code: None, detail: Some(detail) });
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
#[cfg(not(any(target_os = "macos", windows)))]
type Session = ();
#[cfg(any(target_os = "macos", windows))]
type Finishing = core::Finishing;
#[cfg(not(any(target_os = "macos", windows)))]
type Finishing = ();

#[napi]
pub struct NativeCapture {
    session: Arc<Mutex<Option<Session>>>,
    /// The stopped session's file, until `finish` takes it.
    finishing: Arc<Mutex<Option<Finishing>>>,
    events: Arc<EventCallback>,
    /// Where preview frames go, when a preview is wanted (plan 075's prototype).
    preview: Arc<Mutex<Option<PreviewSink>>>,
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
        })
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

    /// The audio input devices, for choosing the microphone.
    #[napi(ts_return_type = "Promise<MicrophoneInfo[]>")]
    pub fn microphones(&self) -> AsyncTask<MicrophonesTask> {
        AsyncTask::new(MicrophonesTask)
    }

    #[napi(ts_return_type = "Promise<PreparedInfo>")]
    pub fn prepare(&self, options: PrepareOptions) -> AsyncTask<PrepareTask> {
        AsyncTask::new(PrepareTask { options: Some(options), session: self.session.clone(), events: self.events.clone(), preview: self.preview.clone() })
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

pub struct MicrophonesTask;

impl Task for MicrophonesTask {
    type Output = Vec<MicrophoneInfo>;
    type JsValue = Vec<MicrophoneInfo>;

    fn compute(&mut self) -> Result<Self::Output> {
        #[cfg(any(target_os = "macos", windows))]
        {
            let found = platform::microphone::list().map_err(|e| failure(e.code, e.detail))?;
            Ok(found.into_iter().map(|m| MicrophoneInfo { id: m.id, name: m.name, default: m.default }).collect())
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        Ok(Vec::new())
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
            };
            let (session, prepared) =
                Session::prepare(request, Arc::new(Emitter(self.events.clone(), self.preview.clone()))).map_err(|e| failure(e.code, e.detail))?;
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
    StopReport { drain_ms: 0.0, drain_padded_frames: 0.0, frame_lead_avg_ms: 0.0, frame_lead_max_ms: 0.0, late_audio_frames: Vec::new(),
      inserted_audio_frames: Vec::new(), dropped_audio_frames: Vec::new(), limited_audio_samples: 0.0,
      captured_pictures: 0.0, captured_without_picture: 0.0, captured_longest_gap_ms: 0.0 }
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
mod tests {
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
}
