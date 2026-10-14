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
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::pacing::Pacer;
use crate::timing::{AudioAligner, NANOS_PER_SECOND};
use crate::writer::{self, AudioSpec, Media, WriteFailure, WriterConfig, WriterEvent};

const PREPARED: u8 = 0;
const RECORDING: u8 = 1;
const STOPPING: u8 = 2;
/// `stop` was called: capture still runs until the sound before the stop has arrived; nothing after it is kept.
const DRAINING: u8 = 3;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
/// 10 ms: how far an audio buffer's time may disagree with the sample count before it is corrected.
const AUDIO_TOLERANCE_FRAMES: u64 = 480;
/// While the screen stays still, the last frame is encoded again this often.
const REFRESH_NS: u64 = NANOS_PER_SECOND;
/// How long `stop` waits for the sound up to the stop; what has not come by then is silence.
const DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
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
}

/// Where encoded video goes, and who hears that encoding failed. Called on the encoder's thread.
pub trait VideoSink: Send + Sync {
    fn media(&self, media: Media);
    fn failed(&self, detail: String);
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
    pub hide_system_ui: bool,
    pub path: PathBuf,
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
}

pub struct Stopped {
    pub bytes: u64,
    pub fragmented: Option<String>,
    pub finalize_ms: f64,
    /// How long the sound up to the stop took to arrive, and how much of it was filled with silence.
    pub drain_ms: f64,
    pub drain_padded_frames: u64,
    /// How far ahead of the host clock frames were stamped when handed over, on average and at most.
    pub frame_lead_ms: (f64, f64),
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
    encoder: Option<A>,
    aligner: Option<AudioAligner>,
    priming: u32,
    scratch: Vec<f32>,
}

impl<A> AudioState<A> {
    /// Changes the cutoff; taking `&mut self` means the audio lock is held.
    fn audio_target_set(&mut self, target: &AtomicU64, frames: u64) {
        target.store(frames, Ordering::Release);
    }
}

/// The state capture callbacks, the refresh thread and the session share.
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
}

impl<P: Platform> Shared<P> {
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

    /// A complete frame captured at `pts` host time. Kept as the newest; encoded when the pacer wants it.
    pub fn frame(&self, frame: P::Frame, pts: u64) {
        self.frames_seen.fetch_add(1, Ordering::Relaxed);
        if self.phase.load(Ordering::Acquire) == RECORDING {
            let lead = (pts as i64 - P::now_ns() as i64) / 1000;
            self.lead_sum_us.fetch_add(lead, Ordering::Relaxed);
            self.lead_count.fetch_add(1, Ordering::Relaxed);
            self.lead_max_us.fetch_max(lead, Ordering::Relaxed);
        }
        let mut guard = self.video.lock().unwrap();
        let video = &mut *guard;
        let phase = self.phase.load(Ordering::Acquire);
        let eligible = matches!(phase, RECORDING | DRAINING) && pts > video.last_encoded_ns && pts <= self.stop_ns.load(Ordering::Acquire);
        let wanted = eligible && video.pacer.as_mut().is_some_and(|pacer| pacer.admit(pts));
        video.pending = eligible && !wanted && video.pacer.is_some();
        if wanted {
            if let Some(encoder) = video.encoder.as_ref() {
                if let Err(detail) = encoder.encode(&frame, pts, false) {
                    drop(guard);
                    self.fail(detail);
                    return;
                }
            }
            video.last_encoded_ns = pts;
        }
        video.last = Some(frame);
        video.last_pts = pts;
    }

    /// Whether sound is taken now; capture may skip reading a buffer when it is not.
    pub fn wants_sound(&self) -> bool {
        matches!(self.phase.load(Ordering::Acquire), RECORDING | DRAINING)
    }

