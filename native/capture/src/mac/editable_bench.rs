//! `pnpm bench:editable`'s recordings (plan 087, step 1): one recording of synthetic capture through the session's own
//! core, encoders and writer, in today's mode or the editable one, at real time, so a sampler outside can read its CPU
//! and memory and that of VideoToolbox's encoder service. No ScreenCaptureKit, camera or microphone is opened: pictures come from
//! a ring of prepared 4:2:0 frames handed over 60 times a second, as a 60 Hz display delivers a moving screen; the
//! camera's from a ring of 1280×720 frames 30 times a second; and two inputs' sound in 10 ms buffers. Making the
//! frames costs nothing while recording, so what differs between the modes is what each does with them:
//!
//! - `direct`: today's recording with a camera: the camera composed into every screen frame on the GPU, every slot
//!   encoded, both inputs mixed into one sound track.
//! - `editable`: the screen alone at today's pace, the camera on its own track, each input on its own sound track.
//!
//! Set `EDITABLE_BENCH_MODE`, `EDITABLE_BENCH_SECONDS` and `EDITABLE_BENCH_OUT` (the file); prints
//! `EDITABLE_BENCH_RECORDING` when the recording starts and `EDITABLE_BENCH {json}` at its end. Ignored unless asked
//! for: `cargo test --release --lib editable_bench -- --ignored`. The camera track's tests that need the session's own
//! types and these synthetic frames are here too.

use std::ptr::{NonNull, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use objc2_core_foundation::{CFDictionary, CFRetained, CFString, CFType};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferCreate, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane, CVPixelBufferGetHeightOfPlane,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress, kCVPixelBufferIOSurfacePropertiesKey,
};

use super::*;
use crate::camera_layout::Layout;
use crate::mux::parse::parse;
use crate::timing::NANOS_PER_SECOND;
use crate::writer::WriteFailure;

const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const FRAME_RATE: u32 = 30;
/// RecordStuff's Standard quality at 1080p30 (src/shared/quality.ts's videoBitsPerSecond), and its sound's rate.
const VIDEO_BITRATE: u32 = 12_000_000;
const AUDIO_BITRATE: u32 = 256_000;
/// Frames in each ring: enough that consecutive frames always differ.
const RING: usize = 12;

#[derive(Default)]
struct Counted {
    failures: Mutex<Vec<String>>,
    camera_lost: AtomicU64,
}

impl Events for Counted {
    fn progress(&self, _bytes: u64) {}
    fn write_failed(&self, failure: WriteFailure) {
        self.failures.lock().unwrap().push(format!("{}: {}", failure.code, failure.detail));
    }
    fn capture_failed(&self, code: &'static str, detail: String) {
        self.failures.lock().unwrap().push(format!("{code}: {detail}"));
    }
    fn microphone_lost(&self, detail: String) {
        self.failures.lock().unwrap().push(format!("microphone lost: {detail}"));
    }
    fn microphone_resumed(&self, _detail: String) {}
    fn camera_lost(&self, _detail: String) {
        self.camera_lost.fetch_add(1, Ordering::Relaxed);
    }
}

/// A 4:2:0 frame with a bright bar `n` steps across a dark field and a shade that changes with `n`.
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
        for row in 0..CVPixelBufferGetHeightOfPlane(&buffer, plane) {
            let line = unsafe { std::slice::from_raw_parts_mut(base.add(row * stride), stride) };
            for (x, value) in line.iter_mut().enumerate() {
                *value = if plane == 1 {
                    (112 + (n * 3 + row / 8) % 32) as u8
                } else if (x + n * width / RING) % width < width / 10 {
                    220
                } else {
                    (40 + (x / 16 + row / 16 + n) % 40) as u8
                };
            }
        }
    }
    unsafe { CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
    buffer
}

