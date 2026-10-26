//! Where each kept part of an export starts and ends, and how each join is made (plan 085, D2). Pure: the source's
//! index and the removed ranges in, the parts, their joins and the sound's layout out, so the edit view's preview,
//! the export and the tests all follow one calculation.
//!
//! **Pictures.** Removed ranges are given in the video's timescale and snap to the nearest frame start. A kept part
//! that resumes on a key frame is copied. One that resumes inside a group of pictures either has its frames up to the
//! next key frame re-encoded from the preceding key frame (`JoinRule::SmartCut`), or resumes at the first key frame at
//! or after the requested one, never before (`JoinRule::KeyFrame`, used where the re-encoded pictures' parameter sets
//! differ from the source's and a second sample description is not allowed): removed content never reappears, and a
//! part with no key frame left is dropped.
//!
//! **Sound.** AAC packets are copied unchanged (as LosslessCut, Avidemux's copy mode and `ffmpeg -c:a copy` cut sound),
//! except a window of a few packets around each join, which is decoded, cut to the frame, faded and re-encoded (the
//! maintainer's choice of 2026-10-24 over D2's re-encoding of the whole track, which ran at a sixth of the disk's speed).
//! A copied packet keeps its place on the 1024-frame packet grid only if each part starts on the same grid position as
//! in the source, so each part's start is moved by at most half a packet (10.7 ms at 48 kHz) by lengthening or
//! shortening the last picture before the join. Pictures and sound move together, so inside each part their offset is
//! exactly the source's, and the drift never adds up across joins. The head is not re-encoded: the copy starts two
//! packets before the first kept frame, which the edit list skips, as it skips an encoder's priming.

use std::ops::Range;

use super::source::{AudioTrack, VideoTrack};

