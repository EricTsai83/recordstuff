//! The rendered export of an editable recording (plan 087): the screen and the camera decoded, the camera's bubble
//! composed onto the screen where the edit placed it (or left out, throughout or over the stretches the edit hides it
//! in, 2026-10-26), every kept picture encoded again, and the sound
//! tracks decoded, mixed at the edit's volumes, cut by its removed ranges with faded joins and encoded as one track,
//! into a new file. 085's remux copies a recording's pictures and sound; nothing can be copied here, since the picture
//! itself changes, so every kept picture is re-encoded and no join waits for a key frame.
//!
//! Time: the output's pictures keep the source's own times, closed up over the removed ranges (a part's output start
//! is the sum of the kept parts before it); the camera picture composed with a screen picture is the last one captured
//! at or before it (both tracks count from the recording's start, mac/camera_track.rs). Sound frame n of a track at
//! presentation time t is decoded frame `skip + t × rate` of its packets.
//!
//! Bounds: a span of samples read at a time (remux's `for_each_sample`), the platform's pictures in flight (its own
//! bound), a second of sound per track decoded at a time and one fragment per track in the muxer. The output's index
//! grows with it, as a recording's does. Cancel is checked at every picture.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::plan::{self, JoinRule, PACKET, Plan};
use super::remux::{self, AudioFormat, ExportError, VideoFormat};
use super::source::{self, AudioTrack, ReadAt, SourceIndex, VideoTrack};
use crate::camera_layout::Layout;
use crate::core::AudioEncode;
use crate::mux::mp4::{Codec, TrackConfig};
use crate::mux::session::SessionMuxer;
use crate::timing::NANOS_PER_SECOND;
use crate::writer::{AAC_FRAMES, Media};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// The raised-cosine fade at each join, as 085's (plan.rs).
const FADE_SECONDS: f64 = 0.005;
/// Sound is decoded and mixed this many packets at a time (about a second at 48 kHz).
const CHUNK_PACKETS: u64 = 47;
/// Packets decoded before a chunk's first, so the decoder is primed (085's rule).
const PRE_ROLL_PACKETS: u64 = 2;
/// The output sound's bit rate when the source does not say.
const DEFAULT_AUDIO_BITRATE: u32 = 256_000;

/// What the edit asks of the rendered export besides its removed ranges.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderOptions {
    /// The camera's bubble (the edit's place and size, the recording's shape), or None to leave the camera out.
    pub camera: Option<Layout>,
    /// Where the bubble is left out though `camera` is given: `[from, to)` in the video's timescale on the recording's
    /// own clock. A picture whose time falls in one is the screen's alone, and no camera picture is decoded for it.
    pub camera_hidden: Vec<(u64, u64)>,
    /// Each sound track's volume as a linear factor, in the file's order; a missing one is 1.
    pub gains: Vec<f32>,
}

/// The platform's half: pictures decoded, composed and encoded, and sound decoded and encoded.
pub trait Renderer {
    /// A picture pipeline for `screen`, composing `camera`'s pictures at `layout` when given, encoding at `bitrate`.
    fn video(&mut self, screen: &VideoFormat, camera: Option<(&VideoFormat, Layout)>, bitrate: u32) -> Result<Box<dyn VideoRender>, String>;
    /// Decodes consecutive packets into interleaved float frames, `PACKET` a packet; the first packets decode without
    /// their predecessors, so a caller starts `PRE_ROLL_PACKETS` early.
    fn decode_audio(&mut self, format: &AudioFormat, packets: &[Vec<u8>]) -> Result<Vec<f32>, String>;
    fn audio_encoder(&mut self, format: &AudioFormat, bitrate: u32) -> Result<Box<dyn AudioEncode>, String>;
}

/// One export's pictures: called in the order they are needed.
pub trait VideoRender {
    /// Decodes a camera sample; the last one decoded is composed from then on.
    fn camera(&mut self, data: &[u8]) -> Result<(), String>;
    /// Decodes a screen sample; with `out_ns`, composes its picture with the camera's (unless `with_camera` is false:
    /// the screen's own picture) and encodes it at that time. Without, the picture is only a reference for the next ones.
    fn screen(&mut self, data: &[u8], out_ns: Option<u64>, with_camera: bool) -> Result<(), String>;
    /// What has been encoded so far, in order: `Media::VideoFormat` once, then `Media::Video`.
    fn take(&mut self) -> Result<Vec<Media>, String>;
    /// Every picture encoded, then what is left.
    fn finish(&mut self) -> Result<Vec<Media>, String>;
}

/// The kept parts of a rendered export: `plan::plan` over the screen as if every picture were a key frame, since
/// every kept picture is encoded again, so each part starts exactly where the edit asked.
pub fn render_plan(index: &SourceIndex, removed: &[(u64, u64)]) -> Result<Plan, ExportError> {
    let mut every_key = index.video.clone();
    every_key.sync = vec![true; every_key.sync.len()];
    let planned = plan::plan(&every_key, None, removed, JoinRule::SmartCut)?;
    if planned.parts.is_empty() {
        return Err(ExportError::new("nothing_kept", "the edit removes the whole recording"));
    }
    Ok(planned)
}

