//! The microphone, mixed into the recording's track (074's input): CoreAudio's HAL (plan 078 step 6), an AUHAL input
//! unit on the chosen device or the system's default input, read as one channel at the device's rate, converted to
//! 48 kHz 32-bit float and heard in both of the track's (074, as Cap does: an audio interface's microphone on its first
//! input would otherwise be in the left ear only), and stamped with the host time of each buffer (`mHostTime`), the
//! clock the screen's samples use. Never voice processing: a plain HAL unit, not the voice-processing one.
//!
//! A microphone that cannot be opened refuses the recording with `microphone_unavailable` (074); one that stops while
//! recording is told after 2 s without sound (`Shared::microphone_clock`) and the recording goes on without it. This
//! module then takes it back. Every 250 ms it checks that the unit still records its device: when the device leaves,
//! the HAL moves the unit to another input rather than stopping it, and that input's sound would go on unnoticed
//! (`InputUnit::moved`), so the unit is closed at once, and the silence that follows tells the loss. A device that is
//! gone, or still there but silent for 2 s, is opened again by its UID as soon as the HAL lists it, retrying after 2 s
//! and backing off to 30 s, as Cap reconnects (cpal). The HAL follows devices in a process without a main run loop, which AVFoundation did
//! not (074's probe, hal.rs). The device taken back is always the one opened at the start, the default input's
//! included: a new default does not replace it (the maintainer's decision, 2026-10-17).
//!
//! The user may switch the device while recording (plan 079, D3): the new one is opened before the old is closed, and
//! is the one taken back from then on.
//!
//! The usage description and the hardened runtime's audio-input entitlement, which a signed RecordStuff needs before
//! macOS lets it open a microphone, are in electron-builder.yml and resources/entitlements.mac.plist; the
//! authorization is still read from AVFoundation, which answers it without a run loop.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

use super::CaptureError;
use super::hal::{self, Chunk, InputUnit, Resampler};
use super::session::Shared;
use crate::core::{Microphone, SAMPLE_RATE};

/// How long without sound before the device is checked and opened again.
const SILENT: Duration = Duration::from_secs(2);
/// How often the open unit is checked to still record its own device.
const CHECK: Duration = Duration::from_millis(250);
/// The waits between attempts to open it again, the last repeated.
const BACKOFF: [Duration; 5] = [Duration::from_secs(2), Duration::from_secs(4), Duration::from_secs(8), Duration::from_secs(16), Duration::from_secs(30)];
/// Buffers the HAL's thread may queue ahead of the reading thread: as many as its pool holds.
const QUEUE: usize = hal::POOL;

fn unavailable(detail: impl Into<String>) -> CaptureError {
    CaptureError::new("microphone_unavailable", format!("microphone: {}", detail.into()))
}

/// The audio input devices, the system's default marked.
pub fn list() -> Result<Vec<Microphone>, CaptureError> {
    let default = hal::default_input().map(|input| input.uid);
    Ok(hal::inputs().into_iter().map(|input| Microphone { default: default.as_deref() == Some(input.uid.as_str()), name: input.name, id: input.uid }).collect())
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
    /// A device the user switched to while recording (plan 079, D3): `Some(None)` is the system's default input.
    switch: Arc<Mutex<Option<Option<String>>>>,
    thread: Option<JoinHandle<()>>,
}

/// Recording or metering a microphone needs macOS's permission: denied or restricted is told with its guidance, and
/// never asked is refused too, since the HAL would deliver silence without a prompt and a narration would be lost
/// unnoticed. Main asks before recording (074) and shows the meter only once access is allowed (079).
pub fn allowed() -> Result<(), CaptureError> {
    let status = AVAuthorizationStatus(authorization()?);
    if status == AVAuthorizationStatus::Denied || status == AVAuthorizationStatus::Restricted {
        return Err(unavailable("access is not allowed (System Settings > Privacy & Security > Microphone)"));
    }
    if status == AVAuthorizationStatus::NotDetermined {
        return Err(unavailable("access is not allowed yet: macOS has not asked for it"));
    }
    Ok(())
}

