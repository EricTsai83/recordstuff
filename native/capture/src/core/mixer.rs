//! The recording's one audio track from several inputs (plan 076, step 4): system audio, chosen apps' audio and the
//! microphone (074). Each input is placed on the session clock by counting its samples (`AudioAligner`), and the
//! track holds their sum, stereo, at unity gain: nothing is resampled, collapsed or levelled.
//!
//! The track advances to where every input has delivered, so inputs that arrive at different delays still line up.
//! An input can also deliver nothing for a while: WASAPI's loopback sends no packets while nothing plays, and a
//! device can stall. The track therefore also advances with the clock, `latency` behind it, counting what an input has
//! not delivered by then as silence; sound of it that arrives later still is dropped and counted as late. With one
//! input the track is that input's samples exactly.

use std::collections::VecDeque;

use crate::timing::{AudioAligner, NANOS_PER_SECOND};

struct Input {
    aligner: AudioAligner,
    /// Interleaved stereo from track position `start` on, not yet mixed.
    pending: VecDeque<f32>,
    start: u64,
    /// Frames that arrived for a part of the track already mixed.
    late: u64,
}

impl Input {
    fn end(&self) -> u64 {
        self.start + (self.pending.len() / 2) as u64
    }

    fn put(&mut self, position: u64, left: f32, right: f32, cutoff: u64) {
        if position < self.start {
            self.late += 1;
        } else if position < cutoff {
            debug_assert_eq!(position, self.end());
            self.pending.push_back(left);
            self.pending.push_back(right);
        }
    }
}

pub struct Mixer {
    rate: u32,
    t0_ns: u64,
    latency_frames: u64,
    inputs: Vec<Input>,
    /// Frames of the track mixed so far.
    mixed: u64,
}

impl Mixer {
    /// `inputs` inputs for a track starting at host time `t0_ns`; see `AudioAligner` for `tolerance_frames`.
    pub fn new(rate: u32, t0_ns: u64, inputs: usize, tolerance_frames: u64, latency_frames: u64) -> Self {
        let input = || Input {
            aligner: AudioAligner::new(rate, t0_ns, tolerance_frames),
            pending: VecDeque::new(),
            start: 0,
            late: 0,
        };
        Self { rate, t0_ns, latency_frames, inputs: (0..inputs).map(|_| input()).collect(), mixed: 0 }
    }

    /// Places `frames` frames of `input`, captured at `pts_ns`; `sample(frame, channel)` reads one, channel 0 or 1.
    /// Nothing at or after track position `cutoff` is kept (the stop).
    pub fn add(&mut self, input: usize, pts_ns: u64, frames: usize, sample: impl Fn(usize, usize) -> f32, cutoff: u64) {
        let Some(input) = self.inputs.get_mut(input) else { return };
        let mut position = input.aligner.position();
        let placement = input.aligner.place(pts_ns, frames as u64);
        // Silence for a gap the clock already mixed past is no lost sound: skipped at once, not counted as late.
        let mixed_already = placement.silence.min(input.start.saturating_sub(position));
        position += mixed_already;
        for _ in mixed_already..placement.silence {
            input.put(position, 0.0, 0.0, cutoff);
            position += 1;
        }
        for frame in (placement.skip as usize).min(frames)..frames {
            input.put(position, sample(frame, 0), sample(frame, 1), cutoff);
            position += 1;
        }
    }

    /// The track position every input has delivered up to.
    pub fn ready(&self) -> u64 {
        self.inputs.iter().map(Input::end).min().unwrap_or(self.mixed).max(self.mixed)
    }

    /// The track position the clock allows at host time `now_ns`: `latency` behind it.
    pub fn clock_limit(&self, now_ns: u64) -> u64 {
        let since = now_ns.saturating_sub(self.t0_ns);
        let frames = u128::from(since) * u128::from(self.rate) / u128::from(NANOS_PER_SECOND);
        u64::try_from(frames).unwrap_or(u64::MAX).saturating_sub(self.latency_frames)
    }

