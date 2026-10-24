//! When the preview thread makes its next frame (plan 092): at the rate the Recording Studio chose, waking only to
//! make one, and at once when the page starts watching or changes the rate or the view. Unwatched, the thread sleeps
//! until it is watched again or stopped, so a preview no one shows costs no wake-ups.

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::camera_layout::{PREVIEW_FPS, PreviewView, preview_rate};

#[derive(Debug)]
struct State {
    stopped: bool,
    watching: bool,
    fps: u32,
    view: PreviewView,
    /// A new watcher or view: the next frame comes at once, and as a key frame.
    key: bool,
    /// The page caught up after chunks were dropped (plan 084): the next frame, at its time, is a key frame.
    key_next: bool,
    /// A new rate: the next frame comes at once, and the schedule starts again from it.
    restart: bool,
}

/// What the preview thread does next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewStep {
    Stop,
    /// Make a frame now of `view`, a key frame when `key`; the next is due `interval` after it.
    Frame {
        key: bool,
        view: PreviewView,
        interval: Duration,
    },
}

/// The preview's controls, set from the session's calls and read by its thread.
#[derive(Debug)]
pub struct PreviewControl {
    state: Mutex<State>,
    changed: Condvar,
}

/// The interval of `fps` frames a second.
pub fn interval(fps: u32) -> Duration {
    Duration::from_nanos(1_000_000_000 / u64::from(fps.max(1)))
}

/// The next frame's time after one made at `made`, due at `due`: an interval after the due time, so the rate holds
/// however long a frame took, or an interval after `made` when the thread fell more than an interval behind.
pub fn next_due(due: Instant, made: Instant, interval: Duration) -> Instant {
    let next = due + interval;
    if next < made { made + interval } else { next }
}

impl PreviewControl {
    pub fn new(watching: bool) -> Self {
        Self {
            state: Mutex::new(State { stopped: false, watching, fps: PREVIEW_FPS, view: PreviewView::Composed, key: true, key_next: false, restart: false }),
            changed: Condvar::new(),
        }
    }

    fn change(&self, apply: impl FnOnce(&mut State)) {
        apply(&mut self.state.lock().unwrap());
        self.changed.notify_all();
    }

    /// Watched, or no longer: a new watcher has a new decoder, which can start only at a key frame.
    pub fn watch(&self, watching: bool) {
        self.change(|state| {
            state.watching = watching;
            state.key |= watching;
        });
    }

    /// The preview's frames a second; false for a rate the Studio does not offer, which changes nothing.
    pub fn set_rate(&self, fps: u32) -> bool {
        let Some(fps) = preview_rate(fps) else { return false };
        self.change(|state| {
            if state.fps != fps {
                state.fps = fps;
                state.restart = true;
            }
        });
        true
    }

    /// What the preview shows (D3), from a key frame made at once.
    pub fn set_view(&self, view: PreviewView) {
        self.change(|state| {
            if state.view != view {
                state.view = view;
                state.key = true;
            }
        });
    }

    /// A key frame at the next frame's time (plan 084): the page that fell behind draws again from it rather than from
    /// the encoder's next periodic one, up to a second later. Wakes nothing, so it adds no frame to the rate. False, and
    /// nothing asked, while unwatched: no frame is made then, and watching again starts at a key frame anyway.
    pub fn request_key(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        state.key_next |= state.watching;
        state.watching
    }

    pub fn view(&self) -> PreviewView {
        self.state.lock().unwrap().view
    }

    pub fn stop(&self) {
        self.change(|state| state.stopped = true);
    }

    /// Waits for the frame due at `due`, or for a change that brings one sooner, and says what to make.
    pub fn wait(&self, due: Instant) -> PreviewStep {
        let mut state = self.state.lock().unwrap();
        loop {
            if state.stopped {
                return PreviewStep::Stop;
            }
            if !state.watching {
                state = self.changed.wait(state).unwrap();
                continue;
            }
            let now = Instant::now();
            if state.key || state.restart || now >= due {
                let key = std::mem::take(&mut state.key) | std::mem::take(&mut state.key_next);
                state.restart = false;
                return PreviewStep::Frame { key, view: state.view, interval: interval(state.fps) };
            }
            state = self.changed.wait_timeout(state, due - now).unwrap().0;
        }
    }

