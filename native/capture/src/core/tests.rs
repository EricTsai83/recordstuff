//! The session core with fake encoders on a real clock: what is encoded when, how the recording ends, and the file
//! it leaves. Platform capture and encoding are tested in their own modules; these run on every platform.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize};
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
    /// The camera composed into each encoded frame, as a compositor takes it at encoding time (plan 075).
    camera: Arc<CameraFeed<u32>>,
    composed: Arc<Mutex<Vec<Option<u32>>>>,
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
        self.composed.lock().unwrap().push(self.camera.latest().map(|(camera, _)| camera));
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
    /// Set, every drain fails.
    fail: Arc<AtomicBool>,
    /// The loudest sample pushed, as f32 bits.
    loudest: Arc<AtomicU32>,
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
        let loudest = interleaved.iter().fold(0.0f32, |peak, sample| peak.max(sample.abs()));
        self.loudest.fetch_max(loudest.to_bits(), Ordering::AcqRel);
    }
    fn push_silence(&mut self, frames: usize) {
        self.frames_in += frames as u64;
    }
    fn drain(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
        if self.fail.load(Ordering::Acquire) {
            return Err("audio encoder broke".into());
        }
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
    microphone_lost: Mutex<Vec<String>>,
    microphone_resumed: Mutex<Vec<String>>,
    camera_lost: Mutex<Vec<String>>,
    camera_resumed: Mutex<Vec<String>>,
    levels: Mutex<Vec<Levels>>,
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
    fn microphone_lost(&self, detail: String) {
        self.microphone_lost.lock().unwrap().push(detail);
    }
    fn microphone_resumed(&self, detail: String) {
        self.microphone_resumed.lock().unwrap().push(detail);
    }
    fn camera_lost(&self, detail: String) {
        self.camera_lost.lock().unwrap().push(detail);
    }
    fn camera_resumed(&self, detail: String) {
        self.camera_resumed.lock().unwrap().push(detail);
    }
    fn levels(&self, levels: Levels) {
        self.levels.lock().unwrap().push(levels);
    }
}

struct Rig {
    core: Core<Fake>,
    shared: Arc<Shared<Fake>>,
    encoded: Arc<Mutex<Vec<(u32, u64, bool)>>>,
    heard: Arc<Heard>,
    fail: Arc<AtomicBool>,
    audio_fail: Arc<AtomicBool>,
    path: std::path::PathBuf,
    camera: Arc<CameraFeed<u32>>,
    composed: Arc<Mutex<Vec<Option<u32>>>>,
    /// The loudest sample the audio encoder got.
    loudest: Arc<AtomicU32>,
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
        let audio_fail = Arc::new(AtomicBool::new(false));
        let camera = Arc::new(CameraFeed::default());
        let composed = Arc::new(Mutex::new(Vec::new()));
        let loudest = Arc::new(AtomicU32::new(0));
        let (e, f, a, c, d, l) = (encoded.clone(), fail.clone(), audio_fail.clone(), camera.clone(), composed.clone(), loudest.clone());
        let made = core
            .make_encoders(move |sink| {
                let video = FakeVideo { sink, encoded: e, format_sent: AtomicBool::new(false), fail: f, camera: c, composed: d };
                Ok((video, FakeAudio { fail: a, loudest: l, ..FakeAudio::default() }))
            })
            .unwrap();
        Core::<Fake>::encoders_made(made).unwrap();
        let shared = core.shared();
        Self { core, shared, encoded, heard, fail, audio_fail, path, camera, composed, loudest }
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

/// How late this machine wakes a thread now: the most a few 2 ms sleeps overran. A CI runner can be busy enough that a
/// timing bound has to allow it.
fn scheduling_slack() -> Duration {
    (0..5)
        .map(|_| {
            let asked = Instant::now();
            std::thread::sleep(Duration::from_millis(2));
            asked.elapsed().saturating_sub(Duration::from_millis(2))
        })
        .max()
        .unwrap()
}

/// How late this machine woke a sleeping thread while `during` ran, sampled alongside it, so a moment the machine was
/// busy (a CI runner) is counted, which `scheduling_slack` measured before it cannot see.
fn slack_during<T>(during: impl FnOnce() -> T) -> (T, Duration) {
    let stop = Arc::new(AtomicBool::new(false));
    let sampler = {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut worst = Duration::ZERO;
            while !stop.load(Ordering::Acquire) {
                let asked = Instant::now();
                std::thread::sleep(Duration::from_millis(2));
                worst = worst.max(asked.elapsed().saturating_sub(Duration::from_millis(2)));
            }
            worst
        })
    };
    let result = during();
    stop.store(true, Ordering::Release);
    (result, sampler.join().unwrap())
}

/// The median interval between encoded frames' times, in nanoseconds.
fn median_interval(times: &[u64]) -> u64 {
    let mut gaps: Vec<u64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    gaps.sort_unstable();
    gaps[gaps.len() / 2]
}

