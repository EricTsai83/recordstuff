//! The camera's frames between the platform's capture and the compositor (plan 075, step 5; D12, D16), on every
//! platform: the newest frame only (the latest wins, so a camera slower or faster than the recording never queues
//! frames), stamped on the host clock the screen's frames use, and whether the camera is still delivering.
//!
//! A camera delivers frames all the time; one that has delivered nothing for `CAMERA_SILENT_NS` while recording is
//! told lost (unplugged, stalled, or its access withdrawn), as 074's microphone is, and from then on the compositor
//! is given no frame, so the recording shows the screen alone rather than the last picture frozen. The platform also
//! tells a loss at once when it sees the device go (`lose`). The first frame delivered after a loss tells its return,
//! and the camera is composed again.

use std::sync::Mutex;

use super::Events;
use crate::timing::NANOS_PER_SECOND;

/// 2 s without a frame while recording is a loss (D12, as the microphone's `MICROPHONE_SILENT_NS`).
pub const CAMERA_SILENT_NS: u64 = 2 * NANOS_PER_SECOND;

struct State<F> {
    latest: Option<(F, u64)>,
    /// Host time a frame last arrived; 0 before the first.
    heard_ns: u64,
    lost: bool,
    delivered: u64,
    losses: u64,
}

/// The camera's newest frame and whether it is delivering. `F` is the platform's frame (a CVPixelBuffer on macOS).
pub struct CameraFeed<F> {
    state: Mutex<State<F>>,
}

impl<F: Clone> Default for CameraFeed<F> {
    fn default() -> Self {
        Self { state: Mutex::new(State { latest: None, heard_ns: 0, lost: false, delivered: 0, losses: 0 }) }
    }
}

impl<F: Clone> CameraFeed<F> {
    /// A frame captured at `pts_ns`, arriving at `now_ns`: it replaces the one before. Tells the camera's return when
    /// it was lost.
    pub fn deliver(&self, frame: F, pts_ns: u64, now_ns: u64, events: &dyn Events) {
        let mut state = self.state.lock().unwrap();
        let gap = now_ns.saturating_sub(state.heard_ns);
        state.latest = Some((frame, pts_ns));
        state.heard_ns = now_ns;
        state.delivered += 1;
        if state.lost {
            state.lost = false;
            // Told under the lock, so a loss and a return are told in the order they happened.
            events.camera_resumed(format!("the camera delivered frames again after {:.1} s", gap as f64 / NANOS_PER_SECOND as f64));
        }
    }

    /// The newest frame and when it was captured, while the camera delivers; nothing while it is lost or before its
    /// first frame.
    pub fn latest(&self) -> Option<(F, u64)> {
        let state = self.state.lock().unwrap();
        if state.lost { None } else { state.latest.clone() }
    }

    /// Tells the loss once the camera has delivered nothing for `CAMERA_SILENT_NS` while `recording` (from `since_ns`,
    /// the recording's start, if it delivered nothing before it).
    pub fn judge(&self, now_ns: u64, since_ns: u64, recording: bool, events: &dyn Events) {
        let mut state = self.state.lock().unwrap();
        let heard = state.heard_ns.max(since_ns);
        if !recording || state.lost || now_ns.saturating_sub(heard) <= CAMERA_SILENT_NS {
            return;
        }
        Self::mark_lost(&mut state, events, format!("the camera delivered no frame for {} s", CAMERA_SILENT_NS / NANOS_PER_SECOND));
    }

    /// The platform saw the device go: told at once while `recording`, without waiting for the silence. Before the
    /// recording the next frame or the start decides.
    pub fn lose(&self, detail: String, recording: bool, events: &dyn Events) {
        let mut state = self.state.lock().unwrap();
        if state.lost {
            return;
        }
        if recording {
            Self::mark_lost(&mut state, events, detail);
        } else {
            state.latest = None;
        }
    }

    fn mark_lost(state: &mut State<F>, events: &dyn Events, detail: String) {
        state.lost = true;
        state.losses += 1;
        events.camera_lost(detail);
    }

    pub fn is_lost(&self) -> bool {
        self.state.lock().unwrap().lost
    }

    /// Frames delivered and losses told, for the log.
    pub fn counts(&self) -> (u64, u64) {
        let state = self.state.lock().unwrap();
        (state.delivered, state.losses)
    }

    /// Forgets the frame, so nothing composes it once the camera is closed.
    pub fn clear(&self) {
        self.state.lock().unwrap().latest = None;
    }
}

/// What the core asks of the platform's camera: to judge it on the refresh thread's clock and to close it, which turns
/// its light off. The core closes it when capture ends (`Core::halted`), when a prepared session is released and when
/// the core is dropped, so every way a session ends closes the camera.
pub trait CameraControl: Send + Sync {
    /// Called on the refresh thread about every 100 ms while recording.
    fn judge(&self, now_ns: u64, since_ns: u64, events: &dyn Events);
    /// Idempotent.
    fn close(&self);
}
