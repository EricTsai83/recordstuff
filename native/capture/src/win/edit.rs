//! An export's decoders and encoders on Windows (plan 085): Microsoft's H.264 decoder transform decodes a group of
//! pictures from its key frame to NV12 in memory, which the recording's software encoder (video.rs) encodes again at
//! the source's level; Microsoft's AAC decoder transform decodes the sound windows, which the recording's AAC encoder
//! (aac.rs) encodes again. Software throughout: at most a second of pictures a join, and no GPU to share with capture.
//!
//! Checked by CI only (its `cargo test --lib` runs this module's tests on a Windows runner); no maintainer machine
//! runs Windows.

use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::core::{GUID, Interface};

use super::aac::AacEncoder;
use super::mft::{bytes, outputs, pack, sample, set_codec_flag};
use super::{com, media_foundation};
use crate::avc;
use crate::core::AudioEncode;
use crate::edit::remux::{AudioFormat, Codecs, Reencoded, VideoFormat};
use crate::writer::AAC_FRAMES;

/// CLSID_CMSAACDecMFT (wmcodecdsp.h).
const CLSID_AAC_DECODER: GUID = GUID::from_u128(0x32d186a7_218f_4c75_8876_dd77273a8999);

#[derive(Default)]
pub struct WinCodecs;

fn failing(what: &'static str) -> impl Fn(windows::core::Error) -> String {
    move |error| format!("{what}: {error}")
}

/// The H.264 decoder set up for `format`, putting out NV12 as each picture goes in.
fn h264_decoder(format: &VideoFormat) -> Result<IMFTransform, String> {
    com();
    media_foundation().map_err(|e| e.detail)?;
    let decoder: IMFTransform = unsafe { CoCreateInstance(&CLSID_MSH264DecoderMFT, None, CLSCTX_INPROC_SERVER) }.map_err(failing("the H.264 decoder"))?;
    if let Ok(codec) = decoder.cast::<ICodecAPI>() {
        // Each picture out as it goes in, as the encoder never reorders.
        set_codec_flag(&codec, &CODECAPI_AVLowLatencyMode, true);
    }
    unsafe {
        let input = MFCreateMediaType().map_err(failing("a media type"))?;
        input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(failing("the decoder's input"))?;
        input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(failing("the decoder's input"))?;
        input.SetUINT64(&MF_MT_FRAME_SIZE, pack(u32::from(format.width), u32::from(format.height))).map_err(failing("the decoder's input"))?;
        decoder.SetInputType(0, &input, 0).map_err(failing("the decoder's input"))?;
        nv12_output(&decoder)?;
        decoder.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).map_err(failing("starting the decoder"))?;
    }
    Ok(decoder)
}

fn nv12_output(decoder: &IMFTransform) -> Result<(), String> {
    let mut index = 0;
    loop {
        let offered = unsafe { decoder.GetOutputAvailableType(0, index) }.map_err(failing("the decoder offers no NV12"))?;
        if unsafe { offered.GetGUID(&MF_MT_SUBTYPE) }.ok() == Some(MFVideoFormat_NV12) {
            return unsafe { decoder.SetOutputType(0, &offered, 0) }.map_err(failing("the decoder's output"));
        }
        index += 1;
    }
}

/// A decoded picture as tightly packed NV12 of `width` × `height`: the decoder's buffer has its rows at the width it
/// decodes to and its height rounded up to whole macroblocks.
fn packed(decoder: &IMFTransform, data: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
    if data.len() == width * height * 3 / 2 {
        return Ok(data.to_vec());
    }
    let current = unsafe { decoder.GetOutputCurrentType(0) }.map_err(failing("the decoder's output"))?;
    let size = unsafe { current.GetUINT64(&MF_MT_FRAME_SIZE) }.map_err(failing("the decoder's picture size"))?;
    let (stride, rows) = ((size >> 32) as usize, (size & 0xffff_ffff) as usize);
    let stride = unsafe { current.GetUINT32(&MF_MT_DEFAULT_STRIDE) }.map(|s| (s as i32).unsigned_abs() as usize).unwrap_or(stride).max(width);
    let rows = if data.len() >= stride * rows * 3 / 2 { rows } else { data.len() * 2 / 3 / stride };
    if rows < height || data.len() < stride * rows + stride * height / 2 {
        return Err(format!("a decoded picture of {} bytes for {width}x{height}", data.len()));
    }
    let mut out = Vec::with_capacity(width * height * 3 / 2);
    for row in 0..height {
        out.extend_from_slice(&data[row * stride..row * stride + width]);
    }
    let chroma = stride * rows;
    for row in 0..height / 2 {
        out.extend_from_slice(&data[chroma + row * stride..chroma + row * stride + width]);
    }
    Ok(out)
}

