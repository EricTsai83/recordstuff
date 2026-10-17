//! Composing the camera into the recording's frames (plan 075, D15) on the GPU with Metal, before VideoToolbox: the
//! screen's frame, the camera's newest one and the output stay IOSurface-backed and are read and written in place as
//! Metal textures of their 4:2:0 planes (`CVMetalTextureCache`, no copy). The kernels are `shaders/compose.wgsl`'s,
//! which build.rs translates to MSL (and to HLSL for Windows), so the bubble's rounding, crop and mirror are one formula
//! on every platform (D2): `luma` writes the output's Y plane and `chroma` its CbCr plane, in one command buffer.
//!
//! The same kernels at preview size make the preview's picture (D17), which the preview encoder takes as it is.
//!
//! Step 2's second compositor: the first, with Core Image, rebuilt a filter graph on the CPU for every frame and cost
//! about 10 points of a core at 30 fps (2026-10-17).

use std::ffi::c_void;
use std::ptr::{NonNull, null_mut};
use std::sync::{Arc, Mutex};

use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::ProtocolObject;
use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_video::{
    CVImageBuffer, CVMetalTexture, CVMetalTextureCache, CVMetalTextureGetTexture, CVPixelBuffer, CVPixelBufferGetHeight,
    CVPixelBufferGetHeightOfPlane, CVPixelBufferGetWidth, CVPixelBufferGetWidthOfPlane, CVPixelBufferPool,
    kCVImageBufferYCbCrMatrix_ITU_R_601_4, kCVImageBufferYCbCrMatrixKey, kCVMetalTextureUsage, kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferPixelFormatTypeKey,
    kCVPixelBufferWidthKey,
};
use objc2_foundation::NSString;
use objc2_metal::{
    MTLCommandBuffer, MTLCommandBufferStatus, MTLCommandEncoder, MTLCommandQueue, MTLComputeCommandEncoder, MTLComputePipelineState,
    MTLCreateSystemDefaultDevice, MTLDevice, MTLLibrary, MTLPixelFormat, MTLSize, MTLTexture, MTLTextureUsage,
};

use super::camera;
use crate::camera_layout::{self, Layout, Rect};

mod names {
    include!(concat!(env!("OUT_DIR"), "/compose_names.rs"));
}

const PIXEL_FORMAT_420V: u32 = u32::from_be_bytes(*b"420v");
const SHADER: &str = include_str!(concat!(env!("OUT_DIR"), "/compose.metal"));

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

/// The kernels' parameters, laid out as `Params` in shaders/compose.wgsl.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct Params {
    out_size: [f32; 2],
    bubble_origin: [f32; 2],
    bubble_size: [f32; 2],
    crop_origin: [f32; 2],
    crop_size: [f32; 2],
    radius: f32,
    mirror: f32,
    camera_on: f32,
    camera_601: f32,
}

/// A plane of a pixel buffer as a Metal texture; the texture lasts while the CVMetalTexture does.
struct Plane {
    _owner: CFRetained<CVMetalTexture>,
    texture: Retained<ProtocolObject<dyn MTLTexture>>,
}

/// The device, the queue, both kernels and the texture cache.
struct Gpu {
    queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    luma: Retained<ProtocolObject<dyn MTLComputePipelineState>>,
    chroma: Retained<ProtocolObject<dyn MTLComputePipelineState>>,
    cache: CFRetained<CVMetalTextureCache>,
}

