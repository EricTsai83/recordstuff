//! AAC-LC through Media Foundation's AAC encoder transform (plan 076, D4). It takes 16-bit PCM only, so the captured
//! float samples are converted, and it encodes at 96, 128, 160 or 192 kbps only: a higher setting is lowered to 192
//! kbps and the session says so in its warnings.
//!
//! Its priming (the encoder's own delay at the start of its output, which the file's edit list skips) is not
//! published, so it is measured when the encoder is made: whole packets of silence in, packets out.

use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::core::GUID;

use super::CaptureError;
use super::mft::{bytes, outputs, sample};
use crate::aac::audio_specific_config;
use crate::core::AudioEncode;
use crate::writer::AAC_FRAMES;

/// CLSID_AACMFTEncoder (wmcodecdsp.h).
const CLSID_AAC_ENCODER: GUID = GUID::from_u128(0x93af0c51_2275_45d2_a35b_f2ba21caed00);
/// The bit rates the encoder takes, in bits per second.
const RATES: [u32; 4] = [96_000, 128_000, 160_000, 192_000];
/// What the priming measurement feeds: packets of silence.
const PROBE_PACKETS: u64 = 8;

pub struct AacEncoder {
    transform: IMFTransform,
    sample_rate: u32,
    channels: usize,
    /// Interleaved 16-bit frames waiting to be encoded.
    pending: Vec<i16>,
    /// Frames handed to the transform, for sample times.
    frames_encoded: u64,
    /// Frames pushed so far, silence included: what the track presents after its priming.
    pub frames_in: u64,
    pub priming: u32,
    /// The bit rate used, after lowering to one the encoder takes.
    pub bitrate: u32,
}

unsafe impl Send for AacEncoder {}

/// The highest rate the encoder takes that is not above `requested`, and the lowest when all are.
pub fn supported_bitrate(requested: u32) -> u32 {
    RATES.iter().rev().copied().find(|&rate| rate <= requested).unwrap_or(RATES[0])
}

impl AacEncoder {
    pub fn new(sample_rate: u32, channels: u32, bitrate: u32) -> Result<Self, CaptureError> {
        let mut encoder = Self::make(sample_rate, channels, supported_bitrate(bitrate))?;
        encoder.priming = Self::make(sample_rate, channels, encoder.bitrate)?.measure_priming()?;
        Ok(encoder)
    }

    fn make(sample_rate: u32, channels: u32, bitrate: u32) -> Result<Self, CaptureError> {
        super::media_foundation()?;
        let fail = super::failing;
        let transform: IMFTransform =
            unsafe { CoCreateInstance(&CLSID_AAC_ENCODER, None, CLSCTX_INPROC_SERVER) }.map_err(super::encoder_missing("the AAC encoder is not available"))?;
        let input = unsafe { MFCreateMediaType() }.map_err(fail("a media type"))?;
        let output = unsafe { MFCreateMediaType() }.map_err(fail("a media type"))?;
        (|| -> windows::core::Result<()> {
            unsafe {
                input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
                input.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
                input.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
                input.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sample_rate)?;
                input.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels)?;
                input.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 2 * channels)?;
                input.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 2 * channels * sample_rate)?;
                output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
                output.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
                output.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
                output.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sample_rate)?;
                output.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels)?;
                output.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, bitrate / 8)?;
                // Raw access units, as MP4 holds them, and AAC-LC.
                output.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)?;
                output.SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)?;
                // The encoder takes its input type first.
                transform.SetInputType(0, &input, 0)?;
                transform.SetOutputType(0, &output, 0)?;
                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
            }
        })()
        .map_err(fail("the AAC encoder refused the format"))?;
        Ok(Self { transform, sample_rate, channels: channels as usize, pending: Vec::new(), frames_encoded: 0, frames_in: 0, priming: 0, bitrate })
    }

    /// Packets of silence in, every packet out: the extra ones are the encoder's priming.
    fn measure_priming(mut self) -> Result<u32, CaptureError> {
        let frames = PROBE_PACKETS * u64::from(AAC_FRAMES);
        self.push_silence(frames as usize);
        let mut packets = 0u64;
        self.finish(&mut |_| packets += 1).map_err(|detail| CaptureError::new("capture_start_failed", detail))?;
        let out = packets * u64::from(AAC_FRAMES);
        if out < frames {
            return Err(CaptureError::new("capture_start_failed", format!("the AAC encoder returned {out} frames for {frames}: its priming cannot be known")));
        }
        Ok((out - frames) as u32)
    }

    fn encode(&mut self, frames: usize, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
        let samples = frames * self.channels;
        let data: Vec<u8> = self.pending.drain(..samples).flat_map(i16::to_le_bytes).collect();
        let time = (self.frames_encoded * 10_000_000 / u64::from(self.sample_rate)) as i64;
        let duration = (frames as u64 * 10_000_000 / u64::from(self.sample_rate)) as i64;
        self.frames_encoded += frames as u64;
        let produced = sample(&data, time, duration)
            .and_then(|input| unsafe { self.transform.ProcessInput(0, &input, 0) })
            .and_then(|()| outputs(&self.transform, 8_192))
            .map_err(|e| format!("AAC encoding failed: {e}"))?;
        for packet in produced {
            out(bytes(&packet).map_err(|e| format!("reading an AAC packet: {e}"))?.0);
        }
        Ok(())
    }
}

impl AudioEncode for AacEncoder {
    fn frames_in(&self) -> u64 {
        self.frames_in
    }

    fn priming(&self) -> u32 {
        self.priming
    }

    fn audio_specific_config(&self) -> Vec<u8> {
        audio_specific_config(self.sample_rate, self.channels as u8)
    }

    fn push(&mut self, interleaved: &[f32]) {
        self.pending.extend(interleaved.iter().map(|&value| (value.clamp(-1.0, 1.0) * 32_767.0).round() as i16));
        self.frames_in += (interleaved.len() / self.channels) as u64;
    }

    fn push_silence(&mut self, frames: usize) {
        self.pending.resize(self.pending.len() + frames * self.channels, 0);
        self.frames_in += frames as u64;
    }

    fn drain(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
        let packet = AAC_FRAMES as usize;
        let whole = self.pending.len() / self.channels / packet * packet;
        if whole > 0 {
            self.encode(whole, out)?;
        }
        Ok(())
    }

    /// Ends the stream: the pending frames, padded to a whole packet, and everything the transform still holds. The
    /// padding lies past `frames_in`, where the edit list ends the track.
    fn finish(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
        let frames = self.pending.len() / self.channels;
        let padded = frames.next_multiple_of(AAC_FRAMES as usize);
        self.pending.resize(padded * self.channels, 0);
        if padded > 0 {
            self.encode(padded, out)?;
        }
        let produced = unsafe { self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0) }
            .and_then(|()| outputs(&self.transform, 8_192))
            .map_err(|e| format!("AAC encoding failed: {e}"))?;
        for packet in produced {
            out(bytes(&packet).map_err(|e| format!("reading an AAC packet: {e}"))?.0);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bit_rate_is_lowered_to_one_the_encoder_takes() {
        assert_eq!(supported_bitrate(256_000), 192_000);
        assert_eq!(supported_bitrate(192_000), 192_000);
        assert_eq!(supported_bitrate(150_000), 128_000);
        assert_eq!(supported_bitrate(64_000), 96_000);
    }
}