/// What a rendered export wrote.
pub struct RenderReport {
    pub plan: Plan,
    pub bytes: u64,
    /// Pictures encoded.
    pub frames: u64,
    /// The source's video timescale, length and picture count, and its description.
    pub source: (u32, u64, usize),
    pub description: Option<String>,
}

/// Renders `source_path` into `output_path`, which must not exist: the edit's `removed` ranges (the video's
/// timescale) left out, the camera and the volumes as `options` say. The source is opened read-only.
pub fn export(
    source_path: &Path,
    output_path: &Path,
    removed: &[(u64, u64)],
    options: &RenderOptions,
    renderer: &mut dyn Renderer,
    report: &mut dyn FnMut(f64),
    cancel: &AtomicBool,
) -> Result<RenderReport, ExportError> {
    let source = File::open(source_path).map_err(|e| ExportError::read(&e))?;
    let index = source::read(&source)?;
    if index.description.is_none() {
        return Err(ExportError::new("unsupported", "only an editable recording is rendered"));
    }
    let plan = render_plan(&index, removed)?;
    let out = OpenOptions::new().write(true).create_new(true).open(output_path).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            ExportError::new("output_exists", format!("{} exists", output_path.display()))
        } else {
            ExportError::write(&e, "creating the export")
        }
    })?;
    let (bytes, frames) = render(&source, &index, &plan, options, renderer, out, report, cancel)?;
    let facts = (index.video.timescale, index.video.end(), index.video.times.len());
    Ok(RenderReport { plan, bytes, frames, source: facts, description: index.description })
}

/// An editable recording's track the edit view plays beside the recording for its preview (plan 087): the recording
/// itself shows the screen with the first sound; these are the camera and the second sound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Extract {
    Camera,
    SecondSound,
}

/// Copies one of `source_path`'s tracks, as it is, into a file of its own at `output_path`, which must not exist: its
/// samples, times and (for sound) edit unchanged, so it plays on the recording's own clock. A few seconds of samples
/// at a time; nothing is decoded. Returns the bytes written.
pub fn extract(source_path: &Path, output_path: &Path, which: Extract, cancel: &AtomicBool) -> Result<u64, ExportError> {
    use crate::mux::mp4::{HybridMp4, Sample};
    let source = File::open(source_path).map_err(|e| ExportError::read(&e))?;
    let index = source::read(&source)?;
    let (config, samples, presented) = match which {
        Extract::Camera => {
            let camera = index.camera.as_ref().ok_or_else(|| ExportError::new("unsupported", "the recording has no camera track"))?;
            let codec = Codec::H264 { avcc: camera.avcc.clone(), width: camera.width, height: camera.height };
            (TrackConfig { codec, timescale: camera.timescale, skip: 0 }, (&camera.samples, Some(&camera.sync)), None)
        }
        Extract::SecondSound => {
            let sound = index.second_audio.as_ref().ok_or_else(|| ExportError::new("unsupported", "the recording has no second sound track"))?;
            let codec = Codec::Aac {
                config: sound.config.clone(),
                sample_rate: sound.sample_rate,
                channels: sound.channels,
                average_bitrate: sound.average_bitrate,
                max_bitrate: sound.max_bitrate,
            };
            (TrackConfig { codec, timescale: sound.timescale, skip: sound.skip }, (&sound.samples, None), sound.presented)
        }
    };
    let out = OpenOptions::new().write(true).create_new(true).open(output_path).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            ExportError::new("output_exists", format!("{} exists", output_path.display()))
        } else {
            ExportError::write(&e, "creating the preview track")
        }
    })?;
    let timescale = config.timescale;
    let mut mp4 = HybridMp4::create(out, vec![config]).map_err(|e| ExportError::write(&e, "writing the preview track"))?;
    let (samples, sync) = samples;
    let mut chunk: Vec<(Vec<u8>, u32, bool)> = Vec::new();
    let mut ticks = 0u64;
    let flush = |chunk: &mut Vec<(Vec<u8>, u32, bool)>, mp4: &mut HybridMp4<File>| -> Result<(), ExportError> {
        let written: Vec<Sample> = chunk.iter().map(|(data, duration, sync)| Sample { data, duration: *duration, sync: *sync }).collect();
        mp4.write_fragment(0, &written).map_err(|e| ExportError::write(&e, "writing the preview track"))?;
        chunk.clear();
        Ok(())
    };
    remux::for_each_sample(&source, samples, 0, samples.len(), &mut |n, data| {
        if cancel.load(Ordering::Acquire) {
            return Err(ExportError::new("cancelled", "the preview track was cancelled"));
        }
        chunk.push((data.to_vec(), samples.durations[n], sync.is_none_or(|sync| sync[n])));
        ticks += u64::from(samples.durations[n]);
        // A fragment every few seconds, each video fragment from a key frame on (the next one starts one).
        let next_is_key = sync.is_none_or(|sync| sync.get(n + 1).copied().unwrap_or(true));
        if ticks >= 4 * u64::from(timescale) && next_is_key {
            ticks = 0;
            flush(&mut chunk, &mut mp4)?;
        }
        Ok(())
    })?;
    flush(&mut chunk, &mut mp4)?;
    if let Some(presented) = presented {
        mp4.set_presented(0, presented);
    }
    let (finished, _) = mp4.finish().map_err(|e| ExportError::write(&e, "finishing the preview track"))?;
    if let Some(reason) = finished.fragmented {
        return Err(ExportError::new("output_write_failed", format!("the preview track could not be finished: {reason}")));
    }
    Ok(finished.bytes)
}

