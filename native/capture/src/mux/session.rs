//! A recording's muxing: encoded samples in, fragments out. Video samples arrive with presentation times and no
//! durations, so each is held until the next one says how long it lasted; a fragment closes at the first key frame
//! after a second of video, so every fragment starts with one and a player can begin at any of them. Audio packets
//! have a fixed duration and close a fragment every second. Tracks are fragmented independently: a fragment holds one
//! track, as ISO BMFF allows, which keeps a late audio packet from holding video back.

use std::io;

use super::mp4::{FinishReport, HybridMp4, Output, Sample, TrackConfig};

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

pub struct SessionMuxer<O: Output> {
    mp4: HybridMp4<O>,
    video_timescale: u32,
    audio_timescale: Option<u32>,
    held: Option<Held>,
    video: Pending,
    audio: Pending,
}

impl<O: Output> SessionMuxer<O> {
    pub fn new(out: O, video: TrackConfig, audio: Option<TrackConfig>) -> io::Result<Self> {
        let video_timescale = video.timescale;
        let audio_timescale = audio.as_ref().map(|a| a.timescale);
        let tracks = std::iter::once(video).chain(audio).collect();
        Ok(Self {
            mp4: HybridMp4::create(out, tracks)?,
            video_timescale,
            audio_timescale,
            held: None,
            video: Pending::default(),
            audio: Pending::default(),
        })
    }

    pub fn bytes_written(&self) -> u64 {
        self.mp4.bytes_written()
    }

    pub fn sync(&mut self) -> io::Result<()> {
        self.mp4.sync()
    }

    /// A video sample presented at `pts` ticks from the start of the recording. A time at or before the previous
    /// sample's (which the encoder does not produce) is moved just after it, so durations stay positive.
    pub fn push_video(&mut self, data: Vec<u8>, pts: u64, sync: bool) -> io::Result<()> {
        let mut pts = pts;
        if let Some(held) = self.held.take() {
            if pts <= held.pts {
                pts = held.pts + 1;
            }
            let duration = clamp_duration(pts - held.pts);
            self.video.ticks += u64::from(duration);
            self.video.samples.push(Owned { data: held.data, duration, sync: held.sync });
            if sync && self.video.ticks >= u64::from(self.video_timescale) {
                self.flush(VIDEO_TRACK)?;
            }
        }
        self.held = Some(Held { data, pts, sync });
        Ok(())
    }

    /// One audio packet lasting `duration` ticks; packets are consecutive.
    pub fn push_audio(&mut self, data: Vec<u8>, duration: u32) -> io::Result<()> {
        let timescale = self.audio_timescale.expect("audio pushed to a recording without an audio track");
        self.audio.ticks += u64::from(duration);
        self.audio.samples.push(Owned { data, duration, sync: true });
        if self.audio.ticks >= u64::from(timescale) {
            self.flush(AUDIO_TRACK)?;
        }
        Ok(())
    }

    /// Writes what is pending and makes the file plain. The last video sample lasts until `video_end` ticks. A last
    /// sample at or after the end is left out, unless it is the only one (then it lasts a thirtieth of a second):
    /// ScreenCaptureKit stamps a frame with when it is shown, which can be a few milliseconds after it is handed
    /// over, so a frame received before the stop can be stamped after it. Nothing refers to the last frame (the
    /// encoder does not reorder), so leaving it out is safe. The audio track presents `audio_frames` after its priming.
    pub fn finish(mut self, video_end: u64, audio_frames: Option<u64>) -> io::Result<(FinishReport, O)> {
        let written = self.mp4.sample_count(VIDEO_TRACK) + self.video.samples.len();
        if self.held.as_ref().is_some_and(|held| held.pts >= video_end && written > 0) {
            self.held = None;
        }
        if let Some(held) = self.held.take() {
            let duration = if video_end > held.pts { clamp_duration(video_end - held.pts) } else { (self.video_timescale / 30).max(1) };
            self.video.samples.push(Owned { data: held.data, duration, sync: held.sync });
        }
        self.flush(VIDEO_TRACK)?;
        if self.audio_timescale.is_some() {
            self.flush(AUDIO_TRACK)?;
            if let Some(frames) = audio_frames {
                self.mp4.set_presented(AUDIO_TRACK, frames);
            }
        }
        self.mp4.finish()
    }

    /// The decode time video has reached, held sample excluded, and the number of samples written per track.
    #[cfg(test)]
    fn written(&self, track: usize) -> (u64, usize) {
        (self.mp4.decode_end(track), self.mp4.sample_count(track))
    }

    fn flush(&mut self, track: usize) -> io::Result<()> {
        let pending = std::mem::take(if track == VIDEO_TRACK { &mut self.video } else { &mut self.audio });
        let samples: Vec<Sample> =
            pending.samples.iter().map(|s| Sample { data: &s.data, duration: s.duration, sync: s.sync }).collect();
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
}
