//! Composing the camera into the recording's frames on Windows (plan 075, D15) with Direct3D 11, before Media
//! Foundation's encoder: the kernels are `shaders/compose.wgsl`'s, which build.rs translates to HLSL and this compiles
//! at run time (`D3DCompile`, d3dcompiler_47, part of Windows), so the bubble's rounding, crop and mirror are the same
//! formula as on macOS.
//!
//! Direct3D 11.1 reads and writes an NV12 texture's planes as `R8` (luma) and `R8G8` (chroma) views for shaders and
//! render targets, but writes them from a compute shader only with Direct3D 11.3's optional planar views. So each
//! kernel writes a texture of its plane's own (`luma` an `R8`, `chroma` an `R8G8` at half size), and two draws of one
//! triangle copy them into the output's planes as render targets, as the video processor writes capture's NV12.
//!
//! The screen's frame is copied into a texture the kernels can read: capture's are made for the video processor only.
//! A device without a video processor (WARP) has the screen as BGRA in memory instead: it is converted as the encoder
//! would (Readback) and uploaded. The composed frame is an NV12 texture of the compositor's pool, which either encoder
//! takes as capture's.
//!
//! The same kernels at preview size make the preview's picture (D17).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use windows::Win32::Graphics::Direct3D::Fxc::{D3DCOMPILE_OPTIMIZATION_LEVEL3, D3DCompile};
use windows::Win32::Graphics::Direct3D::{D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST, D3D_SRV_DIMENSION_TEXTURE2D, ID3DBlob};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT, DXGI_FORMAT_NV12, DXGI_FORMAT_R8_UNORM, DXGI_FORMAT_R8G8_UNORM, DXGI_SAMPLE_DESC};
use windows::core::PCSTR;

use super::Mta;
use super::capture::{Captured, Frame, Gpu, Image, Pool, Readback};
use crate::camera_layout::{self, CameraImage, ComposeParams, Layout, PreviewView};
use crate::core::{CameraAges, CameraFeed};

mod names {
    include!(concat!(env!("OUT_DIR"), "/compose_names.rs"));
}

const SHADER: &str = include_str!(concat!(env!("OUT_DIR"), "/compose.hlsl"));

/// Copies a plane the kernels wrote into the output's plane of the same size: one triangle over the whole target.
const COPY: &str = r"
Texture2D<float4> plane : register(t0);
float4 vertex(uint id : SV_VertexID) : SV_Position {
    float2 uv = float2((id << 1) & 2, id & 2);
    return float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}
float4 pixel(float4 position : SV_Position) : SV_Target {
    return plane.Load(int3(int2(position.xy), 0));
}
";

/// One camera frame as the kernels read it: NV12 uploaded to the GPU, with a view of each plane.
pub struct CameraFrame {
    _texture: ID3D11Texture2D,
    luma: ID3D11ShaderResourceView,
    chroma: ID3D11ShaderResourceView,
    pub image: CameraImage,
}

impl CameraFrame {
    /// Uploads one frame of NV12 bytes, tightly packed (`width` × `height` luma, then the interleaved chroma rows).
    pub fn from_nv12(gpu: &Gpu, image: CameraImage, data: &[u8]) -> Result<Self, String> {
        let (width, height) = (image.width, image.height);
        if width % 2 != 0 || height % 2 != 0 || data.len() < (width * height * 3 / 2) as usize {
            return Err(format!("a {width}x{height} NV12 frame of {} bytes", data.len()));
        }
        let initial = D3D11_SUBRESOURCE_DATA { pSysMem: data.as_ptr().cast(), SysMemPitch: width, SysMemSlicePitch: 0 };
        let texture = texture(&gpu.device, width, height, DXGI_FORMAT_NV12, D3D11_BIND_SHADER_RESOURCE, Some(&initial))
            .map_err(|e| format!("a camera frame could not be uploaded: {e}"))?;
        let luma = shader_view(&gpu.device, &texture, DXGI_FORMAT_R8_UNORM).map_err(|e| format!("the camera's luma: {e}"))?;
        let chroma = shader_view(&gpu.device, &texture, DXGI_FORMAT_R8G8_UNORM).map_err(|e| format!("the camera's chroma: {e}"))?;
        Ok(Self { _texture: texture, luma, chroma, image })
    }
}

