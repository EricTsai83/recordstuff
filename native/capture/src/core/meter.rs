//! The input level meter in Settings (plan 079, D1): a microphone's peak and RMS over each 50 ms of its sound, as the
//! device delivers it, before any volume (Settings shows what the input hears, not a recording's mix). The platform
//! reads the device the way a recording would (mac/meter.rs, win/audio.rs) and hands each buffer here.

/// Levels told this many times a second: often enough for a meter that follows speech.
pub const METER_RATE: u32 = 20;

/// One window's levels, linear (1 is full scale).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeterLevel {
    pub peak: f32,
    pub rms: f32,
}

/// What a meter tells: levels, or that it stopped reading its device (it left, or the system moved it).
pub enum MeterEvent {
    Level(MeterLevel),
    Lost(String),
}

/// Gathers samples at `rate` and gives the levels of every whole window of `rate / METER_RATE` frames.
pub struct LevelMeter {
    window: usize,
    frames: usize,
    peak: f32,
    sum: f64,
}

impl LevelMeter {
    pub fn new(rate: f64) -> Self {
        Self { window: ((rate / f64::from(METER_RATE)).round() as usize).max(1), frames: 0, peak: 0.0, sum: 0.0 }
    }

    /// Adds mono `samples`; `tell` gets each window they complete. A sample that is not finite counts as silence.
    pub fn push(&mut self, samples: &[f32], mut tell: impl FnMut(MeterLevel)) {
        for &sample in samples {
            let sample = if sample.is_finite() { sample.abs() } else { 0.0 };
            self.peak = self.peak.max(sample);
            self.sum += f64::from(sample) * f64::from(sample);
            self.frames += 1;
            if self.frames == self.window {
                tell(MeterLevel { peak: self.peak, rms: (self.sum / self.window as f64).sqrt() as f32 });
                self.frames = 0;
                self.peak = 0.0;
                self.sum = 0.0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn levels(meter: &mut LevelMeter, samples: &[f32]) -> Vec<MeterLevel> {
        let mut told = Vec::new();
        meter.push(samples, |level| told.push(level));
        told
    }

    #[test]
    fn a_sine_gives_its_amplitude_as_peak_and_its_rms() {
        let mut meter = LevelMeter::new(48_000.0);
        // 1 kHz at half scale: 2400 frames a window, a whole number of periods.
        let tone: Vec<f32> = (0..4_800).map(|n| (n as f32 * 1000.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5).collect();
        let told = levels(&mut meter, &tone);
        assert_eq!(told.len(), 2);
        for level in told {
            assert!((level.peak - 0.5).abs() < 1e-3, "{level:?}");
            assert!((level.rms - 0.5 / 2f32.sqrt()).abs() < 1e-3, "{level:?}");
        }
    }

    #[test]
    fn silence_is_zero_and_windows_span_buffers_of_any_size() {
        // A Bluetooth headset's 16 kHz in 160-frame buffers: 800 frames a window, told after the fifth buffer.
        let mut meter = LevelMeter::new(16_000.0);
        let mut told = Vec::new();
        for _ in 0..4 {
            told.extend(levels(&mut meter, &[0.0; 160]));
        }
        assert!(told.is_empty());
        told.extend(levels(&mut meter, &[0.0; 160]));
        assert_eq!(told, [MeterLevel { peak: 0.0, rms: 0.0 }]);
    }

    #[test]
    fn a_window_starts_from_nothing_and_ignores_what_is_not_a_number() {
        let mut meter = LevelMeter::new(400.0);
        // 20 frames a window: a loud one, then a quiet one with a NaN in it.
        let mut samples = vec![0.9f32; 20];
        samples.extend([0.1f32; 19]);
        samples.push(f32::NAN);
        let told = levels(&mut meter, &samples);
        assert_eq!(told.len(), 2);
        assert!((told[0].peak - 0.9).abs() < 1e-6 && (told[0].rms - 0.9).abs() < 1e-6);
        assert!((told[1].peak - 0.1).abs() < 1e-6, "{:?}", told[1]);
        assert!(told[1].rms < 0.1 && told[1].rms > 0.09, "{:?}", told[1]);
    }
}
