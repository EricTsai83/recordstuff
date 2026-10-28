//! An editable recording's description (plan 087), written into the file's `moov` as `udta/rsed` (mux/mp4.rs): what
//! makes a file editable rather than merely several tracks, which input each sound track holds, and where the camera's
//! bubble was when the recording started, the edit's first place for it. JSON, which main reads and checks
//! (src/shared/editable.ts); the engine only writes it and hands it on as text, so it needs no JSON library. Version 1:
//!
//! ```json
//! {"version":1,"sounds":["system","microphone"],"camera":{"width":0.2,"height":0.37,"rounding":0.15,"x":0.97,"y":0.05,"mirror":false}}
//! ```
//!
//! Version 2 (plan 098), written only when there is a mix: the file's first sound track holds the inputs `sounds` names
//! mixed, as a plain recording mixes them, so any player plays every one; the separate tracks follow it in `sounds`'
//! order, disabled alternates for the edit. A recording with one input has nothing to mix and is still version 1, so
//! older versions read it as before.
//!
//! ```json
//! {"version":2,"mix":true,"sounds":["system","microphone"],"camera":null}
//! ```
//!
//! `camera` is null without a camera track. The volumes set while recording are already in the sound tracks, so an
//! edit's volumes start at 100% of what was recorded.

use crate::camera_layout::Layout;

/// The version of a description without a mix, and of one with it (plan 098).
pub const VERSION: u32 = 1;
pub const MIX_VERSION: u32 = 2;
/// A description larger than this is not one the engine wrote, and is not read.
pub const MAX_BYTES: usize = 4096;

/// What a sound track holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sound {
    System,
    Microphone,
    /// A recording without any sound input still has one track, of silence.
    Silent,
}

impl Sound {
    fn name(self) -> &'static str {
        match self {
            Sound::System => "system",
            Sound::Microphone => "microphone",
            Sound::Silent => "silent",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Description {
    /// The inputs' own sound tracks, in the file's order.
    pub sounds: Vec<Sound>,
    /// Whether a track of `sounds` mixed comes before them (plan 098), the one players play.
    pub mix: bool,
    /// The camera's layout when the recording started; None without a camera track.
    pub camera: Option<Layout>,
}

impl Description {
    pub fn to_bytes(&self) -> Vec<u8> {
        let sounds: Vec<String> = self.sounds.iter().map(|s| format!("\"{}\"", s.name())).collect();
        // Clamped, so every number is finite: Rust prints a finite f64 as a JSON number.
        let camera = self.camera.map_or_else(
            || "null".to_string(),
            |l| {
                let l = l.clamped();
                format!(r#"{{"width":{},"height":{},"rounding":{},"x":{},"y":{},"mirror":{}}}"#, l.width, l.height, l.rounding, l.x, l.y, l.mirror)
            },
        );
        let head = if self.mix { format!(r#""version":{MIX_VERSION},"mix":true"#) } else { format!(r#""version":{VERSION}"#) };
        format!(r#"{{{head},"sounds":[{}],"camera":{camera}}}"#, sounds.join(",")).into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_description_is_json_main_can_read() {
        let layout = Layout { width: 0.2, height: 0.37, rounding: 0.15, x: 0.97, y: 0.05, mirror: true };
        let bytes = Description { sounds: vec![Sound::System, Sound::Microphone], mix: false, camera: Some(layout) }.to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["sounds"], serde_json::json!(["system", "microphone"]));
        assert_eq!(value["camera"]["height"], 0.37);
        assert_eq!(value["camera"]["mirror"], true);
        let silent: serde_json::Value = serde_json::from_slice(&Description { sounds: vec![Sound::Silent], mix: false, camera: None }.to_bytes()).unwrap();
        assert_eq!(silent, serde_json::json!({"version": 1, "sounds": ["silent"], "camera": null}));
        assert!(bytes.len() < MAX_BYTES);
    }

    #[test]
    fn a_description_with_a_mix_is_version_2() {
        let bytes = Description { sounds: vec![Sound::System, Sound::Microphone], mix: true, camera: None }.to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value, serde_json::json!({"version": 2, "mix": true, "sounds": ["system", "microphone"], "camera": null}));
    }

    #[test]
    fn a_layout_outside_its_ranges_is_written_clamped_and_finite() {
        let layout = Layout { width: f64::NAN, height: 9.0, rounding: 0.1, x: -1.0, y: 0.5, mirror: false };
        let value: serde_json::Value = serde_json::from_slice(&Description { sounds: vec![], mix: false, camera: Some(layout) }.to_bytes()).unwrap();
        assert_eq!(value["camera"]["height"], crate::camera_layout::MAX_SIZE);
        assert_eq!(value["camera"]["x"].as_f64(), Some(0.0));
        assert!(value["camera"]["width"].is_f64());
    }
}