#[test]
#[ignore = "pnpm bench:editable runs it"]
fn editable_bench() {
    let Ok(mode) = std::env::var("EDITABLE_BENCH_MODE") else { return };
    let editable = match mode.as_str() {
        "direct" => false,
        "editable" => true,
        other => panic!("EDITABLE_BENCH_MODE {other:?} is neither direct nor editable"),
    };
    let seconds: u64 = std::env::var("EDITABLE_BENCH_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
    let path = std::path::PathBuf::from(std::env::var("EDITABLE_BENCH_OUT").expect("EDITABLE_BENCH_OUT"));

    let screens: Vec<Frame> = (0..RING).map(|n| Frame { image: frame(WIDTH as usize, HEIGHT as usize, n) }).collect();
    let cameras: Vec<crate::mac::camera::Image> =
        (0..RING).map(|n| crate::mac::camera::Image(frame(camera_track::WIDTH as usize, camera_track::HEIGHT as usize, RING - 1 - n))).collect();

    let events = Arc::new(Counted::default());
    let file = std::fs::File::create(&path).unwrap();
    let core = Core::<Mac>::new(events.clone(), FRAME_RATE, AUDIO_BITRATE, 2, file);
    core.separate_sound(editable);
    core.watch_microphone(1);
    let feed = Arc::new(crate::mac::camera::Feed::default());
    let compositor = Arc::new(Compositor::new(WIDTH, HEIGHT, Layout::default(), feed.clone()).unwrap());
    let track = editable.then(|| {
        let track = CameraTrack::new(&core.shared(), FRAME_RATE, camera_track::bitrate(WIDTH, HEIGHT, VIDEO_BITRATE)).unwrap();
        core.camera_track(track.spec.clone());
        track
    });
    if !editable {
        core.encode_every_slot(true);
    }
    let encoding_compositor = (!editable).then(|| compositor.clone());
    let composition = Composition::new(core.shared().events(), Some(feed.clone()));
    let made = core
        .make_encoders(move |sink, tracks| {
            let encoder = VideoEncoder::new(WIDTH, HEIGHT, FRAME_RATE, VIDEO_BITRATE, sink)?;
            let audio = (0..tracks).map(|_| AacEncoder::new(SAMPLE_RATE, CHANNELS, AUDIO_BITRATE)).collect::<Result<Vec<_>, _>>()?;
            Ok((Video { encoder, compositor: encoding_compositor, composition, diagnostics: None }, audio))
        })
        .unwrap();
    Core::<Mac>::encoders_made(made).unwrap();

    let running = Arc::new(AtomicBool::new(true));
    let shared = core.shared();
    // The camera at 30 fps, from before the recording, as an opened camera delivers.
    let camera_thread = {
        let (running, feed, events) = (running.clone(), feed.clone(), events.clone());
        std::thread::spawn(move || {
            let mut n = 0;
            let interval = Duration::from_nanos(NANOS_PER_SECOND / 30);
            let mut due = Instant::now();
            while running.load(Ordering::Acquire) {
                let now = now_ns();
                feed.deliver(cameras[n % RING].clone(), now, now, &*events);
                n += 1;
                due += interval;
                std::thread::sleep(due.saturating_duration_since(Instant::now()));
            }
        })
    };
    // The screen at 60 Hz.
    let screen_thread = {
        let (running, shared) = (running.clone(), shared.clone());
        std::thread::spawn(move || {
            let mut n = 0;
            let interval = Duration::from_nanos(NANOS_PER_SECOND / 60);
            let mut due = Instant::now();
            while running.load(Ordering::Acquire) {
                shared.frame(screens[n % RING].clone(), now_ns());
                n += 1;
                due += interval;
                std::thread::sleep(due.saturating_duration_since(Instant::now()));
            }
        })
    };
    core.first_frame(Duration::from_secs(3)).unwrap();
    let mut core = core;
    let began = Instant::now();
    core.record().unwrap();
    // The runner's sampler judges from here.
    println!("EDITABLE_BENCH_RECORDING");
    std::io::Write::flush(&mut std::io::stdout()).unwrap();
    let camera_recording = track.as_ref().map(|track| track.start(shared.clone(), feed.clone(), FRAME_RATE, Arc::new(AtomicBool::new(false))).unwrap());
    // Two inputs' sound, 10 ms at a time, stamped as captured: a tone each, the microphone's quieter.
    let t0 = now_ns();
    let mut next = 0u64;
    while began.elapsed() < Duration::from_secs(seconds) {
        while t0 + (next + 480) * NANOS_PER_SECOND / 48_000 <= now_ns() {
            let at = t0 + next * NANOS_PER_SECOND / 48_000;
            let tone = |hz: f32, level: f32| {
                move |frame: usize, _channel: usize| ((next as usize + frame) as f32 * hz * std::f32::consts::TAU / 48_000.0).sin() * level
            };
            shared.sound(0, at, 480, tone(440.0, 0.2)).unwrap();
            shared.sound(1, at, 480, tone(660.0, 0.1)).unwrap();
            next += 480;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let stop_ns = now_ns();
    let drained = core.drain(stop_ns);
    core.halt();
    if let Some(recording) = camera_recording {
        recording.stop();
    }
    core.halted();
    let (_, finishing) = core.end(stop_ns, drained);
    let finished = finishing.wait().unwrap();
    let recorded = began.elapsed();
    running.store(false, Ordering::Release);
    screen_thread.join().unwrap();
    camera_thread.join().unwrap();

    let parsed = parse(&std::fs::read(&path).unwrap()).unwrap();
    let tracks: Vec<String> = parsed
        .tracks
        .iter()
        .map(|track| {
            let bytes: u64 = track.samples.iter().map(|s| s.data.len() as u64).sum();
            format!(
                r#"{{"descriptions":{:?},"samples":{},"bytes":{bytes},"seconds":{:.3},"enabled":{}}}"#,
                track.descriptions,
                track.samples.len(),
                track.duration as f64 / f64::from(track.timescale),
                track.enabled
            )
        })
        .collect();
    let failures = events.failures.lock().unwrap().clone();
    println!(
        r#"EDITABLE_BENCH {{"mode":"{mode}","seconds":{:.3},"fileBytes":{},"fragmented":{},"cameraLost":{},"failures":{failures:?},"tracks":[{}]}}"#,
        recorded.as_secs_f64(),
        finished.bytes,
        finished.fragmented.is_some(),
        events.camera_lost.load(Ordering::Relaxed),
        tracks.join(",")
    );
    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(parsed.tracks.len(), if editable { 4 } else { 2 });
}

/// Codex's first review of plan 087 (finding 1): hidden, the camera's track is black on the clock, whether the camera
/// delivers or not; a camera that stalled before it was hidden must not leave its last picture in the hidden time.
#[test]
fn a_hidden_camera_s_track_is_black_on_the_clock_even_when_the_camera_delivers_nothing() {
    let path = std::env::temp_dir().join(format!("recordstuff-hidden-camera-{}.mp4", std::process::id()));
    let events = Arc::new(Counted::default());
    let mut core = Core::<Mac>::new(events.clone(), FRAME_RATE, AUDIO_BITRATE, 0, std::fs::File::create(&path).unwrap());
    let feed = Arc::new(crate::mac::camera::Feed::default());
    let track = CameraTrack::new(&core.shared(), FRAME_RATE, 2_000_000).unwrap();
    core.camera_track(track.spec.clone());
    let composition = Composition::new(core.shared().events(), None);
    let made = core
        .make_encoders(move |sink, tracks| {
            let encoder = VideoEncoder::new(640, 360, FRAME_RATE, 1_000_000, sink)?;
            let audio = (0..tracks).map(|_| AacEncoder::new(SAMPLE_RATE, CHANNELS, AUDIO_BITRATE)).collect::<Result<Vec<_>, _>>()?;
            Ok((Video { encoder, compositor: None, composition, diagnostics: None }, audio))
        })
        .unwrap();
    Core::<Mac>::encoders_made(made).unwrap();
    core.shared().frame(Frame { image: frame(640, 360, 0) }, now_ns());
    core.record().unwrap();
    let hidden = Arc::new(AtomicBool::new(true));
    let recording = track.start(core.shared(), feed, FRAME_RATE, hidden).unwrap();
    std::thread::sleep(Duration::from_millis(1_300));
    let stop_ns = now_ns();
    let drained = core.drain(stop_ns);
    core.halt();
    recording.stop();
    core.halted();
    let (_, finishing) = core.end(stop_ns, drained);
    finishing.wait().unwrap();
    let parsed = parse(&std::fs::read(&path).unwrap()).unwrap();
    let camera = parsed.tracks.last().unwrap();
    // No camera frame ever came: black at the start and again a second later.
    assert_eq!(camera.samples.len(), 2, "{} samples", camera.samples.len());
    assert!(camera.samples[0].sync && camera.samples[0].decode_time == 0);
    assert!(events.failures.lock().unwrap().is_empty());
    std::fs::remove_file(&path).unwrap();
}

/// A camera whose frames are not the 720p preset's (an iPhone's Continuity Camera gives 1920×1080, found by plan 087's
/// first desktop round): its frames are scaled into the track, not left out.
#[test]
fn a_camera_of_another_size_is_scaled_into_the_track() {
    let path = std::env::temp_dir().join(format!("recordstuff-camera-size-{}.mp4", std::process::id()));
    let events = Arc::new(Counted::default());
    let mut core = Core::<Mac>::new(events.clone(), FRAME_RATE, AUDIO_BITRATE, 0, std::fs::File::create(&path).unwrap());
    let feed = Arc::new(crate::mac::camera::Feed::default());
    let track = CameraTrack::new(&core.shared(), FRAME_RATE, 2_000_000).unwrap();
    core.camera_track(track.spec.clone());
    let composition = Composition::new(core.shared().events(), None);
    let made = core
        .make_encoders(move |sink, tracks| {
            let encoder = VideoEncoder::new(640, 360, FRAME_RATE, 1_000_000, sink)?;
            let audio = (0..tracks).map(|_| AacEncoder::new(SAMPLE_RATE, CHANNELS, AUDIO_BITRATE)).collect::<Result<Vec<_>, _>>()?;
            Ok((Video { encoder, compositor: None, composition, diagnostics: None }, audio))
        })
        .unwrap();
    Core::<Mac>::encoders_made(made).unwrap();
    core.shared().frame(Frame { image: frame(640, 360, 0) }, now_ns());
    core.record().unwrap();
    let recording = track.start(core.shared(), feed.clone(), FRAME_RATE, Arc::new(AtomicBool::new(false))).unwrap();
    let large: Vec<crate::mac::camera::Image> = (0..RING).map(|n| crate::mac::camera::Image(frame(1920, 1080, n))).collect();
    for n in 0..30 {
        let now = now_ns();
        feed.deliver(large[n % RING].clone(), now, now, &*events);
        std::thread::sleep(Duration::from_millis(33));
    }
    let stop_ns = now_ns();
    let drained = core.drain(stop_ns);
    core.halt();
    recording.stop();
    core.halted();
    let (_, finishing) = core.end(stop_ns, drained);
    finishing.wait().unwrap();
    let parsed = parse(&std::fs::read(&path).unwrap()).unwrap();
    let camera = parsed.tracks.last().unwrap();
    assert!(camera.samples.len() >= 25, "{} samples", camera.samples.len());
    assert_eq!(events.camera_lost.load(Ordering::Relaxed), 0);
    if let Ok(keep) = std::env::var("RECORDSTUFF_CAMERA_SIZE_OUT") {
        std::fs::copy(&path, keep).unwrap();
    }
    std::fs::remove_file(&path).unwrap();
}
