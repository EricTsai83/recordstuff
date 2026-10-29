//! Plan 096's C3: an offline echo canceller of our own, written because C1 and C2 (WebRTC AEC3) changed a voice with no
//! echo to remove and suppressed it during double-talk (step 3, 2026-10-29). Offline, the whole take is available:
//!
//! 1. **Where the speakers were silent, the microphone is returned bit for bit**: no sample is touched unless the
//!    system track had sound within the echo's reach (its delay plus 300 ms).
//! 2. **The echo is subtracted, never just turned down, while someone talks.** A partitioned frequency-domain adaptive
//!    filter (overlap-save, 512-sample blocks, 24 partitions: 256 ms of room after the bulk delay) learns the path
//!    from the system track to the microphone. Its step follows Valin's leakage estimate (2007), so it slows itself
//!    when the error is not echo, as during double-talk. The take is run twice and the second pass kept: the filter
//!    starts converged.
//! 3. **Residual echo is suppressed only where no near end is heard.** A frame whose error is well above the residual
//!    expected from the filter's own estimate is the near end talking; knowing the whole take, such frames are widened
//!    a little before (onsets) and well after (hangover), and in them the gain is 1.
//!
//! Its state is bounded and does not grow with the take (`STATE_BYTES`); this bench holds the take in memory, the
//! app's integration would stream it.

use rustfft::num_complex::Complex32 as C;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

const B: usize = 512;
const N: usize = 1024;
const BINS: usize = N / 2 + 1;
const PARTITIONS: usize = 24;
const RATE: f32 = 48_000.0;
/// How long after the system track's last sound echo may still reach the microphone (beyond the bulk delay).
const TAIL: usize = (0.3 * RATE) as usize;
/// The bulk delay is searched up to 500 ms.
const MAX_DELAY: usize = (0.5 * RATE) as usize;

/// The canceller's own state in bytes for a stereo reference: per channel the filter's and the history's spectra, plus
/// the per-bin power and suppression estimates. The FFT plans add a few kilobytes. Streaming the take (as the app would),
/// three passes keep only this, the flags (a byte per 10.7 ms block: 337 KB an hour) and the blocks in flight; this
/// bench holds whole takes instead.
pub const STATE_BYTES: usize = 2 * 2 * PARTITIONS * BINS * 8 + 6 * BINS * 4;

struct Ffts {
    forward: Arc<dyn Fft<f32>>,
    inverse: Arc<dyn Fft<f32>>,
}

impl Ffts {
    fn new() -> Self {
        let mut planner = FftPlanner::new();
        Self {
            forward: planner.plan_fft_forward(N),
            inverse: planner.plan_fft_inverse(N),
        }
    }
    fn forward(&self, time: &[f32]) -> Vec<C> {
        let mut buffer: Vec<C> = time.iter().map(|&v| C::new(v, 0.0)).collect();
        buffer.resize(N, C::new(0.0, 0.0));
        self.forward.process(&mut buffer);
        buffer
    }
    fn inverse(&self, spectrum: &[C]) -> Vec<f32> {
        let mut buffer = spectrum.to_vec();
        self.inverse.process(&mut buffer);
        buffer.iter().map(|v| v.re / N as f32).collect()
    }
}

