//! Which captured frames to encode (plan 076 step 2 optimisation). ScreenCaptureKit hands over frames on the
//! display's refresh, so asking it for a minimum interval near the frame rate's lands each frame two or three
//! refreshes after the last one, and the recording skips a frame now and then (30 fps on a 60 Hz display: 33 or 50 ms
//! apart). Capture is asked for four times the frame rate instead, and the frame nearest each slot of a grid anchored
//! at the recording's start is kept, as OBS's frame-rate divisor and Cap's pacing do: a 60 Hz display then gives 30
//! fps exactly, each kept frame two refreshes after the last. Not twice: a minimum interval equal to the refresh
//! period made ScreenCaptureKit drop the refreshes that came a little early (measured 2026-10-14: 1.8% of 30 fps
//! frames 50 ms apart at twice the rate, against 0.06% at 60 fps, whose interval was half the refresh period). Asking
//! for every refresh by name (no minimum interval) was no better (step 4, 2026-10-15: 0.17% dropped at 30 and at 60
//! fps against 0.06% and 0.11% with a quarter, for about the same processor time).
//!
//! Frames keep ScreenCaptureKit's display time, about 11 ms ahead of their arrival. Stamping them on arrival moved the
//! flash-to-beep offset from -7 and -15 ms to +5 and +3 ms but dropped 1.4% and 16% of the frames: arrival jitters with
//! the callback's scheduling, and the grid keeps the wrong ones (step 4, 2026-10-15).

use crate::timing::NANOS_PER_SECOND;

#[derive(Debug)]
pub struct Pacer {
    start_ns: u64,
    interval_ns: u64,
    /// The next slot's time; the frame at `start_ns` is the first, encoded by `record`.
    next_ns: u64,
}

impl Pacer {
    pub fn new(start_ns: u64, frame_rate: u32) -> Self {
        let interval_ns = NANOS_PER_SECOND / u64::from(frame_rate.max(1));
        Self { start_ns, interval_ns, next_ns: start_ns + interval_ns }
    }

    /// Whether the frame captured at `pts_ns` is encoded. A frame more than half an interval before the next slot is
    /// left out; one at or after that is kept for the slot nearest it, and the slot after that becomes the next.
    pub fn admit(&mut self, pts_ns: u64) -> bool {
        if pts_ns + self.interval_ns / 2 < self.next_ns {
            return false;
        }
        let since = pts_ns.saturating_sub(self.start_ns);
        let nearest = (since + self.interval_ns / 2) / self.interval_ns;
        self.next_ns = self.start_ns + (nearest + 1) * self.interval_ns;
        true
    }

    /// The slot a frame left out by `admit` is encoded at, once `now_ns` has reached it: a still screen sends no later
    /// frame, so the newest one is encoded then. Never a time after `now_ns`, so a change captured later is still newer.
    /// Takes the slot.
    pub fn due(&mut self, now_ns: u64) -> Option<u64> {
        if now_ns < self.next_ns {
            return None;
        }
        let slot = self.next_ns;
        self.admit(slot);
        Some(slot)
    }

    /// The next slot's time.
    pub fn next_slot(&self) -> u64 {
        self.next_ns
    }

