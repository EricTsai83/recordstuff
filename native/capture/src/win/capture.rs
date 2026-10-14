//! The display through Windows.Graphics.Capture. Each frame arrives as a BGRA texture of the frame pool, which has
//! only two and reuses them, so it is converted at once on the GPU, by the Direct3D 11 video processor, into an NV12
//! texture at the recording's size (scaled, BT.709 limited range): what the H.264 encoder takes. NV12 textures are
//! kept in a pool and go back to it when the core lets go of the frame; only frames that are encoded are read back to
//! memory (video.rs), not every captured one.

use std::sync::{Arc, Mutex};

use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HMODULE, POINT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};
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

/// One NV12 texture at the recording's size, back to its pool when dropped.
pub struct Nv12 {
    pub texture: ID3D11Texture2D,
    view: ID3D11VideoProcessorOutputView,
    pool: Arc<Mutex<Vec<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)>>>,
}

impl Drop for Nv12 {
    fn drop(&mut self) {
        if let Ok(mut pool) = self.pool.lock() {
            pool.push((self.texture.clone(), self.view.clone()));
        }
    }
}

pub type Frame = Arc<Mta<Nv12>>;

/// BGRA at the source's size to NV12 at the recording's.
struct Converter {
    gpu: Arc<Mta<Gpu>>,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    source: SizeInt32,
    width: u32,
    height: u32,
    pool: Arc<Mutex<Vec<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)>>>,
}

/// D3D11_VIDEO_PROCESSOR_COLOR_SPACE: YCbCr_Matrix (bit 2) BT.709 and Nominal_Range (bits 4–5) 16–235.
const BT709_LIMITED: u32 = (1 << 2) | (1 << 4);
/// RGB_Range (bit 1) 0: full range, as capture delivers it.
const RGB_FULL: u32 = 0;

impl Converter {
    fn new(gpu: Arc<Mta<Gpu>>, source: SizeInt32, width: u32, height: u32) -> Result<Self, CaptureError> {
        let fail = super::failing;
        let video_device: ID3D11VideoDevice = gpu.0.device.cast().map_err(fail("no Direct3D video device"))?;
        let video_context: ID3D11VideoContext =
            gpu.0.context.lock().unwrap().cast().map_err(fail("no Direct3D video context"))?;
        let (enumerator, processor) = Self::processor(&video_device, &video_context, source, width, height)?;
        Ok(Self { gpu, video_device, video_context, enumerator, processor, source, width, height, pool: Arc::new(Mutex::new(Vec::new())) })
    }

    fn processor(
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

    fn take(&self) -> windows::core::Result<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)> {
        if let Some(pooled) = self.pool.lock().unwrap().pop() {
            return Ok(pooled);
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: self.width,
            Height: self.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe { self.gpu.0.device.CreateTexture2D(&desc, None, Some(&mut texture))? };
        let texture = texture.unwrap();
        let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
        };
        let mut view = None;
        unsafe { self.video_device.CreateVideoProcessorOutputView(&texture, &self.enumerator, &view_desc, Some(&mut view))? };
        Ok((texture, view.unwrap()))
    }

    /// Converts one captured BGRA texture.
    fn convert(&mut self, bgra: &ID3D11Texture2D, size: SizeInt32) -> Result<Frame, String> {
        if size != self.source {
            // The display's mode changed: the processor is made for one input size.
            let (enumerator, processor) =
                Self::processor(&self.video_device, &self.video_context, size, self.width, self.height).map_err(|e| e.detail)?;
            (self.enumerator, self.processor, self.source) = (enumerator, processor, size);
            // A new pool: output views belong to the enumerator they were made with, and frames still held return
            // theirs to the old pool, which goes with them.
            self.pool = Arc::new(Mutex::new(Vec::new()));
        }
        let (texture, view) = self.take().map_err(|e| format!("an NV12 texture could not be made: {e}"))?;
        let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
        };
        let mut input = None;
        unsafe { self.video_device.CreateVideoProcessorInputView(bgra, &self.enumerator, &input_desc, Some(&mut input)) }
            .map_err(|e| format!("a captured frame could not be read: {e}"))?;
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: std::mem::ManuallyDrop::new(input),
            ..Default::default()
        };
        let streams = [stream];
        let result = {
            let _context = self.gpu.0.context.lock().unwrap();
            unsafe { self.video_context.VideoProcessorBlt(&self.processor, &view, 0, &streams) }
        };
        let [mut stream] = streams;
        unsafe { std::mem::ManuallyDrop::drop(&mut stream.pInputSurface) };
        result.map_err(|e| format!("a captured frame could not be converted: {e}"))?;
        Ok(Arc::new(Mta(Nv12 { texture, view, pool: self.pool.clone() })))
    }
}

/// Capture of one display, delivering converted frames to the core from the frame pool's thread.
pub struct DisplayCapture {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
}

unsafe impl Send for DisplayCapture {}

impl DisplayCapture {
    /// Starts capture. Returns the capture and whether the yellow capture border could be turned off.
    pub fn start(
        gpu: Arc<Mta<Gpu>>,
        item: &GraphicsCaptureItem,
        width: u32,
        height: u32,
        min_interval_ns: u64,
        shared: Arc<Shared<super::session::Win>>,
    ) -> Result<(Self, bool), CaptureError> {
        let fail = super::failing;
        let dxgi: IDXGIDevice = gpu.0.device.cast().map_err(fail("no DXGI device"))?;
        let device: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
            .and_then(|inspectable: IInspectable| inspectable.cast())
            .map_err(fail("no WinRT Direct3D device"))?;
        let size = item.Size().map_err(fail("the display's size"))?;
        let converter = Mta(Mutex::new(Converter::new(gpu, size, width, height)?));
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
        Ok((Self { pool, session }, borderless))
    }

    pub fn stop(&self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

/// Reads an NV12 texture back to memory, tightly packed: the luma rows, then the interleaved chroma rows.
pub struct Readback {
    staging: ID3D11Texture2D,
    width: u32,
    height: u32,
}

impl Readback {
    pub fn new(gpu: &Gpu, width: u32, height: u32) -> Result<Self, CaptureError> {
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
        unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut staging)) }.map_err(|e| start_failed("the read-back texture", e))?;
        Ok(Self { staging: staging.unwrap(), width, height })
    }

    pub fn read(&self, gpu: &Gpu, frame: &Nv12, out: &mut Vec<u8>) -> Result<(), String> {
        let (width, height) = (self.width as usize, self.height as usize);
        out.clear();
        out.reserve(width * height * 3 / 2);
        let context = gpu.context.lock().unwrap();
        unsafe { context.CopyResource(&self.staging, &frame.texture) };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { context.Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.map_err(|e| format!("reading a frame back: {e}"))?;
        let pitch = mapped.RowPitch as usize;
        let base = mapped.pData as *const u8;
        // The chroma plane follows the luma plane's `height` rows of `pitch` bytes.
        for row in 0..height + height / 2 {
            let line = unsafe { std::slice::from_raw_parts(base.add(row * pitch), width) };
            out.extend_from_slice(line);
        }
        unsafe { context.Unmap(&self.staging, 0) };
        Ok(())
    }
}
