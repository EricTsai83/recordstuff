//! The display through Windows.Graphics.Capture. Each frame arrives as a BGRA texture of the frame pool, which has
//! only two and reuses them, so it is converted at once on the GPU, by the Direct3D 11 video processor, into an NV12
//! texture at the recording's size (scaled, BT.709 limited range): what the H.264 encoder takes. Textures are kept in
//! a pool and go back to it when the core lets go of the frame; only frames that are encoded are read back to memory
//! (video.rs), not every captured one.
//!
//! A device without a video processor (WARP, on a virtual machine or a runner without a GPU) cannot convert: each
//! frame is copied as it came into a staging texture instead, and frames that are encoded are converted on the CPU
//! as they are read back.

use std::sync::{Arc, Mutex};

use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HMODULE, POINT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{HMONITOR, MONITOR_DEFAULTTONULL, MONITOR_DEFAULTTOPRIMARY, MonitorFromPoint};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext};
use windows::core::{IInspectable, Interface};

use super::{CaptureError, Mta, hundreds_to_ns, start_failed};
use crate::core::Shared;

/// The monitor at `point` (physical pixels), or the primary one when no point is given.
pub fn monitor(point: Option<(i32, i32)>) -> Result<HMONITOR, CaptureError> {
    // Physical pixels whatever this process's DPI awareness: Electron's utility process and a test's Node differ.
    let previous = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let monitor = match point {
        Some((x, y)) => unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONULL) },
        None => unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) },
    };
    if !previous.is_invalid() {
        unsafe { SetThreadDpiAwarenessContext(previous) };
    }
    if monitor.is_invalid() {
        let (x, y) = point.unwrap_or_default();
        return Err(CaptureError::new("no_display", format!("no display contains the point ({x}, {y})")));
    }
    Ok(monitor)
}

pub fn item(monitor: HMONITOR) -> Result<GraphicsCaptureItem, CaptureError> {
    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .map_err(|e| start_failed("Windows.Graphics.Capture is not available", e))?;
    unsafe { interop.CreateForMonitor::<GraphicsCaptureItem>(monitor) }.map_err(|e| start_failed("the display could not be captured", e))
}

/// The Direct3D device capture, conversion and read-back share. Its immediate context is used by one thread at a time.
pub struct Gpu {
    pub device: ID3D11Device,
    pub context: Mutex<ID3D11DeviceContext>,
    /// WARP, Windows's software rasterizer, when no hardware device could be made (a virtual machine without a GPU).
    pub software: bool,
}

impl Gpu {
    pub fn new() -> Result<Arc<Mta<Gpu>>, CaptureError> {
        let make = |kind: D3D_DRIVER_TYPE| -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext)> {
            let (mut device, mut context) = (None, None);
            unsafe {
                D3D11CreateDevice(
                    None,
                    kind,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )?
            };
            Ok((device.unwrap(), context.unwrap()))
        };
        let (device, context, software) = match make(D3D_DRIVER_TYPE_HARDWARE) {
            Ok((device, context)) => (device, context, false),
            Err(hardware) => {
                let (device, context) = make(D3D_DRIVER_TYPE_WARP)
                    .map_err(|e| CaptureError::new("capture_start_failed", format!("no Direct3D 11 device: {hardware}; WARP: {e}")))?;
                (device, context, true)
            }
        };
        // Capture's thread and the encoder's both submit work.
        if let Ok(multithread) = context.cast::<ID3D11Multithread>() {
            let _ = unsafe { multithread.SetMultithreadProtected(true) };
        }
        Ok(Arc::new(Mta(Gpu { device, context: Mutex::new(context), software })))
    }
}

/// What a pooled texture holds.
#[derive(Clone, Copy, PartialEq)]
pub enum Image {
    /// NV12 at the recording's size, converted by the video processor.
    Nv12,
    /// The captured BGRA as it came, in a staging texture: converted on the CPU when it is encoded (crate::nv12).
    Bgra { width: u32, height: u32 },
}

type Slot = (ID3D11Texture2D, Option<ID3D11VideoProcessorOutputView>);
type Pool = Arc<Mutex<Vec<Slot>>>;

