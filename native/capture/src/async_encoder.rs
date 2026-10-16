//! Driving an asynchronous H.264 encoder (plan 078 step 4): a GPU's hardware encoder on Windows, a Media Foundation
//! transform that asks for input (`NeedInput`) and announces output (`HaveOutput`) through events instead of answering
//! each call. The driver is the platform-independent half, so it is tested with a fake encoder that stalls, fails and
//! changes its format; win/hardware.rs is the transform itself.
//!
//! None of the practice it follows trusts a hardware encoder without a way back (Cap at revision `83237e9`, read for
//! design only, OBS and Chromium): an encoder that takes input and gives nothing back, refuses input again and again,
//! is silent for 5 s or reports an error ends here. Before its first sample reached the muxer, the frames it still
//! holds go back to the caller, which records them with the software encoder instead; after that, the recording ends
//! with what was written, as a capture failure.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use crate::avc;
use crate::core::VideoSink;
use crate::timing::NANOS_PER_SECOND;
use crate::writer::Media;

/// What the encoder announces.
#[derive(Debug)]
pub enum EncoderEvent {
    NeedInput,
    HaveOutput,
    DrainComplete,
    Error(String),
}

/// What one call for output gave.
#[derive(Debug)]
pub enum Output {
    /// Annex B H.264 and its time in 100 ns units.
    Sample { data: Vec<u8>, time: i64 },
    /// The encoder settled another output format and goes on.
    StreamChanged,
    /// Nothing after all.
    Nothing,
}

/// The transform the driver feeds; its events come into the driver's channel as `Message::Event`.
pub trait AsyncTransform {
    type Frame;
    /// Queues `frame` at `time` (100 ns units from the first frame), lasting `duration`, a key frame when asked.
    fn input(&mut self, frame: &Self::Frame, time: i64, duration: i64, key_frame: bool) -> Result<(), String>;
    /// Takes the output a `HaveOutput` announced.
    fn output(&mut self) -> Result<Output, String>;
    /// Asks for everything queued; `DrainComplete` follows.
    fn drain(&mut self) -> Result<(), String>;
}

pub enum Message<F> {
    Frame { frame: F, pts_ns: u64, key_frame: bool },
    /// Answered once every queued frame's sample has reached the sink.
    Flush(Sender<()>),
    Event(EncoderEvent),
    /// The encoder is no longer wanted. Its event callback keeps a sender, so the channel itself never closes.
    Close,
}

/// When the encoder is given up on.
#[derive(Clone, Copy, Debug)]
pub struct Watchdog {
    /// Frames taken without a sample coming back.
    pub inputs_without_output: u32,
    /// Input refused this many times in a row.
    pub input_failures: u32,
    /// No sample for this long while frames are waiting for one, or no `DrainComplete` this long after a drain.
    pub silence: Duration,
}

impl Default for Watchdog {
    fn default() -> Self {
        Self { inputs_without_output: 60, input_failures: 3, silence: Duration::from_secs(5) }
    }
}

/// How the driver ended.
pub enum Ended<F> {
    /// `Close` came, or the channel closed: the encoder is no longer wanted.
    Closed,
    /// The encoder failed. `fallback` holds what the caller can record another way when no sample had reached the
    /// sink yet: every frame not yet encoded, in order, and a flush still to answer; `None` once one had.
    Failed { detail: String, fallback: Option<Fallback<F>> },
}

pub struct Fallback<F> {
    pub frames: Vec<(F, u64, bool)>,
    pub flush: Option<Sender<()>>,
}

struct Queued<F> {
    frame: F,
    pts_ns: u64,
    key_frame: bool,
}