/// Decodes a group of pictures (from a key frame) one sample at a time, giving its packed NV12 pictures from `from` on as
/// they come, so the encoder takes each before the next is decoded: a run's pictures never wait in memory together.
struct Pictures<'a> {
    decoder: IMFTransform,
    format: &'a VideoFormat,
    group: &'a [Vec<u8>],
    from: usize,
    next_sample: usize,
    drained: bool,
    produced: usize,
    ready: std::collections::VecDeque<Vec<u8>>,
}

impl<'a> Pictures<'a> {
    fn new(format: &'a VideoFormat, group: &'a [Vec<u8>], from: usize) -> Result<Self, String> {
        Ok(Self { decoder: h264_decoder(format)?, format, group, from, next_sample: 0, drained: false, produced: 0, ready: Default::default() })
    }

    fn take(&mut self, samples: Vec<IMFSample>) -> Result<(), String> {
        let (width, height) = (usize::from(self.format.width), usize::from(self.format.height));
        for picture in samples {
            let (data, _) = bytes(&picture).map_err(failing("reading a picture"))?;
            if self.produced >= self.from {
                self.ready.push_back(packed(&self.decoder, &data, width, height)?);
            }
            self.produced += 1;
        }
        Ok(())
    }

    /// The next kept picture, decoding as few samples as it takes; none once the group is done.
    fn next_picture(&mut self) -> Result<Option<Vec<u8>>, String> {
        let (width, height) = (usize::from(self.format.width), usize::from(self.format.height));
        let picture_bytes = (width * (height + 15) / 16 * 16 * 3 / 2) as u32;
        loop {
            if let Some(picture) = self.ready.pop_front() {
                return Ok(Some(picture));
            }
            if self.drained {
                if self.produced != self.group.len() {
                    return Err(format!("the decoder returned {} pictures for {}", self.produced, self.group.len()));
                }
                return Ok(None);
            }
            if let Some(data) = self.group.get(self.next_sample) {
                let n = self.next_sample;
                self.next_sample += 1;
                let stream = avc::annex_b(&self.format.avcc, data, n == 0).ok_or("a sample could not be read back")?;
                let input = sample(&stream, n as i64 * 333_333, 333_333).map_err(failing("a decoder sample"))?;
                unsafe { self.decoder.ProcessInput(0, &input, 0) }.map_err(failing("decoding"))?;
                let out = outputs(&self.decoder, picture_bytes).map_err(failing("decoding"))?;
                self.take(out)?;
            } else {
                unsafe { self.decoder.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0) }.map_err(failing("draining the decoder"))?;
                let out = outputs(&self.decoder, picture_bytes).map_err(failing("decoding"))?;
                self.take(out)?;
                self.drained = true;
            }
        }
    }
}

/// Decodes `group` (from a key frame) to packed NV12, keeping the pictures from `from` on: for tests, which compare them.
#[cfg(test)]
fn decode_pictures(format: &VideoFormat, group: &[Vec<u8>], from: usize) -> Result<Vec<Vec<u8>>, String> {
    let mut pictures = Pictures::new(format, group, from)?;
    let mut out = Vec::new();
    while let Some(picture) = pictures.next_picture()? {
        out.push(picture);
    }
    Ok(out)
}