    /// `frames` frames of sound captured at `pts` host time; `sample(frame, channel)` reads one, channel 0 or 1.
    pub fn sound(&self, pts: u64, frames: usize, sample: impl Fn(usize, usize) -> f32) -> Result<(), String> {
        if !self.wants_sound() || frames == 0 {
            return Ok(());
        }
        let mut guard = self.audio.lock().unwrap();
        let audio = &mut *guard;
        let t0 = self.t0_ns.load(Ordering::Acquire);
        // Input frame n is what played at t0 + n / rate; the file's edit list skips the encoder's priming, so sound at
        // presentation time t is what played at t0 + t.
        let aligner = audio.aligner.get_or_insert_with(|| AudioAligner::new(SAMPLE_RATE, t0, AUDIO_TOLERANCE_FRAMES));
        let placement = aligner.place(pts, frames as u64);
        let Some(encoder) = audio.encoder.as_mut() else { return Ok(()) };
        // After `stop`, sound only up to it: the track ends where the video does. `audio_target` is only changed under
        // this lock, so a buffer is cut by the target in force while it is placed.
        let room = self.audio_target.load(Ordering::Acquire).saturating_sub(encoder.frames_in());
        let silence = placement.silence.min(room);
        encoder.push_silence(silence as usize);
        let start = (placement.skip as usize).min(frames);
        let end = start + ((frames - start) as u64).min(room - silence) as usize;
        audio.scratch.clear();
        for frame in start..end {
            audio.scratch.push(sample(frame, 0));
            audio.scratch.push(sample(frame, 1));
        }
        encoder.push(&audio.scratch);
        let mut packets = Vec::new();
        encoder.drain(&mut |packet| packets.push(packet))?;
        drop(guard);
        for data in packets {
            self.send(Media::Audio { data });
        }
        Ok(())
    }

    fn has_frame(&self) -> bool {
        self.video.lock().unwrap().last.is_some()
    }
}

impl<P: Platform> VideoSink for Shared<P> {
    fn media(&self, media: Media) {
        self.send(media);
    }

    fn failed(&self, detail: String) {
        self.fail(detail);
    }
}

/// The platform-independent half of a session; the platform's `Session` owns one beside its capture.
pub struct Core<P: Platform> {
    shared: Arc<Shared<P>>,
    file: Option<File>,
    audio_bitrate: u32,
    writer: Option<JoinHandle<()>>,
    refresher: Option<JoinHandle<()>>,
}

impl<P: Platform> Core<P> {
    pub fn new(events: Arc<dyn Events>, frame_rate: u32, audio_bitrate: u32, file: File) -> Self {
        let shared = Arc::new(Shared {
            events,
            phase: AtomicU8::new(PREPARED),
            t0_ns: AtomicU64::new(0),
            failed: AtomicBool::new(false),
            failure: Mutex::new(None),
            video: Mutex::new(VideoState { encoder: None, last: None, last_encoded_ns: 0, pacer: None, pending: false, last_pts: 0 }),
            audio: Mutex::new(AudioState { encoder: None, aligner: None, priming: 0, scratch: Vec::new() }),
            writer: Mutex::new(None),
            frames_seen: AtomicU64::new(0),
            frame_rate,
            stop_ns: AtomicU64::new(u64::MAX),
            audio_target: AtomicU64::new(u64::MAX),
            lead_sum_us: AtomicI64::new(0),
            lead_count: AtomicU64::new(0),
            lead_max_us: AtomicI64::new(i64::MIN),
        });
        Self { shared, file: Some(file), audio_bitrate, writer: None, refresher: None }
    }

    /// What capture callbacks hold.
    pub fn shared(&self) -> Arc<Shared<P>> {
        self.shared.clone()
    }

    /// Makes the encoders on their own thread, so a platform can start capture meanwhile: until `record` capture only
    /// keeps the newest frame, so nothing needs them before then. `make` gets the sink for encoded video.
    pub fn make_encoders(
        &self,
        make: impl FnOnce(Arc<dyn VideoSink>) -> Result<(P::Video, P::Audio), CaptureError> + Send + 'static,
    ) -> Result<JoinHandle<Result<(), CaptureError>>, CaptureError> {
        let shared = self.shared.clone();
        std::thread::Builder::new()
            .name("recordstuff-encoders".into())
            .spawn(move || -> Result<(), CaptureError> {
                let sink: Arc<dyn VideoSink> = shared.clone();
                let (video, audio) = make(sink)?;
                shared.video.lock().unwrap().encoder = Some(video);
                let mut state = shared.audio.lock().unwrap();
                state.priming = audio.priming();
                state.encoder = Some(audio);
                Ok(())
            })
            .map_err(|e| CaptureError::new("capture_start_failed", format!("encoder thread: {e}")))
    }