/// The input a recording opens for `device`: the chosen one while it is connected, else the system's default input,
/// with a note saying so (074).
pub fn resolve(device: Option<&str>) -> Result<(hal::Input, Option<String>), CaptureError> {
    let chosen = device.and_then(|uid| hal::device_for_uid(uid).and_then(|id| hal::inputs().into_iter().find(|input| input.id == id)));
    let note = match (device, &chosen) {
        (Some(uid), None) => Some(format!("microphone: {uid} is not connected; the default input is used")),
        _ => None,
    };
    let opened = match chosen {
        Some(input) => input,
        None => hal::default_input().ok_or_else(|| unavailable("there is no audio input"))?,
    };
    Ok((opened, note))
}

impl MicrophoneCapture {
    /// Opens `device` (the system's default input when `None`) and hands its sound to `shared` as `input`.
    pub fn start(device: Option<&str>, shared: Arc<Shared>, input: usize) -> Result<Self, CaptureError> {
        allowed()?;
        let (opened, note) = resolve(device)?;
        let unit = Open::new(opened.id).map_err(|why| unavailable(format!("{} could not be opened: {why}", opened.name)))?;
        let stopped = Arc::new(AtomicBool::new(false));
        let switch = Arc::new(Mutex::new(None));
        let reader = Reader { shared, input, uid: opened.uid.clone(), name: opened.name.clone(), stopped: stopped.clone(), switch: switch.clone() };
        let thread = std::thread::Builder::new()
            .name("recordstuff-microphone".into())
            .spawn(move || reader.run(unit))
            .map_err(|e| unavailable(format!("its thread: {e}")))?;
        Ok(Self { note, name: opened.name, stopped, switch, thread: Some(thread) })
    }