/// Runs a timing scenario up to three times and passes on the first attempt within its bound: one attempt on a busy
/// machine (a CI runner, 2026-10-19: 84 and 126 ms where the bounds were 79 and 110) does not fail the test, while a
/// regression that misses the bound every time still does. `attempt` gets its attempt's number for a fresh rig.
fn within_one_of_three(what: &str, mut attempt: impl FnMut(usize) -> Result<(), String>) {
    let mut misses = Vec::new();
    for n in 0..3 {
        match attempt(n) {
            Ok(()) => return,
            Err(miss) => misses.push(miss),
        }
    }
    panic!("{what}: missed in every attempt: {misses:?}");
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
    // 60 Hz capture paced to 30 fps: about 12 frames in 400 ms, never two in one slot: no more frames than the slots
    // their times span. Judged by those times, not by 400 ms: a loaded runner stops later and wakes late.
    let slots = ((encoded.last().unwrap().1 - encoded[1].1) as f64 / 33_333_333.0).round() as usize + 1;
    assert!(encoded.len() > 9 && encoded.len() - 1 <= slots + 1, "{} frames in {slots} slots: {encoded:?}", encoded.len() - 1);
    assert!(encoded.windows(2).all(|w| w[1].1 > w[0].1), "{encoded:?}");
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
    // The sound stops arriving 100 ms before the stop, or longer on a busy machine: the gap is read on the clock.
    let silent_from = Fake::now_ns();
    rig.capture(Duration::from_millis(100), Duration::from_millis(33), false);
    let (stop_ns, stopped, _) = rig.stop();
    assert!(stopped.drain_ms >= 240.0, "waited {} ms", stopped.drain_ms);
    // The gap, and the part of the last buffer (480 frames) that had not been handed over: a CI runner's 100 ms took
    // 127 (2026-10-19), which a fixed 4,000–6,000 frames failed.
    let gap = ((stop_ns - silent_from) as u128 * 48_000 / 1_000_000_000) as u64;
    assert!(
        (gap.saturating_sub(480)..=gap + 960).contains(&stopped.drain_padded_frames),
        "{} frames of silence for a {gap}-frame gap",
        stopped.drain_padded_frames
    );
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
fn a_microphone_that_stops_delivering_is_told_and_taken_again_when_its_sound_comes_back() {
    let mut rig = Rig::with_inputs("microphone-lost", 2);
    rig.core.watch_microphone(1);
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    let t0 = rig.shared.t0_ns.load(Ordering::Acquire);
    // System sound throughout; the microphone for 300 ms, then nothing, as when it is unplugged.
    let mut next = 0u64;
    let began = Instant::now();
    while began.elapsed() < Duration::from_millis(2_800) {
        while t0 + (next + 480) * NANOS_PER_SECOND / 48_000 <= Fake::now_ns() {
            let at = t0 + next * NANOS_PER_SECOND / 48_000;
            rig.shared.sound(0, at, 480, |_, _| 0.25).unwrap();
            if began.elapsed() < Duration::from_millis(300) {
                rig.shared.sound(1, at, 480, |_, _| 0.5).unwrap();
            }
            next += 480;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let lost = rig.heard.microphone_lost.lock().unwrap().clone();
    assert_eq!(lost.len(), 1, "{lost:?}");
    assert!(lost[0].contains("no sound for 2 s"), "{lost:?}");
    // Losing it again (the platform noticing too) is not told twice, and nothing failed.
    rig.shared.lose_microphone("unplugged".into());
    assert_eq!(rig.heard.microphone_lost.lock().unwrap().len(), 1);
    // Its sound comes back: told once, and taken from where it is, the gap silence.
    let delivered = rig.shared.audio.lock().unwrap().mixer.as_ref().map(|m| m.delivered(1)).unwrap();
    let at = t0 + next * NANOS_PER_SECOND / 48_000;
    rig.shared.sound(1, at, 480, |_, _| 0.5).unwrap();
    rig.shared.sound(1, at + 10_000_000, 480, |_, _| 0.5).unwrap();
    let resumed = rig.heard.microphone_resumed.lock().unwrap().clone();
    assert_eq!(resumed.len(), 1, "{resumed:?}");
    assert!(resumed[0].starts_with("the microphone delivered sound again after 2."), "{resumed:?}");
    assert!(rig.shared.audio.lock().unwrap().mixer.as_ref().map(|m| m.delivered(1)).unwrap() > delivered);
    // Stopping again is told again.
    rig.shared.lose_microphone("unplugged".into());
    assert_eq!(rig.heard.microphone_lost.lock().unwrap().len(), 2);
    let (_, _, _) = rig.stop();
    assert!(rig.heard.failures.lock().unwrap().is_empty(), "{:?}", rig.heard.failures.lock().unwrap());
    let (video_ms, audio_ms) = lengths(&rig.file());
    assert!(video_ms > 2_500.0 && (video_ms - audio_ms).abs() < 1.0, "video {video_ms} ms, audio {audio_ms} ms");
}

#[test]
fn a_microphone_delivering_only_digital_silence_is_told_lost_but_a_quiet_one_is_not() {
    // Plan 089, D2: a MacBook's built-in microphone with the lid closed delivers buffers of exact zeros. 2 s of only
    // those is told lost, naming them; a quiet room's faint sound, however low, is sound.
    let mut rig = Rig::with_inputs("microphone-zeros", 2);
    rig.core.watch_microphone(1);
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    let t0 = rig.shared.t0_ns.load(Ordering::Acquire);
    let mut next = 0u64;
    let mut feed = |rig: &Rig, millis: u64, level: f32| {
        let began = Instant::now();
        while began.elapsed() < Duration::from_millis(millis) {
            while t0 + (next + 480) * NANOS_PER_SECOND / 48_000 <= Fake::now_ns() {
                let at = t0 + next * NANOS_PER_SECOND / 48_000;
                rig.shared.sound(0, at, 480, |_, _| 0.0).unwrap();
                // One sample in the buffer carries the level, as a quiet room's noise floor does at -100 dBFS.
                rig.shared.sound(1, at, 480, |frame, _| if frame == 7 { level } else { 0.0 }).unwrap();
                next += 480;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    };
    feed(&rig, 2_600, 1e-5);
    assert!(rig.heard.microphone_lost.lock().unwrap().is_empty(), "{:?}", rig.heard.microphone_lost.lock().unwrap());
    feed(&rig, 2_600, 0.0);
    let lost = rig.heard.microphone_lost.lock().unwrap().clone();
    assert_eq!(lost.len(), 1, "{lost:?}");
    assert!(lost[0].contains("only digital silence") && lost[0].contains("for 2 s"), "{lost:?}");
    // Sound again (the lid opened): told back once.
    feed(&rig, 100, 0.25);
    let resumed = rig.heard.microphone_resumed.lock().unwrap().clone();
    assert_eq!(resumed.len(), 1, "{resumed:?}");
    let (_, _, _) = rig.stop();
    assert!(rig.heard.failures.lock().unwrap().is_empty(), "{:?}", rig.heard.failures.lock().unwrap());
}

#[test]
fn switching_the_microphone_counts_its_silence_from_the_switch() {
    // Plan 079, D3: opening the device switched to can take a Bluetooth headset a second or two, which is no loss.
    let mut rig = Rig::with_inputs("microphone-switched", 2);
    rig.core.watch_microphone(1);
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    let t0 = rig.shared.t0_ns.load(Ordering::Acquire);
    // The old microphone for 300 ms, nothing for 1.5 s while the new one opens, then the switch, then 1.5 s more of
    // nothing: 2.7 s without sound in all, but only 1.5 s since the switch.
    let mut next = 0u64;
    let began = Instant::now();
    let mut switched = false;
    while began.elapsed() < Duration::from_millis(3_300) {
        if !switched && began.elapsed() >= Duration::from_millis(1_800) {
            rig.shared.microphone_switched();
            switched = true;
        }
        while t0 + (next + 480) * NANOS_PER_SECOND / 48_000 <= Fake::now_ns() {
            let at = t0 + next * NANOS_PER_SECOND / 48_000;
            rig.shared.sound(0, at, 480, |_, _| 0.25).unwrap();
            if began.elapsed() < Duration::from_millis(300) {
                rig.shared.sound(1, at, 480, |_, _| 0.5).unwrap();
            }
            next += 480;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(rig.heard.microphone_lost.lock().unwrap().is_empty(), "{:?}", rig.heard.microphone_lost.lock().unwrap());
    // The new one's sound is taken from where it is, the gap silence.
    let delivered = rig.shared.audio.lock().unwrap().mixer.as_ref().map(|m| m.delivered(1)).unwrap();
    rig.shared.sound(1, t0 + next * NANOS_PER_SECOND / 48_000, 480, |_, _| 0.5).unwrap();
    assert!(rig.shared.audio.lock().unwrap().mixer.as_ref().map(|m| m.delivered(1)).unwrap() > delivered);
    assert!(rig.heard.microphone_resumed.lock().unwrap().is_empty());
    let (_, _, _) = rig.stop();
    assert!(rig.heard.failures.lock().unwrap().is_empty(), "{:?}", rig.heard.failures.lock().unwrap());
}

#[test]
fn a_microphone_is_lost_only_while_recording_and_one_that_delivers_never_is() {
    let mut rig = Rig::with_inputs("microphone-kept", 2);
    rig.core.watch_microphone(1);
    rig.shared.frame(1, Fake::now_ns());
    // Prepared: a microphone that fails to open is `prepare`'s refusal, not a loss.
    rig.shared.lose_microphone("before recording".into());
    assert!(rig.heard.microphone_lost.lock().unwrap().is_empty());
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    let t0 = rig.shared.t0_ns.load(Ordering::Acquire);
    let mut next = 0u64;
    let began = Instant::now();
    while began.elapsed() < Duration::from_millis(2_400) {
        while t0 + (next + 480) * NANOS_PER_SECOND / 48_000 <= Fake::now_ns() {
            rig.shared.sound(1, t0 + next * NANOS_PER_SECOND / 48_000, 480, |_, _| 0.5).unwrap();
            next += 480;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(rig.heard.microphone_lost.lock().unwrap().is_empty());
    let (_, _, _) = rig.stop();
    // After the stop nothing is told either.
    rig.shared.lose_microphone("after the stop".into());
    assert!(rig.heard.microphone_lost.lock().unwrap().is_empty());
}

#[test]
fn a_still_screen_is_encoded_again_every_second() {
    let mut rig = Rig::new("still");
    rig.shared.frame(7, Fake::now_ns());
    let began = Instant::now();
    rig.core.record().unwrap();
    std::thread::sleep(Duration::from_millis(1_250));
    let encoded = rig.encoded.lock().unwrap().clone();
    // The first frame, then one a second: two, or three if a busy machine slept past 2 s.
    let seconds = began.elapsed().as_secs() as usize;
    assert!(encoded.len() == 1 + seconds || (encoded.len() == 2 && seconds == 2), "{encoded:?} after {:?}", began.elapsed());
    assert!(encoded.iter().all(|&(frame, _, _)| frame == 7));
    let gap = encoded[1].1 - encoded[0].1;
    // Never early, and within the time this test watched: a busy machine (a CI runner) can wake the refresh thread
    // late, and the refresh is stamped when it is encoded.
    let watched = began.elapsed().as_nanos() as u64;
    assert!(gap >= 1_000_000_000 && gap < watched, "refreshed after {gap} ns, watched {watched} ns");
    rig.stop();
}

#[test]
fn with_every_slot_on_a_still_screen_is_encoded_at_the_frame_rate() {
    let mut rig = Rig::new("every-slot");
    rig.core.encode_every_slot(true);
    rig.shared.frame(7, Fake::now_ns());
    let began = Instant::now();
    rig.core.record().unwrap();
    std::thread::sleep(Duration::from_millis(1_000));
    let encoded = rig.encoded.lock().unwrap().clone();
    let slots = (began.elapsed().as_secs_f64() * 30.0) as usize;
    rig.stop();
    // 30 fps for the time it really slept, give or take the first frame and the scheduler.
    assert!(slots.saturating_sub(3) <= encoded.len() && encoded.len() <= slots + 2, "{} frames in {slots} slots: {encoded:?}", encoded.len());
    assert!(encoded.iter().all(|&(frame, _, _)| frame == 7));
    let t0 = encoded[0].1;
    for (n, &(_, at, _)) in encoded.iter().enumerate().skip(1) {
        assert_eq!(at, t0 + n as u64 * 33_333_333, "frame {n} on the grid");
    }
    assert!(encoded.windows(2).all(|w| w[1].1 > w[0].1));
}

#[test]
fn with_every_slot_the_first_slots_are_encoded_on_time_not_in_a_burst() {
    within_one_of_three("the first slot on time", |n| {
        let mut rig = Rig::new(&format!("every-slot-start-{n}"));
        rig.core.encode_every_slot(true);
        rig.shared.frame(7, Fake::now_ns());
        rig.core.record().unwrap();
        wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
        let first_at = rig.encoded.lock().unwrap()[0].1;
        let slack = scheduling_slack();
        let started = Instant::now();
        wait_for("the first slot", || rig.encoded.lock().unwrap().len() >= 2);
        // The slot is 33 ms after the start; the old first wake came at 100 ms, with three slots at once.
        let elapsed = started.elapsed();
        std::thread::sleep(Duration::from_millis(20));
        // A frame a slot, however long the sleep really took: not three slots at once. Counted from the first frame
        // on the clock the slots are on, since this thread can see the first frame late on a busy machine (a CI runner).
        let since_first = Duration::from_nanos(Fake::now_ns().saturating_sub(first_at));
        let allowed = 2 + (since_first.as_millis() / 33) as usize;
        let encoded = rig.encoded.lock().unwrap().clone();
        rig.stop();
        assert!(encoded.len() <= allowed, "{encoded:?}");
        if elapsed < Duration::from_millis(80) + slack * 2 { Ok(()) } else { Err(format!("first slot after {elapsed:?} (slack {slack:?})")) }
    });
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

/// System sound at 0.25 and the microphone's at 0.5, 10 ms each, for `ms` from `from` frames after t0.
/// Feeds `ms` of both inputs from frame `from` on, 10 ms at a time, paced by the wall clock: a fixed sleep per buffer
/// falls behind on a busy machine (a CI runner), and sound behind the clock is dropped as late.
fn feed_both(rig: &Rig, t0: u64, from: u64, ms: u64) -> u64 {
    let started = Instant::now();
    let mut next = from;
    while next < from + ms * 48 {
        let at = t0 + next * NANOS_PER_SECOND / 48_000;
        rig.shared.sound(0, at, 480, |_, _| 0.25).unwrap();
        rig.shared.sound(1, at, 480, |_, _| 0.5).unwrap();
        next += 480;
        let due = started + Duration::from_micros((next - from) * 1_000_000 / 48_000);
        if let Some(wait) = due.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
    }
    next
}

#[test]
fn levels_are_told_10_times_a_second_only_while_watched_each_kind_its_loudest() {
    let mut rig = Rig::with_inputs("levels", 2);
    rig.core.watch_microphone(1);
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    let t0 = rig.shared.t0_ns.load(Ordering::Acquire);
    let next = feed_both(&rig, t0, 0, 200);
    assert!(rig.heard.levels.lock().unwrap().is_empty(), "unwatched: none");
    rig.core.watch_levels(true);
    let fed = Instant::now();
    let next = feed_both(&rig, t0, next, 500);
    let took = fed.elapsed().as_millis() as usize;
    let levels = rig.heard.levels.lock().unwrap().clone();
    // One every 100 ms of the time it took, give or take one at each end.
    assert!((took / 100).saturating_sub(1) <= levels.len() && levels.len() <= took / 100 + 2, "{} in {took} ms: {levels:?}", levels.len());
    assert!(levels.iter().skip(1).all(|l| l.system == 0.25 && l.microphone == Some(0.5)), "{levels:?}");
    // Muted, an input still shows its level: what it hears, not what is recorded.
    rig.core.set_muted(true, true);
    rig.heard.levels.lock().unwrap().clear();
    let next = feed_both(&rig, t0, next, 200);
    assert!(rig.heard.levels.lock().unwrap().iter().skip(1).all(|l| l.system == 0.25 && l.microphone == Some(0.5)));
    rig.core.watch_levels(false);
    rig.heard.levels.lock().unwrap().clear();
    feed_both(&rig, t0, next, 200);
    assert!(rig.heard.levels.lock().unwrap().is_empty());
    rig.stop();
}

#[test]
fn a_prepared_session_tells_watched_levels_and_records_nothing_until_it_records() {
    let rig = Rig::with_inputs("prepared-levels", 2);
    rig.core.watch_microphone(1);
    assert!(!rig.shared.reads_sound(), "nothing is read before recording, unwatched");
    rig.core.watch_levels(true);
    assert!(rig.shared.reads_sound() && !rig.shared.wants_sound());
    feed_both(&rig, Fake::now_ns(), 0, 300);
    let levels = rig.heard.levels.lock().unwrap().clone();
    assert!(levels.len() >= 2 && levels.iter().skip(1).all(|l| l.system == 0.25 && l.microphone == Some(0.5)), "{levels:?}");
    assert_eq!(f32::from_bits(rig.loudest.load(Ordering::Acquire)), 0.0, "no sound reached the encoder");
}

#[test]
fn an_input_is_recorded_and_metered_at_its_volume() {
    let mut rig = Rig::with_inputs("gains", 2);
    rig.core.watch_microphone(1);
    rig.core.watch_levels(true);
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    let t0 = rig.shared.t0_ns.load(Ordering::Acquire);
    let loudest = |rig: &Rig| f32::from_bits(rig.loudest.swap(0, Ordering::AcqRel));
    // -6 dB on the system's 0.25, the microphone silent at the fader's bottom: about 0.125 recorded and metered.
    rig.core.set_gains(-6.0, SILENT_GAIN_DB);
    rig.heard.levels.lock().unwrap().clear();
    let next = feed_both(&rig, t0, 0, 300);
    let recorded = loudest(&rig);
    assert!((recorded - 0.125).abs() < 0.002, "{recorded}");
    let levels = rig.heard.levels.lock().unwrap().clone();
    assert!(levels.iter().skip(1).all(|l| (l.system - 0.125).abs() < 0.002 && l.microphone == Some(0.0)), "{levels:?}");
    // 600% on the microphone's 0.5 would reach 3: softly limited below full scale, not clipped.
    rig.core.set_gains(0.0, MAX_GAIN_DB);
    feed_both(&rig, t0, next, 100);
    let recorded = loudest(&rig);
    assert!(recorded > 0.95 && recorded < 1.0, "{recorded}");
    rig.stop();
}

#[test]
fn a_muted_input_is_recorded_as_silence_and_heard_again_once_unmuted() {
    let mut rig = Rig::with_inputs("muted", 2);
    rig.core.watch_microphone(1);
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    let t0 = rig.shared.t0_ns.load(Ordering::Acquire);
    let loudest = |rig: &Rig| f32::from_bits(rig.loudest.swap(0, Ordering::AcqRel));
    // The microphone muted: only the system's 0.25 reaches the encoder.
    rig.core.set_muted(false, true);
    let next = feed_both(&rig, t0, 0, 100);
    assert_eq!(loudest(&rig), 0.25);
    // Both muted: silence, the track still advancing.
    rig.core.set_muted(true, true);
    let next = feed_both(&rig, t0, next, 100);
    assert_eq!(loudest(&rig), 0.0);
    // Unmuted: the sum again.
    rig.core.set_muted(false, false);
    feed_both(&rig, t0, next, 100);
    assert_eq!(loudest(&rig), 0.75);
    let (_, stopped, _) = rig.stop();
    assert_eq!(stopped.late_audio_frames, [0, 0]);
    assert!(rig.heard.microphone_lost.lock().unwrap().is_empty(), "muting is no loss");
}

#[test]
fn an_audio_encoder_failing_on_the_microphone_s_sound_fails_the_recording_and_loses_no_microphone() {
    let mut rig = Rig::with_inputs("microphone-encoder", 2);
    rig.core.watch_microphone(1);
    rig.shared.frame(1, Fake::now_ns());
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    let t0 = rig.shared.t0_ns.load(Ordering::Acquire);
    // The system's sound is in; the microphone's is what reaches the broken encoder.
    rig.shared.sound(0, t0, 4_800, |_, _| 0.25).unwrap();
    rig.audio_fail.store(true, Ordering::Release);
    rig.shared.sound(1, t0, 4_800, |_, _| 0.5).unwrap();
    let failures = rig.heard.failures.lock().unwrap().clone();
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert_eq!(failures[0], ("capture_failed", "audio encoder broke".to_string()));
    assert!(rig.heard.microphone_lost.lock().unwrap().is_empty(), "{:?}", rig.heard.microphone_lost.lock().unwrap());
    rig.audio_fail.store(false, Ordering::Release);
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

#[test]
fn the_stop_reports_what_capture_delivered_while_recording() {
    let mut rig = Rig::new("captured");
    // Before recording: neither counted.
    rig.shared.frame(1, Fake::now_ns());
    rig.shared.frame_without_picture(Fake::now_ns());
    rig.core.first_frame(Duration::from_secs(1)).unwrap();
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    // Long after the frame before the start: no gap counts from it.
    std::thread::sleep(Duration::from_millis(120));
    let t = Fake::now_ns();
    rig.shared.frame(2, t + 1_000_000);
    rig.shared.frame(3, t + 18_000_000);
    rig.shared.frame_without_picture(t + 30_000_000);
    rig.shared.frame(4, t + 68_000_000);
    let (_, stopped, _) = rig.stop();
    assert_eq!(stopped.captured.pictures, 3);
    assert_eq!(stopped.captured.without_picture, 1);
    assert!((stopped.captured.longest_gap_ms - 50.0).abs() < 0.01, "{:?}", stopped.captured);
}

#[test]
fn a_refresh_the_screen_skipped_keeps_the_newest_picture_on_the_frame_grid() {
    let mut rig = Rig::new("unchanged");
    rig.shared.frame(1, Fake::now_ns());
    rig.core.first_frame(Duration::from_secs(1)).unwrap();
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    let t0 = rig.shared.t0_ns.load(Ordering::Acquire);
    // 30 fps from a 60 Hz display whose refreshes come 5 ms after the slots' grid: every second refresh is a slot's.
    // The refresh for the third slot was idle.
    let refresh = |n: u64| t0 + 5_000_000 + n * 16_666_667;
    for n in 1..=8 {
        if n == 5 { rig.shared.frame_unchanged(refresh(n)) } else { rig.shared.frame(100 + n as u32, refresh(n)) }
    }
    let encoded: Vec<(u32, u64)> = rig.encoded.lock().unwrap().iter().map(|&(frame, pts, _)| (frame, pts)).collect();
    // After the start's own first frame: one each 33 ms, the idle refresh's slot holding the newest picture, the one
    // the pacer had left out a refresh before.
    let gaps: Vec<u64> = encoded[1..].windows(2).map(|w| (w[1].1 - w[0].1 + 500_000) / 1_000_000).collect();
    assert_eq!(gaps, [33, 33, 33], "encoded {encoded:?}");
    assert_eq!(encoded[1..].iter().map(|&(frame, _)| frame).collect::<Vec<_>>(), [101, 103, 104, 107]);
    rig.stop();
}

#[test]
fn a_refresh_capture_skipped_is_filled_with_the_newest_picture() {
    let mut rig = Rig::new("skipped");
    rig.shared.frame(1, Fake::now_ns());
    rig.core.first_frame(Duration::from_secs(1)).unwrap();
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    let t0 = rig.shared.t0_ns.load(Ordering::Acquire);
    // Plan 078 step 1: 30 fps from a 60 Hz display, refreshes 8 ms before the slots' grid (as recorded on 2026-10-17);
    // capture skipped the sixth refresh, a slot's, and delivered nothing for it.
    let refresh = |n: u64| t0 + n * 16_666_667 - 8_000_000;
    for n in 2..=10 {
        if n != 6 {
            rig.shared.frame(100 + n as u32, refresh(n));
        }
    }
    let encoded: Vec<(u32, u64)> = rig.encoded.lock().unwrap().iter().map(|&(frame, pts, _)| (frame, pts)).collect();
    let gaps: Vec<u64> = encoded[1..].windows(2).map(|w| (w[1].1 - w[0].1 + 500_000) / 1_000_000).collect();
    // One every 33 ms: the skipped refresh's slot holds the picture of the refresh before it, and the one after it,
    // too soon after that, is left out rather than kept 17 ms early.
    assert_eq!(gaps, [33, 33, 33, 33], "encoded {encoded:?}");
    assert_eq!(encoded[1..].iter().map(|&(frame, _)| frame).collect::<Vec<_>>(), [102, 104, 105, 108, 110]);
    rig.stop();
}

/// The platform's camera as the core sees it (plan 075, step 5): judged on the refresh thread, its closes counted.
struct FakeCamera {
    feed: Arc<CameraFeed<u32>>,
    closes: AtomicUsize,
}

impl CameraControl for FakeCamera {
    fn judge(&self, now_ns: u64, since_ns: u64, events: &dyn Events) {
        self.feed.judge(now_ns, since_ns, true, events);
    }
    fn close(&self) {
        self.closes.fetch_add(1, Ordering::AcqRel);
        self.feed.clear();
    }
}

impl Rig {
    fn watch_camera(&self) -> Arc<FakeCamera> {
        let camera = Arc::new(FakeCamera { feed: self.camera.clone(), closes: AtomicUsize::new(0) });
        self.core.watch_camera(camera.clone());
        camera
    }

    /// A camera frame captured now.
    fn camera_frame(&self, n: u32) {
        self.camera.deliver(n, Fake::now_ns(), Fake::now_ns(), &*self.heard);
    }
}

#[test]
fn the_camera_keeps_only_its_newest_frame() {
    let feed = CameraFeed::<u32>::default();
    let heard = Heard::default();
    assert_eq!(feed.latest(), None);
    for n in 1..=3 {
        feed.deliver(n, 10 * u64::from(n), 10 * u64::from(n), &heard);
    }
    assert_eq!(feed.latest(), Some((3, 30)));
    assert_eq!(feed.counts(), (3, 0));
}

#[test]
fn the_camera_s_age_in_its_frames_is_summed_up_for_the_log() {
    let ages = CameraAges::default();
    assert_eq!(ages.summary(), None, "nothing before a frame is composed with the camera");
    ages.record(40_000_000, 10_000_000);
    ages.record(50_000_000, 30_000_000);
    ages.record(60_000_000, 65_000_000);
    assert_eq!(ages.summary().as_deref(), Some("the camera's picture 15.0 ms older than its frame on average (-5.0 to 30.0 ms) in 3 frame(s)"));
}

#[test]
fn each_encoded_frame_takes_the_camera_s_newest_frame_whether_the_camera_is_slower_or_faster() {
    for (camera_interval, expect_repeats) in [(Duration::from_millis(66), true), (Duration::from_millis(16), false)] {
        let mut rig = Rig::new(if expect_repeats { "camera-slower" } else { "camera-faster" });
        rig.core.encode_every_slot(true);
        rig.watch_camera();
        rig.camera_frame(0);
        rig.shared.frame(7, Fake::now_ns());
        rig.core.record().unwrap();
        let began = Instant::now();
        let end = began + Duration::from_millis(700);
        let mut n = 1;
        while Instant::now() < end {
            rig.camera_frame(n);
            n += 1;
            std::thread::sleep(camera_interval);
        }
        // The rate the camera really delivered at: a busy machine (a CI runner) sleeps longer than asked.
        let camera_fps = f64::from(n - 1) / began.elapsed().as_secs_f64();
        rig.stop();
        let composed: Vec<u32> = rig.composed.lock().unwrap().iter().map(|c| c.expect("a camera frame in every encoded frame")).collect();
        assert!(composed.len() >= 15, "{composed:?}");
        // Never an older frame after a newer one.
        assert!(composed.windows(2).all(|w| w[1] >= w[0]), "{composed:?}");
        let repeats = composed.windows(2).filter(|w| w[0] == w[1]).count();
        let skips = composed.windows(2).filter(|w| w[1] > w[0] + 1).count();
        if expect_repeats {
            // 15 fps into 30: each camera frame about twice.
            assert!(repeats * 3 >= composed.len(), "slower camera: {composed:?}");
        } else if camera_fps > 45.0 {
            // 60 fps into 30: frames in between are left out, never queued.
            assert!(skips * 3 >= composed.len(), "faster camera at {camera_fps:.0} fps: {composed:?}");
        }
    }
}

#[test]
fn a_camera_silent_for_two_seconds_is_told_lost_composes_nothing_and_comes_back_with_its_next_frame() {
    let mut rig = Rig::new("camera-lost");
    rig.core.encode_every_slot(true);
    rig.watch_camera();
    rig.camera_frame(1);
    rig.shared.frame(7, Fake::now_ns());
    let began = Instant::now();
    rig.core.record().unwrap();
    // No frame for a while: not yet lost before 2 s (unless a busy machine slept that long).
    std::thread::sleep(Duration::from_millis(1_500));
    assert!(rig.heard.camera_lost.lock().unwrap().is_empty() || began.elapsed() >= Duration::from_millis(1_900));
    wait_for("the loss", || !rig.heard.camera_lost.lock().unwrap().is_empty());
    assert!(rig.camera.is_lost());
    assert_eq!(rig.camera.latest(), None, "a lost camera gives the compositor nothing");
    let lost_at = rig.composed.lock().unwrap().len();
    std::thread::sleep(Duration::from_millis(200));
    assert!(rig.composed.lock().unwrap()[lost_at..].iter().all(Option::is_none), "the screen alone while it is lost");
    // Told once, however long it stays silent.
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(rig.heard.camera_lost.lock().unwrap().len(), 1);
    rig.camera_frame(2);
    assert_eq!(rig.heard.camera_resumed.lock().unwrap().len(), 1);
    assert_eq!(rig.camera.latest().map(|(n, _)| n), Some(2));
    wait_for("the camera composed again", || rig.composed.lock().unwrap().last() == Some(&Some(2)));
    rig.stop();
    assert_eq!(rig.camera.counts(), (2, 1));
}

#[test]
fn a_camera_is_never_told_lost_before_the_recording_or_when_it_delivers() {
    let feed = CameraFeed::<u32>::default();
    let heard = Heard::default();
    // Prepared, silent for long: not a loss.
    feed.judge(10 * NANOS_PER_SECOND, 0, false, &heard);
    assert!(heard.camera_lost.lock().unwrap().is_empty());
    // Recording since 1 s, a frame at 2 s: judged at 3.9 s it is still delivering.
    feed.deliver(1, 2 * NANOS_PER_SECOND, 2 * NANOS_PER_SECOND, &heard);
    feed.judge(3_900_000_000, NANOS_PER_SECOND, true, &heard);
    assert!(heard.camera_lost.lock().unwrap().is_empty());
    feed.judge(4_100_000_000, NANOS_PER_SECOND, true, &heard);
    assert_eq!(heard.camera_lost.lock().unwrap().len(), 1);
    // A device the platform sees go is told at once while recording, and only once.
    let gone = CameraFeed::<u32>::default();
    gone.deliver(1, 1, 1, &heard);
    gone.lose("disconnected".into(), true, &heard);
    gone.lose("disconnected".into(), true, &heard);
    assert_eq!(heard.camera_lost.lock().unwrap().len(), 2);
    assert_eq!(gone.latest(), None);
}

#[test]
fn the_camera_is_closed_however_the_session_ends() {
    // A stop: closed once capture has ended, before the file is finished.
    let mut stopped = Rig::new("camera-stop");
    let camera = stopped.watch_camera();
    stopped.shared.frame(1, Fake::now_ns());
    stopped.core.record().unwrap();
    wait_for("the first frame", || !stopped.encoded.lock().unwrap().is_empty());
    let stop_ns = Fake::now_ns();
    let drained = stopped.core.drain(stop_ns);
    stopped.core.halt();
    stopped.core.halted();
    assert_eq!(camera.closes.load(Ordering::Acquire), 1, "closed at the halt");
    let (_, finishing) = stopped.core.end(stop_ns, drained);
    finishing.wait().unwrap();
    drop(stopped);
    assert_eq!(camera.closes.load(Ordering::Acquire), 1, "and only once");

    // A cancel: a prepared session released.
    let cancelled = Rig::new("camera-cancel");
    let camera = cancelled.watch_camera();
    cancelled.core.halt();
    cancelled.core.release();
    assert_eq!(camera.closes.load(Ordering::Acquire), 1);

    // Its owner gone without either (a failed prepare, a session dropped).
    let dropped = Rig::new("camera-drop");
    let camera = dropped.watch_camera();
    drop(dropped);
    assert_eq!(camera.closes.load(Ordering::Acquire), 1);
    assert_eq!(camera.feed.latest(), None);
}

#[test]
fn hiding_the_camera_goes_back_to_a_still_screen_s_pace_and_showing_it_to_every_slot() {
    let mut rig = Rig::new("every-slot-toggle");
    rig.core.encode_every_slot(true);
    rig.shared.frame(7, Fake::now_ns());
    rig.core.record().unwrap();
    // Judged by the frames' own times, not by how many a fixed sleep saw: a busy machine (a CI runner) can starve the
    // refresh thread for a while, leaving fewer frames, but those it encodes are still a slot apart.
    let times = |rig: &Rig| rig.encoded.lock().unwrap().iter().map(|&(_, at, _)| at).collect::<Vec<u64>>();
    wait_for("frames while shown", || rig.encoded.lock().unwrap().len() >= 7);
    let shown = times(&rig);
    assert!(median_interval(&shown) < 40_000_000, "every slot while shown: {shown:?}");
    rig.core.encode_every_slot(false);
    std::thread::sleep(Duration::from_millis(600));
    let hidden = times(&rig).len() - shown.len();
    assert!(hidden <= 1, "a still screen once a second while hidden: {hidden}");
    rig.core.encode_every_slot(true);
    let resumed_from = shown.len() + hidden;
    wait_for("frames shown again", || rig.encoded.lock().unwrap().len() >= resumed_from + 6);
    let again = times(&rig)[resumed_from..].to_vec();
    assert!(median_interval(&again) < 40_000_000, "every slot again: {again:?}");
    rig.stop();
}

#[test]
fn showing_the_camera_again_after_a_still_screen_starts_at_the_current_slot_without_a_burst() {
    let mut rig = Rig::new("every-slot-resume");
    rig.shared.frame(7, Fake::now_ns());
    rig.core.record().unwrap();
    wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
    // Hidden over a still screen for a while: a refresh a second.
    std::thread::sleep(Duration::from_millis(1_300));
    let before = rig.encoded.lock().unwrap().len();
    let shown_at = Fake::now_ns();
    rig.core.encode_every_slot(true);
    std::thread::sleep(Duration::from_millis(400));
    rig.stop();
    let encoded = rig.encoded.lock().unwrap().clone();
    let after: Vec<u64> = encoded[before..].iter().map(|&(_, at, _)| at).collect();
    assert!(after.len() >= 8, "{after:?}");
    // Nothing before the camera was shown again, and frames a slot apart, not a burst of the slots it left empty.
    assert!(after.iter().all(|&at| at + 33_333_333 >= shown_at), "{after:?} from {shown_at}");
    assert!(after.windows(2).all(|w| w[1] - w[0] >= 30_000_000), "{after:?}");
}

#[test]
fn showing_the_camera_wakes_the_refresh_thread_for_the_next_slot() {
    within_one_of_three("the next slot after showing the camera", |n| {
        let mut rig = Rig::new(&format!("every-slot-wake-{n}"));
        rig.shared.frame(7, Fake::now_ns());
        rig.core.record().unwrap();
        wait_for("the first frame", || !rig.encoded.lock().unwrap().is_empty());
        let slack = scheduling_slack();
        // Shown just after the still screen's refresh a second later, when the refresh thread has just begun a 100 ms
        // wait: without being woken it would encode nothing for most of that wait, wherever the wait's phase falls.
        wait_for("the refresh a second later", || rig.encoded.lock().unwrap().len() >= 2);
        let before = rig.encoded.lock().unwrap().len();
        let shown = Instant::now();
        rig.core.encode_every_slot(true);
        let ((), during) = slack_during(|| wait_for("the next slot", || rig.encoded.lock().unwrap().len() > before));
        let slack = slack.max(during);
        let elapsed = shown.elapsed();
        std::thread::sleep(Duration::from_millis(20));
        // A frame a slot from then on, however long the sleep really took, not the slots the still screen left empty.
        let allowed = 2 + (shown.elapsed().as_millis() / 33) as usize;
        let count = rig.encoded.lock().unwrap().len() - before;
        rig.stop();
        assert!(count <= allowed, "no catch-up burst");
        // Within a slot and a little, not at the end of a 100 ms wait, allowing how late this machine woke threads then.
        if elapsed < Duration::from_millis(60) + slack * 2 { Ok(()) } else { Err(format!("first frame after {elapsed:?} (slack {slack:?})")) }
    });
}

#[test]
fn the_pacer_skips_to_the_current_slot_on_its_grid() {
    let start = 1_000_000_000_000u64;
    let interval = 33_333_333u64;
    let mut pacer = crate::pacing::Pacer::new(start, 30);
    // Behind by a second: the first slot at or after it, on the grid from the start.
    pacer.skip_to(start + 1_000_000_000);
    assert_eq!(pacer.next_slot(), start + 31 * interval);
    // On a slot exactly: that slot.
    pacer.skip_to(start + 40 * interval);
    assert_eq!(pacer.next_slot(), start + 40 * interval);
    // Already ahead: unchanged, never backwards.
    pacer.skip_to(start + 35 * interval);
    assert_eq!(pacer.next_slot(), start + 40 * interval);
}

#[test]
fn frame_lead_without_a_frame_is_zero_not_the_maximums_start() {
    assert_eq!(frame_lead_ms(0, 0, i64::MIN), (0.0, 0.0));
    assert_eq!(frame_lead_ms(3_000, 2, 2_500), (1.5, 2.5));
    assert_eq!(frame_lead_ms(-4_000, 2, -1_000), (-2.0, -1.0));
}

#[test]
fn a_writer_gone_without_answering_is_not_reported_as_a_timeout() {
    let (reply, result) = std::sync::mpsc::channel();
    drop(reply);
    let failure = Finishing::from_receiver(result).wait().err().unwrap();
    assert_eq!(failure.code, "output_write_failed");
    assert_eq!(failure.detail, "the writer ended without finishing the file");
}
