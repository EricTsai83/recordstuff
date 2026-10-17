//! The camera bubble's geometry (plan 075): where the camera goes in an output frame, how its corners are rounded and
//! how the camera's own picture fills it. Pure, so the compositor and its tests (and later the Settings preview's
//! parameters) come from one formula (D2).
//!
//! Step 2's prototype takes its layout from the development switch `RECORDSTUFF_CAMERA_PROTOTYPE` (`CameraPrototype`):
//! `1` (or `on`) for the defaults, or comma-separated `key=value` pairs: `width`, `height` (fractions of the output's
//! shorter side, 0.05–0.6), `rounding` (0–1, 1 being half the bubble's shorter side), `x`, `y` (0–1 of the free space:
//! 0 the left or top edge, 1 the right or bottom one), `mirror` (0 or 1), `device` (an AVCaptureDevice unique ID) and
//! `preview` (0 to send no preview frames). Unset, empty or `0` is off, and recording is unchanged.

/// A rectangle in pixels from the frame's top-left corner.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the user sets (D1, D3, D8): sizes as fractions of the output's shorter side, the position as a fraction of the
/// free space on each axis, the rounding as a fraction of half the bubble's shorter side.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layout {
    pub width: f64,
    pub height: f64,
    pub rounding: f64,
    pub x: f64,
    pub y: f64,
    pub mirror: bool,
}

pub const MIN_SIZE: f64 = 0.05;
pub const MAX_SIZE: f64 = 0.6;

impl Default for Layout {
    /// A circle a fifth of the shorter side across, near the bottom-right corner.
    fn default() -> Self {
        Self { width: 0.2, height: 0.2, rounding: 1.0, x: 0.97, y: 0.95, mirror: false }
    }
}

impl Layout {
    /// The same layout with every value inside its range; a value that is not a number takes the default's.
    pub fn clamped(self) -> Self {
        let d = Self::default();
        let pick = |value: f64, fallback: f64, min: f64, max: f64| if value.is_finite() { value.clamp(min, max) } else { fallback };
        Self {
            width: pick(self.width, d.width, MIN_SIZE, MAX_SIZE),
            height: pick(self.height, d.height, MIN_SIZE, MAX_SIZE),
            rounding: pick(self.rounding, d.rounding, 0.0, 1.0),
            x: pick(self.x, d.x, 0.0, 1.0),
            y: pick(self.y, d.y, 0.0, 1.0),
            mirror: self.mirror,
        }
    }

    /// The bubble in a `frame_width` × `frame_height` frame, whole pixels, inside the frame.
    pub fn bubble(&self, frame_width: u32, frame_height: u32) -> Rect {
        let layout = self.clamped();
        let (fw, fh) = (f64::from(frame_width), f64::from(frame_height));
        let shorter = fw.min(fh);
        let width = (layout.width * shorter).round().clamp(1.0, fw);
        let height = (layout.height * shorter).round().clamp(1.0, fh);
        let x = ((fw - width) * layout.x).round();
        let y = ((fh - height) * layout.y).round();
        Rect { x, y, width, height }
    }

    /// The corner radius of `bubble`, in its pixels: a circular arc (D2), at most half its shorter side.
    pub fn radius(&self, bubble: &Rect) -> f64 {
        self.clamped().rounding * bubble.width.min(bubble.height) / 2.0
    }
}

/// Whether the pixel centre (`px`, `py`) is inside `bubble` with corners of `radius` (D2's formula).
pub fn inside(bubble: &Rect, radius: f64, px: f64, py: f64) -> bool {
    let (left, top, right, bottom) = (bubble.x, bubble.y, bubble.x + bubble.width, bubble.y + bubble.height);
    if px < left || px >= right || py < top || py >= bottom {
        return false;
    }
    let r = radius.min(bubble.width / 2.0).min(bubble.height / 2.0).max(0.0);
    // The nearest point of the inner rectangle the corners' centres span.
    let cx = px.clamp(left + r, right - r);
    let cy = py.clamp(top + r, bottom - r);
    let (dx, dy) = (px - cx, py - cy);
    dx * dx + dy * dy <= r * r
}

