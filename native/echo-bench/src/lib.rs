//! Plan 096 step 3: the offline bench of echo-removal candidates (docs/system-design/tooling.md#echo-removal-bench).
//! The microphone is processed with the system's sound (summed to mono) as the reference, in 10 ms frames at 48 kHz;
//! nothing but echo cancellation runs (no high-pass filter, noise suppression or gain control: the plan's P4).
//! Developer tooling only; never shipped.

#[cfg(feature = "c3")]
pub mod c3;

#[cfg(feature = "aec3")]
use webrtc_audio_processing::Processor;
#[cfg(feature = "aec3")]
use webrtc_audio_processing::experimental::EchoCanceller3Config;
#[cfg(feature = "aec3")]
use webrtc_audio_processing_config::{Config, EchoCanceller, Pipeline, PipelineProcessingRate};

pub const RATE: u32 = 48_000;
/// 10 ms at 48 kHz, the module's frame.
pub const FRAME: usize = 480;

/// The plan's candidates (C3, an offline canceller of our own, is written only if both fail for a reason it addresses).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Candidate {
    /// The input unchanged: the bench's own floor and its cost without the module.
    None,
    /// C1: WebRTC AEC3 with its default configuration, echo cancellation alone.
    Aec3,
    /// C2: AEC3 with a suppressor that lets more through when the near end talks (the plan's P5: the voice first).
    Aec3Gentle,
    /// C3: the offline canceller of our own (c3.rs).
    Offline,
}

impl Candidate {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "none" => Some(Self::None),
            "c1" => Some(Self::Aec3),
            "c2" => Some(Self::Aec3Gentle),
            "c3" => Some(Self::Offline),
            _ => None,
        }
    }
}

#[cfg(feature = "aec3")]
/// C2's suppressor: the near-end state is entered sooner and its masks are more transparent, so less of a voice is
/// taken during double-talk, at the cost of more residual echo there.
fn gentle_config() -> EchoCanceller3Config {
    let mut config = EchoCanceller3Config::default();
    let suppressor = &mut config.suppressor;
    suppressor.dominant_nearend_detection.enr_threshold = 0.1;
    suppressor.dominant_nearend_detection.snr_threshold = 20.0;
    suppressor.dominant_nearend_detection.hold_duration = 100;
    suppressor.nearend_tuning.mask_lf.enr_transparent = 2.0;
    suppressor.nearend_tuning.mask_lf.enr_suppress = 2.2;
    suppressor.nearend_tuning.mask_hf.enr_transparent = 0.5;
    suppressor.nearend_tuning.mask_hf.enr_suppress = 0.8;
    config.validate();
    config
}

#[cfg(feature = "aec3")]
fn processor(candidate: Candidate) -> Processor {
    let processor = match candidate {
        Candidate::Aec3Gentle => Processor::with_aec3_config(RATE, gentle_config()),
        _ => Processor::new(RATE),
    }
    .expect("the audio processing module starts");
    processor.set_config(Config {
        pipeline: Pipeline {
            maximum_internal_processing_rate: PipelineProcessingRate::Max48000Hz,
            multi_channel_render: false,
            multi_channel_capture: false,
            ..Default::default()
        },
        echo_canceller: Some(EchoCanceller::Full {
            stream_delay_ms: None,
        }),
        high_pass_filter: None,
        noise_suppression: None,
        gain_controller: None,
        capture_amplifier: None,
    });
    processor
}

/// The microphone with the candidate applied; as long as `mic`. `reference` is the system track, mono, on the same
/// clock. With `two_pass` the whole take is processed once to converge and the output is the second pass's, so the
/// first seconds are not left echoing (an offline pass may do what a live one cannot).
/// `reference` is the system track's channels; C1 and C2 take their sum's mean (the plan's C1), C3 each channel.
pub fn process(
    mic: &[f32],
    reference: &[Vec<f32>],
    candidate: Candidate,
    two_pass: bool,
) -> Vec<f32> {
    match candidate {
        Candidate::None => mic.to_vec(),
        // C3 always runs its two passes.
        #[cfg(feature = "c3")]
        Candidate::Offline => c3::process(mic, reference),
        #[cfg(not(feature = "c3"))]
        Candidate::Offline => panic!("C3 needs the bench built with the c3 feature"),
        _ => aec3(mic, &mono(reference), candidate, two_pass),
    }
}

#[cfg(not(feature = "aec3"))]
fn aec3(_: &[f32], _: &[f32], candidate: Candidate, _: bool) -> Vec<f32> {
    panic!("{candidate:?} needs the bench built with the aec3 feature");
}

#[cfg(feature = "aec3")]
fn aec3(mic: &[f32], reference: &[f32], candidate: Candidate, two_pass: bool) -> Vec<f32> {
    let processor = processor(candidate);
    let frames = mic.len().div_ceil(FRAME);
    let mut out = Vec::with_capacity(frames * FRAME);
    for pass in 0..if two_pass { 2 } else { 1 } {
        out.clear();
        for f in 0..frames {
            let take = |source: &[f32]| -> Vec<f32> {
                let mut frame = vec![0.0f32; FRAME];
                let start = (f * FRAME).min(source.len());
                let end = ((f + 1) * FRAME).min(source.len());
                frame[..end - start].copy_from_slice(&source[start..end]);
                frame
            };
            let mut render = take(reference);
            let mut capture = take(mic);
            processor
                .process_render_frame([render.as_mut_slice()])
                .expect("render frame");
            processor
                .process_capture_frame([capture.as_mut_slice()])
                .expect("capture frame");
            if pass == if two_pass { 1 } else { 0 } {
                out.extend_from_slice(&capture);
            }
        }
    }
    out.truncate(mic.len());
    out
}

