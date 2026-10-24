//! An export's decoders and encoders on macOS (plan 085): VideoToolbox decodes a group of pictures from its key frame
//! on the media engine and hands each picture, still on the GPU, to the engine's own H.264 encoder (video.rs) set up as
//! for a recording but not in real time and at the source's level; AudioToolbox decodes AAC for the sound windows,
//! which the recording's AAC encoder (audio.rs) encodes again.

use std::ffi::c_void;
use std::ptr::{NonNull, null_mut};
use std::sync::{Arc, Mutex};

use objc2_audio_toolbox::{
    AudioConverterDispose, AudioConverterFillComplexBuffer, AudioConverterNew, AudioConverterRef, AudioConverterSetProperty,
    kAudioConverterDecompressionMagicCookie,
};
use objc2_core_audio_types::{
    AudioBuffer, AudioBufferList, AudioStreamBasicDescription, AudioStreamPacketDescription, kAudioFormatFlagIsFloat, kAudioFormatFlagIsPacked,
    kAudioFormatLinearPCM, kAudioFormatMPEG4AAC,
};
use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_media::{
    CMBlockBuffer, CMFormatDescription, CMSampleBuffer, CMSampleTimingInfo, CMTime, CMTimeFlags, CMVideoFormatDescriptionCreateFromH264ParameterSets,
    kCMBlockBufferAssureMemoryNowFlag, kCMTimeInvalid,
};
use objc2_core_video::{CVImageBuffer, kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferPixelFormatTypeKey};
use objc2_video_toolbox::{VTDecodeFrameFlags, VTDecodeInfoFlags, VTDecompressionOutputCallbackRecord, VTDecompressionSession};

use super::audio::AacEncoder;
use super::video::{EncoderOptions, VideoEncoder};
use crate::avc;
use crate::core::{AudioEncode, VideoSink};
use crate::edit::remux::{AudioFormat, Codecs, Reencoded, VideoFormat};
use crate::writer::{AAC_FRAMES, Media};

/// kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, what the recording's encoder is given.
const PIXEL_FORMAT_420V: u32 = u32::from_be_bytes(*b"420v");
const NO_MORE_INPUT: i32 = 0x6e6f6d6f;

/// The platform's codecs for an export. `cavlc` is a fixture's switch: re-encoded pictures whose parameter sets differ
/// from a recording's, to check the second sample description.
#[derive(Default)]
pub struct MacCodecs {
    pub cavlc: bool,
}

#[derive(Default)]
struct Collected {
    media: Vec<Media>,
    failure: Option<String>,
}

struct Collector(Mutex<Collected>);

impl VideoSink for Collector {
    fn media(&self, media: Media) {
        self.0.lock().unwrap().media.push(media);
    }

    fn failed(&self, detail: String) {
        self.0.lock().unwrap().failure.get_or_insert(detail);
    }

    fn dropped(&self) {
        self.0.lock().unwrap().failure.get_or_insert_with(|| "the H.264 encoder dropped a picture".into());
    }
}

/// A decoded picture, or why there is none.
type Picture = Result<CFRetained<CVImageBuffer>, String>;

/// Where the decoder's callback hands each picture, with the index it was decoded as: kept for `take`, or passed on
/// as it comes (an export's encoder), so a group's pictures never wait in memory together.
type Forward = Box<dyn Fn(usize, Picture) + Send + Sync>;

#[derive(Default)]
struct Decoded {
    pictures: Mutex<Vec<(usize, Picture)>>,
    forward: Option<Forward>,
}

// The callback may run on VideoToolbox's thread; a retained image buffer may be released from any thread.
unsafe impl Send for Decoded {}
unsafe impl Sync for Decoded {}

pub(super) struct Decoder {
    session: CFRetained<VTDecompressionSession>,
    format: CFRetained<CMFormatDescription>,
    /// The callback's context, freed after the session is invalidated.
    decoded: *const Decoded,
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe { self.session.invalidate() };
        drop(unsafe { Arc::from_raw(self.decoded) });
    }
}

unsafe extern "C-unwind" fn decoded(
    refcon: *mut c_void,
    frame: *mut c_void,
    status: i32,
    _flags: VTDecodeInfoFlags,
    image: *mut CVImageBuffer,
    _pts: CMTime,
    _duration: CMTime,
) {
    let decoded = unsafe { &*(refcon as *const Decoded) };
    let picture = match NonNull::new(image) {
        Some(image) if status == 0 => Ok(unsafe { CFRetained::retain(image) }),
        // A picture decoded but not wanted (`decode_with`'s `output` false).
        None if status == 0 => return,
        _ => Err(format!("a picture could not be decoded: {status}")),
    };
    match &decoded.forward {
        Some(forward) => forward(frame as usize, picture),
        None => decoded.pictures.lock().unwrap().push((frame as usize, picture)),
    }
}

