//! The export's remux (plan 085): reads the source's samples where they lie, copies the kept ones with their times
//! closed up across each removed range, re-encodes the pictures and the sound windows the plan names, and writes both
//! through the engine's own muxer into the file main reserved. Media is read in bounded spans and written one fragment
//! at a time, so memory does not grow with the file's length; only the output's sample index does, as the recording's
//! writer keeps it to write `moov` at the end.
//!
//! The source is opened read-only and nothing here writes, renames or removes it. The output must not exist yet; it
//! is created here, synced by the muxer's finish and published by main, which removes it on any failure.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::plan::{self, AudioPlan, JoinRule, PACKET, Plan};
use super::source::{self, ReadAt, Samples, SourceIndex};
use crate::core::AudioEncode;
use crate::mux::mp4::{Codec, HybridMp4, Output, Sample, TrackConfig};
use crate::writer::classify;

/// Pictures in a fragment of the output, at most: about a second (fragments only matter while the file is written).
const FRAGMENT_TICKS_SECONDS: u64 = 1;
/// The largest read of consecutive samples.
const SPAN_BYTES: u64 = 8 * 1024 * 1024;
/// Frames past a sound window the encoder is given, so its last packet is whole.
const POSTROLL: u64 = 2 * PACKET;
/// The re-encoded pictures' bit rate against the source's average (D2: at least the source's).
const REENCODE_BITRATE_FACTOR: u64 = 2;
const REENCODE_BITRATE_MIN: u64 = 2_000_000;
/// The most compressed bytes a re-encoded run reads, beyond `plan::MAX_RUN_SECONDS`: a few seconds at any recording's
/// bit rate is far below it.
const MAX_RUN_BYTES: u64 = 256 * 1024 * 1024;
/// How often progress is reported.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Whether players accept a second `avc1` description in one track, D2's rule, settled once by the playback checks of
/// 2026-10-24 (plan 085's record): AVFoundation, QuickTime's, decoded and sought every picture of such a file, but
/// Chromium, the app's own player, failed to decode at the first picture using the second description
/// (`PIPELINE_ERROR_DECODE`, VideoToolbox -12909), as it does not follow a change of description within a track. So a
/// join whose re-encoded pictures' parameter sets differ from the source's resumes at a key frame instead. At the
/// source's level they matched on every recording measured, so this fallback is rare.
pub const SECOND_DESCRIPTION_PLAYS: bool = false;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VideoFormat {
    pub avcc: Vec<u8>,
    pub width: u16,
    pub height: u16,
    pub timescale: u32,
    /// The source's average frame rate, which its level allows: an encoder told a run's own rate (a single short
    /// picture's can be 240 fps) can refuse the level.
    pub frame_rate: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioFormat {
    pub config: Vec<u8>,
    pub sample_rate: u32,
    pub channels: u16,
}

/// A re-encoded run: the encoder's `avcC` and one sample per picture, the first a key frame.
pub struct Reencoded {
    pub avcc: Vec<u8>,
    pub samples: Vec<(Vec<u8>, bool)>,
}

/// The platform's decoders and encoders an export uses.
pub trait Codecs {
    /// Decodes `group` (samples from a key frame) and re-encodes its pictures from `from` on as a closed group that
    /// starts with a key frame, at `bitrate` bits a second; `durations` are those pictures' durations in the format's
    /// timescale.
    fn reencode(&mut self, format: &VideoFormat, group: &[Vec<u8>], from: usize, durations: &[u32], bitrate: u32) -> Result<Reencoded, String>;
    /// Decodes consecutive packets into interleaved float frames, `PACKET` a packet. The first packets decode without
    /// their predecessors, so a caller starts two early.
    fn decode_audio(&mut self, format: &AudioFormat, packets: &[Vec<u8>]) -> Result<Vec<f32>, String>;
    fn audio_encoder(&mut self, format: &AudioFormat, bitrate: u32) -> Result<Box<dyn AudioEncode>, String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExportError {
    /// `unsupported`, `malformed`, `read_failed` (the source), `nothing_kept`, `too_many_ranges`, `invalid_range`,
    /// `cancelled`, `encode_failed`, `disk_full`, `output_write_failed` or `output_exists`.
    pub code: &'static str,
    pub detail: String,
}

impl ExportError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }

    fn write(error: &io::Error, what: &str) -> Self {
        Self { code: classify(error), detail: format!("{what}: {error}") }
    }

    fn read(error: &io::Error) -> Self {
        Self { code: "read_failed", detail: format!("reading the recording: {error}") }
    }
}

impl From<source::ReadError> for ExportError {
    fn from(error: source::ReadError) -> Self {
        Self { code: error.code, detail: error.detail }
    }
}

impl From<plan::PlanError> for ExportError {
    fn from(error: plan::PlanError) -> Self {
        Self { code: error.code, detail: error.detail }
    }
}

/// How joins inside a group of pictures are made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinPolicy {
    /// A smart cut when the re-encoded pictures can be described, else resuming at a key frame (D2).
    Auto,
    /// Every such join resumes at a key frame (a fixture's forced fallback).
    KeyFrame,
    /// As `Auto`, with a second description used whatever the players do: only for the fixture that checks them.
    SecondDescription,
}

/// How `prepare` learns the re-encoded pictures' `avcC`, which is the same for every run of a recording's exports (one
/// encoder setting: the source's size, level, frame rate and bit rate).
pub enum Probe<'a> {
    /// Re-encode the first join's run now and reuse it in the export, so learning it costs nothing.
    FirstRun,
    /// The edit view's plan: the `avcC` learned before for this recording, else learned now from one picture.
    Known(&'a mut Option<Vec<u8>>),
}

