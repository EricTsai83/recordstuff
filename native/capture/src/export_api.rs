//! The export's JavaScript interface (plan 085), loaded by the export worker (src/main/editing/export-process.ts), never
//! by main: `inspect` reads a recording's index and plans an edit without writing, `run` exports it into a file that
//! must not exist yet, reporting progress on the constructor's callback, and `cancel` stops a running export within a
//! fragment. Times are in the recording's video timescale, as the edit record stores them.
//!
//! A failure rejects with a message `code|detail`, the codes of `edit::remux::ExportError`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{AsyncTask, Function};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Result, Status, Task};
use napi_derive::napi;

use crate::camera_layout::Layout;
use crate::core::gain_factor;
use crate::edit::plan::Plan;
use crate::edit::remux::{self, Codecs, ExportError, JoinPolicy};
use crate::edit::render::{self, RenderOptions, Renderer};
use crate::edit::source::{self, SourceIndex};
use crate::failure;

#[napi(object)]
#[derive(Clone)]
pub struct ExportRange {
    pub from: f64,
    pub to: f64,
}

#[napi(object)]
pub struct ExportRequest {
    pub source: String,
    /// Where `run` writes: a path in the source's folder that does not exist yet.
    pub output: Option<String>,
    pub removed: Vec<ExportRange>,
    /// `keyFrame` forces every join inside a group of pictures to resume at a key frame (a fixture's fallback).
    pub join: Option<String>,
    /// An editable recording's rendered export (plan 087): the camera's place and the volumes. Absent is 085's remux.
    pub render: Option<ExportRender>,
}

/// What an editable recording's export composes and mixes (plan 087).
#[napi(object)]
#[derive(Clone)]
pub struct ExportRender {
    /// The camera's bubble, in the camera layout's fractions (src/shared/camera-layout.ts); absent leaves it out.
    pub camera: Option<ExportCamera>,
    /// Where the bubble is left out though composed elsewhere (2026-10-26), in the video's timescale on the
    /// recording's own clock; absent or empty, it is composed throughout.
    pub camera_hidden: Option<Vec<ExportRange>>,
    /// Each sound track's volume in dB, in the file's order (the Studio's faders, src/shared/audio-volume.ts).
    pub volumes_db: Vec<f64>,
}

#[napi(object)]
#[derive(Clone, Copy)]
pub struct ExportCamera {
    pub width: f64,
    pub height: f64,
    pub rounding: f64,
    pub x: f64,
    pub y: f64,
    pub mirror: bool,
}

#[napi(object)]
pub struct ExportPart {
    /// Where the edit asked the part to start, and where it starts (later only when it fell back to a key frame).
    pub requested: f64,
    pub start: f64,
    pub stop: f64,
    /// Where it starts in the export.
    pub out_start: f64,
    pub fell_back: bool,
    /// Its first pictures, up to the next key frame, are re-encoded.
    pub reencoded: bool,
}

#[napi(object)]
pub struct ExportPlan {
    pub timescale: u32,
    /// The recording's length, and the export's.
    pub duration: f64,
    pub output_duration: f64,
    pub frames: u32,
    /// The removed ranges, snapped to frame starts.
    pub removed: Vec<ExportRange>,
    pub parts: Vec<ExportPart>,
    /// Kept ranges left out for want of a key frame to resume at.
    pub dropped: Vec<ExportRange>,
    pub second_description: bool,
    pub has_audio: bool,
    /// An editable recording's description as written (plan 087, editable.rs), which main reads; absent otherwise.
    pub editable: Option<String>,
}

#[napi(object)]
pub struct ExportResult {
    pub plan: ExportPlan,
    pub bytes: f64,
    pub reencoded_frames: u32,
    pub reencoded_packets: u32,
}

/// The source's video timescale, length and picture count.
type SourceFacts = (u32, u64, usize);

fn facts(index: &SourceIndex) -> SourceFacts {
    (index.video.timescale, index.video.end(), index.video.times.len())
}

fn plan_view((timescale, duration, frames): SourceFacts, plan: &Plan, second_description: bool, editable: Option<String>) -> ExportPlan {
    let range = |(from, to): (u64, u64)| ExportRange { from: from as f64, to: to as f64 };
    ExportPlan {
        timescale,
        duration: duration as f64,
        output_duration: plan.duration as f64,
        frames: frames as u32,
        removed: plan.removed.iter().copied().map(range).collect(),
        parts: plan
            .parts
            .iter()
            .map(|p| ExportPart {
                requested: p.requested_time as f64,
                start: p.start as f64,
                stop: p.stop as f64,
                out_start: p.out_start as f64,
                fell_back: p.fell_back,
                reencoded: p.reencode.is_some(),
            })
            .collect(),
        dropped: plan.dropped.iter().map(|d| range((d.start, d.stop))).collect(),
        second_description,
        has_audio: plan.audio.is_some() || editable.is_some(),
        editable,
    }
}

fn reject(error: ExportError) -> napi::Error {
    failure(error.code, error.detail)
}

