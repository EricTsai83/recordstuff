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
    // Most of the 30 delivered frames, not each: a CI runner's virtual GPU scales them slowly enough to miss a few (24
    // on 2026-10-25); what is checked is that frames of another size reach the track at all, scaled.
    assert!(camera.samples.len() >= 20, "{} samples", camera.samples.len());
    assert_eq!(events.camera_lost.load(Ordering::Relaxed), 0);
    if let Ok(keep) = std::env::var("RECORDSTUFF_CAMERA_SIZE_OUT") {
        std::fs::copy(&path, keep).unwrap();
    }
    std::fs::remove_file(&path).unwrap();
}

/// A 4:2:0 frame of one grey, `luma`.
fn flat(width: usize, height: usize, luma: u8) -> CFRetained<CVPixelBuffer> {
    let surface = CFDictionary::<CFString, CFType>::from_slices(&[], &[]);
    let key: &CFString = unsafe { kCVPixelBufferIOSurfacePropertiesKey };
    let attributes = CFDictionary::<CFString, CFType>::from_slices(&[key], &[surface.as_ref()]);
    let mut buffer: *mut CVPixelBuffer = null_mut();
    let status = unsafe { CVPixelBufferCreate(None, width, height, u32::from_be_bytes(*b"420v"), Some(attributes.as_opaque()), NonNull::from(&mut buffer)) };
    assert_eq!(status, 0);
    let buffer = unsafe { CFRetained::from_raw(NonNull::new(buffer).unwrap()) };
    unsafe { CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
    for (plane, value) in [(0usize, luma), (1, 128)] {
        let base = CVPixelBufferGetBaseAddressOfPlane(&buffer, plane).cast::<u8>();
        let bytes = CVPixelBufferGetBytesPerRowOfPlane(&buffer, plane) * CVPixelBufferGetHeightOfPlane(&buffer, plane);
        unsafe { std::ptr::write_bytes(base, value, bytes) };
    }
    unsafe { CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
    buffer
}

/// An editable recording of `seconds` through the session's own core and encoders: a dark 640×360 screen, a bright
/// camera, a 440 Hz tone as the system's sound and a 660 Hz one as the microphone's.
pub(crate) fn record_editable(path: &std::path::Path, seconds: f64) {
    let events = Arc::new(Counted::default());
    let mut core = Core::<Mac>::new(events.clone(), FRAME_RATE, AUDIO_BITRATE, 2, std::fs::File::create(path).unwrap());
    core.separate_sound(true);
    core.watch_microphone(1);
    let feed = Arc::new(crate::mac::camera::Feed::default());
    let track = CameraTrack::new(&core.shared(), FRAME_RATE, 2_000_000).unwrap();
    core.camera_track(track.spec.clone());
    let camera_layout = Layout::default();
    core.metadata(Description { sounds: vec![Sound::System, Sound::Microphone], camera: Some(camera_layout) }.to_bytes());
    let composition = Composition::new(core.shared().events(), None);
    let made = core
        .make_encoders(move |sink, tracks| {
            let encoder = VideoEncoder::new(640, 360, FRAME_RATE, 2_000_000, sink)?;
            let audio = (0..tracks).map(|_| AacEncoder::new(SAMPLE_RATE, CHANNELS, AUDIO_BITRATE)).collect::<Result<Vec<_>, _>>()?;
            Ok((Video { encoder, compositor: None, composition, diagnostics: None }, audio))
        })
        .unwrap();
    Core::<Mac>::encoders_made(made).unwrap();
    let screen = Frame { image: flat(640, 360, 40) };
    let camera = crate::mac::camera::Image(flat(1280, 720, 220));
    core.shared().frame(screen.clone(), now_ns());
    core.record().unwrap();
    let recording = track.start(core.shared(), feed.clone(), FRAME_RATE, Arc::new(AtomicBool::new(false))).unwrap();
    let shared = core.shared();
    let t0 = now_ns();
    let began = Instant::now();
    let (mut next_frame, mut next_sound) = (0u64, 0u64);
    while began.elapsed() < Duration::from_secs_f64(seconds) {
        let now = now_ns();
        while t0 + next_frame * NANOS_PER_SECOND / 30 <= now {
            shared.frame(screen.clone(), now);
            feed.deliver(camera.clone(), now, now, &*events);
            next_frame += 1;
        }
        while t0 + (next_sound + 480) * NANOS_PER_SECOND / 48_000 <= now {
            let at = t0 + next_sound * NANOS_PER_SECOND / 48_000;
            let tone = |hz: f32| move |frame: usize, _: usize| ((next_sound as usize + frame) as f32 * hz * std::f32::consts::TAU / 48_000.0).sin() * 0.3;
            shared.sound(0, at, 480, tone(440.0)).unwrap();
            shared.sound(1, at, 480, tone(660.0)).unwrap();
            next_sound += 480;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let stop_ns = now_ns();
    let drained = core.drain(stop_ns);
    core.halt();
    recording.stop();
    core.halted();
    let (_, finishing) = core.end(stop_ns, drained);
    finishing.wait().unwrap();
    assert!(events.failures.lock().unwrap().is_empty());
}

/// The energy of `hz` in the left channel of interleaved stereo `frames`, by Goertzel's algorithm.
fn tone_energy(frames: &[f32], hz: f64) -> f64 {
    let k = 2.0 * (std::f64::consts::TAU * hz / 48_000.0).cos();
    let (mut a, mut b) = (0.0f64, 0.0f64);
    for frame in frames.as_chunks::<2>().0 {
        let c = f64::from(frame[0]) + k * a - b;
        b = a;
        a = c;
    }
    (a * a + b * b - k * a * b) / (frames.len() / 2).max(1) as f64
}

/// Plan 087: an editable recording rendered with a part removed, its camera moved to the bottom-left corner and its
/// system sound muted: the camera's bright picture where the edit put it and nowhere else, the screen's dark one
/// around it, the microphone's tone alone in the sound, and the export as long as what was kept.
#[test]
fn a_rendered_export_composes_the_camera_where_the_edit_puts_it_and_mixes_at_its_volumes() {
    use crate::edit::render::{self, RenderOptions};
    let dir = std::env::temp_dir().join(format!("recordstuff-render-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let (source, output) = (dir.join("source.mp4"), dir.join("export.mp4"));
    let _ = std::fs::remove_file(&output);
    record_editable(&source, 2.5);
    let before = std::fs::read(&source).unwrap();
    let corner = Layout { x: 0.0, y: 1.0, ..Layout::default() };
    let options = RenderOptions { camera: Some(corner), camera_hidden: Vec::new(), gains: vec![0.0, 1.0] };
    // Half a second removed from the middle (90 kHz ticks).
    let removed = [(90_000u64, 135_000u64)];
    let report = render::export(&source, &output, &removed, &options, &mut crate::mac::render::MacRenderer, &mut |_| {}, &AtomicBool::new(false)).unwrap();
    assert_eq!(std::fs::read(&source).unwrap(), before, "the source is never written");
    let file = crate::mac::edit_test::tracks(&output);
    assert_eq!(file.tracks.len(), 2, "one picture, one sound");
    let video = &file.tracks[0];
    let kept_seconds = report.plan.duration as f64 / 90_000.0;
    let source_seconds = parse(&before).unwrap().tracks[0].duration as f64 / 90_000.0;
    assert!((source_seconds - 0.5 - kept_seconds).abs() < 0.05, "{source_seconds} s less half a second is not {kept_seconds} s");
    assert_eq!(video.samples.len() as u64, report.frames);
    // The first picture: the bubble's centre is the camera's light grey, the opposite corner the screen's dark one.
    let samples = vec![(video.samples[0].data.clone(), 1)];
    let index = crate::edit::source::read(&std::fs::read(&output).unwrap()).unwrap();
    let luma = &crate::mac::edit_test::decode_luma(&samples, std::slice::from_ref(&index.video.avcc), 640, 360)[0];
    let bubble = corner.bubble(640, 360);
    let at = |x: f64, y: f64| f64::from(luma[y as usize * 640 + x as usize]);
    let centre = at(bubble.x + bubble.width / 2.0, bubble.y + bubble.height / 2.0);
    assert!(centre > 180.0, "the camera's picture in the bubble: {centre}");
    assert!(at(600.0, 20.0) < 70.0, "the screen's picture elsewhere: {}", at(600.0, 20.0));
    // The sound: the microphone's 660 Hz, the muted system's 440 Hz gone.
    let packets: Vec<Vec<u8>> = file.tracks[1].samples.iter().map(|s| s.data.clone()).collect();
    let config = index.audio.as_ref().unwrap().config.clone();
    let decoded =
        crate::mac::edit::AacDecoder::new(&crate::edit::remux::AudioFormat { config, sample_rate: 48_000, channels: 2 }).unwrap().decode(&packets).unwrap();
    let middle = &decoded[decoded.len() / 4..decoded.len() / 2];
    let (mic, system) = (tone_energy(middle, 660.0), tone_energy(middle, 440.0));
    assert!(mic > 100.0 * system, "660 Hz {mic} against 440 Hz {system}");
    if let Ok(keep) = std::env::var("RECORDSTUFF_RENDER_OUT") {
        std::fs::copy(&output, keep).unwrap();
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Encodes `count` of `frames` with a fresh encoder of `width`×`height`: its `avcC` and one second's samples.
fn one_second(width: usize, height: usize, frames: &[CFRetained<CVPixelBuffer>], bitrate: u32) -> (Vec<u8>, Vec<(Vec<u8>, bool)>) {
    struct Collect(Mutex<Vec<crate::writer::Media>>);
    impl crate::core::VideoSink for Collect {
        fn media(&self, media: crate::writer::Media) {
            self.0.lock().unwrap().push(media);
        }
        fn failed(&self, detail: String) {
            panic!("{detail}");
        }
    }
    let collect = Arc::new(Collect(Mutex::new(Vec::new())));
    let encoder = VideoEncoder::new(width as u32, height as u32, FRAME_RATE, bitrate, collect.clone()).unwrap();
    for n in 0..FRAME_RATE as usize {
        encoder.encode(&frames[n % frames.len()], n as u64 * NANOS_PER_SECOND / u64::from(FRAME_RATE), n == 0).unwrap();
    }
    encoder.flush();
    drop(encoder);
    let media = std::mem::take(&mut *collect.0.lock().unwrap());
    let avcc = media.iter().find_map(|m| if let crate::writer::Media::VideoFormat { avcc, .. } = m { Some(avcc.clone()) } else { None }).unwrap();
    let samples = media.into_iter().filter_map(|m| if let crate::writer::Media::Video { data, sync, .. } = m { Some((data, sync)) } else { None }).collect();
    (avcc, samples)
}

/// A synthetic 1080p30 editable recording of `seconds` (a moving screen at 12 Mbps, the camera at 720p, two tones),
/// one second of each encoded once and repeated, as `bench_sources` makes the remux's sources.
fn editable_source(path: &std::path::Path, seconds: u64) {
    use crate::mux::mp4::{Codec, HybridMp4, Sample, TrackConfig};
    let screens: Vec<_> = (0..RING).map(|n| frame(1920, 1080, n)).collect();
    let cameras: Vec<_> = (0..RING).map(|n| frame(1280, 720, RING - 1 - n)).collect();
    let (screen_avcc, screen) = one_second(1920, 1080, &screens, VIDEO_BITRATE);
    let (camera_avcc, camera) = one_second(1280, 720, &cameras, camera_track::bitrate(1920, 1080, VIDEO_BITRATE));
    let mut packets = Vec::new();
    let mut tones = Vec::new();
    for hz in [440.0f32, 660.0] {
        let mut aac = AacEncoder::new(48_000, 2, AUDIO_BITRATE).unwrap();
        let tone: Vec<f32> = (0..10 * 48_000 * 2).map(|n| ((n / 2) as f32 * hz * std::f32::consts::TAU / 48_000.0).sin() * 0.2).collect();
        aac.push(&tone);
        let mut out = Vec::new();
        aac.drain(&mut |p| out.push(p)).unwrap();
        tones.push((aac.audio_specific_config(), aac.priming));
        packets.push(out);
    }
    let audio = |n: usize| TrackConfig {
        codec: Codec::Aac { config: tones[n].0.clone(), sample_rate: 48_000, channels: 2, average_bitrate: AUDIO_BITRATE, max_bitrate: AUDIO_BITRATE },
        timescale: 48_000,
        skip: tones[n].1,
    };
    let video = |avcc: &Vec<u8>, width: u16, height: u16| TrackConfig { codec: Codec::H264 { avcc: avcc.clone(), width, height }, timescale: 90_000, skip: 0 };
    let tracks = vec![video(&screen_avcc, 1920, 1080), audio(0), audio(1), video(&camera_avcc, 1280, 720)];
    let description = Description { sounds: vec![Sound::System, Sound::Microphone], camera: Some(Layout::default()) };
    let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(path).unwrap();
    let mut mp4 = HybridMp4::create_with_metadata(file, tracks, Some(description.to_bytes())).unwrap();
    let mut written = 0u64;
    for second in 0..seconds {
        for (track, samples) in [(0usize, &screen), (3, &camera)] {
            let samples: Vec<Sample> = samples.iter().map(|(d, s)| Sample { data: d, duration: 3000, sync: *s }).collect();
            mp4.write_fragment(track, &samples).unwrap();
        }
        let target = ((second + 1) * 48_000 + u64::from(tones[0].1)).div_ceil(1024);
        for (n, track) in [1usize, 2].into_iter().enumerate() {
            let chunk: Vec<Sample> =
                (written..target).map(|k| Sample { data: &packets[n][k as usize % packets[n].len()], duration: 1024, sync: true }).collect();
            mp4.write_fragment(track, &chunk).unwrap();
        }
        written = target;
    }
    for track in [1, 2] {
        mp4.set_presented(track, seconds * 48_000);
    }
    mp4.finish().unwrap();
}

/// Plan 087's export gates: a 1080p30 editable recording rendered at least in real time with the camera composed and
/// both sounds mixed, and a cancelled render ending within 2 s at p95. `RENDER_BENCH_SECONDS` (60) long,
/// `RENDER_BENCH_CANCELS` (10) cancels at random moments; prints `RENDER_BENCH {json}`.
#[test]
#[ignore = "run on its own: cargo test --release --lib render_bench -- --ignored --nocapture"]
fn render_bench() {
    use crate::edit::render::{self, RenderOptions};
    let seconds: u64 = std::env::var("RENDER_BENCH_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
    let cancels: usize = std::env::var("RENDER_BENCH_CANCELS").ok().and_then(|s| s.parse().ok()).unwrap_or(10);
    let dir = std::env::temp_dir().join(format!("recordstuff-render-bench-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let source = dir.join("source.mp4");
    editable_source(&source, seconds);
    let options = RenderOptions { camera: Some(Layout { x: 0.03, y: 0.95, ..Layout::default() }), camera_hidden: Vec::new(), gains: vec![1.0, 1.0] };
    let output = dir.join("export.mp4");
    let began = Instant::now();
    let done = render::export(&source, &output, &[], &options, &mut crate::mac::render::MacRenderer, &mut |_| {}, &AtomicBool::new(false)).unwrap();
    let elapsed = began.elapsed().as_secs_f64();
    let bytes = std::fs::metadata(&output).unwrap().len();
    std::fs::remove_file(&output).unwrap();
    let mut cancel_ms = Vec::new();
    for n in 0..cancels {
        let cancel = Arc::new(AtomicBool::new(false));
        let at = Duration::from_millis(200 + (n as u64 * 7919) % 3000);
        let flag = cancel.clone();
        let asked = Arc::new(Mutex::new(None));
        let when = asked.clone();
        let timer = std::thread::spawn(move || {
            std::thread::sleep(at);
            *when.lock().unwrap() = Some(Instant::now());
            flag.store(true, Ordering::Release);
        });
        let result = render::export(&source, &output, &[], &options, &mut crate::mac::render::MacRenderer, &mut |_| {}, &cancel);
        let ended = Instant::now();
        timer.join().unwrap();
        assert_eq!(result.err().map(|e| e.code), Some("cancelled"), "the render ended before its cancel at {at:?}");
        cancel_ms.push(ended.duration_since(asked.lock().unwrap().unwrap()).as_secs_f64() * 1000.0);
        let _ = std::fs::remove_file(&output);
    }
    cancel_ms.sort_by(f64::total_cmp);
    let p95 = cancel_ms.get(((cancel_ms.len() as f64 * 0.95).ceil() as usize).saturating_sub(1)).copied().unwrap_or(0.0);
    println!(
        r#"RENDER_BENCH {{"seconds":{seconds},"frames":{},"elapsedSeconds":{elapsed:.3},"realTime":{:.2},"bytes":{bytes},"cancelMs":{cancel_ms:?},"cancelP95Ms":{p95:.1}}}"#,
        done.frames,
        seconds as f64 / elapsed
    );
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(seconds as f64 / elapsed >= 1.0, "rendered at {:.2}× real time", seconds as f64 / elapsed);
    assert!(p95 <= 2000.0, "cancel p95 {p95} ms");
}