/// The bulk delay from the system track to the microphone, by phase-transform cross-correlation over at most 30 s from
/// where the system track first has sound (wherever in the take that is), less 2 ms so the filter sees the direct
/// sound. The peak is taken by magnitude: an echo path may invert polarity. `None` without system sound.
pub fn estimate_delay(mic: &[f32], reference: &[f32]) -> Option<usize> {
    let length = mic.len().min(reference.len());
    let start = reference[..length].iter().position(|v| v.abs() > 1e-4)?;
    let span = (length - start).min((30.0 * RATE) as usize);
    let (reference, mic) = (
        &reference[start..start + span],
        &mic[start..(start + span + MAX_DELAY).min(mic.len())],
    );
    let energy: f32 = reference.iter().map(|v| v * v).sum();
    if energy < 1e-6 {
        return None;
    }
    let size = (span + MAX_DELAY).next_power_of_two();
    let mut planner = FftPlanner::<f32>::new();
    let (forward, inverse) = (
        planner.plan_fft_forward(size),
        planner.plan_fft_inverse(size),
    );
    let mut x: Vec<C> = reference.iter().map(|&v| C::new(v, 0.0)).collect();
    let mut m: Vec<C> = mic.iter().map(|&v| C::new(v, 0.0)).collect();
    x.resize(size, C::new(0.0, 0.0));
    m.resize(size, C::new(0.0, 0.0));
    forward.process(&mut x);
    forward.process(&mut m);
    // A softened phase transform (β = 0.7) over 150 Hz–8 kHz: full whitening weighs every bin alike, and bins a
    // microphone gates (the BenQ's, 2026-10-29) or a speaker cannot play then put a stray peak above the true one once
    // the peak is read by magnitude.
    let (low, high) = (
        (150.0 * size as f32 / RATE) as usize,
        (8000.0 * size as f32 / RATE) as usize,
    );
    let mut cross: Vec<C> = x
        .iter()
        .zip(&m)
        .enumerate()
        .map(|(k, (a, b))| {
            let bin = k.min(size - k);
            if bin < low || bin > high {
                return C::new(0.0, 0.0);
            }
            let product = a.conj() * b;
            product / (product.norm().powf(0.7) + 1e-12)
        })
        .collect();
    inverse.process(&mut cross);
    let best = (0..MAX_DELAY.min(size))
        .max_by(|&a, &b| cross[a].re.abs().total_cmp(&cross[b].re.abs()))?;
    Some(best.saturating_sub((0.002 * RATE) as usize))
}

/// The adaptive filter: overlap-save, one filter per channel of the system track (left and right speakers reach the
/// microphone by different paths, which one filter on their sum cannot model once the channels differ), normalized by
/// the reference's power per bin across channels and partitions, and adapted only in the blocks `adapt` allows (the far
/// end playing and, after the first pass, no near end heard). Spectra keep the non-negative bins only (real signals).
/// Its weights carry over between passes.
struct Linear {
    ffts: Ffts,
    /// `weights[channel][partition][bin]`, and the reference's last spectra in the same shape.
    weights: Vec<Vec<Vec<C>>>,
    history: Vec<Vec<Vec<C>>>,
    /// Per bin: the history's total power, kept as blocks enter and leave it, and its smoothed value.
    total: Vec<f32>,
    power: Vec<f32>,
    block: usize,
}

/// The step: a fifth of the normalized optimum. 0.5 sat at the edge of stability on speech and music (2026-10-29: 0.9
/// diverged, 0.5 reached 8–20 dB, 0.2 39 dB on speech and 21 dB on stereo music, the echo alone).
const STEP: f32 = 0.2;
/// Each later partition learns at this fraction of the one before (0.8 per 10.7 ms): a room's echo weakens with time,
/// and a quasi-periodic far end (voiced speech) otherwise spreads weight over late, false delays that ring once it
/// stops (2026-10-29: the error rose 15 dB after the far end paused; 0.9 left some, 0.8 none).
const SHAPE: f32 = 0.8;
/// Partitions kept linear (not circular) convolutions each block, in turn: all 24 every 6 blocks.
const CONSTRAIN: usize = 4;

impl Ffts {
    /// The non-negative bins of a real block's spectrum.
    fn forward_half(&self, time: &[f32]) -> Vec<C> {
        let mut full = self.forward(time);
        full.truncate(BINS);
        full
    }
    /// The real block from its non-negative bins.
    fn inverse_half(&self, half: &[C]) -> Vec<f32> {
        let mut full = vec![C::new(0.0, 0.0); N];
        full[..BINS].copy_from_slice(half);
        for k in 1..N / 2 {
            full[N - k] = half[k].conj();
        }
        self.inverse(&full)
    }
}

impl Linear {
    fn new(channels: usize) -> Self {
        Self {
            ffts: Ffts::new(),
            weights: vec![vec![vec![C::new(0.0, 0.0); BINS]; PARTITIONS]; channels],
            history: vec![vec![vec![C::new(0.0, 0.0); BINS]; PARTITIONS]; channels],
            total: vec![0.0; BINS],
            power: vec![0.0; BINS],
            block: 0,
        }
    }

