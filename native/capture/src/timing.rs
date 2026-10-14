//! One clock per recording (plan 076, step 4): every timestamp is host time in nanoseconds (mach absolute time on
//! macOS, QueryPerformanceCounter on Windows), and the recording starts at `t0`, the moment `record` arrived.
//!
//! Video samples keep their capture times. Audio is placed by counting samples, not by trusting each buffer's time:
//! a buffer continues where the last one ended as long as its timestamp agrees within a tolerance. When the timestamp
//! runs ahead (the device delivered nothing for a while) the gap is filled with silence; when it falls behind (the
//! audio clock ran fast, or a buffer overlapped) the extra samples are dropped. Audio therefore cannot drift against
//! video by more than the tolerance however long the recording lasts.

pub const NANOS_PER_SECOND: u64 = 1_000_000_000;

/// Ticks of `timescale` per second from `ns` nanoseconds after the start, rounded down.
pub fn ticks(ns: u64, timescale: u32) -> u64 {
    (u128::from(ns) * u128::from(timescale) / u128::from(NANOS_PER_SECOND)) as u64
}

/// Where one captured buffer goes in the audio track.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    /// Frames of silence to write before the buffer.
    pub silence: u64,
    /// Frames to drop from the start of the buffer; all of it when this equals its length.
    pub skip: u64,
}

pub struct AudioAligner {
    rate: u32,
    /// Host time of input frame 0.
    origin_ns: u64,
    /// The next frame to write.
    next: u64,
    tolerance: u64,
    placed_any: bool,
}

impl AudioAligner {
    /// `origin_ns` is the host time the first written frame stands for; `tolerance_frames` how far a buffer's time
    /// may disagree with the count before it is corrected.
    pub fn new(rate: u32, origin_ns: u64, tolerance_frames: u64) -> Self {
        Self { rate, origin_ns, next: 0, tolerance: tolerance_frames, placed_any: false }
    }

    /// Frames written so far, silence included.
    pub fn position(&self) -> u64 {
        self.next
    }

    /// Places a buffer of `frames` frames captured at `pts_ns`. The first buffer is placed exactly, so the track
    /// starts in step with the video; later ones only when they disagree by more than the tolerance.
    pub fn place(&mut self, pts_ns: u64, frames: u64) -> Placement {
        let offset = i128::from(pts_ns) - i128::from(self.origin_ns);
        // Rounded to the nearest frame: timestamps are whole nanoseconds, frames are not.
        let nanos = i128::from(NANOS_PER_SECOND);
        let expected = (offset * i128::from(self.rate) + nanos / 2).div_euclid(nanos);
        let difference = expected - i128::from(self.next);
        let tolerance = if self.placed_any { i128::from(self.tolerance) } else { 0 };
        let placement = if difference > tolerance {
            Placement { silence: difference as u64, skip: 0 }
        } else if difference < -tolerance {
            Placement { silence: 0, skip: ((-difference) as u64).min(frames) }
        } else {
            Placement { silence: 0, skip: 0 }
        };
        let kept = frames - placement.skip;
        // A buffer dropped whole leaves nothing written: the first placement is still to come.
        if kept > 0 || placement.silence > 0 {
            self.placed_any = true;
        }
        self.next += placement.silence + kept;
        placement
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;
    /// 10 ms at 48 kHz.
    const TOLERANCE: u64 = 480;

    fn ns(frames: u64) -> u64 {
        frames * NANOS_PER_SECOND / u64::from(RATE)
    }

    #[test]
    fn buffers_that_follow_each_other_are_written_back_to_back() {
        let mut aligner = AudioAligner::new(RATE, 1_000, TOLERANCE);
        for n in 0..100u64 {
            // After the first, timestamps jitter by up to 2 ms, well inside the tolerance.
            let jitter = if n % 2 == 1 { 2_000_000 } else { 0 };
            assert_eq!(aligner.place(1_000 + ns(n * 1024) + jitter, 1024), Placement { silence: 0, skip: 0 }, "buffer {n}");
        }
        assert_eq!(aligner.position(), 102_400);
    }

    #[test]
    fn a_first_buffer_before_the_start_loses_what_precedes_it() {
        let origin = 5 * NANOS_PER_SECOND;
        let mut aligner = AudioAligner::new(RATE, origin, TOLERANCE);
        assert_eq!(aligner.place(origin - ns(100), 1024), Placement { silence: 0, skip: 100 });
        assert_eq!(aligner.position(), 924);
    }

    #[test]
    fn a_first_buffer_after_the_start_is_preceded_by_silence() {
        let origin = 5 * NANOS_PER_SECOND;
        let mut aligner = AudioAligner::new(RATE, origin, TOLERANCE);
        assert_eq!(aligner.place(origin + ns(30), 1024), Placement { silence: 30, skip: 0 });
    }

    #[test]
    fn a_buffer_entirely_before_the_start_is_dropped_and_the_next_one_placed_exactly() {
        let origin = 5 * NANOS_PER_SECOND;
        let mut aligner = AudioAligner::new(RATE, origin, TOLERANCE);
        assert_eq!(aligner.place(origin - ns(2048), 1024), Placement { silence: 0, skip: 1024 });
        assert_eq!(aligner.place(origin + ns(5), 1024), Placement { silence: 5, skip: 0 });
    }

    #[test]
    fn a_gap_is_filled_with_silence() {
        let mut aligner = AudioAligner::new(RATE, 0, TOLERANCE);
        aligner.place(0, 1024);
        // The device delivered nothing for 100 ms.
        assert_eq!(aligner.place(ns(1024 + 4800), 1024), Placement { silence: 4800, skip: 0 });
        assert_eq!(aligner.position(), 1024 + 4800 + 1024);
    }

    #[test]
    fn a_slow_audio_clock_cannot_drift_past_the_tolerance() {
        // The audio device runs 100 ppm slow: each buffer of 1024 frames really spans 1024.1 frames of host time.
        let mut aligner = AudioAligner::new(RATE, 0, TOLERANCE);
        let mut written_silence = 0;
        for n in 0..30_000u64 {
            let host = (n as f64 * 1024.0 * 1.0001 / f64::from(RATE) * 1e9) as u64;
            let placement = aligner.place(host, 1024);
            written_silence += placement.silence;
            let expected = (host as u128 * u128::from(RATE) / u128::from(NANOS_PER_SECOND)) as i64;
            let drift = expected - (aligner.position() - 1024) as i64;
            assert!(drift.unsigned_abs() <= TOLERANCE + 1, "buffer {n} drifted {drift} frames");
        }
        // Ten minutes at 100 ppm is 60 ms: corrected by silence a few frames over the tolerance at a time.
        assert!(written_silence > 2_400 && written_silence < 3_500, "{written_silence}");
    }

    #[test]
    fn a_fast_audio_clock_drops_samples_instead() {
        let mut aligner = AudioAligner::new(RATE, 0, TOLERANCE);
        let mut skipped = 0;
        for n in 0..30_000u64 {
            let host = (n as f64 * 1024.0 * 0.9999 / f64::from(RATE) * 1e9) as u64;
            skipped += aligner.place(host, 1024).skip;
        }
        assert!(skipped > 2_400 && skipped < 3_500, "{skipped}");
    }

    #[test]
    fn ticks_round_down_without_overflow() {
        assert_eq!(ticks(NANOS_PER_SECOND, 90_000), 90_000);
        assert_eq!(ticks(33_333_333, 90_000), 2_999);
        assert_eq!(ticks(u64::MAX / 2, 90_000), 830_103_483_316_929);
    }
}
