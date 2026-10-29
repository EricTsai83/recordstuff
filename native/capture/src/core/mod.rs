//! One recording, whatever captures it (plan 076, steps 3 and 4): the phases, which captured frames are encoded, the
//! sound up to the stop, and the file. A platform module (mac/, win/) starts capture at `prepare`, hands every frame
//! to `Shared::frame` and every sound buffer to `Shared::sound`, and supplies its encoders; everything about time is
//! decided here, once for both platforms.
//!
//! Capture runs from `prepare`, but until `record` only the newest frame is kept. At `record` that frame is encoded at
//! the recording's start, so the file starts with a picture however still the screen is, and while nothing changes
//! the last frame is encoded again every second, so a key frame still comes every second and fragments keep closing.
//! `Pacer` keeps one captured frame per slot of the frame rate's grid (see pacing.rs).
//!
//! `stop` ends both tracks at the moment it is called: frames after it are left out, and capture keeps running until
//! the sound up to that moment has arrived (capture hands audio over a few tens of milliseconds late), so the audio
//! track is exactly as long as the video's.

use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

mod camera;
pub mod diagnostics;
mod frame_log;
pub mod meter;
mod mixer;
pub mod preview;

use crate::pacing::Pacer;
use crate::timing::NANOS_PER_SECOND;
use crate::writer::{self, AudioSpec, Media, VideoSpec, WriteFailure, WriterConfig, WriterEvent};
pub use camera::{CAMERA_FIRST_FRAME_NS, CAMERA_SILENT_NS, CameraAges, CameraControl, CameraFeed};
pub use diagnostics::Diagnostics;
pub use frame_log::FrameLog;
use mixer::Mixer;
/// The soft limit above -1 dBFS a loud mix or a raised volume goes through (mixer.rs), for the rendered export's mix too.
pub(crate) use mixer::limit;

const PREPARED: u8 = 0;
const RECORDING: u8 = 1;
const STOPPING: u8 = 2;
/// `stop` was called: capture still runs until the sound before the stop has arrived; nothing after it is kept.
const DRAINING: u8 = 3;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
/// 10 ms: how far an audio buffer's time may disagree with the sample count before it is corrected.
const AUDIO_TOLERANCE_FRAMES: u64 = 480;
/// 500 ms: how far behind the clock the audio track may wait for an input that delivers nothing (see mixer.rs).
const MIX_LATENCY_FRAMES: u64 = 24_000;
/// While the screen stays still, the last frame is encoded again this often.
const REFRESH_NS: u64 = NANOS_PER_SECOND;
/// How long `stop` waits for the sound up to the stop; what has not come by then is silence.
const DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
/// A microphone delivers sound all the time, silence included; one that has delivered nothing for this long while
/// recording is told lost (unplugged, stalled, or its access withdrawn), and the recording goes on without it (074),
/// taking its sound again if it comes back: a Bluetooth or Continuity microphone can stall for a few seconds and go on,
/// which Cap and OBS reconnect for and Chromium waits 12 s for.
const MICROPHONE_SILENT_NS: u64 = 2 * NANOS_PER_SECOND;
const FINISH_TIMEOUT: Duration = Duration::from_secs(120);

/// A failure with one of the capture host's error codes (`HostErrorCode` in src/shared/protocol.ts).
#[derive(Clone, Debug)]
pub struct CaptureError {
    pub code: &'static str,
    pub detail: String,
}

impl CaptureError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }
}

/// What the session tells its owner while it runs. Called from capture, encoder and writer threads.
pub trait Events: Send + Sync {
    fn progress(&self, bytes: u64);
    fn write_failed(&self, failure: WriteFailure);
    /// Capture ended without a stop: `capture_failed` while recording, `capture_start_failed` while prepared.
    fn capture_failed(&self, code: &'static str, detail: String);
    /// The microphone stopped delivering while recording (074): the track goes on with the other inputs and silence
    /// where the microphone was. Told each time it stops.
    fn microphone_lost(&self, detail: String);
    /// The microphone told lost delivers sound again, which the track takes from then on.
    fn microphone_resumed(&self, detail: String);
    /// The user switched the recording's microphone (plan 079, D3): `to` delivers from now on, `from` is closed.
    fn microphone_switched(&self, _from: String, _to: String) {}
    /// A switch the device refused: the microphone recorded before goes on.
    fn microphone_switch_failed(&self, _detail: String) {}
    /// A preview chunk of the composed picture (plan 075, step 2's prototype; D17's second option).
    fn preview(&self, _chunk: PreviewChunk) {}
    /// The camera stopped delivering while recording (plan 075, D12): the recording goes on without it. Told once per
    /// dropout.
    fn camera_lost(&self, _detail: String) {}
    /// The camera delivered its first frame, unless it was told lost or not ready before it (then `camera_resumed`
    /// tells it), so the Recording Studio can stop saying it waits for the camera (plan 090). Told at most once.
    fn camera_ready(&self, _detail: String) {}
    /// The camera delivered nothing in `CAMERA_FIRST_FRAME_NS` after its opening while recording (plan 090, D1): the
    /// recording goes on without it. Told once per session, before any loss.
    fn camera_not_ready(&self, _detail: String) {}
    /// The camera told lost or not ready delivers, and is composed from then on.
    fn camera_resumed(&self, _detail: String) {}
    /// The loudest sample of each kind of input since the last levels (plan 075, D19), 10 times a second while
    /// they are watched and sound is taken; called on an input's thread.
    fn levels(&self, _levels: Levels) {}
}

/// Peak levels, linear (1 is full scale), of the inputs after their volumes (D21), before any muting.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Levels {
    /// System audio and any apps' audio together.
    pub system: f32,
    /// The microphone, when the session records one.
    pub microphone: Option<f32>,
}

/// A volume in dB as the linear factor a sample is multiplied by: silence at or below `SILENT_GAIN_DB`, at most
/// `MAX_GAIN_DB` (D21); the rendered export's volumes (plan 087) are the same faders'.
pub fn gain_factor(db: f64) -> f32 {
    if !db.is_finite() || db <= SILENT_GAIN_DB { 0.0 } else { 10f64.powf(db.min(MAX_GAIN_DB) / 20.0) as f32 }
}

/// An input's volume at or below this is silence (D21), the bottom of its fader.
pub const SILENT_GAIN_DB: f64 = -60.0;
/// The loudest an input's volume raises it: 600%, about +15.6 dB (20 log10 6), the fader's top (audio-volume.ts).
pub const MAX_GAIN_DB: f64 = 15.563025007672874;

/// How often levels are told while watched: 10 times a second, the preview's rate (D21).
const LEVELS_INTERVAL_NS: u64 = NANOS_PER_SECOND / 10;

/// The level meters, the volumes and the mutes of the recording in progress (plan 075, D19, D21).
struct Meters {
    watched: AtomicBool,
    /// Each kind's loudest sample since the last levels told, as f32 bits: a non-negative f32 orders as its bits do.
    system_peak: AtomicU32,
    microphone_peak: AtomicU32,
    told_ns: AtomicU64,
    system_muted: AtomicBool,
    microphone_muted: AtomicBool,
    /// Each kind's volume, a linear factor as f32 bits: 1 leaves its samples as they are.
    system_gain: AtomicU32,
    microphone_gain: AtomicU32,
}

impl Default for Meters {
    fn default() -> Self {
        Self {
            watched: AtomicBool::new(false),
            system_peak: AtomicU32::new(0),
            microphone_peak: AtomicU32::new(0),
            told_ns: AtomicU64::new(0),
            system_muted: AtomicBool::new(false),
            microphone_muted: AtomicBool::new(false),
            system_gain: AtomicU32::new(1.0f32.to_bits()),
            microphone_gain: AtomicU32::new(1.0f32.to_bits()),
        }
    }
}

/// One encoded frame of the preview: H.264 in AVCC form (length-prefixed NAL units), for WebCodecs' `VideoDecoder`.
#[derive(Clone, Debug, PartialEq)]
pub struct PreviewChunk {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    /// Whether it is a key frame, which a decoder can start from.
    pub key: bool,
    /// Host time it was captured, in microseconds.
    pub timestamp_us: u64,
    /// The `avcC` record a decoder is configured with; with every key frame, so a page that joins late can start.
    pub description: Option<Vec<u8>>,
}

/// Takes a preview encoder's output and tells it as preview chunks, the `avcC` record with every key frame (plan 075,
/// D17), on every platform.
pub struct PreviewSink {
    events: Arc<dyn Events>,
    format: Mutex<Option<(Vec<u8>, u32, u32)>>,
    /// The session's stage figures (plan 083) and the clock its frames are stamped on.
    diagnostics: Option<(Arc<Diagnostics>, Clock)>,
}

/// A platform's host clock, in nanoseconds.
type Clock = fn() -> u64;