    /// A frame owed as a key frame could not be made (no picture yet): the next one is still a key frame.
    pub fn owe_key(&self) {
        self.state.lock().unwrap().key = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const SOON: Duration = Duration::from_millis(500);

    fn frame(step: PreviewStep) -> (bool, PreviewView, Duration) {
        match step {
            PreviewStep::Frame { key, view, interval } => (key, view, interval),
            PreviewStep::Stop => panic!("stopped"),
        }
    }

    #[test]
    fn the_first_frame_comes_at_once_as_a_key_frame_and_the_next_at_the_rate() {
        let control = PreviewControl::new(true);
        let later = Instant::now() + Duration::from_secs(60);
        assert_eq!(frame(control.wait(later)), (true, PreviewView::Composed, interval(10)));
        let due = Instant::now() + Duration::from_millis(30);
        assert!(!frame(control.wait(due)).0);
        assert!(Instant::now() >= due, "waited for the frame's time");
    }

    #[test]
    fn a_rate_or_view_change_wakes_the_thread_at_once() {
        let control = Arc::new(PreviewControl::new(true));
        frame(control.wait(Instant::now()));
        let later = Instant::now() + Duration::from_secs(60);
        let changer = control.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            assert!(changer.set_rate(15));
        });
        let started = Instant::now();
        assert_eq!(frame(control.wait(later)), (false, PreviewView::Composed, interval(15)), "a new rate needs no key frame");
        assert!(started.elapsed() < SOON);
        t.join().unwrap();
        control.set_view(PreviewView::Screen);
        assert_eq!(frame(control.wait(later)), (true, PreviewView::Screen, interval(15)), "a new view starts at a key frame");
        // The same rate or view again changes nothing.
        assert!(control.set_rate(15));
        control.set_view(PreviewView::Screen);
        let due = Instant::now() + Duration::from_millis(30);
        assert!(!frame(control.wait(due)).0);
        assert!(Instant::now() >= due);
    }

    #[test]
    fn rates_the_studio_does_not_offer_are_refused() {
        let control = PreviewControl::new(true);
        for fps in [0, 1, 7, 30, 60] {
            assert!(!control.set_rate(fps), "{fps}");
        }
        for fps in [5, 10, 15] {
            assert!(control.set_rate(fps), "{fps}");
        }
    }

    #[test]
    fn unwatched_it_sleeps_until_watched_again_then_starts_at_a_key_frame() {
        let control = Arc::new(PreviewControl::new(false));
        let waiter = control.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let t = std::thread::spawn(move || {
            // Due long ago: unwatched, even an overdue frame is not made.
            tx.send(waiter.wait(Instant::now() - Duration::from_secs(1))).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err(), "no frame while unwatched");
        control.watch(true);
        assert!(frame(rx.recv_timeout(SOON).unwrap()).0);
        t.join().unwrap();
        control.watch(false);
        let waiter = control.clone();
        let t = std::thread::spawn(move || waiter.wait(Instant::now()));
        std::thread::sleep(Duration::from_millis(20));
        control.stop();
        assert_eq!(t.join().unwrap(), PreviewStep::Stop, "stopping wakes an unwatched thread");
    }

    #[test]
    fn a_key_frame_owed_stays_owed() {
        let control = PreviewControl::new(true);
        assert!(frame(control.wait(Instant::now())).0);
        control.owe_key();
        assert!(frame(control.wait(Instant::now() + Duration::from_secs(60))).0);
    }

    #[test]
    fn a_key_frame_requested_comes_at_the_next_frame_time_not_sooner() {
        let control = Arc::new(PreviewControl::new(true));
        assert!(frame(control.wait(Instant::now())).0);
        let due = Instant::now() + Duration::from_millis(30);
        assert!(control.request_key());
        assert!(frame(control.wait(due)).0, "the next frame is a key frame");
        assert!(Instant::now() >= due, "at its time: the request wakes nothing");
        assert!(!frame(control.wait(Instant::now())).0, "once");
        control.watch(false);
        assert!(!control.request_key(), "unwatched: nothing asked");
    }

    #[test]
    fn the_schedule_keeps_its_rate_and_catches_up_once_behind() {
        let start = Instant::now();
        let step = interval(5);
        assert_eq!(next_due(start, start + Duration::from_millis(20), step), start + step);
        let late = start + Duration::from_millis(450);
        assert_eq!(next_due(start, late, step), late + step, "more than an interval behind: no burst to catch up");
    }
}