/// What an export did, for the edit view and the log.
#[derive(Clone, Debug, PartialEq)]
pub struct ExportReport {
    pub plan: Plan,
    /// The source's video timescale, length and picture count.
    pub timescale: u32,
    pub source_duration: u64,
    pub frames: usize,
    pub bytes: u64,
    /// The re-encoded pictures' parameter sets differed from the source's, so they use a second description.
    pub second_description: bool,
    pub reencoded_frames: u64,
    pub reencoded_packets: u64,
}

/// What an export is made of before anything is written: its plan, the re-encoded pictures' description when it is
/// not the source's, and the first re-encoded run, which told it.
pub struct Prepared {
    pub plan: Plan,
    pub alternate: Option<Vec<u8>>,
    first: Option<(usize, Reencoded)>,
}

/// Plans an export. The re-encoded pictures' `avcC` decides how each join inside a group of pictures is made (D2): a
/// smart cut when it is the source's, or when a second description is allowed; otherwise every such join resumes at a
/// key frame. `probe` says how it is learned.
pub fn prepare(
    index: &SourceIndex,
    source: &dyn ReadAt,
    removed: &[(u64, u64)],
    policy: JoinPolicy,
    codecs: &mut dyn Codecs,
    probe: Probe,
) -> Result<Prepared, ExportError> {
    let audio = index.audio.as_ref();
    if policy == JoinPolicy::KeyFrame {
        return Ok(Prepared { plan: plan::plan(&index.video, audio, removed, JoinRule::KeyFrame)?, alternate: None, first: None });
    }
    let allowed = SECOND_DESCRIPTION_PLAYS || policy == JoinPolicy::SecondDescription;
    let smart = plan::plan(&index.video, audio, removed, JoinRule::SmartCut)?;
    let Some(at) = smart.parts.iter().position(|p| p.reencode.is_some()) else {
        return Ok(Prepared { plan: smart, alternate: None, first: None });
    };
    let (avcc, first) = match probe {
        // The plan is the smart cut's whatever the description: nothing to learn.
        Probe::Known(_) if allowed => return Ok(Prepared { plan: smart, alternate: None, first: None }),
        Probe::Known(known) => {
            let avcc = match known.as_ref() {
                Some(avcc) => avcc.clone(),
                None => {
                    let picture = read_samples(source, &index.video.samples, 0, 1)?;
                    let durations = &index.video.samples.durations[..1];
                    let made =
                        codecs.reencode(&video_format(index), &picture, 0, durations, bitrate(index)).map_err(|e| ExportError::new("encode_failed", e))?;
                    known.insert(made.avcc).clone()
                }
            };
            (avcc, None)
        }
        Probe::FirstRun => {
            let run = reencode_part(source, index, &smart.parts[at], codecs)?;
            (run.avcc.clone(), Some((at, run)))
        }
    };
    if avcc == index.video.avcc {
        return Ok(Prepared { plan: smart, alternate: None, first });
    }
    if allowed {
        return Ok(Prepared { plan: smart, alternate: Some(avcc), first });
    }
    Ok(Prepared { plan: plan::plan(&index.video, audio, removed, JoinRule::KeyFrame)?, alternate: None, first: None })
}

/// An output picture's duration: the source's, or for a part's last picture the plan's (`Part::last_duration`).
fn duration_of(index: &SourceIndex, part: &plan::Part, frame: usize) -> u32 {
    if frame + 1 == part.end { part.last_duration } else { index.video.samples.durations[frame] }
}

/// Re-encodes `part`'s pictures from its resume point to its run's end, decoding from the run's key frame.
fn reencode_part(source: &dyn ReadAt, index: &SourceIndex, part: &plan::Part, codecs: &mut dyn Codecs) -> Result<Reencoded, ExportError> {
    let run = part.reencode.as_ref().expect("a part with a re-encoded run");
    let bytes: u64 = index.video.samples.sizes[run.key..run.until].iter().map(|&s| u64::from(s)).sum();
    if bytes > MAX_RUN_BYTES {
        return Err(ExportError::new("unsupported", format!("a group of pictures of {bytes} bytes, more than any recording has")));
    }
    let group = read_samples(source, &index.video.samples, run.key, run.until)?;
    let durations: Vec<u32> = (part.first..run.until).map(|frame| duration_of(index, part, frame)).collect();
    let encoded =
        codecs.reencode(&video_format(index), &group, part.first - run.key, &durations, bitrate(index)).map_err(|e| ExportError::new("encode_failed", e))?;
    if encoded.samples.len() != durations.len() || !encoded.samples.first().is_some_and(|s| s.1) {
        return Err(ExportError::new("encode_failed", format!("{} pictures re-encoded for {}", encoded.samples.len(), durations.len())));
    }
    Ok(encoded)
}

fn video_format(index: &SourceIndex) -> VideoFormat {
    let v = &index.video;
    let seconds = v.end() as f64 / f64::from(v.timescale);
    let frame_rate = if seconds > 0.0 { (v.times.len() as f64 / seconds).round().clamp(1.0, 240.0) as u32 } else { 30 };
    VideoFormat { avcc: v.avcc.clone(), width: v.width, height: v.height, timescale: v.timescale, frame_rate }
}

/// The highest video bit rate H.264's High profile allows at `level_idc` (ITU-T H.264 table A-1's MaxBR, × 1.25 for
/// High, A.3.3.2), in bits a second; none for a level it does not list.
fn level_max_bitrate(level: u8) -> Option<u64> {
    let kbps: u64 = match level {
        10 => 64,
        11 => 192,
        12 => 384,
        13 => 768,
        20 => 2_000,
        21 | 22 => 4_000,
        30 => 10_000,
        31 => 14_000,
        32 | 40 => 20_000,
        41 | 42 => 50_000,
        50 => 135_000,
        51 | 52 => 240_000,
        _ => return None,
    };
    Some(kbps * 1250)
}

