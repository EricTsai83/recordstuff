//! The microphone, mixed into the recording's track (074's input): CoreAudio's HAL (plan 078 step 6), an AUHAL input
//! unit on the chosen device or the system's default input, read as one channel at the device's rate, converted to
//! 48 kHz 32-bit float and heard in both of the track's (074, as Cap does: an audio interface's microphone on its first
//! input would otherwise be in the left ear only), and stamped with the host time of each buffer (`mHostTime`), the
//! clock the screen's samples use. Never voice processing: a plain HAL unit, not the voice-processing one.
//!
//! A microphone that cannot be opened refuses the recording with `microphone_unavailable` (074); one that stops while
//! recording is told after 2 s without sound (`Shared::microphone_clock`) and the recording goes on without it. This
//! module then takes it back: once a second it checks the device, and a device that is gone, or still there but
//! silent, is closed and opened again by its UID as soon as the HAL lists it, retrying after 2 s and backing off to
//! 30 s, as Cap reconnects (cpal). The HAL follows devices in a process without a main run loop, which AVFoundation did
//! not (074's probe, hal.rs). The device taken back is always the one opened at the start, the default input's
//! included: a new default does not replace it (the maintainer's decision, 2026-10-17).
//!
//! The usage description and the hardened runtime's audio-input entitlement, which a signed RecordStuff needs before
//! macOS lets it open a microphone, are in electron-builder.yml and resources/entitlements.mac.plist; the
//! authorization is still read from AVFoundation, which answers it without a run loop.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, sync_channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

use super::hal::{self, Chunk, InputUnit, Resampler};
use super::session::Shared;
use super::CaptureError;
use crate::core::{Microphone, SAMPLE_RATE};

/// How long without sound before the device is checked and opened again.
const SILENT: Duration = Duration::from_secs(2);
/// The waits between attempts to open it again, the last repeated.
const BACKOFF: [Duration; 5] = [Duration::from_secs(2), Duration::from_secs(4), Duration::from_secs(8), Duration::from_secs(16), Duration::from_secs(30)];
/// Buffers the HAL's thread may queue ahead of the reading thread (about 2 s at 512 frames).
const QUEUE: usize = 192;

fn unavailable(detail: impl Into<String>) -> CaptureError {
    CaptureError::new("microphone_unavailable", format!("microphone: {}", detail.into()))
}

/// The audio input devices, the system's default marked.
pub fn list() -> Result<Vec<Microphone>, CaptureError> {
    let default = hal::default_input().map(|input| input.uid);
    Ok(hal::inputs()
        .into_iter()
        .map(|input| Microphone { default: default.as_deref() == Some(input.uid.as_str()), name: input.name, id: input.uid })
        .collect())
}

/// AVFoundation's microphone authorization for this process: 0 not determined, 1 restricted, 2 denied, 3 authorized.
pub fn authorization() -> Result<isize, CaptureError> {
    let media = unsafe { AVMediaTypeAudio }.ok_or_else(|| unavailable("AVFoundation has no audio media type"))?;
    Ok(unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) }.0)
}

