//! A real recording on this machine: the primary display and system audio for three seconds through a whole session,
//! then the file read back. Ignored by default, since it needs a desktop session; CI's Windows job runs it with
//! `cargo test -- --ignored` (plan 076, D8). When the runner's session cannot capture at all (no desktop to compose,
//! no audio engine), that is a finding, not a failure: the test says so, records it in the job summary, and passes,
//! so the recording is listed as untested. Any other error fails.
//!
//! System audio alone and the display alone come first, each its own test that CI runs in its own process, so a
//! crash in one part names that part.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::audio::SoundCapture;
use super::capture::{self, DisplayCapture, Gpu};
use super::com;
use super::session::{Session, Win};
use crate::core::{CaptureError, Core, Events, PrepareRequest};
use crate::pacing::Pacer;
use crate::mux::parse::parse;
use crate::writer::WriteFailure;

#[derive(Default)]
struct Heard(Mutex<Vec<String>>);

impl Events for Heard {
    fn progress(&self, _bytes: u64) {}
    fn write_failed(&self, failure: WriteFailure) {
        self.0.lock().unwrap().push(format!("write {}: {}", failure.code, failure.detail));
    }
    fn capture_failed(&self, code: &'static str, detail: String) {
        self.0.lock().unwrap().push(format!("capture {code}: {detail}"));
    }
}

/// Failures that mean this session has nothing to capture, rather than that the engine is wrong.
const UNAVAILABLE: [&str; 7] = [
    "no display contains",
    "Windows.Graphics.Capture is not available",
    "the display could not be captured",
    "delivered no frame",
    "system audio capture is not available",
    "system audio capture was refused",
    "system audio capture did not open",
];