/// The re-encoded pictures' bit rate: twice the source's average video rate, at least 2 Mbps, and within nine tenths of
/// what the source's level allows, which an encoder set to that level refuses to exceed (VideoToolbox: -12902). Never
/// below the source's own rate, which its level already allows (D2).
fn bitrate(index: &SourceIndex) -> u32 {
    let v = &index.video;
    let bytes: u64 = v.samples.sizes.iter().map(|&s| u64::from(s)).sum();
    let seconds = (v.end() as f64 / f64::from(v.timescale)).max(0.001);
    let average = (bytes as f64 * 8.0 / seconds) as u64;
    let wanted = (average * REENCODE_BITRATE_FACTOR).max(REENCODE_BITRATE_MIN);
    let cap = v.avcc.get(3).copied().and_then(level_max_bitrate).map_or(u64::MAX, |max| (max * 9 / 10).max(average));
    wanted.min(cap).min(u64::from(u32::MAX)) as u32
}

/// Reads samples `from..to` in spans of consecutive bytes.
fn read_samples(source: &dyn ReadAt, samples: &Samples, from: usize, to: usize) -> Result<Vec<Vec<u8>>, ExportError> {
    let mut out = Vec::with_capacity(to.saturating_sub(from));
    for_each_sample(source, samples, from, to, &mut |_, data| {
        out.push(data.to_vec());
        Ok(())
    })?;
    Ok(out)
}

/// What `for_each_sample` calls with each sample's index and bytes.
type EachSample<'a> = dyn FnMut(usize, &[u8]) -> Result<(), ExportError> + 'a;

/// Calls `each` with every sample `from..to`, reading runs of samples that lie one after another in one read.
fn for_each_sample(source: &dyn ReadAt, samples: &Samples, from: usize, to: usize, each: &mut EachSample) -> Result<(), ExportError> {
    let mut spans: Vec<(usize, u64, u64)> = Vec::new();
    samples.locate(from, to, |index, offset, size| match spans.last_mut() {
        Some((_, start, length)) if *start + *length == offset && *length + u64::from(size) <= SPAN_BYTES => *length += u64::from(size),
        _ => spans.push((index, offset, u64::from(size))),
    });
    let mut buffer = Vec::new();
    for (first, offset, length) in spans {
        buffer.resize(length as usize, 0);
        source.read_at(&mut buffer, offset).map_err(|e| ExportError::read(&e))?;
        let mut at = 0usize;
        let mut index = first;
        while at < buffer.len() {
            let size = samples.sizes[index] as usize;
            each(index, &buffer[at..at + size])?;
            at += size;
            index += 1;
        }
    }
    Ok(())
}

struct Progress<'a> {
    total: u64,
    done: u64,
    last: Instant,
    report: &'a mut dyn FnMut(f64),
    cancel: &'a AtomicBool,
}

impl Progress<'_> {
    fn advance(&mut self, bytes: u64) -> Result<(), ExportError> {
        self.done += bytes;
        if self.cancel.load(Ordering::Acquire) {
            return Err(ExportError::new("cancelled", "the export was cancelled"));
        }
        if self.last.elapsed() >= PROGRESS_INTERVAL {
            self.last = Instant::now();
            (self.report)((self.done as f64 / self.total.max(1) as f64).min(1.0));
        }
        Ok(())
    }
}

/// Writes the output: pictures part by part, interleaved with the sound up to the same time, a fragment at a time.
struct Writer<'a, O: Output> {
    mp4: HybridMp4<O>,
    video: Vec<(Vec<u8>, u32, bool, u32)>,
    video_ticks: u64,
    /// Output time written so far, in the video's timescale.
    written: u64,
    timescale: u32,
    sound: Option<Sound<'a>>,
}

/// The output's sound: the next packet to write, and the current window's re-encoded packets.
struct Sound<'a> {
    plan: &'a Plan,
    audio: &'a AudioPlan,
    track: &'a source::AudioTrack,
    format: AudioFormat,
    bitrate: u32,
    next: u64,
    window: Option<(std::ops::Range<u64>, Vec<Vec<u8>>)>,
    reencoded: u64,
}