impl PreviewSink {
    pub fn new(events: Arc<dyn Events>) -> Self {
        Self { events, format: Mutex::new(None), diagnostics: None }
    }

    /// Counts the chunks and times each from its frame's submission, stamped by `now`, when the session keeps figures.
    pub fn timed(mut self, diagnostics: Option<Arc<Diagnostics>>, now: fn() -> u64) -> Self {
        self.diagnostics = diagnostics.map(|diagnostics| (diagnostics, now));
        self
    }
}

impl VideoSink for PreviewSink {
    fn media(&self, media: Media) {
        match media {
            Media::VideoFormat { avcc, width, height } => *self.format.lock().unwrap() = Some((avcc, u32::from(width), u32::from(height))),
            Media::Video { data, pts_ns, sync } => {
                if let Some((diagnostics, now)) = self.diagnostics.as_ref() {
                    diagnostics.preview_chunks.fetch_add(1, Ordering::Relaxed);
                    diagnostics.preview_encode.record_ns(now().saturating_sub(pts_ns));
                }
                let Some((avcc, width, height)) = self.format.lock().unwrap().clone() else { return };
                self.events.preview(PreviewChunk { width, height, data, key: sync, timestamp_us: pts_ns / 1000, description: sync.then_some(avcc) });
            }
            Media::Audio { .. } | Media::Camera { .. } => {}
        }
    }

    // A preview is a convenience: one whose encoder fails stops showing, the recording does not.
    fn failed(&self, _detail: String) {}
}

/// Where encoded video goes, and who hears that encoding failed. Called on the encoder's thread.
pub trait VideoSink: Send + Sync {
    fn media(&self, media: Media);
    fn failed(&self, detail: String);
    /// The encoder answered a frame without a sample: it dropped it.
    fn dropped(&self) {}
}

/// An H.264 encoder that sends `Media::VideoFormat` once and then each sample to its `VideoSink`.
pub trait VideoEncode<F>: Send + Sync {
    /// Queues `frame`, captured at `pts_ns` host time.
    fn encode(&self, frame: &F, pts_ns: u64, key_frame: bool) -> Result<(), String>;
    /// Returns once every queued frame's sample has reached the sink.
    fn flush(&self);
}

/// An AAC-LC encoder taking interleaved stereo 32-bit float at `SAMPLE_RATE`, one packet per `AAC_FRAMES` frames.
pub trait AudioEncode: Send {
    /// Frames pushed so far, silence included.
    fn frames_in(&self) -> u64;
    /// Frames of the encoder's own delay at the start of its output, which the file's edit list skips.
    fn priming(&self) -> u32;
    fn audio_specific_config(&self) -> Vec<u8>;
    fn push(&mut self, interleaved: &[f32]);
    fn push_silence(&mut self, frames: usize);
    /// Encodes every whole packet's worth of pending frames.
    fn drain(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String>;
    /// Ends the stream: everything pending and everything the encoder holds comes out.
    fn finish(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String>;
}

/// What a platform captures with: its frames, its encoders and its clock.
pub trait Platform: 'static {
    type Frame: Send + 'static;
    type Video: VideoEncode<Self::Frame> + 'static;
    type Audio: AudioEncode + 'static;
    /// Host time now, on the clock capture stamps frames and sound with.
    fn now_ns() -> u64;
}

/// What the recording's picture shows (plan 076, step 4: the engine and its tests; the pickers are a later plan).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// The whole display, without RecordStuff's windows: today's recording.
    Display,
    /// One window wherever it is on the display, even when covered: its CGWindowID on macOS, its HWND on Windows.
    Window(u64),
    /// Part of the display, in its pixels from its top-left corner.
    Area { x: u32, y: u32, width: u32, height: u32 },
    /// The display showing only these processes' windows (macOS; Windows.Graphics.Capture cannot).
    Apps(Vec<i32>),
}

/// Whose sound the system part of the track holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SystemAudio {
    /// Everything the system plays except RecordStuff: today's recording.
    All,
    /// Only these processes' sound (with their children on Windows).
    Apps(Vec<i32>),
    Off,
}

/// The track's inputs besides the picture's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioRequest {
    pub system: SystemAudio,
    /// The microphone mixed into the track (074): `Some(None)` is the system's default input, `Some(Some(id))` a
    /// device `microphones` listed.
    pub microphone: Option<Option<String>>,
}

impl Default for AudioRequest {
    fn default() -> Self {
        Self { system: SystemAudio::All, microphone: None }
    }
}

/// A camera, for choosing one (plan 075, D9).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Camera {
    /// Stable across launches: AVCaptureDevice's unique ID.
    pub id: String,
    pub name: String,
    /// Whether it is the system's default camera now.
    pub default: bool,
}

/// An audio input device, for choosing the microphone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Microphone {
    /// Stable across launches: AVCaptureDevice's unique ID, the endpoint ID on Windows.
    pub id: String,
    pub name: String,
    /// Whether it is the system's default input now.
    pub default: bool,
    /// Built into a MacBook whose lid is closed (plan 089): listed and opened, but it hears nothing.
    pub lid_closed: bool,
}

pub struct PrepareRequest {
    pub display_id: u32,
    /// A point on the display in physical screen pixels: how Windows finds it (Electron's display ids name no
    /// monitor there). Unused on macOS.
    pub display_point: Option<(i32, i32)>,
    pub width: u32,
    pub height: u32,
    /// The frame rate setting: the encoder's rate control and `Pacer`'s grid.
    pub frame_rate: u32,
    pub video_bitrate: u32,
    pub audio_bitrate: u32,
    pub own_pids: Vec<i32>,
    pub system_ui: SystemUi,
    pub path: PathBuf,
    pub source: Source,
    pub audio: AudioRequest,
    /// The camera composed into the frames (plan 075); absent is none.
    pub camera: Option<CameraRequest>,
    /// Plan 087's editable recording (step 1's prototype, a development switch): the screen without the camera, each
    /// sound input on a track of its own and the camera on its own track, in one file.
    pub editable: bool,
}

/// Which of the system's chrome a display's picture leaves out (plan 099, D1; one switch in plan 076's D6): the menu
/// bar and its status items, the Dock, desktop icons and widgets. Main cuts the strips the hidden ones keep on screen
/// off with an area of the display.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SystemUi {
    pub menu_bar: bool,
    pub dock: bool,
    pub desktop: bool,
}

impl SystemUi {
    pub fn any(self) -> bool {
        self.menu_bar || self.dock || self.desktop
    }
}

/// Which camera and where its bubble is (plan 075): main's setting and its layout on the recorded display.
#[derive(Clone, Debug, PartialEq)]
pub struct CameraRequest {
    /// AVCaptureDevice's unique ID; absent is the system's default camera, as is one not connected (D9).
    pub device: Option<String>,
    pub layout: crate::camera_layout::Layout,
    /// Whether the preview is watched from the start (step 7: Settings shows it); `Session::set_preview` changes it.
    pub preview: bool,
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
    /// Where preparing spent its time, for the log.
    pub timings: String,
    /// The microphone actually opened (074): its name, which is the default input's when a chosen one was not connected.
    pub microphone: Option<String>,
}

/// What `end` reports once capture has stopped: the file is still being finished (see `Finishing`).
pub struct Stopped {
    /// How long the sound up to the stop took to arrive, and how much of it was filled with silence.
    pub drain_ms: f64,
    pub drain_padded_frames: u64,
    /// How far ahead of the host clock frames were stamped when handed over, on average and at most.
    pub frame_lead_ms: (f64, f64),
    /// Frames each audio input delivered too late to be mixed (see mixer.rs).
    pub late_audio_frames: Vec<u64>,
    /// Frames of silence inserted and frames dropped to keep each audio input on the clock: drift and gaps.
    pub audio_corrections: Vec<(u64, u64)>,
    /// Samples where two inputs summed past -1 dBFS and the limiter changed them.
    pub limited_audio_samples: u64,
    /// What capture delivered while recording: frames with a picture, deliveries without one (a frame capture reported
    /// idle, blank or the like), and the longest time between two pictures, in ms. A display refreshing at 60 Hz that
    /// delivers every refresh shows about 60 pictures a second and a longest gap near 17 ms; a recording's frame then
    /// missing from the file is the pacer's, not capture's.
    pub captured: Captured,
    /// The first error of a sound encoder while the stop drained and flushed it: the file is still finished, its sound
    /// ending where the encoder stopped (while recording, such an error fails the recording instead).
    pub audio_failure: Option<String>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Captured {
    pub pictures: u64,
    pub without_picture: u64,
    pub longest_gap_ms: f64,
}

/// The finished file.
#[derive(Debug)]
pub struct Finished {
    pub bytes: u64,
    /// Why the file stayed fragmented, when it did.
    pub fragmented: Option<String>,
    pub finalize_ms: f64,
}

type FinishOutcome = std::sync::mpsc::Receiver<Result<crate::mux::mp4::FinishReport, WriteFailure>>;

/// The writer making the file plain after capture stopped, which can outlast any stop deadline on a slow volume.
pub struct Finishing {
    /// The writer's answer and its thread; None when nothing was recorded.
    outcome: Option<(FinishOutcome, Option<JoinHandle<()>>)>,
    began: Instant,
}

impl Finishing {
    #[cfg(test)]
    pub(crate) fn from_receiver(result: FinishOutcome) -> Self {
        Self { outcome: Some((result, None)), began: Instant::now() }
    }