/// The part of a `camera_width` × `camera_height` picture that fills a bubble of `width` × `height`: the largest
/// centred crop of the bubble's shape, so the camera is scaled to cover it without distortion.
pub fn camera_crop(camera_width: u32, camera_height: u32, width: f64, height: f64) -> Rect {
    let (cw, ch) = (f64::from(camera_width), f64::from(camera_height));
    if cw <= 0.0 || ch <= 0.0 || width <= 0.0 || height <= 0.0 {
        return Rect { x: 0.0, y: 0.0, width: cw, height: ch };
    }
    let scale = (width / cw).max(height / ch);
    let (crop_width, crop_height) = (width / scale, height / scale);
    Rect { x: (cw - crop_width) / 2.0, y: (ch - crop_height) / 2.0, width: crop_width, height: crop_height }
}

/// The preview's size for a `width` × `height` output (D17's first option): `PREVIEW_WIDTH` wide, or the output's
/// own size when it is smaller, keeping its shape, both even for NV12.
pub fn preview_size(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (2, 2);
    }
    let target = PREVIEW_WIDTH.min(width);
    let scaled = (u64::from(height) * u64::from(target) / u64::from(width)) as u32;
    ((target & !1).max(2), (scaled & !1).max(2))
}

pub const PREVIEW_WIDTH: u32 = 640;
pub const PREVIEW_FPS: u32 = 15;

/// Step 2's development switch: whether the camera is composed, and how.
#[derive(Clone, Debug, PartialEq)]
pub struct CameraPrototype {
    pub layout: Layout,
    /// The camera's unique ID; absent is the system's default camera.
    pub device: Option<String>,
    /// Whether preview frames are made for a preview page.
    pub preview: bool,
}

pub const SWITCH: &str = "RECORDSTUFF_CAMERA_PROTOTYPE";

impl CameraPrototype {
    pub fn from_env() -> Option<Self> {
        Self::parse(&std::env::var(SWITCH).ok()?)
    }

    /// The switch's value; `None` when it is off. Unknown keys and unreadable values are ignored.
    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        if value.is_empty() || value == "0" || value.eq_ignore_ascii_case("off") {
            return None;
        }
        let mut prototype = Self { layout: Layout::default(), device: None, preview: true };
        if value == "1" || value.eq_ignore_ascii_case("on") {
            return Some(prototype);
        }
        for pair in value.split(',') {
            let Some((key, raw)) = pair.split_once('=') else { continue };
            let (key, raw) = (key.trim(), raw.trim());
            let number = raw.parse::<f64>().ok().filter(|n| n.is_finite());
            let layout = &mut prototype.layout;
            match (key, number) {
                ("width", Some(n)) => layout.width = n,
                ("height", Some(n)) => layout.height = n,
                ("rounding", Some(n)) => layout.rounding = n,
                ("x", Some(n)) => layout.x = n,
                ("y", Some(n)) => layout.y = n,
                ("mirror", Some(n)) => layout.mirror = n != 0.0,
                ("preview", Some(n)) => prototype.preview = n != 0.0,
                ("device", _) if !raw.is_empty() => prototype.device = Some(raw.to_owned()),
                _ => {}
            }
        }
        prototype.layout = prototype.layout.clamped();
        Some(prototype)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_bubble_is_a_circle_near_the_bottom_right() {
        let layout = Layout::default();
        let bubble = layout.bubble(1920, 1080);
        assert_eq!(bubble, Rect { x: 1653.0, y: 821.0, width: 216.0, height: 216.0 });
        assert_eq!(layout.radius(&bubble), 108.0);
        assert!(bubble.x + bubble.width <= 1920.0 && bubble.y + bubble.height <= 1080.0);
    }