/// One converted or copied frame, back to its pool when dropped.
pub struct Captured {
    pub texture: ID3D11Texture2D,
    pub image: Image,
    view: Option<ID3D11VideoProcessorOutputView>,
    pool: Pool,
}

impl Drop for Captured {
    fn drop(&mut self) {
        if let Ok(mut pool) = self.pool.lock() {
            pool.push((self.texture.clone(), self.view.take()));
        }
    }
}

pub type Frame = Arc<Mta<Captured>>;

/// The Direct3D 11 video processor, for BGRA at the source's size to NV12 at the recording's.
struct Processor {
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
}

/// D3D11_VIDEO_PROCESSOR_COLOR_SPACE: YCbCr_Matrix (bit 2) BT.709 and Nominal_Range (bits 4–5) 16–235.
const BT709_LIMITED: u32 = (1 << 2) | (1 << 4);
/// RGB_Range (bit 1) 0: full range, as capture delivers it.
const RGB_FULL: u32 = 0;

impl Processor {
    fn new(gpu: &Gpu, source: SizeInt32, width: u32, height: u32) -> Result<Self, CaptureError> {
        let fail = super::failing;
        let video_device: ID3D11VideoDevice = gpu.device.cast().map_err(fail("no Direct3D video device"))?;
        let video_context: ID3D11VideoContext = gpu.context.lock().unwrap().cast().map_err(fail("no Direct3D video context"))?;
        let (enumerator, processor) = Self::make(&video_device, &video_context, source, width, height)?;
        Ok(Self { video_device, video_context, enumerator, processor })
    }

    fn make(
        video_device: &ID3D11VideoDevice,
        video_context: &ID3D11VideoContext,
        source: SizeInt32,
        width: u32,
        height: u32,
    ) -> Result<(ID3D11VideoProcessorEnumerator, ID3D11VideoProcessor), CaptureError> {
        let rate = DXGI_RATIONAL { Numerator: 60, Denominator: 1 };
        let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: rate,
            InputWidth: source.Width as u32,
            InputHeight: source.Height as u32,
            OutputFrameRate: rate,
            OutputWidth: width,
            OutputHeight: height,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        };
        let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&content) }
            .map_err(|e| start_failed("the video processor is not available", e))?;
        let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0) }
            .map_err(|e| start_failed("the video processor could not be made", e))?;
        unsafe {
            video_context.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            video_context.VideoProcessorSetStreamColorSpace(&processor, 0, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: RGB_FULL });
            video_context.VideoProcessorSetOutputColorSpace(&processor, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: BT709_LIMITED });
        }
        Ok((enumerator, processor))
    }
}

/// Captured BGRA to what the encoder reads back: NV12 through the video processor, or, when the device has none, a
/// copy of the BGRA in a staging texture.
struct Converter {
    gpu: Arc<Mta<Gpu>>,
    processor: Option<Processor>,
    source: SizeInt32,
    width: u32,
    height: u32,
    pool: Pool,
}

impl Converter {
    /// The converter, and why frames are converted on the CPU when they are.
    fn new(gpu: Arc<Mta<Gpu>>, source: SizeInt32, width: u32, height: u32) -> (Self, Option<String>) {
        let (processor, cpu) = match Processor::new(&gpu.0, source, width, height) {
            Ok(processor) => (Some(processor), None),
            Err(error) => (None, Some(error.detail)),
        };
        (Self { gpu, processor, source, width, height, pool: Arc::new(Mutex::new(Vec::new())) }, cpu)
    }