impl Gpu {
    fn new() -> Result<Self, String> {
        let device = MTLCreateSystemDefaultDevice().ok_or("no Metal device")?;
        let queue = device.newCommandQueue().ok_or("no Metal command queue")?;
        let library = device
            .newLibraryWithSource_options_error(&NSString::from_str(SHADER), None)
            .map_err(|e| format!("the compositor's shader did not compile: {}", super::content::describe(&e)))?;
        let pipeline = |name: &str| {
            let function = library.newFunctionWithName(&NSString::from_str(name)).ok_or_else(|| format!("the shader has no {name}"))?;
            device
                .newComputePipelineStateWithFunction_error(&function)
                .map_err(|e| format!("{name} could not be prepared: {}", super::content::describe(&e)))
        };
        let (luma, chroma) = (pipeline(names::MSL_LUMA)?, pipeline(names::MSL_CHROMA)?);
        // The output's planes are written, the inputs' read.
        let usage = CFNumber::new_i64((MTLTextureUsage::ShaderRead | MTLTextureUsage::ShaderWrite).0 as i64);
        let key: &CFString = unsafe { kCVMetalTextureUsage };
        let attributes = CFDictionary::<CFString, CFType>::from_slices(&[key], &[usage.as_ref()]);
        let mut cache: *mut CVMetalTextureCache = null_mut();
        let status = unsafe { CVMetalTextureCache::create(None, None, &device, Some(attributes.as_opaque()), NonNull::from(&mut cache)) };
        let cache = NonNull::new(cache).filter(|_| status == 0).ok_or_else(|| format!("no Metal texture cache: {status}"))?;
        Ok(Self { queue, luma, chroma, cache: unsafe { CFRetained::from_raw(cache) } })
    }

    fn plane(&self, buffer: &CVImageBuffer, plane: usize, format: MTLPixelFormat) -> Result<Plane, String> {
        let (width, height) = (CVPixelBufferGetWidthOfPlane(buffer, plane), CVPixelBufferGetHeightOfPlane(buffer, plane));
        let mut texture: *mut CVMetalTexture = null_mut();
        let status = unsafe {
            CVMetalTextureCache::create_texture_from_image(None, &self.cache, buffer, None, format, width, height, plane, NonNull::from(&mut texture))
        };
        let owner = NonNull::new(texture).filter(|_| status == 0).ok_or_else(|| format!("plane {plane} is no Metal texture: {status}"))?;
        let owner = unsafe { CFRetained::from_raw(owner) };
        let texture = CVMetalTextureGetTexture(&owner).ok_or_else(|| format!("plane {plane} has no Metal texture"))?;
        Ok(Plane { _owner: owner, texture })
    }

    /// Runs both kernels: `output` gets `screen` with `camera` in its bubble, and the call returns once the GPU is done.
    fn compose(&self, screen: &CVImageBuffer, camera: Option<&CVImageBuffer>, output: &CVPixelBuffer, params: &Params) -> Result<(), String> {
        let (screen_y, screen_uv) = (self.plane(screen, 0, MTLPixelFormat::R8Unorm)?, self.plane(screen, 1, MTLPixelFormat::RG8Unorm)?);
        // Without a camera frame the kernels read the screen in its place and cover nothing with it.
        let camera = camera.unwrap_or(screen);
        let (camera_y, camera_uv) = (self.plane(camera, 0, MTLPixelFormat::R8Unorm)?, self.plane(camera, 1, MTLPixelFormat::RG8Unorm)?);
        let (out_y, out_uv) = (self.plane(output, 0, MTLPixelFormat::R8Unorm)?, self.plane(output, 1, MTLPixelFormat::RG8Unorm)?);
        let commands = self.queue.commandBuffer().ok_or("no Metal command buffer")?;
        let encoder = commands.computeCommandEncoder().ok_or("no Metal compute encoder")?;
        for (pipeline, screen, camera, out) in [(&self.luma, &screen_y, &camera_y, &out_y), (&self.chroma, &screen_uv, &camera_uv, &out_uv)] {
            encoder.setComputePipelineState(pipeline);
            unsafe {
                encoder.setBytes_length_atIndex(NonNull::from(params).cast::<c_void>(), size_of::<Params>(), 0);
                encoder.setTexture_atIndex(Some(&screen.texture), 0);
                encoder.setTexture_atIndex(Some(&camera.texture), 1);
                encoder.setTexture_atIndex(Some(&out.texture), 2);
                // `luma` converts a BT.601 camera with its chroma; `chroma` ignores the slot.
                encoder.setTexture_atIndex(Some(&camera_uv.texture), 3);
            }
            let grid = MTLSize { width: out.texture.width(), height: out.texture.height(), depth: 1 };
            encoder.dispatchThreads_threadsPerThreadgroup(grid, MTLSize { width: 16, height: 16, depth: 1 });
        }
        encoder.endEncoding();
        commands.commit();
        commands.waitUntilCompleted();
        self.cache.flush(0);
        if commands.status() == MTLCommandBufferStatus::Error {
            return Err(format!("composing failed on the GPU: {}", commands.error().map(|e| super::content::describe(&e)).unwrap_or_default()));
        }
        Ok(())
    }
}