/// Reads a WAV of 32-bit floats or 16-bit integers, plain or extensible, into one vector per channel.
pub fn read_wav(bytes: &[u8]) -> Result<(u32, Vec<Vec<f32>>), String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let u16_at = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
    let u32_at =
        |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    let mut format: Option<(u16, u16, u32, u16)> = None;
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32_at(offset + 4) as usize;
        let body = offset + 8;
        if id == b"fmt " {
            let mut tag = u16_at(body);
            if tag == 0xfffe {
                tag = u16_at(body + 24);
            }
            format = Some((tag, u16_at(body + 2), u32_at(body + 4), u16_at(body + 14)));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = format.ok_or("WAV data before its format")?;
            let channels = channels as usize;
            let width = (bits / 8) as usize;
            if !((tag == 3 && bits == 32) || (tag == 1 && bits == 16)) || channels == 0 {
                return Err(format!("unsupported WAV format {tag}/{bits}"));
            }
            let available = size.min(bytes.len() - body);
            let count = available / (width * channels);
            let mut out = vec![Vec::with_capacity(count); channels];
            for i in 0..count {
                for (c, channel) in out.iter_mut().enumerate() {
                    let at = body + (i * channels + c) * width;
                    channel.push(if tag == 3 {
                        f32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
                    } else {
                        i16::from_le_bytes([bytes[at], bytes[at + 1]]) as f32 / 32768.0
                    });
                }
            }
            return Ok((rate, out));
        }
        offset = body + size + (size & 1);
    }
    Err("WAV file has no data".into())
}

/// A mono 32-bit float WAV.
pub fn write_wav(samples: &[f32]) -> Vec<u8> {
    let bytes = samples.len() * 4;
    let mut out = Vec::with_capacity(44 + bytes);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + bytes as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&3u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 4).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(bytes as u32).to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

/// The channels' mean: the reference is summed to mono, as the plan's C1 says.
pub fn mono(channels: &[Vec<f32>]) -> Vec<f32> {
    let length = channels.iter().map(Vec::len).min().unwrap_or(0);
    (0..length)
        .map(|i| channels.iter().map(|c| c[i]).sum::<f32>() / channels.len() as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(length: usize, frequency: f32, amplitude: f32) -> Vec<f32> {
        (0..length)
            .map(|i| {
                amplitude * (2.0 * std::f32::consts::PI * frequency * i as f32 / RATE as f32).sin()
            })
            .collect()
    }
    fn energy(samples: &[f32]) -> f32 {
        samples.iter().map(|v| v * v).sum::<f32>() / samples.len().max(1) as f32
    }

    #[cfg(feature = "aec3")]
    #[test]
    fn the_same_input_gives_the_same_output_and_length() {
        let mic = tone(RATE as usize * 2 + 123, 440.0, 0.1);
        let reference = tone(RATE as usize * 2 + 123, 300.0, 0.2);
        for candidate in [Candidate::Aec3, Candidate::Aec3Gentle] {
            let a = process(&mic, std::slice::from_ref(&reference), candidate, false);
            let b = process(&mic, std::slice::from_ref(&reference), candidate, false);
            assert_eq!(a.len(), mic.len());
            assert_eq!(a, b, "{candidate:?} is deterministic");
        }
    }

    /// AEC3 fills what it suppresses with comfort noise at its floor (about -96 dBFS): silence stays inaudible, below
    /// -80 dBFS at its peak, far under any real microphone's own noise (-70 to -85 dBFS measured in step 2).
    #[cfg(feature = "aec3")]
    #[test]
    fn silence_stays_inaudible() {
        let silent = vec![0.0f32; RATE as usize];
        let out = process(
            &silent,
            &[tone(RATE as usize, 300.0, 0.2)],
            Candidate::Aec3,
            true,
        );
        let peak = out.iter().fold(0.0f32, |a, v| a.max(v.abs()));
        assert!(peak < 1e-4, "peak {peak}");
    }

    #[cfg(feature = "aec3")]
    #[test]
    fn without_a_reference_the_microphone_keeps_its_level() {
        let mic = tone(RATE as usize * 3, 1000.0, 0.1);
        let out = process(&mic, &[vec![0.0; mic.len()]], Candidate::Aec3, false);
        // After the first half second, within 0.5 dB.
        let start = RATE as usize / 2;
        let ratio = 10.0 * (energy(&out[start..]) / energy(&mic[start..])).log10();
        assert!(ratio.abs() < 0.5, "level changed by {ratio} dB");
    }

    #[test]
    fn the_input_passes_unchanged_without_a_candidate_and_wav_round_trips() {
        let mic = tone(1000, 440.0, 0.3);
        assert_eq!(
            process(&mic, std::slice::from_ref(&mic), Candidate::None, true),
            mic
        );
        let (rate, channels) = read_wav(&write_wav(&mic)).unwrap();
        assert_eq!((rate, channels.len()), (RATE, 1));
        assert_eq!(channels[0], mic);
        assert_eq!(mono(&[vec![1.0, 0.0], vec![0.0, 1.0]]), vec![0.5, 0.5]);
        assert!(read_wav(b"nope").is_err());
    }
}