    /// One pass over the take: the error (microphone less the estimated echo) and the estimate.
    fn run(
        &mut self,
        mic: &[f32],
        reference: &[Vec<f32>],
        adapt: &dyn Fn(usize) -> bool,
    ) -> (Vec<f32>, Vec<f32>) {
        self.history
            .iter_mut()
            .flatten()
            .for_each(|x| x.fill(C::new(0.0, 0.0)));
        self.total.fill(0.0);
        let blocks = mic.len().div_ceil(B);
        let mut error = vec![0.0f32; blocks * B];
        let mut estimate = vec![0.0f32; blocks * B];
        let mut previous = vec![vec![0.0f32; B]; reference.len()];
        let take = |source: &[f32], b: usize| -> Vec<f32> {
            let mut out = vec![0.0f32; B];
            let start = (b * B).min(source.len());
            let end = ((b + 1) * B).min(source.len());
            out[..end - start].copy_from_slice(&source[start..end]);
            out
        };
        for b in 0..blocks {
            let m_block = take(mic, b);
            let mut far = 0.0f32;
            for (c, channel) in reference.iter().enumerate() {
                let x_block = take(channel, b);
                far += x_block.iter().map(|v| v * v).sum::<f32>();
                let mut frame = std::mem::replace(&mut previous[c], x_block.clone());
                frame.extend_from_slice(&x_block);
                let spectrum = self.ffts.forward_half(&frame);
                let history = &mut self.history[c];
                for k in 0..BINS {
                    self.total[k] += spectrum[k].norm_sqr() - history[PARTITIONS - 1][k].norm_sqr();
                }
                history.rotate_right(1);
                history[0] = spectrum;
            }
            let mut sum = vec![C::new(0.0, 0.0); BINS];
            for (weights, history) in self.weights.iter().zip(&self.history) {
                for (w, x) in weights.iter().zip(history) {
                    for k in 0..BINS {
                        sum[k] += w[k] * x[k];
                    }
                }
            }
            let y_block: Vec<f32> = self.ffts.inverse_half(&sum)[B..].to_vec();
            let e_block: Vec<f32> = m_block.iter().zip(&y_block).map(|(m, y)| m - y).collect();
            error[b * B..(b + 1) * B].copy_from_slice(&e_block);
            estimate[b * B..(b + 1) * B].copy_from_slice(&y_block);
            for k in 0..BINS {
                self.power[k] = 0.85 * self.power[k] + 0.15 * self.total[k].max(0.0);
            }
            // A microphone not yet delivering (exact zeros) says nothing about the room: learning there would pull the
            // filter towards silence.
            let silent_mic = m_block.iter().all(|&v| v == 0.0);
            if far / ((B * reference.len()) as f32) < 1e-9 || silent_mic || !adapt(b) {
                continue;
            }
            let mut padded = vec![0.0f32; B];
            padded.extend_from_slice(&e_block);
            let e_spectrum = self.ffts.forward_half(&padded);
            // Regularized by a hundredth of the mean power: a bin the reference barely reaches (speech above 11 kHz)
            // would otherwise take a huge step on whatever the microphone holds there, and the constraint spreads it.
            let floor = 0.01 * self.power.iter().sum::<f32>() / BINS as f32 + 1e-10;
            let steps: Vec<C> = (0..BINS)
                .map(|k| e_spectrum[k] * (STEP / (self.power[k] + floor)))
                .collect();
            for (weights, history) in self.weights.iter_mut().zip(&self.history) {
                for (p, (w, x)) in weights.iter_mut().zip(history).enumerate() {
                    let scale = SHAPE.powi(p as i32);
                    for k in 0..BINS {
                        w[k] += x[k].conj() * steps[k] * scale;
                    }
                }
            }
            for i in 0..CONSTRAIN {
                let p = (self.block * CONSTRAIN + i) % PARTITIONS;
                for weights in &mut self.weights {
                    let mut time = self.ffts.inverse_half(&weights[p]);
                    time[B..].iter_mut().for_each(|v| *v = 0.0);
                    weights[p] = self.ffts.forward_half(&time);
                }
            }
            self.block += 1;
        }
        error.truncate(mic.len());
        estimate.truncate(mic.len());
        (error, estimate)
    }
}