    fn take(&self) -> windows::core::Result<Slot> {
        if let Some(pooled) = self.pool.lock().unwrap().pop() {
            return Ok(pooled);
        }
        let (width, height, format, usage, bind, cpu) = match self.processor {
            Some(_) => (self.width, self.height, DXGI_FORMAT_NV12, D3D11_USAGE_DEFAULT, D3D11_BIND_RENDER_TARGET.0 as u32, 0),
            None => (
                self.source.Width as u32,
                self.source.Height as u32,
                DXGI_FORMAT_B8G8R8A8_UNORM,
                D3D11_USAGE_STAGING,
                0,
                D3D11_CPU_ACCESS_READ.0 as u32,
            ),
        };
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: usage,
            BindFlags: bind,
            CPUAccessFlags: cpu,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe { self.gpu.0.device.CreateTexture2D(&desc, None, Some(&mut texture))? };
        let texture = texture.unwrap();
        let Some(processor) = &self.processor else { return Ok((texture, None)) };
        let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
        };
        let mut view = None;
        unsafe { processor.video_device.CreateVideoProcessorOutputView(&texture, &processor.enumerator, &view_desc, Some(&mut view))? };
        Ok((texture, view))
    }

    /// Converts or copies one captured BGRA texture.
    fn convert(&mut self, bgra: &ID3D11Texture2D, size: SizeInt32) -> Result<Frame, String> {
        if size != self.source {
            // The display's mode changed: the processor is made for one input size, and copies are made at it.
            if let Some(processor) = &mut self.processor {
                let (enumerator, made) =
                    Processor::make(&processor.video_device, &processor.video_context, size, self.width, self.height).map_err(|e| e.detail)?;
                (processor.enumerator, processor.processor) = (enumerator, made);
            }
            self.source = size;
            // A new pool: output views belong to the enumerator they were made with, copies have the old size, and
            // frames still held return theirs to the old pool, which goes with them.
            self.pool = Arc::new(Mutex::new(Vec::new()));
        }
        let (texture, view) = self.take().map_err(|e| format!("a frame texture could not be made: {e}"))?;
        let Some(processor) = &self.processor else {
            unsafe { self.gpu.0.context.lock().unwrap().CopyResource(&texture, bgra) };
            let image = Image::Bgra { width: size.Width as u32, height: size.Height as u32 };
            return Ok(Arc::new(Mta(Captured { texture, image, view, pool: self.pool.clone() })));
        };
        let output = view.as_ref().expect("the video processor's textures have output views");
        let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
        };
        let mut input = None;
        unsafe { processor.video_device.CreateVideoProcessorInputView(bgra, &processor.enumerator, &input_desc, Some(&mut input)) }
            .map_err(|e| format!("a captured frame could not be read: {e}"))?;
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: std::mem::ManuallyDrop::new(input),
            ..Default::default()
        };
        let streams = [stream];
        let result = {
            let _context = self.gpu.0.context.lock().unwrap();
            unsafe { processor.video_context.VideoProcessorBlt(&processor.processor, output, 0, &streams) }
        };
        let [mut stream] = streams;
        unsafe { std::mem::ManuallyDrop::drop(&mut stream.pInputSurface) };
        result.map_err(|e| format!("a captured frame could not be converted: {e}"))?;
        Ok(Arc::new(Mta(Captured { texture, image: Image::Nv12, view, pool: self.pool.clone() })))
    }
}

/// Capture of one display, delivering converted frames to the core from the frame pool's thread.
pub struct DisplayCapture {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
}

unsafe impl Send for DisplayCapture {}

