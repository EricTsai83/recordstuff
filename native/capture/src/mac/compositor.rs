//! Composing the camera into the recording's frames (plan 075, D15) with Core Image on the GPU, before VideoToolbox:
//! the screen's frame and the camera's newest one stay IOSurface-backed, the camera is cropped to the bubble's shape,
//! scaled, mirrored when asked and masked by a circular-arc rounded rectangle (D2, `CIRoundedRectangleGenerator`),
//! and the result is rendered into a pixel buffer from this compositor's pool, in the screen's 4:2:0 format with its
//! colour tags. A frame without a camera frame yet is the screen alone.
//!
//! The same picture, scaled down to `camera_layout::preview_size`, is the preview (D17's first option): rendered into
//! a small buffer and copied out as NV12 bytes for a page to draw.
//!
//! Step 2's prototype: Core Image rather than a Metal kernel of our own, so the gate measures the work with the fewest
//! moving parts; a Metal kernel is the next step if the graph Core Image builds per frame costs too much.

use std::ptr::{NonNull, null_mut};
use std::sync::{Arc, Mutex};

use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::AnyObject;
use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFString, CFType, CGAffineTransform, CGPoint, CGRect, CGSize};
use objc2_core_image::{CIColor, CIContext, CIContextOption, CIFilter, CIImage, CIVector, kCIContextCacheIntermediates, kCIContextWorkingColorSpace};
use objc2_core_video::{
    CVImageBuffer, CVPixelBuffer, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane, CVPixelBufferGetHeight,
    CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferPool, CVPixelBufferUnlockBaseAddress,
    kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey,
};
use objc2_foundation::{NSDictionary, NSNull, NSNumber, NSString};

use super::camera;
use crate::camera_layout::{self, Layout};

const PIXEL_FORMAT_420V: u32 = u32::from_be_bytes(*b"420v");

/// A preview frame: NV12, the luma plane then the interleaved chroma one, rows without padding.
pub struct PreviewFrame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// An IOSurface-backed pool of 4:2:0 buffers of one size.
struct Pool(CFRetained<CVPixelBufferPool>);
unsafe impl Send for Pool {}
unsafe impl Sync for Pool {}

impl Pool {
    fn new(width: u32, height: u32) -> Result<Self, String> {
        let surface = CFDictionary::<CFString, CFType>::from_slices(&[], &[]);
        let keys: [&CFString; 4] =
            unsafe { [kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey, kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey] };
        let (format, w, h) = (CFNumber::new_i64(i64::from(PIXEL_FORMAT_420V)), CFNumber::new_i64(i64::from(width)), CFNumber::new_i64(i64::from(height)));
        let values: [&CFType; 4] = [format.as_ref(), w.as_ref(), h.as_ref(), surface.as_ref()];
        let attributes = CFDictionary::<CFString, CFType>::from_slices(&keys, &values);
        let mut pool: *mut CVPixelBufferPool = null_mut();
        let status = unsafe { CVPixelBufferPool::create(None, None, Some(attributes.as_opaque()), NonNull::from(&mut pool)) };
        let pool = NonNull::new(pool).filter(|_| status == 0).ok_or_else(|| format!("a {width}x{height} buffer pool could not be made: {status}"))?;
        Ok(Self(unsafe { CFRetained::from_raw(pool) }))
    }

    fn buffer(&self) -> Result<CFRetained<CVPixelBuffer>, String> {
        let mut buffer: *mut CVPixelBuffer = null_mut();
        let status = unsafe { CVPixelBufferPool::create_pixel_buffer(None, &self.0, NonNull::from(&mut buffer)) };
        let buffer = NonNull::new(buffer).filter(|_| status == 0).ok_or_else(|| format!("no buffer from the pool: {status}"))?;
        Ok(unsafe { CFRetained::from_raw(buffer) })
    }
}

pub struct Compositor {
    context: Retained<CIContext>,
    pool: Pool,
    preview_pool: Pool,
    preview_size: (u32, u32),
    layout: Mutex<Layout>,
    camera: Arc<camera::Shared>,
}

// Core Image contexts are thread-safe; images are made per call.
unsafe impl Send for Compositor {}
unsafe impl Sync for Compositor {}

fn rect(x: f64, y: f64, width: f64, height: f64) -> CGRect {
    CGRect { origin: CGPoint { x, y }, size: CGSize { width, height } }
}