/// Per block of the linear stage's output: whether the near end is heard, and the leak (the share of the estimate's
/// power left as residual echo, the median over blocks with echo and no near end). The near end is error well above
/// the residual the leak predicts and not coherent with the estimate: an echo path that changed (a volume step) leaves
/// an error that follows the estimate, a voice does not.
fn near_end(
    error: &[f32],
    estimate: &[f32],
    reference: &[Vec<f32>],
    previous: Option<&[bool]>,
) -> (Vec<bool>, f32) {
    let blocks = error.len().div_ceil(B);
    let stats: Vec<(f32, f32, f32, f32)> = (0..blocks)
        .map(|b| {
            let range = b * B..((b + 1) * B).min(error.len());
            let (mut ee, mut yy, mut ey, mut xx) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
            for i in range {
                ee += error[i] * error[i];
                yy += estimate[i] * estimate[i];
                ey += error[i] * estimate[i];
                xx += reference
                    .iter()
                    .map(|c| c.get(i).map_or(0.0, |v| v * v))
                    .sum::<f32>();
            }
            (ee, yy, ey, xx)
        })
        .collect();
    let mut quiet: Vec<f32> = stats.iter().map(|s| s.0).filter(|&e| e > 0.0).collect();
    quiet.sort_by(f32::total_cmp);
    let floor = quiet
        .get(quiet.len() / 10)
        .copied()
        .unwrap_or(0.0)
        .max(1e-12);
    // With a previous pass's flags, the ratios of blocks it heard no near end in, at their 75th percentile (the residual
    // fluctuates widely, and its typical high is what a near end must stand above); without, below the middle of all,
    // where blocks with the near end talking do not reach.
    let mut ratios: Vec<f32> = stats
        .iter()
        .enumerate()
        .filter(|(b, s)| {
            s.3 > 1e-6
                && s.1 > 10.0 * floor
                && !previous.is_some_and(|p| p.get(*b).copied().unwrap_or(false))
        })
        .map(|(_, s)| s.0 / s.1)
        .collect();
    ratios.sort_by(f32::total_cmp);
    let rank = if previous.is_some() {
        ratios.len() * 3 / 4
    } else {
        ratios.len() * 2 / 5
    };
    let leak = ratios.get(rank).copied().unwrap_or(0.1).clamp(1e-4, 1.0);
    let mut envelope = 0.0f32;
    let near: Vec<bool> = stats
        .iter()
        .map(|&(ee, yy, ey, _)| {
            envelope = yy.max(DECAY * envelope);
            let coherence = ey * ey / (ee * yy).max(1e-30);
            ee > 8.0 * leak * envelope + 4.0 * floor && coherence < 0.5
        })
        .collect();
    // Offline, a whole run is seen: a voice's syllable lasts tens of milliseconds, while a speaker's distortion at a
    // peak of the far end flags a block or two. Runs shorter than `MIN_RUN` blocks are dropped.
    let mut kept = near.clone();
    let mut start = 0;
    while start < near.len() {
        if !near[start] {
            start += 1;
            continue;
        }
        let end = (start..near.len())
            .find(|&i| !near[i])
            .unwrap_or(near.len());
        if end - start < MIN_RUN {
            kept[start..end].iter_mut().for_each(|v| *v = false);
        }
        start = end;
    }
    (kept, leak)
}

/// The shortest run of blocks (10.7 ms each) read as a near end: about 21 ms (4 dropped real short syllables).
const MIN_RUN: usize = 2;

/// `flags` widened: a few blocks before each flagged one (onsets) and about 270 ms after (hangover).
fn widen(flags: &[bool], before: usize, after: usize) -> Vec<bool> {
    let mut out = vec![false; flags.len()];
    for (t, &flag) in flags.iter().enumerate() {
        if flag {
            out[t.saturating_sub(before)..(t + after + 1).min(flags.len())]
                .iter_mut()
                .for_each(|v| *v = true);
        }
    }
    out
}

