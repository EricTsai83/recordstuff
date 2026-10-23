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
//! A refresh at which the screen did not change comes as an idle frame without a picture; when it is a slot's, the
//! newest picture is encoded again at it (core `frame_unchanged`), as Chromium repeats one, instead of the slot taking
//! the next picture a refresh late (step 7, 2026-10-16: 1–2% of 30 fps frames 50 ms apart on a 60 Hz display, every
//! one at an idle refresh; capture itself never missed one).
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
    /// When the last kept frame was captured, and whether capture has delivered one since that was left out.
    last_ns: u64,
    left_out: bool,
}

impl Pacer {
    pub fn new(start_ns: u64, frame_rate: u32) -> Self {
        let interval_ns = NANOS_PER_SECOND / u64::from(frame_rate.max(1));
        Self { start_ns, interval_ns, next_ns: start_ns + interval_ns, last_ns: start_ns, left_out: false }
    }

    /// Whether the frame captured at `pts_ns` is encoded. A frame more than half an interval before the next slot is
    /// left out; one at or after that is kept for the slot nearest it, and the slot after that becomes the next.
    pub fn admit(&mut self, pts_ns: u64) -> bool {
        if pts_ns + self.interval_ns / 2 < self.next_ns {
            self.left_out = true;
            return false;
        }
        let since = pts_ns.saturating_sub(self.start_ns);
        let nearest = (since + self.interval_ns / 2) / self.interval_ns;
        self.next_ns = self.start_ns + (nearest + 1) * self.interval_ns;
        self.last_ns = pts_ns;
        self.left_out = false;
        true
    }

    /// The time of a refresh capture skipped, when the frame captured at `pts_ns` shows one: capture delivered a frame
    /// since the last kept one that was too soon to keep, and this one comes more than an interval and an eighth after
    /// it, so the refresh in between, the one to keep, never came. The newest picture is then encoded at that time, an
    /// interval after the last kept frame, as Chromium repeats one, before `admit` judges this frame. Takes the slot.
    ///
    /// Plan 078 step 1 (2026-10-17): ScreenCaptureKit skipped about one refresh in 180 (five in a 15 s take at 60 Hz,
    /// 33.3 ms between two deliveries); each one that was a slot's left a frame 50 ms after the last in the file, and
    /// the slot after it a frame 17 ms after that. Only after a frame left out: a source that delivers only when the
    /// screen changes (Windows) and changes more slowly than the frame rate is kept as it comes.
    pub fn skipped(&mut self, pts_ns: u64) -> Option<u64> {
        if !self.left_out || pts_ns < self.last_ns + self.interval_ns + self.interval_ns / 8 {
            return None;
        }
        let at = self.last_ns + self.interval_ns;
        self.admit(at);
        Some(at)
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

    /// Moves the next slot to the first one at or after `now_ns`, on the same grid, when it is behind: slots the
    /// recording left empty on purpose (a camera hidden over a still screen, plan 075) are not filled afterwards.
    pub fn skip_to(&mut self, now_ns: u64) {
        if self.next_ns >= now_ns {
            return;
        }
        let since = now_ns - self.start_ns;
        self.next_ns = self.start_ns + since.div_ceil(self.interval_ns) * self.interval_ns;
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

    /// The interval macOS asks capture for: `capture_interval_ns`, or the frame interval itself under plan 091's
    /// development switch (`RECORDSTUFF_CAPTURE_INTERVAL=frame`), which measures what the deliveries the pacer leaves
    /// out cost. Not a product setting: asking for the frame interval brings back the gaps described above.
    pub fn requested_interval_ns(frame_rate: u32, switch: Option<&str>) -> u64 {
        match switch {
            Some(FRAME_INTERVAL) => NANOS_PER_SECOND / u64::from(frame_rate.max(1)),
            _ => Self::capture_interval_ns(frame_rate),
        }
    }
}

/// Plan 091's development switch: `RECORDSTUFF_CAPTURE_INTERVAL=frame` in the app's environment. Off by default;
/// nothing ships that sets it.
pub const INTERVAL_ENV: &str = "RECORDSTUFF_CAPTURE_INTERVAL";
const FRAME_INTERVAL: &str = "frame";

#[cfg(test)]
mod tests {
    use super::*;

    /// Frames on a display refreshing at `hz`, starting `phase_ns` after the start, with alternating jitter.
    fn refreshes(hz: f64, phase_ns: f64, seconds: f64, jitter_ns: f64) -> Vec<u64> {
        let period = 1e9 / hz;
        (0..(seconds * hz) as usize).map(|n| (1e12 + phase_ns + n as f64 * period + if n % 2 == 0 { jitter_ns } else { -jitter_ns }) as u64).collect()
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

    #[test]
    fn the_development_switch_asks_for_the_frame_interval_only_when_named() {
        assert_eq!(Pacer::requested_interval_ns(30, Some("frame")), 33_333_333);
        assert_eq!(Pacer::requested_interval_ns(60, Some("frame")), 16_666_666);
        for other in [None, Some(""), Some("Frame"), Some("quarter")] {
            assert_eq!(Pacer::requested_interval_ns(30, other), Pacer::capture_interval_ns(30));
        }
    }
}
