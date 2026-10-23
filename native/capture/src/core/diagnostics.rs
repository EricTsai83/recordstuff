//! The pipeline's stage counters (plan 083), a development switch: with `RECORDSTUFF_DIAGNOSTICS=1` in the app's
//! environment each session keeps bounded histograms of how long its stages take and the high-water marks of its
//! queues, which the capture host reads once the session has ended (`NativeCapture::diagnostics`) and logs as one
//! `diagnostics: engine {…}` line. Off by default; nothing ships that sets it, and with it off no stage is timed.
//!
//! Every figure is taken on one clock inside the capture process (the host clock frames are stamped with, or the
//! monotonic `Instant`), so no two processes' clocks are subtracted. Nothing per frame is written anywhere: a
//! histogram is a fixed array of counters, so its memory does not grow with the recording's length.
//!
//! Buckets (shared with `src/shared/pipeline-histogram.ts`, which merges and reads them): a value in microseconds `v`
//! falls in octave `o = floor(log2 v)` and, within it, the quarter `q = floor(4 (v - 2^o) / 2^o)`; its bucket is
//! `4 o + q`, 0 for `v <= 1`, and `BUCKETS - 1` from 2^32 µs on. A quarter of an octave is at most 25% of its lower bound, so a
//! percentile read as its bucket's midpoint is within about 12.5%.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

pub const ENV: &str = "RECORDSTUFF_DIAGNOSTICS";
/// The report's version: `src/shared/pipeline-histogram.ts` refuses another.
pub const SCHEMA: u32 = 1;
/// 32 octaves of microseconds, about 71 minutes; a longer value is counted in the last bucket.
pub const BUCKETS: usize = 128;
/// Frames remembered between their submission and their encoded sample: more are counted, not kept.
const IN_FLIGHT_LIMIT: usize = 64;

/// The bucket of `us` microseconds.
pub fn bucket(us: u64) -> usize {
    if us <= 1 {
        return 0;
    }
    if us >> 32 != 0 {
        return BUCKETS - 1;
    }
    let octave = 63 - us.leading_zeros() as u64;
    let quarter = ((us - (1 << octave)) * 4) >> octave;
    (octave * 4 + quarter) as usize
}

/// Durations in a fixed set of buckets, with their count, sum and maximum.
pub struct Histogram {
    buckets: [AtomicU64; BUCKETS],
    count: AtomicU64,
    sum_us: AtomicU64,
    max_us: AtomicU64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self { buckets: std::array::from_fn(|_| AtomicU64::new(0)), count: AtomicU64::new(0), sum_us: AtomicU64::new(0), max_us: AtomicU64::new(0) }
    }
}