    pub fn mixed(&self) -> u64 {
        self.mixed
    }

    /// The track position `input` has delivered up to, late frames included.
    #[cfg(test)]
    pub fn delivered(&self, input: usize) -> u64 {
        self.inputs.get(input).map_or(0, |input| input.aligner.position())
    }

    /// Frames each input delivered too late to be mixed.
    pub fn late(&self) -> Vec<u64> {
        self.inputs.iter().map(|input| input.late).collect()
    }

    /// Mixes the track up to `until` into `out` (interleaved stereo, replaced); what an input has not delivered is
    /// silence. Returns the frames mixed.
    pub fn mix(&mut self, until: u64, out: &mut Vec<f32>) -> u64 {
        out.clear();
        if until <= self.mixed {
            return 0;
        }
        let frames = until - self.mixed;
        out.reserve(frames as usize * 2);
        for position in self.mixed..until {
            for channel in 0..2 {
                // The first input that has this frame gives it as it is; the others are added.
                let mut value: Option<f32> = None;
                for input in &self.inputs {
                    if position >= input.start && position < input.end() {
                        let sample = input.pending[((position - input.start) * 2) as usize + channel];
                        value = Some(value.map_or(sample, |sum| sum + sample));
                    }
                }
                out.push(value.unwrap_or(0.0));
            }
        }
        // Every input's `start` is the track's mixed position: what it delivered from there on stays pending, and
        // anything it delivers for an earlier position from now on is late.
        for input in &mut self.inputs {
            let used = (until - input.start).min((input.pending.len() / 2) as u64);
            input.pending.drain(..(used * 2) as usize);
            input.start = until;
        }
        self.mixed = until;
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;
    const T0: u64 = 5 * NANOS_PER_SECOND;
    /// 10 ms and 500 ms.
    const TOLERANCE: u64 = 480;
    const LATENCY: u64 = 24_000;

    fn ns(frames: u64) -> u64 {
        T0 + frames * NANOS_PER_SECOND / u64::from(RATE)
    }

    fn mixer(inputs: usize) -> Mixer {
        Mixer::new(RATE, T0, inputs, TOLERANCE, LATENCY)
    }

    #[test]
    fn one_input_is_passed_through_exactly() {
        let mut mixer = mixer(1);
        let values = [0.25f32, -0.0, -0.5, 1.5];
        mixer.add(0, ns(0), 2, |frame, channel| values[frame * 2 + channel], u64::MAX);
        assert_eq!(mixer.ready(), 2);
        let mut out = Vec::new();
        assert_eq!(mixer.mix(mixer.ready(), &mut out), 2);
        assert_eq!(out.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), values.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
    }

    #[test]
    fn two_inputs_are_summed_where_both_delivered() {
        let mut mixer = mixer(2);
        mixer.add(0, ns(0), 4, |_, channel| if channel == 0 { 0.5 } else { 0.25 }, u64::MAX);
        // The microphone arrives later and only for frames 0 and 1 so far.
        assert_eq!(mixer.ready(), 0);
        mixer.add(1, ns(0), 2, |_, _| 0.125, u64::MAX);
        assert_eq!(mixer.ready(), 2);
        let mut out = Vec::new();
        mixer.mix(mixer.ready(), &mut out);
        assert_eq!(out, [0.625, 0.375, 0.625, 0.375]);
        mixer.add(1, ns(2), 2, |_, _| -0.5, u64::MAX);
        mixer.mix(mixer.ready(), &mut out);
        assert_eq!(out, [0.0, -0.25, 0.0, -0.25]);
    }

    #[test]
    fn an_input_placed_later_on_the_clock_lines_up_with_the_others() {
        let mut mixer = mixer(2);
        mixer.add(0, ns(0), 8, |_, _| 1.0, u64::MAX);
        // Its first buffer starts at frame 5: silence before it.
        mixer.add(1, ns(5), 3, |_, _| 2.0, u64::MAX);
        let mut out = Vec::new();
        mixer.mix(mixer.ready(), &mut out);
        let left: Vec<f32> = out.iter().step_by(2).copied().collect();
        assert_eq!(left, [1.0, 1.0, 1.0, 1.0, 1.0, 3.0, 3.0, 3.0]);
    }

    #[test]
    fn a_silent_input_holds_the_track_only_until_the_clock_passes_the_latency() {
        let mut mixer = mixer(2);
        mixer.add(0, ns(0), 48_000, |_, _| 0.5, u64::MAX);
        // The second input delivered nothing: the track waits for it...
        assert_eq!(mixer.ready(), 0);
        // ...until the clock is the latency past a position: then that much is mixed, the input as silence.
        let limit = mixer.clock_limit(ns(30_000));
        assert_eq!(limit, 6_000);
        let mut out = Vec::new();
        assert_eq!(mixer.mix(limit, &mut out), 6_000);
        assert!(out.iter().all(|&v| v == 0.5));
        // Its sound for the mixed part arrives late and is dropped; the rest is mixed in.
        mixer.add(1, ns(0), 8_000, |_, _| 0.25, u64::MAX);
        assert_eq!(mixer.late(), [0, 6_000]);
        assert_eq!(mixer.ready(), 8_000);
        mixer.mix(8_000, &mut out);
        assert!(out.iter().all(|&v| v == 0.75));
    }

    #[test]
    fn a_long_silence_the_clock_mixed_past_is_not_counted_late() {
        let mut mixer = mixer(1);
        mixer.add(0, ns(0), 480, |_, _| 0.5, u64::MAX);
        let mut out = Vec::new();
        // Nothing for two seconds (loopback while nothing plays): the clock mixes on.
        mixer.mix(mixer.clock_limit(ns(96_000)), &mut out);
        assert_eq!(mixer.mixed(), 72_000);
        // Sound resumes on time: the aligner's silence for the gap is behind the track, the sound itself is not.
        mixer.add(0, ns(96_000), 480, |_, _| 0.25, u64::MAX);
        assert_eq!(mixer.late(), [0]);
        assert_eq!(mixer.ready(), 96_480);
        mixer.mix(mixer.ready(), &mut out);
        let left: Vec<f32> = out.iter().step_by(2).copied().collect();
        assert!(left[..24_000].iter().all(|&v| v == 0.0));
        assert!(left[24_000..].iter().all(|&v| v == 0.25));
    }

    #[test]
    fn with_no_input_at_all_the_clock_fills_the_track_with_silence() {
        let mut mixer = mixer(1);
        let mut out = Vec::new();
        assert_eq!(mixer.mix(mixer.clock_limit(ns(48_000)), &mut out), 24_000);
        assert!(out.iter().all(|&v| v == 0.0));
        assert_eq!(mixer.delivered(0), 0);
    }

    #[test]
    fn nothing_at_or_after_the_cutoff_is_kept() {
        let mut mixer = mixer(1);
        mixer.add(0, ns(0), 10, |_, _| 1.0, 6);
        assert_eq!(mixer.ready(), 6);
        mixer.add(0, ns(10), 10, |_, _| 1.0, 6);
        assert_eq!(mixer.ready(), 6);
    }

    #[test]
    fn a_gap_in_one_input_is_silence_in_its_part_only() {
        let mut mixer = mixer(1);
        mixer.add(0, ns(0), 1_000, |_, _| 0.5, u64::MAX);
        // 100 ms with nothing, then more: the aligner fills the gap.
        mixer.add(0, ns(5_800), 1_000, |_, _| 0.5, u64::MAX);
        let mut out = Vec::new();
        assert_eq!(mixer.mix(mixer.ready(), &mut out), 6_800);
        let left: Vec<f32> = out.iter().step_by(2).copied().collect();
        assert!(left[..1_000].iter().all(|&v| v == 0.5));
        assert!(left[1_000..5_800].iter().all(|&v| v == 0.0));
        assert!(left[5_800..].iter().all(|&v| v == 0.5));
    }
}
