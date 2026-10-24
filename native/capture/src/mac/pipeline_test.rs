//! The encoding and writing half of a recording without ScreenCaptureKit: synthetic frames through VideoToolbox and
//! a tone through AudioToolbox into the writer, then the finished file read back. Set `RECORDSTUFF_SYNTHETIC_OUT` to
//! a path to keep the file for a decoder to check.

use std::ptr::{NonNull, null_mut};
use std::sync::{Arc, Mutex};

use objc2_core_foundation::{CFDictionary, CFRetained, CFString, CFType};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferCreate, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane, CVPixelBufferGetHeightOfPlane,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress, kCVPixelBufferIOSurfacePropertiesKey,
};

use super::audio::AacEncoder;
use super::video::{VideoEncoder, VideoSink};
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

fn frame(width: usize, height: usize, n: usize) -> CFRetained<CVPixelBuffer> {
    let surface = CFDictionary::<CFString, CFType>::from_slices(&[], &[]);
    let key: &CFString = unsafe { kCVPixelBufferIOSurfacePropertiesKey };
    let attributes = CFDictionary::<CFString, CFType>::from_slices(&[key], &[surface.as_ref()]);
    let mut buffer: *mut CVPixelBuffer = null_mut();
    let status = unsafe { CVPixelBufferCreate(None, width, height, u32::from_be_bytes(*b"420v"), Some(attributes.as_opaque()), NonNull::from(&mut buffer)) };
    assert_eq!(status, 0);
    let buffer = unsafe { CFRetained::from_raw(NonNull::new(buffer).unwrap()) };
    unsafe { CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
    for plane in 0..2 {
        let base = CVPixelBufferGetBaseAddressOfPlane(&buffer, plane).cast::<u8>();
        let stride = CVPixelBufferGetBytesPerRowOfPlane(&buffer, plane);
        let rows = CVPixelBufferGetHeightOfPlane(&buffer, plane);
        for row in 0..rows {
            let line = unsafe { std::slice::from_raw_parts_mut(base.add(row * stride), stride) };
            for (x, value) in line.iter_mut().enumerate() {
                // A bar moving across a grey field, so consecutive frames differ.
                *value = if plane == 1 {
                    128
                } else if (x + n * 8) % width < 40 {
                    235
                } else {
                    64
                };
            }
        }
    }
    unsafe { CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
    buffer
}

#[test]
fn synthetic_frames_and_tone_become_a_plain_mp4() {
    let (width, height) = (640usize, 360usize);
    let sink = Arc::new(Collect(Mutex::new(Vec::new())));
    let encoder = VideoEncoder::new(width as u32, height as u32, 30, 2_000_000, sink.clone()).unwrap();
    let t0 = 1_000 * NANOS_PER_SECOND;
    for n in 0..90 {
        let pts = t0 + n as u64 * NANOS_PER_SECOND / 30;
        encoder.encode(&frame(width, height, n), pts, n == 0).unwrap();
    }
    encoder.flush();
    drop(encoder);

    let mut aac = AacEncoder::new(48_000, 2, 256_000).unwrap();
    let tone: Vec<f32> = (0..48_000 * 3 * 2).map(|n| ((n / 2) as f32 * 1000.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.25).collect();
    aac.push(&tone);
    let mut packets = Vec::new();
    aac.finish(&mut |packet| packets.push(packet)).unwrap();

    let path = std::env::var("RECORDSTUFF_SYNTHETIC_OUT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join(format!("recordstuff-synthetic-{}.mp4", std::process::id())));
    let file = std::fs::File::create(&path).unwrap();
    let spec = AudioSpec { config: aac.audio_specific_config(), priming: aac.priming, sample_rate: 48_000, channels: 2, bitrate: 256_000 };
    let writer = writer::spawn(WriterConfig { file, t0_ns: t0, audio: vec![spec], camera: None, diagnostics: None }, |_| {}).unwrap();
    let media = std::mem::take(&mut *sink.0.lock().unwrap());
    assert!(matches!(media.first(), Some(Media::VideoFormat { width: 640, height: 360, .. })));
    let samples = media.iter().filter(|m| matches!(m, Media::Video { .. })).count();
    assert_eq!(samples, 90);
    for item in media {
        writer.sender.send(item);
    }
    for data in packets {
        writer.sender.send(Media::Audio { data, track: 0 });
    }
    let report = writer.sender.finish(t0 + 3 * NANOS_PER_SECOND, vec![Some(aac.frames_in)]).recv().unwrap().unwrap();
    writer.thread.join().unwrap();
    assert_eq!(report.fragmented, None);

    let bytes = std::fs::read(&path).unwrap();
    let parsed = parse(&bytes).unwrap();
    assert_eq!(parsed.top, ["ftyp", "mdat", "moov"]);
    let video = &parsed.tracks[0];
    assert_eq!(video.samples.len(), 90);
    assert!(video.samples[0].sync);
    // A key frame at least every second: frames 0, 30 and 60 at the latest.
    assert!(video.samples.iter().filter(|s| s.sync).count() >= 3);
    assert_eq!(video.duration, 270_000);
    assert!(parsed.tracks[1].samples.len() >= 140);
    if std::env::var("RECORDSTUFF_SYNTHETIC_OUT").is_err() {
        std::fs::remove_file(&path).unwrap();
    }
}