impl DisplayCapture {
    /// Starts capture. Returns the capture, whether the yellow capture border could be turned off, and why frames are
    /// converted on the CPU when they are.
    pub fn start(
        gpu: Arc<Mta<Gpu>>,
        item: &GraphicsCaptureItem,
        width: u32,
        height: u32,
        min_interval_ns: u64,
        shared: Arc<Shared<super::session::Win>>,
    ) -> Result<(Self, bool, Option<String>), CaptureError> {
        let fail = super::failing;
        let dxgi: IDXGIDevice = gpu.0.device.cast().map_err(fail("no DXGI device"))?;
        let device: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
            .and_then(|inspectable: IInspectable| inspectable.cast())
            .map_err(fail("no WinRT Direct3D device"))?;
        let size = item.Size().map_err(fail("the display's size"))?;
        let (converter, cpu) = Converter::new(gpu, size, width, height);
        let converter = Mta(Mutex::new(converter));
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)
            .map_err(fail("the capture frame pool"))?;
        let device_for_resize = Mta(device);
        pool.FrameArrived(&TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(move |sender, _| {
            let Ok(pool) = sender.ok() else { return Ok(()) };
            let Ok(frame) = pool.TryGetNextFrame() else { return Ok(()) };
            let result = (|| -> Result<(), String> {
                let pts = hundreds_to_ns(frame.SystemRelativeTime().map_err(|e| e.to_string())?.Duration);
                let content = frame.ContentSize().map_err(|e| e.to_string())?;
                let surface = frame.Surface().map_err(|e| e.to_string())?;
                let access: IDirect3DDxgiInterfaceAccess = surface.cast().map_err(|e| e.to_string())?;
                let texture: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(|e| e.to_string())?;
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                unsafe { texture.GetDesc(&mut desc) };
                let surface_size = SizeInt32 { Width: desc.Width as i32, Height: desc.Height as i32 };
                let converted = converter.get().lock().unwrap().convert(&texture, surface_size)?;
                if content != surface_size {
                    // Later frames come at the new size.
                    let _ = pool.Recreate(device_for_resize.get(), DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content);
                }
                shared.frame(converted, pts);
                Ok(())
            })();
            let _ = frame.Close();
            if let Err(detail) = result {
                shared.fail(detail);
            }
            Ok(())
        }))
        .map_err(fail("listening for frames"))?;
        let session = pool.CreateCaptureSession(item).map_err(fail("the capture session"))?;
        let _ = session.SetIsCursorCaptureEnabled(true);
        // Windows 11 lets the border go; Windows 10 always draws it.
        let borderless = session.SetIsBorderRequired(false).is_ok();
        // Windows 11 24H2 and later deliver at most this often; earlier versions on every change.
        let _ = session.SetMinUpdateInterval(windows::Foundation::TimeSpan { Duration: (min_interval_ns / 100) as i64 });
        session.StartCapture().map_err(fail("starting capture"))?;
        Ok((Self { pool, session }, borderless, cpu))
    }

    pub fn stop(&self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

/// Reads a frame back to memory as NV12 at the recording's size, tightly packed: the luma rows, then the interleaved
/// chroma rows. A BGRA copy is converted here, on the encoder's caller's thread.
pub struct Readback {
    /// Made at the first NV12 frame: a device without a video processor never sends one.
    staging: Option<ID3D11Texture2D>,
    width: u32,
    height: u32,
}

impl Readback {
    pub fn new(width: u32, height: u32) -> Self {
        Self { staging: None, width, height }
    }

    pub fn read(&mut self, gpu: &Gpu, frame: &Captured, out: &mut Vec<u8>) -> Result<(), String> {
        let (width, height) = (self.width as usize, self.height as usize);
        let context = gpu.context.lock().unwrap();
        let mapped_texture = match frame.image {
            Image::Nv12 => {
                if self.staging.is_none() {
                    self.staging = Some(Self::staging(gpu, self.width, self.height).map_err(|e| format!("the read-back texture: {e}"))?);
                }
                let staging = self.staging.as_ref().unwrap();
                unsafe { context.CopyResource(staging, &frame.texture) };
                staging
            }
            Image::Bgra { .. } => &frame.texture,
        };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { context.Map(mapped_texture, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.map_err(|e| format!("reading a frame back: {e}"))?;
        let pitch = mapped.RowPitch as usize;
        let base = mapped.pData as *const u8;
        match frame.image {
            Image::Nv12 => {
                out.clear();
                out.reserve(width * height * 3 / 2);
                // The chroma plane follows the luma plane's `height` rows of `pitch` bytes.
                for row in 0..height + height / 2 {
                    let line = unsafe { std::slice::from_raw_parts(base.add(row * pitch), width) };
                    out.extend_from_slice(line);
                }
            }
            Image::Bgra { width: source_width, height: source_height } => {
                let (source_width, source_height) = (source_width as usize, source_height as usize);
                let source = unsafe { std::slice::from_raw_parts(base, pitch * (source_height - 1) + source_width * 4) };
                crate::nv12::from_bgra(source, pitch, source_width, source_height, out, width, height);
            }
        }
        unsafe { context.Unmap(mapped_texture, 0) };
        Ok(())
    }

    fn staging(gpu: &Gpu, width: u32, height: u32) -> windows::core::Result<ID3D11Texture2D> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging = None;
        unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut staging))? };
        Ok(staging.unwrap())
    }
}
