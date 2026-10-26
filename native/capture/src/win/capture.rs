//! The display or one window through Windows.Graphics.Capture, the whole of it or an area. Each frame arrives as a BGRA texture of the frame pool, which has
//! only two and reuses them, so it is converted at once on the GPU, by the Direct3D 11 video processor, into an NV12
//! texture at the recording's size (cut to the area, scaled, BT.709 limited range): what the H.264 encoder takes. Textures are kept in
//! a pool and go back to it when the core lets go of the frame; only frames that are encoded are read back to memory
//! (video.rs), not every captured one.
//!
//! A device without a video processor (WARP, on a virtual machine or a runner without a GPU) cannot convert: each
//! frame (its area) is copied as it came into a staging texture instead, and frames that are encoded are converted on
//! the CPU as they are read back.
//!
//! A window that changes size is scaled to the recording's size as it is, so its picture stretches; the item closing
//! (the window closed, the display removed) ends the recording as a capture failure.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HMODULE, HWND, POINT, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{HMONITOR, MONITOR_DEFAULTTONULL, MONITOR_DEFAULTTOPRIMARY, MonitorFromPoint};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext};
use windows::Win32::UI::WindowsAndMessaging::IsWindow;
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

/// The window `id` (its HWND).
pub fn window_item(id: u64) -> Result<GraphicsCaptureItem, CaptureError> {
    let hwnd = HWND(id as usize as *mut core::ffi::c_void);
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err(CaptureError::new("capture_start_failed", format!("window {id:#x} does not exist (closed?)")));
    }
    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .map_err(|e| start_failed("Windows.Graphics.Capture is not available", e))?;
    unsafe { interop.CreateForWindow::<GraphicsCaptureItem>(hwnd) }.map_err(|e| start_failed("the window could not be captured", e))
}

/// A part of the captured surface, in its pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Area {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Area {
    /// This area within a surface of `size`, or the whole surface without one; never empty.
    fn within(area: Option<Area>, size: SizeInt32) -> Area {
        let (width, height) = (size.Width.max(1) as u32, size.Height.max(1) as u32);
        match area {
            None => Area { x: 0, y: 0, width, height },
            Some(area) => {
                let x = area.x.min(width - 1);
                let y = area.y.min(height - 1);
                Area { x, y, width: area.width.min(width - x).max(1), height: area.height.min(height - y).max(1) }
            }
        }
    }
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
pub(crate) type Pool = Arc<Mutex<Vec<Slot>>>;

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

impl Captured {
    /// A texture of its own, returned to no pool: the hardware encoder's self-test frame.
    pub fn detached(texture: ID3D11Texture2D, image: Image) -> Self {
        Self { texture, image, view: None, pool: Arc::new(Mutex::new(Vec::new())) }
    }

    /// An NV12 texture of another pool than capture's, back to it when dropped: the camera compositor's output.
    pub(crate) fn pooled(texture: ID3D11Texture2D, pool: Pool) -> Self {
        Self { texture, image: Image::Nv12, view: None, pool }
    }

    /// The texture back from `pool`, if one is there.
    pub(crate) fn reuse(pool: &Pool) -> Option<ID3D11Texture2D> {
        pool.lock().unwrap().pop().map(|(texture, _)| texture)
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
    fn new(gpu: &Gpu, source: SizeInt32, area: Area, width: u32, height: u32) -> Result<Self, CaptureError> {
        let fail = super::failing;
        let video_device: ID3D11VideoDevice = gpu.device.cast().map_err(fail("no Direct3D video device"))?;
        let video_context: ID3D11VideoContext = gpu.context.lock().unwrap().cast().map_err(fail("no Direct3D video context"))?;
        let (enumerator, processor) = Self::make(&video_device, &video_context, source, area, width, height)?;
        Ok(Self { video_device, video_context, enumerator, processor })
    }

    fn make(
        video_device: &ID3D11VideoDevice,
        video_context: &ID3D11VideoContext,
        source: SizeInt32,
        area: Area,
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
        let enumerator =
            unsafe { video_device.CreateVideoProcessorEnumerator(&content) }.map_err(|e| start_failed("the video processor is not available", e))?;
        let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0) }.map_err(|e| start_failed("the video processor could not be made", e))?;
        unsafe {
            video_context.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            video_context.VideoProcessorSetStreamColorSpace(&processor, 0, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: RGB_FULL });
            video_context.VideoProcessorSetOutputColorSpace(&processor, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: BT709_LIMITED });
            let rect = RECT { left: area.x as i32, top: area.y as i32, right: (area.x + area.width) as i32, bottom: (area.y + area.height) as i32 };
            video_context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&rect));
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
    /// The area asked for, and the part of the current surface it covers.
    asked: Option<Area>,
    area: Area,
    width: u32,
    height: u32,
    pool: Pool,
}