pub type Feed = CameraFeed<Arc<Mta<CameraFrame>>>;

fn texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
    bind: D3D11_BIND_FLAG,
    initial: Option<&D3D11_SUBRESOURCE_DATA>,
) -> windows::core::Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: bind.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut made = None;
    unsafe { device.CreateTexture2D(&desc, initial.map(std::ptr::from_ref), Some(&mut made))? };
    Ok(made.unwrap())
}

/// A shader's view of `texture`; of an NV12 texture, `R8` is its luma plane and `R8G8` its chroma plane.
fn shader_view(device: &ID3D11Device, texture: &ID3D11Texture2D, format: DXGI_FORMAT) -> windows::core::Result<ID3D11ShaderResourceView> {
    let desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
        Format: format,
        ViewDimension: D3D_SRV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_SRV { MostDetailedMip: 0, MipLevels: 1 } },
    };
    let mut view = None;
    unsafe { device.CreateShaderResourceView(texture, Some(&desc), Some(&mut view))? };
    Ok(view.unwrap())
}

fn target_view(device: &ID3D11Device, texture: &ID3D11Texture2D, format: DXGI_FORMAT) -> windows::core::Result<ID3D11RenderTargetView> {
    let desc = D3D11_RENDER_TARGET_VIEW_DESC {
        Format: format,
        ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_RTV { MipSlice: 0 } },
    };
    let mut view = None;
    unsafe { device.CreateRenderTargetView(texture, Some(&desc), Some(&mut view))? };
    Ok(view.unwrap())
}