impl Codecs for WinCodecs {
    fn reencode(&mut self, format: &VideoFormat, group: &[Vec<u8>], from: usize, durations: &[u32], bitrate: u32) -> Result<Reencoded, String> {
        let mut pictures = Pictures::new(format, group, from)?;
        let frame_rate = format.frame_rate;
        let mut pts_ticks = 0u64;
        let mut index = 0usize;
        // Pulled by the encoder's loop one at a time: each picture is decoded only when the encoder wants it.
        let timed = std::iter::from_fn(|| {
            let duration = *durations.get(index)?;
            index += 1;
            Some(pictures.next_picture().and_then(|picture| {
                let picture = picture.ok_or("the decoder returned fewer pictures than the run holds")?;
                let pts_ns = (u128::from(pts_ticks) * 1_000_000_000 / u128::from(format.timescale)) as u64;
                pts_ticks += u64::from(duration);
                Ok((picture, pts_ns))
            }))
        });
        let (avcc, samples) =
            super::video::encode_pictures(u32::from(format.width), u32::from(format.height), frame_rate, bitrate, format.avcc.get(3).copied(), timed)?;
        if samples.len() != durations.len() {
            return Err(format!("{} pictures came back from the encoder for {}", samples.len(), durations.len()));
        }
        Ok(Reencoded { avcc, samples })
    }

    fn decode_audio(&mut self, format: &AudioFormat, packets: &[Vec<u8>]) -> Result<Vec<f32>, String> {
        decode_aac(format, packets)
    }

    fn audio_encoder(&mut self, format: &AudioFormat, bitrate: u32) -> Result<Box<dyn AudioEncode>, String> {
        com();
        let encoder = AacEncoder::new(format.sample_rate, u32::from(format.channels), bitrate).map_err(|e| e.detail)?;
        Ok(Box::new(encoder))
    }
}