/// The residual expected after the estimate falls decays as a room's reverberation does, taken slow: 60 dB in 0.8 s,
/// per 512-sample block or frame (about 0.8 dB). A faster decay read a room's tail after the far end paused as a voice.
const DECAY: f32 = 0.83;
/// A bin's smoothed power below this is digital silence, not a room (-100 dBFS noise reads about 1e-7 here).
const DIGITAL_SILENCE: f32 = 1e-14;
/// How fast the noise floor may rise per frame (10.7 ms): about 3 dB a second, so a floor taken low at a quiet moment
/// reaches the room's level within seconds (2026-10-29's 1.002 never did, and suppression gated the room by 40 dB).
const NOISE_RISE: f32 = 1.0074;
/// Frames (10.7 ms) on each side of a voice where suppression is limited to `BESIDE_FLOOR`: about 530 ms.
const BESIDE: usize = 50;
const BESIDE_FLOOR: f32 = 0.126;
/// Frames (10.7 ms) a voice keeps suppression off after it was last heard: 160 ms.
const HANGOVER: usize = 15;

/// Suppresses residual echo where no near end is heard, in a sqrt-Hann STFT (1024, hop 512) that reconstructs the
/// error exactly where the gain is 1.
fn suppress(
    error: &[f32],
    estimate: &[f32],
    mic: &[f32],
    reference: &[f32],
    leak: f32,
    voiced_blocks: &[bool],
) -> Vec<f32> {
    let ffts = Ffts::new();
    let window: Vec<f32> = (0..N)
        .map(|i| (std::f32::consts::PI * i as f32 / N as f32).sin())
        .collect();
    let pad = N - B;
    let frames = (error.len() + pad).div_ceil(B) + 1;
    let padded = |source: &[f32]| -> Vec<f32> {
        let mut out = vec![0.0f32; pad];
        out.extend_from_slice(source);
        out.resize(frames * B + N, 0.0);
        out
    };
    let (e, y, m, x) = (
        padded(error),
        padded(estimate),
        padded(mic),
        padded(reference),
    );
    let analyse = |source: &[f32], t: usize| -> Vec<C> {
        let frame: Vec<f32> = (0..N).map(|i| source[t * B + i] * window[i]).collect();
        ffts.forward(&frame)
    };
    let first = (125.0 * N as f32 / RATE) as usize;
    let last = (8000.0 * N as f32 / RATE) as usize;
    // Per frame: the residual expected (the leak of the estimate, decaying as a room does), which says whether echo
    // can be there at all, and the error's noise floor, which suppression stops at.
    let mut residual = vec![0.0f32; BINS];
    // The room's noise per bin: the error's power smoothed over about 70 ms (one frame's power scatters by 10–20 dB,
    // and its minimum reads a floor that far too low), from the first frame down at once to any quieter level, up by
    // about 3 dB a second.
    let mut noise = vec![f32::INFINITY; BINS];
    let mut smoothed = vec![0.0f32; BINS];
    let mut echo = vec![false; frames];
    // Whether the far end played within a room's reach of each frame: echo is possible there even where the filter
    // predicts none (a frequency it never heard before, as a new tone).
    let mut reach = 0.0f32;
    let mut gains_of: Vec<Vec<f32>> = Vec::with_capacity(frames);
    for t in 0..frames {
        let es = analyse(&e, t);
        let ys = analyse(&y, t);
        // Gated on the microphone, not the error: where the microphone is digitally silent the error is only the
        // estimate's echo, no measure of the room.
        let audible = (0..N).any(|i| m[t * B + i] != 0.0);
        let (mut expected, mut floor) = (0.0f32, 0.0f32);
        let mut gains = vec![1.0f32; BINS];
        for k in 0..BINS {
            let ee = es[k].norm_sqr();
            residual[k] = (2.0 * leak * ys[k].norm_sqr()).max(DECAY * residual[k]);
            smoothed[k] = if t == 0 {
                ee
            } else {
                0.85 * smoothed[k] + 0.15 * ee
            };
            // Digital silence (a track before its input delivered) is no measure of the room: it leaves the floor as it
            // was, so the first real noise seeds it.
            if audible && smoothed[k] > DIGITAL_SILENCE {
                noise[k] = if smoothed[k] < noise[k] {
                    smoothed[k]
                } else {
                    noise[k] * NOISE_RISE
                };
            }
            if (first..=last).contains(&k) {
                expected += residual[k];
                floor += noise[k];
            }
            // With no near end, what is left is residual echo and the room: it is brought down to the room's own noise
            // (not below, so the noise does not pump; at most 40 dB).
            gains[k] = (noise[k] / (ee + 1e-12)).clamp(0.01 * 0.01, 1.0).sqrt();
        }
        let far: f32 = (0..N).map(|i| x[t * B + i] * x[t * B + i]).sum();
        reach = far.max(DECAY * reach);
        echo[t] = expected > 0.1 * floor || reach > 1e-9;
        gains_of.push(gains);
    }
    // A frame is voiced when the linear stage heard the near end in the block under its centre (its test also asks
    // that the error not follow the estimate, which a room's tail beyond the filter does; a test on the error's level
    // alone read such tails as a voice), widened offline: 3 frames before (onsets) and `HANGOVER` after.
    let flags: Vec<bool> = (0..frames)
        .map(|t| {
            voiced_blocks
                .get((t * B + N / 2).saturating_sub(pad) / B)
                .copied()
                .unwrap_or(false)
        })
        .collect();
    let voiced = widen(&flags, 3, HANGOVER);
    // Near a voice, a frame judged without one may still hold a soft syllable the test missed: there it is taken down
    // by at most 9 dB, never to the room's noise, so a miss quietens a word rather than cuts it (P5: some residual
    // echo beside a voice is accepted; a cut voice is not).
    let beside = widen(&flags, BESIDE, BESIDE);
    let mut out = vec![0.0f32; frames * B + N];
    let mut previous = vec![1.0f32; BINS];
    for t in 0..frames {
        let mut spectrum = analyse(&e, t);
        let microphone = analyse(&m, t);
        let gains: Vec<f32> = if voiced[t] || !echo[t] {
            vec![1.0; BINS]
        } else {
            // Gains fall at once and rise at most 6 dB a frame, so suppression does not flutter.
            let floor = if beside[t] { BESIDE_FLOOR.sqrt() } else { 0.0 };
            gains_of[t]
                .iter()
                .zip(&previous)
                .map(|(g, p)| g.min(p * 2.0).max(floor))
                .collect()
        };
        for k in 0..BINS {
            spectrum[k] *= gains[k];
            // Removing echo never adds sound: no bin leaves louder than the microphone had it (a filter's
            // misadjusted tail still "predicts" a reverberation after the far end stops).
            let (out, limit) = (spectrum[k].norm(), microphone[k].norm());
            if out > limit {
                spectrum[k] *= limit / out;
            }
            if k > 0 && k < N / 2 {
                spectrum[N - k] = spectrum[k].conj();
            }
        }
        previous = gains;
        let time = ffts.inverse(&spectrum);
        for i in 0..N {
            out[t * B + i] += time[i] * window[i];
        }
    }
    out[pad..pad + error.len()].to_vec()
}

