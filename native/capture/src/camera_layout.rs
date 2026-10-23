//! The camera bubble's geometry (plan 075): where the camera goes in an output frame, how its corners are rounded and
//! how the camera's own picture fills it. Pure, so the compositor and its tests come from one formula (D2), the one the
//! Settings preview draws with too (src/shared/camera-layout.ts): both are checked against the same cases
//! (src/shared/camera-layout.cases.json).
//!
//! Step 2's prototype took its layout from the development switch `RECORDSTUFF_CAMERA_PROTOTYPE` (`CameraPrototype`),
//! whose grammar is kept for tests; since step 5 the engine composes the camera only at main's request (the Camera
//! setting), and main reads the switch for whether the Camera row is available and preview frames are made. The switch:
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
    /// A portrait 3:4 rectangle with slightly rounded corners near the top-right corner, as `DEFAULT_CAMERA_LAYOUT`.
    fn default() -> Self {
        Self { width: 0.21, height: 0.28, rounding: 0.15, x: 0.97, y: 0.05, mirror: false }
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

/// The compositor's kernels' parameters, laid out as `Params` in shaders/compose.wgsl, which every platform's compositor
/// passes as they are (64 bytes: Direct3D 11's constant buffers come in 16-byte rows).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ComposeParams {
    pub out_size: [f32; 2],
    pub bubble_origin: [f32; 2],
    pub bubble_size: [f32; 2],
    pub crop_origin: [f32; 2],
    pub crop_size: [f32; 2],
    pub radius: f32,
    pub mirror: f32,
    pub camera_on: f32,
    pub camera_601: f32,
    _padding: [f32; 2],
}

/// A camera frame as the compositor reads it: its size, and whether its YCbCr is BT.601's.
#[derive(Clone, Copy, Debug)]
pub struct CameraImage {
    pub width: u32,
    pub height: u32,
    pub bt601: bool,
}

/// The parameters for an output of `out` pixels from a `size` frame, the bubble placed as on the full-size frame; no
/// camera frame composes the screen alone.
pub fn compose_params(layout: &Layout, size: (u32, u32), out: (u32, u32), camera: Option<CameraImage>) -> ComposeParams {
    let full = layout.bubble(size.0, size.1);
    let (sx, sy) = (f64::from(out.0) / f64::from(size.0), f64::from(out.1) / f64::from(size.1));
    let bubble = Rect { x: full.x * sx, y: full.y * sy, width: full.width * sx, height: full.height * sy };
    let mut params = ComposeParams {
        out_size: [out.0 as f32, out.1 as f32],
        bubble_origin: [bubble.x as f32, bubble.y as f32],
        bubble_size: [bubble.width as f32, bubble.height as f32],
        radius: (layout.radius(&full) * sx.min(sy)) as f32,
        mirror: if layout.mirror { 1.0 } else { 0.0 },
        ..ComposeParams::default()
    };
    if let Some(camera) = camera {
        let (cw, ch) = (camera.width, camera.height);
        let crop = camera_crop(cw, ch, full.width, full.height);
        params.crop_origin = [(crop.x / f64::from(cw)) as f32, (crop.y / f64::from(ch)) as f32];
        params.crop_size = [(crop.width / f64::from(cw)) as f32, (crop.height / f64::from(ch)) as f32];
        params.camera_on = 1.0;
        params.camera_601 = if camera.bt601 { 1.0 } else { 0.0 };
    }
    params
}

pub const PREVIEW_WIDTH: u32 = 640;
/// The preview's rate at a session's start, until the Studio's page says its own (plan 092, D1): 10 a second, Standard.
pub const PREVIEW_FPS: u32 = 10;
/// The rates the Recording Studio offers (plan 092, D1): Power saving's 5 while only looked at, 10 (Standard, and Power
/// saving while worked in) and Smooth's 15.
pub const PREVIEW_RATES: [u32; 3] = [5, 10, 15];
/// The rate the preview's encoder is configured for: the highest offered, so its rate control never assumes fewer
/// frames than it is given (it times its bits by the frames' timestamps on macOS).
pub const PREVIEW_ENCODER_FPS: u32 = 15;

/// `fps` when the Studio offers it, else none.
pub fn preview_rate(fps: u32) -> Option<u32> {
    PREVIEW_RATES.contains(&fps).then_some(fps)
}

/// What the preview shows (plan 092, D3): the composed picture, or the screen without the camera. Only the preview:
/// the recording is always the composed picture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewView {
    Composed,
    Screen,
}