/// A time in `timescale` ticks as the nanoseconds handed to the encoder, rounded up, so `ticks_from_ns` gives it back.
fn ns_from_ticks(ticks: u64, timescale: u32) -> u64 {
    (u128::from(ticks) * u128::from(NANOS_PER_SECOND)).div_ceil(u128::from(timescale)) as u64
}

fn ticks_from_ns(ns: u64, timescale: u32) -> u64 {
    (u128::from(ns) * u128::from(timescale) / u128::from(NANOS_PER_SECOND)) as u64
}

/// Whether `time` falls in one of the stretches the camera is hidden over.
fn hidden_at(hidden: &[(u64, u64)], time: u64) -> bool {
    hidden.iter().any(|&(from, to)| time >= from && time < to)
}

/// The camera picture shown at `time`: the last one captured at or before it.
fn camera_at(camera: &VideoTrack, time: u64) -> Option<usize> {
    camera.times.partition_point(|&t| t <= time).checked_sub(1)
}

/// The key frame at or before `frame`.
fn key_before(track: &VideoTrack, frame: usize) -> usize {
    (0..=frame).rev().find(|&i| track.sync[i]).unwrap_or(0)
}

/// Reads one sample whole.
fn read_sample(source: &dyn ReadAt, track: &VideoTrack, index: usize) -> Result<Vec<u8>, ExportError> {
    Ok(remux::read_samples(source, &track.samples, index, index + 1)?.pop().unwrap_or_default())
}

/// Where the output stands, shared by the picture loop and the sound it interleaves.
struct Output<'a> {
    muxer: Option<SessionMuxer<File>>,
    /// The file until the encoder's description makes the header.
    file: Option<File>,
    audio: Option<TrackConfig>,
    /// Pictures encoded before the header could be written, and sound packets likewise.
    early_video: Vec<(Vec<u8>, u64, bool)>,
    early_audio: Vec<Vec<u8>>,
    timescale: u32,
    frames: u64,
    progress: Progress<'a>,
}

impl Output<'_> {
    fn take(&mut self, media: Vec<Media>) -> Result<(), ExportError> {
        for media in media {
            match media {
                Media::VideoFormat { avcc, width, height } => {
                    let Some(file) = self.file.take() else { continue };
                    let video = TrackConfig { codec: Codec::H264 { avcc, width, height }, timescale: self.timescale, skip: 0 };
                    let tracks = std::iter::once(video).chain(self.audio.clone()).collect();
                    let mut muxer = SessionMuxer::with_tracks(file, tracks).map_err(|e| ExportError::write(&e, "writing the export's header"))?;
                    for (data, pts, sync) in self.early_video.drain(..) {
                        muxer.push_video(data, pts, sync).map_err(|e| ExportError::write(&e, "writing the export"))?;
                    }
                    for data in self.early_audio.drain(..) {
                        muxer.push_audio(data, AAC_FRAMES).map_err(|e| ExportError::write(&e, "writing the export"))?;
                    }
                    self.muxer = Some(muxer);
                }
                Media::Video { data, pts_ns, sync } => {
                    let pts = ticks_from_ns(pts_ns, self.timescale);
                    self.frames += 1;
                    match self.muxer.as_mut() {
                        Some(muxer) => muxer.push_video(data, pts, sync).map_err(|e| ExportError::write(&e, "writing the export"))?,
                        None => self.early_video.push((data, pts, sync)),
                    }
                }
                Media::Audio { .. } | Media::Camera { .. } => {}
            }
        }
        Ok(())
    }

    fn sound(&mut self, packets: Vec<Vec<u8>>) -> Result<(), ExportError> {
        for data in packets {
            match self.muxer.as_mut() {
                Some(muxer) => muxer.push_audio(data, AAC_FRAMES).map_err(|e| ExportError::write(&e, "writing the export"))?,
                None => self.early_audio.push(data),
            }
        }
        Ok(())
    }
}

struct Progress<'a> {
    total: u64,
    done: u64,
    last: Instant,
    report: &'a mut dyn FnMut(f64),
    cancel: &'a AtomicBool,
}

