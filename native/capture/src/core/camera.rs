//! The camera's frames between the platform's capture and the compositor (plan 075, step 5; D12, D16), on every
//! platform: the newest frame only (the latest wins, so a camera slower or faster than the recording never queues
//! frames), stamped on the host clock the screen's frames use, and whether the camera is still delivering.
//!
//! A camera delivers frames all the time once it has started; one that has delivered nothing for `CAMERA_SILENT_NS`
//! while recording is told lost (unplugged, stalled, or its access withdrawn), as 074's microphone is, and from then on
//! the compositor is given no frame, so the recording shows the screen alone rather than the last picture frozen. The
//! platform also tells a loss at once when it sees the device go (`lose`). The first frame delivered after a loss tells
//! its return, and the camera is composed again.
//!
//! Its first frame can take longer (plan 090: an iPhone's Continuity Camera took up to 3.1 s after the Recording
//! Studio let it go), so until then the recording starts without waiting and shows the screen alone, and the camera has
//! `CAMERA_FIRST_FRAME_NS` from its opening, not 2 s from the recording's start; one that delivers nothing in that time
//! is told not ready, never lost, and treated as lost from then on (its platform opens it again).

use std::sync::Mutex;

use super::Events;
use crate::timing::NANOS_PER_SECOND;

/// 2 s without a frame while recording is a loss (D12, as the microphone's `MICROPHONE_SILENT_NS`).
pub const CAMERA_SILENT_NS: u64 = 2 * NANOS_PER_SECOND;
/// How long a camera has for its first frame from its opening before a recording tells it not ready (plan 090, D1):
/// three times the slowest first frame its baseline measured.
pub const CAMERA_FIRST_FRAME_NS: u64 = 10 * NANOS_PER_SECOND;

struct State<F> {
    latest: Option<(F, u64)>,
    /// Host time a frame last arrived; 0 before the first.
    heard_ns: u64,
    /// The recording's start, as `judge` was last told it; 0 before the recording.
    since_ns: u64,
    /// Host time the platform began opening the camera, and the first frame's arrival; 0 before either (plan 090).
    opened_ns: u64,
    first_ns: u64,
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
        Self { state: Mutex::new(State { latest: None, heard_ns: 0, since_ns: 0, opened_ns: 0, first_ns: 0, lost: false, delivered: 0, losses: 0 }) }
    }
}

impl<F: Clone> CameraFeed<F> {
    /// A frame captured at `pts_ns`, arriving at `now_ns`: it replaces the one before. Tells the camera's return when
    /// it was lost, with the silence measured as `judge` measures it: from the recording's start if the camera
    /// delivered nothing before it (plan 093).
    pub fn deliver(&self, frame: F, pts_ns: u64, now_ns: u64, events: &dyn Events) {
        let mut state = self.state.lock().unwrap();
        let first = state.first_ns == 0;
        let gap = now_ns.saturating_sub(state.heard_ns.max(state.since_ns));
        let opened_for = now_ns.saturating_sub(if state.opened_ns != 0 { state.opened_ns } else { state.since_ns });
        state.latest = Some((frame, pts_ns));
        state.heard_ns = now_ns;
        if state.first_ns == 0 {
            state.first_ns = now_ns;
        }
        state.delivered += 1;
        if state.lost {
            state.lost = false;
            // Told under the lock, so a loss and a return are told in the order they happened.
            let seconds = |ns: u64| ns as f64 / NANOS_PER_SECOND as f64;
            events.camera_resumed(if first {
                format!("the camera delivered its first frame {:.1} s after it was opened", seconds(opened_for))
            } else {
                format!("the camera delivered frames again after {:.1} s", seconds(gap))
            });
        }
    }

    /// The newest frame and when it was captured, while the camera delivers; nothing while it is lost or before its
    /// first frame.
    pub fn latest(&self) -> Option<(F, u64)> {
        let state = self.state.lock().unwrap();
        if state.lost { None } else { state.latest.clone() }
    }

