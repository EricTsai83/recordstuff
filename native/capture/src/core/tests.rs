//! The session core with fake encoders on a real clock: what is encoded when, how the recording ends, and the file
//! it leaves. Platform capture and encoding are tested in their own modules; these run on every platform.

use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::*;
use crate::mux::parse::parse;
use crate::writer::AAC_FRAMES;

fn epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

struct Fake;

impl Platform for Fake {
    type Frame = u32;
    type Video = FakeVideo;
    type Audio = FakeAudio;

    fn now_ns() -> u64 {
        // Far from zero, as host clocks are.
        1_000 * NANOS_PER_SECOND + epoch().elapsed().as_nanos() as u64
    }
}

struct FakeVideo {
    sink: Arc<dyn VideoSink>,
    encoded: Arc<Mutex<Vec<(u32, u64, bool)>>>,
    format_sent: AtomicBool,
    fail: Arc<AtomicBool>,
}

impl VideoEncode<u32> for FakeVideo {
    fn encode(&self, frame: &u32, pts_ns: u64, key_frame: bool) -> Result<(), String> {
        if self.fail.load(Ordering::Acquire) {
            return Err("encoder broke".into());
        }
        if !self.format_sent.swap(true, Ordering::AcqRel) {
            self.sink.media(Media::VideoFormat { avcc: vec![1, 100, 0, 40, 0xff, 0xe0, 0], width: 64, height: 36 });
        }
        self.encoded.lock().unwrap().push((*frame, pts_ns, key_frame));
        self.sink.media(Media::Video { data: vec![0, 0, 0, 1, 0x65], pts_ns, sync: key_frame });
        Ok(())
    }

    fn flush(&self) {}
}

const PRIMING: u32 = 1024;

#[derive(Default)]
struct FakeAudio {
    frames_in: u64,
    /// Frames out of the encoder so far, priming included.
    frames_out: u64,
}

impl FakeAudio {
    fn packets(&mut self, out: &mut dyn FnMut(Vec<u8>), until: u64) {
        while self.frames_out + u64::from(AAC_FRAMES) <= until {
            self.frames_out += u64::from(AAC_FRAMES);
            out(vec![0x21, 0x10, 0x04]);
        }
    }
}

impl AudioEncode for FakeAudio {
    fn frames_in(&self) -> u64 {
        self.frames_in
    }
    fn priming(&self) -> u32 {
        PRIMING
    }
    fn audio_specific_config(&self) -> Vec<u8> {
        vec![0x11, 0x90]
    }
    fn push(&mut self, interleaved: &[f32]) {
        self.frames_in += (interleaved.len() / 2) as u64;
    }
    fn push_silence(&mut self, frames: usize) {
        self.frames_in += frames as u64;
    }
    fn drain(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
        let until = self.frames_in + u64::from(PRIMING);
        self.packets(out, until);
        Ok(())
    }
    fn finish(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
        let until = (self.frames_in + u64::from(PRIMING)).next_multiple_of(u64::from(AAC_FRAMES));
        self.packets(out, until);
        Ok(())
    }
}

#[derive(Default)]
struct Heard {
    failures: Mutex<Vec<(&'static str, String)>>,
    progress: AtomicUsize,
}

impl Events for Heard {
    fn progress(&self, _bytes: u64) {
        self.progress.fetch_add(1, Ordering::Relaxed);
    }
    fn write_failed(&self, failure: WriteFailure) {
        self.failures.lock().unwrap().push((failure.code, failure.detail));
    }
    fn capture_failed(&self, code: &'static str, detail: String) {
        self.failures.lock().unwrap().push((code, detail));
    }
}

struct Rig {
    core: Core<Fake>,
    shared: Arc<Shared<Fake>>,
    encoded: Arc<Mutex<Vec<(u32, u64, bool)>>>,
    heard: Arc<Heard>,
    fail: Arc<AtomicBool>,
    path: std::path::PathBuf,
}

impl Rig {
    fn new(name: &str) -> Self {
        Self::with_inputs(name, 1)
    }

