//! Which H.264 encoder a Windows recording uses (plan 078 step 4, decided by the maintainer on 2026-10-16: the GPU's
//! hardware encoder, on by default, as Cap does). The platform-independent half: the rules and the record of what each
//! adapter's encoder did, kept in a file because each recording runs in a process of its own.
//!
//! Never WARP, Windows's software rasterizer, whose frames are converted on the CPU, and never AMD's encoder, which Cap
//! skips and which made OBS drop Media Foundation's encoders: AMD keeps the software encoder. A new adapter, driver or
//! size first passes a self-test (a few grey frames encoded and decoded back), because some drivers open a session and
//! then emit green or black frames without an error; an encoder that failed the test or a recording's watchdog is not
//! used again on that adapter and driver. `RECORDSTUFF_SOFTWARE_ENCODER=1` forces the software encoder, a development
//! switch; there is no user setting, as in Cap.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const FORCE_SOFTWARE_ENV: &str = "RECORDSTUFF_SOFTWARE_ENCODER";
/// The folder main gives the engine for what it keeps between recordings.
pub const DATA_ENV: &str = "RECORDSTUFF_ENGINE_DATA";
const FILE: &str = "h264-encoders.txt";

const AMD: [u32; 2] = [0x1002, 0x1022];

/// The Direct3D adapter capture runs on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Adapter {
    pub vendor: u32,
    pub device: u32,
    /// The user-mode driver's version.
    pub driver: i64,
    pub name: String,
    /// WARP.
    pub software: bool,
}

impl Adapter {
    fn key(&self) -> String {
        format!("{:04x}:{:04x}:{:x}", self.vendor, self.device, self.driver)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Choice {
    /// The software encoder, and why.
    Software(String),
    /// The hardware encoder, which passed its self-test at this size.
    Hardware,
    /// The hardware encoder once it passes a self-test at this size.
    SelfTest,
}

/// What each adapter's encoder did: passed the self-test at a size, or failed (the test or a recording).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Record {
    entries: BTreeMap<String, String>,
    path: Option<PathBuf>,
}

impl Record {
    /// The record in the folder `DATA_ENV` names, or an empty one that is never saved without it.
    pub fn from_env() -> Self {
        match std::env::var_os(DATA_ENV).filter(|value| !value.is_empty()) {
            Some(folder) => Self::load(&Path::new(&folder).join(FILE)),
            None => Self::default(),
        }
    }

    /// A missing or unreadable file is an empty record: the worst that costs is a self-test.
    pub fn load(path: &Path) -> Self {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        let entries = text
            .lines()
            .filter_map(|line| line.split_once(" = "))
            .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
            .collect();
        Self { entries, path: Some(path.to_path_buf()) }
    }

    /// Writes the record through a temporary name; a failure is ignored, as above.
    fn save(&self) {
        let Some(path) = &self.path else { return };
        let text: String = self.entries.iter().map(|(key, value)| format!("{key} = {value}\n")).collect();
        if let Some(folder) = path.parent() {
            let _ = std::fs::create_dir_all(folder);
        }
        let temporary = path.with_extension("tmp");
        if std::fs::write(&temporary, text).is_ok() {
            let _ = std::fs::rename(&temporary, path);
        }
    }

    pub fn passed(&mut self, adapter: &Adapter, (width, height): (u32, u32)) {
        self.entries.insert(format!("{} {width}x{height}", adapter.key()), "passed".into());
        self.save();
    }

    /// The encoder failed on this adapter and driver; `why` is kept for the log.
    pub fn failed(&mut self, adapter: &Adapter, why: &str) {
        let why: String = why.chars().filter(|c| !c.is_control()).take(200).collect();
        self.entries.insert(adapter.key(), format!("failed: {why}"));
        self.save();
    }

    fn failure(&self, adapter: &Adapter) -> Option<&str> {
        self.entries.get(&adapter.key()).and_then(|value| value.strip_prefix("failed: "))
    }

    fn has_passed(&self, adapter: &Adapter, (width, height): (u32, u32)) -> bool {
        self.entries.get(&format!("{} {width}x{height}", adapter.key())).is_some_and(|value| value == "passed")
    }
}

/// The encoder for a recording of `size` on `adapter`, before knowing whether it has a hardware encoder at all.
pub fn choose(adapter: &Adapter, size: (u32, u32), forced_software: bool, record: &Record) -> Choice {
    if forced_software {
        return Choice::Software(format!("{FORCE_SOFTWARE_ENV} is set"));
    }
    if adapter.software {
        return Choice::Software("no GPU: WARP converts frames on the CPU".into());
    }
    if AMD.contains(&adapter.vendor) {
        return Choice::Software(format!("{}: AMD's hardware encoder is not used", adapter.name));
    }
    if let Some(why) = record.failure(adapter) {
        return Choice::Software(format!("{}'s hardware encoder failed before ({why})", adapter.name));
    }
    if record.has_passed(adapter, size) { Choice::Hardware } else { Choice::SelfTest }
}

/// Whether the development switch forces the software encoder.
pub fn forced_software() -> bool {
    std::env::var(FORCE_SOFTWARE_ENV).is_ok_and(|value| value == "1")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(vendor: u32) -> Adapter {
        Adapter { vendor, device: 0x2684, driver: 0x0020_0010_000f_1234, name: "GPU".into(), software: false }
    }

    #[test]
    fn warp_amd_and_the_switch_keep_the_software_encoder() {
        let record = Record::default();
        assert!(matches!(choose(&Adapter { software: true, ..adapter(0x1414) }, (1920, 1080), false, &record), Choice::Software(_)));
        assert!(matches!(choose(&adapter(0x1002), (1920, 1080), false, &record), Choice::Software(why) if why.contains("AMD")));
        assert!(matches!(choose(&adapter(0x10de), (1920, 1080), true, &record), Choice::Software(why) if why.contains(FORCE_SOFTWARE_ENV)));
    }

    #[test]
    fn a_new_adapter_driver_or_size_is_tested_first_and_a_failure_is_remembered_across_recordings() {
        let folder = std::env::temp_dir().join(format!("recordstuff-encoders-{}", std::process::id()));
        let path = folder.join(FILE);
        let _ = std::fs::remove_dir_all(&folder);
        let nvidia = adapter(0x10de);
        let mut record = Record::load(&path);
        assert_eq!(choose(&nvidia, (1920, 1080), false, &record), Choice::SelfTest);
        record.passed(&nvidia, (1920, 1080));
        // Read again, as the next recording's process does.
        let mut record = Record::load(&path);
        assert_eq!(choose(&nvidia, (1920, 1080), false, &record), Choice::Hardware);
        assert_eq!(choose(&nvidia, (2560, 1440), false, &record), Choice::SelfTest, "another size");
        assert_eq!(choose(&Adapter { driver: 1, ..nvidia.clone() }, (1920, 1080), false, &record), Choice::SelfTest, "another driver");
        record.failed(&nvidia, "the encoder did not give a frame back within 5 s\n");
        let record = Record::load(&path);
        assert!(matches!(choose(&nvidia, (1920, 1080), false, &record), Choice::Software(why) if why.contains("within 5 s")));
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn an_unreadable_record_costs_only_a_self_test() {
        let path = std::env::temp_dir().join(format!("recordstuff-encoders-garbage-{}.txt", std::process::id()));
        std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(choose(&adapter(0x8086), (1280, 720), false, &Record::load(&path)), Choice::SelfTest);
        let _ = std::fs::remove_file(&path);
    }
}