fn filter(name: &str, keys: &[&str], values: &[&AnyObject]) -> Result<Retained<CIImage>, String> {
    let keys: Vec<Retained<NSString>> = keys.iter().map(|key| NSString::from_str(key)).collect();
    let keys: Vec<&NSString> = keys.iter().map(|key| &**key).collect();
    let parameters = NSDictionary::<NSString, AnyObject>::from_slices(&keys, values);
    let filter = unsafe { CIFilter::filterWithName_withInputParameters(&NSString::from_str(name), Some(&parameters)) }
        .ok_or_else(|| format!("Core Image has no {name}"))?;
    unsafe { filter.outputImage() }.ok_or_else(|| format!("{name} made no image"))
}

impl Compositor {
    /// A compositor for `width` × `height` frames, taking the camera's newest frame from `camera`.
    pub fn new(width: u32, height: u32, layout: Layout, camera: Arc<camera::Shared>) -> Result<Self, String> {
        // No colour management: the screen and the camera are both BT.709-ish 4:2:0 and the output keeps the screen's
        // tags; converting through a linear working space would cost GPU time for no visible gain in a bubble.
        let options = unsafe {
            let keys: [&CIContextOption; 2] = [kCIContextWorkingColorSpace, kCIContextCacheIntermediates];
            let null = NSNull::null();
            let no = NSNumber::new_bool(false);
            let values: [&AnyObject; 2] = [&null, &no];
            NSDictionary::<CIContextOption, AnyObject>::from_slices(&keys, &values)
        };
        let context = unsafe { CIContext::contextWithOptions(Some(&options)) };
        let preview_size = camera_layout::preview_size(width, height);
        Ok(Self {
            context,
            pool: Pool::new(width, height)?,
            preview_pool: Pool::new(preview_size.0, preview_size.1)?,
            preview_size,
            layout: Mutex::new(layout.clamped()),
            camera,
        })
    }

    pub fn layout(&self) -> Layout {
        *self.layout.lock().unwrap()
    }

    /// The screen with the camera's newest frame in its bubble, in Core Image's coordinates (origin bottom-left).
    fn picture(&self, screen: &CVImageBuffer) -> Result<Retained<CIImage>, String> {
        let screen_image = unsafe { CIImage::imageWithCVImageBuffer(screen) };
        let Some((camera, _)) = self.camera.latest() else { return Ok(screen_image) };
        let (width, height) = (CVPixelBufferGetWidth(screen) as u32, CVPixelBufferGetHeight(screen) as u32);
        let layout = self.layout();
        let bubble = layout.bubble(width, height);
        let radius = layout.radius(&bubble);
        let (camera_width, camera_height) = (CVPixelBufferGetWidth(&camera) as u32, CVPixelBufferGetHeight(&camera) as u32);
        let crop = camera_layout::camera_crop(camera_width, camera_height, bubble.width, bubble.height);

        // Layout rectangles are measured from the top; Core Image's from the bottom.
        let crop_y = f64::from(camera_height) - (crop.y + crop.height);
        let bubble_y = f64::from(height) - (bubble.y + bubble.height);
        let scale = bubble.width / crop.width;
        let sx = if layout.mirror { -scale } else { scale };
        let tx = if layout.mirror { bubble.x + bubble.width } else { bubble.x } - sx * crop.x;
        let transform = CGAffineTransform { a: sx, b: 0.0, c: 0.0, d: scale, tx, ty: bubble_y - scale * crop_y };
        let camera_image = unsafe {
            CIImage::imageWithCVImageBuffer(&camera).imageByCroppingToRect(rect(crop.x, crop_y, crop.width, crop.height)).imageByApplyingTransform(transform)
        };

        let extent = unsafe { CIVector::vectorWithCGRect(rect(bubble.x, bubble_y, bubble.width, bubble.height)) };
        let radius = NSNumber::new_f64(radius);
        let white = unsafe { CIColor::colorWithRed_green_blue_alpha(1.0, 1.0, 1.0, 1.0) };
        let mask = filter("CIRoundedRectangleGenerator", &["inputExtent", "inputRadius", "inputColor"], &[&extent, &radius, &white])?;
        filter("CIBlendWithMask", &["inputImage", "inputBackgroundImage", "inputMaskImage"], &[&camera_image, &screen_image, &mask])
    }