    /// Records `device` from now on instead (plan 079, D3; `None` is the system's default input): it is opened before
    /// the one recording now is closed, and one that cannot be opened leaves that one recording. The outcome is told as
    /// `microphone_switched` or `microphone_switch_failed`.
    pub fn switch(&self, device: Option<String>) {
        *self.switch.lock().unwrap() = Some(device);
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

/// An open device: its unit, the converter to 48 kHz when it runs at another rate, and the queue of its buffers, its
/// own so a device closed or switched from cannot mix its sound with the next one's.
struct Open {
    unit: InputUnit,
    resampler: Option<Resampler>,
    received: Receiver<Chunk>,
}

impl Open {
    fn new(device: hal::ObjectId) -> Result<Self, String> {
        let (chunks, received) = sync_channel(QUEUE);
        let unit = InputUnit::open(device, chunks)?;
        let resampler = converter(unit.rate)?;
        Ok(Self { unit, resampler, received })
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
    stopped: Arc<AtomicBool>,
    switch: Arc<Mutex<Option<Option<String>>>>,
}

impl Reader {
    /// One buffer into the recording, converted to 48 kHz first when the device runs at another rate. Sound that
    /// cannot be converted or read loses the microphone, not the recording.
    fn take(&self, chunk: &Chunk, resampler: Option<&mut Resampler>, converted: &mut Vec<f32>) {
        let samples = match resampler {
            Some(resampler) => {
                converted.clear();
                if let Err(why) = resampler.process(&chunk.samples, converted) {
                    self.shared.lose_microphone(format!("microphone: {why}"));
                    return;
                }
                &converted[..]
            }
            None => &chunk.samples[..],
        };
        if let Err(detail) = self.shared.sound(self.input, chunk.pts_ns, samples.len(), |frame, _| samples[frame]) {
            self.shared.lose_microphone(format!("microphone: {detail}"));
        }
    }

    /// Takes a buffer and gives it back to its unit's pool.
    fn read(&self, chunk: Chunk, open: &mut Open, converted: &mut Vec<f32>) {
        if self.shared.reads_sound() {
            self.take(&chunk, open.resampler.as_mut(), converted);
        }
        // Back to the pool of the unit it came from, on every path (review of plan 078).
        let _ = open.unit.recycle.try_send(chunk.samples);
    }

    /// The device the user switched to (plan 079, D3), opened before the one recording now is closed: the sound the
    /// old one queued goes into the recording first, and the new one's from then on, its first buffers overlapping
    /// the old one's last dropped by the aligner and a gap between them left as silence. One that is not connected or
    /// does not open leaves the old one recording. From then on it is the device taken back after a loss.
    fn switch_to(&mut self, device: Option<String>, open: &mut Option<Open>, converted: &mut Vec<f32>) -> bool {
        let events = self.shared.events();
        let wanted = match device.as_deref() {
            Some(uid) => hal::device_for_uid(uid).and_then(|id| hal::inputs().into_iter().find(|input| input.id == id)),
            None => hal::default_input(),
        };
        let Some(input) = wanted else {
            let what = device.map_or_else(|| "there is no default input".to_string(), |uid| format!("{uid} is not connected"));
            events.microphone_switch_failed(format!("microphone: {what}; {} goes on being recorded", self.name));
            return false;
        };
        // The device recorded already (System default and that device by name are one): answered all the same, so the
        // one waiting to ask next is not held back (review of plan 079).
        if input.uid == self.uid {
            eprintln!("microphone: {} is already the one recorded", self.name);
            events.microphone_switched(self.name.clone(), self.name.clone());
            return false;
        }
        let new = match Open::new(input.id) {
            Ok(new) => new,
            Err(why) => {
                events.microphone_switch_failed(format!("microphone: {} could not be opened ({why}); {} goes on being recorded", input.name, self.name));
                return false;
            }
        };
        if let Some(mut old) = open.take() {
            while let Ok(chunk) = old.received.try_recv() {
                self.read(chunk, &mut old, converted);
            }
        }
        *open = Some(new);
        self.uid = input.uid;
        let from = std::mem::replace(&mut self.name, input.name.clone());
        self.shared.microphone_switched();
        eprintln!("microphone: switched from {from} to {} at {} Hz", self.name, open.as_ref().map_or(0.0, |open| open.unit.rate));
        events.microphone_switched(from, input.name);
        true
    }

    fn run(mut self, first: Open) {
        let mut open = Some(first);
        let mut heard = Instant::now();
        // When the device may next be opened again, and how many times that has failed.
        let mut retry_at = Instant::now();
        let mut attempts = 0usize;
        let mut converted = Vec::new();
        let mut checked = Instant::now();
        while !self.stopped.load(Ordering::Acquire) {
            let request = self.switch.lock().unwrap().take();
            if let Some(device) = request
                && self.switch_to(device, &mut open, &mut converted)
            {
                heard = Instant::now();
                retry_at = Instant::now();
                attempts = 0;
            }
            let received = match open.as_ref() {
                Some(open) => open.received.recv_timeout(Duration::from_millis(250)),
                None => {
                    std::thread::sleep(Duration::from_millis(100));
                    Err(RecvTimeoutError::Timeout)
                }
            };
            // Disconnected cannot happen while the unit, which holds the sender, is open; it waits as a timeout does.
            if let (Ok(chunk), Some(unit)) = (received, open.as_mut()) {
                heard = Instant::now();
                attempts = 0;
                self.read(chunk, unit, &mut converted);
            }
            if checked.elapsed() >= CHECK {
                checked = Instant::now();
                if let Some(why) = open.as_ref().and_then(|open| open.unit.moved()) {
                    eprintln!("microphone: {} stopped being recorded ({why}); reopening it when it is there", self.name);
                    // What it queued may be the other input's sound: let it go with its queue.
                    open = None;
                    // Opened again as soon as the HAL lists it, without first waiting out the silence.
                    heard = Instant::now().checked_sub(SILENT).unwrap_or(heard);
                }
            }
            if heard.elapsed() < SILENT || Instant::now() < retry_at {
                continue;
            }
            // Silent for 2 s: the device left, or it stalled. Either way it is opened again by its UID once listed.
            if open.take().is_some() {
                eprintln!("microphone: {} delivered nothing for {} s; reopening it when it is there", self.name, SILENT.as_secs());
            }
            let Some(device) = hal::device_for_uid(&self.uid) else {
                retry_at = Instant::now() + Duration::from_secs(1);
                continue;
            };
            match Open::new(device) {
                Ok(reopened) => {
                    eprintln!("microphone: {} opened again at {} Hz", self.name, reopened.unit.rate);
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