    #[test]
    fn sizes_follow_the_shorter_side_and_stay_in_range() {
        let layout = Layout { width: 0.6, height: 0.3, ..Layout::default() };
        assert_eq!(layout.bubble(1080, 1920).width, 648.0);
        assert_eq!(layout.bubble(1080, 1920).height, 324.0);
        let tiny = Layout { width: 0.0, height: 9.0, ..Layout::default() };
        let bubble = tiny.bubble(1000, 800);
        assert_eq!((bubble.width, bubble.height), (40.0, 480.0));
    }

    #[test]
    fn positions_span_the_free_space() {
        let corner = |x, y| Layout { x, y, ..Layout::default() }.bubble(1000, 500);
        assert_eq!((corner(0.0, 0.0).x, corner(0.0, 0.0).y), (0.0, 0.0));
        assert_eq!((corner(1.0, 1.0).x, corner(1.0, 1.0).y), (900.0, 400.0));
        assert_eq!(corner(0.5, 0.5).x, 450.0);
    }

    #[test]
    fn rounding_zero_is_square_and_one_is_round() {
        let bubble = Rect { x: 0.0, y: 0.0, width: 100.0, height: 100.0 };
        assert!(inside(&bubble, 0.0, 0.5, 0.5));
        assert!(!inside(&bubble, 50.0, 0.5, 0.5));
        assert!(inside(&bubble, 50.0, 50.0, 0.5));
        let half = Layout { rounding: 0.5, ..Layout::default() };
        assert_eq!(half.radius(&bubble), 25.0);
        assert!(!inside(&bubble, 25.0, 2.0, 2.0));
        assert!(inside(&bubble, 25.0, 10.0, 10.0));
        assert!(!inside(&bubble, 25.0, 100.0, 50.0));
    }

    #[test]
    fn a_wide_bubble_rounds_to_its_shorter_side() {
        let layout = Layout { width: 0.4, height: 0.1, rounding: 1.0, ..Layout::default() };
        let bubble = layout.bubble(1000, 1000);
        assert_eq!(layout.radius(&bubble), 50.0);
        assert!(inside(&bubble, 50.0, bubble.x + 200.0, bubble.y + 1.0));
    }

    #[test]
    fn the_camera_covers_the_bubble_from_its_centre() {
        assert_eq!(camera_crop(1280, 720, 200.0, 200.0), Rect { x: 280.0, y: 0.0, width: 720.0, height: 720.0 });
        let tall = camera_crop(1280, 720, 100.0, 200.0);
        assert_eq!((tall.width, tall.height), (360.0, 720.0));
        let wide = camera_crop(1280, 720, 400.0, 100.0);
        assert_eq!((wide.x, wide.width, wide.height), (0.0, 1280.0, 320.0));
    }

    #[test]
    fn the_preview_is_small_and_even() {
        assert_eq!(preview_size(1920, 1080), (640, 360));
        assert_eq!(preview_size(3024, 1964), (640, 414));
        assert_eq!(preview_size(320, 241), (320, 240));
        assert_eq!(preview_size(0, 0), (2, 2));
    }

    #[test]
    fn the_switch_reads_its_pairs() {
        assert_eq!(CameraPrototype::parse(""), None);
        assert_eq!(CameraPrototype::parse("0"), None);
        assert_eq!(CameraPrototype::parse("off"), None);
        assert_eq!(CameraPrototype::parse("1"), Some(CameraPrototype { layout: Layout::default(), device: None, preview: true }));
        let parsed = CameraPrototype::parse("width=0.3, height=2, rounding=0.25, x=0, y=1, mirror=1, preview=0, device=ABC-1, junk, size=x").unwrap();
        assert_eq!(parsed.layout, Layout { width: 0.3, height: 0.6, rounding: 0.25, x: 0.0, y: 1.0, mirror: true });
        assert_eq!(parsed.device.as_deref(), Some("ABC-1"));
        assert!(!parsed.preview);
        assert_eq!(CameraPrototype::parse("rounding=nan").unwrap().layout.rounding, 1.0);
    }
}