impl Converter {
    /// The converter, and why frames are converted on the CPU when they are.
    fn new(gpu: Arc<Mta<Gpu>>, source: SizeInt32, asked: Option<Area>, width: u32, height: u32) -> (Self, Option<String>) {
        let area = Area::within(asked, source);
        let (processor, cpu) = match Processor::new(&gpu.0, source, area, width, height) {
            Ok(processor) => (Some(processor), None),
            Err(error) => (None, Some(error.detail)),
        };
        (Self { gpu, processor, source, asked, area, width, height, pool: Arc::new(Mutex::new(Vec::new())) }, cpu)
    }

    fn take(&self) -> windows::core::Result<Slot> {
        if let Some(pooled) = self.pool.lock().unwrap().pop() {
            return Ok(pooled);
        }
        let (width, height, format, usage, bind, cpu) = match self.processor {
            Some(_) => (self.width, self.height, DXGI_FORMAT_NV12, D3D11_USAGE_DEFAULT, D3D11_BIND_RENDER_TARGET.0 as u32, 0),
            None => (self.area.width, self.area.height, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ.0 as u32),
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
            // The display's mode or the window's size changed: the processor is made for one input size, and copies
            // are made at the area's.
            self.area = Area::within(self.asked, size);
            if let Some(processor) = &mut self.processor {
                let (enumerator, made) =
                    Processor::make(&processor.video_device, &processor.video_context, size, self.area, self.width, self.height).map_err(|e| e.detail)?;
                (processor.enumerator, processor.processor) = (enumerator, made);
            }
            self.source = size;
            // A new pool: output views belong to the enumerator they were made with, copies have the old size, and
            // frames still held return theirs to the old pool, which goes with them.
            self.pool = Arc::new(Mutex::new(Vec::new()));
        }
        let (texture, view) = self.take().map_err(|e| format!("a frame texture could not be made: {e}"))?;
        let Some(processor) = &self.processor else {
            let area = self.area;
            let region = D3D11_BOX { left: area.x, top: area.y, front: 0, right: area.x + area.width, bottom: area.y + area.height, back: 1 };
            unsafe { self.gpu.0.context.lock().unwrap().CopySubresourceRegion(&texture, 0, 0, 0, 0, bgra, 0, Some(&region)) };
            let image = Image::Bgra { width: area.width, height: area.height };
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
        let stream = D3D11_VIDEO_PROCESSOR_STREAM { Enable: true.into(), pInputSurface: std::mem::ManuallyDrop::new(input), ..Default::default() };
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

/// Capture of one display or window, delivering converted frames to the core from the frame pool's thread.
pub struct DisplayCapture {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    item: GraphicsCaptureItem,
    closed: i64,
    arrived: i64,
    gate: Arc<FrameGate>,
}

/// How long `stop` waits for a frame handler still running; past it, it goes on rather than hang a stop.
const HANDLER_WAIT: Duration = Duration::from_secs(2);

/// Whether capture has stopped, and how many frame handlers run now (2026-10-27). The frame pool calls its handler on a
/// thread of its own, and closing it does not wait for a call under way: one still converting a frame on the CPU (a
/// device with no video processor, as CI's runners) went on after `stop` returned, and in the test's process ended
/// under it (`STATUS_ACCESS_VIOLATION`). `stop` closes the gate and waits for the calls inside it, so none runs after.
#[derive(Default)]
struct FrameGate {
    state: Mutex<(bool, usize)>,
    left: Condvar,
}

/// A frame handler inside the gate: leaving, it says so to a `stop` waiting for it.
struct InsideGate<'a>(&'a FrameGate);

impl FrameGate {
    /// Enters, unless capture has stopped.
    fn enter(&self) -> Option<InsideGate<'_>> {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.0 {
            return None;
        }
        state.1 += 1;
        Some(InsideGate(self))
    }

