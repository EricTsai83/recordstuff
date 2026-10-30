//! What main asks of an export while it runs: stop it (`cancel`), and, for a version prepared ahead of a drag (plan 100
//! step 4), hold it at its next picture (`pause`) and keep the encoder to one picture at a time while a recording runs
//! (`careful`). An export checks at every picture, so a pause takes effect within one and costs nothing: the export
//! resumes where it stopped. A cancel always wins over a pause.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use super::remux::ExportError;

/// How often a paused export looks at its cancel again, besides being woken.
const PAUSED_WAKE: Duration = Duration::from_millis(100);

#[derive(Default)]
pub struct Control {
    cancelled: AtomicBool,
    paused: Mutex<bool>,
    changed: Condvar,
    careful: AtomicBool,
}

impl Control {
    /// A control already cancelled, or not.
    pub fn new(cancelled: bool) -> Self {
        Self { cancelled: AtomicBool::new(cancelled), ..Self::default() }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        let _paused = self.paused.lock().unwrap();
        self.changed.notify_all();
    }

    /// A new export starts: no longer cancelled. A pause stays, since it is the process's, not the export's.
    pub fn reset(&self) {
        self.cancelled.store(false, Ordering::Release);
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn pause(&self, on: bool) {
        *self.paused.lock().unwrap() = on;
        self.changed.notify_all();
    }

    pub fn paused(&self) -> bool {
        *self.paused.lock().unwrap()
    }

    pub fn set_careful(&self, on: bool) {
        self.careful.store(on, Ordering::Release);
    }

    pub fn careful(&self) -> bool {
        self.careful.load(Ordering::Acquire)
    }

    /// Between pictures (or samples): waits while paused, then fails with `cancelled` once cancelled. `what` names the
    /// work in the error ("export", "copy").
    pub fn checkpoint(&self, what: &str) -> Result<(), ExportError> {
        let mut paused = self.paused.lock().unwrap();
        while *paused && !self.cancelled() {
            paused = self.changed.wait_timeout(paused, PAUSED_WAKE).unwrap().0;
        }
        drop(paused);
        if self.cancelled() {
            return Err(ExportError::new("cancelled", format!("the {what} was cancelled")));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::time::Instant;

    #[test]
    fn a_checkpoint_passes_unless_cancelled() {
        assert!(Control::new(false).checkpoint("export").is_ok());
        let error = Control::new(true).checkpoint("copy").unwrap_err();
        assert_eq!((error.code, error.detail.as_str()), ("cancelled", "the copy was cancelled"));
    }

    #[test]
    fn a_paused_checkpoint_waits_until_resumed() {
        let control = Arc::new(Control::new(false));
        control.pause(true);
        let started = Arc::new(Barrier::new(2));
        let waiting = {
            let control = control.clone();
            let started = started.clone();
            std::thread::spawn(move || {
                let began = Instant::now();
                started.wait();
                control.checkpoint("export").map(|()| began.elapsed())
            })
        };
        // The worker must start its clock before the caller measures the pause. On a busy runner it may not be
        // scheduled until after the caller's sleep; that says nothing about how checkpoint waits.
        started.wait();
        std::thread::sleep(Duration::from_millis(150));
        assert!(!waiting.is_finished(), "held while paused");
        control.pause(false);
        assert!(waiting.join().unwrap().unwrap() >= Duration::from_millis(150));
    }

    #[test]
    fn a_cancel_ends_a_pause_and_a_new_export_keeps_the_pause() {
        let control = Arc::new(Control::new(false));
        control.pause(true);
        let waiting = {
            let control = control.clone();
            std::thread::spawn(move || control.checkpoint("export"))
        };
        std::thread::sleep(Duration::from_millis(50));
        control.cancel();
        assert_eq!(waiting.join().unwrap().unwrap_err().code, "cancelled");
        control.reset();
        assert!(!control.cancelled());
        assert!(control.paused(), "the pause is the process's, not the export's");
    }

    #[test]
    fn careful_is_kept_until_changed() {
        let control = Control::new(false);
        assert!(!control.careful());
        control.set_careful(true);
        assert!(control.careful());
    }
}