impl<O: Output> Writer<'_, O> {
    fn push_video(&mut self, data: Vec<u8>, duration: u32, sync: bool, description: u32, ctx: &mut Context) -> Result<(), ExportError> {
        if self.video.last().is_some_and(|last| last.3 != description) {
            self.flush_video(ctx)?;
        }
        self.video_ticks += u64::from(duration);
        self.video.push((data, duration, sync, description));
        if self.video_ticks >= u64::from(self.timescale) * FRAGMENT_TICKS_SECONDS {
            self.flush_video(ctx)?;
        }
        Ok(())
    }

    fn flush_video(&mut self, ctx: &mut Context) -> Result<(), ExportError> {
        if self.video.is_empty() {
            return Ok(());
        }
        let description = self.video[0].3;
        let samples: Vec<Sample> = self.video.iter().map(|(data, duration, sync, _)| Sample { data, duration: *duration, sync: *sync }).collect();
        self.mp4.write_fragment_described(0, &samples, description).map_err(|e| ExportError::write(&e, "writing the export"))?;
        let bytes: u64 = self.video.iter().map(|v| v.0.len() as u64).sum();
        self.written += self.video_ticks;
        self.video.clear();
        self.video_ticks = 0;
        ctx.progress.advance(bytes)?;
        self.flush_sound(Some(self.written), ctx)
    }

    /// Writes the sound up to output time `until` (the video's timescale), or all of it.
    fn flush_sound(&mut self, until: Option<u64>, ctx: &mut Context) -> Result<(), ExportError> {
        let timescale = self.timescale;
        let Some(sound) = self.sound.as_mut() else { return Ok(()) };
        let sample_rate = u64::from(sound.track.sample_rate);
        let last = match until {
            Some(ticks) => ((u128::from(ticks) * u128::from(sample_rate) / u128::from(timescale)) as u64 + u64::from(sound.audio.skip)) / PACKET,
            None => sound.audio.packets,
        }
        .min(sound.audio.packets);
        let mut packets: Vec<Vec<u8>> = Vec::new();
        while sound.next < last {
            let n = sound.next;
            if let Some(window) = sound.audio.windows.iter().find(|w| w.contains(&n)) {
                if sound.window.as_ref().is_none_or(|(range, _)| range != window) {
                    let encoded = encode_window(sound, window.clone(), ctx)?;
                    sound.reencoded += encoded.len() as u64;
                    sound.window = Some((window.clone(), encoded));
                }
                let (range, encoded) = sound.window.as_ref().unwrap();
                packets.push(encoded[(n - range.start) as usize].clone());
                sound.next += 1;
                continue;
            }
            // A run of copied packets up to the next window or `last`.
            let source = sound.plan.copied_packet(n).ok_or_else(|| ExportError::new("malformed", "a sound packet outside the source"))?;
            let stop = sound.audio.windows.iter().map(|w| w.start).find(|&s| s > n).unwrap_or(u64::MAX).min(last);
            let count = stop - n;
            if source + count > sound.track.samples.len() as u64 {
                return Err(ExportError::new("malformed", "the sound ends before the plan's last packet"));
            }
            for_each_sample(ctx.source, &sound.track.samples, source as usize, (source + count) as usize, &mut |_, data| {
                packets.push(data.to_vec());
                Ok(())
            })?;
            sound.next = stop;
        }
        if packets.is_empty() {
            return Ok(());
        }
        let bytes: u64 = packets.iter().map(|p| p.len() as u64).sum();
        let samples: Vec<Sample> = packets.iter().map(|data| Sample { data, duration: PACKET as u32, sync: true }).collect();
        self.mp4.write_fragment(1, &samples).map_err(|e| ExportError::write(&e, "writing the export"))?;
        ctx.progress.advance(bytes)
    }
}

struct Context<'a> {
    source: &'a dyn ReadAt,
    codecs: &'a mut dyn Codecs,
    progress: Progress<'a>,
}

/// Re-encodes the sound window `window` (output packets): the frames the plan maps there, faded at the joins, given
/// to a fresh encoder from early enough that its first kept packet is past its priming, which is dropped with the
/// packets before the window.
fn encode_window(sound: &Sound, window: std::ops::Range<u64>, ctx: &mut Context) -> Result<Vec<Vec<u8>>, ExportError> {
    let audio = sound.audio;
    let channels = usize::from(sound.format.channels);
    let fail = |e: String| ExportError::new("encode_failed", e);
    let mut encoder = ctx.codecs.audio_encoder(&sound.format, sound.bitrate).map_err(fail)?;
    let priming = u64::from(encoder.priming());
    let lead = (priming + 2 * PACKET).div_ceil(PACKET);
    let skip = i64::from(audio.skip);
    // Input frame 0 is output media frame `start`: the encoder's packet `lead` then covers the window's first packet.
    let start = (window.start * PACKET) as i64 - (lead * PACKET) as i64 + priming as i64;
    let end = (window.end * PACKET + POSTROLL) as i64;
    let frames = (end - start) as usize;
    // Which source frames each output frame takes, by part, so each part's span decodes once.
    let mut mapping: Vec<(usize, Option<u64>, f32)> = Vec::with_capacity(frames);
    let mut spans: Vec<(usize, u64, u64)> = Vec::new();
    for f in start..end {
        let q = f - skip;
        let part = plan::part_at(audio, q);
        let (source, gain) = plan::source_frame(audio, part, q);
        if let Some(s) = source {
            match spans.iter_mut().find(|(p, ..)| *p == part) {
                Some((_, low, high)) => {
                    *low = (*low).min(s);
                    *high = (*high).max(s + 1);
                }
                None => spans.push((part, s, s + 1)),
            }
        }
        mapping.push((part, source, gain));
    }
    let track = sound.track;
    let mut decoded: Vec<(usize, u64, Vec<f32>)> = Vec::new();
    for (part, low, high) in spans {
        let first = (low / PACKET).saturating_sub(2);
        let last = high.div_ceil(PACKET).min(track.samples.len() as u64);
        if first >= last {
            decoded.push((part, first * PACKET, Vec::new()));
            continue;
        }
        let packets = read_samples(ctx.source, &track.samples, first as usize, last as usize)?;
        let pcm = ctx.codecs.decode_audio(&sound.format, &packets).map_err(fail)?;
        decoded.push((part, first * PACKET, pcm));
    }
    let mut input = vec![0f32; frames * channels];
    for (n, (part, source, gain)) in mapping.into_iter().enumerate() {
        let Some(s) = source else { continue };
        let (_, base, pcm) = decoded.iter().find(|(p, ..)| *p == part).unwrap();
        let Some(offset) = s.checked_sub(*base) else { continue };
        let at = offset as usize * channels;
        if at + channels <= pcm.len() {
            for c in 0..channels {
                input[n * channels + c] = pcm[at + c] * gain;
            }
        }
    }
    encoder.push(&input);
    let mut packets = Vec::new();
    encoder.finish(&mut |packet| packets.push(packet)).map_err(fail)?;
    let wanted = (window.end - window.start) as usize;
    let lead = lead as usize;
    if packets.len() < lead + wanted {
        return Err(fail(format!("the sound encoder returned {} packets for a window of {wanted}", packets.len())));
    }
    Ok(packets.drain(lead..lead + wanted).collect())
}