impl Decoder {
    #[cfg(test)]
    pub(super) fn new(avcc: &[u8]) -> Result<Self, String> {
        Self::with_forward(avcc, None)
    }

    fn with_forward(avcc: &[u8], forward: Option<Forward>) -> Result<Self, String> {
        let (sps, pps) = avc::record_parameter_sets(avcc).ok_or("the recording's avcC holds no parameter sets")?;
        let pointers = [NonNull::from(&sps[0]), NonNull::from(&pps[0])];
        let sizes = [sps.len(), pps.len()];
        let mut format: *const CMFormatDescription = std::ptr::null();
        let status = unsafe {
            CMVideoFormatDescriptionCreateFromH264ParameterSets(
                None,
                2,
                NonNull::from(&pointers[0]).cast(),
                NonNull::from(&sizes[0]),
                4,
                NonNull::from(&mut format),
            )
        };
        let format = NonNull::new(format.cast_mut()).filter(|_| status == 0).ok_or_else(|| format!("the parameter sets were refused: {status}"))?;
        let format = unsafe { CFRetained::from_raw(format) };
        let surface = CFDictionary::<CFString, CFType>::from_slices(&[], &[]);
        let pixel = CFNumber::new_i64(i64::from(PIXEL_FORMAT_420V));
        let keys: [&CFString; 2] = unsafe { [kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferIOSurfacePropertiesKey] };
        let values: [&CFType; 2] = [pixel.as_ref(), surface.as_ref()];
        let attributes = CFDictionary::<CFString, CFType>::from_slices(&keys, &values);
        let context = Arc::into_raw(Arc::new(Decoded { pictures: Mutex::default(), forward }));
        let record = VTDecompressionOutputCallbackRecord { decompressionOutputCallback: Some(decoded), decompressionOutputRefCon: context.cast_mut().cast() };
        let mut session: *mut VTDecompressionSession = null_mut();
        let status = unsafe { VTDecompressionSession::create(None, &format, None, Some(attributes.as_opaque()), &record, NonNull::from(&mut session)) };
        let Some(session) = NonNull::new(session).filter(|_| status == 0) else {
            drop(unsafe { Arc::from_raw(context) });
            return Err(format!("the H.264 decoder could not be created: {status}"));
        };
        Ok(Self { session: unsafe { CFRetained::from_raw(session) }, format, decoded: context })
    }

    /// Decodes one sample, synchronously; its picture (or why there is none) is taken with `take`.
    #[cfg(test)]
    pub(super) fn decode(&self, data: &[u8], index: usize) -> Result<(), String> {
        self.decode_with(data, index, false, true)
    }