impl Histogram {
    pub fn record_ns(&self, ns: u64) {
        let us = ns / 1000;
        self.buckets[bucket(us)].fetch_add(1, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
        self.sum_us.fetch_add(us, Ordering::Relaxed);
        self.max_us.fetch_max(us, Ordering::Relaxed);
    }

    pub fn count(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }

    /// `{"n":…,"sum":…,"max":…,"b":{"<bucket>":<count>,…}}`, microseconds; empty buckets left out.
    fn json(&self, out: &mut String) {
        let _ = write!(
            out,
            r#"{{"n":{},"sum":{},"max":{},"b":{{"#,
            self.count.load(Ordering::Relaxed),
            self.sum_us.load(Ordering::Relaxed),
            self.max_us.load(Ordering::Relaxed)
        );
        let mut first = true;
        for (index, bucket) in self.buckets.iter().enumerate() {
            let count = bucket.load(Ordering::Relaxed);
            if count == 0 {
                continue;
            }
            let _ = write!(out, r#"{}"{index}":{count}"#, if first { "" } else { "," });
            first = false;
        }
        out.push_str("}}");
    }
}

/// One session's stage figures.
#[derive(Default)]
pub struct Diagnostics {
    /// How long the core took over a captured picture: the video lock, the pacer and, when it was kept, its submission.
    pub capture_callback: Histogram,
    /// How long handing a frame to the encoder took; on macOS with a camera composing it is included.
    pub encode_submit: Histogram,
    /// From a frame's submission to its encoded sample reaching the core.
    pub encode_latency: Histogram,
    /// Composing the camera into a recording's frame, on the GPU and waited for (macOS).
    pub compose: Histogram,
    /// Composing the preview's picture (macOS).
    pub preview_compose: Histogram,
    /// From the preview's frame submitted to its chunk leaving the encoder.
    pub preview_encode: Histogram,
    /// From media handed to the writer to the writer taking it.
    pub write_wait: Histogram,
    /// The writer muxing and writing one piece of media.
    pub write: Histogram,
    pub frames_submitted: AtomicU64,
    pub frames_encoded: AtomicU64,
    /// Frames the encoder answered without a sample (VideoToolbox's dropped frame).
    pub encoder_dropped: AtomicU64,
    /// Encoded samples whose submission was no longer remembered: the bound passed, or an encoder's own frame.
    pub unmatched_samples: AtomicU64,
    pub in_flight_high: AtomicU64,
    pub preview_chunks: AtomicU64,
    /// Media waiting for the writer: now and at most, by count and by bytes.
    pub writer_pending: AtomicU64,
    pub writer_pending_high: AtomicU64,
    pub writer_backlog_high_bytes: AtomicU64,
    in_flight: Mutex<VecDeque<(u64, u64)>>,
}

impl Diagnostics {
    /// The session's figures when the development switch asks for them.
    pub fn from_env() -> Option<Self> {
        std::env::var_os(ENV).is_some_and(|value| value == "1").then(Self::default)
    }

    /// A frame captured at `pts_ns` handed to the encoder at `now_ns`, on the host clock.
    pub fn submitted(&self, pts_ns: u64, now_ns: u64) {
        self.frames_submitted.fetch_add(1, Ordering::Relaxed);
        let mut in_flight = self.in_flight.lock().unwrap();
        if in_flight.len() == IN_FLIGHT_LIMIT {
            in_flight.pop_front();
        }
        in_flight.push_back((pts_ns, now_ns));
        self.in_flight_high.fetch_max(in_flight.len() as u64, Ordering::Relaxed);
    }

    /// The encoded sample of the frame at `pts_ns` arrived at `now_ns`. The encoders do not reorder frames, so the
    /// ones remembered before it were dropped by the encoder or are an earlier submission of the same time.
    pub fn encoded(&self, pts_ns: u64, now_ns: u64) {
        self.frames_encoded.fetch_add(1, Ordering::Relaxed);
        let mut in_flight = self.in_flight.lock().unwrap();
        while in_flight.front().is_some_and(|&(pts, _)| pts < pts_ns) {
            in_flight.pop_front();
        }
        match in_flight.front() {
            Some(&(pts, at)) if pts == pts_ns => {
                in_flight.pop_front();
                drop(in_flight);
                self.encode_latency.record_ns(now_ns.saturating_sub(at));
            }
            _ => {
                self.unmatched_samples.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Media of `bytes` handed to the writer, with `backlog` bytes then waiting.
    pub fn queued(&self, backlog: u64) {
        let pending = self.writer_pending.fetch_add(1, Ordering::Relaxed) + 1;
        self.writer_pending_high.fetch_max(pending, Ordering::Relaxed);
        self.writer_backlog_high_bytes.fetch_max(backlog, Ordering::Relaxed);
    }

    /// The writer took a piece of media that waited `wait_ns`.
    pub fn taken(&self, wait_ns: u64) {
        self.writer_pending.fetch_sub(1, Ordering::Relaxed);
        self.write_wait.record_ns(wait_ns);
    }

    /// The report: `{"schema":1,"stages":{…},"counts":{…}}`, `extra` (already JSON members) added to the counts.
    pub fn json(&self, extra: &[(&str, u64)]) -> String {
        let mut out = format!(r#"{{"schema":{SCHEMA},"stages":{{"#);
        let stages: [(&str, &Histogram); 8] = [
            ("capture_callback", &self.capture_callback),
            ("encode_submit", &self.encode_submit),
            ("encode_latency", &self.encode_latency),
            ("compose", &self.compose),
            ("preview_compose", &self.preview_compose),
            ("preview_encode", &self.preview_encode),
            ("write_wait", &self.write_wait),
            ("write", &self.write),
        ];
        for (index, (name, histogram)) in stages.iter().enumerate() {
            let _ = write!(out, r#"{}"{name}":"#, if index == 0 { "" } else { "," });
            histogram.json(&mut out);
        }
        out.push_str(r#"},"counts":{"#);
        let load = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        let counts = [
            ("frames_submitted", load(&self.frames_submitted)),
            ("frames_encoded", load(&self.frames_encoded)),
            ("encoder_dropped", load(&self.encoder_dropped)),
            ("unmatched_samples", load(&self.unmatched_samples)),
            ("in_flight_high", load(&self.in_flight_high)),
            ("preview_chunks", load(&self.preview_chunks)),
            ("writer_pending_high", load(&self.writer_pending_high)),
            ("writer_backlog_high_bytes", load(&self.writer_backlog_high_bytes)),
        ];
        for (index, (name, value)) in counts.iter().chain(extra.iter()).enumerate() {
            let _ = write!(out, r#"{}"{name}":{value}"#, if index == 0 { "" } else { "," });
        }
        out.push_str("}}");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_split_each_octave_in_quarters() {
        assert_eq!(bucket(0), 0);
        assert_eq!(bucket(1), 0);
        // 2..3: octave 1, quarters of width a half.
        assert_eq!(bucket(2), 4);
        assert_eq!(bucket(3), 6);
        // 1000 µs: octave 9 (512), (1000 - 512) * 4 / 512 = 3.8.
        assert_eq!(bucket(1000), 39);
        assert_eq!(bucket(1024), 40);
        assert_eq!(bucket(1279), 40);
        assert_eq!(bucket(1280), 41);
        assert_eq!(bucket((1 << 32) - 1), BUCKETS - 1);
        assert_eq!(bucket(1 << 32), BUCKETS - 1);
        assert_eq!(bucket(u64::MAX), BUCKETS - 1);
    }

    #[test]
    fn a_histogram_reports_its_count_sum_maximum_and_only_filled_buckets() {
        let histogram = Histogram::default();
        histogram.record_ns(1_000_000);
        histogram.record_ns(1_000_000);
        histogram.record_ns(3_000);
        let mut out = String::new();
        histogram.json(&mut out);
        assert_eq!(out, r#"{"n":3,"sum":2003,"max":1000,"b":{"6":1,"39":2}}"#);
    }

    #[test]
    fn encode_latency_pairs_each_sample_with_its_submission_and_counts_what_it_cannot() {
        let diagnostics = Diagnostics::default();
        diagnostics.submitted(100, 1_000);
        diagnostics.submitted(200, 2_000);
        diagnostics.submitted(300, 3_000);
        assert_eq!(diagnostics.in_flight_high.load(Ordering::Relaxed), 3);
        // 100's sample never came (dropped): 200's pairs with its own submission.
        diagnostics.encoded(200, 2_000 + 5_000_000);
        diagnostics.encoded(300, 3_000 + 7_000_000);
        // An encoder's own sample, never submitted.
        diagnostics.encoded(400, 9_000_000);
        assert_eq!(diagnostics.encode_latency.count(), 2);
        assert_eq!(diagnostics.encode_latency.max_us.load(Ordering::Relaxed), 7_000);
        assert_eq!(diagnostics.unmatched_samples.load(Ordering::Relaxed), 1);
        assert_eq!(diagnostics.frames_encoded.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn frames_in_flight_are_bounded() {
        let diagnostics = Diagnostics::default();
        for n in 0..(IN_FLIGHT_LIMIT as u64 + 10) {
            diagnostics.submitted(n, n);
        }
        assert_eq!(diagnostics.in_flight.lock().unwrap().len(), IN_FLIGHT_LIMIT);
        assert_eq!(diagnostics.in_flight_high.load(Ordering::Relaxed), IN_FLIGHT_LIMIT as u64);
    }

    #[test]
    fn the_writer_s_queue_keeps_its_high_water_mark() {
        let diagnostics = Diagnostics::default();
        diagnostics.queued(10);
        diagnostics.queued(30);
        diagnostics.taken(5_000);
        diagnostics.queued(20);
        assert_eq!(diagnostics.writer_pending_high.load(Ordering::Relaxed), 2);
        assert_eq!(diagnostics.writer_backlog_high_bytes.load(Ordering::Relaxed), 30);
        assert_eq!(diagnostics.write_wait.count(), 1);
    }

    #[test]
    fn the_report_names_its_schema_every_stage_and_the_extra_counts() {
        let json = Diagnostics::default().json(&[("preview_gate_dropped", 4)]);
        assert!(json.starts_with(r#"{"schema":1,"stages":{"capture_callback":{"n":0,"#), "{json}");
        assert!(json.contains(r#""write":{"n":0,"sum":0,"max":0,"b":{}}"#), "{json}");
        assert!(json.ends_with(r#""writer_backlog_high_bytes":0,"preview_gate_dropped":4}}"#), "{json}");
    }
}