    /// The minimum interval asked of capture: a quarter of the frame interval, well below any display's refresh
    /// period at these rates, so capture delivers every refresh and every slot has a frame near it.
    pub fn capture_interval_ns(frame_rate: u32) -> u64 {
        NANOS_PER_SECOND / (4 * u64::from(frame_rate.max(1)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frames on a display refreshing at `hz`, starting `phase_ns` after the start, with alternating jitter.
    fn refreshes(hz: f64, phase_ns: f64, seconds: f64, jitter_ns: f64) -> Vec<u64> {
        let period = 1e9 / hz;
        (0..(seconds * hz) as usize)
            .map(|n| (1e12 + phase_ns + n as f64 * period + if n % 2 == 0 { jitter_ns } else { -jitter_ns }) as u64)
            .collect()
    }

    fn kept_gaps(frames: &[u64], frame_rate: u32) -> (usize, u64) {
        let start = 1_000_000_000_000u64;
        let mut pacer = Pacer::new(start, frame_rate);
        let kept: Vec<u64> = std::iter::once(start).chain(frames.iter().copied().filter(|&pts| pacer.admit(pts))).collect();
        // The first frame is the one `record` encodes at the start; the first captured one follows within one and a
        // half intervals, and from there the cadence is the grid's.
        let interval = 1_000_000_000 / u64::from(frame_rate);
        assert!(kept[1] - kept[0] <= interval * 3 / 2 + 1_000_000, "first gap {}", kept[1] - kept[0]);
        let max_gap = kept[1..].windows(2).map(|w| w[1] - w[0]).max().unwrap();
        (kept.len(), max_gap)
    }

    #[test]
    fn thirty_fps_from_a_60_hz_display_keeps_every_other_refresh() {
        for phase in [0.0, 3e6, 8e6, 12e6, 16e6] {
            let (count, max_gap) = kept_gaps(&refreshes(60.0, phase, 10.0, 300_000.0), 30);
            assert!((300..=301).contains(&count), "phase {phase}: {count} frames");
            assert!(max_gap < 34_500_000, "phase {phase}: gap {max_gap}");
        }
    }

    #[test]
    fn sixty_fps_keeps_every_refresh_of_a_60_hz_display() {
        let (count, max_gap) = kept_gaps(&refreshes(60.0, 5e6, 10.0, 300_000.0), 60);
        assert!((600..=601).contains(&count), "{count} frames");
        assert!(max_gap < 17_500_000, "gap {max_gap}");
    }

    #[test]
    fn a_120_hz_display_gives_the_frame_rate_too() {
        for rate in [30, 60] {
            let (count, _) = kept_gaps(&refreshes(120.0, 2e6, 10.0, 200_000.0), rate);
            let expected = rate as usize * 10;
            assert!((expected..=expected + 1).contains(&count), "{rate} fps: {count} frames");
        }
    }

    #[test]
    fn after_a_still_screen_the_next_change_is_kept_and_the_grid_continues() {
        let start = 1_000_000_000_000u64;
        let mut pacer = Pacer::new(start, 30);
        // Nothing changed for two seconds, then a frame lands between slots.
        let late = start + 2_000_000_000 + 10_000_000;
        assert!(pacer.admit(late));
        // The next slot is the grid's, not a full interval after the late frame.
        assert!(!pacer.admit(late + 5_000_000));
        assert!(pacer.admit(start + 2_033_333_333 + 16_000_000));
    }

    #[test]
    fn a_frame_left_out_is_due_at_its_slot() {
        let start = 1_000_000_000_000u64;
        let mut pacer = Pacer::new(start, 30);
        // A change 10 ms in is too early for the slot at 33.3 ms, and then the screen stays still.
        assert!(!pacer.admit(start + 10_000_000));
        assert_eq!(pacer.next_slot(), start + 33_333_333);
        // Not before the slot itself.
        assert_eq!(pacer.due(start + 30_000_000), None);
        assert_eq!(pacer.due(start + 34_000_000), Some(start + 33_333_333));
        // The slot is taken: the next frame is for the one after.
        assert!(!pacer.admit(start + 40_000_000));
        assert!(pacer.admit(start + 55_000_000));
    }

    #[test]
    fn capture_is_asked_for_four_times_the_frame_rate() {
        // Below a 60 Hz refresh period (16.7 ms) at 30 fps, and below a 120 Hz one (8.3 ms) at 60 fps.
        assert_eq!(Pacer::capture_interval_ns(30), 8_333_333);
        assert_eq!(Pacer::capture_interval_ns(60), 4_166_666);
    }
}