impl PreviewView {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "composed" => Some(Self::Composed),
            "screen" => Some(Self::Screen),
            _ => None,
        }
    }

    /// Whether the camera is drawn in this view's preview.
    pub fn shows_camera(self) -> bool {
        self == Self::Composed
    }
}

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
    fn the_default_bubble_is_a_rounded_portrait_rectangle_near_the_top_right() {
        let layout = Layout::default();
        let bubble = layout.bubble(1920, 1080);
        assert_eq!(bubble, Rect { x: 1642.0, y: 39.0, width: 227.0, height: 302.0 });
        assert!((layout.radius(&bubble) - 17.025).abs() < 1e-9);
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
        let corner = |x, y| Layout { x, y, width: 0.2, height: 0.2, ..Layout::default() }.bubble(1000, 500);
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
    fn the_preview_takes_only_the_studio_s_rates_and_views() {
        assert_eq!(PREVIEW_RATES.map(preview_rate), [Some(5), Some(10), Some(15)]);
        assert_eq!([0, 1, 7, 30, 60].map(preview_rate), [None; 5]);
        assert!(PREVIEW_RATES.contains(&PREVIEW_FPS) && PREVIEW_RATES.iter().all(|&fps| fps <= PREVIEW_ENCODER_FPS));
        assert_eq!(PreviewView::parse("composed"), Some(PreviewView::Composed));
        assert_eq!(PreviewView::parse("screen"), Some(PreviewView::Screen));
        assert_eq!(PreviewView::parse("camera"), None);
        assert!(PreviewView::Composed.shows_camera() && !PreviewView::Screen.shows_camera());
    }

    #[test]
    fn the_preview_is_small_and_even() {
        assert_eq!(preview_size(1920, 1080), (640, 360));
        assert_eq!(preview_size(3024, 1964), (640, 414));
        assert_eq!(preview_size(320, 241), (320, 240));
        assert_eq!(preview_size(0, 0), (2, 2));
    }

    /// The cases the TypeScript layout (src/shared/camera-layout.ts) is checked against too: the Settings preview and
    /// the recording place the bubble alike.
    #[test]
    fn the_cases_shared_with_the_settings_preview_agree() {
        let cases: serde_json::Value = serde_json::from_str(include_str!("../../../src/shared/camera-layout.cases.json")).unwrap();
        let number = |value: &serde_json::Value| value.as_f64().unwrap();
        let mut checked = 0;
        for case in cases["cases"].as_array().unwrap() {
            let l = &case["layout"];
            let p = &case["position"];
            let layout = Layout {
                width: number(&l["width"]),
                height: number(&l["height"]),
                rounding: number(&l["rounding"]),
                x: number(&p["x"]),
                y: number(&p["y"]),
                mirror: l["mirror"].as_bool().unwrap(),
            };
            let (w, h) = (case["frame"][0].as_u64().unwrap() as u32, case["frame"][1].as_u64().unwrap() as u32);
            let bubble = layout.bubble(w, h);
            let r = &case["rect"];
            let expected = Rect { x: number(&r["x"]), y: number(&r["y"]), width: number(&r["width"]), height: number(&r["height"]) };
            assert_eq!(bubble, expected, "{} at {p} in {w}x{h}", case["name"]);
            assert!((layout.radius(&bubble) - number(&case["radius"])).abs() < 1e-9, "{} radius", case["name"]);
            checked += 1;
        }
        assert!(checked > 100);
        for preview in cases["previews"].as_array().unwrap() {
            let (w, h) = (preview["frame"][0].as_u64().unwrap() as u32, preview["frame"][1].as_u64().unwrap() as u32);
            let expected = (preview["preview"]["width"].as_u64().unwrap() as u32, preview["preview"]["height"].as_u64().unwrap() as u32);
            assert_eq!(preview_size(w, h), expected, "preview of {w}x{h}");
        }
        for crop in cases["crops"].as_array().unwrap() {
            let c = &crop["camera"];
            let b = &crop["bubble"];
            let got = camera_crop(c[0].as_u64().unwrap() as u32, c[1].as_u64().unwrap() as u32, number(&b[0]), number(&b[1]));
            let e = &crop["crop"];
            for (got, want) in [(got.x, &e["x"]), (got.y, &e["y"]), (got.width, &e["width"]), (got.height, &e["height"])] {
                assert!((got - number(want)).abs() < 1e-9, "crop {crop}");
            }
        }
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
        assert_eq!(CameraPrototype::parse("rounding=nan").unwrap().layout.rounding, Layout::default().rounding);
    }
}