    /// As `decode`: `asynchronous` lets the decoder run ahead (`wait` collects it), and a picture not to `output` is
    /// decoded only as a reference for the next ones.
    fn decode_with(&self, data: &[u8], index: usize, asynchronous: bool, output: bool) -> Result<(), String> {
        let mut block: *mut CMBlockBuffer = null_mut();
        let status = unsafe {
            CMBlockBuffer::create_with_memory_block(
                None,
                null_mut(),
                data.len(),
                None,
                std::ptr::null(),
                0,
                data.len(),
                kCMBlockBufferAssureMemoryNowFlag,
                NonNull::from(&mut block),
            )
        };
        let block = NonNull::new(block).filter(|_| status == 0).ok_or_else(|| format!("a sample buffer could not be made: {status}"))?;
        let block = unsafe { CFRetained::from_raw(block) };
        let status = unsafe { CMBlockBuffer::replace_data_bytes(NonNull::from(&data[0]).cast(), &block, 0, data.len()) };
        if status != 0 {
            return Err(format!("a sample could not be copied: {status}"));
        }
        let timing = CMSampleTimingInfo {
            duration: unsafe { kCMTimeInvalid },
            presentationTimeStamp: CMTime { value: index as i64, timescale: 30, flags: CMTimeFlags::Valid, epoch: 0 },
            decodeTimeStamp: unsafe { kCMTimeInvalid },
        };
        let size = data.len();
        let mut sample: *mut CMSampleBuffer = null_mut();
        let status = unsafe { CMSampleBuffer::create_ready(None, Some(&block), Some(&self.format), 1, 1, &timing, 1, &size, NonNull::from(&mut sample)) };
        let sample = NonNull::new(sample).filter(|_| status == 0).ok_or_else(|| format!("a sample buffer could not be made: {status}"))?;
        let sample = unsafe { CFRetained::from_raw(sample) };
        let mut flags = VTDecodeFrameFlags(0);
        if asynchronous {
            flags |= VTDecodeFrameFlags::Frame_EnableAsynchronousDecompression;
        }
        if !output {
            flags |= VTDecodeFrameFlags::Frame_DoNotOutputFrame;
        }
        let status = unsafe { self.session.decode_frame(&sample, flags, index as *mut c_void, null_mut()) };
        if status != 0 {
            return Err(format!("a picture could not be decoded: {status}"));
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn take(&self) -> Vec<(usize, Picture)> {
        self.wait();
        std::mem::take(&mut *unsafe { &*self.decoded }.pictures.lock().unwrap())
    }

    /// Returns once every picture decoded so far has reached the callback.
    fn wait(&self) {
        unsafe { self.session.wait_for_asynchronous_frames() };
    }
}

#[cfg(test)]
impl MacCodecs {
    /// The `avcC` these codecs' re-encoded pictures carry, from re-encoding the first picture of `file`.
    pub(super) fn probe_avcc(&mut self, avcc: &[u8], file: &Vec<u8>) -> Vec<u8> {
        use crate::edit::source::{self, ReadAt};
        let index = source::read(file).unwrap();
        let mut first = Vec::new();
        index.video.samples.locate(0, 1, |_, offset, size| {
            first = vec![0u8; size as usize];
            file.read_at(&mut first, offset).unwrap();
        });
        let format =
            VideoFormat { avcc: avcc.to_vec(), width: index.video.width, height: index.video.height, timescale: index.video.timescale, frame_rate: 30 };
        self.reencode(&format, &[first], 0, &index.video.samples.durations[..1], 8_000_000).unwrap().avcc
    }
}

impl Codecs for MacCodecs {
    fn reencode(&mut self, format: &VideoFormat, group: &[Vec<u8>], from: usize, durations: &[u32], bitrate: u32) -> Result<Reencoded, String> {
        let collector = Arc::new(Collector(Mutex::new(Collected::default())));
        let options = EncoderOptions { real_time: false, baseline: false, level: format.avcc.get(3).copied(), cavlc: self.cavlc };
        let encoder = VideoEncoder::with_options(u32::from(format.width), u32::from(format.height), format.frame_rate, bitrate, options, collector.clone())
            .map_err(|e| e.detail)?;
        let encoder = Arc::new(encoder);
        // Each kept picture's presentation time from the first, in nanoseconds.
        let mut ticks = 0u64;
        let times: Vec<u64> = durations
            .iter()
            .map(|&d| {
                let ns = (u128::from(ticks) * 1_000_000_000 / u128::from(format.timescale)) as u64;
                ticks += u64::from(d);
                ns
            })
            .collect();
        let wanted = durations.len();
        // Pictures go from the decoder's callback straight to the encoder, in order, so the two run together and a
        // group's pictures never wait in memory.
        let next = Arc::new(Mutex::new((0usize, false)));
        let forward: Forward = {
            let (encoder, next, collector) = (encoder.clone(), next.clone(), collector.clone());
            Box::new(move |frame, picture| {
                let mut state = next.lock().unwrap();
                if state.1 || frame < from {
                    return;
                }
                let n = state.0;
                let result = picture.and_then(|picture| {
                    if frame != from + n || n >= wanted {
                        return Err(format!("the decoder returned picture {frame} for {}", from + n));
                    }
                    encoder.encode(&picture, times[n], n == 0)
                });
                match result {
                    Ok(()) => state.0 += 1,
                    Err(detail) => {
                        collector.failed(detail);
                        state.1 = true;
                    }
                }
            })
        };
        let decoder = Decoder::with_forward(&format.avcc, Some(forward))?;
        for (index, data) in group.iter().enumerate() {
            decoder.decode_with(data, index, true, index >= from)?;
        }
        decoder.wait();
        drop(decoder);
        let decoded = next.lock().unwrap().0;
        if decoded != wanted && collector.0.lock().unwrap().failure.is_none() {
            return Err(format!("{decoded} pictures decoded for {wanted}"));
        }
        encoder.flush();
        drop(encoder);
        let collected = std::mem::take(&mut *collector.0.lock().unwrap());
        if let Some(failure) = collected.failure {
            return Err(failure);
        }
        let mut avcc = None;
        let mut samples = Vec::with_capacity(wanted);
        for media in collected.media {
            match media {
                Media::VideoFormat { avcc: record, .. } => avcc = Some(record),
                Media::Video { data, sync, .. } => samples.push((data, sync)),
                Media::Audio { .. } => {}
            }
        }
        if samples.len() != durations.len() {
            return Err(format!("{} pictures came back from the encoder for {}", samples.len(), durations.len()));
        }
        Ok(Reencoded { avcc: avcc.ok_or("the H.264 encoder produced no avcC")?, samples })
    }

    fn decode_audio(&mut self, format: &AudioFormat, packets: &[Vec<u8>]) -> Result<Vec<f32>, String> {
        AacDecoder::new(format)?.decode(packets)
    }

    fn audio_encoder(&mut self, format: &AudioFormat, bitrate: u32) -> Result<Box<dyn AudioEncode>, String> {
        let encoder = AacEncoder::new(format.sample_rate, u32::from(format.channels), bitrate).map_err(|e| e.detail)?;
        Ok(Box::new(encoder))
    }
}

pub(super) struct AacDecoder {
    converter: AudioConverterRef,
    channels: usize,
}

impl Drop for AacDecoder {
    fn drop(&mut self) {
        unsafe { AudioConverterDispose(self.converter) };
    }
}

/// An `ES_Descriptor` around the AudioSpecificConfig, the magic cookie AudioToolbox's AAC decoder reads.
fn magic_cookie(config: &[u8]) -> Vec<u8> {
    fn descriptor(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![tag, 0x80, 0x80, 0x80, body.len() as u8];
        out.extend_from_slice(body);
        out
    }
    let mut decoder = vec![0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    decoder.extend(descriptor(0x05, config));
    let mut es = vec![0, 0, 0];
    es.extend(descriptor(0x04, &decoder));
    es.extend(descriptor(0x06, &[0x02]));
    descriptor(0x03, &es)
}

impl AacDecoder {
    pub(super) fn new(format: &AudioFormat) -> Result<Self, String> {
        let channels = u32::from(format.channels);
        let mut input = AudioStreamBasicDescription {
            mSampleRate: f64::from(format.sample_rate),
            mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: AAC_FRAMES,
            mBytesPerFrame: 0,
            mChannelsPerFrame: channels,
            mBitsPerChannel: 0,
            mReserved: 0,
        };
        let mut output = AudioStreamBasicDescription {
            mSampleRate: f64::from(format.sample_rate),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4 * channels,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4 * channels,
            mChannelsPerFrame: channels,
            mBitsPerChannel: 32,
            mReserved: 0,
        };
        let mut converter: AudioConverterRef = null_mut();
        let status = unsafe { AudioConverterNew(NonNull::from(&mut input), NonNull::from(&mut output), NonNull::from(&mut converter)) };
        if status != 0 || converter.is_null() {
            return Err(format!("the AAC decoder could not be created: {status}"));
        }
        let decoder = Self { converter, channels: channels as usize };
        let mut cookie = magic_cookie(&format.config);
        let status =
            unsafe { AudioConverterSetProperty(converter, kAudioConverterDecompressionMagicCookie, cookie.len() as u32, NonNull::from(&mut cookie[0]).cast()) };
        if status != 0 {
            return Err(format!("the AAC decoder refused the configuration: {status}"));
        }
        Ok(decoder)
    }

    /// Every packet decoded, in order: `AAC_FRAMES` interleaved frames each.
    pub(super) fn decode(&mut self, packets: &[Vec<u8>]) -> Result<Vec<f32>, String> {
        let frames = packets.len() * AAC_FRAMES as usize;
        let mut out = vec![0f32; frames * self.channels];
        let mut state =
            DecodeInput { packets, next: 0, description: AudioStreamPacketDescription { mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: 0 } };
        let mut filled = 0usize;
        while filled < frames {
            let wanted = (frames - filled).min(AAC_FRAMES as usize);
            let mut list = AudioBufferList {
                mNumberBuffers: 1,
                mBuffers: [AudioBuffer {
                    mNumberChannels: self.channels as u32,
                    mDataByteSize: (wanted * self.channels * 4) as u32,
                    mData: out[filled * self.channels..].as_mut_ptr().cast(),
                }],
            };
            let mut count = wanted as u32;
            let status = unsafe {
                AudioConverterFillComplexBuffer(
                    self.converter,
                    Some(decode_input),
                    (&mut state as *mut DecodeInput).cast(),
                    NonNull::from(&mut count),
                    NonNull::from(&mut list),
                    null_mut(),
                )
            };
            if status != 0 && status != NO_MORE_INPUT {
                return Err(format!("AAC decoding failed: {status}"));
            }
            if count == 0 {
                break;
            }
            filled += count as usize;
        }
        out.truncate(filled * self.channels);
        Ok(out)
    }
}

struct DecodeInput<'a> {
    packets: &'a [Vec<u8>],
    next: usize,
    description: AudioStreamPacketDescription,
}

unsafe extern "C-unwind" fn decode_input(
    _converter: AudioConverterRef,
    packets: NonNull<u32>,
    data: NonNull<AudioBufferList>,
    descriptions: *mut *mut AudioStreamPacketDescription,
    user: *mut c_void,
) -> i32 {
    let state = unsafe { &mut *(user as *mut DecodeInput) };
    let list = unsafe { &mut *data.as_ptr() };
    let Some(packet) = state.packets.get(state.next) else {
        unsafe { *packets.as_ptr() = 0 };
        list.mBuffers[0].mDataByteSize = 0;
        list.mBuffers[0].mData = null_mut();
        // The end of the stream: the converter returns what it holds.
        return 0;
    };
    state.next += 1;
    unsafe { *packets.as_ptr() = 1 };
    list.mNumberBuffers = 1;
    list.mBuffers[0].mDataByteSize = packet.len() as u32;
    // Read only, until the converter calls again.
    list.mBuffers[0].mData = packet.as_ptr().cast_mut().cast();
    state.description = AudioStreamPacketDescription { mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: packet.len() as u32 };
    if !descriptions.is_null() {
        unsafe { *descriptions = &mut state.description };
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sweep from 200 Hz up: no lag but the right one lines it up, unlike a tone, which repeats every period.
    pub fn sweep(frames: usize) -> Vec<f32> {
        (0..frames * 2)
            .map(|n| {
                let t = (n / 2) as f64 / 48_000.0;
                ((std::f64::consts::TAU * (200.0 * t + 1900.0 * t * t)).sin() * 0.4) as f32
            })
            .collect()
    }

    /// The lag at which `decoded` best matches `original` (left channel), searched in `0..range`.
    pub fn best_lag(decoded: &[f32], original: &[f32], range: usize) -> usize {
        (0..range)
            .min_by(|&a, &b| {
                let error = |lag: usize| -> f64 {
                    (0..4096).map(|i| f64::from(decoded.get((lag + 2000 + i) * 2).copied().unwrap_or(9.0) - original[(2000 + i) * 2]).powi(2)).sum()
                };
                error(a).total_cmp(&error(b))
            })
            .unwrap()
    }

    #[test]
    fn decoded_sound_lines_up_with_the_encoder_s_priming() {
        let mut encoder = AacEncoder::new(48_000, 2, 256_000).unwrap();
        let original = sweep(48_000);
        encoder.push(&original);
        let mut packets = Vec::new();
        encoder.finish(&mut |p| packets.push(p)).unwrap();
        let format = AudioFormat { config: encoder.audio_specific_config(), sample_rate: 48_000, channels: 2 };
        let decoded = AacDecoder::new(&format).unwrap().decode(&packets).unwrap();
        assert_eq!(decoded.len(), packets.len() * 1024 * 2);
        // Packet k decodes to frames k*1024.., so frame `priming + t` is the original's frame t.
        assert_eq!(best_lag(&decoded, &original, 4096), encoder.priming as usize);
        // Decoding from packet 10 on gives the same frames past its first two packets.
        let tail = AacDecoder::new(&format).unwrap().decode(&packets[10..]).unwrap();
        let at = 2 * 1024 * 2;
        let error: f32 = (0..2048).map(|i| (tail[at + i] - decoded[10 * 2048 + at + i]).abs()).fold(0.0, f32::max);
        assert!(error < 1e-3, "{error}");
    }

    #[test]
    fn a_magic_cookie_wraps_the_config() {
        let cookie = magic_cookie(&[0x11, 0x90]);
        assert_eq!(cookie[0], 0x03);
        assert_eq!(&cookie[cookie.len() - 8..cookie.len() - 6], [0x11, 0x90]);
    }
}