    /// Lets no handler in again and waits, at most `wait`, for those inside; true when none is left.
    fn close(&self, wait: Duration) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.0 = true;
        let (state, _) = self.left.wait_timeout_while(state, wait, |state| state.1 > 0).unwrap_or_else(|poisoned| poisoned.into_inner());
        state.1 == 0
    }
}

impl Drop for InsideGate<'_> {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.1 -= 1;
        if state.1 == 0 {
            self.0.left.notify_all();
        }
    }
}

unsafe impl Send for DisplayCapture {}

impl DisplayCapture {
    /// Starts capture. Returns the capture, whether the yellow capture border could be turned off, and why frames are
    /// converted on the CPU when they are.
    pub fn start(
        gpu: Arc<Mta<Gpu>>,
        item: &GraphicsCaptureItem,
        area: Option<Area>,
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
        let (converter, cpu) = Converter::new(gpu, size, area, width, height);
        let converter = Mta(Mutex::new(converter));
        let on_close = shared.clone();
        let closed = item
            .Closed(&TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new(move |_, _| {
                on_close.fail("what was being captured went away (the window closed or the display was removed)".into());
                Ok(())
            }))
            .map_err(fail("listening for the item's closing"))?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)
            .map_err(fail("the capture frame pool"))?;
        let device_for_resize = Mta(device);
        let gate = Arc::new(FrameGate::default());
        let inside = gate.clone();
        let arrived = pool
            .FrameArrived(&TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(move |sender, _| {
                // Nothing once stopped, and `stop` waits for a frame under way (`FrameGate`).
                let Some(_inside) = inside.enter() else { return Ok(()) };
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
        Ok((Self { pool, session, item: item.clone(), closed, arrived, gate }, borderless, cpu))
    }

    /// Ends capture: no frame handler runs once it returns, one under way waited for (`FrameGate`).
    pub fn stop(&self) {
        let _ = self.item.RemoveClosed(self.closed);
        let _ = self.pool.RemoveFrameArrived(self.arrived);
        if !self.gate.close(HANDLER_WAIT) {
            eprintln!("display: a frame handler still ran {} s after the stop; going on", HANDLER_WAIT.as_secs());
        }
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

#[cfg(test)]
mod frame_gate_tests {
    use super::FrameGate;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[test]
    fn a_handler_enters_until_the_stop_and_none_after() {
        let gate = FrameGate::default();
        assert!(gate.enter().is_some());
        assert!(gate.close(Duration::from_millis(10)));
        assert!(gate.enter().is_none());
    }

    #[test]
    fn the_stop_waits_for_a_handler_under_way() {
        // By order alone, not by time (Codex's review): the stop is still waiting while the handler holds the gate, and
        // returns, with none left inside, once it lets go.
        let gate = Arc::new(FrameGate::default());
        let inside = gate.enter().expect("not stopped yet");
        let stopped = Arc::new(AtomicBool::new(false));
        let stopping = {
            let (gate, stopped) = (gate.clone(), stopped.clone());
            std::thread::spawn(move || {
                let none_left = gate.close(Duration::from_secs(30));
                stopped.store(true, Ordering::SeqCst);
                none_left
            })
        };
        // The stop has closed the gate once no handler may enter; until the one inside leaves, it has not returned.
        while gate.enter().is_some() {
            std::thread::yield_now();
        }
        assert!(!stopped.load(Ordering::SeqCst), "the stop returned while a handler was inside");
        drop(inside);
        assert!(stopping.join().unwrap(), "the handler had left");
        assert!(stopped.load(Ordering::SeqCst));
    }

    #[test]
    fn the_stop_goes_on_after_its_wait_when_a_handler_never_leaves() {
        let gate = FrameGate::default();
        let inside = gate.enter();
        assert!(!gate.close(Duration::from_millis(20)));
        drop(inside);
    }
}
