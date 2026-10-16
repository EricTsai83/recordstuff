//! The encoding and writing half of a recording without capture, as mac/pipeline_test.rs is on macOS: synthetic NV12
//! frames through Media Foundation's H.264 encoder and a tone through its AAC encoder into the writer, then the
//! finished file read back. Needs no desktop or audio device, so it runs on CI's Windows runner. Set
//! `RECORDSTUFF_SYNTHETIC_OUT` to a path to keep the file for a decoder to check.

use std::sync::{Arc, Mutex};

use super::aac::AacEncoder;
use super::capture::Gpu;
use super::video::H264Encoder;
use crate::core::{AudioEncode, VideoEncode, VideoSink};
use crate::mux::parse::parse;
use crate::timing::NANOS_PER_SECOND;
use crate::writer::{self, AudioSpec, Media, WriterConfig};

struct Collect(Mutex<Vec<Media>>);

impl VideoSink for Collect {
    fn media(&self, media: Media) {
        self.0.lock().unwrap().push(media);
    }
    fn failed(&self, detail: String) {
        panic!("encoder failed: {detail}");
    }
}

/// A bar moving across a grey field, so consecutive frames differ.
fn frame(width: usize, height: usize, n: usize) -> Vec<u8> {
    let mut data = vec![128u8; width * height * 3 / 2];
    for row in 0..height {
        for x in 0..width {
            data[row * width + x] = if (x + n * 8) % width < 40 { 235 } else { 64 };
        }
    }
    data
}

#[test]
fn synthetic_frames_and_tone_become_a_plain_mp4() {
    super::com();
    let (width, height) = (640usize, 360usize);
    let sink = Arc::new(Collect(Mutex::new(Vec::new())));
    let gpu = Gpu::new().unwrap();
    let encoder = H264Encoder::new(gpu, width as u32, height as u32, 30, 2_000_000, sink.clone()).unwrap();
    let t0 = 1_000 * NANOS_PER_SECOND;
    for n in 0..90 {
        let pts = t0 + n as u64 * NANOS_PER_SECOND / 30;
        encoder.queue(frame(width, height, n), pts, n == 0).unwrap();
    }
    encoder.flush();
    drop(encoder);

    let mut aac = AacEncoder::new(48_000, 2, 256_000).unwrap();
    assert_eq!(aac.bitrate, 192_000, "lowered to what the encoder takes");
    assert!(aac.priming < 4096, "priming {}", aac.priming);
    let tone: Vec<f32> = (0..48_000 * 3 * 2).map(|n| ((n / 2) as f32 * 1000.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.25).collect();
    aac.push(&tone);
    let mut packets = Vec::new();
    aac.finish(&mut |packet| packets.push(packet)).unwrap();
    // Every input frame and the priming, the last packet padded.
    assert_eq!(packets.len(), (48_000 * 3 + aac.priming as usize).div_ceil(1024), "{} packets, priming {}", packets.len(), aac.priming);

    let path = std::env::var("RECORDSTUFF_SYNTHETIC_OUT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join(format!("recordstuff-synthetic-{}.mp4", std::process::id())));
    let file = std::fs::File::create(&path).unwrap();
    let spec = AudioSpec { config: aac.audio_specific_config(), priming: aac.priming, sample_rate: 48_000, channels: 2, bitrate: aac.bitrate };
    let writer = writer::spawn(WriterConfig { file, t0_ns: t0, audio: Some(spec) }, |_| {}).unwrap();
    let media = std::mem::take(&mut *sink.0.lock().unwrap());
    assert!(matches!(media.first(), Some(Media::VideoFormat { width: 640, height: 360, .. })));
    let samples = media.iter().filter(|m| matches!(m, Media::Video { .. })).count();
    assert_eq!(samples, 90);
    for item in media {
        writer.sender.send(item);
    }
    for data in packets {
        writer.sender.send(Media::Audio { data });
    }
    let report = writer.sender.finish(t0 + 3 * NANOS_PER_SECOND, Some(aac.frames_in())).recv().unwrap().unwrap();
    writer.thread.join().unwrap();
    assert_eq!(report.fragmented, None);

    let bytes = std::fs::read(&path).unwrap();
    let parsed = parse(&bytes).unwrap();
    assert_eq!(parsed.top, ["ftyp", "mdat", "moov"]);
    let video = &parsed.tracks[0];
    assert_eq!(video.samples.len(), 90);
    assert!(video.samples[0].sync);
    // A key frame at least every second.
    assert!(video.samples.iter().filter(|s| s.sync).count() >= 3);
    assert_eq!(video.duration, 270_000);
    // Each sample is length-prefixed NAL units, none of them a parameter set.
    for sample in &video.samples {
        let mut at = 0;
        while at < sample.data.len() {
            let length = u32::from_be_bytes(sample.data[at..at + 4].try_into().unwrap()) as usize;
            assert!(length > 0 && at + 4 + length <= sample.data.len());
            assert!(!matches!(sample.data[at + 4] & 0x1f, 7 | 8 | 9));
            at += 4 + length;
        }
    }
    assert!(parsed.tracks[1].samples.len() >= 140);
    if std::env::var("RECORDSTUFF_SYNTHETIC_OUT").is_err() {
        std::fs::remove_file(&path).unwrap();
    }
}

/// Plan 078 step 4 on CI's runner, which has no GPU: its WARP device lists no hardware encoder, and an encoder made on
/// it is the software one, saying why.
#[test]
fn without_a_gpu_no_hardware_encoder_is_found_and_the_software_encoder_records() {
    super::com();
    let gpu = Gpu::new().unwrap();
    let (adapter, luid) = super::hardware::adapter(&gpu.0).expect("the adapter is read");
    if !adapter.software {
        eprintln!("this machine has a GPU ({}); the no-GPU case is not exercised", adapter.name);
        return;
    }
    assert!(super::hardware::find(luid).unwrap().is_none(), "WARP lists no hardware H.264 encoder");
    let sink = Arc::new(Collect(Mutex::new(Vec::new())));
    let encoder = H264Encoder::new(gpu, 640, 360, 30, 2_000_000, sink).unwrap();
    assert!(encoder.description.contains("software encoder") && encoder.description.contains("WARP"), "{}", encoder.description);
}

/// The self-test's check (plan 078 step 4), against the software encoder CI has: grey frames come back grey through
/// Microsoft's decoder, and black ones, as a broken driver can emit, do not.
#[test]
fn the_self_test_tells_a_grey_picture_from_a_black_one() {
    super::com();
    let (width, height) = (640u32, 360u32);
    let encode = |luma: u8| {
        let sink = Arc::new(Collect(Mutex::new(Vec::new())));
        let encoder = H264Encoder::new(Gpu::new().unwrap(), width, height, 30, 2_000_000, sink.clone()).unwrap();
        let mut data = vec![128u8; (width * height * 3 / 2) as usize];
        data[..(width * height) as usize].fill(luma);
        for n in 0..6u64 {
            encoder.queue(data.clone(), n * NANOS_PER_SECOND / 30, n == 0).unwrap();
        }
        encoder.flush();
        drop(encoder);
        std::mem::take(&mut *sink.0.lock().unwrap())
    };
    let grey = super::hardware::grey_share(&encode(128), width, height).unwrap();
    assert!(grey > 0.95, "grey: {grey}");
    let black = super::hardware::grey_share(&encode(16), width, height).unwrap();
    assert!(black < 0.5, "black: {black}");
}
