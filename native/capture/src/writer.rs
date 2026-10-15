//! The engine's file writer (plan 076, D3): one thread owns the file and the muxer. Capture and encoder callbacks
//! hand it encoded samples over a channel and never wait on the disk, so a slow or stalled volume cannot hold capture
//! up, and a stalled main process no longer delays writing. It syncs the file every five seconds, as `file-writer.ts`
//! does, reports the bytes written once a second while media arrives, and classifies the first write error. Media
//! waiting for the disk is bounded as main's writer backlog is: past the bound the recording fails with
//! `output_write_failed` instead of growing until the process runs out of memory.

use std::fs::File;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::mux::mp4::{Codec, FinishReport, TrackConfig};
use crate::mux::session::SessionMuxer;
use crate::timing::ticks;

pub const VIDEO_TIMESCALE: u32 = 90_000;
/// Frames in one AAC packet.
pub const AAC_FRAMES: u32 = 1024;
const SYNC_INTERVAL: Duration = Duration::from_secs(5);
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
/// Encoded media waiting for the disk beyond this fails the recording instead of filling memory with it.
pub const BACKLOG_LIMIT_BYTES: u64 = 64 * 1024 * 1024;

pub enum Media {
    /// The encoder's configuration, sent once before its first sample.
    VideoFormat { avcc: Vec<u8>, width: u16, height: u16 },
    /// An encoded video sample captured at `pts_ns` host time.
    Video { data: Vec<u8>, pts_ns: u64, sync: bool },
    /// One AAC packet of `AAC_FRAMES` frames; packets are consecutive from the start of the recording.
    Audio { data: Vec<u8> },
}

impl Media {
    fn len(&self) -> u64 {
        match self {
            Media::VideoFormat { avcc, .. } => avcc.len() as u64,
            Media::Video { data, .. } | Media::Audio { data } => data.len() as u64,
        }
    }
}

enum Command {
    Media(Media),
    /// Write what is pending and make the file plain; video lasts until `video_end_ns`, and the audio track presents
    /// `audio_frames` frames after the encoder's priming.
    Finish { video_end_ns: u64, audio_frames: Option<u64>, reply: Sender<Result<FinishReport, WriteFailure>> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteFailure {
    /// `disk_full` or `output_write_failed`, as main's `classifyWriteError` names them.
    pub code: &'static str,
    pub detail: String,
}

pub enum WriterEvent {
    Progress { bytes: u64 },
    Failed(WriteFailure),
}

pub struct AudioSpec {
    pub config: Vec<u8>,
    /// Frames of encoder delay at the start of the track, which an edit list skips.
    pub priming: u32,
    pub sample_rate: u32,
    pub channels: u16,
    pub bitrate: u32,
}

pub struct WriterConfig {
    pub file: File,
    /// Host time of the recording's start; video times count from it.
    pub t0_ns: u64,
    pub audio: Option<AudioSpec>,
}

pub fn classify(error: &std::io::Error) -> &'static str {
    // ENOSPC on macOS and Linux; ERROR_HANDLE_DISK_FULL and ERROR_DISK_FULL on Windows.
    let full = error.kind() == std::io::ErrorKind::StorageFull
        || matches!(error.raw_os_error(), Some(28)) && cfg!(unix)
        || matches!(error.raw_os_error(), Some(39 | 112)) && cfg!(windows);
    if full { "disk_full" } else { "output_write_failed" }
}

fn failure(error: &std::io::Error, what: &str) -> WriteFailure {
    WriteFailure { code: classify(error), detail: format!("{what}: {error}") }
}

type Events = Arc<dyn Fn(WriterEvent) + Send + Sync>;

/// Hands media to the writer thread without waiting on it; any thread may hold a clone.
#[derive(Clone)]
pub struct MediaSender {
    commands: Sender<Command>,
    backlog: Arc<AtomicU64>,
    /// Set once media was refused for the backlog; `finish` then reports it.
    refused: Arc<Mutex<Option<WriteFailure>>>,
    events: Events,
}

impl MediaSender {
    pub fn send(&self, media: Media) {
        let mut refused = self.refused.lock().unwrap();
        if refused.is_some() {
            return;
        }
        let size = media.len();
        let pending = self.backlog.load(Ordering::Acquire);
        if pending + size > BACKLOG_LIMIT_BYTES {
            let failure = WriteFailure {
                code: "output_write_failed",
                detail: format!("writer backlog limit {BACKLOG_LIMIT_BYTES} bytes exceeded: {pending} bytes pending, {size} arriving"),
            };
            *refused = Some(failure.clone());
            drop(refused);
            (self.events)(WriterEvent::Failed(failure));
            return;
        }
        self.backlog.fetch_add(size, Ordering::AcqRel);
        let _ = self.commands.send(Command::Media(media));
    }