fn codecs() -> std::result::Result<Box<dyn Codecs>, ExportError> {
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(crate::mac::edit::MacCodecs::default()))
    }
    #[cfg(windows)]
    {
        Ok(Box::new(crate::win::edit::WinCodecs))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    Err(ExportError { code: "unsupported", detail: "exporting is not available on this platform".into() })
}

struct Parsed {
    source: PathBuf,
    output: Option<PathBuf>,
    removed: Vec<(u64, u64)>,
    policy: JoinPolicy,
    render: Option<RenderOptions>,
}

/// The platform's renderer for an editable recording's export (plan 087): macOS only.
fn renderer() -> std::result::Result<Box<dyn Renderer>, ExportError> {
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(crate::mac::render::MacRenderer))
    }
    #[cfg(not(target_os = "macos"))]
    Err(ExportError { code: "unsupported", detail: "an editable recording is exported on macOS only".into() })
}

fn parse(request: ExportRequest) -> Result<Parsed> {
    let tick = |value: f64| -> Result<u64> {
        if value.is_finite() && value >= 0.0 && value <= 2f64.powi(53) && value.fract() == 0.0 {
            Ok(value as u64)
        } else {
            Err(failure("invalid_range", format!("{value} is not a time in the video's timescale")))
        }
    };
    let removed = request.removed.iter().map(|r| Ok((tick(r.from)?, tick(r.to)?))).collect::<Result<Vec<_>>>()?;
    let policy = match request.join.as_deref() {
        None | Some("auto") => JoinPolicy::Auto,
        Some("keyFrame") => JoinPolicy::KeyFrame,
        Some(other) => return Err(failure("invalid_range", format!("join {other}"))),
    };
    let render = match request.render {
        Some(render) => Some(RenderOptions {
            camera: render.camera.map(|c| Layout { width: c.width, height: c.height, rounding: c.rounding, x: c.x, y: c.y, mirror: c.mirror }.clamped()),
            camera_hidden: render.camera_hidden.unwrap_or_default().iter().map(|r| Ok((tick(r.from)?, tick(r.to)?))).collect::<Result<Vec<_>>>()?,
            gains: render.volumes_db.iter().map(|&db| gain_factor(db)).collect(),
        }),
        None => None,
    };
    Ok(Parsed { source: PathBuf::from(request.source), output: request.output.map(PathBuf::from), removed, policy, render })
}

/// The re-encoded pictures' `avcC` learned for each recording this worker has planned, by its path, size and
/// modification time: the edit view's later plans need no encoding.
type Known = Arc<Mutex<HashMap<(PathBuf, u64, u128), Vec<u8>>>>;

pub struct InspectTask(Option<Parsed>, Known);

impl Task for InspectTask {
    type Output = ExportPlan;
    type JsValue = ExportPlan;