/// What `remux` wrote.
pub struct Remuxed<O> {
    pub bytes: u64,
    pub reencoded_frames: u64,
    pub reencoded_packets: u64,
    pub out: O,
}

/// Remuxes `source` (its `index`) by `plan` into `out`. `alternate` is the re-encoded pictures' `avcC` when it differs
/// from the source's.
#[allow(clippy::too_many_arguments)]
pub fn remux<O: Output>(
    source: &dyn ReadAt,
    index: &SourceIndex,
    prepared: Prepared,
    codecs: &mut dyn Codecs,
    out: O,
    report: &mut dyn FnMut(f64),
    cancel: &AtomicBool,
) -> Result<Remuxed<O>, ExportError> {
    let Prepared { plan, alternate, mut first } = prepared;
    let plan = &plan;
    let video = &index.video;
    let video_config =
        TrackConfig { codec: Codec::H264 { avcc: video.avcc.clone(), width: video.width, height: video.height }, timescale: video.timescale, skip: 0 };
    let audio_parts = index.audio.as_ref().zip(plan.audio.as_ref());
    let audio_config = audio_parts.map(|(track, layout)| TrackConfig {
        codec: Codec::Aac {
            config: track.config.clone(),
            sample_rate: track.sample_rate,
            channels: track.channels,
            average_bitrate: track.average_bitrate,
            max_bitrate: track.max_bitrate,
        },
        timescale: track.timescale,
        skip: layout.skip,
    });
    let second = alternate.is_some();
    let alternate = alternate.map(|avcc| (0, Codec::H264 { avcc, width: video.width, height: video.height }));
    let tracks = std::iter::once(video_config).chain(audio_config).collect();
    let mp4 = HybridMp4::create_with_alternate(out, tracks, alternate).map_err(|e| ExportError::write(&e, "creating the export"))?;
    let mut total: u64 = plan.parts.iter().map(|p| video.samples.sizes[p.first..p.end].iter().map(|&s| u64::from(s)).sum::<u64>()).sum();
    if let Some((track, layout)) = audio_parts {
        total += layout.packets * track.samples.sizes.iter().map(|&s| u64::from(s)).sum::<u64>() / track.samples.len().max(1) as u64;
    }
    let mut ctx = Context { source, codecs, progress: Progress { total, done: 0, last: Instant::now(), report, cancel } };
    let sound = audio_parts.map(|(track, layout)| Sound {
        plan,
        audio: layout,
        track,
        format: AudioFormat { config: track.config.clone(), sample_rate: track.sample_rate, channels: track.channels },
        bitrate: track.average_bitrate.max(64_000),
        next: 0,
        window: None,
        reencoded: 0,
    });
    let mut writer = Writer { mp4, video: Vec::new(), video_ticks: 0, written: 0, timescale: video.timescale, sound };
    let mut reencoded_frames = 0u64;
    for (at, part) in plan.parts.iter().enumerate() {
        let duration = |frame: usize| duration_of(index, part, frame);
        let mut copy_from = part.first;
        if let Some(run) = &part.reencode {
            let encoded = match first.take_if(|(part, _)| *part == at) {
                Some((_, encoded)) => encoded,
                None => reencode_part(source, index, part, ctx.codecs)?,
            };
            let description = if second { 2 } else { 1 };
            for ((data, sync), frame) in encoded.samples.into_iter().zip(part.first..run.until) {
                writer.push_video(data, duration(frame), sync, description, &mut ctx)?;
            }
            reencoded_frames += (run.until - part.first) as u64;
            copy_from = run.until;
        }
        // Each sample goes to the writer as it is read: memory holds a span and a fragment, never a whole part.
        for_each_sample(source, &video.samples, copy_from, part.end, &mut |frame, data| {
            writer.push_video(data.to_vec(), duration(frame), video.sync[frame], 1, &mut ctx)
        })?;
    }
    writer.flush_video(&mut ctx)?;
    writer.flush_sound(None, &mut ctx)?;
    let reencoded_packets = writer.sound.as_ref().map_or(0, |s| s.reencoded);
    let mut mp4 = writer.mp4;
    if let Some(layout) = plan.audio.as_ref() {
        mp4.set_presented(1, layout.presented);
    }
    if cancel.load(Ordering::Acquire) {
        return Err(ExportError::new("cancelled", "the export was cancelled"));
    }
    let (finished, out) = mp4.finish().map_err(|e| ExportError::write(&e, "finishing the export"))?;
    if let Some(reason) = finished.fragmented {
        return Err(ExportError::new("output_write_failed", format!("the export's index was not written: {reason}")));
    }
    (ctx.progress.report)(1.0);
    Ok(Remuxed { bytes: finished.bytes, reencoded_frames, reencoded_packets, out })
}

/// Exports `source_path` without `removed` (the video's timescale) into `output_path`, which must not exist. The
/// source is opened read-only.
pub fn export(
    source_path: &Path,
    output_path: &Path,
    removed: &[(u64, u64)],
    policy: JoinPolicy,
    codecs: &mut dyn Codecs,
    report: &mut dyn FnMut(f64),
    cancel: &AtomicBool,
) -> Result<ExportReport, ExportError> {
    let source = File::open(source_path).map_err(|e| ExportError::read(&e))?;
    let index = source::read(&source)?;
    let prepared = prepare(&index, &source, removed, policy, codecs, Probe::FirstRun)?;
    let second_description = prepared.alternate.is_some();
    let out = OpenOptions::new().write(true).create_new(true).open(output_path).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            ExportError::new("output_exists", format!("{} exists", output_path.display()))
        } else {
            ExportError::write(&e, "creating the export")
        }
    })?;
    let plan = prepared.plan.clone();
    let done = remux(&source, &index, prepared, codecs, out, report, cancel)?;
    let (timescale, source_duration, frames) = (index.video.timescale, index.video.end(), index.video.times.len());
    Ok(ExportReport {
        plan,
        timescale,
        source_duration,
        frames,
        bytes: done.bytes,
        second_description,
        reencoded_frames: done.reencoded_frames,
        reencoded_packets: done.reencoded_packets,
    })
}