/// C3 on a take: the microphone with the echo of `reference` (the system track's channels, on the same clock) removed.
pub fn process(mic: &[f32], reference: &[Vec<f32>]) -> Vec<f32> {
    let length = reference.iter().map(Vec::len).min().unwrap_or(0);
    // The delay from the loudest channel: a sum can cancel (one channel the other inverted) while both speakers play.
    let loudest = reference.iter().max_by(|a, b| {
        a.iter()
            .map(|v| v * v)
            .sum::<f32>()
            .total_cmp(&b.iter().map(|v| v * v).sum::<f32>())
    });
    let Some(delay) = loudest.and_then(|channel| estimate_delay(mic, channel)) else {
        return mic.to_vec();
    };
    let delayed: Vec<Vec<f32>> = reference
        .iter()
        .map(|channel| {
            (0..mic.len())
                .map(|i| {
                    if i >= delay {
                        channel.get(i - delay).copied().unwrap_or(0.0)
                    } else {
                        0.0
                    }
                })
                .collect()
        })
        .collect();
    // Pass 1 learns everywhere the far end plays; its output says where the near end talks. Pass 2 learns only where
    // it does not and says it again, from a filter no longer pulled by the voice; pass 3 starts converged, learns where
    // pass 2 heard no near end, and its output is kept.
    let mut linear = Linear::new(reference.len());
    let (error, estimate) = linear.run(mic, &delayed, &|_| true);
    let (near, _) = near_end(&error, &estimate, &delayed, None);
    let frozen = widen(&near, 2, 25);
    let (error, estimate) =
        linear.run(mic, &delayed, &|b| !frozen.get(b).copied().unwrap_or(false));
    let (near, _) = near_end(&error, &estimate, &delayed, Some(&frozen));
    let frozen = widen(&near, 2, 25);
    let (error, estimate) =
        linear.run(mic, &delayed, &|b| !frozen.get(b).copied().unwrap_or(false));
    let (near, leak) = near_end(&error, &estimate, &delayed, Some(&frozen));
    let summed_delayed: Vec<f32> = (0..mic.len())
        .map(|i| delayed.iter().map(|c| c[i]).sum())
        .collect();
    let mut out = suppress(&error, &estimate, mic, &summed_delayed, leak, &near);
    // Where the system track was silent within the echo's reach, the microphone as it was, bit for bit.
    let mut sound = vec![0u32; length + 1];
    for i in 0..length {
        sound[i + 1] = sound[i] + u32::from(reference.iter().any(|c| c[i] != 0.0));
    }
    let reach = delay + TAIL + B;
    for (i, sample) in out.iter_mut().enumerate() {
        let (from, to) = (i.saturating_sub(reach).min(length), i.min(length));
        if sound[to] == sound[from] {
            *sample = mic[i];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(length: usize, seed: u32) -> Vec<f32> {
        let mut state = seed;
        (0..length)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state >> 8) as f32 / (1u32 << 24) as f32 - 0.5
            })
            .collect()
    }
    fn energy(samples: &[f32]) -> f32 {
        samples.iter().map(|v| v * v).sum::<f32>() / samples.len().max(1) as f32
    }
    /// A room: 40 ms of delay, then a decaying random tail of 100 ms.
    fn room(reference: &[f32]) -> Vec<f32> {
        let taps: Vec<f32> = noise(4800, 7)
            .iter()
            .enumerate()
            .map(|(i, v)| v * (-(i as f32) / 900.0).exp() * 0.5)
            .collect();
        let delay = 1920;
        (0..reference.len())
            .map(|n| {
                taps.iter()
                    .enumerate()
                    .map(|(k, t)| {
                        if n >= delay + k {
                            t * reference[n - delay - k]
                        } else {
                            0.0
                        }
                    })
                    .sum()
            })
            .collect()
    }

    #[test]
    fn a_silent_system_track_leaves_the_microphone_bit_for_bit() {
        let mic = noise(48_000, 3);
        assert_eq!(process(&mic, &[vec![0.0; mic.len()]]), mic);
    }

    #[test]
    fn echo_alone_is_removed_and_the_voice_alone_is_untouched() {
        // 6 s: the far end alone for 4 s, then 2 s of silence on the system track with a near voice.
        let length = 6 * 48_000;
        let mut reference = noise(length, 11);
        reference[4 * 48_000..].iter_mut().for_each(|v| *v = 0.0);
        let echo = room(&reference);
        let voice: Vec<f32> = noise(length, 5)
            .iter()
            .enumerate()
            .map(|(i, v)| {
                if i >= 4 * 48_000 + 24_000 {
                    v * 0.3
                } else {
                    0.0
                }
            })
            .collect();
        let mic: Vec<f32> = echo.iter().zip(&voice).map(|(e, v)| e + v).collect();
        let out = process(&mic, &[reference.clone()]);
        let (a, b) = (48_000, 4 * 48_000 - 4800);
        let erle = 10.0 * (energy(&mic[a..b]) / energy(&out[a..b])).log10();
        assert!(erle > 25.0, "ERLE {erle} dB");
        let tail = 4 * 48_000 + 24_000 + TAIL + 2000;
        assert_eq!(&out[tail..], &mic[tail..]);
        assert_eq!(out.len(), mic.len());
    }

    #[test]
    fn the_same_take_gives_the_same_output() {
        let reference = noise(96_000, 2);
        let mic: Vec<f32> = room(&reference)
            .iter()
            .zip(noise(96_000, 9))
            .map(|(e, n)| e + 0.01 * n)
            .collect();
        assert_eq!(
            process(&mic, std::slice::from_ref(&reference)),
            process(&mic, &[reference])
        );
    }
    /// The echo: the reference `delay` samples late at `gain`.
    fn late(reference: &[f32], delay: usize, gain: f32) -> Vec<f32> {
        (0..reference.len())
            .map(|n| {
                if n >= delay {
                    gain * reference[n - delay]
                } else {
                    0.0
                }
            })
            .collect()
    }

    #[test]
    fn inverted_stereo_inverted_polarity_and_late_sound_are_still_cancelled() {
        // Left and right in opposite phase (their sum is silence), the echo path inverting polarity, and the system
        // track silent for its first 31 s: each once made C3 pass the whole take through.
        let length = 36 * 48_000;
        let start = 31 * 48_000;
        let mut left = noise(length, 21);
        left[..start].iter_mut().for_each(|v| *v = 0.0);
        let right: Vec<f32> = left.iter().map(|v| -v).collect();
        let echo = late(&left, 2400, -0.5);
        let floor = noise(length, 4);
        let mic: Vec<f32> = echo
            .iter()
            .zip(&floor)
            .map(|(e, n)| e + 0.001 * n)
            .collect();
        let out = process(&mic, &[left, right]);
        let (a, b) = (start + 48_000, length - 4800);
        let erle = 10.0 * (energy(&mic[a..b]) / energy(&out[a..b])).log10();
        assert!(erle > 25.0, "ERLE {erle} dB");
        assert_eq!(
            &out[..start],
            &mic[..start],
            "silent system track: untouched"
        );
    }

    #[test]
    fn a_short_system_track_leaves_the_microphone_past_its_reach_untouched() {
        let reference = noise(2 * 48_000, 13);
        let mut mic = late(&reference, 2400, 0.5);
        mic.extend(noise(3 * 48_000, 17).iter().map(|v| 0.1 * v));
        let out = process(&mic, &[reference]);
        let past = 2 * 48_000 + 2400 + TAIL + 2 * B;
        assert_eq!(&out[past..], &mic[past..]);
    }

    #[test]
    fn suppression_stops_at_the_room_noise_not_below() {
        let length = 6 * 48_000;
        let reference = noise(length, 23);
        let room = noise(length, 29);
        let mic: Vec<f32> = late(&reference, 2400, 0.5)
            .iter()
            .zip(&room)
            .map(|(e, n)| e + 0.003 * n)
            .collect();
        let out = process(&mic, &[reference]);
        let (a, b) = (2 * 48_000, length - 4800);
        let noise_level = 10.0 * (energy(&room[a..b]) * 0.003 * 0.003).log10();
        let out_level = 10.0 * energy(&out[a..b]).log10();
        assert!(
            (out_level - noise_level).abs() < 6.0,
            "output {out_level:.1} dB against the room's {noise_level:.1} dB"
        );
    }

    #[test]
    fn digital_silence_before_the_room_does_not_floor_the_noise() {
        // A second of exact zeros (an input not yet delivering), then the room and echo: the floor must come from the
        // room, so what is left stays at its level rather than 40 dB under it.
        let length = 6 * 48_000;
        let reference = noise(length, 31);
        let room = noise(length, 37);
        let mut mic: Vec<f32> = late(&reference, 2400, 0.5)
            .iter()
            .zip(&room)
            .map(|(e, n)| e + 0.003 * n)
            .collect();
        mic[..48_000].iter_mut().for_each(|v| *v = 0.0);
        let out = process(&mic, &[reference]);
        let (a, b) = (3 * 48_000, length - 4800);
        let noise_level = 10.0 * (energy(&room[a..b]) * 0.003 * 0.003).log10();
        let out_level = 10.0 * energy(&out[a..b]).log10();
        assert!(
            (out_level - noise_level).abs() < 6.0,
            "output {out_level:.1} dB against the room's {noise_level:.1} dB"
        );
    }
}