fn compile(source: &str, entry: &str, target: &str) -> Result<Vec<u8>, String> {
    let entry_c = format!("{entry}\0");
    let target_c = format!("{target}\0");
    let mut code: Option<ID3DBlob> = None;
    let mut errors: Option<ID3DBlob> = None;
    let result = unsafe {
        D3DCompile(
            source.as_ptr().cast(),
            source.len(),
            PCSTR(c"compose.hlsl".as_ptr().cast()),
            None,
            None,
            PCSTR(entry_c.as_ptr()),
            PCSTR(target_c.as_ptr()),
            D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    let text = |blob: &ID3DBlob| unsafe {
        String::from_utf8_lossy(std::slice::from_raw_parts(blob.GetBufferPointer().cast::<u8>(), blob.GetBufferSize())).trim().to_string()
    };
    match (result, code) {
        (Ok(()), Some(code)) => Ok(unsafe { std::slice::from_raw_parts(code.GetBufferPointer().cast::<u8>(), code.GetBufferSize()) }.to_vec()),
        (result, _) => Err(format!("{entry} did not compile: {}", errors.as_ref().map(text).unwrap_or_else(|| format!("{result:?}")))),
    }
}

/// The shaders and the parameters' buffer, made once per compositor.
struct Kernels {
    luma: ID3D11ComputeShader,
    chroma: ID3D11ComputeShader,
    vertex: ID3D11VertexShader,
    pixel: ID3D11PixelShader,
    params: ID3D11Buffer,
}

impl Kernels {
    fn new(device: &ID3D11Device) -> Result<Self, String> {
        let compute = |entry: &str| -> Result<ID3D11ComputeShader, String> {
            let code = compile(SHADER, entry, "cs_5_0")?;
            let mut shader = None;
            unsafe { device.CreateComputeShader(&code, None, Some(&mut shader)) }.map_err(|e| format!("{entry}: {e}"))?;
            Ok(shader.unwrap())
        };
        let (luma, chroma) = (compute(names::HLSL_LUMA)?, compute(names::HLSL_CHROMA)?);
        let code = compile(COPY, "vertex", "vs_5_0")?;
        let mut vertex = None;
        unsafe { device.CreateVertexShader(&code, None, Some(&mut vertex)) }.map_err(|e| format!("the copy's vertex shader: {e}"))?;
        let code = compile(COPY, "pixel", "ps_5_0")?;
        let mut pixel = None;
        unsafe { device.CreatePixelShader(&code, None, Some(&mut pixel)) }.map_err(|e| format!("the copy's pixel shader: {e}"))?;
        let desc = D3D11_BUFFER_DESC {
            ByteWidth: size_of::<ComposeParams>() as u32,
            Usage: D3D11_USAGE_DYNAMIC,
            BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
            CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
            MiscFlags: 0,
            StructureByteStride: 0,
        };
        let mut params = None;
        unsafe { device.CreateBuffer(&desc, None, Some(&mut params)) }.map_err(|e| format!("the parameters' buffer: {e}"))?;
        Ok(Self { luma, chroma, vertex: vertex.unwrap(), pixel: pixel.unwrap(), params: params.unwrap() })
    }
}

/// What one output size needs: the screen's frame in a readable texture, each plane as the kernels write it, and the
/// pool of composed frames.
struct Target {
    /// The output's size.
    size: (u32, u32),
    /// The screen's frame, at its own size, copied here (capture's textures are not readable by shaders).
    input: ID3D11Texture2D,
    input_luma: ID3D11ShaderResourceView,
    input_chroma: ID3D11ShaderResourceView,
    /// Made at the first frame of a device without a video processor, which uploads the screen from memory.
    upload: Option<ID3D11Texture2D>,
    luma: (ID3D11UnorderedAccessView, ID3D11ShaderResourceView),
    chroma: (ID3D11UnorderedAccessView, ID3D11ShaderResourceView),
    pool: Pool,
}

impl Target {
    fn new(device: &ID3D11Device, screen: (u32, u32), size: (u32, u32)) -> Result<Self, String> {
        let (width, height) = size;
        let input = texture(device, screen.0, screen.1, DXGI_FORMAT_NV12, D3D11_BIND_SHADER_RESOURCE, None).map_err(|e| format!("the screen's copy: {e}"))?;
        let plane = |width: u32, height: u32, format: DXGI_FORMAT| -> windows::core::Result<(ID3D11UnorderedAccessView, ID3D11ShaderResourceView)> {
            let texture = texture(device, width, height, format, D3D11_BIND_FLAG(D3D11_BIND_UNORDERED_ACCESS.0 | D3D11_BIND_SHADER_RESOURCE.0), None)?;
            let desc = D3D11_UNORDERED_ACCESS_VIEW_DESC {
                Format: format,
                ViewDimension: D3D11_UAV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_UNORDERED_ACCESS_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_UAV { MipSlice: 0 } },
            };
            let mut write = None;
            unsafe { device.CreateUnorderedAccessView(&texture, Some(&desc), Some(&mut write))? };
            Ok((write.unwrap(), shader_view(device, &texture, format)?))
        };
        Ok(Self {
            size,
            input_luma: shader_view(device, &input, DXGI_FORMAT_R8_UNORM).map_err(|e| format!("the screen's luma: {e}"))?,
            input_chroma: shader_view(device, &input, DXGI_FORMAT_R8G8_UNORM).map_err(|e| format!("the screen's chroma: {e}"))?,
            input,
            upload: None,
            luma: plane(width, height, DXGI_FORMAT_R8_UNORM).map_err(|e| format!("the luma plane: {e}"))?,
            chroma: plane(width / 2, height / 2, DXGI_FORMAT_R8G8_UNORM).map_err(|e| format!("the chroma plane: {e}"))?,
            pool: Arc::new(Mutex::new(Vec::new())),
        })
    }

    /// An output frame from the pool, or a new one.
    fn output(&self, device: &ID3D11Device) -> Result<ID3D11Texture2D, String> {
        match Captured::reuse(&self.pool) {
            Some(texture) => Ok(texture),
            None => texture(device, self.size.0, self.size.1, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET, None)
                .map_err(|e| format!("a composed frame could not be made: {e}")),
        }
    }
}

pub struct Compositor {
    gpu: Arc<Mta<Gpu>>,
    kernels: Kernels,
    size: (u32, u32),
    preview_size: (u32, u32),
    /// The full size's and the preview's, each used by one thread at a time (the encoder's, the preview's).
    full: Mutex<Target>,
    preview: Mutex<Target>,
    /// Screens kept in memory on a device without a video processor, read back to be uploaded.
    readback: Mutex<(Readback, Vec<u8>)>,
    layout: Mutex<Layout>,
    /// Hidden from the tray (D13): the camera stays open and nothing of it is composed.
    hidden: AtomicBool,
    camera: Arc<Feed>,
    /// The camera's picture's age in the recording's frames, for the log.
    ages: CameraAges,
}

impl Compositor {
    /// A compositor for `width` × `height` frames, taking the camera's newest frame from `camera`.
    pub fn new(gpu: Arc<Mta<Gpu>>, width: u32, height: u32, layout: Layout, camera: Arc<Feed>) -> Result<Self, String> {
        let preview_size = camera_layout::preview_size(width, height);
        let device = &gpu.0.device;
        Ok(Self {
            kernels: Kernels::new(device)?,
            full: Mutex::new(Target::new(device, (width, height), (width, height))?),
            preview: Mutex::new(Target::new(device, (width, height), preview_size)?),
            readback: Mutex::new((Readback::new(width, height), Vec::new())),
            size: (width, height),
            preview_size,
            layout: Mutex::new(layout.clamped()),
            hidden: AtomicBool::new(false),
            camera,
            ages: CameraAges::default(),
            gpu,
        })
    }

    pub fn layout(&self) -> Layout {
        *self.layout.lock().unwrap()
    }

    /// A new layout, from the next frame composed on (D7).
    pub fn set_layout(&self, layout: Layout) {
        *self.layout.lock().unwrap() = layout.clamped();
    }

    pub fn hidden(&self) -> bool {
        self.hidden.load(Ordering::Acquire)
    }

    /// Hides or shows the camera from the next frame on (D13).
    pub fn set_hidden(&self, hidden: bool) {
        self.hidden.store(hidden, Ordering::Release);
    }

    pub fn preview_size(&self) -> (u32, u32) {
        self.preview_size
    }

    /// The frame to encode in place of `screen`, at `at_ns` host time.
    pub fn compose(&self, screen: &Frame, at_ns: u64) -> Result<Frame, String> {
        self.render(screen, &self.full, Some(at_ns), true)
    }

    /// The picture of `screen` at preview size in `view` (plan 092, D3), for the preview's encoder.
    pub fn preview(&self, screen: &Frame, view: PreviewView) -> Result<Frame, String> {
        self.render(screen, &self.preview, None, view.shows_camera())
    }

    /// The camera's age in the frames composed so far, for the log.
    pub fn camera_ages(&self) -> Option<String> {
        self.ages.summary()
    }

    /// `at_ns`: the recording's frame's host time, whose camera's age is kept; none for the preview. `camera`: whether
    /// the camera may be drawn, which only the preview's Screen view refuses (plan 092, D3).
    fn render(&self, screen: &Frame, target: &Mutex<Target>, at_ns: Option<u64>, camera: bool) -> Result<Frame, String> {
        let mut target = target.lock().unwrap();
        let gpu = &self.gpu.0;
        // Nothing while the camera is lost (D12) or hidden (D13), or in the Screen view: the screen alone.
        let camera = if self.hidden() || !camera { None } else { self.camera.latest() };
        if let (Some(at_ns), Some((_, captured_ns))) = (at_ns, camera.as_ref()) {
            self.ages.record(at_ns, *captured_ns);
        }
        let camera = camera.map(|(frame, _)| frame);
        let params = camera_layout::compose_params(&self.layout(), self.size, target.size, camera.as_ref().map(|frame| frame.0.image));
        let output = target.output(&gpu.device)?;
        let output_luma = target_view(&gpu.device, &output, DXGI_FORMAT_R8_UNORM).map_err(|e| format!("the output's luma: {e}"))?;
        let output_chroma = target_view(&gpu.device, &output, DXGI_FORMAT_R8G8_UNORM).map_err(|e| format!("the output's chroma: {e}"))?;
        // In memory on a device without a video processor: converted as the encoder would, to be uploaded.
        let screen_bytes = match screen.0.image {
            Image::Nv12 => None,
            Image::Bgra { .. } => {
                let mut guard = self.readback.lock().unwrap();
                let (readback, bytes) = &mut *guard;
                readback.read(gpu, &screen.0, bytes)?;
                Some(bytes.clone())
            }
        };
        let context = gpu.context.lock().unwrap();
        let Target { input, upload, .. } = &mut *target;
        self.fill(&context, input, upload, screen, screen_bytes.as_deref(), self.size)?;
        let source = (target.input_luma.clone(), target.input_chroma.clone());
        unsafe {
            let mapped = {
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                context.Map(&self.kernels.params, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut mapped)).map_err(|e| format!("the parameters: {e}"))?;
                mapped
            };
            std::ptr::copy_nonoverlapping(std::ptr::from_ref(&params).cast::<u8>(), mapped.pData.cast::<u8>(), size_of::<ComposeParams>());
            context.Unmap(&self.kernels.params, 0);
            // Without a camera frame the kernels read the screen in its place and cover nothing with it.
            let (camera_luma, camera_chroma) = match camera.as_ref() {
                Some(frame) => (frame.0.luma.clone(), frame.0.chroma.clone()),
                None => (source.0.clone(), source.1.clone()),
            };
            context.CSSetConstantBuffers(0, Some(&[Some(self.kernels.params.clone())]));
            context.CSSetShaderResources(1, Some(&[Some(source.0.clone()), Some(source.1.clone()), Some(camera_luma), Some(camera_chroma)]));
            let (width, height) = target.size;
            for (shader, slot, view, (w, h)) in
                [(&self.kernels.luma, 5, &target.luma.0, (width, height)), (&self.kernels.chroma, 6, &target.chroma.0, (width / 2, height / 2))]
            {
                context.CSSetShader(shader, None);
                context.CSSetUnorderedAccessViews(slot, 1, Some(&Some(view.clone())), None);
                context.Dispatch(w.div_ceil(16), h.div_ceil(16), 1);
                context.CSSetUnorderedAccessViews(slot, 1, Some(&None), None);
            }
            context.CSSetShaderResources(1, Some(&[None, None, None, None]));
            context.CSSetShader(None, None);
            // Each plane into the output's, one triangle over the whole of it.
            context.IASetInputLayout(None);
            context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            context.VSSetShader(&self.kernels.vertex, None);
            context.PSSetShader(&self.kernels.pixel, None);
            for (view, plane, (w, h)) in [(&output_luma, &target.luma.1, (width, height)), (&output_chroma, &target.chroma.1, (width / 2, height / 2))] {
                context.OMSetRenderTargets(Some(&[Some(view.clone())]), None);
                context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                    TopLeftX: 0.0,
                    TopLeftY: 0.0,
                    Width: w as f32,
                    Height: h as f32,
                    MinDepth: 0.0,
                    MaxDepth: 1.0,
                }]));
                context.PSSetShaderResources(0, Some(&[Some(plane.clone())]));
                context.Draw(3, 0);
            }
            context.PSSetShaderResources(0, Some(&[None]));
            context.OMSetRenderTargets(None, None);
            context.VSSetShader(None, None);
            context.PSSetShader(None, None);
        }
        Ok(Arc::new(Mta(Captured::pooled(output, target.pool.clone()))))
    }

    /// Puts `screen` into `input`: copied on the GPU, or its NV12 bytes uploaded through a staging texture.
    fn fill(
        &self,
        context: &ID3D11DeviceContext,
        input: &ID3D11Texture2D,
        upload: &mut Option<ID3D11Texture2D>,
        screen: &Frame,
        bytes: Option<&[u8]>,
        (width, height): (u32, u32),
    ) -> Result<(), String> {
        let Some(bytes) = bytes else {
            unsafe { context.CopyResource(input, &screen.0.texture) };
            return Ok(());
        };
        if upload.is_none() {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
                MiscFlags: 0,
            };
            let mut made = None;
            unsafe { self.gpu.0.device.CreateTexture2D(&desc, None, Some(&mut made)) }.map_err(|e| format!("the screen's upload: {e}"))?;
            *upload = made;
        }
        let staging = upload.as_ref().unwrap();
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { context.Map(staging, 0, D3D11_MAP_WRITE, 0, Some(&mut mapped)) }.map_err(|e| format!("uploading the screen: {e}"))?;
        let (pitch, width) = (mapped.RowPitch as usize, width as usize);
        // The chroma plane follows the luma plane's `height` rows of `pitch` bytes, as Readback reads it.
        for row in 0..(height as usize) * 3 / 2 {
            unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr().add(row * width), mapped.pData.cast::<u8>().add(row * pitch), width) };
        }
        unsafe {
            context.Unmap(staging, 0);
            context.CopyResource(input, staging);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::Events;

    const W: u32 = 320;
    const H: u32 = 180;
    const DARK: u8 = 40;
    const BRIGHT: u8 = 220;

    struct Quiet;
    impl Events for Quiet {
        fn progress(&self, _bytes: u64) {}
        fn write_failed(&self, _failure: crate::writer::WriteFailure) {}
        fn capture_failed(&self, _code: &'static str, _detail: String) {}
        fn microphone_lost(&self, _detail: String) {}
        fn microphone_resumed(&self, _detail: String) {}
    }

    fn gpu() -> Arc<Mta<Gpu>> {
        super::super::com();
        Gpu::new().expect("a Direct3D 11 device (WARP on a runner)")
    }

    /// NV12 bytes: luma from `luma(x, y)`, chroma `cbcr` everywhere.
    fn nv12(width: u32, height: u32, luma: impl Fn(u32, u32) -> u8, (cb, cr): (u8, u8)) -> Vec<u8> {
        let mut data: Vec<u8> = (0..height).flat_map(|y| (0..width).map(move |x| (x, y))).map(|(x, y)| luma(x, y)).collect();
        data.extend((0..width * height / 4).flat_map(|_| [cb, cr]));
        data
    }

    /// A screen frame as capture makes it: an NV12 texture for the video processor only.
    fn screen(gpu: &Gpu, data: &[u8], width: u32, height: u32) -> Frame {
        let initial = D3D11_SUBRESOURCE_DATA { pSysMem: data.as_ptr().cast(), SysMemPitch: width, SysMemSlicePitch: 0 };
        let texture = texture(&gpu.device, width, height, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET, Some(&initial)).unwrap();
        Arc::new(Mta(Captured::detached(texture, Image::Nv12)))
    }

    fn compositor(gpu: &Arc<Mta<Gpu>>, layout: Layout, width: u32, height: u32) -> (Compositor, Arc<Feed>) {
        let feed = Arc::new(Feed::default());
        (Compositor::new(gpu.clone(), width, height, layout, feed.clone()).unwrap(), feed)
    }

    fn deliver(gpu: &Gpu, feed: &Feed, luma: impl Fn(u32, u32) -> u8, cbcr: (u8, u8)) {
        let image = CameraImage { width: 128, height: 72, bt601: false };
        let frame = CameraFrame::from_nv12(gpu, image, &nv12(128, 72, luma, cbcr)).unwrap();
        feed.deliver(Arc::new(Mta(frame)), 1, 1, &Quiet);
    }

    fn read(gpu: &Gpu, frame: &Frame, width: u32, height: u32) -> Vec<u8> {
        let mut out = Vec::new();
        Readback::new(width, height).read(gpu, &frame.0, &mut out).unwrap();
        out
    }

    fn near(value: u8, expected: u8) -> bool {
        value.abs_diff(expected) <= 12
    }

    #[test]
    fn without_a_camera_frame_the_screen_is_unchanged_byte_for_byte() {
        let gpu = gpu();
        let (compositor, _) = compositor(&gpu, Layout::default(), W, H);
        let data = nv12(W, H, |x, y| (x * 7 + y * 3) as u8, (90, 170));
        let out = compositor.compose(&screen(&gpu.0, &data, W, H), 0).unwrap();
        assert!(read(&gpu.0, &out, W, H) == data, "the composed frame differs from the screen's");
    }

    #[test]
    fn the_camera_fills_its_rounded_bubble_and_nothing_else() {
        let gpu = gpu();
        let layout = Layout { width: 0.5, height: 0.5, rounding: 1.0, x: 0.5, y: 0.5, mirror: false };
        let (compositor, feed) = compositor(&gpu, layout, W, H);
        deliver(&gpu.0, &feed, |_, _| BRIGHT, (200, 60));
        let out = compositor.compose(&screen(&gpu.0, &nv12(W, H, |_, _| DARK, (90, 170)), W, H), 0).unwrap();
        let data = read(&gpu.0, &out, W, H);
        let luma = |x: usize, y: usize| data[y * W as usize + x];
        let chroma = |x: usize, y: usize| {
            let at = (W * H) as usize + (y / 2) * W as usize + (x / 2) * 2;
            (data[at], data[at + 1])
        };
        let bubble = layout.bubble(W, H);
        let (cx, cy) = ((bubble.x + bubble.width / 2.0) as usize, (bubble.y + bubble.height / 2.0) as usize);
        assert!(near(luma(cx, cy), BRIGHT), "centre {}", luma(cx, cy));
        assert!(near(luma(bubble.x as usize + 2, bubble.y as usize + 2), DARK), "outside the circle {}", luma(bubble.x as usize + 2, bubble.y as usize + 2));
        assert!(near(luma(5, 5), DARK));
        let (cb, cr) = chroma(cx, cy);
        assert!(near(cb, 200) && near(cr, 60), "the camera's colour {cb} {cr}");
        let (cb, cr) = chroma(5, 5);
        assert!(cb == 90 && cr == 170, "the screen's colour {cb} {cr}");
    }

    #[test]
    fn hidden_composes_nothing_and_a_new_layout_lands_on_the_next_frame() {
        let gpu = gpu();
        let corner = Layout { width: 0.3, height: 0.3, rounding: 0.0, x: 0.0, y: 0.0, mirror: false };
        let (compositor, feed) = compositor(&gpu, corner, W, H);
        deliver(&gpu.0, &feed, |_, _| BRIGHT, (128, 128));
        let data = nv12(W, H, |_, _| DARK, (128, 128));
        let first = read(&gpu.0, &compositor.compose(&screen(&gpu.0, &data, W, H), 0).unwrap(), W, H);
        assert!(near(first[W as usize + 1], BRIGHT), "top-left {}", first[W as usize + 1]);
        compositor.set_hidden(true);
        assert!(read(&gpu.0, &compositor.compose(&screen(&gpu.0, &data, W, H), 0).unwrap(), W, H) == data, "hidden: the screen alone");
        compositor.set_hidden(false);
        compositor.set_layout(Layout { x: 1.0, y: 1.0, ..corner });
        let moved = read(&gpu.0, &compositor.compose(&screen(&gpu.0, &data, W, H), 0).unwrap(), W, H);
        assert!(near(moved[W as usize + 1], DARK) && near(moved[(H as usize - 2) * W as usize + W as usize - 2], BRIGHT));
    }

    #[test]
    fn mirroring_flips_the_camera_left_to_right() {
        let gpu = gpu();
        let layout = Layout { width: 0.5, height: 0.5, rounding: 0.0, x: 0.5, y: 0.5, mirror: false };
        let bubble = layout.bubble(W, H);
        let (left, right, y) = (bubble.x as usize + 10, (bubble.x + bubble.width) as usize - 10, (bubble.y + bubble.height / 2.0) as usize);
        for mirror in [false, true] {
            let (compositor, feed) = compositor(&gpu, Layout { mirror, ..layout }, W, H);
            deliver(&gpu.0, &feed, |x, _| if x < 64 { BRIGHT } else { DARK }, (128, 128));
            let data = read(&gpu.0, &compositor.compose(&screen(&gpu.0, &nv12(W, H, |_, _| 128, (128, 128)), W, H), 0).unwrap(), W, H);
            let (l, r) = (data[y * W as usize + left], data[y * W as usize + right]);
            assert!(if mirror { near(l, DARK) && near(r, BRIGHT) } else { near(l, BRIGHT) && near(r, DARK) }, "mirror {mirror}: {l} {r}");
        }
    }

    #[test]
    fn the_preview_is_the_composed_picture_scaled_down() {
        let gpu = gpu();
        let layout = Layout { width: 0.3, height: 0.3, rounding: 0.0, x: 1.0, y: 1.0, mirror: false };
        let (compositor, feed) = compositor(&gpu, layout, 1280, 720);
        assert_eq!(compositor.preview_size(), (960, 540));
        deliver(&gpu.0, &feed, |_, _| BRIGHT, (128, 128));
        let preview = compositor.preview(&screen(&gpu.0, &nv12(1280, 720, |_, _| DARK, (128, 128)), 1280, 720), PreviewView::Composed).unwrap();
        let data = read(&gpu.0, &preview, 960, 540);
        assert!(near(data[530 * 960 + 950], BRIGHT), "{}", data[530 * 960 + 950]);
        assert!(near(data[10 * 960 + 10], DARK));
        assert!(data[960 * 540..].iter().all(|&c| c.abs_diff(128) <= 4));
    }

    #[test]
    fn the_screen_view_leaves_the_camera_out_of_the_preview_only() {
        let gpu = gpu();
        let layout = Layout { width: 0.3, height: 0.3, rounding: 0.0, x: 1.0, y: 1.0, mirror: false };
        let (compositor, feed) = compositor(&gpu, layout, 1280, 720);
        deliver(&gpu.0, &feed, |_, _| BRIGHT, (128, 128));
        let data = nv12(1280, 720, |_, _| DARK, (128, 128));
        let shown = |view| read(&gpu.0, &compositor.preview(&screen(&gpu.0, &data, 1280, 720), view).unwrap(), 960, 540)[530 * 960 + 950];
        assert!(near(shown(PreviewView::Screen), DARK), "Screen: no camera {}", shown(PreviewView::Screen));
        // The recording in between is the composed picture whatever the preview shows.
        let full = read(&gpu.0, &compositor.compose(&screen(&gpu.0, &data, 1280, 720), 0).unwrap(), 1280, 720);
        assert!(near(full[710 * 1280 + 1270], BRIGHT), "the recording keeps the camera {}", full[710 * 1280 + 1270]);
        assert!(near(shown(PreviewView::Composed), BRIGHT), "Composed: the camera again");
    }

    #[test]
    fn a_screen_in_memory_is_uploaded_and_composed() {
        // A device without a video processor keeps the screen as BGRA in a staging texture (capture.rs).
        let gpu = gpu();
        let bgra: Vec<u8> = (0..W * H).flat_map(|_| [128u8, 128, 128, 255]).collect();
        let desc = D3D11_TEXTURE2D_DESC {
            Width: W,
            Height: H,
            MipLevels: 1,
            ArraySize: 1,
            Format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: (D3D11_CPU_ACCESS_READ.0 | D3D11_CPU_ACCESS_WRITE.0) as u32,
            MiscFlags: 0,
        };
        let initial = D3D11_SUBRESOURCE_DATA { pSysMem: bgra.as_ptr().cast(), SysMemPitch: W * 4, SysMemSlicePitch: 0 };
        let mut staging = None;
        unsafe { gpu.0.device.CreateTexture2D(&desc, Some(&initial), Some(&mut staging)) }.unwrap();
        let frame: Frame = Arc::new(Mta(Captured::detached(staging.unwrap(), Image::Bgra { width: W, height: H })));
        let expected = read(&gpu.0, &frame, W, H);
        let (compositor, _) = compositor(&gpu, Layout::default(), W, H);
        assert!(read(&gpu.0, &compositor.compose(&frame, 0).unwrap(), W, H) == expected, "the uploaded screen differs");
    }
}
