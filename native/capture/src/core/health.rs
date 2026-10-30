//! A recording's health, as main's governor of the versions prepared alongside it reads it (plan 100 step 4): pictures
//! handed over late, pictures the recording lost (a refresh capture skipped, filled with the picture before it, or one
//! the encoder dropped) and the pictures waiting in the encoder. Always kept, unlike the stage figures
//! (diagnostics.rs): a few atomics per picture. Read once a second, each read starting the next second's counts.
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub struct Health {
    late: AtomicU64,
    lost: AtomicU64,
    in_flight: AtomicU64,
    in_flight_high: AtomicU64,
}

/// One second of a recording's health.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HealthSample {
    /// Pictures handed over more than a frame's time after they were captured.
    pub late: u64,
    /// Pictures the recording lost: a refresh capture skipped, or one the encoder dropped.
    pub lost: u64,
    /// The most pictures in the encoder at once.
    pub backlog: u64,
}

impl Health {
    /// A picture handed over `behind_ns` after it was captured, at a frame interval of `interval_ns`.
    pub fn handed(&self, behind_ns: i64, interval_ns: u64) {
        if behind_ns > interval_ns as i64 {
            self.late.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn lost(&self) {
        self.lost.fetch_add(1, Ordering::Relaxed);
    }

    /// A picture handed to the encoder.
    pub fn submitted(&self) {
        let now = self.in_flight.fetch_add(1, Ordering::Relaxed) + 1;
        self.in_flight_high.fetch_max(now, Ordering::Relaxed);
    }

    /// The encoder handed a picture back, or dropped it (`dropped`, which the recording lost).
    pub fn returned(&self, dropped: bool) {
        let mut now = self.in_flight.load(Ordering::Relaxed);
        while let Err(seen) = self.in_flight.compare_exchange_weak(now, now.saturating_sub(1), Ordering::Relaxed, Ordering::Relaxed) {
            now = seen;
        }
        if dropped {
            self.lost();
        }
    }

    /// The counts since the last take; the backlog starts again from what is in the encoder now.
    pub fn take(&self) -> HealthSample {
        let now = self.in_flight.load(Ordering::Relaxed);
        HealthSample {
            late: self.late.swap(0, Ordering::Relaxed),
            lost: self.lost.swap(0, Ordering::Relaxed),
            backlog: self.in_flight_high.swap(now, Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_counts_late_and_lost_pictures_and_the_encoders_most() {
        let health = Health::default();
        let interval = 33_333_333;
        health.handed(5_000_000, interval);
        health.handed(40_000_000, interval);
        health.handed(-1_000_000, interval);
        health.submitted();
        health.submitted();
        health.returned(false);
        health.submitted();
        health.returned(true);
        assert_eq!(health.take(), HealthSample { late: 1, lost: 1, backlog: 2 });
        // The next second starts from the picture still in the encoder.
        assert_eq!(health.take(), HealthSample { late: 0, lost: 0, backlog: 1 });
        health.returned(false);
        health.returned(false);
        assert_eq!(health.take(), HealthSample { late: 0, lost: 0, backlog: 1 }, "never below none");
        assert_eq!(health.take(), HealthSample::default());
    }
}
