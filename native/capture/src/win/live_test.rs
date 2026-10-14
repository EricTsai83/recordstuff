//! A real recording on this machine: the primary display and system audio for three seconds through a whole session,
//! then the file read back. Ignored by default, since it needs a desktop session; CI's Windows job runs it with
//! `cargo test -- --ignored` (plan 076, D8). When the runner's session cannot capture at all (no desktop to compose,
//! no audio engine), that is a finding, not a failure: the test says so, records it in the job summary, and passes,
//! so the recording is listed as untested. Any other error fails.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::session::Session;
use crate::core::{Events, PrepareRequest};
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
    let (mut session, prepared) = match Session::prepare(request, heard.clone()) {
        Ok(prepared) => prepared,
        // Only when nothing else failed: a frame that arrived but could not be converted fails the test.
        Err(error) if heard.0.lock().unwrap().is_empty() && UNAVAILABLE.iter().any(|reason| error.detail.contains(reason)) => {
            summary(&format!("Windows live capture UNTESTED: this runner's session cannot capture ({}: {})", error.code, error.detail));
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
    std::thread::sleep(Duration::from_secs(3));
    let frames_seen = session.frames_seen();
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