    /// The frame to encode in place of `screen`. Each call drains its own autorelease pool: it runs on the engine's
    /// threads, which have none, so Core Image's autoreleased objects would otherwise last until the thread ends.
    pub fn compose(&self, screen: &CVImageBuffer) -> Result<CFRetained<CVPixelBuffer>, String> {
        autoreleasepool(|_| {
            let picture = self.picture(screen)?;
            let output = self.pool.buffer()?;
            screen.propagate_attachments(&output);
            unsafe { self.context.render_toCVPixelBuffer(&picture, &output) };
            Ok(output)
        })
    }

    /// The composed picture of `screen` at preview size, as NV12 bytes, in an autorelease pool of its own too.
    pub fn preview(&self, screen: &CVImageBuffer) -> Result<PreviewFrame, String> {
        autoreleasepool(|_| self.small(screen))
    }

    fn small(&self, screen: &CVImageBuffer) -> Result<PreviewFrame, String> {
        let picture = self.picture(screen)?;
        let (width, height) = self.preview_size;
        let scale = f64::from(width) / CVPixelBufferGetWidth(screen).max(1) as f64;
        let small = unsafe { picture.imageByApplyingTransform(CGAffineTransform { a: scale, b: 0.0, c: 0.0, d: scale, tx: 0.0, ty: 0.0 }) };
        let output = self.preview_pool.buffer()?;
        screen.propagate_attachments(&output);
        unsafe { self.context.render_toCVPixelBuffer(&small, &output) };
        Ok(PreviewFrame { width, height, data: nv12_bytes(&output, width as usize, height as usize)? })
    }
}

