//! A recording's muxing: encoded samples in, fragments out. Video samples arrive with presentation times and no
//! durations, so each is held until the next one says how long it lasted; a fragment closes at the first key frame
//! after a second of video, so every fragment starts with one and a player can begin at any of them. Audio packets
//! have a fixed duration and close a fragment every second. Tracks are fragmented independently: a fragment holds one
//! track, as ISO BMFF allows, which keeps a late audio packet from holding video back.

use std::io;

use super::mp4::{Codec, FinishReport, HybridMp4, Output, Sample, TrackConfig};

/// Today's recording: the picture first, then its sound.
pub const VIDEO_TRACK: usize = 0;
pub const AUDIO_TRACK: usize = 1;

struct Owned {
    data: Vec<u8>,
    duration: u32,
    sync: bool,
}

struct Held {
    data: Vec<u8>,
    pts: u64,
    sync: bool,
}

#[derive(Default)]
struct Pending {
    samples: Vec<Owned>,
    ticks: u64,
}

/// One track's samples not yet in a fragment; a video track also holds its newest sample until the next one says how
/// long it lasted.
struct Muxed {
    timescale: u32,
    video: bool,
    held: Option<Held>,
    pending: Pending,
}

pub struct SessionMuxer<O: Output> {
    mp4: HybridMp4<O>,
    tracks: Vec<Muxed>,
}

impl<O: Output> SessionMuxer<O> {
    /// Today's recording: `video`, then `audio` when it has sound.
    pub fn new(out: O, video: TrackConfig, audio: Option<TrackConfig>) -> io::Result<Self> {
        Self::with_tracks(out, std::iter::once(video).chain(audio).collect())
    }

    /// Any tracks, in file order (plan 087's editable recording: the screen, each sound, the camera); H.264 tracks are
    /// pushed with `push_video_to`, AAC ones with `push_audio_to`.
    pub fn with_tracks(out: O, tracks: Vec<TrackConfig>) -> io::Result<Self> {
        let muxed = tracks
            .iter()
            .map(|track| Muxed { timescale: track.timescale, video: matches!(track.codec, Codec::H264 { .. }), held: None, pending: Pending::default() })
            .collect();
        Ok(Self { mp4: HybridMp4::create(out, tracks)?, tracks: muxed })
    }

    pub fn bytes_written(&self) -> u64 {
        self.mp4.bytes_written()
    }

    pub fn sync(&mut self) -> io::Result<()> {
        self.mp4.sync()
    }

    /// A video sample of the first track, presented at `pts` ticks from the start of the recording.
    pub fn push_video(&mut self, data: Vec<u8>, pts: u64, sync: bool) -> io::Result<()> {
        self.push_video_to(VIDEO_TRACK, data, pts, sync)
    }

    /// A video sample of `track` presented at `pts` ticks from the start of the recording. A time at or before the
    /// previous sample's (which the encoder does not produce) is moved just after it, so durations stay positive.
    pub fn push_video_to(&mut self, track: usize, data: Vec<u8>, pts: u64, sync: bool) -> io::Result<()> {
        let muxed = &mut self.tracks[track];
        assert!(muxed.video, "video pushed to a sound track");
        let mut pts = pts;
        let mut flush = false;
        if let Some(held) = muxed.held.take() {
            if pts <= held.pts {
                pts = held.pts + 1;
            }
            let duration = clamp_duration(pts - held.pts);
            muxed.pending.ticks += u64::from(duration);
            muxed.pending.samples.push(Owned { data: held.data, duration, sync: held.sync });
            flush = sync && muxed.pending.ticks >= u64::from(muxed.timescale);
        }
        muxed.held = Some(Held { data, pts, sync });
        if flush { self.flush(track) } else { Ok(()) }
    }

    /// One audio packet of the first sound track lasting `duration` ticks; packets are consecutive.
    pub fn push_audio(&mut self, data: Vec<u8>, duration: u32) -> io::Result<()> {
        let track = self.tracks.iter().position(|muxed| !muxed.video).expect("audio pushed to a recording without an audio track");
        self.push_audio_to(track, data, duration)
    }

    /// One audio packet of `track` lasting `duration` ticks; packets are consecutive.
    pub fn push_audio_to(&mut self, track: usize, data: Vec<u8>, duration: u32) -> io::Result<()> {
        let muxed = &mut self.tracks[track];
        assert!(!muxed.video, "audio pushed to a video track");
        muxed.pending.ticks += u64::from(duration);
        muxed.pending.samples.push(Owned { data, duration, sync: true });
        if muxed.pending.ticks >= u64::from(muxed.timescale) { self.flush(track) } else { Ok(()) }
    }

    /// Today's recording's `finish_tracks`: its one sound track presents `audio_frames`.
    pub fn finish(self, video_end: u64, audio_frames: Option<u64>) -> io::Result<(FinishReport, O)> {
        self.finish_tracks(video_end, &[audio_frames])
    }