impl Progress<'_> {
    fn advance(&mut self) -> Result<(), ExportError> {
        self.done += 1;
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

/// One kept part's sound: source frames `from..to` (presentation frames, before a track's `skip`), and where the part
/// starts in the output.
#[derive(Clone, Copy, Debug)]
struct SoundPart {
    from: u64,
    to: u64,
    out_start: u64,
}

/// The output's sound: each track decoded a chunk at a time, mixed at its volume, the joins faded, encoded as one.
struct Sound {
    tracks: Vec<(AudioTrack, f32)>,
    format: AudioFormat,
    encoder: Box<dyn AudioEncode>,
    parts: Vec<SoundPart>,
    /// Output frames mixed so far, and the total.
    mixed: u64,
    total: u64,
    fade: u64,
    bitrate: u32,
}

impl Sound {
    /// Mixes and encodes the output's sound up to `until` frames; returns the packets made.
    fn advance(&mut self, until: u64, source: &dyn ReadAt, renderer: &mut dyn Renderer) -> Result<Vec<Vec<u8>>, ExportError> {
        let until = until.min(self.total);
        let mut packets = Vec::new();
        while self.mixed < until {
            let at = self.mixed;
            let part = self.parts.iter().rposition(|p| p.out_start <= at).unwrap_or(0);
            let p = self.parts[part];
            let part_end = p.out_start + (p.to - p.from);
            let count = (until - at).min(CHUNK_PACKETS * PACKET).min(part_end - at);
            let from = p.from + (at - p.out_start);
            let mut mix = vec![0f32; count as usize * 2];
            for (track, gain) in &self.tracks {
                if *gain == 0.0 {
                    continue;
                }
                let frames = decode_frames(source, track, &self.format, from, from + count, renderer)?;
                for (out, value) in mix.iter_mut().zip(frames) {
                    *out += value * gain;
                }
            }
            for (n, frame) in mix.as_chunks_mut::<2>().0.iter_mut().enumerate() {
                let q = at + n as u64;
                // Faded in after a join and out before one; the export's own start and end are not joins.
                let into = q - p.out_start;
                let left = part_end - 1 - q;
                let mut gain = 1.0f32;
                if part > 0 && into < self.fade {
                    gain *= raised_cosine(into, self.fade);
                }
                if part + 1 < self.parts.len() && left < self.fade {
                    gain *= raised_cosine(left, self.fade);
                }
                for value in frame {
                    *value = crate::core::limit(*value * gain);
                }
            }
            self.encoder.push(&mix);
            self.encoder.drain(&mut |packet| packets.push(packet)).map_err(|e| ExportError::new("encode_failed", e))?;
            self.mixed += count;
        }
        Ok(packets)
    }
}

/// 0 at `0`, 1 at `length`: a raised cosine, as 085's joins (plan.rs).
fn raised_cosine(at: u64, length: u64) -> f32 {
    (0.5 - 0.5 * (std::f64::consts::PI * (at as f64 + 0.5) / length as f64).cos()) as f32
}

/// `track`'s stereo frames `from..to` (presentation frames), decoded from `PRE_ROLL_PACKETS` before; silence past its
/// end. A mono track is spread to both channels.
fn decode_frames(
    source: &dyn ReadAt,
    track: &AudioTrack,
    format: &AudioFormat,
    from: u64,
    to: u64,
    renderer: &mut dyn Renderer,
) -> Result<Vec<f32>, ExportError> {
    let wanted = (to - from) as usize;
    let (first, last) = (from + u64::from(track.skip), to + u64::from(track.skip));
    let packets = track.samples.len() as u64;
    let first_packet = (first / PACKET).saturating_sub(PRE_ROLL_PACKETS);
    let end_packet = last.div_ceil(PACKET).min(packets);
    let mut out = vec![0f32; wanted * 2];
    if first_packet >= end_packet {
        return Ok(out);
    }
    let read = remux::read_samples(source, &track.samples, first_packet as usize, end_packet as usize)?;
    let decoded = renderer.decode_audio(format, &read).map_err(|e| ExportError::new("encode_failed", e))?;
    let channels = usize::from(format.channels.max(1));
    let offset = (first - first_packet * PACKET) as usize;
    for n in 0..wanted {
        let at = (offset + n) * channels;
        if at + channels > decoded.len() {
            break;
        }
        let (left, right) = (decoded[at], decoded[at + channels - 1]);
        out[n * 2] = left;
        out[n * 2 + 1] = right;
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn render(
    source: &dyn ReadAt,
    index: &SourceIndex,
    plan: &Plan,
    options: &RenderOptions,
    renderer: &mut dyn Renderer,
    file: File,
    report: &mut dyn FnMut(f64),
    cancel: &AtomicBool,
) -> Result<(u64, u64), ExportError> {
    let screen = &index.video;
    let timescale = screen.timescale;
    let screen_format = remux::video_format(index);
    let camera = index.camera.as_ref().zip(options.camera);
    let camera_format = camera.map(|(track, _)| VideoFormat {
        avcc: track.avcc.clone(),
        width: track.width,
        height: track.height,
        timescale: track.timescale,
        frame_rate: screen_format.frame_rate,
    });
    let encode = |e: String| ExportError::new("encode_failed", e);
    let mut video = renderer.video(&screen_format, camera_format.as_ref().zip(camera.map(|(_, layout)| layout)), remux::bitrate(index)).map_err(encode)?;

    // The sound tracks, in the file's order, at the edit's volumes.
    let tracks: Vec<(AudioTrack, f32)> = index
        .audio
        .iter()
        .chain(index.second_audio.iter())
        .enumerate()
        .map(|(n, track)| (track.clone(), options.gains.get(n).copied().unwrap_or(1.0).max(0.0)))
        .collect();
    let mut sound = match tracks.first() {
        Some((first, _)) => {
            let format = AudioFormat { config: first.config.clone(), sample_rate: first.sample_rate, channels: first.channels };
            let bitrate = if first.average_bitrate > 0 { first.average_bitrate } else { DEFAULT_AUDIO_BITRATE };
            let encoder = renderer.audio_encoder(&AudioFormat { channels: 2, ..format.clone() }, bitrate).map_err(encode)?;
            let rate = u64::from(first.sample_rate);
            let frames_at = |ticks: u64| (u128::from(ticks) * u128::from(rate) / u128::from(timescale)) as u64;
            let mut out = 0;
            let parts: Vec<SoundPart> = plan
                .parts
                .iter()
                .map(|p| {
                    let (from, to) = (frames_at(p.start), frames_at(p.stop));
                    let part = SoundPart { from, to, out_start: out };
                    out += to - from;
                    part
                })
                .collect();
            let fade = ((FADE_SECONDS * rate as f64).round() as u64).max(1);
            Some(Sound { tracks, format, encoder, parts, mixed: 0, total: out, fade, bitrate })
        }
        None => None,
    };
    let audio_config = sound.as_ref().map(|s| TrackConfig {
        codec: Codec::Aac {
            config: s.encoder.audio_specific_config(),
            sample_rate: s.format.sample_rate,
            channels: 2,
            average_bitrate: s.bitrate,
            max_bitrate: s.bitrate,
        },
        timescale: s.format.sample_rate,
        skip: s.encoder.priming(),
    });
    let total: u64 = plan.parts.iter().map(|p| (p.end - p.first) as u64).sum();
    let mut output = Output {
        muxer: None,
        file: Some(file),
        audio: audio_config,
        early_video: Vec::new(),
        early_audio: Vec::new(),
        timescale,
        frames: 0,
        progress: Progress { total, done: 0, last: Instant::now(), report, cancel },
    };

    let mut camera_shown: Option<usize> = None;
    for part in &plan.parts {
        let key = key_before(screen, part.first);
        remux::for_each_sample(source, &screen.samples, key, part.end, &mut |frame, data| {
            if frame < part.first {
                return video.screen(data, None, false).map_err(encode);
            }
            let time = screen.times[frame];
            let with_camera = camera.is_some() && !hidden_at(&options.camera_hidden, time);
            if with_camera
                && let Some((track, _)) = camera
                && let Some(wanted) = camera_at(track, time)
                && camera_shown != Some(wanted)
            {
                // Decoded from its key frame when it jumps (a new part) or goes back, else from the one shown.
                let from = match camera_shown {
                    Some(shown) if shown < wanted && key_before(track, wanted) <= shown => shown + 1,
                    _ => key_before(track, wanted),
                };
                for n in from..=wanted {
                    video.camera(&read_sample(source, track, n)?).map_err(encode)?;
                }
                camera_shown = Some(wanted);
            }
            let out = part.out_start + (time - part.start);
            video.screen(data, Some(ns_from_ticks(out, timescale)), with_camera).map_err(encode)?;
            let encoded = video.take().map_err(encode)?;
            output.take(encoded)?;
            if let Some(sound) = sound.as_mut() {
                // Sound up to the pictures, so the file interleaves them.
                let until = (u128::from(out) * u128::from(sound.format.sample_rate) / u128::from(timescale)) as u64;
                let packets = sound.advance(until, source, renderer)?;
                output.sound(packets)?;
            }
            output.progress.advance()
        })?;
    }
    let encoded = video.finish().map_err(encode)?;
    output.take(encoded)?;
    let mut audio_frames = None;
    if let Some(sound) = sound.as_mut() {
        let packets = sound.advance(sound.total, source, renderer)?;
        output.sound(packets)?;
        let mut rest = Vec::new();
        sound.encoder.finish(&mut |packet| rest.push(packet)).map_err(encode)?;
        output.sound(rest)?;
        audio_frames = Some(sound.total);
    }
    if output.progress.cancel.load(Ordering::Acquire) {
        return Err(ExportError::new("cancelled", "the export was cancelled"));
    }
    let muxer = output.muxer.take().ok_or_else(|| ExportError::new("encode_failed", "the encoder made no picture"))?;
    let (finished, _) = muxer.finish_tracks(plan.duration, &[audio_frames]).map_err(|e| ExportError::write(&e, "finishing the export"))?;
    if let Some(reason) = finished.fragmented {
        return Err(ExportError::new("output_write_failed", format!("the export could not be finished: {reason}")));
    }
    (output.progress.report)(1.0);
    Ok((finished.bytes, output.frames))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::edit::source::tests::editable_recording;
    use crate::mux::parse::parse;

    /// What the fake pipeline was asked to do.
    #[derive(Default)]
    struct Calls {
        cameras: Vec<Vec<u8>>,
        /// Screen samples decoded only as references, and the camera picture each kept one was composed with.
        references: Vec<Vec<u8>>,
        composed: Vec<(Vec<u8>, Option<Vec<u8>>)>,
        mixed: Vec<f32>,
        camera_asked: Option<Layout>,
    }

    struct FakeRenderer(Arc<Mutex<Calls>>);

    struct FakeVideo {
        calls: Arc<Mutex<Calls>>,
        camera: Option<Vec<u8>>,
        pending: Vec<Media>,
        format_sent: bool,
    }

    impl VideoRender for FakeVideo {
        fn camera(&mut self, data: &[u8]) -> Result<(), String> {
            self.calls.lock().unwrap().cameras.push(data.to_vec());
            self.camera = Some(data.to_vec());
            Ok(())
        }
        fn screen(&mut self, data: &[u8], out_ns: Option<u64>, with_camera: bool) -> Result<(), String> {
            let Some(at) = out_ns else {
                self.calls.lock().unwrap().references.push(data.to_vec());
                return Ok(());
            };
            let camera = self.camera.clone().filter(|_| with_camera);
            self.calls.lock().unwrap().composed.push((data.to_vec(), camera.clone()));
            if !std::mem::replace(&mut self.format_sent, true) {
                let Codec::H264 { avcc, .. } = crate::mux::mp4::tests::video_config().codec else { unreachable!() };
                self.pending.push(Media::VideoFormat { avcc, width: 64, height: 36 });
            }
            let mut sample = data.to_vec();
            sample.extend(camera.unwrap_or_default());
            self.pending.push(Media::Video { data: sample, pts_ns: at, sync: self.pending.len() <= 1 });
            Ok(())
        }
        fn take(&mut self) -> Result<Vec<Media>, String> {
            Ok(std::mem::take(&mut self.pending))
        }
        fn finish(&mut self) -> Result<Vec<Media>, String> {
            self.take()
        }
    }

    /// Sound "decoded" to each packet's first byte / 100, and an encoder that keeps what it is given.
    struct KeepingEncoder(Arc<Mutex<Calls>>, u64);

    impl AudioEncode for KeepingEncoder {
        fn frames_in(&self) -> u64 {
            self.1
        }
        fn priming(&self) -> u32 {
            2112
        }
        fn audio_specific_config(&self) -> Vec<u8> {
            vec![0x11, 0x90]
        }
        fn push(&mut self, interleaved: &[f32]) {
            self.0.lock().unwrap().mixed.extend_from_slice(interleaved);
            self.1 += interleaved.len() as u64 / 2;
        }
        fn push_silence(&mut self, frames: usize) {
            self.push(&vec![0.0; frames * 2]);
        }
        fn drain(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
            out(vec![0xaa]);
            Ok(())
        }
        fn finish(&mut self, _out: &mut dyn FnMut(Vec<u8>)) -> Result<(), String> {
            Ok(())
        }
    }

    impl Renderer for FakeRenderer {
        fn video(&mut self, _screen: &VideoFormat, camera: Option<(&VideoFormat, Layout)>, _bitrate: u32) -> Result<Box<dyn VideoRender>, String> {
            self.0.lock().unwrap().camera_asked = camera.map(|(_, layout)| layout);
            Ok(Box::new(FakeVideo { calls: self.0.clone(), camera: None, pending: Vec::new(), format_sent: false }))
        }
        fn decode_audio(&mut self, _format: &AudioFormat, packets: &[Vec<u8>]) -> Result<Vec<f32>, String> {
            Ok(packets.iter().flat_map(|p| std::iter::repeat_n(f32::from(p[0]) / 100.0, 2048)).collect())
        }
        fn audio_encoder(&mut self, _format: &AudioFormat, _bitrate: u32) -> Result<Box<dyn AudioEncode>, String> {
            Ok(Box::new(KeepingEncoder(self.0.clone(), 0)))
        }
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("recordstuff-render-{name}-{}.mp4", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    /// Renders a 2-second editable recording (editable_recording: screen `[1, n]`, camera `[4, n]`, system sound 0.02,
    /// microphone 0.03) without `removed`, as `options` say.
    fn rendered(name: &str, removed: &[(u64, u64)], options: RenderOptions, cancel: bool) -> (Result<(u64, u64), ExportError>, Calls, std::path::PathBuf) {
        let file = editable_recording(2, true);
        let index = source::read(&file).unwrap();
        let plan = render_plan(&index, removed).unwrap();
        let calls = Arc::new(Mutex::new(Calls::default()));
        let path = temp(name);
        let out = File::create(&path).unwrap();
        let result = render(&file, &index, &plan, &options, &mut FakeRenderer(calls.clone()), out, &mut |_| {}, &AtomicBool::new(cancel));
        let calls = std::mem::take(&mut *calls.lock().unwrap());
        (result, calls, path)
    }

    #[test]
    fn each_kept_picture_is_composed_with_the_camera_picture_of_its_time_and_a_cut_decodes_from_key_frames() {
        let layout = Layout::default();
        // Frames 10 to 39 removed (3000 ticks a frame): the second part resumes at frame 40, inside its second's group.
        let (result, calls, path) =
            rendered("composed", &[(30_000, 120_000)], RenderOptions { camera_hidden: Vec::new(), camera: Some(layout), gains: vec![1.0, 1.0] }, false);
        let (_, frames) = result.unwrap();
        assert_eq!(calls.camera_asked, Some(layout));
        // 60 pictures less the 30 removed.
        assert_eq!(frames, 30);
        // Every kept screen picture n with camera picture n, the two tracks sharing their times.
        for (screen, camera) in &calls.composed {
            assert_eq!(camera.as_deref(), Some(&[4, screen[1]][..]), "screen {screen:?}");
        }
        // The second part decodes the screen from its key frame (30) as references, and the camera likewise.
        assert_eq!(calls.references, (30..40).map(|n| vec![1u8, n]).collect::<Vec<_>>());
        assert!(calls.cameras.contains(&vec![4, 30]) && !calls.cameras.contains(&vec![4, 20]));
        // The output's pictures close up over the cut: 30 at 3000 ticks apart.
        let parsed = parse(&std::fs::read(&path).unwrap()).unwrap();
        let times: Vec<u64> = parsed.tracks[0].samples.iter().map(|s| s.decode_time).collect();
        assert_eq!(times, (0..30).map(|n| n * 3000).collect::<Vec<_>>());
        assert_eq!(parsed.tracks[0].duration, 90_000);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_hidden_camera_is_neither_decoded_nor_composed() {
        let (result, calls, path) = rendered("hidden", &[], RenderOptions { camera_hidden: Vec::new(), camera: None, gains: vec![1.0, 1.0] }, false);
        result.unwrap();
        assert_eq!(calls.camera_asked, None);
        assert!(calls.cameras.is_empty() && calls.composed.iter().all(|(_, camera)| camera.is_none()));
        assert_eq!(calls.composed.len(), 60);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_camera_hidden_over_a_stretch_is_left_out_of_its_pictures_only_and_comes_back_after() {
        // Pictures 20–39 (0.67–1.33 s at 30 fps, 3000 ticks apart) hidden; a cut over 10–15 keeps the stretch on the
        // recording's own clock, not the export's.
        let layout = Layout { x: 0.0, y: 1.0, ..Layout::default() };
        let options = RenderOptions { camera: Some(layout), camera_hidden: vec![(60_000, 120_000)], gains: vec![1.0, 1.0] };
        let (result, calls, path) = rendered("hidden-stretch", &[(30_000, 45_000)], options, false);
        result.unwrap();
        assert_eq!(calls.camera_asked, Some(layout));
        assert!(!calls.composed.is_empty());
        for (screen, camera) in &calls.composed {
            let n = screen[1];
            if (20..40).contains(&n) {
                assert_eq!(camera, &None, "picture {n} is in the hidden stretch");
            } else {
                assert_eq!(camera.as_deref(), Some(&[4, n][..]), "picture {n} has its own camera picture");
            }
        }
        // No camera picture is decoded for the hidden stretch's own pictures alone: past it, decoding resumes from the
        // camera's key frame before picture 40 (or after the last one shown), never every picture in between.
        assert!(!calls.cameras.iter().any(|c| (20..30).contains(&c[1])), "{:?}", calls.cameras.iter().map(|c| c[1]).collect::<Vec<_>>());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn the_sound_is_each_track_at_its_volume_faded_across_a_join() {
        // The system's sound (0.02) at half, the microphone's (0.03) at twice: 0.07 wherever no fade applies.
        let (result, calls, path) =
            rendered("mixed", &[(30_000, 60_000)], RenderOptions { camera_hidden: Vec::new(), camera: None, gains: vec![0.5, 2.0] }, false);
        result.unwrap();
        let left: Vec<f32> = calls.mixed.iter().step_by(2).copied().collect();
        // 1.67 s kept at 48 kHz.
        assert_eq!(left.len(), 80_000);
        let join = 16_000;
        assert!((left[1000] - 0.07).abs() < 1e-6, "{}", left[1000]);
        assert!((left[join + 1000] - 0.07).abs() < 1e-6);
        // Silent at the join itself, rising and falling over 5 ms (240 frames) each side.
        assert!(left[join - 1] < 0.001 && left[join] < 0.001, "{} {}", left[join - 1], left[join]);
        assert!(left[join - 120] > 0.02 && left[join - 120] < 0.05);
        assert!((left[join - 241] - 0.07).abs() < 1e-6 && (left[join + 240] - 0.07).abs() < 1e-6);
        // Its start and end are not joins: whole from the first frame to the sound's last. The fixture's tracks hold
        // 94 packets, 94,144 frames once their priming is skipped: past them the export is silent, not shifted.
        let last_heard = 94_144 - 16_000 - 1;
        assert!((left[0] - 0.07).abs() < 1e-6 && (left[last_heard] - 0.07).abs() < 1e-6);
        assert!(left[last_heard + 1..].iter().all(|&v| v == 0.0));
        let parsed = parse(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(parsed.tracks.len(), 2);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_muted_track_is_left_out_and_the_other_plays_alone() {
        let (result, calls, path) = rendered("muted", &[], RenderOptions { camera_hidden: Vec::new(), camera: None, gains: vec![0.0, 1.0] }, false);
        result.unwrap();
        // The microphone's 0.03 alone while its track lasts (94,144 frames), silence after.
        let (heard, after) = calls.mixed.split_at(94_144 * 2);
        assert!(heard.iter().all(|&v| (v - 0.03).abs() < 1e-6));
        assert!(after.iter().all(|&v| v == 0.0));
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_cancel_stops_it_and_removing_everything_or_a_plain_recording_is_refused() {
        let (result, _, path) = rendered("cancel", &[], RenderOptions { camera_hidden: Vec::new(), camera: None, gains: vec![] }, true);
        assert_eq!(result.unwrap_err().code, "cancelled");
        std::fs::remove_file(&path).unwrap();

        let index = source::read(&editable_recording(2, true)).unwrap();
        assert_eq!(render_plan(&index, &[(0, 180_000)]).unwrap_err().code, "nothing_kept");

        let plain = temp("plain-source");
        std::fs::write(&plain, crate::edit::remux::tests::recording(2)).unwrap();
        let output = temp("plain-output");
        let options = RenderOptions { camera_hidden: Vec::new(), camera: None, gains: vec![] };
        let error = export(&plain, &output, &[], &options, &mut FakeRenderer(Arc::default()), &mut |_| {}, &AtomicBool::new(false)).err().unwrap();
        assert_eq!(error.code, "unsupported");
        assert!(!output.exists(), "nothing is created for a refused export");
        std::fs::remove_file(&plain).unwrap();
    }

    #[test]
    fn the_camera_and_the_second_sound_are_copied_into_files_of_their_own_on_the_recording_s_clock() {
        let source = temp("extract-source");
        std::fs::write(&source, editable_recording(2, true)).unwrap();
        let index = source::read(&std::fs::read(&source).unwrap()).unwrap();
        for (which, name) in [(Extract::Camera, "extract-camera"), (Extract::SecondSound, "extract-sound")] {
            let output = temp(name);
            extract(&source, &output, which, &AtomicBool::new(false)).unwrap();
            let copied = parse(&std::fs::read(&output).unwrap()).unwrap();
            assert_eq!(copied.tracks.len(), 1);
            let track = &copied.tracks[0];
            match which {
                Extract::Camera => {
                    let camera = index.camera.as_ref().unwrap();
                    assert_eq!(track.samples.len(), camera.times.len());
                    assert_eq!(track.samples[31].data, [4, 31]);
                    assert_eq!(track.samples.iter().map(|s| s.decode_time).collect::<Vec<_>>(), camera.times);
                    assert!(track.samples[30].sync && !track.samples[31].sync);
                }
                Extract::SecondSound => {
                    assert!(track.samples.iter().all(|s| s.data == [3; 9]));
                    // Its priming skipped as the recording's is, so it plays from the same moment.
                    assert_eq!(track.edit.map(|(_, media)| media), Some(2112));
                }
            }
            // Never over a file that exists.
            assert_eq!(extract(&source, &output, which, &AtomicBool::new(false)).unwrap_err().code, "output_exists");
            std::fs::remove_file(&output).unwrap();
        }
        let plain = temp("extract-plain");
        std::fs::write(&plain, crate::edit::remux::tests::recording(1)).unwrap();
        let output = temp("extract-none");
        assert_eq!(extract(&plain, &output, Extract::Camera, &AtomicBool::new(false)).unwrap_err().code, "unsupported");
        assert!(!output.exists());
        std::fs::remove_file(&plain).unwrap();
        std::fs::remove_file(&source).unwrap();
    }

    /// Plan 087's recovery: a recording that ended without its stop (a crash, a full disk) is left fragmented, every
    /// track's whole fragments kept; it is read, rendered and exported as a finished one is, up to what was written.
    #[test]
    fn an_interrupted_editable_recording_renders_what_it_holds() {
        let file = editable_recording(2, false);
        let index = source::read(&file).unwrap();
        assert!(index.fragmented && index.camera.is_some() && index.second_audio.is_some() && index.description.is_some());
        let plan = render_plan(&index, &[]).unwrap();
        let calls = Arc::new(Mutex::new(Calls::default()));
        let path = temp("interrupted");
        let options = RenderOptions { camera_hidden: Vec::new(), camera: Some(Layout::default()), gains: vec![1.0, 1.0] };
        let (_, frames) =
            render(&file, &index, &plan, &options, &mut FakeRenderer(calls.clone()), File::create(&path).unwrap(), &mut |_| {}, &AtomicBool::new(false))
                .unwrap();
        assert_eq!(frames, 60);
        let calls = calls.lock().unwrap();
        assert!(calls.composed.iter().all(|(screen, camera)| camera.as_deref() == Some(&[4, screen[1]][..])));
        let parsed = parse(&std::fs::read(&path).unwrap()).unwrap();
        assert!(!parsed.tracks[0].fragmented, "the export is finished, a plain file");
        std::fs::remove_file(&path).unwrap();
    }
}