/// Decodes consecutive AAC packets to interleaved float frames, `AAC_FRAMES` a packet.
fn decode_aac(format: &AudioFormat, packets: &[Vec<u8>]) -> Result<Vec<f32>, String> {
    com();
    media_foundation().map_err(|e| e.detail)?;
    let channels = usize::from(format.channels);
    let decoder: IMFTransform = unsafe { CoCreateInstance(&CLSID_AAC_DECODER, None, CLSCTX_INPROC_SERVER) }.map_err(failing("the AAC decoder"))?;
    // HEAACWAVEINFO's fields after WAVEFORMATEX (raw AAC, no profile given), then the AudioSpecificConfig.
    let mut user_data = vec![0u8, 0, 0xfe, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    user_data.extend_from_slice(&format.config);
    let float = unsafe {
        let input = MFCreateMediaType().map_err(failing("a media type"))?;
        input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(failing("the AAC decoder's input"))?;
        input.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(failing("the AAC decoder's input"))?;
        input.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, format.sample_rate).map_err(failing("the AAC decoder's input"))?;
        input.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, u32::from(format.channels)).map_err(failing("the AAC decoder's input"))?;
        input.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(failing("the AAC decoder's input"))?;
        input.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0).map_err(failing("the AAC decoder's input"))?;
        input.SetBlob(&MF_MT_USER_DATA, &user_data).map_err(failing("the AAC decoder's input"))?;
        decoder.SetInputType(0, &input, 0).map_err(failing("the AAC decoder refused the format"))?;
        // Float when offered, else 16-bit PCM, converted below.
        let mut chosen = None;
        let mut index = 0;
        while let Ok(offered) = decoder.GetOutputAvailableType(0, index) {
            let subtype = offered.GetGUID(&MF_MT_SUBTYPE).ok();
            if subtype == Some(MFAudioFormat_Float) {
                chosen = Some((offered, true));
                break;
            }
            if subtype == Some(MFAudioFormat_PCM) && chosen.is_none() {
                chosen = Some((offered, false));
            }
            index += 1;
        }
        let (output, float) = chosen.ok_or("the AAC decoder offers no PCM")?;
        decoder.SetOutputType(0, &output, 0).map_err(failing("the AAC decoder's output"))?;
        decoder.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).map_err(failing("starting the AAC decoder"))?;
        float
    };
    let frame_time = |n: usize| (n as u64 * u64::from(AAC_FRAMES) * 10_000_000 / u64::from(format.sample_rate)) as i64;
    let packet_bytes = (AAC_FRAMES as usize * channels * 4) as u32;
    let mut out: Vec<f32> = Vec::with_capacity(packets.len() * AAC_FRAMES as usize * channels);
    let take = |samples: Vec<IMFSample>, out: &mut Vec<f32>| -> Result<(), String> {
        for decoded in samples {
            let (data, _) = bytes(&decoded).map_err(failing("reading decoded sound"))?;
            if float {
                out.extend(data.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)));
            } else {
                out.extend(data.as_chunks::<2>().0.iter().map(|b| f32::from(i16::from_le_bytes(*b)) / 32768.0));
            }
        }
        Ok(())
    };
    for (n, packet) in packets.iter().enumerate() {
        let input = sample(packet, frame_time(n), frame_time(n + 1) - frame_time(n)).map_err(failing("a sound sample"))?;
        unsafe { decoder.ProcessInput(0, &input, 0) }.map_err(failing("decoding sound"))?;
        take(outputs(&decoder, packet_bytes).map_err(failing("decoding sound"))?, &mut out)?;
    }
    unsafe { decoder.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0) }.map_err(failing("draining the AAC decoder"))?;
    take(outputs(&decoder, packet_bytes).map_err(failing("decoding sound"))?, &mut out)?;
    let expected = packets.len() * AAC_FRAMES as usize * channels;
    if out.len() < expected {
        // A decoder that held its first packet back: the frames it never gave are at the start.
        let mut padded = vec![0f32; expected - out.len()];
        padded.extend(out);
        out = padded;
    }
    out.truncate(expected);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use crate::edit::control::Control;

    use super::*;
    use crate::edit::remux::{self, JoinPolicy};
    use crate::edit::source;
    use crate::mux::mp4::{Codec, HybridMp4, Sample, TrackConfig};

    fn sweep(frames: usize) -> Vec<f32> {
        (0..frames * 2)
            .map(|n| {
                let t = (n / 2) as f64 / 48_000.0;
                ((std::f64::consts::TAU * (200.0 * t + 1900.0 * t * t)).sin() * 0.4) as f32
            })
            .collect()
    }

    #[test]
    fn decoded_sound_lines_up_with_the_encoder_s_priming() {
        com();
        let mut encoder = AacEncoder::new(48_000, 2, 192_000).unwrap();
        let original = sweep(48_000);
        encoder.push(&original);
        let mut packets = Vec::new();
        encoder.finish(&mut |p| packets.push(p)).unwrap();
        let format = AudioFormat { config: encoder.audio_specific_config(), sample_rate: 48_000, channels: 2 };
        let decoded = decode_aac(&format, &packets).unwrap();
        assert_eq!(decoded.len(), packets.len() * 1024 * 2);
        let error = |lag: usize| -> f64 {
            (0..4096).map(|i| f64::from(decoded.get((lag + 2000 + i) * 2).copied().unwrap_or(9.0) - original[(2000 + i) * 2]).powi(2)).sum()
        };
        let lag = (0..4096).min_by(|&a, &b| error(a).total_cmp(&error(b))).unwrap();
        assert_eq!(lag, encoder.priming() as usize, "decoded sound is {lag} frames after its source, the priming is {}", encoder.priming());
    }

    /// NV12 with a moving texture.
    fn picture(width: usize, height: usize, frame: usize) -> Vec<u8> {
        let mut data = Vec::with_capacity(width * height * 3 / 2);
        for y in 0..height {
            for x in 0..width {
                data.push(40 + (((x + 3 * frame) / 4 + y / 4 + (x * y + frame * 7) % 9) % 120) as u8);
            }
        }
        for _ in 0..height / 2 {
            for x in 0..width {
                data.push(128 + (((x / 2 + frame) % 32) as u8));
            }
        }
        data
    }

    fn psnr(a: &[u8], b: &[u8]) -> f64 {
        let mse = a.iter().zip(b).map(|(&x, &y)| (f64::from(x) - f64::from(y)).powi(2)).sum::<f64>() / a.len() as f64;
        if mse == 0.0 { f64::INFINITY } else { 10.0 * (255.0f64 * 255.0 / mse).log10() }
    }

    #[test]
    fn a_smart_cut_join_shows_the_requested_frame() {
        com();
        let (width, height, fps) = (1280u32, 720u32, 30u32);
        let frames = 90usize;
        let pictures = (0..frames).map(|n| Ok((picture(width as usize, height as usize, n), n as u64 * 1_000_000_000 / u64::from(fps))));
        let (avcc, samples) = super::super::video::encode_pictures(width, height, fps, 4_000_000, None, pictures).unwrap();
        assert_eq!(samples.len(), frames);
        let mut encoder = AacEncoder::new(48_000, 2, 192_000).unwrap();
        encoder.push(&sweep(3 * 48_000));
        let mut packets = Vec::new();
        encoder.finish(&mut |p| packets.push(p)).unwrap();
        let dir = std::env::temp_dir().join(format!("recordstuff-export-win-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("source.mp4");
        let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&path).unwrap();
        let video = TrackConfig { codec: Codec::H264 { avcc: avcc.clone(), width: width as u16, height: height as u16 }, timescale: 90_000, skip: 0 };
        let audio = TrackConfig {
            codec: Codec::Aac { config: encoder.audio_specific_config(), sample_rate: 48_000, channels: 2, average_bitrate: 192_000, max_bitrate: 192_000 },
            timescale: 48_000,
            skip: encoder.priming(),
        };
        let mut mp4 = HybridMp4::create(file, vec![video, audio]).unwrap();
        let video_samples: Vec<Sample> = samples.iter().map(|(d, s)| Sample { data: d, duration: 3000, sync: *s }).collect();
        mp4.write_fragment(0, &video_samples).unwrap();
        let audio_samples: Vec<Sample> = packets.iter().map(|d| Sample { data: d, duration: 1024, sync: true }).collect();
        mp4.write_fragment(1, &audio_samples).unwrap();
        mp4.set_presented(1, 3 * 48_000);
        mp4.finish().unwrap();
        let before = std::fs::read(&path).unwrap();
        let output = dir.join("out.mp4");
        let cancel = Control::new(false);
        // Remove 0.5 s .. 1.5 s: the part resumes at frame 45, inside the group from 30.
        let report = remux::export(&path, &output, &[(45_000, 135_000)], JoinPolicy::Auto, &mut WinCodecs, &mut |_| {}, &cancel).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(report.plan.parts[1].reencode.is_some());
        let out_bytes = std::fs::read(&output).unwrap();
        let out = crate::mux::parse::parse(&out_bytes).unwrap();
        let format = VideoFormat { avcc: avcc.clone(), width: width as u16, height: height as u16, timescale: 90_000, frame_rate: fps };
        let source_pictures = decode_pictures(&format, &samples.iter().map(|s| s.0.clone()).collect::<Vec<_>>(), 0).unwrap();
        // The re-encoded run, decoded with its own description.
        let run: Vec<Vec<u8>> = out.tracks[0].samples[15..30].iter().map(|s| s.data.clone()).collect();
        let alternate =
            if report.second_description { WinCodecs.reencode(&format, &[samples[0].0.clone()], 0, &[3000], 4_000_000).unwrap().avcc } else { avcc.clone() };
        let format_out = VideoFormat { avcc: alternate, ..format };
        let decoded = decode_pictures(&format_out, &run, 0).unwrap();
        let quality = psnr(&decoded[0], &source_pictures[45]);
        eprintln!("first picture after the join: {quality:.1} dB; second description: {}", report.second_description);
        assert!(quality >= 40.0, "{quality}");
        assert!(source::read(&before).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