    /// Writes what is pending and makes the file plain. The last sample of each video track lasts until `video_end`
    /// ticks. A last sample at or after the end is left out, unless it is the only one (then it lasts a thirtieth of a
    /// second): ScreenCaptureKit stamps a frame with when it is shown, which can be a few milliseconds after it is
    /// handed over, so a frame received before the stop can be stamped after it. Nothing refers to the last frame (the
    /// encoder does not reorder), so leaving it out is safe. The n-th sound track presents `audio_frames[n]` after its
    /// priming, when given.
    pub fn finish_tracks(mut self, video_end: u64, audio_frames: &[Option<u64>]) -> io::Result<(FinishReport, O)> {
        let mut sound = 0;
        for track in 0..self.tracks.len() {
            if self.tracks[track].video {
                let written = self.mp4.sample_count(track) + self.tracks[track].pending.samples.len();
                let muxed = &mut self.tracks[track];
                if muxed.held.as_ref().is_some_and(|held| held.pts >= video_end && written > 0) {
                    muxed.held = None;
                }
                if let Some(held) = muxed.held.take() {
                    let duration = if video_end > held.pts { clamp_duration(video_end - held.pts) } else { (muxed.timescale / 30).max(1) };
                    muxed.pending.samples.push(Owned { data: held.data, duration, sync: held.sync });
                }
                self.flush(track)?;
            } else {
                self.flush(track)?;
                if let Some(frames) = audio_frames.get(sound).copied().flatten() {
                    self.mp4.set_presented(track, frames);
                }
                sound += 1;
            }
        }
        self.mp4.finish()
    }

    /// Writes what is pending and syncs, leaving the file fragmented: for a recording that ends without finishing, so
    /// what it already holds is kept. A held video sample, whose end is unknown, lasts a thirtieth of a second.
    pub fn abandon(mut self) -> io::Result<()> {
        for track in 0..self.tracks.len() {
            let muxed = &mut self.tracks[track];
            if let Some(held) = muxed.held.take() {
                muxed.pending.samples.push(Owned { data: held.data, duration: (muxed.timescale / 30).max(1), sync: held.sync });
            }
            self.flush(track)?;
        }
        self.mp4.sync()
    }

    /// The decode time video has reached, held sample excluded, and the number of samples written per track.
    #[cfg(test)]
    fn written(&self, track: usize) -> (u64, usize) {
        (self.mp4.decode_end(track), self.mp4.sample_count(track))
    }

    fn flush(&mut self, track: usize) -> io::Result<()> {
        let pending = std::mem::take(&mut self.tracks[track].pending);
        let samples: Vec<Sample> = pending.samples.iter().map(|s| Sample { data: &s.data, duration: s.duration, sync: s.sync }).collect();
        self.mp4.write_fragment(track, &samples)
    }
}