/// Feeds `transform` the frames that arrive on `messages` as it asks for them and sends its samples to `sink`: the
/// format once, from the first sample's parameter sets, then each sample at the capture time of the frame it encodes.
/// A key frame comes at least every second of presentation time, as on macOS. Returns when the channel closes or the
/// encoder fails; the sink hears nothing of a failure, which is the caller's to report or recover from.
pub fn drive<T: AsyncTransform>(
    transform: &mut T,
    messages: &Receiver<Message<T::Frame>>,
    sink: &Arc<dyn VideoSink>,
    (width, height, frame_rate): (u32, u32, u32),
    watchdog: Watchdog,
) -> Ended<T::Frame> {
    let frame_duration = 10_000_000 / i64::from(frame_rate.max(1));
    // Frames waiting for the encoder to ask, and frames it took, by encoder time, until their sample comes back.
    let mut waiting: VecDeque<Queued<T::Frame>> = VecDeque::new();
    let mut taken: VecDeque<(i64, Queued<T::Frame>)> = VecDeque::new();
    let mut asked = 0u32;
    let mut origin: Option<u64> = None;
    let mut last_key: Option<u64> = None;
    let mut format_sent = false;
    let mut since_output = 0u32;
    let mut refused = 0u32;
    // Since when frames have waited for a sample, or a drain for its end.
    let mut silent_since: Option<Instant> = None;
    let mut flush: Option<Sender<()>> = None;
    let mut draining = false;

    let failed = |detail: String, format_sent: bool, taken: VecDeque<(i64, Queued<T::Frame>)>, waiting: VecDeque<Queued<T::Frame>>, flush: Option<Sender<()>>| {
        let fallback = (!format_sent).then(|| Fallback {
            frames: taken.into_iter().map(|(_, q)| q).chain(waiting).map(|q| (q.frame, q.pts_ns, q.key_frame)).collect(),
            flush,
        });
        Ended::Failed { detail, fallback }
    };

    loop {
        // Feed what the encoder asked for.
        while asked > 0 && !draining {
            let Some(next) = waiting.pop_front() else { break };
            let origin = *origin.get_or_insert(next.pts_ns);
            let due = last_key.is_none_or(|last| next.pts_ns.saturating_sub(last) >= NANOS_PER_SECOND);
            let key_frame = next.key_frame || due;
            let time = (next.pts_ns.saturating_sub(origin) / 100) as i64;
            match transform.input(&next.frame, time, frame_duration, key_frame) {
                Ok(()) => {
                    asked -= 1;
                    refused = 0;
                    since_output += 1;
                    if key_frame {
                        last_key = Some(next.pts_ns);
                    }
                    silent_since.get_or_insert_with(Instant::now);
                    taken.push_back((time, next));
                    if since_output > watchdog.inputs_without_output {
                        let detail = format!("the encoder took {since_output} frames without giving one back");
                        return failed(detail, format_sent, taken, waiting, flush);
                    }
                }
                Err(detail) => {
                    refused += 1;
                    // Before a sample reached the muxer nothing is lost by giving up at once: the software encoder
                    // takes every frame, this one included (review of plan 078).
                    if !format_sent || refused >= watchdog.input_failures {
                        waiting.push_front(next);
                        return failed(format!("the encoder refused {refused} frames in a row: {detail}"), format_sent, taken, waiting, flush);
                    }
                    // This frame is left out; the next one is tried at the next request.
                    asked -= 1;
                }
            }
        }
        // Frames waiting for the encoder to ask are outstanding work too: an encoder that never asks, or stops asking,
        // is given up by the watchdog instead of holding them, and a flush behind them, forever.
        if !waiting.is_empty() && silent_since.is_none() {
            silent_since = Some(Instant::now());
        }
        // Every queued frame is in: a flush can drain.
        if flush.is_some() && !draining && waiting.is_empty() {
            if let Err(detail) = transform.drain() {
                return failed(format!("draining the encoder failed: {detail}"), format_sent, taken, waiting, flush);
            }
            draining = true;
            silent_since = Some(Instant::now());
        }

        let message = match messages.recv_timeout(Duration::from_millis(250)) {
            Ok(message) => Some(message),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return Ended::Closed,
        };
        match message {
            None => {}
            Some(Message::Close) => return Ended::Closed,
            Some(Message::Frame { frame, pts_ns, key_frame }) => waiting.push_back(Queued { frame, pts_ns, key_frame }),
            Some(Message::Flush(done)) => match flush {
                // One flush at a time; a second is answered with the first.
                Some(_) => drop(done),
                None => flush = Some(done),
            },
            Some(Message::Event(EncoderEvent::NeedInput)) => asked += 1,
            // A format change leaves the announced output where it was: it is asked for again at once (a few times).
            Some(Message::Event(EncoderEvent::HaveOutput)) => match (0..4).map(|_| transform.output()).find(|output| !matches!(output, Ok(Output::StreamChanged))).unwrap_or(Ok(Output::Nothing)) {
                Ok(Output::Sample { data, time }) => {
                    // Checked before any frame is let go, so a fallback still has them all.
                    let format = if format_sent {
                        None
                    } else {
                        let Some((sps, pps)) = avc::parameter_sets(&data) else {
                            return failed("the first H.264 sample has no parameter sets".into(), format_sent, taken, waiting, flush);
                        };
                        Some(avc::decoder_config(sps, pps))
                    };
                    while taken.front().is_some_and(|(queued, _)| *queued < time) {
                        taken.pop_front();
                    }
                    let pts_ns = match taken.front() {
                        Some((queued, _)) if *queued == time => taken.pop_front().map(|(_, q)| q.pts_ns).unwrap_or_default(),
                        _ => origin.unwrap_or(0) + time.max(0) as u64 * 100,
                    };
                    if let Some(avcc) = format {
                        sink.media(Media::VideoFormat { avcc, width: width as u16, height: height as u16 });
                        format_sent = true;
                    }
                    let (data, sync) = avc::sample(&data);
                    sink.media(Media::Video { data, pts_ns, sync });
                    since_output = 0;
                    silent_since = (!taken.is_empty() || !waiting.is_empty() || draining).then(Instant::now);
                }
                Ok(Output::StreamChanged | Output::Nothing) => {}
                Err(detail) => return failed(format!("reading the encoder's output failed: {detail}"), format_sent, taken, waiting, flush),
            },
            Some(Message::Event(EncoderEvent::DrainComplete)) => {
                if let Some(done) = flush.take() {
                    let _ = done.send(());
                }
                draining = false;
                taken.clear();
                silent_since = None;
            }
            Some(Message::Event(EncoderEvent::Error(detail))) => {
                return failed(format!("the encoder reported an error: {detail}"), format_sent, taken, waiting, flush);
            }
        }
        if silent_since.is_some_and(|since| since.elapsed() >= watchdog.silence) {
            let what = if draining { "finish draining" } else { "give a frame back" };
            return failed(format!("the encoder did not {what} within {} s", watchdog.silence.as_secs()), format_sent, taken, waiting, flush);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::mpsc::channel;

    /// An Annex B key frame with its parameter sets, and a delta frame.
    const KEY: &[u8] = &[0, 0, 0, 1, 0x67, 0x64, 0, 0x1f, 0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80, 0, 0, 0, 1, 0x65, 0x88];
    const DELTA: &[u8] = &[0, 0, 0, 1, 0x41, 0x9a];

    #[derive(Default)]
    struct Collect(Mutex<Vec<Media>>);
    impl VideoSink for Collect {
        fn media(&self, media: Media) {
            self.0.lock().unwrap().push(media);
        }
        fn failed(&self, detail: String) {
            panic!("the driver reports nothing itself: {detail}");
        }
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Behaviour {
        /// Asks again at once and gives each frame back.
        Healthy,
        /// Takes frames and gives nothing back, asking again each time.
        Hoards,
        /// Refuses every frame.
        Refuses,
        /// Gives the first two frames back, then reports an error.
        FailsAfterTwo,
        /// Announces a format change before each output.
        ChangesFormat,
        /// Never asks for input.
        Silent,
    }

    struct Fake {
        events: Sender<Message<u32>>,
        behaviour: Behaviour,
        /// Times of frames taken and not yet given back.
        pending: VecDeque<i64>,
        outputs: u32,
        changed: bool,
        keys: Vec<bool>,
    }

    impl Fake {
        fn new(events: Sender<Message<u32>>, behaviour: Behaviour) -> Self {
            if behaviour != Behaviour::Silent {
                events.send(Message::Event(EncoderEvent::NeedInput)).unwrap();
            }
            Self { events, behaviour, pending: VecDeque::new(), outputs: 0, changed: false, keys: Vec::new() }
        }
        fn event(&self, event: EncoderEvent) {
            let _ = self.events.send(Message::Event(event));
        }
    }

    impl AsyncTransform for Fake {
        type Frame = u32;
        fn input(&mut self, _frame: &u32, time: i64, _duration: i64, key_frame: bool) -> Result<(), String> {
            if self.behaviour == Behaviour::Refuses {
                self.event(EncoderEvent::NeedInput);
                return Err("E_FAIL".into());
            }
            self.keys.push(key_frame);
            self.pending.push_back(time);
            if self.behaviour == Behaviour::Silent {
                return Ok(());
            }
            if self.behaviour != Behaviour::Hoards {
                self.event(EncoderEvent::HaveOutput);
            }
            self.event(EncoderEvent::NeedInput);
            Ok(())
        }
        fn output(&mut self) -> Result<Output, String> {
            // As Media Foundation does: the announced output stays pending, with no new event for it.
            if self.behaviour == Behaviour::ChangesFormat && !self.changed {
                self.changed = true;
                return Ok(Output::StreamChanged);
            }
            self.changed = false;
            let Some(time) = self.pending.pop_front() else { return Ok(Output::Nothing) };
            self.outputs += 1;
            if self.behaviour == Behaviour::FailsAfterTwo && self.outputs == 2 {
                self.event(EncoderEvent::Error("MF_E_HW_MFT_FAILED_START_STREAMING".into()));
            }
            Ok(Output::Sample { data: if self.outputs == 1 { KEY.to_vec() } else { DELTA.to_vec() }, time })
        }
        fn drain(&mut self) -> Result<(), String> {
            for _ in 0..self.pending.len() {
                self.event(EncoderEvent::HaveOutput);
            }
            self.event(EncoderEvent::DrainComplete);
            Ok(())
        }
    }

    const FAST: Watchdog = Watchdog { inputs_without_output: 10, input_failures: 3, silence: Duration::from_millis(400) };

    /// Runs `frames` frames 33 ms apart through a fake that behaves so, then a flush, and returns what the sink got,
    /// how the driver ended and whether the flush was answered.
    fn run(behaviour: Behaviour, frames: u32) -> (Vec<Media>, Ended<u32>, bool, Vec<bool>) {
        let (sender, messages) = channel();
        let mut fake = Fake::new(sender.clone(), behaviour);
        let start = 1_000 * NANOS_PER_SECOND;
        for n in 0..frames {
            sender.send(Message::Frame { frame: n, pts_ns: start + u64::from(n) * 33_333_333, key_frame: n == 0 }).unwrap();
        }
        let (done, flushed) = channel();
        sender.send(Message::Flush(done)).unwrap();
        // After the drain's events, which the fake sends as the flush is handled.
        let closer = sender.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            let _ = closer.send(Message::Close);
        });
        drop(sender);
        let sink = Arc::new(Collect::default());
        let as_sink: Arc<dyn VideoSink> = sink.clone();
        let ended = drive(&mut fake, &messages, &as_sink, (640, 360, 30), FAST);
        let media = std::mem::take(&mut *sink.0.lock().unwrap());
        (media, ended, flushed.try_recv().is_ok(), fake.keys)
    }

    fn samples(media: &[Media]) -> Vec<u64> {
        media.iter().filter_map(|m| if let Media::Video { pts_ns, .. } = m { Some(*pts_ns) } else { None }).collect()
    }

    #[test]
    fn a_healthy_encoder_gives_the_format_then_each_frame_at_its_capture_time() {
        let (media, ended, flushed, keys) = run(Behaviour::Healthy, 40);
        assert!(matches!(media.first(), Some(Media::VideoFormat { width: 640, height: 360, .. })));
        let times = samples(&media);
        assert_eq!(times.len(), 40);
        assert_eq!(times[1] - times[0], 33_333_333);
        assert!(flushed, "the flush is answered once drained");
        assert!(matches!(ended, Ended::Closed));
        // A key frame at the start and then once a second has passed (frame 31, 1.03 s in).
        assert!(keys[0] && keys[31] && keys.iter().filter(|&&k| k).count() == 2, "{keys:?}");
    }

    #[test]
    fn a_format_change_is_taken_in_stride() {
        let (media, ended, flushed, _) = run(Behaviour::ChangesFormat, 5);
        assert_eq!(samples(&media).len(), 5);
        assert!(flushed && matches!(ended, Ended::Closed));
    }

    #[test]
    fn an_encoder_that_gives_nothing_back_is_given_up_with_every_frame_for_the_software_encoder() {
        let (media, ended, _, _) = run(Behaviour::Hoards, 20);
        assert!(media.is_empty());
        let Ended::Failed { detail, fallback: Some(fallback) } = ended else { panic!("expected a failure with a fallback") };
        assert!(detail.contains("without giving one back"), "{detail}");
        assert_eq!(fallback.frames.iter().map(|f| f.0).collect::<Vec<_>>(), (0..20).collect::<Vec<_>>(), "every frame, in order");
        assert!(fallback.flush.is_some(), "the flush is the fallback's to answer");
    }

    #[test]
    fn an_encoder_that_refuses_its_first_frame_hands_every_frame_to_the_software_encoder() {
        let (_, ended, _, _) = run(Behaviour::Refuses, 5);
        let Ended::Failed { detail, fallback: Some(fallback) } = ended else { panic!("expected a failure with a fallback") };
        assert!(detail.contains("refused 1 frames"), "{detail}");
        // The refused frame itself; the frames after it are still on the channel, which the fallback reads next.
        assert_eq!(fallback.frames.iter().map(|f| f.0).collect::<Vec<_>>(), [0], "nothing lost");
    }

    #[test]
    fn an_encoder_that_never_asks_for_input_is_given_up_with_its_frames_and_the_flush() {
        let (sender, messages) = channel();
        let mut fake = Fake::new(sender.clone(), Behaviour::Silent);
        for n in 0..3 {
            sender.send(Message::Frame { frame: n, pts_ns: u64::from(n) * 33_333_333, key_frame: n == 0 }).unwrap();
        }
        let (done, _flushed) = channel();
        sender.send(Message::Flush(done)).unwrap();
        let sink: Arc<dyn VideoSink> = Arc::new(Collect::default());
        let began = Instant::now();
        let ended = drive(&mut fake, &messages, &sink, (640, 360, 30), Watchdog { silence: Duration::from_millis(300), ..FAST });
        assert!(began.elapsed() < Duration::from_secs(2), "the watchdog, not a hang");
        let Ended::Failed { detail, fallback: Some(fallback) } = ended else { panic!("expected a failure with a fallback") };
        assert!(detail.contains("within"), "{detail}");
        assert_eq!(fallback.frames.len(), 3);
        assert!(fallback.flush.is_some());
        drop(sender);
    }

    #[test]
    fn an_error_after_the_first_sample_ends_the_recording_without_a_fallback() {
        let (media, ended, _, _) = run(Behaviour::FailsAfterTwo, 10);
        assert_eq!(samples(&media).len(), 2);
        let Ended::Failed { detail, fallback } = ended else { panic!("expected a failure") };
        assert!(detail.contains("MF_E_HW_MFT_FAILED_START_STREAMING"), "{detail}");
        assert!(fallback.is_none(), "samples reached the muxer: the recording ends instead");
    }

    #[test]
    fn a_silent_encoder_with_a_frame_waiting_ends_by_the_watchdog_not_at_once() {
        let (sender, messages) = channel();
        let mut fake = Fake::new(sender.clone(), Behaviour::Silent);
        // It never asks: the frame waits, and with nothing taken the watchdog has nothing to time yet.
        sender.send(Message::Frame { frame: 7, pts_ns: 1, key_frame: true }).unwrap();
        sender.send(Message::Event(EncoderEvent::NeedInput)).unwrap();
        let sink: Arc<dyn VideoSink> = Arc::new(Collect::default());
        let began = Instant::now();
        // Asked once, then silent: the taken frame is never given back.
        let ended = drive(&mut fake, &messages, &sink, (640, 360, 30), Watchdog { silence: Duration::from_millis(300), ..FAST });
        assert!(began.elapsed() >= Duration::from_millis(300));
        let Ended::Failed { detail, fallback: Some(fallback) } = ended else { panic!("expected a failure with a fallback") };
        assert!(detail.contains("did not give a frame back within"), "{detail}");
        assert_eq!(fallback.frames.len(), 1);
        drop(sender);
    }
}