/// Reads a 4:2:0 buffer's planes into contiguous NV12 bytes.
fn nv12_bytes(buffer: &CVPixelBuffer, width: usize, height: usize) -> Result<Vec<u8>, String> {
    let read_only = CVPixelBufferLockFlags(1);
    let status = unsafe { CVPixelBufferLockBaseAddress(buffer, read_only) };
    if status != 0 {
        return Err(format!("the preview buffer could not be read: {status}"));
    }
    let mut data = Vec::with_capacity(width * height * 3 / 2);
    for (plane, rows) in [(0, height), (1, height / 2)] {
        let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane).cast::<u8>();
        let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane);
        if base.is_null() || stride < width {
            unsafe { CVPixelBufferUnlockBaseAddress(buffer, read_only) };
            return Err("the preview buffer has no readable plane".into());
        }
        for row in 0..rows {
            data.extend_from_slice(unsafe { std::slice::from_raw_parts(base.add(row * stride), width) });
        }
    }
    unsafe { CVPixelBufferUnlockBaseAddress(buffer, read_only) };
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `width` × `height` 4:2:0 buffer whose luma is `luma(x, y)`, chroma neutral.
    fn buffer(width: u32, height: u32, luma: impl Fn(usize, usize) -> u8) -> CFRetained<CVPixelBuffer> {
        let buffer = Pool::new(width, height).unwrap().buffer().unwrap();
        unsafe { CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
        for (plane, rows) in [(0, height as usize), (1, height as usize / 2)] {
            let base = CVPixelBufferGetBaseAddressOfPlane(&buffer, plane).cast::<u8>();
            let stride = CVPixelBufferGetBytesPerRowOfPlane(&buffer, plane);
            for y in 0..rows {
                let line = unsafe { std::slice::from_raw_parts_mut(base.add(y * stride), width as usize) };
                for (x, value) in line.iter_mut().enumerate() {
                    *value = if plane == 1 { 128 } else { luma(x, y) };
                }
            }
        }
        unsafe { CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
        buffer
    }

    fn luma(buffer: &CVPixelBuffer, x: usize, y: usize) -> u8 {
        let width = CVPixelBufferGetWidth(buffer);
        nv12_bytes(buffer, width, CVPixelBufferGetHeight(buffer)).unwrap()[y * width + x]
    }

    const DARK: u8 = 40;
    const BRIGHT: u8 = 220;
    const W: u32 = 320;
    const H: u32 = 180;

    fn compositor(layout: Layout) -> (Compositor, Arc<camera::Shared>) {
        let camera = Arc::new(camera::Shared::default());
        (Compositor::new(W, H, layout, camera.clone()).unwrap(), camera)
    }

    fn near(value: u8, expected: u8) -> bool {
        value.abs_diff(expected) <= 12
    }

    #[test]
    fn without_a_camera_frame_the_screen_is_unchanged() {
        let (compositor, _) = compositor(Layout::default());
        let screen = buffer(W, H, |x, _| if x < 160 { DARK } else { BRIGHT });
        let out = compositor.compose(&screen).unwrap();
        assert!(near(luma(&out, 10, 10), DARK) && near(luma(&out, 300, 170), BRIGHT));
    }

    #[test]
    fn the_camera_fills_its_rounded_bubble_and_nothing_else() {
        let layout = Layout { width: 0.5, height: 0.5, rounding: 1.0, x: 0.5, y: 0.5, mirror: false };
        let (compositor, camera) = compositor(layout);
        camera.deliver(buffer(128, 72, |_, _| BRIGHT), 1);
        let screen = buffer(W, H, |_, _| DARK);
        let out = compositor.compose(&screen).unwrap();
        let bubble = layout.bubble(W, H);
        let (cx, cy) = ((bubble.x + bubble.width / 2.0) as usize, (bubble.y + bubble.height / 2.0) as usize);
        assert!(near(luma(&out, cx, cy), BRIGHT), "centre {}", luma(&out, cx, cy));
        // Inside the bubble's square but outside its circle: the screen.
        assert!(near(luma(&out, bubble.x as usize + 2, bubble.y as usize + 2), DARK), "corner {}", luma(&out, bubble.x as usize + 2, bubble.y as usize + 2));
        assert!(near(luma(&out, 5, 5), DARK));
        // Top and bottom of the circle are inside, so rows are measured from the top, as the layout's are.
        assert!(near(luma(&out, cx, bubble.y as usize + 4), BRIGHT));
        assert!(near(luma(&out, cx, (bubble.y + bubble.height) as usize - 4), BRIGHT));
    }

    #[test]
    fn a_square_bubble_at_the_top_left_is_at_the_top_left() {
        let layout = Layout { width: 0.3, height: 0.3, rounding: 0.0, x: 0.0, y: 0.0, mirror: false };
        let (compositor, camera) = compositor(layout);
        camera.deliver(buffer(128, 72, |_, _| BRIGHT), 1);
        let out = compositor.compose(&buffer(W, H, |_, _| DARK)).unwrap();
        assert!(near(luma(&out, 1, 1), BRIGHT), "{}", luma(&out, 1, 1));
        assert!(near(luma(&out, 1, 178), DARK));
        assert!(near(luma(&out, 318, 1), DARK));
    }

    #[test]
    fn mirroring_flips_the_camera_left_to_right() {
        let camera_picture = || buffer(128, 72, |x, _| if x < 64 { BRIGHT } else { DARK });
        let layout = Layout { width: 0.5, height: 0.5, rounding: 0.0, x: 0.5, y: 0.5, mirror: false };
        let bubble = layout.bubble(W, H);
        let (left, right, y) = (bubble.x as usize + 10, (bubble.x + bubble.width) as usize - 10, (bubble.y + bubble.height / 2.0) as usize);
        for mirror in [false, true] {
            let (compositor, camera) = compositor(Layout { mirror, ..layout });
            camera.deliver(camera_picture(), 1);
            let out = compositor.compose(&buffer(W, H, |_, _| 128)).unwrap();
            let (l, r) = (luma(&out, left, y), luma(&out, right, y));
            if mirror {
                assert!(near(l, DARK) && near(r, BRIGHT), "mirrored: {l} {r}");
            } else {
                assert!(near(l, BRIGHT) && near(r, DARK), "plain: {l} {r}");
            }
        }
    }

    #[test]
    fn the_preview_is_the_composed_picture_scaled_down() {
        let layout = Layout { width: 0.3, height: 0.3, rounding: 0.0, x: 1.0, y: 1.0, mirror: false };
        let camera = Arc::new(camera::Shared::default());
        let compositor = Compositor::new(1280, 720, layout, camera.clone()).unwrap();
        camera.deliver(buffer(128, 72, |_, _| BRIGHT), 1);
        let preview = compositor.preview(&buffer(1280, 720, |_, _| DARK)).unwrap();
        assert_eq!((preview.width, preview.height), (640, 360));
        assert_eq!(preview.data.len(), 640 * 360 * 3 / 2);
        let at = |x: usize, y: usize| preview.data[y * 640 + x];
        assert!(near(at(630, 350), BRIGHT), "{}", at(630, 350));
        assert!(near(at(10, 10), DARK));
        assert!(preview.data[640 * 360..].iter().all(|&c| c.abs_diff(128) <= 4));
    }
}