    /// While `recording`, tells the loss once the camera has delivered nothing for `CAMERA_SILENT_NS` since its last
    /// frame or the recording's start (`since_ns`), whichever is later; before its first frame, tells it not ready
    /// once `CAMERA_FIRST_FRAME_NS` have passed since its opening (the recording's start if no opening was told).
    pub fn judge(&self, now_ns: u64, since_ns: u64, recording: bool, events: &dyn Events) {
        let mut state = self.state.lock().unwrap();
        if recording {
            state.since_ns = since_ns;
        }
        if !recording || state.lost {
            return;
        }
        if state.first_ns == 0 {
            let opened = if state.opened_ns != 0 { state.opened_ns } else { since_ns };
            if now_ns.saturating_sub(opened) > CAMERA_FIRST_FRAME_NS {
                state.lost = true;
                events.camera_not_ready(format!("the camera delivered no frame in the {} s after it was opened", CAMERA_FIRST_FRAME_NS / NANOS_PER_SECOND));
            }
            return;
        }
        if now_ns.saturating_sub(state.heard_ns.max(since_ns)) <= CAMERA_SILENT_NS {
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

    /// The platform began opening the camera at `now_ns`; only the first opening counts, not one after a loss.
    pub fn opened(&self, now_ns: u64) {
        let mut state = self.state.lock().unwrap();
        if state.opened_ns == 0 {
            state.opened_ns = now_ns;
        }
    }

    /// When the first frame came, for the log (plan 090): after the camera's opening and, once recording, from the
    /// recording's start (negative when it came before).
    pub fn first_frame(&self) -> String {
        let state = self.state.lock().unwrap();
        let seconds = |ns: i128| ns as f64 / NANOS_PER_SECOND as f64;
        if state.first_ns == 0 {
            return if state.lost && state.losses == 0 {
                format!("no frame in the {} s after opening", CAMERA_FIRST_FRAME_NS / NANOS_PER_SECOND)
            } else {
                "no frame yet".into()
            };
        }
        let mut note = format!("first frame {:.2} s after opening", seconds(state.first_ns as i128 - state.opened_ns as i128));
        if state.since_ns != 0 {
            note.push_str(&format!(", {:+.2} s from the recording's start", seconds(state.first_ns as i128 - state.since_ns as i128)));
        }
        note
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

/// How far the camera's picture is from the frames it is composed into (plan 075, step 8): each composed frame's host
/// time less the capture time of the camera frame in it. Positive when the camera's picture is older than its frame,
/// negative when it was captured after the screen's. On Windows the camera's frames are stamped when they arrive, so
/// the time the camera and Media Foundation hold a picture is not counted there.
#[derive(Default)]
pub struct CameraAges(Mutex<Ages>);

#[derive(Default)]
struct Ages {
    count: u64,
    sum_ns: i128,
    min_ns: i64,
    max_ns: i64,
}

impl CameraAges {
    /// A frame at `frame_ns` composed with the camera frame captured at `camera_ns`.
    pub fn record(&self, frame_ns: u64, camera_ns: u64) {
        let age = frame_ns as i64 - camera_ns as i64;
        let mut ages = self.0.lock().unwrap();
        if ages.count == 0 {
            (ages.min_ns, ages.max_ns) = (age, age);
        }
        ages.count += 1;
        ages.sum_ns += age as i128;
        ages.min_ns = ages.min_ns.min(age);
        ages.max_ns = ages.max_ns.max(age);
    }

    /// For the log, in milliseconds; nothing before a frame was composed with the camera.
    pub fn summary(&self) -> Option<String> {
        let ages = self.0.lock().unwrap();
        let ms = |ns: f64| ns / 1e6;
        (ages.count > 0).then(|| {
            format!(
                "the camera's picture {:.1} ms older than its frame on average ({:.1} to {:.1} ms) in {} frame(s)",
                ms(ages.sum_ns as f64 / ages.count as f64),
                ms(ages.min_ns as f64),
                ms(ages.max_ns as f64),
                ages.count
            )
        })
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