    /// The encoders' outcome, once they are made.
    pub fn encoders_made(handle: JoinHandle<Result<(), CaptureError>>) -> Result<(), CaptureError> {
        handle.join().unwrap_or_else(|_| Err(CaptureError::new("capture_start_failed", "making the encoders failed")))
    }

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
                return Err(CaptureError::new(
                    "capture_start_failed",
                    format!("the display delivered no frame within {} s", timeout.as_secs()),
                ));
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
            let audio = self.shared.audio.lock().unwrap();
            let encoder = audio.encoder.as_ref().ok_or_else(|| CaptureError::new("capture_start_failed", "prepared without an audio encoder"))?;
            AudioSpec {
                config: encoder.audio_specific_config(),
                priming: encoder.priming(),
                sample_rate: SAMPLE_RATE,
                channels: CHANNELS as u16,
                bitrate: self.audio_bitrate,
            }
        };
        let events = self.shared.events.clone();
        let writer = writer::spawn(WriterConfig { file, t0_ns: t0, audio: Some(config) }, move |event| match event {
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
        let target = u64::try_from(u128::from(stop_ns.saturating_sub(t0)) * u128::from(SAMPLE_RATE) / u128::from(NANOS_PER_SECOND))
            .unwrap_or(u64::MAX);
        // The cutoff first, under the audio lock that placement holds: no sound after the stop is taken from here on.
        self.shared.audio.lock().unwrap().audio_target_set(&self.shared.audio_target, target);
        {
            // Under the video lock, so no frame after the stop is encoded once this returns. A record whose first frame
            // is still being encoded (PREPARED) drains too, and its refresh thread then never moves to RECORDING.
            let mut guard = self.shared.video.lock().unwrap();
            let video = &mut *guard;
            self.shared.stop_ns.store(stop_ns, Ordering::Release);
            let moved = [RECORDING, PREPARED]
                .iter()
                .any(|&from| self.shared.phase.compare_exchange(from, DRAINING, Ordering::AcqRel, Ordering::Acquire).is_ok());
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
                } else if let (Some(encoder), Some(frame)) = (video.encoder.as_ref(), video.last.as_ref()) {
                    if encoder.encode(frame, at, false).is_ok() {
                        video.last_encoded_ns = at;
                    }
                }
            }
        }
        let deadline = began + DRAIN_TIMEOUT;
        loop {
            let mut audio = self.shared.audio.lock().unwrap();
            let started = audio.aligner.is_some();
            let Some(encoder) = audio.encoder.as_mut() else { return (0.0, 0) };
            let missing = target.saturating_sub(encoder.frames_in());
            if missing == 0 || Instant::now() >= deadline {
                // No sound at all yet: the track is empty and `stop` leaves it so.
                if !started {
                    return (began.elapsed().as_secs_f64() * 1000.0, 0);
                }
                encoder.push_silence(missing as usize);
                return (began.elapsed().as_secs_f64() * 1000.0, missing);
            }
            drop(audio);
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
    }

    pub fn stopping(&self) -> bool {
        self.shared.phase.load(Ordering::Acquire) == STOPPING
    }

    /// After `drain` and the platform's halt: flushes the encoders and finishes the file. Blocks until the file is
    /// plain or why it is not is known.
    pub fn finish(&mut self, stop_ns: u64, (drain_ms, drain_padded_frames): (f64, u64)) -> Result<Stopped, WriteFailure> {
        {
            // Encoded samples reach the writer before the flush returns, and before the file is finished below.
            let mut video = self.shared.video.lock().unwrap();
            if let Some(encoder) = video.encoder.take() {
                encoder.flush();
            }
            video.last = None;
        }
        let mut packets = Vec::new();
        let mut audio_frames = None;
        {
            let mut audio = self.shared.audio.lock().unwrap();
            if let Some(mut encoder) = audio.encoder.take() {
                if audio.aligner.is_some() {
                    let _ = encoder.finish(&mut |packet| packets.push(packet));
                    audio_frames = Some(encoder.frames_in().min(self.shared.audio_target.load(Ordering::Acquire)));
                }
            }
        }
        for data in packets {
            self.shared.send(Media::Audio { data });
        }
        let Some(sender) = self.shared.writer.lock().unwrap().take() else {
            return Ok(Stopped { bytes: 0, fragmented: None, finalize_ms: 0.0, drain_ms, drain_padded_frames, frame_lead_ms: (0.0, 0.0) });
        };
        let began = Instant::now();
        let outcome = sender
            .finish(stop_ns, audio_frames)
            .recv_timeout(FINISH_TIMEOUT)
            .map_err(|_| WriteFailure { code: "output_write_failed", detail: "finishing the file did not complete within 120 s".into() })?;
        if let Some(thread) = self.writer.take() {
            let _ = thread.join();
        }
        let report = outcome?;
        let count = self.shared.lead_count.load(Ordering::Relaxed).max(1) as f64;
        let frame_lead_ms = (
            self.shared.lead_sum_us.load(Ordering::Relaxed) as f64 / count / 1000.0,
            self.shared.lead_max_us.load(Ordering::Relaxed).max(i64::MIN / 2) as f64 / 1000.0,
        );
        Ok(Stopped {
            frame_lead_ms,
            bytes: report.bytes,
            fragmented: report.fragmented,
            finalize_ms: began.elapsed().as_secs_f64() * 1000.0,
            drain_ms,
            drain_padded_frames,
        })
    }

    /// Releases the encoders of a session that never recorded.
    pub fn release(&self) {
        self.shared.video.lock().unwrap().encoder.take();
        self.shared.audio.lock().unwrap().encoder.take();
    }

    pub fn frames_seen(&self) -> u64 {
        self.shared.frames_seen.load(Ordering::Relaxed)
    }
}