    /// Blocks until the file is plain or why it is not is known.
    pub fn wait(self) -> Result<Finished, WriteFailure> {
        let Some((result, thread)) = self.outcome else {
            return Ok(Finished { bytes: 0, fragmented: None, finalize_ms: 0.0 });
        };
        let outcome = result.recv_timeout(FINISH_TIMEOUT).map_err(|error| WriteFailure {
            code: "output_write_failed",
            detail: match error {
                std::sync::mpsc::RecvTimeoutError::Timeout => format!("finishing the file did not complete within {} s", FINISH_TIMEOUT.as_secs()),
                // The writer thread is gone without answering: it panicked, and the file is as it left it.
                std::sync::mpsc::RecvTimeoutError::Disconnected => "the writer ended without finishing the file".into(),
            },
        })?;
        if let Some(thread) = thread {
            let _ = thread.join();
        }
        let report = outcome?;
        Ok(Finished { bytes: report.bytes, fragmented: report.fragmented, finalize_ms: self.began.elapsed().as_secs_f64() * 1000.0 })
    }
}

struct VideoState<P: Platform> {
    encoder: Option<P::Video>,
    last: Option<P::Frame>,
    last_encoded_ns: u64,
    /// Set once the first frame is encoded; until then no captured frame is.
    pacer: Option<Pacer>,
    /// The newest frame was left out by the pacer and is still to be encoded at its slot.
    pending: bool,
    /// When the newest frame was captured.
    last_pts: u64,
}

struct AudioState<A> {
    /// One per sound track, in the file's order: today one, every input mixed into it; an editable recording's one
    /// per input (plan 087), after a track of them mixed when it has several (plan 098). Empty until made, and again
    /// once finished or released.
    encoders: Vec<A>,
    /// One per sound track, made at `record`, when the tracks' start is known.
    mixers: Vec<Mixer>,
    /// How many inputs the platform feeds: system audio, chosen apps' audio, the microphone.
    inputs: usize,
    /// Each input on a sound track of its own (plan 087's editable recording) rather than mixed.
    separate: bool,
    /// With `separate` and several inputs, a first track of them all mixed, the one players play (plan 098). Only
    /// `pnpm bench:editable`'s comparison leaves it out.
    mix: bool,
    priming: u32,
    scratch: Vec<f32>,
}

impl<A: AudioEncode> AudioState<A> {
    /// Changes the cutoff; taking `&mut self` means the audio lock is held.
    fn audio_target_set(&mut self, target: &AtomicU64, frames: u64) {
        target.store(frames, Ordering::Release);
    }

    /// Whether each of several inputs has a track of its own.
    fn split(&self) -> bool {
        self.separate && self.inputs > 1
    }

    /// How many sound tracks the recording has: one unless each of several inputs has its own, and then a track of
    /// them mixed before theirs (plan 098).
    fn tracks(&self) -> usize {
        match (self.split(), self.mix) {
            (false, _) => 1,
            (true, true) => 1 + self.inputs,
            (true, false) => self.inputs,
        }
    }

    /// How many inputs `track`'s mixer sums: all of them on a mixed track, one on an input's own.
    fn track_inputs(&self, track: usize) -> usize {
        if !self.split() || (self.mix && track == 0) { self.inputs } else { 1 }
    }

    /// The tracks `input` is on, each with which of that track's mixer's inputs it is: the mixed track's, and with
    /// separate tracks its own (both, with a mix).
    fn routes(&self, input: usize) -> impl Iterator<Item = (usize, usize)> {
        let (mixed, own) = match (self.split(), self.mix) {
            (false, _) => (Some((0, input)), None),
            (true, true) => (Some((0, input)), Some((1 + input, 0))),
            (true, false) => (None, Some((input, 0))),
        };
        mixed.into_iter().chain(own)
    }

    /// Per input, in their order: the frames it delivered too late to be mixed, and the silence inserted and dropped
    /// to keep it on the clock (see mixer.rs). With a mix, an input is in two mixers: their aligners place it alike, and
    /// its late frames are the more of the two.
    fn per_input(&self) -> (Vec<u64>, Vec<(u64, u64)>) {
        if !self.split() || !self.mix {
            return (self.mixers.iter().flat_map(Mixer::late).collect(), self.mixers.iter().flat_map(Mixer::corrections).collect());
        }
        let Some(mixed) = self.mixers.first() else { return (Vec::new(), Vec::new()) };
        let own: Vec<u64> = self.mixers[1..].iter().flat_map(Mixer::late).collect();
        let late = mixed.late().iter().enumerate().map(|(n, &late)| late.max(own.get(n).copied().unwrap_or(0))).collect();
        (late, mixed.corrections())
    }

    /// Mixes `track` up to `until` into its encoder; returns the packets it made.
    fn advance(&mut self, track: usize, until: u64) -> Result<Vec<Vec<u8>>, String> {
        let mut packets = Vec::new();
        let (Some(mixer), Some(encoder)) = (self.mixers.get_mut(track), self.encoders.get_mut(track)) else { return Ok(packets) };
        if mixer.mix(until, &mut self.scratch) == 0 {
            return Ok(packets);
        }
        encoder.push(&self.scratch);
        encoder.drain(&mut |packet| packets.push(packet))?;
        Ok(packets)
    }

    fn mixed(&self, track: usize) -> u64 {
        self.mixers.get(track).map_or(0, Mixer::mixed)
    }

    /// Whether every track has its mixer and its encoder.
    fn ready_to_mix(&self) -> bool {
        !self.mixers.is_empty() && self.mixers.len() == self.encoders.len()
    }
}

/// The state capture callbacks, the refresh thread and the session share.
/// The microphone's delivery, as `Shared::microphone` keeps it.
#[derive(Default)]
struct MicrophoneState {
    /// Host time it last delivered sound: a buffer with any sample not exactly zero.
    heard_ns: u64,
    /// Host time it last delivered a buffer of only digital silence, every sample exactly zero (plan 089, D2): a MacBook's
    /// built-in microphone with the lid closed is listed and opened but delivers that, which no room does.
    zeros_ns: u64,
    lost: bool,
}

pub struct Shared<P: Platform> {
    events: Arc<dyn Events>,
    phase: AtomicU8,
    t0_ns: AtomicU64,
    failed: AtomicBool,
    /// Why capture or encoding first failed, for a `prepare` that is still waiting.
    failure: Mutex<Option<String>>,
    video: Mutex<VideoState<P>>,
    audio: Mutex<AudioState<P::Audio>>,
    writer: Mutex<Option<writer::MediaSender>>,
    frames_seen: AtomicU64,
    frame_rate: u32,
    /// Host time of `stop`; nothing captured after it is kept. `u64::MAX` until then.
    stop_ns: AtomicU64,
    /// Audio frames the recording holds up to the stop, counted from t0; `u64::MAX` until then.
    audio_target: AtomicU64,
    /// How far ahead of the host clock frames are stamped when handed over, in microseconds, while recording.
    lead_sum_us: AtomicI64,
    lead_count: AtomicU64,
    lead_max_us: AtomicI64,
    /// While recording: frames with a picture, deliveries without one, and the longest gap between pictures in ns.
    captured_pictures: AtomicU64,
    captured_without_picture: AtomicU64,
    captured_gap_max_ns: AtomicU64,
    /// The microphone's input number (`usize::MAX` without one).
    microphone_input: AtomicUsize,
    /// When the microphone last delivered and whether it is told lost: one lock, so a loss and a return are judged
    /// and told in the order they happened.
    microphone: Mutex<MicrophoneState>,
    /// The per-frame log, when the development switch asks for one (frame_log.rs). Locked inside the video lock.
    frame_log: Mutex<Option<FrameLog>>,
    /// Every slot of the frame rate is encoded, still screen or not: the picture changes every frame while a camera
    /// is composed into it (plan 075), which the encoder sees at encoding time.
    every_slot: AtomicBool,
    /// The camera composed into the frames (plan 075): judged on the refresh thread, closed when capture ends.
    camera: Mutex<Option<Arc<dyn CameraControl>>>,
    /// The camera's own track's configuration (plan 087's editable recording), which the file's header holds.
    camera_track: Mutex<Option<VideoSpec>>,
    /// Whether the camera track's encoder failed, told once.
    camera_track_failed: AtomicBool,
    /// The editable recording's description (plan 087), which the file's header holds.
    metadata: Mutex<Option<Vec<u8>>>,
    meters: Meters,
    /// The stage figures, when the development switch asks for them (plan 083, diagnostics.rs).
    diagnostics: Option<Arc<Diagnostics>>,
}

impl<P: Platform> Shared<P> {
    /// Logs a frame at `pts` while recording, when the per-frame log is on. Called under the video lock.
    fn log_frame(&self, video: &VideoState<P>, pts: u64, kind: &str, kept: bool) {
        let mut log = self.frame_log.lock().unwrap();
        let Some(log) = log.as_mut() else { return };
        if !matches!(self.phase.load(Ordering::Acquire), RECORDING | DRAINING) && kind != "first" {
            return;
        }
        log.line(self.t0_ns.load(Ordering::Acquire), pts, kind, kept, video.pacer.as_ref().map(Pacer::next_slot));
    }