    /// Asks the writer to finish the file; the answer arrives on the returned receiver.
    pub fn finish(&self, video_end_ns: u64, audio_frames: Option<u64>) -> Receiver<Result<FinishReport, WriteFailure>> {
        let (reply, result) = channel();
        let _ = self.commands.send(Command::Finish { video_end_ns, audio_frames, reply });
        result
    }
}

pub struct Writer {
    pub sender: MediaSender,
    pub thread: JoinHandle<()>,
}

/// Starts the writer thread. `events` is called from it, and from a sender refusing media.
pub fn spawn(config: WriterConfig, events: impl Fn(WriterEvent) + Send + Sync + 'static) -> std::io::Result<Writer> {
    let (commands, receiver) = channel();
    let events: Events = Arc::new(events);
    let sender = MediaSender { commands, backlog: Arc::new(AtomicU64::new(0)), refused: Arc::new(Mutex::new(None)), events: events.clone() };
    let (backlog, refused) = (sender.backlog.clone(), sender.refused.clone());
    let thread = std::thread::Builder::new()
        .name("recordstuff-writer".into())
        .spawn(move || run(config, receiver, &*events, &backlog, &refused))?;
    Ok(Writer { sender, thread })
}

struct State {
    file: Option<File>,
    t0_ns: u64,
    audio: Option<AudioSpec>,
    muxer: Option<SessionMuxer<File>>,
    /// Audio packets that arrived before the video's configuration, which the file's header needs.
    early_audio: Vec<Vec<u8>>,
    failed: Option<WriteFailure>,
    media_since_progress: bool,
}

fn run(
    config: WriterConfig,
    receiver: Receiver<Command>,
    events: &dyn Fn(WriterEvent),
    backlog: &AtomicU64,
    refused: &Mutex<Option<WriteFailure>>,
) {
    let mut state = State {
        file: Some(config.file),
        t0_ns: config.t0_ns,
        audio: config.audio,
        muxer: None,
        early_audio: Vec::new(),
        failed: None,
        media_since_progress: false,
    };
    let mut next_sync = Instant::now() + SYNC_INTERVAL;
    let mut next_progress = Instant::now() + PROGRESS_INTERVAL;
    loop {
        let wait = next_sync.min(next_progress).saturating_duration_since(Instant::now());
        match receiver.recv_timeout(wait) {
            Ok(Command::Media(media)) => {
                state.media_since_progress = true;
                let size = media.len();
                if let Err(failure) = state.take(media) {
                    state.fail(failure, &events);
                }
                backlog.fetch_sub(size, Ordering::AcqRel);
            }
            Ok(Command::Finish { video_end_ns, audio_frames, reply }) => {
                let outcome = match refused.lock().unwrap().clone() {
                    // Media is missing from the file: it stays fragmented, as written.
                    Some(failure) => Err(failure),
                    None => state.finish(video_end_ns, audio_frames),
                };
                let _ = reply.send(outcome);
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
            // The engine went away without finishing: what was written stays, fragmented and readable.
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let now = Instant::now();
        if now >= next_sync {
            next_sync = now + SYNC_INTERVAL;
            if let Some(muxer) = state.muxer.as_mut() {
                if let Err(error) = muxer.sync() {
                    state.fail(failure(&error, "sync failed"), &events);
                }
            }
        }
        if now >= next_progress {
            next_progress = now + PROGRESS_INTERVAL;
            // Progress is what main's stall guard watches: it is sent only while media arrives.
            if state.media_since_progress && state.failed.is_none() {
                state.media_since_progress = false;
                events(WriterEvent::Progress { bytes: state.muxer.as_ref().map_or(0, |m| m.bytes_written()) });
            }
        }
    }
}

impl State {
    fn take(&mut self, media: Media) -> Result<(), WriteFailure> {
        if self.failed.is_some() {
            return Ok(());
        }
        match media {
            Media::VideoFormat { avcc, width, height } => {
                if self.muxer.is_some() {
                    return Ok(());
                }
                let Some(file) = self.file.take() else { return Ok(()) };
                let video = TrackConfig { codec: Codec::H264 { avcc, width, height }, timescale: VIDEO_TIMESCALE, skip: 0 };
                let audio = self.audio.as_ref().map(|spec| TrackConfig {
                    codec: Codec::Aac {
                        config: spec.config.clone(),
                        sample_rate: spec.sample_rate,
                        channels: spec.channels,
                        average_bitrate: spec.bitrate,
                        max_bitrate: spec.bitrate,
                    },
                    timescale: spec.sample_rate,
                    skip: spec.priming,
                });
                let mut muxer = SessionMuxer::new(file, video, audio).map_err(|e| failure(&e, "header write failed"))?;
                for packet in self.early_audio.drain(..) {
                    muxer.push_audio(packet, AAC_FRAMES).map_err(|e| failure(&e, "write failed"))?;
                }
                self.muxer = Some(muxer);
            }
            Media::Video { data, pts_ns, sync } => {
                let Some(muxer) = self.muxer.as_mut() else { return Ok(()) };
                let pts = ticks(pts_ns.saturating_sub(self.t0_ns), VIDEO_TIMESCALE);
                muxer.push_video(data, pts, sync).map_err(|e| failure(&e, "write failed"))?;
            }
            Media::Audio { data } => match self.muxer.as_mut() {
                Some(muxer) => muxer.push_audio(data, AAC_FRAMES).map_err(|e| failure(&e, "write failed"))?,
                None => self.early_audio.push(data),
            },
        }
        Ok(())
    }

    fn fail(&mut self, failure: WriteFailure, events: &impl Fn(WriterEvent)) {
        if self.failed.is_some() {
            return;
        }
        self.failed = Some(failure.clone());
        // Closing keeps what was written; nothing more is.
        self.muxer = None;
        events(WriterEvent::Failed(failure));
    }

    fn finish(&mut self, video_end_ns: u64, audio_frames: Option<u64>) -> Result<FinishReport, WriteFailure> {
        if let Some(failure) = &self.failed {
            return Err(failure.clone());
        }
        let Some(muxer) = self.muxer.take() else {
            // No video ever arrived: nothing was written, and main reports a recording without media.
            return Ok(FinishReport { bytes: 0, fragmented: None });
        };
        let end = ticks(video_end_ns.saturating_sub(self.t0_ns), VIDEO_TIMESCALE);
        let (report, _file) = muxer.finish(end, audio_frames).map_err(|e| failure(&e, "finish failed"))?;
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mux::parse::parse;
    use std::sync::{Arc, Mutex};

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("recordstuff-writer-{}-{name}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        dir
    }

    fn avcc() -> Vec<u8> {
        vec![1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee]
    }

    #[test]
    fn audio_before_the_video_format_is_kept_and_the_file_finishes_plain() {
        let path = temp("plain");
        let file = File::create(&path).unwrap();
        let t0 = 10 * crate::timing::NANOS_PER_SECOND;
        let spec = AudioSpec { config: vec![0x11, 0x90], priming: 0, sample_rate: 48_000, channels: 2, bitrate: 256_000 };
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let writer = spawn(WriterConfig { file, t0_ns: t0, audio: Some(spec) }, move |event| {
            seen.lock().unwrap().push(matches!(event, WriterEvent::Failed(_)));
        })
        .unwrap();
        let send = |media| writer.sender.send(media);
        send(Media::Audio { data: vec![1; 8] });
        send(Media::VideoFormat { avcc: avcc(), width: 640, height: 360 });
        for n in 0..60u64 {
            send(Media::Video { data: vec![n as u8; 20], pts_ns: t0 + n * 33_333_333, sync: n % 30 == 0 });
        }
        send(Media::Audio { data: vec![2; 8] });
        let result = writer.sender.finish(t0 + 2 * crate::timing::NANOS_PER_SECOND, None);
        let report = result.recv().unwrap().unwrap();
        writer.thread.join().unwrap();
        assert_eq!(report.fragmented, None);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len() as u64, report.bytes);
        let parsed = parse(&bytes).unwrap();
        assert_eq!(parsed.top, ["ftyp", "mdat", "moov"]);
        assert_eq!(parsed.tracks[0].samples.len(), 60);
        assert_eq!(parsed.tracks[0].samples[59].decode_time, 59 * 33_333_333 * 9 / 100_000);
        assert_eq!(parsed.tracks[0].duration, 180_000);
        assert_eq!(parsed.tracks[1].samples.len(), 2);
        assert_eq!(parsed.tracks[1].samples[0].data, vec![1; 8]);
        assert!(!events.lock().unwrap().contains(&true));
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn finishing_without_video_writes_nothing() {
        let path = temp("empty");
        let writer = spawn(WriterConfig { file: File::create(&path).unwrap(), t0_ns: 0, audio: None }, |_| {}).unwrap();
        let result = writer.sender.finish(0, None);
        assert_eq!(result.recv().unwrap().unwrap().bytes, 0);
        writer.thread.join().unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn media_past_the_backlog_limit_is_refused_once_and_finish_reports_it() {
        let path = temp("backlog");
        let failures = Arc::new(Mutex::new(Vec::new()));
        let seen = failures.clone();
        let writer = spawn(WriterConfig { file: File::create(&path).unwrap(), t0_ns: 0, audio: None }, move |event| {
            if let WriterEvent::Failed(failure) = event {
                seen.lock().unwrap().push(failure);
            }
        })
        .unwrap();
        // As if the disk had not kept up with everything already sent.
        writer.sender.backlog.store(BACKLOG_LIMIT_BYTES - 10, Ordering::Release);
        writer.sender.send(Media::Video { data: vec![0; 11], pts_ns: 0, sync: true });
        writer.sender.send(Media::Video { data: vec![0; 11], pts_ns: 1, sync: true });
        let error = writer.sender.finish(1, None).recv().unwrap().unwrap_err();
        writer.thread.join().unwrap();
        assert_eq!(error.code, "output_write_failed");
        assert!(error.detail.starts_with("writer backlog limit"));
        assert_eq!(failures.lock().unwrap().len(), 1);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_full_disk_is_classified_as_such() {
        assert_eq!(classify(&std::io::Error::from(std::io::ErrorKind::StorageFull)), "disk_full");
        #[cfg(unix)]
        assert_eq!(classify(&std::io::Error::from_raw_os_error(28)), "disk_full");
        assert_eq!(classify(&std::io::Error::from(std::io::ErrorKind::PermissionDenied)), "output_write_failed");
    }

    #[test]
    fn a_write_error_is_reported_once_and_finish_returns_it() {
        let path = temp("readonly");
        std::fs::write(&path, b"").unwrap();
        // Opened read-only: the first write fails.
        let file = File::open(&path).unwrap();
        let failures = Arc::new(Mutex::new(Vec::new()));
        let seen = failures.clone();
        let writer = spawn(WriterConfig { file, t0_ns: 0, audio: None }, move |event| {
            if let WriterEvent::Failed(failure) = event {
                seen.lock().unwrap().push(failure);
            }
        })
        .unwrap();
        writer.sender.send(Media::VideoFormat { avcc: avcc(), width: 2, height: 2 });
        writer.sender.send(Media::Video { data: vec![1], pts_ns: 0, sync: true });
        let result = writer.sender.finish(1, None);
        let error = result.recv().unwrap().unwrap_err();
        writer.thread.join().unwrap();
        assert_eq!(error.code, "output_write_failed");
        assert_eq!(failures.lock().unwrap().len(), 1);
        std::fs::remove_file(&path).unwrap();
    }
}