pub struct MicrophoneCapture {
    /// A chosen device that is not connected is replaced by the default input; this says so (074).
    pub note: Option<String>,
    /// The device opened.
    pub name: String,
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MicrophoneCapture {
    /// Opens `device` (the system's default input when `None`) and hands its sound to `shared` as `input`.
    pub fn start(device: Option<&str>, shared: Arc<Shared>, input: usize) -> Result<Self, CaptureError> {
        let status = AVAuthorizationStatus(authorization()?);
        if status == AVAuthorizationStatus::Denied || status == AVAuthorizationStatus::Restricted {
            return Err(unavailable("access is not allowed (System Settings > Privacy & Security > Microphone)"));
        }
        // Never asked: the HAL would deliver silence without a prompt, and a narration would be lost unnoticed. Main
        // asks before recording (074).
        if status == AVAuthorizationStatus::NotDetermined {
            return Err(unavailable("access is not allowed yet: macOS has not asked for it"));
        }
        // A chosen device that is not connected falls back to the default input, and the note says so.
        let chosen = device.and_then(|uid| hal::device_for_uid(uid).and_then(|id| hal::inputs().into_iter().find(|input| input.id == id)));
        let note = match (device, &chosen) {
            (Some(uid), None) => Some(format!("microphone: {uid} is not connected; the default input is used")),
            _ => None,
        };
        let opened = match chosen {
            Some(input) => input,
            None => hal::default_input().ok_or_else(|| unavailable("there is no audio input"))?,
        };
        let (chunks, received) = sync_channel(QUEUE);
        let unit = InputUnit::open(opened.id, chunks.clone()).map_err(|why| unavailable(format!("{} could not be opened: {why}", opened.name)))?;
        let resampler = converter(unit.rate).map_err(unavailable)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let reader = Reader { shared, input, uid: opened.uid.clone(), name: opened.name.clone(), chunks, received, stopped: stopped.clone() };
        let thread = std::thread::Builder::new()
            .name("recordstuff-microphone".into())
            .spawn(move || reader.run(unit, resampler))
            .map_err(|e| unavailable(format!("its thread: {e}")))?;
        Ok(Self { note, name: opened.name, stopped, thread: Some(thread) })
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }
}

impl Drop for MicrophoneCapture {
    fn drop(&mut self) {
        self.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A converter when the device does not run at 48 kHz.
fn converter(rate: f64) -> Result<Option<Resampler>, String> {
    if (rate - f64::from(SAMPLE_RATE)).abs() < 0.5 { Ok(None) } else { Resampler::new(rate, f64::from(SAMPLE_RATE)).map(Some) }
}

/// The thread that reads the HAL's buffers into the recording and takes the device back when it goes.
struct Reader {
    shared: Arc<Shared>,
    input: usize,
    uid: String,
    name: String,
    chunks: std::sync::mpsc::SyncSender<Chunk>,
    received: Receiver<Chunk>,
    stopped: Arc<AtomicBool>,
}

impl Reader {
    fn run(self, unit: InputUnit, resampler: Option<Resampler>) {
        let mut open = Some((unit, resampler));
        let mut heard = Instant::now();
        // When the device may next be opened again, and how many times that has failed.
        let mut retry_at = Instant::now();
        let mut attempts = 0usize;
        let mut converted = Vec::new();
        while !self.stopped.load(Ordering::Acquire) {
            match self.received.recv_timeout(Duration::from_millis(250)) {
                Ok(chunk) => {
                    heard = Instant::now();
                    attempts = 0;
                    if !self.shared.wants_sound() {
                        continue;
                    }
                    converted.clear();
                    let samples = match open.as_mut().and_then(|(_, resampler)| resampler.as_mut()) {
                        Some(resampler) => match resampler.process(&chunk.samples, &mut converted) {
                            Ok(()) => &converted,
                            Err(why) => {
                                self.shared.lose_microphone(format!("microphone: {why}"));
                                continue;
                            }
                        },
                        None => &chunk.samples,
                    };
                    // Sound that cannot be read loses the microphone, not the recording.
                    if let Err(detail) = self.shared.sound(self.input, chunk.pts_ns, samples.len(), |frame, _| samples[frame]) {
                        self.shared.lose_microphone(format!("microphone: {detail}"));
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if heard.elapsed() < SILENT || Instant::now() < retry_at {
                continue;
            }
            // Silent for 2 s: the device left, or it stalled. Either way it is opened again by its UID once listed.
            if let Some((unit, _)) = open.take() {
                eprintln!("microphone: {} delivered nothing for {} s; reopening it when it is there", self.name, SILENT.as_secs());
                drop(unit);
            }
            let Some(device) = hal::device_for_uid(&self.uid) else {
                retry_at = Instant::now() + Duration::from_secs(1);
                continue;
            };
            match InputUnit::open(device, self.chunks.clone()).and_then(|unit| converter(unit.rate).map(|resampler| (unit, resampler))) {
                Ok(reopened) => {
                    eprintln!("microphone: {} opened again at {} Hz", self.name, reopened.0.rate);
                    open = Some(reopened);
                    heard = Instant::now();
                    retry_at = Instant::now();
                }
                Err(why) => {
                    let wait = BACKOFF[attempts.min(BACKOFF.len() - 1)];
                    attempts += 1;
                    eprintln!("microphone: {} could not be opened again ({why}); retrying in {} s", self.name, wait.as_secs());
                    retry_at = Instant::now() + wait;
                }
            }
        }
    }
}