/// AAC frames in a packet.
pub const PACKET: u64 = 1024;
/// Removed ranges an edit may hold.
pub const MAX_RANGES: usize = 256;
/// The fade at each side of a join, in seconds.
pub const FADE_SECONDS: f64 = 0.005;
/// Frames of sound around a join, beyond the fades and the nudge, that the window also re-encodes.
const WINDOW_MARGIN: u64 = 512;
/// The longest group of pictures re-encoded, in seconds: recordings have a key frame every second, so only a damaged
/// file's runs are longer; such a join resumes at its next key frame instead, as the key-frame rule does, so a run's
/// pictures held in memory stay bounded.
pub const MAX_RUN_SECONDS: u64 = 4;
/// Packets the copy starts before the first kept frame, so a decoder is primed before it.
const HEAD_PACKETS: u64 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinRule {
    /// Re-encode from a resume point inside a group of pictures to the next key frame.
    SmartCut,
    /// Resume at the first key frame at or after the requested frame.
    KeyFrame,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reencode {
    /// The key frame decoding starts at.
    pub key: usize,
    /// Frames `part.first..until` are re-encoded; `until` is the next key frame or the part's end.
    pub until: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    /// The frame the edit asked this part to start at, and its time.
    pub requested: usize,
    pub requested_time: u64,
    /// Frames `first..end` are kept.
    pub first: usize,
    pub end: usize,
    /// Source times of the first frame's start and the last frame's end.
    pub start: u64,
    pub stop: u64,
    pub reencode: Option<Reencode>,
    /// The part resumes later than asked, at a key frame (`JoinRule::KeyFrame`).
    pub fell_back: bool,
    /// Where its first frame is shown in the output, and how long its last frame lasts there.
    pub out_start: u64,
    pub last_duration: u32,
}

/// A kept range left out because it held no key frame to resume at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dropped {
    pub start: u64,
    pub stop: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioPart {
    /// Presentation frame (after the output's skip) the part starts at, and the source's media frame there.
    pub out_start: u64,
    pub src_start: u64,
    /// The source's media frame where the part's pictures end: sound past it is silence.
    pub src_stop: u64,
    pub fade_in: bool,
    pub fade_out: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioPlan {
    /// Frames the output's edit list skips.
    pub skip: u32,
    /// Frames after `skip` that are presented.
    pub presented: u64,
    /// Output packets.
    pub packets: u64,
    pub parts: Vec<AudioPart>,
    /// Output packets that are re-encoded, in order and apart.
    pub windows: Vec<Range<u64>>,
    /// Frames of each fade.
    pub fade: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    /// The removed ranges as snapped to frames, in source time.
    pub removed: Vec<(u64, u64)>,
    pub parts: Vec<Part>,
    pub dropped: Vec<Dropped>,
    /// The output's length in the video's timescale.
    pub duration: u64,
    pub audio: Option<AudioPlan>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanError {
    /// `nothing_kept`, `too_many_ranges` or `invalid_range`.
    pub code: &'static str,
    pub detail: String,
}

fn error(code: &'static str, detail: impl Into<String>) -> PlanError {
    PlanError { code, detail: detail.into() }
}

impl Plan {
    /// The output packet `n`'s source packet when it is copied: none inside a window.
    pub fn copied_packet(&self, n: u64) -> Option<u64> {
        let audio = self.audio.as_ref()?;
        if audio.windows.iter().any(|w| w.contains(&n)) {
            return None;
        }
        let frame = n * PACKET;
        let part = audio.parts.iter().rposition(|p| p.out_start + u64::from(audio.skip) <= frame).unwrap_or(0);
        let p = &audio.parts[part];
        // Each part's offset is a whole number of packets (`audio_plan`).
        let source = (frame + p.src_start).checked_sub(p.out_start + u64::from(audio.skip))?;
        Some(source / PACKET)
    }
}

/// The frame whose start is nearest `time`, or the frame count at or past the end.
fn snap(video: &VideoTrack, time: u64) -> usize {
    if time >= video.end() {
        return video.times.len();
    }
    let after = video.times.partition_point(|&t| t < time);
    if after == 0 {
        return 0;
    }
    if after == video.times.len() {
        let last = after - 1;
        let end = video.end();
        return if end - time < time - video.times[last] { after } else { last };
    }
    if video.times[after] - time < time - video.times[after - 1] { after } else { after - 1 }
}

/// Plans the export of `video` (and `audio`) without the `removed` ranges, given in the video's timescale.
pub fn plan(video: &VideoTrack, audio: Option<&AudioTrack>, removed: &[(u64, u64)], rule: JoinRule) -> Result<Plan, PlanError> {
    if removed.len() > MAX_RANGES {
        return Err(error("too_many_ranges", format!("{} removed ranges; at most {MAX_RANGES}", removed.len())));
    }
    let count = video.times.len();
    // Frames removed, as sorted, merged index ranges.
    let mut gone: Vec<(usize, usize)> = Vec::new();
    for &(from, to) in removed {
        if from >= to {
            return Err(error("invalid_range", format!("a removed range from {from} to {to}")));
        }
        let (a, b) = (snap(video, from), snap(video, to));
        if a < b {
            gone.push((a, b));
        }
    }
    gone.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (a, b) in gone {
        match merged.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => merged.push((a, b)),
        }
    }
    let time = |index: usize| if index < count { video.times[index] } else { video.end() };
    let mut kept: Vec<(usize, usize)> = Vec::new();
    let mut at = 0;
    for &(a, b) in &merged {
        if a > at {
            kept.push((at, a));
        }
        at = b;
    }
    if at < count {
        kept.push((at, count));
    }
    let mut parts = Vec::new();
    let mut dropped = Vec::new();
    for (first, end) in kept {
        let requested = first;
        let mut part = Part {
            requested,
            requested_time: time(first),
            first,
            end,
            start: time(first),
            stop: time(end),
            reencode: None,
            fell_back: false,
            out_start: 0,
            last_duration: video.samples.durations[end - 1],
        };
        if !video.sync[first] {
            let next_key = (first + 1..end).find(|&k| video.sync[k]);
            // Frame 0 is a key frame (the reader checks), so one precedes every frame.
            let key = (0..first).rev().find(|&k| video.sync[k]).unwrap_or(0);
            let until = next_key.unwrap_or(end);
            let bounded = time(until) - time(key) <= MAX_RUN_SECONDS * u64::from(video.timescale);
            match if bounded { rule } else { JoinRule::KeyFrame } {
                JoinRule::SmartCut => part.reencode = Some(Reencode { key, until }),
                JoinRule::KeyFrame => match next_key {
                    Some(k) => {
                        part.first = k;
                        part.start = time(k);
                        part.fell_back = true;
                    }
                    None => {
                        dropped.push(Dropped { start: time(first), stop: time(end) });
                        continue;
                    }
                },
            }
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Err(error("nothing_kept", "every frame is removed"));
    }
    // A removal from the first frame is from the recording's start, before which nothing is drawn: a first frame stamped
    // a little after zero would otherwise leave a sliver the edit view showed as kept (a native round of 2026-10-27).
    let removed = merged.iter().map(|&(a, b)| (if a == 0 { 0 } else { time(a) }, time(b))).collect();
    let audio = audio.filter(|a| !a.samples.is_empty());
    let (duration, audio) = match audio {
        Some(audio) => {
            let (duration, plan) = audio_plan(video.timescale, audio, &mut parts);
            (duration, Some(plan))
        }
        None => {
            let mut out = 0;
            for part in &mut parts {
                part.out_start = out;
                out += part.stop - part.start;
            }
            (out, None)
        }
    };
    Ok(Plan { removed, parts, dropped, duration, audio })
}

fn to_frames(ticks: u64, timescale: u32, rate: u32) -> u64 {
    ((u128::from(ticks) * u128::from(rate) + u128::from(timescale) / 2) / u128::from(timescale)) as u64
}

fn to_ticks(frames: u64, rate: u32, timescale: u32) -> u64 {
    ((u128::from(frames) * u128::from(timescale) + u128::from(rate) / 2) / u128::from(rate)) as u64
}

/// Places each part on the output's timeline so its sound keeps the source's packet grid, and lays out the windows.
/// Returns the output's length in the video's timescale.
fn audio_plan(timescale: u32, audio: &AudioTrack, parts: &mut [Part]) -> (u64, AudioPlan) {
    let rate = audio.sample_rate;
    let skip_src = u64::from(audio.skip);
    let media = |ticks: u64| to_frames(ticks, timescale, rate) + skip_src;
    // The head: the copy starts HEAD_PACKETS before the packet holding the first kept frame.
    let a0 = media(parts[0].start);
    let first_packet = (a0 / PACKET).saturating_sub(HEAD_PACKETS);
    let skip = a0 - first_packet * PACKET;
    let mut audio_parts = Vec::with_capacity(parts.len());
    let mut ideal = 0u64;
    let mut out = 0u64;
    let count = parts.len();
    for index in 0..count {
        let src_start = media(parts[index].start);
        let src_stop = media(parts[index].stop);
        let q = if index == 0 {
            0
        } else {
            // The presentation frame nearest the ideal one at which the part's packets line up with the source's.
            let target = to_frames(ideal, timescale, rate) as i64;
            let residue = (src_start as i64 - skip as i64).rem_euclid(PACKET as i64);
            let above = target + (residue - target).rem_euclid(PACKET as i64);
            let below = above - PACKET as i64;
            let previous = &parts[index - 1];
            let last_start = out - u64::from(previous.last_duration);
            // The previous part's last picture must keep at least a millisecond.
            let floor = last_start + (u64::from(timescale) / 1000).max(1);
            let fits = |q: i64| q > 0 && to_ticks(q as u64, rate, timescale) >= floor;
            let mut pick = if (target - below).abs() <= (above - target).abs() && fits(below) { below } else { above };
            // A picture shorter than the nudge (a variable-rate source's): a later grid position.
            while !fits(pick) {
                pick += PACKET as i64;
            }
            let q = pick as u64;
            let start = to_ticks(q, rate, timescale);
            parts[index - 1].last_duration = u32::try_from(start - last_start).unwrap_or(u32::MAX);
            out = start;
            q
        };
        parts[index].out_start = out;
        out += parts[index].stop - parts[index].start;
        ideal += parts[index].stop - parts[index].start;
        audio_parts.push(AudioPart { out_start: q, src_start, src_stop, fade_in: index > 0, fade_out: index + 1 < count });
    }
    let duration = out;
    // Sound ends with the pictures, or where the source's ends.
    let last = audio_parts.last().unwrap();
    let source_end = skip_src + audio.presented.unwrap_or_else(|| (audio.samples.len() as u64 * PACKET).saturating_sub(skip_src));
    let available = source_end.saturating_sub(last.src_start);
    let presented = to_frames(duration, timescale, rate).min(last.out_start + available);
    let packets = (presented + skip).div_ceil(PACKET);
    let fade = ((f64::from(rate) * FADE_SECONDS).round() as u64).max(1);
    let mut windows: Vec<Range<u64>> = Vec::new();
    for index in 1..audio_parts.len() {
        let join = audio_parts[index].out_start + skip;
        let previous = &audio_parts[index - 1];
        let audible_end = (previous.out_start + skip + previous.src_stop.saturating_sub(previous.src_start)).min(join);
        let from = audible_end.saturating_sub(fade + WINDOW_MARGIN) / PACKET;
        let to = (join + fade + WINDOW_MARGIN).div_ceil(PACKET).min(packets);
        if from >= to {
            continue;
        }
        match windows.last_mut() {
            // A copied packet between two windows would be a splice of its own: they become one.
            Some(last) if from <= last.end + 1 => last.end = last.end.max(to),
            _ => windows.push(from..to),
        }
    }
    let plan = AudioPlan { skip: skip as u32, presented, packets, parts: audio_parts, windows, fade };
    (duration, plan)
}

/// The gain at output presentation frame `q` of `part` (raised-cosine fades), and the source frame it takes, or none
/// past the part's pictures (silence).
pub fn source_frame(plan: &AudioPlan, part: usize, q: i64) -> (Option<u64>, f32) {
    let p = &plan.parts[part];
    let offset = q - p.out_start as i64;
    let source = p.src_start as i64 + offset;
    let length = (p.src_stop - p.src_start) as i64;
    let next = plan.parts.get(part + 1).map(|n| n.out_start as i64 - p.out_start as i64);
    // Audible until the part's pictures end or the next part begins, whichever is first.
    let audible = next.map_or(length, |n| n.min(length));
    if source < 0 || p.fade_out && offset >= audible {
        return (None, 0.0);
    }
    let fade = plan.fade as f64;
    let curve = |x: f64| (0.5 - 0.5 * (std::f64::consts::PI * x.clamp(0.0, 1.0)).cos()) as f32;
    let mut gain = 1.0f32;
    if p.fade_in {
        gain *= curve((offset as f64 + 0.5) / fade);
    }
    if p.fade_out {
        gain *= curve((audible as f64 - offset as f64 - 0.5) / fade);
    }
    (Some(source as u64), gain)
}

/// The part output presentation frame `q` belongs to.
pub fn part_at(plan: &AudioPlan, q: i64) -> usize {
    plan.parts.iter().rposition(|p| p.out_start as i64 <= q).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::source::Samples;

    /// `count` frames of `duration` ticks at 90 kHz with a key frame every `gop`.
    fn video(count: usize, duration: u32, gop: usize) -> VideoTrack {
        VideoTrack {
            timescale: 90_000,
            avcc: vec![],
            width: 16,
            height: 16,
            samples: Samples { sizes: vec![10; count], durations: vec![duration; count], chunks: vec![(0, 0)] },
            times: (0..count as u64).map(|n| n * u64::from(duration)).collect(),
            sync: (0..count).map(|n| n % gop == 0).collect(),
        }
    }

    fn audio(packets: usize) -> AudioTrack {
        AudioTrack {
            timescale: 48_000,
            config: vec![0x11, 0x90],
            sample_rate: 48_000,
            channels: 2,
            average_bitrate: 256_000,
            max_bitrate: 256_000,
            skip: 2112,
            presented: Some(packets as u64 * 1024 - 2112 - 500),
            samples: Samples { sizes: vec![9; packets], durations: vec![1024; packets], chunks: vec![(0, 0)] },
        }
    }

    #[test]
    fn cuts_snap_to_the_nearest_frame_start_and_merge() {
        // 30 fps, a key frame each second; remove 1.0 s to 2.0 s, written slightly off the frame starts, twice.
        let v = video(150, 3000, 30);
        let p = plan(&v, None, &[(91_000, 179_000), (100_000, 120_000)], JoinRule::SmartCut).unwrap();
        assert_eq!(p.removed, [(90_000, 180_000)]);
        assert_eq!(p.parts.len(), 2);
        assert_eq!((p.parts[0].first, p.parts[0].end, p.parts[1].first), (0, 30, 60));
        // Both resume on key frames: copied.
        assert!(p.parts.iter().all(|part| part.reencode.is_none() && !part.fell_back));
        assert_eq!(p.duration, 120 * 3000);
        assert_eq!(p.parts[1].out_start, 90_000);
    }

    #[test]
    fn a_resume_inside_a_group_is_re_encoded_to_the_next_key_frame() {
        let v = video(150, 3000, 30);
        // Resume at frame 70, ten frames after the key frame at 60.
        let p = plan(&v, None, &[(30 * 3000, 70 * 3000)], JoinRule::SmartCut).unwrap();
        let part = &p.parts[1];
        assert_eq!((part.first, part.start), (70, 70 * 3000));
        assert_eq!(part.reencode, Some(Reencode { key: 60, until: 90 }));
        assert_eq!(p.duration, (30 + 80) * 3000);
    }

    #[test]
    fn a_resume_inside_a_short_part_re_encodes_only_the_part() {
        let v = video(150, 3000, 30);
        let p = plan(&v, None, &[(30 * 3000, 70 * 3000), (80 * 3000, 150 * 3000)], JoinRule::SmartCut).unwrap();
        assert_eq!(p.parts[1].reencode, Some(Reencode { key: 60, until: 80 }));
        assert_eq!(p.parts[1].end, 80);
    }

    #[test]
    fn the_key_frame_rule_resumes_at_the_next_key_frame_and_drops_a_part_without_one() {
        let v = video(150, 3000, 30);
        let p = plan(&v, None, &[(30 * 3000, 70 * 3000), (80 * 3000, 100 * 3000)], JoinRule::KeyFrame).unwrap();
        // 70..80 holds no key frame: dropped. 100..150 resumes at 120, never before 100.
        assert_eq!(p.dropped, [Dropped { start: 70 * 3000, stop: 80 * 3000 }]);
        assert_eq!(p.parts.len(), 2);
        let resumed = &p.parts[1];
        assert!(resumed.fell_back);
        assert_eq!((resumed.requested, resumed.first, resumed.start), (100, 120, 120 * 3000));
        assert_eq!(resumed.reencode, None);
        assert_eq!(p.duration, (30 + 30) * 3000);
    }

    #[test]
    fn a_group_longer_than_recordings_have_resumes_at_its_key_frame_instead_of_re_encoding() {
        // A damaged file: a key frame every 10 s.
        let v = video(900, 3000, 300);
        let p = plan(&v, None, &[(30 * 3000, 400 * 3000)], JoinRule::SmartCut).unwrap();
        let part = &p.parts[1];
        assert_eq!(part.reencode, None);
        assert!(part.fell_back);
        assert_eq!(part.first, 600);
    }

    #[test]
    fn removing_everything_or_a_reversed_range_is_refused() {
        let v = video(30, 3000, 30);
        assert_eq!(plan(&v, None, &[(0, 30 * 3000)], JoinRule::SmartCut).unwrap_err().code, "nothing_kept");
        assert_eq!(plan(&v, None, &[(10, 5)], JoinRule::SmartCut).unwrap_err().code, "invalid_range");
        let many: Vec<(u64, u64)> = (0..MAX_RANGES as u64 + 1).map(|n| (n * 10, n * 10 + 5)).collect();
        assert_eq!(plan(&v, None, &many, JoinRule::SmartCut).unwrap_err().code, "too_many_ranges");
    }

    #[test]
    fn a_removed_head_starts_at_zero_though_the_first_frame_is_stamped_later() {
        let mut v = video(150, 3000, 30);
        for t in &mut v.times {
            *t += 1500;
        }
        let p = plan(&v, None, &[(0, 30 * 3000 + 1500)], JoinRule::SmartCut).unwrap();
        assert_eq!(p.removed, [(0, 30 * 3000 + 1500)]);
        assert_eq!(p.parts[0].first, 30);
        // Removed from inside, it keeps the frame's own start.
        let p = plan(&v, None, &[(10 * 3000 + 1500, 30 * 3000 + 1500)], JoinRule::SmartCut).unwrap();
        assert_eq!(p.removed, [(10 * 3000 + 1500, 30 * 3000 + 1500)]);
    }

    #[test]
    fn a_removed_head_and_tail_keep_one_part() {
        let v = video(150, 3000, 30);
        let p = plan(&v, None, &[(0, 30 * 3000), (120 * 3000, 150 * 3000)], JoinRule::SmartCut).unwrap();
        assert_eq!(p.parts.len(), 1);
        assert_eq!((p.parts[0].first, p.parts[0].end, p.parts[0].out_start), (30, 120, 0));
        assert_eq!(p.duration, 90 * 3000);
    }

    #[test]
    fn each_part_keeps_the_source_packet_grid_within_half_a_packet() {
        let v = video(300, 3000, 30);
        let a = audio(500);
        // Joins at odd times: 1.0 -> 2.3 s and 4.1 -> 6.7 s removed.
        let p = plan(&v, Some(&a), &[(90_000, 207_000), (369_000, 603_000)], JoinRule::SmartCut).unwrap();
        let audio = p.audio.as_ref().unwrap();
        let skip = u64::from(audio.skip);
        let mut ideal = 0u64;
        for (index, (part, sound)) in p.parts.iter().zip(&audio.parts).enumerate() {
            // The part's media offset is a whole number of packets.
            assert_eq!((sound.out_start + skip) as i64 % 1024, sound.src_start as i64 % 1024, "part {index}");
            // Pictures start where the sound does, to a tick.
            assert!(to_ticks(sound.out_start, 48_000, 90_000).abs_diff(part.out_start) <= 1);
            // At most half a packet from where it would be without the grid.
            assert!(part.out_start.abs_diff(ideal) <= to_ticks(512, 48_000, 90_000) + 1, "part {index}: {} vs {ideal}", part.out_start);
            ideal += part.stop - part.start;
        }
        // The nudge sits in the last picture before each join.
        for pair in p.parts.windows(2) {
            assert_eq!(pair[0].out_start + (pair[0].stop - pair[0].start) - 3000 + u64::from(pair[0].last_duration), pair[1].out_start);
        }
        assert!(p.duration.abs_diff(ideal) <= to_ticks(512, 48_000, 90_000) + 1);
        // The head is copied from two packets before the first kept frame.
        assert!((2048..3072).contains(&skip), "skip {skip}");
        assert_eq!(audio.windows.len(), 2);
        // Every packet outside a window maps to a source packet; those inside are re-encoded.
        for window in &audio.windows {
            assert_eq!(p.copied_packet(window.start), None);
            assert!(p.copied_packet(window.end).is_some());
        }
        assert_eq!(p.copied_packet(0), Some(0));
        let after = audio.windows[0].end;
        let expected = (after * 1024 + audio.parts[1].src_start - audio.parts[1].out_start - skip) / 1024;
        assert_eq!(p.copied_packet(after), Some(expected));
    }

    #[test]
    fn a_window_covers_the_fades_and_the_nudge() {
        let v = video(300, 3000, 30);
        let a = audio(500);
        let p = plan(&v, Some(&a), &[(90_000, 207_000)], JoinRule::SmartCut).unwrap();
        let audio = p.audio.as_ref().unwrap();
        let skip = audio.skip as u64;
        let join = audio.parts[1].out_start + skip;
        let window = &audio.windows[0];
        assert!(window.start * 1024 + audio.fade <= join - 512, "{window:?} {join}");
        assert!(window.end * 1024 >= join + audio.fade + 512);
        // Inside the fades the gain rises and falls; past the first part's pictures there is silence.
        let q = audio.parts[1].out_start as i64;
        assert!(source_frame(audio, 1, q).1 < 0.01);
        assert!((source_frame(audio, 1, q + audio.fade as i64).1 - 1.0).abs() < 1e-6);
        let before = source_frame(audio, 0, q - 1);
        assert!(before.1 < 0.01 || before.0.is_none());
        assert_eq!(part_at(audio, q - 1), 0);
        assert_eq!(part_at(audio, q), 1);
    }

    #[test]
    fn short_parts_merge_their_windows() {
        let v = video(300, 3000, 30);
        let a = audio(500);
        // A one-frame part (33 ms) between two cuts: its two joins share one window.
        let p = plan(&v, Some(&a), &[(90_000, 180_000), (183_000, 270_000)], JoinRule::SmartCut).unwrap();
        assert_eq!(p.parts.len(), 3);
        assert_eq!(p.audio.unwrap().windows.len(), 1);
    }

    #[test]
    fn sound_ends_where_the_source_sound_does() {
        let v = video(300, 3000, 30);
        // Less sound than pictures: 3 s of packets for 10 s of video.
        let a = audio(141);
        let p = plan(&v, Some(&a), &[(0, 30_000)], JoinRule::SmartCut).unwrap();
        let audio = p.audio.unwrap();
        let source_end = 2112 + a.presented.unwrap();
        assert_eq!(audio.presented, source_end - audio.parts[0].src_start);
        assert!(audio.packets * 1024 >= audio.presented + u64::from(audio.skip));
    }
}
