//! RecordStuff's native capture engine (plan 076): capture, encoding and the hybrid MP4 file, loaded by the capture
//! host in an Electron `utilityProcess` (src/main/native-capture/host-process.ts). Its JavaScript interface is
//! `NativeCapture`: `probe` the display, `prepare` capture into the file main created, `record`, then `stop` (or
//! `cancel` before recording). Events arrive on the callback given to the constructor.
//!
//! A failure rejects with a message `code|detail`, where `code` is one of the capture host's error codes.

pub mod core;
pub mod mux;
pub mod pacing;
pub mod timing;
pub mod writer;

pub mod aac;
pub mod avc;
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

use napi::bindgen_prelude::{AsyncTask, Function};
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
}

#[napi(object)]
pub struct StopReport {
    pub bytes: f64,
    /// Why the file stayed fragmented, when it did.
    pub fragmented: Option<String>,
    pub finalize_ms: f64,
    /// How long the sound up to the stop took to arrive, and how many of its frames were filled with silence.
    pub drain_ms: f64,
    pub drain_padded_frames: f64,
    /// How far ahead of the host clock frames were stamped when handed over: average and maximum, in ms.
    pub frame_lead_avg_ms: f64,
    pub frame_lead_max_ms: f64,
}

#[napi(object)]
#[derive(Clone)]
pub struct EngineEvent {
    /// `progress`, `writeError` or `captureError`.
    pub kind: String,
    pub bytes: Option<f64>,
    pub code: Option<String>,
    pub detail: Option<String>,
}

type EventCallback = ThreadsafeFunction<EngineEvent, (), EngineEvent, Status, false>;

fn failure(code: &str, detail: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{code}|{detail}"))
}

struct Emitter(Arc<EventCallback>);

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
}

#[cfg(any(target_os = "macos", windows))]
type Session = platform::session::Session;
#[cfg(not(any(target_os = "macos", windows)))]
type Session = ();

#[napi]
pub struct NativeCapture {
    session: Arc<Mutex<Option<Session>>>,
    events: Arc<EventCallback>,
}

#[napi]
impl NativeCapture {
    #[napi(constructor)]
    pub fn new(on_event: Function<EngineEvent, ()>) -> Result<Self> {
        let events = on_event.build_threadsafe_function().callee_handled::<false>().build()?;
        Ok(Self { session: Arc::new(Mutex::new(None)), events: Arc::new(events) })
    }

    #[napi(ts_return_type = "Promise<ProbeResult>")]
    pub fn probe(&self, display_id: u32, display_point: Option<DisplayPoint>) -> AsyncTask<ProbeTask> {
        AsyncTask::new(ProbeTask { display_id, display_point: display_point.map(|p| (p.x, p.y)) })
    }

    #[napi(ts_return_type = "Promise<PreparedInfo>")]
    pub fn prepare(&self, options: PrepareOptions) -> AsyncTask<PrepareTask> {
        AsyncTask::new(PrepareTask { options: Some(options), session: self.session.clone(), events: self.events.clone() })
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

    #[napi(ts_return_type = "Promise<StopReport>")]
    pub fn stop(&self) -> AsyncTask<StopTask> {
        AsyncTask::new(StopTask { session: self.session.clone() })
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn cancel(&self) -> AsyncTask<CancelTask> {
        AsyncTask::new(CancelTask { session: self.session.clone() })
    }
}

pub struct ProbeTask {
    display_id: u32,
    display_point: Option<(i32, i32)>,
}

impl Task for ProbeTask {
    type Output = (u32, u32);
    type JsValue = ProbeResult;

    fn compute(&mut self) -> Result<Self::Output> {
        #[cfg(any(target_os = "macos", windows))]
        return platform::session::probe(self.display_id, self.display_point).map_err(|e| failure(e.code, e.detail));
        #[cfg(not(any(target_os = "macos", windows)))]
        Err(failure("capture_start_failed", "native capture is not available on this platform yet"))
    }

    fn resolve(&mut self, _env: Env, (width, height): Self::Output) -> Result<Self::JsValue> {
        Ok(ProbeResult { width, height })
    }
}

pub struct PrepareTask {
    options: Option<PrepareOptions>,
    session: Arc<Mutex<Option<Session>>>,
    events: Arc<EventCallback>,
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
            };
            let (session, prepared) =
                Session::prepare(request, Arc::new(Emitter(self.events.clone()))).map_err(|e| failure(e.code, e.detail))?;
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
            })
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = (options, &self.events);
            Err(failure("capture_start_failed", "native capture is not available on this platform yet"))
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct StopTask {
    session: Arc<Mutex<Option<Session>>>,
}

impl Task for StopTask {
    type Output = StopReport;
    type JsValue = StopReport;

    fn compute(&mut self) -> Result<Self::Output> {
        let Some(session) = self.session.lock().unwrap().take() else {
            return Ok(StopReport { bytes: 0.0, fragmented: None, finalize_ms: 0.0, drain_ms: 0.0, drain_padded_frames: 0.0, frame_lead_avg_ms: 0.0, frame_lead_max_ms: 0.0 });
        };
        #[cfg(any(target_os = "macos", windows))]
        {
            let stopped = session.stop().map_err(|e| failure(e.code, e.detail))?;
            Ok(StopReport {
                bytes: stopped.bytes as f64,
                fragmented: stopped.fragmented,
                finalize_ms: stopped.finalize_ms,
                drain_ms: stopped.drain_ms,
                drain_padded_frames: stopped.drain_padded_frames as f64,
                frame_lead_avg_ms: stopped.frame_lead_ms.0,
                frame_lead_max_ms: stopped.frame_lead_ms.1,
            })
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let () = session;
            Ok(StopReport { bytes: 0.0, fragmented: None, finalize_ms: 0.0, drain_ms: 0.0, drain_padded_frames: 0.0, frame_lead_avg_ms: 0.0, frame_lead_max_ms: 0.0 })
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