    fn send(&self, media: Media) {
        if let Some(writer) = self.writer.lock().unwrap().as_ref() {
            writer.send(media);
        }
    }

    /// Capture or encoding failed: reported once, and not after a stop.
    pub fn fail(&self, detail: String) {
        if self.failed.swap(true, Ordering::AcqRel) || self.phase.load(Ordering::Acquire) == STOPPING {
            return;
        }
        *self.failure.lock().unwrap() = Some(detail.clone());
        let code = if matches!(self.phase.load(Ordering::Acquire), RECORDING | DRAINING) { "capture_failed" } else { "capture_start_failed" };
        self.events.capture_failed(code, detail);
    }

    /// Hands `frame` at `pts` to the encoder, timed when the session keeps figures (plan 083).
    fn submit(&self, encoder: &P::Video, frame: &P::Frame, pts: u64, key_frame: bool) -> Result<(), String> {
        let Some(diagnostics) = self.diagnostics.as_ref() else { return encoder.encode(frame, pts, key_frame) };
        // Remembered before the call: an encoder may hand the sample back before it returns.
        diagnostics.submitted(pts, P::now_ns());
        let began = Instant::now();
        let result = encoder.encode(frame, pts, key_frame);
        diagnostics.encode_submit.record_ns(began.elapsed().as_nanos() as u64);
        result
    }

    /// The session's stage figures, when the development switch asks for them.
    pub fn diagnostics(&self) -> Option<Arc<Diagnostics>> {
        self.diagnostics.clone()
    }

    /// A complete frame captured at `pts` host time. Kept as the newest; encoded when the pacer wants it.
    pub fn frame(&self, frame: P::Frame, pts: u64) {
        let Some(diagnostics) = self.diagnostics.as_ref() else { return self.take_frame(frame, pts) };
        let began = Instant::now();
        self.take_frame(frame, pts);
        diagnostics.capture_callback.record_ns(began.elapsed().as_nanos() as u64);
    }

    fn take_frame(&self, frame: P::Frame, pts: u64) {
        self.frames_seen.fetch_add(1, Ordering::Relaxed);
        let recording = self.phase.load(Ordering::Acquire) == RECORDING;
        if recording {
            let lead = (pts as i64 - P::now_ns() as i64) / 1000;
            self.lead_sum_us.fetch_add(lead, Ordering::Relaxed);
            self.lead_count.fetch_add(1, Ordering::Relaxed);
            self.lead_max_us.fetch_max(lead, Ordering::Relaxed);
        }
        let mut guard = self.video.lock().unwrap();
        let video = &mut *guard;
        if recording {
            self.captured_pictures.fetch_add(1, Ordering::Relaxed);
            // Between pictures both captured while recording: the wait for the first one is the start's, not a gap.
            if video.last_pts >= self.t0_ns.load(Ordering::Acquire) && pts > video.last_pts {
                self.captured_gap_max_ns.fetch_max(pts - video.last_pts, Ordering::Relaxed);
            }
        }
        let phase = self.phase.load(Ordering::Acquire);
        let eligible = matches!(phase, RECORDING | DRAINING) && pts > video.last_encoded_ns && pts < self.stop_ns.load(Ordering::Acquire);
        if let Err(detail) = if eligible { self.fill_skipped(video, pts) } else { Ok(()) } {
            drop(guard);
            self.fail(detail);
            return;
        }
        let wanted = eligible && video.pacer.as_mut().is_some_and(|pacer| pacer.admit(pts));
        video.pending = eligible && !wanted && video.pacer.is_some();
        if wanted {
            if let Some(encoder) = video.encoder.as_ref()
                && let Err(detail) = self.submit(encoder, &frame, pts, false)
            {
                drop(guard);
                self.fail(detail);
                return;
            }
            video.last_encoded_ns = pts;
        }
        self.log_frame(video, pts, "picture", wanted);
        video.last = Some(frame);
        video.last_pts = pts;
    }

    /// Before a delivery at `pts` is judged: when it shows that capture skipped the refresh the pacer wanted (see
    /// `Pacer::skipped`), the newest picture is encoded at that refresh's time. An encoding failure is returned for the
    /// caller to report once it has released the video lock, dropping the delivery.
    fn fill_skipped(&self, video: &mut VideoState<P>, pts: u64) -> Result<(), String> {
        let Some(at) = video.pacer.as_mut().and_then(|pacer| pacer.skipped(pts)) else { return Ok(()) };
        if at <= video.last_encoded_ns {
            return Ok(());
        }
        if let (Some(encoder), Some(frame)) = (video.encoder.as_ref(), video.last.as_ref()) {
            self.submit(encoder, frame, at, false)?;
        }
        video.last_encoded_ns = at;
        video.pending = false;
        self.log_frame(video, at, "skipped", true);
        Ok(())
    }

    /// Capture delivered a frame without a picture (blank, suspended and the like) at `pts`; counted while recording.
    pub fn frame_without_picture(&self, pts: u64) {
        self.count_without_picture();
        let video = self.video.lock().unwrap();
        self.log_frame(&video, pts, "blank", false);
    }