/// The refresh thread: encodes the first frame at t0, then a frame the pacer left out at its slot, and the last frame
/// again every second while the screen stands still.
fn refresh<P: Platform>(shared: Arc<Shared<P>>, t0: u64) {
    {
        let mut guard = shared.video.lock().unwrap();
        let video = &mut *guard;
        let first = match (video.encoder.as_ref(), video.last.as_ref()) {
            (Some(encoder), Some(frame)) => encoder.encode(frame, t0, true),
            _ => Err("no frame to start the recording with".into()),
        };
        if let Err(detail) = first {
            drop(guard);
            shared.fail(detail);
            return;
        }
        video.last_encoded_ns = t0;
        video.pacer = Some(Pacer::new(t0, shared.frame_rate));
        // Under the video lock: no captured frame can be encoded before the first one. A stop that came first keeps
        // its phase.
        if shared.phase.compare_exchange(PREPARED, RECORDING, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return;
        }
    }
    let mut wake = Duration::from_millis(100);
    while shared.phase.load(Ordering::Acquire) == RECORDING {
        std::thread::sleep(wake);
        wake = Duration::from_millis(100);
        let now = P::now_ns();
        let mut guard = shared.video.lock().unwrap();
        let video = &mut *guard;
        if shared.phase.load(Ordering::Acquire) != RECORDING {
            continue;
        }
        // A frame the pacer left out, on a screen that has since stood still: due at its slot.
        let at = if video.pending {
            match video.pacer.as_mut().and_then(|pacer| pacer.due(now)) {
                Some(slot) => Some(slot.max(video.last_encoded_ns + 1)),
                None => {
                    let slot = video.pacer.as_ref().map_or(now, |pacer| pacer.next_slot());
                    wake = Duration::from_nanos(slot.saturating_sub(now).clamp(1_000_000, 100_000_000));
                    None
                }
            }
        } else if now >= video.last_encoded_ns + REFRESH_NS {
            Some(now)
        } else {
            None
        };
        let Some(at) = at else { continue };
        video.pending = false;
        let result = match (video.encoder.as_ref(), video.last.as_ref()) {
            (Some(encoder), Some(frame)) => encoder.encode(frame, at, false),
            _ => Ok(()),
        };
        video.last_encoded_ns = at;
        drop(guard);
        if let Err(detail) = result {
            shared.fail(detail);
        }
    }
}

#[cfg(test)]
mod tests;