/// Whether a frame says its YCbCr is BT.601's; anything else is taken as the output's BT.709.
fn is_601(image: &CVImageBuffer) -> bool {
    let key: &CFString = unsafe { kCVImageBufferYCbCrMatrixKey };
    let Some(value) = (unsafe { image.attachment(key, null_mut()) }) else { return false };
    value.downcast_ref::<CFString>().is_some_and(|matrix| matrix == unsafe { kCVImageBufferYCbCrMatrix_ITU_R_601_4 })
}

pub struct Compositor {
    gpu: Gpu,
    pool: Pool,
    preview_pool: Pool,
    size: (u32, u32),
    preview_size: (u32, u32),
    layout: Mutex<Layout>,
    camera: Arc<camera::Shared>,
}

// Metal's device, queue and pipeline states are thread-safe; command buffers are made per call.
unsafe impl Send for Compositor {}
unsafe impl Sync for Compositor {}

impl Compositor {
    /// A compositor for `width` × `height` frames, taking the camera's newest frame from `camera`.
    pub fn new(width: u32, height: u32, layout: Layout, camera: Arc<camera::Shared>) -> Result<Self, String> {
        let preview_size = camera_layout::preview_size(width, height);
        Ok(Self {
            gpu: Gpu::new()?,
            pool: Pool::new(width, height)?,
            preview_pool: Pool::new(preview_size.0, preview_size.1)?,
            size: (width, height),
            preview_size,
            layout: Mutex::new(layout.clamped()),
            camera,
        })
    }

    pub fn layout(&self) -> Layout {
        *self.layout.lock().unwrap()
    }

    pub fn preview_size(&self) -> (u32, u32) {
        self.preview_size
    }

    /// The kernels' parameters for an output of `out` pixels, the bubble placed as on the full-size frame.
    fn params(&self, out: (u32, u32), camera: Option<&CVImageBuffer>) -> Params {
        let layout = self.layout();
        let full = layout.bubble(self.size.0, self.size.1);
        let (sx, sy) = (f64::from(out.0) / f64::from(self.size.0), f64::from(out.1) / f64::from(self.size.1));
        let bubble = Rect { x: full.x * sx, y: full.y * sy, width: full.width * sx, height: full.height * sy };
        let mut params = Params {
            out_size: [out.0 as f32, out.1 as f32],
            bubble_origin: [bubble.x as f32, bubble.y as f32],
            bubble_size: [bubble.width as f32, bubble.height as f32],
            radius: (layout.radius(&full) * sx.min(sy)) as f32,
            mirror: if layout.mirror { 1.0 } else { 0.0 },
            ..Params::default()
        };
        if let Some(camera) = camera {
            let (cw, ch) = (CVPixelBufferGetWidth(camera) as u32, CVPixelBufferGetHeight(camera) as u32);
            let crop = camera_layout::camera_crop(cw, ch, full.width, full.height);
            params.crop_origin = [(crop.x / f64::from(cw)) as f32, (crop.y / f64::from(ch)) as f32];
            params.crop_size = [(crop.width / f64::from(cw)) as f32, (crop.height / f64::from(ch)) as f32];
            params.camera_on = 1.0;
            params.camera_601 = if is_601(camera) { 1.0 } else { 0.0 };
        }
        params
    }