    fn count_without_picture(&self) {
        if self.phase.load(Ordering::Acquire) == RECORDING {
            self.captured_without_picture.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Capture reported the screen unchanged at `pts` (ScreenCaptureKit's idle frame): the newest picture is still what
    /// is shown. When that refresh is the one the pacer wants, the picture is encoded again at it, so a refresh the
    /// screen skipped does not leave a gap of one and a half frames in the recording (plan 076 step 7, 2026-10-16:
    /// 30 fps from the test material on a 60 Hz display had 1–2% of its frames 50 ms apart, every one at an idle
    /// refresh, and none where capture missed one).
    pub fn frame_unchanged(&self, pts: u64) {
        self.count_without_picture();
        let mut guard = self.video.lock().unwrap();
        let video = &mut *guard;
        let phase = self.phase.load(Ordering::Acquire);
        let eligible = matches!(phase, RECORDING | DRAINING) && pts > video.last_encoded_ns && pts < self.stop_ns.load(Ordering::Acquire);
        if let Err(detail) = if eligible { self.fill_skipped(video, pts) } else { Ok(()) } {
            drop(guard);
            self.fail(detail);
            return;
        }
        if !eligible || video.last.is_none() || !video.pacer.as_mut().is_some_and(|pacer| pacer.admit(pts)) {
            self.log_frame(video, pts, "idle", false);
            return;
        }
        if let (Some(encoder), Some(frame)) = (video.encoder.as_ref(), video.last.as_ref())
            && let Err(detail) = self.submit(encoder, frame, pts, false)
        {
            drop(guard);
            self.fail(detail);
            return;
        }
        video.last_encoded_ns = pts;
        video.pending = false;
        self.log_frame(video, pts, "idle", true);
    }

    /// The microphone stopped (or its sound can no longer be read): the recording goes on without it. Told once per
    /// dropout, and only while recording; a microphone that fails to open is `prepare`'s `microphone_unavailable`
    /// instead.
    pub fn lose_microphone(&self, detail: String) {
        let mut microphone = self.microphone.lock().unwrap();
        if !matches!(self.phase.load(Ordering::Acquire), RECORDING | DRAINING) || microphone.lost {
            return;
        }
        microphone.lost = true;
        // Told under the lock: a return the microphone's thread notices next is told after this.
        self.events.microphone_lost(detail);
    }

    /// Another microphone was opened in its place (plan 079, D3): its time without sound counts from now, so the moment
    /// the switch took is not told as a loss. One told lost is told back by its first sound, as a return is.
    pub fn microphone_switched(&self) {
        self.microphone.lock().unwrap().heard_ns = P::now_ns();
    }

    /// Whether `input` is the microphone.
    pub fn is_microphone(&self, input: usize) -> bool {
        self.microphone_input.load(Ordering::Acquire) == input
    }

    /// Tells the microphone's loss once it has delivered nothing for `MICROPHONE_SILENT_NS` while recording.
    fn microphone_clock(&self, now_ns: u64) {
        if self.microphone_input.load(Ordering::Acquire) == usize::MAX {
            return;
        }
        let mut microphone = self.microphone.lock().unwrap();
        // Judged under the lock: sound arriving meanwhile has moved `heard_ns` on, so it cannot be taken for silence.
        let heard = microphone.heard_ns.max(self.t0_ns.load(Ordering::Acquire));
        if microphone.lost || !matches!(self.phase.load(Ordering::Acquire), RECORDING | DRAINING) || now_ns.saturating_sub(heard) <= MICROPHONE_SILENT_NS {
            return;
        }
        microphone.lost = true;
        let seconds = MICROPHONE_SILENT_NS / NANOS_PER_SECOND;
        self.events.microphone_lost(if microphone.zeros_ns > heard {
            format!("the microphone delivered only digital silence (every sample zero) for {seconds} s")
        } else {
            format!("the microphone delivered no sound for {seconds} s")
        });
    }

    /// Whether capture should read its sound now: while it is taken, or while its levels are watched before (plan 075,
    /// D20: a Live preview is a prepared session, whose meters show what each input hears).
    pub fn reads_sound(&self) -> bool {
        self.wants_sound() || self.meters.watched.load(Ordering::Acquire)
    }

    /// Whether sound is taken now; capture may skip reading a buffer when it is not.
    pub fn wants_sound(&self) -> bool {
        matches!(self.phase.load(Ordering::Acquire), RECORDING | DRAINING)
    }

    /// `frames` frames of `input`'s sound captured at `pts` host time; `sample(frame, channel)` reads one, channel 0
    /// or 1 (a mono input gives the same sample for both). Inputs are numbered from 0 in the order the platform told
    /// `Core::new` it has them.
    pub fn sound(&self, input: usize, pts: u64, frames: usize, sample: impl Fn(usize, usize) -> f32) -> Result<(), String> {
        if frames == 0 {
            return Ok(());
        }
        let microphone_input = self.is_microphone(input);
        // Read before the volume and the mute, which make silence of their own: the device's own digital silence.
        let digital_silence = microphone_input && (0..frames).all(|frame| sample(frame, 0) == 0.0 && sample(frame, 1) == 0.0);
        // Its volume (D21): raised past -1 dBFS, softly limited as a loud sum is, rather than clipped by the encoder.
        let gain = f32::from_bits(if microphone_input { &self.meters.microphone_gain } else { &self.meters.system_gain }.load(Ordering::Acquire));
        let sample = |frame: usize, channel: usize| {
            let value = sample(frame, channel) * gain;
            if gain > 1.0 { mixer::limit(value) } else { value }
        };
        // Levels from the moment sound arrives, before recording too (D20: a Live preview is a prepared session): after
        // the volume, so the meter shows what is recorded, and before the mute, so a muted input still shows it hears.
        if self.meters.watched.load(Ordering::Acquire) {
            let peak = (0..frames).fold(0.0f32, |peak, frame| peak.max(sample(frame, 0).abs()).max(sample(frame, 1).abs()));
            let kind = if microphone_input { &self.meters.microphone_peak } else { &self.meters.system_peak };
            if peak.is_finite() {
                kind.fetch_max(peak.to_bits(), Ordering::AcqRel);
            }
            self.tell_levels(P::now_ns());
        }
        if !self.wants_sound() {
            return Ok(());
        }
        // Muted (D19): silence in its place, so the input stays on the clock and unmuting needs no realigning.
        let muted = if microphone_input { &self.meters.microphone_muted } else { &self.meters.system_muted }.load(Ordering::Acquire);
        let sample = |frame: usize, channel: usize| if muted { 0.0 } else { sample(frame, channel) };
        if microphone_input && digital_silence {
            // Not sound (plan 089, D2): 2 s of only this is told lost, as no buffers are; it stays on the clock.
            self.microphone.lock().unwrap().zeros_ns = P::now_ns();
        } else if microphone_input {
            let mut microphone = self.microphone.lock().unwrap();
            let now = P::now_ns();
            let heard = std::mem::replace(&mut microphone.heard_ns, now).max(self.t0_ns.load(Ordering::Acquire));
            // Its sound comes back (074): taken again, the gap left as silence by the aligner.
            if microphone.lost {
                microphone.lost = false;
                let gap = now.saturating_sub(heard) as f64 / NANOS_PER_SECOND as f64;
                self.events.microphone_resumed(format!("the microphone delivered sound again after {gap:.1} s"));
            }
        }
        let mut guard = self.audio.lock().unwrap();
        let audio = &mut *guard;
        // After `stop`, sound only up to it: the track ends where the video does. `audio_target` is only changed under
        // this lock, so a buffer is cut by the target in force while it is placed.
        let target = self.audio_target.load(Ordering::Acquire);
        let routes: Vec<(usize, usize)> = audio.routes(input).collect();
        for (track, slot) in routes {
            let Some(mixer) = audio.mixers.get_mut(track) else { continue };
            // Input frame n is what played at t0 + n / rate; the file's edit list skips the encoder's priming, so sound
            // at presentation time t is what played at t0 + t.
            mixer.add(slot, pts, frames, sample, target);
            let until = mixer.ready().min(target);
            let packets = match audio.advance(track, until) {
                Ok(packets) => packets,
                // The encoder's failure is the recording's, whichever input's sound reached it first: a microphone's
                // caller would take an error for the microphone's own and tell it lost.
                Err(detail) if self.is_microphone(input) => {
                    drop(guard);
                    self.fail(detail);
                    return Ok(());
                }
                Err(detail) => return Err(detail),
            };
            // Sent under the audio lock: packets carry no time, so the writer's order is the track's, and another
            // input or the clock must not send theirs in between.
            for data in packets {
                self.send(Media::Audio { data, track });
            }
        }
        Ok(())
    }

    /// Tells the levels gathered since the last ones, once `LEVELS_INTERVAL_NS` has passed; one input's thread does.
    fn tell_levels(&self, now_ns: u64) {
        let told = self.meters.told_ns.load(Ordering::Acquire);
        if now_ns.saturating_sub(told) < LEVELS_INTERVAL_NS || self.meters.told_ns.compare_exchange(told, now_ns, Ordering::AcqRel, Ordering::Acquire).is_err()
        {
            return;
        }
        let take = |peak: &AtomicU32| f32::from_bits(peak.swap(0, Ordering::AcqRel));
        let microphone = (self.microphone_input.load(Ordering::Acquire) != usize::MAX).then(|| take(&self.meters.microphone_peak));
        self.events.levels(Levels { system: take(&self.meters.system_peak), microphone });
    }

    /// Advances the track with the clock past an input that delivers nothing (see mixer.rs).
    fn sound_clock(&self, now_ns: u64) {
        let mut audio = self.audio.lock().unwrap();
        let target = self.audio_target.load(Ordering::Acquire);
        for track in 0..audio.mixers.len() {
            let limit = audio.mixers[track].clock_limit(now_ns).min(target);
            match audio.advance(track, limit) {
                // Under the audio lock, as in `sound`.
                Ok(packets) => packets.into_iter().for_each(|data| self.send(Media::Audio { data, track })),
                Err(detail) => {
                    drop(audio);
                    self.fail(detail);
                    return;
                }
            }
        }
    }

    /// The time a camera frame captured at `captured_ns` takes in the camera's own track (plan 087), after the one at
    /// `last` (None before its first): the first is at the recording's start, so the track starts with the screen's,
    /// and later ones at their capture; None while not recording, at or after the stop, or for a frame not newer than
    /// the last. Returns the time and whether it is the track's first.
    pub fn camera_pts(&self, captured_ns: u64, last: Option<u64>) -> Option<(u64, bool)> {
        if !self.recording() || captured_ns >= self.stop_ns.load(Ordering::Acquire) {
            return None;
        }
        match last {
            None => Some((self.t0_ns.load(Ordering::Acquire), true)),
            Some(last) if captured_ns > last => Some((captured_ns, false)),
            Some(_) => None,
        }
    }

    /// The sink of the camera's own track's encoder (plan 087): its samples go to the file's camera track. Its failure
    /// loses the camera, told once, not the recording.
    pub fn camera_track_sink(self: &Arc<Self>) -> Arc<dyn VideoSink> {
        Arc::new(CameraTrackSink { shared: self.clone() })
    }

    fn has_frame(&self) -> bool {
        self.video.lock().unwrap().last.is_some()
    }

    /// The newest captured frame, for a preview (plan 075); a clone, so the video lock is not held while it is used.
    pub fn newest(&self) -> Option<P::Frame>
    where
        P::Frame: Clone,
    {
        self.video.lock().unwrap().last.clone()
    }

    /// Whether the recording is on (its first frame encoded) and not yet stopped: when a camera's loss is told.
    pub fn recording(&self) -> bool {
        matches!(self.phase.load(Ordering::Acquire), RECORDING | DRAINING)
    }

    /// Closes the camera, if one is watched; idempotent.
    fn close_camera(&self) {
        let camera = self.camera.lock().unwrap().take();
        if let Some(camera) = camera {
            camera.close();
        }
    }

    /// Whether capture has ended (`Core::halt`).
    pub fn halted(&self) -> bool {
        self.phase.load(Ordering::Acquire) == STOPPING
    }

    pub fn events(&self) -> Arc<dyn Events> {
        self.events.clone()
    }
}

impl<P: Platform> VideoSink for Shared<P> {
    fn media(&self, media: Media) {
        if let (Some(diagnostics), Media::Video { pts_ns, .. }) = (self.diagnostics.as_ref(), &media) {
            diagnostics.encoded(*pts_ns, P::now_ns());
        }
        self.send(media);
    }

    fn failed(&self, detail: String) {
        self.fail(detail);
    }

    fn dropped(&self) {
        if let Some(diagnostics) = self.diagnostics.as_ref() {
            diagnostics.encoder_dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Where the camera's own track's encoder hands its samples (plan 087's editable recording).
struct CameraTrackSink<P: Platform> {
    shared: Arc<Shared<P>>,
}

impl<P: Platform> VideoSink for CameraTrackSink<P> {
    fn media(&self, media: Media) {
        // The configuration is the file's already (`Core::camera_track`), made at `prepare`.
        if let Media::Video { data, pts_ns, sync } = media {
            self.shared.send(Media::Camera { data, pts_ns, sync });
        }
    }

    fn failed(&self, detail: String) {
        if !self.shared.camera_track_failed.swap(true, Ordering::AcqRel) {
            self.shared.events.camera_lost(format!("the camera's own track: {detail}"));
        }
    }
}

/// The platform-independent half of a session; the platform's `Session` owns one beside its capture.
pub struct Core<P: Platform> {
    shared: Arc<Shared<P>>,
    file: Option<File>,
    audio_bitrate: u32,
    writer: Option<JoinHandle<()>>,
    refresher: Option<JoinHandle<()>>,
    /// `Stopped::audio_failure`, kept from `drain` to `end`.
    audio_failure: Option<String>,
}

impl<P: Platform> Core<P> {
    /// `audio_inputs` is how many sound inputs the platform feeds `Shared::sound`.
    pub fn new(events: Arc<dyn Events>, frame_rate: u32, audio_bitrate: u32, audio_inputs: usize, file: File) -> Self {
        let shared = Arc::new(Shared {
            events,
            phase: AtomicU8::new(PREPARED),
            t0_ns: AtomicU64::new(0),
            failed: AtomicBool::new(false),
            failure: Mutex::new(None),
            video: Mutex::new(VideoState { encoder: None, last: None, last_encoded_ns: 0, pacer: None, pending: false, last_pts: 0 }),
            audio: Mutex::new(AudioState {
                encoders: Vec::new(),
                mixers: Vec::new(),
                inputs: audio_inputs,
                separate: false,
                mix: true,
                priming: 0,
                scratch: Vec::new(),
            }),
            writer: Mutex::new(None),
            frames_seen: AtomicU64::new(0),
            frame_rate,
            stop_ns: AtomicU64::new(u64::MAX),
            audio_target: AtomicU64::new(u64::MAX),
            lead_sum_us: AtomicI64::new(0),
            lead_count: AtomicU64::new(0),
            lead_max_us: AtomicI64::new(i64::MIN),
            captured_pictures: AtomicU64::new(0),
            captured_without_picture: AtomicU64::new(0),
            captured_gap_max_ns: AtomicU64::new(0),
            microphone_input: AtomicUsize::new(usize::MAX),
            microphone: Mutex::new(MicrophoneState::default()),
            frame_log: Mutex::new(None),
            every_slot: AtomicBool::new(false),
            camera: Mutex::new(None),
            camera_track: Mutex::new(None),
            camera_track_failed: AtomicBool::new(false),
            metadata: Mutex::new(None),
            meters: Meters::default(),
            diagnostics: Diagnostics::from_env().map(Arc::new),
        });
        Self { shared, file: Some(file), audio_bitrate, writer: None, refresher: None, audio_failure: None }
    }

    /// Which of the sound inputs is the microphone, whose loss while recording is told rather than failing it.
    pub fn watch_microphone(&self, input: usize) {
        self.shared.microphone_input.store(input, Ordering::Release);
    }

    /// The camera composed into this session's frames (plan 075): judged while recording and closed with the session.
    pub fn watch_camera(&self, camera: Arc<dyn CameraControl>) {
        *self.shared.camera.lock().unwrap() = Some(camera);
    }

    /// Puts each sound input on a track of its own instead of mixing them (plan 087's editable recording), after a
    /// track of them mixed when there are several (plan 098); before `make_encoders`, which then makes one encoder per
    /// track.
    pub fn separate_sound(&self, on: bool) {
        self.shared.audio.lock().unwrap().separate = on;
    }

    /// Whether the recording's sound tracks begin with its inputs mixed: with separate tracks and several inputs.
    pub fn mixed_sound(&self) -> bool {
        let audio = self.shared.audio.lock().unwrap();
        audio.split() && audio.mix
    }

    /// Leaves the mixed track out of separate tracks, plan 087's file (`pnpm bench:editable`'s comparison, plan 098):
    /// tests only, so no recording can be made without it.
    #[cfg(test)]
    pub fn leave_out_mix(&self) {
        self.shared.audio.lock().unwrap().mix = false;
    }

    /// How many sound tracks the recording has, and so how many encoders `make_encoders` asks for.
    pub fn sound_tracks(&self) -> usize {
        self.shared.audio.lock().unwrap().tracks()
    }

    /// The camera's own track (plan 087's editable recording), last in the file; before `record`.
    pub fn camera_track(&self, spec: VideoSpec) {
        *self.shared.camera_track.lock().unwrap() = Some(spec);
    }

    /// The editable recording's description (plan 087), in the file's header; before `record`.
    pub fn metadata(&self, metadata: Vec<u8>) {
        *self.shared.metadata.lock().unwrap() = Some(metadata);
    }

    /// Whether the level meters are watched (plan 075, D19): levels are gathered and told only then.
    pub fn watch_levels(&self, watching: bool) {
        self.shared.meters.watched.store(watching, Ordering::Release);
    }

    /// Mutes system audio, the microphone or both from their next sound on (D19): silence in their place.
    pub fn set_muted(&self, system: bool, microphone: bool) {
        self.shared.meters.system_muted.store(system, Ordering::Release);
        self.shared.meters.microphone_muted.store(microphone, Ordering::Release);
    }

    /// Sets system audio's and the microphone's volumes, in dB, from their next sound on (D21); at or below
    /// `SILENT_GAIN_DB` an input is silent. The meters show the levels after them.
    pub fn set_gains(&self, system_db: f64, microphone_db: f64) {
        self.shared.meters.system_gain.store(gain_factor(system_db).to_bits(), Ordering::Release);
        self.shared.meters.microphone_gain.store(gain_factor(microphone_db).to_bits(), Ordering::Release);
    }

    /// Encodes the newest frame at every slot the screen leaves empty, instead of once a second (plan 075: a camera is
    /// composed into each encoded frame, so the picture moves while the screen stands still).
    pub fn encode_every_slot(&self, on: bool) {
        let mut video = self.shared.video.lock().unwrap();
        // Shown again after a still screen: from the current slot on, not every slot the hiding left empty, and the
        // refresh thread woken for it rather than at the end of its 100 ms wait.
        let resumed = on && !self.shared.every_slot.load(Ordering::Acquire);
        if resumed && let Some(pacer) = video.pacer.as_mut() {
            pacer.skip_to(P::now_ns());
        }
        self.shared.every_slot.store(on, Ordering::Release);
        drop(video);
        if resumed && let Some(refresher) = self.refresher.as_ref() {
            refresher.thread().unpark();
        }
    }

    /// Writes the per-frame log for the recording at `path` when the development switch asks for one; returns where.
    pub fn log_frames(&self, path: &std::path::Path) -> Option<PathBuf> {
        let log = FrameLog::from_env(path)?;
        let at = log.path.clone();
        *self.shared.frame_log.lock().unwrap() = Some(log);
        Some(at)
    }

    /// What capture callbacks hold.
    pub fn shared(&self) -> Arc<Shared<P>> {
        self.shared.clone()
    }

    /// Makes the encoders on their own thread, so a platform can start capture meanwhile: until `record` capture only
    /// keeps the newest frame, so nothing needs them before then. `make` gets the sink for encoded video and how many
    /// sound tracks need an encoder, and returns that many.
    pub fn make_encoders(
        &self,
        make: impl FnOnce(Arc<dyn VideoSink>, usize) -> Result<(P::Video, Vec<P::Audio>), CaptureError> + Send + 'static,
    ) -> Result<JoinHandle<Result<(), CaptureError>>, CaptureError> {
        let shared = self.shared.clone();
        let tracks = self.sound_tracks();
        std::thread::Builder::new()
            .name("recordstuff-encoders".into())
            .spawn(move || -> Result<(), CaptureError> {
                let sink: Arc<dyn VideoSink> = shared.clone();
                let (video, audio) = make(sink, tracks)?;
                if audio.len() != tracks {
                    return Err(CaptureError::new("capture_start_failed", format!("{} audio encoders for {tracks} sound tracks", audio.len())));
                }
                shared.video.lock().unwrap().encoder = Some(video);
                let mut state = shared.audio.lock().unwrap();
                state.priming = audio[0].priming();
                state.encoders = audio;
                Ok(())
            })
            .map_err(|e| CaptureError::new("capture_start_failed", format!("encoder thread: {e}")))
    }

    /// The encoders' outcome, once they are made.
    pub fn encoders_made(handle: JoinHandle<Result<(), CaptureError>>) -> Result<(), CaptureError> {
        handle.join().unwrap_or_else(|_| Err(CaptureError::new("capture_start_failed", "making the encoders failed")))
    }

    /// The first sound track's encoder priming; every track's encoder is alike.
    pub fn priming(&self) -> u32 {
        self.shared.audio.lock().unwrap().priming
    }

    /// Waits for capture's first picture, which `record` starts the file with. A failure before it is returned as
    /// itself, not as a missing frame.
    pub fn first_frame(&self, timeout: Duration) -> Result<(), CaptureError> {
        let deadline = Instant::now() + timeout;
        while !self.shared.has_frame() {
            if let Some(detail) = self.shared.failure.lock().unwrap().clone() {
                return Err(CaptureError::new("capture_start_failed", detail));
            }
            if Instant::now() > deadline {
                return Err(CaptureError::new("capture_start_failed", format!("the display delivered no frame within {} s", timeout.as_secs())));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        Ok(())
    }

    /// Starts the file at this moment: the newest frame is its first, a key frame at time zero. Returns at once.
    pub fn record(&mut self) -> Result<(), CaptureError> {
        let file = self.file.take().ok_or_else(|| CaptureError::new("capture_start_failed", "record called twice"))?;
        let t0 = P::now_ns();
        self.shared.t0_ns.store(t0, Ordering::Release);
        let config = {
            let mut audio = self.shared.audio.lock().unwrap();
            let tracks = audio.tracks();
            if audio.encoders.len() != tracks {
                return Err(CaptureError::new("capture_start_failed", "prepared without an audio encoder"));
            }
            // Before the phase lets sound in, which it does only once the first frame is encoded. Separate tracks each
            // take one input; a mixed track takes them all.
            audio.mixers =
                (0..tracks).map(|track| Mixer::new(SAMPLE_RATE, t0, audio.track_inputs(track), AUDIO_TOLERANCE_FRAMES, MIX_LATENCY_FRAMES)).collect();
            audio
                .encoders
                .iter()
                .map(|encoder| AudioSpec {
                    config: encoder.audio_specific_config(),
                    priming: encoder.priming(),
                    sample_rate: SAMPLE_RATE,
                    channels: CHANNELS as u16,
                    bitrate: self.audio_bitrate,
                })
                .collect()
        };
        let events = self.shared.events.clone();
        let diagnostics = self.shared.diagnostics.clone();
        let camera = self.shared.camera_track.lock().unwrap().clone();
        let metadata = self.shared.metadata.lock().unwrap().clone();
        let writer = writer::spawn(WriterConfig { file, t0_ns: t0, audio: config, camera, metadata, diagnostics }, move |event| match event {
            WriterEvent::Progress { bytes } => events.progress(bytes),
            WriterEvent::Failed(failure) => events.write_failed(failure),
        })
        .map_err(|e| CaptureError::new("capture_start_failed", format!("writer thread: {e}")))?;
        *self.shared.writer.lock().unwrap() = Some(writer.sender);
        self.writer = Some(writer.thread);

        // The first frame is encoded on the refresh thread, so `record` answers at once; until it is, the phase
        // stays PREPARED and no captured frame or sound is taken, and the file's time zero is still t0.
        let shared = self.shared.clone();
        self.refresher = Some(
            std::thread::Builder::new()
                .name("recordstuff-refresh".into())
                .spawn(move || refresh::<P>(shared, t0))
                .map_err(|e| CaptureError::new("capture_start_failed", format!("refresh thread: {e}")))?,
        );
        Ok(())
    }

    /// Ends the recording at `stop_ns`: no later frame is encoded, and capture runs on until the sound up to it has
    /// been encoded, or for `DRAIN_TIMEOUT`, after which the rest of it is silence. Returns how long that took and how
    /// many frames were silence.
    pub fn drain(&mut self, stop_ns: u64) -> (f64, u64) {
        let began = Instant::now();
        // Not recorded: nothing to end.
        if self.writer.is_none() {
            return (0.0, 0);
        }
        let t0 = self.shared.t0_ns.load(Ordering::Acquire);
        let target = u64::try_from(u128::from(stop_ns.saturating_sub(t0)) * u128::from(SAMPLE_RATE) / u128::from(NANOS_PER_SECOND)).unwrap_or(u64::MAX);
        // The cutoff first, under the audio lock that placement holds: no sound after the stop is taken from here on.
        self.shared.audio.lock().unwrap().audio_target_set(&self.shared.audio_target, target);
        {
            // Under the video lock, so no frame after the stop is encoded once this returns. A record whose first frame
            // is still being encoded (PREPARED) drains too, and its refresh thread then never moves to RECORDING.
            let mut guard = self.shared.video.lock().unwrap();
            let video = &mut *guard;
            self.shared.stop_ns.store(stop_ns, Ordering::Release);
            let moved =
                [RECORDING, PREPARED].iter().any(|&from| self.shared.phase.compare_exchange(from, DRAINING, Ordering::AcqRel, Ordering::Acquire).is_ok());
            if !moved {
                return (0.0, 0);
            }
            // The newest change, left out by the pacer, is the picture until the stop: at its own capture time, which
            // is after the last encoded frame and before the stop, so it lasts until the video's end.
            if video.pending {
                video.pending = false;
                let at = video.last_pts.max(video.last_encoded_ns + 1);
                if at >= stop_ns {
                    // No time left before the stop to show it.
                } else if let (Some(encoder), Some(frame)) = (video.encoder.as_ref(), video.last.as_ref())
                    && self.shared.submit(encoder, frame, at, false).is_ok()
                {
                    video.last_encoded_ns = at;
                    self.shared.log_frame(video, at, "stop", true);
                }
            }
        }
        let deadline = began + DRAIN_TIMEOUT;
        loop {
            let mut audio = self.shared.audio.lock().unwrap();
            if !audio.ready_to_mix() {
                return (0.0, 0);
            }
            let mut packets = Vec::new();
            // An encoder's error loses what it held; the stop goes on, and `Stopped` tells it.
            let mut keep = |track: usize, made: Result<Vec<Vec<u8>>, String>, failure: &mut Option<String>| match made {
                Ok(made) => packets.extend(made.into_iter().map(|data| (track, data))),
                Err(detail) => {
                    failure.get_or_insert(detail);
                }
            };
            for track in 0..audio.mixers.len() {
                let ready = audio.mixers[track].ready().min(target);
                let made = audio.advance(track, ready);
                keep(track, made, &mut self.audio_failure);
            }
            // The track furthest from the stop: the frames still missing that the drain waits for.
            let missing = (0..audio.mixers.len()).map(|track| target.saturating_sub(audio.mixed(track))).max().unwrap_or(0);
            let done = missing == 0 || Instant::now() >= deadline;
            if done {
                // What has not arrived by now is silence.
                for track in 0..audio.mixers.len() {
                    let made = audio.advance(track, target);
                    keep(track, made, &mut self.audio_failure);
                }
            }
            // Under the audio lock, as in `Shared::sound`.
            for (track, data) in packets {
                self.shared.send(Media::Audio { data, track });
            }
            drop(audio);
            if done {
                return (began.elapsed().as_secs_f64() * 1000.0, missing);
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// From here on frames and sound are ignored and the refresh thread ends; the platform stops capture between
    /// this and `halted`.
    pub fn halt(&self) {
        self.shared.phase.store(STOPPING, Ordering::Release);
    }

    pub fn halted(&mut self) {
        if let Some(thread) = self.refresher.take() {
            let _ = thread.join();
        }
        // Capture has ended: the camera's light goes off now, not when the file is finished.
        self.shared.close_camera();
    }

    pub fn stopping(&self) -> bool {
        self.shared.phase.load(Ordering::Acquire) == STOPPING
    }

    /// After `drain` and the platform's halt: flushes the encoders and asks the writer to finish the file, which goes
    /// on in the background (`Finishing`). Capture has ended when this returns.
    pub fn end(&mut self, stop_ns: u64, (drain_ms, drain_padded_frames): (f64, u64)) -> (Stopped, Finishing) {
        {
            // Encoded samples reach the writer before the flush returns, and before the file is finished below.
            let mut video = self.shared.video.lock().unwrap();
            if let Some(encoder) = video.encoder.take() {
                encoder.flush();
            }
            video.last = None;
        }
        let mut packets = Vec::new();
        let mut audio_frames = Vec::new();
        let (late_audio_frames, audio_corrections, limited_audio_samples);
        {
            let mut audio = self.shared.audio.lock().unwrap();
            let encoders = std::mem::take(&mut audio.encoders);
            for (track, mut encoder) in encoders.into_iter().enumerate() {
                let mut frames = None;
                if audio.mixed(track) > 0 {
                    if let Err(detail) = encoder.finish(&mut |packet| packets.push((track, packet))) {
                        self.audio_failure.get_or_insert(detail);
                    }
                    frames = Some(encoder.frames_in().min(self.shared.audio_target.load(Ordering::Acquire)));
                }
                audio_frames.push(frames);
            }
            // Per input, in their order.
            (late_audio_frames, audio_corrections) = audio.per_input();
            limited_audio_samples = audio.mixers.iter().map(Mixer::limited).sum();
        }
        for (track, data) in packets {
            self.shared.send(Media::Audio { data, track });
        }
        let frame_lead_ms = frame_lead_ms(
            self.shared.lead_sum_us.load(Ordering::Relaxed),
            self.shared.lead_count.load(Ordering::Relaxed),
            self.shared.lead_max_us.load(Ordering::Relaxed),
        );
        let captured = Captured {
            pictures: self.shared.captured_pictures.load(Ordering::Relaxed),
            without_picture: self.shared.captured_without_picture.load(Ordering::Relaxed),
            longest_gap_ms: self.shared.captured_gap_max_ns.load(Ordering::Relaxed) as f64 / 1e6,
        };
        let audio_failure = self.audio_failure.take();
        let stopped =
            Stopped { drain_ms, drain_padded_frames, frame_lead_ms, late_audio_frames, audio_corrections, limited_audio_samples, captured, audio_failure };
        let outcome = self.shared.writer.lock().unwrap().take().map(|sender| (sender.finish(stop_ns, audio_frames), self.writer.take()));
        (stopped, Finishing { outcome, began: Instant::now() })
    }

    /// Releases the encoders and the camera of a session that never recorded.
    pub fn release(&self) {
        self.shared.close_camera();
        self.shared.video.lock().unwrap().encoder.take();
        self.shared.audio.lock().unwrap().encoders.clear();
    }

    pub fn frames_seen(&self) -> u64 {
        self.shared.frames_seen.load(Ordering::Relaxed)
    }
}

impl<P: Platform> Drop for Core<P> {
    /// A core dropped without a stop or a release (its owner went away, or preparing failed) still closes the camera.
    fn drop(&mut self) {
        self.shared.close_camera();
    }
}

/// The refresh thread: encodes the first frame at t0, then a frame the pacer left out at its slot, and the last frame
/// again every second while the screen stands still, or at every slot while a camera is composed.
fn refresh<P: Platform>(shared: Arc<Shared<P>>, t0: u64) {
    {
        let mut guard = shared.video.lock().unwrap();
        let video = &mut *guard;
        let first = match (video.encoder.as_ref(), video.last.as_ref()) {
            (Some(encoder), Some(frame)) => shared.submit(encoder, frame, t0, true),
            _ => Err("no frame to start the recording with".into()),
        };
        if let Err(detail) = first {
            drop(guard);
            shared.fail(detail);
            return;
        }
        video.last_encoded_ns = t0;
        video.pacer = Some(Pacer::new(t0, shared.frame_rate));
        shared.log_frame(video, t0, "first", true);
        // Under the video lock: no captured frame can be encoded before the first one. A stop that came first keeps
        // its phase.
        if shared.phase.compare_exchange(PREPARED, RECORDING, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return;
        }
    }
    // With a composed camera the first slot comes before the usual 100 ms, so each slot samples the camera in turn
    // rather than the first few catching up at once.
    let mut wake = if shared.every_slot.load(Ordering::Acquire) {
        let slot = shared.video.lock().unwrap().pacer.as_ref().map_or(t0, |pacer| pacer.next_slot());
        Duration::from_nanos(slot.saturating_sub(P::now_ns()).clamp(1_000_000, 100_000_000))
    } else {
        Duration::from_millis(100)
    };
    while shared.phase.load(Ordering::Acquire) == RECORDING {
        // Parked rather than asleep, so showing the camera again wakes it for the next slot (`encode_every_slot`).
        std::thread::park_timeout(wake);
        wake = Duration::from_millis(100);
        let now = P::now_ns();
        shared.sound_clock(now);
        shared.microphone_clock(now);
        let camera = shared.camera.lock().unwrap().clone();
        if let Some(camera) = camera {
            camera.judge(now, t0, &*shared.events);
        }
        let mut guard = shared.video.lock().unwrap();
        let video = &mut *guard;
        if shared.phase.load(Ordering::Acquire) != RECORDING {
            continue;
        }
        // A frame the pacer left out, on a screen that has since stood still: due at its slot.
        let at = if video.pending {
            match video.pacer.as_mut().and_then(|pacer| pacer.due(now)) {
                Some(slot) => Some((slot.max(video.last_encoded_ns + 1), "due")),
                None => {
                    let slot = video.pacer.as_ref().map_or(now, |pacer| pacer.next_slot());
                    wake = Duration::from_nanos(slot.saturating_sub(now).clamp(1_000_000, 100_000_000));
                    None
                }
            }
        } else if shared.every_slot.load(Ordering::Acquire) {
            // A composed camera: the newest frame again at each slot no capture took.
            match video.pacer.as_mut().and_then(|pacer| pacer.due(now)) {
                Some(slot) => Some((slot.max(video.last_encoded_ns + 1), "slot")),
                None => {
                    let slot = video.pacer.as_ref().map_or(now, |pacer| pacer.next_slot());
                    wake = Duration::from_nanos(slot.saturating_sub(now).clamp(1_000_000, 100_000_000));
                    None
                }
            }
        } else if now >= video.last_encoded_ns + REFRESH_NS {
            Some((now, "refresh"))
        } else {
            None
        };
        let Some((at, kind)) = at else { continue };
        video.pending = false;
        let result = match (video.encoder.as_ref(), video.last.as_ref()) {
            (Some(encoder), Some(frame)) => shared.submit(encoder, frame, at, false),
            _ => Ok(()),
        };
        video.last_encoded_ns = at;
        shared.log_frame(video, at, kind, true);
        if shared.every_slot.load(Ordering::Acquire) {
            let slot = video.pacer.as_ref().map_or(now, |pacer| pacer.next_slot());
            wake = Duration::from_nanos(slot.saturating_sub(now).clamp(1_000_000, 100_000_000));
        }
        drop(guard);
        if let Err(detail) = result {
            shared.fail(detail);
        }
    }
}

/// The bounds the Settings faders send within (src/shared/audio-volume.ts), from the file both sides are checked against.
#[cfg(test)]
mod gain_bounds_tests {
    use super::{MAX_GAIN_DB, SILENT_GAIN_DB};

    #[test]
    fn the_gains_agree_with_the_settings_faders() {
        let bounds: serde_json::Value = serde_json::from_str(include_str!("../../../../src/shared/audio-volume.bounds.json")).unwrap();
        assert_eq!(SILENT_GAIN_DB, bounds["silentGainDb"].as_f64().unwrap());
        let max_percent = bounds["maxVolumePercent"].as_f64().unwrap();
        assert!((MAX_GAIN_DB - 20.0 * (max_percent / 100.0).log10()).abs() < 1e-12, "{MAX_GAIN_DB} is not {max_percent}%");
        let top = bounds["volumes"].as_array().unwrap().iter().find(|volume| volume["percent"].as_f64() == Some(max_percent)).unwrap();
        assert!((MAX_GAIN_DB - top["db"].as_f64().unwrap()).abs() < 1e-12);
    }
}

/// How far ahead of the clock the recording's frames were stamped, on average and at most, in ms. No frame while
/// recording (a still screen, a stop right after record) is 0 for both: the maximum's `i64::MIN` start is no lead.
fn frame_lead_ms(sum_us: i64, count: u64, max_us: i64) -> (f64, f64) {
    if count == 0 {
        return (0.0, 0.0);
    }
    (sum_us as f64 / count as f64 / 1000.0, max_us as f64 / 1000.0)
}

#[cfg(test)]
mod tests;
