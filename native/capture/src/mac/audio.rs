//! AAC-LC through AudioToolbox's converter (plan 076, D4). PCM goes in as interleaved 32-bit float; at most one packet
//! of 1024 frames comes out per call. The encoder's priming (its first output frames are its own delay) is reported,
//! so the file's edit list can skip it, and at the end the converter is told the stream ended so the sound it still
//! holds comes out too.

use std::ffi::c_void;
use std::ptr::{NonNull, null_mut};

use objc2_audio_toolbox::{
    AudioConverterDispose, AudioConverterFillComplexBuffer, AudioConverterGetProperty, AudioConverterNew, AudioConverterPrimeInfo,
    AudioConverterRef, AudioConverterSetProperty, kAudioConverterEncodeBitRate, kAudioConverterPrimeInfo,
    kAudioConverterPropertyMaximumOutputPacketSize,
};
use objc2_core_audio_types::{
    AudioBuffer, AudioBufferList, AudioStreamBasicDescription, AudioStreamPacketDescription, kAudioFormatFlagIsFloat,
    kAudioFormatFlagIsPacked, kAudioFormatLinearPCM, kAudioFormatMPEG4AAC,
};

use super::CaptureError;
use crate::aac::audio_specific_config;
use crate::writer::AAC_FRAMES;

/// What the input callback returns once it has handed over every buffered frame: not an error, only "no more now".
const NO_MORE_INPUT: i32 = 0x6e6f6d6f;

pub struct AacEncoder {
    converter: AudioConverterRef,
    channels: usize,
    sample_rate: u32,
    max_packet: u32,
    /// Interleaved frames waiting to be encoded.
    pending: Vec<f32>,
    /// What the input callback last handed the converter, which may read it until the callback runs again: a copy
    /// that never moves or grows, unlike `pending`.
    handed: Box<[f32]>,
    /// Frames pushed so far, silence included: what the track presents after its priming.
    pub frames_in: u64,
    /// The stream ended: the callback reports the end instead of "no input yet".
    ended: bool,
    /// Frames of the encoder's own delay at the start of its output.
    pub priming: u32,
}

// The converter is used from one thread at a time, behind the session's lock.
unsafe impl Send for AacEncoder {}

impl AacEncoder {
    pub fn new(sample_rate: u32, channels: u32, bitrate: u32) -> Result<Self, CaptureError> {
        let fail = |what: &str, status: i32| CaptureError::new("capture_start_failed", format!("AAC encoder {what}: {status}"));
        let mut input = AudioStreamBasicDescription {
            mSampleRate: f64::from(sample_rate),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4 * channels,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4 * channels,
            mChannelsPerFrame: channels,
            mBitsPerChannel: 32,
            mReserved: 0,
        };
        let mut output = AudioStreamBasicDescription {
            mSampleRate: f64::from(sample_rate),
            mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: AAC_FRAMES,
            mBytesPerFrame: 0,
            mChannelsPerFrame: channels,
            mBitsPerChannel: 0,
            mReserved: 0,
        };
        let mut converter: AudioConverterRef = null_mut();
        let status = unsafe { AudioConverterNew(NonNull::from(&mut input), NonNull::from(&mut output), NonNull::from(&mut converter)) };
        if status != 0 || converter.is_null() {
            return Err(fail("could not be created", status));
        }
        let mut encoder = Self {
            converter,
            channels: channels as usize,
            sample_rate,
            max_packet: 0,
            pending: Vec::new(),
            handed: vec![0.0; AAC_FRAMES as usize * channels as usize].into_boxed_slice(),
            frames_in: 0,
            ended: false,
            priming: 0,
        };
        let mut rate = bitrate;
        let status = unsafe {
            AudioConverterSetProperty(converter, kAudioConverterEncodeBitRate, 4, NonNull::from(&mut rate).cast())
        };
        if status != 0 {
            return Err(fail("refused the bit rate", status));
        }
        let mut size = 4u32;
        let status = unsafe {
            AudioConverterGetProperty(
                converter,
                kAudioConverterPropertyMaximumOutputPacketSize,
                NonNull::from(&mut size),
                NonNull::from(&mut encoder.max_packet).cast(),
            )
        };
        if status != 0 || encoder.max_packet == 0 {
            return Err(fail("has no packet size", status));
        }
        let mut prime = AudioConverterPrimeInfo { leadingFrames: 0, trailingFrames: 0 };
        let mut size = std::mem::size_of::<AudioConverterPrimeInfo>() as u32;
        let status = unsafe {
            AudioConverterGetProperty(converter, kAudioConverterPrimeInfo, NonNull::from(&mut size), NonNull::from(&mut prime).cast())
        };
        encoder.priming = if status == 0 { prime.leadingFrames } else { 0 };
        Ok(encoder)
    }

    /// The AudioSpecificConfig for AAC-LC at this rate and channel count (ISO/IEC 14496-3, 1.6.2.1).
    pub fn audio_specific_config(&self) -> Vec<u8> {
        audio_specific_config(self.sample_rate, self.channels as u8)
    }