    fn render(&self, screen: &CVImageBuffer, pool: &Pool, out: (u32, u32)) -> Result<CFRetained<CVPixelBuffer>, String> {
        autoreleasepool(|_| {
            let camera = self.camera.latest().map(|(image, _)| image);
            let output = pool.buffer()?;
            screen.propagate_attachments(&output);
            self.gpu.compose(screen, camera.as_deref(), &output, &self.params(out, camera.as_deref()))?;
            Ok(output)
        })
    }

    /// The frame to encode in place of `screen`. Each call drains its own autorelease pool: it runs on the engine's
    /// threads, which have none.
    pub fn compose(&self, screen: &CVImageBuffer) -> Result<CFRetained<CVPixelBuffer>, String> {
        self.render(screen, &self.pool, self.size)
    }

    /// The composed picture of `screen` at preview size, for the preview's encoder.
    pub fn preview(&self, screen: &CVImageBuffer) -> Result<CFRetained<CVPixelBuffer>, String> {
        self.render(screen, &self.preview_pool, self.preview_size)
    }
}

/// A grey 4:2:0 frame from a pool, for other modules' tests.
#[cfg(test)]
pub(super) fn test_frame(width: u32, height: u32) -> CFRetained<CVPixelBuffer> {
    Pool::new(width, height).unwrap().buffer().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_core_video::{CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress};

/// Reads a 4:2:0 buffer's planes into contiguous NV12 bytes.
    fn nv12_bytes(buffer: &CVPixelBuffer, width: usize, height: usize) -> Result<Vec<u8>, String> {
        let read_only = CVPixelBufferLockFlags(1);
        let status = unsafe { CVPixelBufferLockBaseAddress(buffer, read_only) };
        if status != 0 {
            return Err(format!("the buffer could not be read: {status}"));
        }
        let mut data = Vec::with_capacity(width * height * 3 / 2);
        for (plane, rows) in [(0, height), (1, height / 2)] {
            let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane).cast::<u8>();
            let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane);
            if base.is_null() || stride < width {
                unsafe { CVPixelBufferUnlockBaseAddress(buffer, read_only) };
                return Err("the buffer has no readable plane".into());
            }
            for row in 0..rows {
                data.extend_from_slice(unsafe { std::slice::from_raw_parts(base.add(row * stride), width) });
            }
        }
        unsafe { CVPixelBufferUnlockBaseAddress(buffer, read_only) };
        Ok(data)
    }

    /// A `width` × `height` 4:2:0 buffer whose luma is `luma(x, y)`, chroma neutral.
    fn buffer(width: u32, height: u32, luma: impl Fn(usize, usize) -> u8) -> CFRetained<CVPixelBuffer> {
        coloured(width, height, luma, (128, 128))
    }

    /// The same with every chroma sample `(cb, cr)`.
    fn coloured(width: u32, height: u32, luma: impl Fn(usize, usize) -> u8, (cb, cr): (u8, u8)) -> CFRetained<CVPixelBuffer> {
        let buffer = Pool::new(width, height).unwrap().buffer().unwrap();
        unsafe { CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
        for (plane, rows) in [(0, height as usize), (1, height as usize / 2)] {
            let base = CVPixelBufferGetBaseAddressOfPlane(&buffer, plane).cast::<u8>();
            let stride = CVPixelBufferGetBytesPerRowOfPlane(&buffer, plane);
            for y in 0..rows {
                let line = unsafe { std::slice::from_raw_parts_mut(base.add(y * stride), width as usize) };
                for (x, value) in line.iter_mut().enumerate() {
                    *value = if plane == 1 { if x % 2 == 0 { cb } else { cr } } else { luma(x, y) };
                }
            }
        }
        unsafe { CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
        buffer
    }

    /// The (Cb, Cr) of the chroma sample at chroma position (`x`, `y`).
    fn chroma(buffer: &CVPixelBuffer, x: usize, y: usize) -> (u8, u8) {
        let (width, height) = (CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer));
        let data = nv12_bytes(buffer, width, height).unwrap();
        let at = width * height + y * width + x * 2;
        (data[at], data[at + 1])
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
        assert_eq!((CVPixelBufferGetWidth(&preview), CVPixelBufferGetHeight(&preview)), (640, 360));
        let data = nv12_bytes(&preview, 640, 360).unwrap();
        let at = |x: usize, y: usize| data[y * 640 + x];
        assert!(near(at(630, 350), BRIGHT), "{}", at(630, 350));
        assert!(near(at(10, 10), DARK));
        assert!(data[640 * 360..].iter().all(|&c| c.abs_diff(128) <= 4));
    }

    #[test]
    fn the_camera_s_colour_fills_its_bubble_and_the_screen_s_stays_outside() {
        let layout = Layout { width: 0.5, height: 0.5, rounding: 0.0, x: 0.5, y: 0.5, mirror: false };
        let (compositor, camera) = compositor(layout);
        camera.deliver(coloured(128, 72, |_, _| BRIGHT, (200, 60)), 1);
        let out = compositor.compose(&coloured(W, H, |_, _| DARK, (90, 170))).unwrap();
        let bubble = layout.bubble(W, H);
        let (cx, cy) = ((bubble.x + bubble.width / 2.0) as usize / 2, (bubble.y + bubble.height / 2.0) as usize / 2);
        let inside = chroma(&out, cx, cy);
        assert!(near(inside.0, 200) && near(inside.1, 60), "inside {inside:?}");
        let outside = chroma(&out, 2, 2);
        assert!(near(outside.0, 90) && near(outside.1, 170), "outside {outside:?}");
    }

    #[test]
    fn a_bt601_camera_is_converted_to_bt709() {
        let layout = Layout { width: 0.5, height: 0.5, rounding: 0.0, x: 0.5, y: 0.5, mirror: false };
        let (compositor, camera) = compositor(layout);
        let frame = coloured(128, 72, |_, _| BRIGHT, (200, 60));
        let key: &CFString = unsafe { kCVImageBufferYCbCrMatrixKey };
        unsafe { frame.set_attachment(key, kCVImageBufferYCbCrMatrix_ITU_R_601_4, objc2_core_video::CVAttachmentMode::ShouldPropagate) };
        camera.deliver(frame, 1);
        let out = compositor.compose(&buffer(W, H, |_, _| DARK)).unwrap();
        let bubble = layout.bubble(W, H);
        let (x, y) = ((bubble.x + bubble.width / 2.0) as usize, (bubble.y + bubble.height / 2.0) as usize);
        // BT.601 (Y 220, Cb 200, Cr 60) is BT.709 (Y 225.8, Cb 193.5, Cr 63.7).
        let (cb, cr) = chroma(&out, x / 2, y / 2);
        assert!(cb.abs_diff(193) <= 2 && cr.abs_diff(64) <= 2, "chroma {cb} {cr}");
        assert!(luma(&out, x, y).abs_diff(226) <= 2, "luma {}", luma(&out, x, y));
    }

    #[test]
    fn a_chroma_sample_on_the_bubble_s_edge_takes_the_share_its_luma_pixels_do() {
        // A square bubble from luma (31, 31): the chroma sample over luma 30-31 by 30-31 has one of its four inside.
        let layout = Layout { width: 0.5, height: 0.5, rounding: 0.0, x: 31.0 / 230.0, y: 31.0 / 90.0, mirror: false };
        assert_eq!((layout.bubble(W, H).x, layout.bubble(W, H).y), (31.0, 31.0));
        let (compositor, camera) = compositor(layout);
        camera.deliver(coloured(128, 72, |_, _| BRIGHT, (200, 128)), 1);
        let out = compositor.compose(&buffer(W, H, |_, _| DARK)).unwrap();
        // A quarter of the way from the screen's 128 to the camera's 200.
        let (cb, _) = chroma(&out, 15, 15);
        assert!(cb.abs_diff(146) <= 3, "edge chroma {cb}");
        let (inside, _) = chroma(&out, 20, 20);
        assert!(near(inside, 200));
    }
}