    fn with_inputs(name: &str, inputs: usize) -> Self {
        let path = std::env::temp_dir().join(format!("recordstuff-core-{name}-{}.mp4", std::process::id()));
        let file = File::create(&path).unwrap();
        let heard = Arc::new(Heard::default());
        let core = Core::<Fake>::new(heard.clone(), 30, 192_000, inputs, file);
        let encoded = Arc::new(Mutex::new(Vec::new()));
        let fail = Arc::new(AtomicBool::new(false));
        let (e, f) = (encoded.clone(), fail.clone());
        let made = core
            .make_encoders(move |sink| Ok((FakeVideo { sink, encoded: e, format_sent: AtomicBool::new(false), fail: f }, FakeAudio::default())))
            .unwrap();
        Core::<Fake>::encoders_made(made).unwrap();
        let shared = core.shared();
        Self { core, shared, encoded, heard, fail, path }
    }

    /// Frames every `interval` and 10 ms of sound every 10 ms, stamped with the clock, for `duration`.
    fn capture(&self, duration: Duration, interval: Duration, sound: bool) {
        let end = Instant::now() + duration;
        let mut n = 100;
        let mut next_sound = Fake::now_ns();
        let mut next_frame = Instant::now();
        while Instant::now() < end {
            if Instant::now() >= next_frame {
                self.shared.frame(n, Fake::now_ns());
                n += 1;
                next_frame += interval;
            }
            if sound {
                // Sound arrives in 480-frame buffers stamped with when they began.
                while next_sound + 10_000_000 <= Fake::now_ns() {
                    self.shared.sound(0, next_sound, 480, |_, _| 0.1).unwrap();
                    next_sound += 10_000_000;
                }
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn stop(&mut self) -> (u64, Stopped, Finished) {
        let stop_ns = Fake::now_ns();
        let drained = self.core.drain(stop_ns);
        self.core.halt();
        self.core.halted();
        let (stopped, finishing) = self.core.end(stop_ns, drained);
        (stop_ns, stopped, finishing.wait().unwrap())
    }

    fn file(&self) -> crate::mux::parse::Mp4 {
        parse(&std::fs::read(&self.path).unwrap()).unwrap()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// The video's and the audio's presented lengths in ms: the video's media duration, and the audio's edit (in the
/// movie's timescale, which is the audio rate when an edit skips priming).
fn lengths(file: &crate::mux::parse::Mp4) -> (f64, f64) {
    let (video, audio) = (&file.tracks[0], &file.tracks[1]);
    let presented = audio.edit.expect("an edit list skips the priming").0;
    (video.duration as f64 * 1000.0 / f64::from(video.timescale), presented as f64 * 1000.0 / 48_000.0)
}

fn wait_for(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !condition() {
        assert!(Instant::now() < deadline, "{what} did not happen");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn the_file_starts_with_the_newest_frame_as_a_key_frame_and_both_tracks_end_at_the_stop() {
    let mut rig = Rig::new("ends");
    rig.shared.frame(1, Fake::now_ns());
    rig.shared.frame(2, Fake::now_ns());
    rig.core.first_frame(Duration::from_secs(1)).unwrap();
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    rig.capture(Duration::from_millis(400), Duration::from_micros(16_667), true);
    // Sound keeps arriving while `stop` waits for it, as capture's does.
    let feeding = Arc::new(AtomicBool::new(true));
    let feeder = {
        let (shared, feeding) = (rig.shared.clone(), feeding.clone());
        let mut next = rig.shared.audio.lock().unwrap().mixer.as_ref().map(|m| m.delivered(0)).unwrap();
        let t0 = rig.shared.t0_ns.load(Ordering::Acquire);
        std::thread::spawn(move || {
            while feeding.load(Ordering::Acquire) {
                let at = t0 + next * NANOS_PER_SECOND / 48_000;
                if at + 10_000_000 <= Fake::now_ns() {
                    shared.sound(0, at, 480, |_, _| 0.1).unwrap();
                    next += 480;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };
    let (_, stopped, finished) = rig.stop();
    feeding.store(false, Ordering::Release);
    feeder.join().unwrap();

    let encoded = rig.encoded.lock().unwrap().clone();
    assert_eq!((encoded[0].0, encoded[0].2), (2, true), "the newest prepared frame, as a key frame");
    assert!(encoded[1..].iter().all(|&(_, _, key)| !key));
    // 60 Hz capture paced to 30 fps: about 12 frames in 400 ms, never two in one slot.
    assert!((9..=15).contains(&(encoded.len() - 1)), "{} frames", encoded.len() - 1);
    assert!(encoded.windows(2).all(|w| w[1].1 - w[0].1 > 16_000_000), "{encoded:?}");
    // Sound kept up, so nothing was filled in; on a loaded runner the feeder thread can miss the deadline (CI saw 534
    // frames), and then the drain must have waited the deadline out before filling in.
    assert!(
        stopped.drain_padded_frames == 0 || stopped.drain_ms >= 240.0,
        "{} frames filled in after only {} ms",
        stopped.drain_padded_frames,
        stopped.drain_ms
    );
    assert_eq!(finished.fragmented, None);

    let file = rig.file();
    assert!(file.tracks[0].samples[0].sync);
    // Equal ends.
    let (video_ms, audio_ms) = lengths(&file);
    assert!((video_ms - audio_ms).abs() < 1.0, "video {video_ms} ms, audio {audio_ms} ms");
    assert!(rig.heard.failures.lock().unwrap().is_empty());
}

#[test]
fn nothing_captured_after_the_stop_is_kept() {
    let mut rig = Rig::new("after");
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    rig.capture(Duration::from_millis(150), Duration::from_millis(33), true);
    // No frame for longer than a slot, so the pacer would take the next one at once.
    std::thread::sleep(Duration::from_millis(50));
    let stop_ns = Fake::now_ns();
    let drained = rig.core.drain(stop_ns);
    let encoded = rig.encoded.lock().unwrap().len();
    // A frame stamped at the stop itself is after it: the video ends there.
    rig.shared.frame(998, stop_ns);
    assert_eq!(rig.encoded.lock().unwrap().len(), encoded, "the frame at the stop");
    // A frame and sound stamped after the stop, arriving while capture still runs.
    rig.shared.frame(999, stop_ns + 40_000_000);
    rig.shared.sound(0, stop_ns + 1_000_000, 4_800, |_, _| 0.5).unwrap();
    assert_eq!(rig.encoded.lock().unwrap().len(), encoded);
    rig.core.halt();
    rig.core.halted();
    rig.core.end(stop_ns, drained).1.wait().unwrap();
    let file = rig.file();
    let (video_ms, audio_ms) = lengths(&file);
    assert!((video_ms - audio_ms).abs() < 1.0, "video {video_ms} ms, audio {audio_ms} ms");
}

#[test]
fn sound_that_does_not_arrive_by_the_deadline_becomes_silence() {
    let mut rig = Rig::new("silence");
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    rig.capture(Duration::from_millis(200), Duration::from_millis(33), true);
    // The sound stops arriving 100 ms before the stop.
    rig.capture(Duration::from_millis(100), Duration::from_millis(33), false);
    let (_, stopped, _) = rig.stop();
    assert!(stopped.drain_ms >= 240.0, "waited {} ms", stopped.drain_ms);
    // About 100 ms, and the part of the last buffer that had not been handed over.
    assert!((4_000..=6_000).contains(&stopped.drain_padded_frames), "{} frames of silence", stopped.drain_padded_frames);
    let file = rig.file();
    let (video_ms, audio_ms) = lengths(&file);
    assert!((video_ms - audio_ms).abs() < 1.0, "video {video_ms} ms, audio {audio_ms} ms");
}

#[test]
fn a_recording_without_any_sound_gets_a_silent_track_as_long_as_its_video() {
    let mut rig = Rig::new("mute");
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    // Longer than the mixer's latency, so the clock has already moved the track on.
    rig.capture(Duration::from_millis(700), Duration::from_millis(33), false);
    let (_, stopped, _) = rig.stop();
    // Sound may still be on its way, so the deadline is waited out; the rest is silence up to the stop.
    assert!((240.0..400.0).contains(&stopped.drain_ms), "waited {} ms", stopped.drain_ms);
    assert!(stopped.drain_padded_frames > 0 && stopped.drain_padded_frames < 30_000, "{} frames", stopped.drain_padded_frames);
    let file = rig.file();
    assert!(file.tracks[0].samples.len() >= 2);
    let (video_ms, audio_ms) = lengths(&file);
    assert!((video_ms - audio_ms).abs() < 1.0, "video {video_ms} ms, audio {audio_ms} ms");
}

#[test]
fn a_second_input_that_stops_delivering_holds_the_track_back_only_for_the_mixing_latency() {
    let mut rig = Rig::with_inputs("two", 2);
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    let t0 = rig.shared.t0_ns.load(Ordering::Acquire);
    // Both inputs for 300 ms, then only the first for a second: the second (a microphone, say) went quiet.
    let mut next = 0u64;
    let feed = |next: &mut u64, both: bool| {
        let at = t0 + *next * NANOS_PER_SECOND / 48_000;
        rig.shared.sound(0, at, 480, |_, _| 0.25).unwrap();
        if both {
            rig.shared.sound(1, at, 480, |_, _| 0.5).unwrap();
        }
        *next += 480;
    };
    let began = Instant::now();
    while began.elapsed() < Duration::from_millis(1_300) {
        while t0 + (next + 480) * NANOS_PER_SECOND / 48_000 <= Fake::now_ns() {
            feed(&mut next, began.elapsed() < Duration::from_millis(300));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    // The track went on past where the second input stopped: up to the clock less the latency, at least.
    let mixed = rig.shared.audio.lock().unwrap().mixed();
    assert!(mixed > 24_000, "only {mixed} frames mixed");
    let (_, stopped, _) = rig.stop();
    assert_eq!(stopped.late_audio_frames, [0, 0]);
    let (video_ms, audio_ms) = lengths(&rig.file());
    assert!((video_ms - audio_ms).abs() < 1.0, "video {video_ms} ms, audio {audio_ms} ms");
}

#[test]
fn a_still_screen_is_encoded_again_every_second() {
    let mut rig = Rig::new("still");
    rig.shared.frame(7, Fake::now_ns());
    rig.core.record().unwrap();
    std::thread::sleep(Duration::from_millis(1_250));
    let encoded = rig.encoded.lock().unwrap().clone();
    assert_eq!(encoded.len(), 2, "{encoded:?}");
    assert!(encoded.iter().all(|&(frame, _, _)| frame == 7));
    let gap = encoded[1].1 - encoded[0].1;
    assert!((1_000_000_000..1_200_000_000).contains(&gap), "refreshed after {gap} ns");
    rig.stop();
}

#[test]
fn a_change_left_out_by_the_pacer_is_encoded_at_its_slot() {
    let mut rig = Rig::new("pending");
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    let t0 = rig.encoded.lock().unwrap()[0].1;
    // A change 5 ms after the start is too early for the slot at 33 ms, and then the screen stands still.
    rig.shared.frame(2, t0 + 5_000_000);
    wait_for("the change", || rig.encoded.lock().unwrap().len() == 2);
    let (frame, at, _) = rig.encoded.lock().unwrap()[1];
    assert_eq!(frame, 2);
    assert_eq!(at, t0 + 33_333_333, "at its slot");
    rig.stop();
}

#[test]
fn an_encoding_failure_while_recording_is_reported_once() {
    let mut rig = Rig::new("broken");
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    rig.fail.store(true, Ordering::Release);
    rig.capture(Duration::from_millis(120), Duration::from_millis(33), false);
    let failures = rig.heard.failures.lock().unwrap().clone();
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert_eq!(failures[0].0, "capture_failed");
    rig.fail.store(false, Ordering::Release);
    rig.stop();
}

#[test]
fn a_session_with_no_frame_by_the_deadline_fails_to_prepare() {
    let rig = Rig::new("blank");
    let error = rig.core.first_frame(Duration::from_millis(50)).unwrap_err();
    assert_eq!(error.code, "capture_start_failed");
}

#[test]
fn a_failure_before_the_first_frame_is_reported_as_itself() {
    let rig = Rig::new("conversion");
    rig.shared.fail("a captured frame could not be converted: E_INVALIDARG".into());
    let error = rig.core.first_frame(Duration::from_secs(1)).unwrap_err();
    assert_eq!(error.detail, "a captured frame could not be converted: E_INVALIDARG");
}

#[test]
fn a_stop_before_record_ends_nothing() {
    let mut rig = Rig::new("unrecorded");
    rig.shared.frame(1, Fake::now_ns());
    assert_eq!(rig.core.drain(Fake::now_ns()), (0.0, 0));
    rig.core.halt();
    rig.core.halted();
    rig.core.release();
    assert!(rig.encoded.lock().unwrap().is_empty());
    assert_eq!(std::fs::metadata(&rig.path).unwrap().len(), 0, "the file stays empty");
}