/// The plan an edit would export with, for the edit view, without writing: `known` is the re-encoded pictures'
/// `avcC` learned before for this recording, filled in when it is learned now.
pub fn inspect(
    source_path: &Path,
    removed: &[(u64, u64)],
    policy: JoinPolicy,
    codecs: &mut dyn Codecs,
    known: &mut Option<Vec<u8>>,
) -> Result<(SourceIndex, Plan), ExportError> {
    let source = File::open(source_path).map_err(|e| ExportError::read(&e))?;
    let index = source::read(&source)?;
    let prepared = prepare(&index, &source, removed, policy, codecs, Probe::Known(known))?;
    Ok((index, prepared.plan))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::mux::mp4::tests::video_config;
    use crate::mux::parse::parse;

    /// Pictures re-encoded as `[0xee, n]` (n the picture's place in the group), and sound "decoded" to each packet's
    /// first byte, encoded back with a priming of 2112 frames as each packet's first frame's value.
    pub struct FakeCodecs {
        pub avcc: Option<Vec<u8>>,
    }

    pub struct FakeEncoder {
        pending: Vec<f32>,
        frames_in: u64,
    }

    impl AudioEncode for FakeEncoder {
        fn frames_in(&self) -> u64 {
            self.frames_in
        }
        fn priming(&self) -> u32 {
            2112
        }
        fn audio_specific_config(&self) -> Vec<u8> {
            vec![0x11, 0x90]
        }
        fn push(&mut self, interleaved: &[f32]) {
            self.pending.extend_from_slice(interleaved);
            self.frames_in += interleaved.len() as u64 / 2;
        }
        fn push_silence(&mut self, frames: usize) {
            self.push(&vec![0.0; frames * 2]);
        }
        fn drain(&mut self, _out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
            Ok(())
        }
        fn finish(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
            // The priming first, then one packet per 1024 frames: [0xaa, value of the packet's first frame].
            let mut stream = vec![0.0f32; 2112 * 2];
            stream.extend_from_slice(&self.pending);
            for packet in stream.chunks(2048) {
                out(vec![0xaa, (packet[0] * 100.0).round() as u8]);
            }
            Ok(())
        }
    }

    impl Codecs for FakeCodecs {
        fn reencode(&mut self, format: &VideoFormat, group: &[Vec<u8>], from: usize, durations: &[u32], _bitrate: u32) -> Result<Reencoded, String> {
            assert_eq!(group.len() - from, durations.len());
            let samples = (from..group.len()).map(|n| (vec![0xee, group[n][0]], n == from)).collect();
            Ok(Reencoded { avcc: self.avcc.clone().unwrap_or_else(|| format.avcc.clone()), samples })
        }
        fn decode_audio(&mut self, _format: &AudioFormat, packets: &[Vec<u8>]) -> Result<Vec<f32>, String> {
            Ok(packets.iter().flat_map(|p| std::iter::repeat_n(f32::from(p[0]) / 100.0, 2048)).collect())
        }
        fn audio_encoder(&mut self, _format: &AudioFormat, _bitrate: u32) -> Result<Box<dyn AudioEncode>, String> {
            Ok(Box::new(FakeEncoder { pending: Vec::new(), frames_in: 0 }))
        }
    }

    /// A recording of `seconds` at 30 fps with a key frame each second; picture n's bytes start with n % 256, sound
    /// packet k's with k % 100.
    pub fn recording(seconds: u64) -> Vec<u8> {
        use crate::mux::mp4::tests::audio_config;
        let audio = TrackConfig { skip: 2112, ..audio_config() };
        let mut mp4 = HybridMp4::create(Vec::new(), vec![video_config(), audio]).unwrap();
        let mut packet = 0u64;
        for second in 0..seconds {
            let frames: Vec<Vec<u8>> = (0..30).map(|n| vec![((second * 30 + n) % 256) as u8, 1, 2, 3]).collect();
            let samples: Vec<Sample> = frames.iter().enumerate().map(|(n, d)| Sample { data: d, duration: 3000, sync: n == 0 }).collect();
            mp4.write_fragment(0, &samples).unwrap();
            let target = ((second + 1) * 48_000 + 2112).div_ceil(1024);
            let sound: Vec<Vec<u8>> = (packet..target).map(|k| vec![(k % 100) as u8, 9]).collect();
            packet = target;
            let samples: Vec<Sample> = sound.iter().map(|d| Sample { data: d, duration: 1024, sync: true }).collect();
            mp4.write_fragment(1, &samples).unwrap();
        }
        mp4.set_presented(1, seconds * 48_000);
        mp4.finish().unwrap().1
    }

    fn run(file: &Vec<u8>, removed: &[(u64, u64)], codecs: &mut FakeCodecs, policy: JoinPolicy) -> (Plan, Vec<u8>, bool) {
        let index = source::read(file).unwrap();
        let prepared = prepare(&index, file, removed, policy, codecs, Probe::FirstRun).unwrap();
        let second = prepared.alternate.is_some();
        let plan = prepared.plan.clone();
        let cancel = AtomicBool::new(false);
        let done = remux(file, &index, prepared, codecs, Vec::new(), &mut |_| {}, &cancel).unwrap();
        assert_eq!(done.bytes as usize, done.out.len());
        (plan, done.out, second)
    }

    fn fakes() -> FakeCodecs {
        FakeCodecs { avcc: None }
    }

    #[test]
    fn kept_pictures_are_copied_with_times_closed_up_and_a_mid_group_resume_re_encoded() {
        let file = recording(4);
        // Remove 1.0 s .. 2.5 s: the resume at frame 75 is inside the group starting at 60.
        let (plan, out, second) = run(&file, &[(90_000, 225_000)], &mut fakes(), JoinPolicy::Auto);
        assert!(!second);
        let parsed = parse(&out).unwrap();
        let video = &parsed.tracks[0];
        assert_eq!(parsed.top, ["ftyp", "mdat", "moov"]);
        assert_eq!(video.samples.len(), 30 + 45);
        // Frames 0..30 copied, 75..90 re-encoded from the group at 60, 90..120 copied.
        assert_eq!(video.samples[29].data, [29, 1, 2, 3]);
        assert_eq!(video.samples[30].data, [0xee, 75]);
        assert!(video.samples[30].sync && !video.samples[31].sync);
        assert_eq!(video.samples[44].data, [0xee, 89]);
        assert_eq!(video.samples[45].data, [90, 1, 2, 3]);
        assert!(video.samples[45].sync);
        // Times close up: the first resumed frame is shown where the first part ends, as nudged.
        assert_eq!(video.samples[30].decode_time, plan.parts[1].out_start);
        assert_eq!(video.duration, plan.duration);
        assert!(video.samples.iter().all(|s| s.description == 1));
    }

    #[test]
    fn copied_sound_packets_are_the_source_s_and_each_window_is_re_encoded() {
        let file = recording(4);
        let (plan, out, _) = run(&file, &[(90_000, 225_000)], &mut fakes(), JoinPolicy::Auto);
        let parsed = parse(&out).unwrap();
        let sound = &parsed.tracks[1];
        let layout = plan.audio.as_ref().unwrap();
        assert_eq!(sound.samples.len() as u64, layout.packets);
        assert_eq!(sound.edit.unwrap().1, i64::from(layout.skip));
        let source = parse(&file).unwrap();
        for (n, packet) in sound.samples.iter().enumerate() {
            match plan.copied_packet(n as u64) {
                Some(k) => assert_eq!(packet.data, source.tracks[1].samples[k as usize].data, "packet {n}"),
                None => assert_eq!(packet.data[0], 0xaa, "packet {n}"),
            }
        }
        // The head: the first copied packet is two before the one holding the first kept frame.
        assert_eq!(plan.copied_packet(0), Some(0));
        assert_eq!(layout.windows.len(), 1);
    }

    #[test]
    fn a_window_carries_each_side_of_the_join_and_its_fades() {
        let file = recording(4);
        let (plan, out, _) = run(&file, &[(90_000, 225_000)], &mut fakes(), JoinPolicy::Auto);
        let layout = plan.audio.as_ref().unwrap();
        let parsed = parse(&out).unwrap();
        let window = layout.windows[0].clone();
        // The fake encoder writes each packet's first frame value: the first window packet is the part before the
        // join (a source packet's first byte / 100 for the source packet at that place), unfaded.
        let first = &parsed.tracks[1].samples[window.start as usize].data;
        let q = (window.start * PACKET) as i64 - i64::from(layout.skip);
        let (src, gain) = plan::source_frame(layout, plan::part_at(layout, q), q);
        let expected = ((src.unwrap() / PACKET % 100) as f32 / 100.0 * gain * 100.0).round() as u8;
        assert_eq!(first[1], expected);
    }

    fn other_parameter_sets() -> FakeCodecs {
        FakeCodecs { avcc: Some(vec![1, 0x64, 0, 0x29, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x29, 1, 0, 2, 0x68, 0xee]) }
    }

    #[test]
    fn differing_parameter_sets_resume_at_a_key_frame_as_chromium_takes_no_second_description() {
        let file = recording(4);
        let (plan, out, second) = run(&file, &[(90_000, 225_000)], &mut other_parameter_sets(), JoinPolicy::Auto);
        assert!(!second);
        // Resumes at the key frame at 3.0 s (frame 90), not before it.
        assert!(plan.parts[1].fell_back);
        assert_eq!((plan.parts[1].requested, plan.parts[1].first), (75, 90));
        let parsed = parse(&out).unwrap();
        assert_eq!(parsed.tracks[0].descriptions, ["avc1"]);
        assert!(parsed.tracks[0].samples.iter().all(|s| s.data[0] != 0xee));
    }

    #[test]
    fn the_edit_view_learns_the_parameter_sets_once_and_then_plans_without_encoding() {
        let file = recording(4);
        let index = source::read(&file).unwrap();
        let mut known = None;
        let first = prepare(&index, &file, &[(90_000, 225_000)], JoinPolicy::Auto, &mut other_parameter_sets(), Probe::Known(&mut known)).unwrap();
        assert!(first.plan.parts[1].fell_back);
        assert!(known.is_some());
        /// Fails if asked to encode: the plan must come from what is known.
        struct NoEncoding;
        impl Codecs for NoEncoding {
            fn reencode(&mut self, _: &VideoFormat, _: &[Vec<u8>], _: usize, _: &[u32], _: u32) -> Result<Reencoded, String> {
                panic!("encoded again")
            }
            fn decode_audio(&mut self, _: &AudioFormat, _: &[Vec<u8>]) -> Result<Vec<f32>, String> {
                panic!("decoded")
            }
            fn audio_encoder(&mut self, _: &AudioFormat, _: u32) -> Result<Box<dyn AudioEncode>, String> {
                panic!("encoded")
            }
        }
        let again = prepare(&index, &file, &[(90_000, 225_000), (250_000, 260_000)], JoinPolicy::Auto, &mut NoEncoding, Probe::Known(&mut known)).unwrap();
        assert!(again.plan.parts.iter().skip(1).all(|p| p.fell_back || p.reencode.is_none()));
        // The source's own parameter sets: a smart cut.
        let mut same = Some(index.video.avcc.clone());
        let smart = prepare(&index, &file, &[(90_000, 225_000)], JoinPolicy::Auto, &mut NoEncoding, Probe::Known(&mut same)).unwrap();
        assert!(smart.plan.parts[1].reencode.is_some());
    }

    #[test]
    fn a_second_description_carries_the_re_encoded_pictures_when_the_fixture_asks() {
        let file = recording(4);
        let (_, out, second) = run(&file, &[(90_000, 225_000)], &mut other_parameter_sets(), JoinPolicy::SecondDescription);
        assert!(second);
        let parsed = parse(&out).unwrap();
        let video = &parsed.tracks[0];
        assert_eq!(video.descriptions.len(), 2);
        let described: Vec<u32> = video.samples.iter().map(|s| s.description).collect();
        assert!(described[..30].iter().all(|&d| d == 1));
        assert!(described[30..45].iter().all(|&d| d == 2));
        assert!(described[45..].iter().all(|&d| d == 1));
    }

    #[test]
    fn the_key_frame_policy_resumes_at_a_key_frame_and_drops_a_part_without_one() {
        let file = recording(4);
        // Kept: 0..1 s, 2.5..2.8 s (no key frame: dropped), 3.3..4 s (resumes at 3.0? no: at or after 3.3 -> none in
        // 99..120 either, dropped), so only the head and a part resuming at the key frame at 2 s remain.
        let removed = [(90_000, 225_000), (252_000, 297_000)];
        let (plan, out, _) = run(&file, &removed, &mut fakes(), JoinPolicy::KeyFrame);
        assert_eq!(plan.dropped.len(), 2);
        assert_eq!(plan.parts.len(), 1);
        let parsed = parse(&out).unwrap();
        assert!(parsed.tracks[0].samples.iter().all(|s| s.data[0] != 0xee));
        let (plan, _, _) = run(&file, &[(90_000, 165_000)], &mut fakes(), JoinPolicy::KeyFrame);
        let resumed = &plan.parts[1];
        assert!(resumed.fell_back);
        assert_eq!((resumed.requested, resumed.first), (55, 60));
    }

    #[test]
    fn re_encoded_pictures_stay_within_their_level_and_never_below_the_source() {
        assert_eq!(level_max_bitrate(40), Some(25_000_000));
        assert_eq!(level_max_bitrate(42), Some(62_500_000));
        assert_eq!(level_max_bitrate(99), None);
        let file = recording(4);
        let mut index = source::read(&file).unwrap();
        // A tiny source: the 2 Mbps floor, within level 4.0's 22.5 Mbps.
        assert_eq!(bitrate(&index), 2_000_000);
        // 12 Mbps at level 4.0: twice is 24 Mbps, over nine tenths of its 25 Mbps.
        let seconds = index.video.end() as f64 / 90_000.0;
        let per_sample = (12_000_000.0 / 8.0 * seconds / index.video.samples.len() as f64) as u32;
        index.video.samples.sizes.iter_mut().for_each(|size| *size = per_sample);
        assert_eq!(bitrate(&index), 22_500_000);
    }

    #[test]
    fn a_cancelled_export_stops_with_its_reason() {
        let file = recording(3);
        let index = source::read(&file).unwrap();
        let prepared = prepare(&index, &file, &[(90_000, 120_000)], JoinPolicy::Auto, &mut fakes(), Probe::FirstRun).unwrap();
        let cancel = AtomicBool::new(true);
        let error = remux(&file, &index, prepared, &mut fakes(), Vec::new(), &mut |_| {}, &cancel).err().unwrap();
        assert_eq!(error.code, "cancelled");
    }

    #[test]
    fn a_full_disk_is_reported_as_one() {
        struct Full;
        impl Output for Full {
            fn write_at(&mut self, _data: &[u8], offset: u64) -> io::Result<()> {
                if offset > 0 { Err(io::Error::new(io::ErrorKind::StorageFull, "no space")) } else { Ok(()) }
            }
            fn sync(&mut self) -> io::Result<()> {
                Ok(())
            }
            fn truncate(&mut self, _len: u64) -> io::Result<()> {
                Ok(())
            }
        }
        let file = recording(3);
        let index = source::read(&file).unwrap();
        let prepared = prepare(&index, &file, &[(90_000, 120_000)], JoinPolicy::Auto, &mut fakes(), Probe::FirstRun).unwrap();
        let cancel = AtomicBool::new(false);
        let error = remux(&file, &index, prepared, &mut fakes(), Full, &mut |_| {}, &cancel).err().unwrap();
        assert_eq!(error.code, "disk_full");
    }

    #[test]
    fn the_output_must_not_exist_and_the_source_is_never_written() {
        let dir = std::env::temp_dir().join(format!("recordstuff-remux-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mp4");
        std::fs::write(&source, recording(3)).unwrap();
        let before = std::fs::read(&source).unwrap();
        let output = dir.join("out.mp4");
        std::fs::write(&output, b"someone else's").unwrap();
        let cancel = AtomicBool::new(false);
        let error = export(&source, &output, &[(0, 30_000)], JoinPolicy::Auto, &mut fakes(), &mut |_| {}, &cancel).err().unwrap();
        assert_eq!(error.code, "output_exists");
        assert_eq!(std::fs::read(&output).unwrap(), b"someone else's");
        std::fs::remove_file(&output).unwrap();
        let report = export(&source, &output, &[(0, 30_000)], JoinPolicy::Auto, &mut fakes(), &mut |_| {}, &cancel).unwrap();
        assert_eq!(report.bytes, std::fs::metadata(&output).unwrap().len());
        assert_eq!(std::fs::read(&source).unwrap(), before);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