    pub fn push(&mut self, interleaved: &[f32]) {
        self.pending.extend_from_slice(interleaved);
        self.frames_in += (interleaved.len() / self.channels) as u64;
    }

    pub fn push_silence(&mut self, frames: usize) {
        self.pending.resize(self.pending.len() + frames * self.channels, 0.0);
        self.frames_in += frames as u64;
    }

    /// Encodes every whole packet's worth of pending frames, handing each packet to `out`.
    pub fn drain(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
        while self.pending.len() >= AAC_FRAMES as usize * self.channels {
            if !self.encode_one(out)? {
                break;
            }
        }
        Ok(())
    }

    /// Ends the stream: encodes what is pending and everything the converter still holds. The last packet's padding
    /// lies past `frames_in`, where the edit list ends the track.
    pub fn finish(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
        self.ended = true;
        // Bounded: each call consumes input or produces a packet, and the converter holds about two packets.
        let limit = self.pending.len() / (AAC_FRAMES as usize * self.channels) + 16;
        for _ in 0..limit {
            if !self.encode_one(out)? {
                return Ok(());
            }
        }
        Err("the AAC encoder did not finish".into())
    }

    /// One converter call for one packet. False when it neither took input nor produced a packet.
    fn encode_one(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<bool, String> {
        let mut state = Input { data: &self.pending, handed: &mut self.handed, channels: self.channels, consumed: 0, ended: self.ended };
        let mut packet = vec![0u8; self.max_packet as usize];
        let mut list = AudioBufferList {
            mNumberBuffers: 1,
            mBuffers: [AudioBuffer { mNumberChannels: self.channels as u32, mDataByteSize: self.max_packet, mData: packet.as_mut_ptr().cast() }],
        };
        let mut packets = 1u32;
        let mut description = AudioStreamPacketDescription { mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: 0 };
        let status = unsafe {
            AudioConverterFillComplexBuffer(
                self.converter,
                Some(input),
                (&mut state as *mut Input).cast(),
                NonNull::from(&mut packets),
                NonNull::from(&mut list),
                &mut description,
            )
        };
        let consumed = state.consumed;
        self.pending.drain(..consumed * self.channels);
        if status != 0 && status != NO_MORE_INPUT {
            return Err(format!("AAC encoding failed: {status}"));
        }
        if packets == 0 || list.mBuffers[0].mDataByteSize == 0 {
            return Ok(consumed > 0);
        }
        packet.truncate(list.mBuffers[0].mDataByteSize as usize);
        out(packet);
        Ok(true)
    }
}

impl Drop for AacEncoder {
    fn drop(&mut self) {
        unsafe { AudioConverterDispose(self.converter) };
    }
}

struct Input<'a> {
    data: &'a [f32],
    handed: &'a mut [f32],
    channels: usize,
    consumed: usize,
    ended: bool,
}

unsafe extern "C-unwind" fn input(
    _converter: AudioConverterRef,
    packets: NonNull<u32>,
    data: NonNull<AudioBufferList>,
    _descriptions: *mut *mut AudioStreamPacketDescription,
    user: *mut c_void,
) -> i32 {
    let state = unsafe { &mut *(user as *mut Input) };
    let available = state.data.len() / state.channels - state.consumed;
    let wanted = unsafe { *packets.as_ptr() } as usize;
    let given = wanted.min(available).min(state.handed.len() / state.channels);
    unsafe { *packets.as_ptr() = given as u32 };
    let list = unsafe { &mut *data.as_ptr() };
    list.mNumberBuffers = 1;
    list.mBuffers[0].mNumberChannels = state.channels as u32;
    if given == 0 {
        list.mBuffers[0].mDataByteSize = 0;
        list.mBuffers[0].mData = null_mut();
        // Zero frames with no error is the end of the stream; the converter then returns what it holds.
        return if state.ended { 0 } else { NO_MORE_INPUT };
    }
    let samples = given * state.channels;
    let from = state.consumed * state.channels;
    state.handed[..samples].copy_from_slice(&state.data[from..from + samples]);
    list.mBuffers[0].mDataByteSize = (samples * 4) as u32;
    // Valid until the converter calls again: only this callback writes `handed`.
    list.mBuffers[0].mData = state.handed.as_mut_ptr().cast();
    state.consumed += given;
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_encoder_turns_a_second_of_tone_into_aac_packets() {
        let mut encoder = AacEncoder::new(48_000, 2, 256_000).unwrap();
        let tone: Vec<f32> = (0..48_000 * 2).map(|n| ((n / 2) as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5).collect();
        encoder.push(&tone);
        let mut packets = Vec::new();
        encoder.finish(&mut |packet| packets.push(packet)).unwrap();
        // Ending the stream returns everything: the priming and every input frame, the last packet padded.
        assert_eq!(packets.len(), (48_000 + encoder.priming as usize).div_ceil(1024), "{} packets", packets.len());
        assert_eq!(encoder.frames_in, 48_000);
        assert!(packets.iter().all(|p| !p.is_empty() && p.len() < 1536));
        assert!(encoder.priming > 0 && encoder.priming < 4096, "priming {}", encoder.priming);
    }
}
