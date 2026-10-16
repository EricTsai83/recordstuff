//! The per-frame log (plan 078, steps 1 and 3), a development switch: with `RECORDSTUFF_FRAME_LOG` naming a folder,
//! each recording writes `<recording's file name>.frames.jsonl` there, one line for every frame capture delivered
//! while recording and every frame the core encoded, so the cadence of a file can be traced to its cause (a picture
//! the pacer left out, an idle refresh, the refresh thread's slot). Off by default; nothing ships that sets it.
//!
//! A line is `{"t":<ms after the recording's start>,"kind":"<kind>","kept":<bool>,"next":<the pacer's next slot, ms>}`.
//! Kinds: `picture` (a frame with a new picture), `idle` (capture said the screen did not change), `blank` (a delivery
//! without a picture that is not idle), and the frames the core encodes on its own: `first` (the start), `skipped`
//! (the newest picture at a refresh capture skipped, see `Pacer::skipped`), `due` (a
//! picture left out, at its slot), `refresh` (the still screen's frame each second) and `stop` (the newest picture
//! before the stop).

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub const ENV: &str = "RECORDSTUFF_FRAME_LOG";

pub struct FrameLog {
    out: BufWriter<File>,
    pub path: PathBuf,
}

impl FrameLog {
    /// The log for the recording at `recording`, when the switch names a folder; None when it is unset or the file
    /// cannot be made (a diagnostic never stops a recording).
    pub fn from_env(recording: &Path) -> Option<Self> {
        let folder = std::env::var_os(ENV).filter(|value| !value.is_empty())?;
        Self::create(Path::new(&folder), recording)
    }

    pub fn create(folder: &Path, recording: &Path) -> Option<Self> {
        let mut name = recording.file_name()?.to_os_string();
        name.push(".frames.jsonl");
        let path = folder.join(name);
        let file = File::create(&path).ok()?;
        Some(Self { out: BufWriter::new(file), path })
    }

    /// One frame at `pts_ns`, the recording having started at `t0_ns`; `next_ns` is the pacer's next slot after it.
    pub fn line(&mut self, t0_ns: u64, pts_ns: u64, kind: &str, kept: bool, next_ns: Option<u64>) {
        let ms = |ns: u64| (ns as i128 - t0_ns as i128) as f64 / 1e6;
        let next = next_ns.map_or_else(|| "null".to_string(), |next| format!("{:.3}", ms(next)));
        let _ = writeln!(self.out, r#"{{"t":{:.3},"kind":"{kind}","kept":{kept},"next":{next}}}"#, ms(pts_ns));
    }
}

impl Drop for FrameLog {
    fn drop(&mut self) {
        let _ = self.out.flush();
    }
}