fn summary(line: &str) {
    println!("{line}");
    if let Ok(path) = std::env::var("GITHUB_STEP_SUMMARY") {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// True, after saying so in the job summary, when `error` means this session cannot capture and nothing else failed.
fn untested(what: &str, error: &CaptureError, heard: &Heard) -> bool {
    if heard.0.lock().unwrap().is_empty() && UNAVAILABLE.iter().any(|reason| error.detail.contains(reason)) {
        summary(&format!("Windows live {what} UNTESTED: this runner's session cannot capture ({}: {})", error.code, error.detail));
        return true;
    }
    false
}

/// A core that is never recorded: parts started on its `shared()` deliver to it, and it counts frames.
fn idle_core(heard: Arc<Heard>) -> (Core<Win>, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!("recordstuff-live-part-{}.mp4", std::process::id()));
    let file = std::fs::File::create(&path).unwrap();
    (Core::<Win>::new(heard, 30, 192_000, file), path)
}

#[test]
#[ignore = "captures system audio; CI's Windows job runs it"]
fn live_sound_alone_opens_reads_and_stops() {
    com();
    let heard = Arc::new(Heard::default());
    let (core, path) = idle_core(heard.clone());
    eprintln!("sound: starting process loopback");
    let mut sound = match SoundCapture::start(std::process::id(), core.shared()) {
        Ok(sound) => sound,
        Err(error) if untested("system audio", &error, &heard) => return,
        Err(error) => panic!("sound failed to start: {}: {}", error.code, error.detail),
    };
    eprintln!("sound: started; reading for 1 s");
    std::thread::sleep(Duration::from_secs(1));
    sound.stop();
    drop(sound);
    eprintln!("sound: stopped");
    assert!(heard.0.lock().unwrap().is_empty(), "{:?}", heard.0.lock().unwrap());
    drop(core);
    let _ = std::fs::remove_file(&path);
    summary("Windows live system audio alone: opened, read for 1 s and stopped");
}

#[test]
#[ignore = "captures the display; CI's Windows job runs it"]
fn live_display_alone_delivers_frames() {
    com();
    let heard = Arc::new(Heard::default());
    let (core, path) = idle_core(heard.clone());
    let started = (|| -> Result<_, CaptureError> {
        let item = capture::item(capture::monitor(None)?)?;
        let size = item.Size().map_err(super::failing("the display's size"))?;
        let gpu = Gpu::new()?;
        eprintln!("display: {}x{}, software device {}; starting capture", size.Width, size.Height, gpu.0.software);
        let (width, height) = ((size.Width as u32).min(1280) & !1, (size.Height as u32).min(720) & !1);
        DisplayCapture::start(gpu, &item, width, height, Pacer::capture_interval_ns(30), core.shared())
    })();
    let (display, borderless, cpu) = match started {
        Ok(started) => started,
        Err(error) if untested("display", &error, &heard) => return,
        Err(error) => panic!("display capture failed to start: {}: {}", error.code, error.detail),
    };
    eprintln!("display: started (borderless {borderless}, CPU conversion {cpu:?}); capturing for 1 s");
    std::thread::sleep(Duration::from_secs(1));
    display.stop();
    let frames = core.frames_seen();
    eprintln!("display: stopped after {frames} frames");
    assert!(heard.0.lock().unwrap().is_empty(), "{:?}", heard.0.lock().unwrap());
    drop(display);
    drop(core);
    let _ = std::fs::remove_file(&path);
    summary(&format!("Windows live display alone: {frames} frames in 1 s; CPU conversion: {cpu:?}"));
    assert!(frames > 0, "no frame arrived");
}

#[test]
#[ignore = "records the display and system audio; CI's Windows job runs it"]
fn live_capture_records_the_primary_display_and_system_audio() {
    let path = std::env::temp_dir().join(format!("recordstuff-live-{}.mp4", std::process::id()));
    std::fs::File::create(&path).unwrap();
    let heard = Arc::new(Heard::default());
    let (width, height) = super::session::probe(0, None).map(|(w, h)| (w.min(1920) & !1, h.min(1080) & !1)).unwrap_or((1280, 720));
    let request = PrepareRequest {
        display_id: 0,
        display_point: None,
        width,
        height,
        frame_rate: 30,
        video_bitrate: 6_000_000,
        audio_bitrate: 256_000,
        own_pids: vec![std::process::id() as i32],
        hide_system_ui: false,
        path: path.clone(),
    };
    eprintln!("session: preparing {width}x{height}");
    let (mut session, prepared) = match Session::prepare(request, heard.clone()) {
        Ok(prepared) => prepared,
        // Only when nothing else failed: a frame that arrived but could not be converted fails the test.
        Err(error) if untested("capture", &error, &heard) => {
            let _ = std::fs::remove_file(&path);
            return;
        }
        Err(error) => panic!("prepare failed: {}: {}", error.code, error.detail),
    };
    summary(&format!(
        "Windows live capture prepared {}x{}, AAC priming {} frames, timings: {}; warnings: {:?}",
        prepared.width, prepared.height, prepared.priming_frames, prepared.timings, prepared.warnings
    ));
    session.record().unwrap();
    eprintln!("session: recording for 3 s");
    std::thread::sleep(Duration::from_secs(3));
    let frames_seen = session.frames_seen();
    eprintln!("session: stopping after {frames_seen} frames");
    let stopped = session.stop().unwrap_or_else(|failure| panic!("stop failed: {}: {}", failure.code, failure.detail));
    assert!(heard.0.lock().unwrap().is_empty(), "{:?}", heard.0.lock().unwrap());
    assert_eq!(stopped.fragmented, None);

    let file = parse(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(file.top, ["ftyp", "mdat", "moov"]);
    let (video, audio) = (&file.tracks[0], &file.tracks[1]);
    let video_ms = video.duration as f64 * 1000.0 / f64::from(video.timescale);
    let audio_ms = audio.edit.map_or(0.0, |(presented, _)| presented as f64 * 1000.0 / 48_000.0);
    summary(&format!(
        "Windows live capture recorded {} frames seen, {} video samples ({} key) over {video_ms:.0} ms, {} audio packets presenting {audio_ms:.0} ms; drain {:.0} ms, {} frames of silence filled in",
        frames_seen,
        video.samples.len(),
        video.samples.iter().filter(|s| s.sync).count(),
        audio.samples.len(),
        stopped.drain_ms,
        stopped.drain_padded_frames
    ));
    assert!(video.samples[0].sync);
    assert!((2_800.0..3_400.0).contains(&video_ms), "video lasts {video_ms} ms");
    // A still runner desktop gives one frame a second at least; a changing one up to 30.
    assert!(video.samples.len() >= 3, "{} video samples", video.samples.len());
    if !audio.samples.is_empty() {
        assert!((video_ms - audio_ms).abs() < 1.0, "video {video_ms} ms, audio {audio_ms} ms");
    }
    let _ = std::fs::remove_file(&path);
}