    fn compute(&mut self) -> Result<Self::Output> {
        let request = self.0.take().expect("an inspect runs once");
        // An editable recording (plan 087) is rendered: every kept picture is encoded again, so its plan needs no codec.
        let file = std::fs::File::open(&request.source).map_err(|e| reject(ExportError::read(&e)))?;
        let index = source::read(&file).map_err(|e| reject(e.into()))?;
        if index.description.is_some() {
            let plan = render::render_plan(&index, &request.removed).map_err(reject)?;
            return Ok(plan_view(facts(&index), &plan, false, index.description.clone()));
        }
        let mut codecs = codecs().map_err(reject)?;
        let key = std::fs::metadata(&request.source).ok().map(|m| {
            let modified = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
            (request.source.clone(), m.len(), modified)
        });
        let mut known = key.as_ref().and_then(|key| self.1.lock().unwrap().get(key).cloned());
        let (index, plan) = remux::inspect(&request.source, &request.removed, request.policy, codecs.as_mut(), &mut known).map_err(reject)?;
        if let (Some(key), Some(avcc)) = (key, known) {
            self.1.lock().unwrap().insert(key, avcc);
        }
        Ok(plan_view(facts(&index), &plan, false, None))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

type ProgressCallback = ThreadsafeFunction<f64, (), f64, Status, false, true>;

/// What `streamCopy` reads and writes at a time.
const COPY_CHUNK: usize = 8 * 1024 * 1024;

/// The reference an export's speed is measured against (plan 085's gate): `source` copied into `output`, which must not
/// exist, by plain reads and writes in bounded chunks and a sync, never a clone or a link. For `pnpm bench:export` only.
pub struct CopyTask {
    source: PathBuf,
    output: PathBuf,
}

impl Task for CopyTask {
    type Output = f64;
    type JsValue = f64;

    fn compute(&mut self) -> Result<Self::Output> {
        use std::io::{Read, Write};
        let mut from = std::fs::File::open(&self.source).map_err(|e| failure("read_failed", e))?;
        let mut to = std::fs::OpenOptions::new().write(true).create_new(true).open(&self.output).map_err(|e| failure("output_write_failed", e))?;
        let mut buffer = vec![0u8; COPY_CHUNK];
        let mut total = 0u64;
        loop {
            let n = from.read(&mut buffer).map_err(|e| failure("read_failed", e))?;
            if n == 0 {
                break;
            }
            to.write_all(&buffer[..n]).map_err(|e| failure("output_write_failed", e))?;
            total += n as u64;
        }
        to.sync_all().map_err(|e| failure("output_write_failed", e))?;
        Ok(total as f64)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Copies an editable recording's camera or second sound into a file of its own for the edit view's preview (plan 087).
pub struct ExtractTask {
    source: PathBuf,
    output: PathBuf,
    which: render::Extract,
}

impl Task for ExtractTask {
    type Output = f64;
    type JsValue = f64;

    fn compute(&mut self) -> Result<Self::Output> {
        let bytes = render::extract(&self.source, &self.output, self.which, &AtomicBool::new(false)).map_err(reject)?;
        Ok(bytes as f64)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct RunTask {
    request: Option<Parsed>,
    cancel: Arc<AtomicBool>,
    progress: Arc<ProgressCallback>,
}

impl Task for RunTask {
    type Output = ExportResult;
    type JsValue = ExportResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let request = self.request.take().expect("an export runs once");
        let output = request.output.ok_or_else(|| failure("invalid_range", "an export needs its output path"))?;
        let progress = self.progress.clone();
        let mut report = move |fraction: f64| {
            progress.call(fraction, ThreadsafeFunctionCallMode::NonBlocking);
        };
        if let Some(options) = request.render.as_ref() {
            let mut renderer = renderer().map_err(reject)?;
            let done = render::export(&request.source, &output, &request.removed, options, renderer.as_mut(), &mut report, &self.cancel).map_err(reject)?;
            return Ok(ExportResult {
                plan: plan_view(done.source, &done.plan, false, done.description),
                bytes: done.bytes as f64,
                reencoded_frames: done.frames as u32,
                reencoded_packets: 0,
            });
        }
        let mut codecs = codecs().map_err(reject)?;
        let done = remux::export(&request.source, &output, &request.removed, request.policy, codecs.as_mut(), &mut report, &self.cancel).map_err(reject)?;
        Ok(ExportResult {
            plan: plan_view((done.timescale, done.source_duration, done.frames), &done.plan, done.second_description, None),
            bytes: done.bytes as f64,
            reencoded_frames: done.reencoded_frames as u32,
            reencoded_packets: done.reencoded_packets as u32,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub struct NativeExport {
    cancel: Arc<AtomicBool>,
    progress: Arc<ProgressCallback>,
    known: Known,
}

#[napi]
impl NativeExport {
    /// `on_progress` is called with the fraction done, about ten times a second while an export runs.
    #[napi(constructor)]
    pub fn new(on_progress: Function<f64, ()>) -> Result<Self> {
        // Weak: a pending export keeps its process alive through its promise; the callback alone should not.
        let progress = on_progress.build_threadsafe_function().callee_handled::<false>().weak::<true>().build()?;
        Ok(Self { cancel: Arc::new(AtomicBool::new(false)), progress: Arc::new(progress), known: Arc::default() })
    }

    #[napi(ts_return_type = "Promise<ExportPlan>")]
    pub fn inspect(&self, request: ExportRequest) -> Result<AsyncTask<InspectTask>> {
        Ok(AsyncTask::new(InspectTask(Some(parse(request)?), self.known.clone())))
    }

    #[napi(ts_return_type = "Promise<ExportResult>")]
    pub fn run(&self, request: ExportRequest) -> Result<AsyncTask<RunTask>> {
        self.cancel.store(false, Ordering::Release);
        Ok(AsyncTask::new(RunTask { request: Some(parse(request)?), cancel: self.cancel.clone(), progress: self.progress.clone() }))
    }

    /// Copies `source` into `output` the plain way, the bytes copied: the export's speed reference (`pnpm bench:export`).
    #[napi(ts_return_type = "Promise<number>")]
    pub fn stream_copy(&self, source: String, output: String) -> AsyncTask<CopyTask> {
        AsyncTask::new(CopyTask { source: PathBuf::from(source), output: PathBuf::from(output) })
    }

    /// Copies `source`'s `track` (`camera` or `secondSound`) into `output`, which must not exist, as it is: the edit
    /// view plays it beside the recording (plan 087). The bytes written.
    #[napi(ts_return_type = "Promise<number>")]
    pub fn extract(&self, source: String, track: String, output: String) -> Result<AsyncTask<ExtractTask>> {
        let which = match track.as_str() {
            "camera" => render::Extract::Camera,
            "secondSound" => render::Extract::SecondSound,
            other => return Err(failure("invalid_range", format!("no track {other:?} to extract"))),
        };
        Ok(AsyncTask::new(ExtractTask { source: PathBuf::from(source), output: PathBuf::from(output), which }))
    }

    /// Stops the running export at its next fragment; it then rejects with `cancelled`.
    #[napi]
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }
}