fn clamp_duration(ticks: u64) -> u32 {
    u32::try_from(ticks).unwrap_or(u32::MAX).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mux::mp4::tests::{audio_config, video_config};
    use crate::mux::parse::parse;

    #[test]
    fn video_fragments_start_at_key_frames_after_a_second() {
        let mut muxer = SessionMuxer::new(Vec::new(), video_config(), Some(audio_config())).unwrap();
        // 30 fps with a key frame every 15 frames: the first fragment closes at the key frame at 1 s (frame 30).
        for n in 0..31u64 {
            muxer.push_video(vec![n as u8; 3], n * 3000, n % 15 == 0).unwrap();
        }
        assert_eq!(muxer.written(VIDEO_TRACK), (90_000, 30));
        let (report, out) = muxer.finish(31 * 3000, None).unwrap();
        assert_eq!(report.fragmented, None);
        let parsed = parse(&out).unwrap();
        assert_eq!(parsed.tracks[0].samples.len(), 31);
        assert_eq!(parsed.tracks[0].duration, 93_000);
    }

    #[test]
    fn durations_come_from_the_next_frame_and_the_end_time() {
        let mut muxer = SessionMuxer::new(Vec::new(), video_config(), None).unwrap();
        // Variable frame rate: a screen that changed, sat still for half a second, then changed again.
        for (pts, sync) in [(0, true), (1500, false), (46_500, false)] {
            muxer.push_video(vec![1, 2, 3], pts, sync).unwrap();
        }
        let (_, out) = muxer.finish(50_000, None).unwrap();
        let parsed = parse(&out).unwrap();
        let times: Vec<u64> = parsed.tracks[0].samples.iter().map(|s| s.decode_time).collect();
        assert_eq!(times, [0, 1500, 46_500]);
        assert_eq!(parsed.tracks[0].duration, 50_000);
    }

    #[test]
    fn a_repeated_timestamp_still_advances() {
        let mut muxer = SessionMuxer::new(Vec::new(), video_config(), None).unwrap();
        muxer.push_video(vec![1], 0, true).unwrap();
        muxer.push_video(vec![2], 0, false).unwrap();
        let (_, out) = muxer.finish(4000, None).unwrap();
        let parsed = parse(&out).unwrap();
        assert_eq!(parsed.tracks[0].samples[1].decode_time, 1);
        assert_eq!(parsed.tracks[0].duration, 4000);
    }

    #[test]
    fn a_last_frame_stamped_at_or_after_the_end_is_left_out_unless_it_is_the_only_one() {
        let mut muxer = SessionMuxer::new(Vec::new(), video_config(), None).unwrap();
        for (pts, sync) in [(0, true), (1500, false), (3000, false)] {
            muxer.push_video(vec![1, 2, 3], pts, sync).unwrap();
        }
        // Stopped at 2900 ticks: the frame stamped 3000 was shown after the stop.
        let (_, out) = muxer.finish(2900, None).unwrap();
        let parsed = parse(&out).unwrap();
        assert_eq!(parsed.tracks[0].samples.len(), 2);
        assert_eq!(parsed.tracks[0].duration, 3000);

        let mut muxer = SessionMuxer::new(Vec::new(), video_config(), None).unwrap();
        muxer.push_video(vec![1], 500, true).unwrap();
        let (_, out) = muxer.finish(100, None).unwrap();
        let parsed = parse(&out).unwrap();
        assert_eq!(parsed.tracks[0].samples.len(), 1);
        assert_eq!(parsed.tracks[0].duration, 3000);
    }

    #[test]
    fn audio_closes_a_fragment_every_second() {
        let mut muxer = SessionMuxer::new(Vec::new(), video_config(), Some(audio_config())).unwrap();
        muxer.push_video(vec![9], 0, true).unwrap();
        for _ in 0..47 {
            muxer.push_audio(vec![1; 4], 1024).unwrap();
        }
        assert_eq!(muxer.written(AUDIO_TRACK), (47 * 1024, 47));
        muxer.push_audio(vec![1; 4], 1024).unwrap();
        let (_, out) = muxer.finish(3000, None).unwrap();
        assert_eq!(parse(&out).unwrap().tracks[1].samples.len(), 48);
    }

    #[test]
    fn an_editable_recording_holds_each_track_apart_with_the_first_of_each_kind_presented() {
        // Plan 087's prototype: the screen, the system's sound, the microphone's, the camera.
        let tracks = vec![video_config(), audio_config(), audio_config(), video_config()];
        let mut muxer = SessionMuxer::with_tracks(Vec::new(), tracks).unwrap();
        for n in 0..31u64 {
            muxer.push_video_to(0, vec![1; 3], n * 3000, n % 30 == 0).unwrap();
            // The camera's frames on their own clock, a little after the screen's; its first at the start, as the
            // engine stamps it (a track's first sample is presented at zero whatever its time).
            muxer.push_video_to(3, vec![4; 2], if n == 0 { 0 } else { 1000 + n * 3000 }, n % 30 == 0).unwrap();
        }
        for _ in 0..48 {
            muxer.push_audio_to(1, vec![2; 4], 1024).unwrap();
        }
        for _ in 0..47 {
            muxer.push_audio_to(2, vec![3; 4], 1024).unwrap();
        }
        let (report, out) = muxer.finish_tracks(31 * 3000, &[Some(48 * 1024), Some(47 * 1024)]).unwrap();
        assert_eq!(report.fragmented, None);
        let parsed = parse(&out).unwrap();
        let counts: Vec<usize> = parsed.tracks.iter().map(|t| t.samples.len()).collect();
        assert_eq!(counts, [31, 48, 47, 31]);
        assert!(parsed.tracks[1].samples.iter().all(|s| s.data == [2; 4]) && parsed.tracks[2].samples.iter().all(|s| s.data == [3; 4]));
        assert!(parsed.tracks[3].samples.iter().all(|s| s.data == [4; 2]));
        // Both video tracks end at the stop.
        assert_eq!((parsed.tracks[0].duration, parsed.tracks[3].duration), (93_000, 93_000));
        let presented: Vec<(bool, u16)> = parsed.tracks.iter().map(|t| (t.enabled, t.alternate_group)).collect();
        assert_eq!(presented, [(true, 1), (true, 2), (false, 2), (false, 1)]);
    }

    #[test]
    fn today_s_recording_keeps_every_track_presented_and_in_no_group() {
        let mut muxer = SessionMuxer::new(Vec::new(), video_config(), Some(audio_config())).unwrap();
        muxer.push_video(vec![9], 0, true).unwrap();
        muxer.push_audio(vec![1; 4], 1024).unwrap();
        let (_, out) = muxer.finish(3000, None).unwrap();
        let presented: Vec<(bool, u16)> = parse(&out).unwrap().tracks.iter().map(|t| (t.enabled, t.alternate_group)).collect();
        assert_eq!(presented, [(true, 0), (true, 0)]);
    }
}
