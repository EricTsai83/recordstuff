//! A GPU's hardware H.264 encoder through Media Foundation (plan 078 step 4): an asynchronous transform on the
//! capture device's adapter, fed the converted NV12 textures where they are, so frames never come back to memory.
//! encoder_choice.rs decides whether it is used and async_encoder.rs drives it; this module finds it, opens it, turns
//! its events into the driver's messages and tests it before a recording.
//!
//! Untested on real GPUs: CI's Windows runner has none, so enumeration finds nothing there and the software encoder
//! records. NVIDIA's and Intel's encoders, the picture they produce and the processor time they save are fixed from
//! users' reports (plan 078).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows::Win32::Foundation::LUID;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, CoTaskMemFree};
use windows::core::{IUnknownImpl, Interface, implement};

use super::capture::{Captured, Frame, Gpu, Image};
use super::mft::{bytes, outputs, pack, sample, set_codec, set_codec_flag};
use super::{Mta, com};
use crate::async_encoder::{AsyncTransform, EncoderEvent, Ended, Message, Output, Watchdog, drive};
use crate::avc;
use crate::core::VideoSink;
use crate::encoder_choice::Adapter;
use crate::writer::Media;

/// The capture device's adapter and its LUID, which hardware encoders are listed by.
pub fn adapter(gpu: &Gpu) -> Option<(Adapter, LUID)> {
    let dxgi: IDXGIDevice = gpu.device.cast().ok()?;
    let adapter = unsafe { dxgi.GetAdapter() }.ok()?;
    let desc = unsafe { adapter.GetDesc() }.ok()?;
    let driver = unsafe { adapter.CheckInterfaceSupport(&IDXGIDevice::IID) }.unwrap_or(0);
    let length = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
    let name = String::from_utf16_lossy(&desc.Description[..length]);
    Some((Adapter { vendor: desc.VendorId, device: desc.DeviceId, driver, name, software: gpu.software }, desc.AdapterLuid))
}

/// The first hardware H.264 encoder on the adapter `luid` that takes NV12, or none.
pub fn find(luid: LUID) -> Result<Option<IMFActivate>, String> {
    super::media_foundation().map_err(|e| e.detail)?;
    let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
    let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, 1) }.map_err(|e| format!("attributes: {e}"))?;
    let attributes = attributes.ok_or("no attributes")?;
    let mut bytes = [0u8; 8];
    bytes[..4].copy_from_slice(&luid.LowPart.to_le_bytes());
    bytes[4..].copy_from_slice(&luid.HighPart.to_le_bytes());
    unsafe { attributes.SetBlob(&MFT_ENUM_ADAPTER_LUID, &bytes) }.map_err(|e| format!("the adapter's LUID: {e}"))?;
    let mut found: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    unsafe {
        MFTEnum2(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input),
            Some(&output),
            &attributes,
            &mut found,
            &mut count,
        )
    }
    .map_err(|e| format!("listing hardware encoders: {e}"))?;
    if found.is_null() {
        return Ok(None);
    }
    let list = unsafe { std::slice::from_raw_parts_mut(found, count as usize) };
    let first = list.first_mut().and_then(Option::take);
    for entry in list.iter_mut() {
        drop(entry.take());
    }
    unsafe { CoTaskMemFree(Some(found as *const _)) };
    Ok(first)
}

/// Forwards the transform's events to the driver, asking for the next each time, until stopped.
#[implement(IMFAsyncCallback)]
struct Events {
    generator: Mta<IMFMediaEventGenerator>,
    messages: Mutex<Sender<Message<Frame>>>,
    stopped: Arc<AtomicBool>,
}

impl IMFAsyncCallback_Impl for Events_Impl {
    fn GetParameters(&self, _flags: *mut u32, _queue: *mut u32) -> windows::core::Result<()> {
        Err(windows::Win32::Foundation::E_NOTIMPL.into())
    }

    fn Invoke(&self, result: windows::core::Ref<IMFAsyncResult>) -> windows::core::Result<()> {
        let generator = self.generator.get();
        let event = match unsafe { generator.EndGetEvent(result.as_ref()) } {
            Ok(event) => event,
            // The transform shut down.
            Err(_) => return Ok(()),
        };
        let kind = unsafe { event.GetType() }.unwrap_or(0) as i32;
        let status = unsafe { event.GetStatus() }.unwrap_or_default();
        let message = if status.is_err() {
            Some(EncoderEvent::Error(format!("event {kind}: {status}")))
        } else if kind == METransformNeedInput.0 {
            Some(EncoderEvent::NeedInput)
        } else if kind == METransformHaveOutput.0 {
            Some(EncoderEvent::HaveOutput)
        } else if kind == METransformDrainComplete.0 {
            Some(EncoderEvent::DrainComplete)
        } else if kind == MEError.0 {
            Some(EncoderEvent::Error("MEError".into()))
        } else {
            None
        };
        if let Some(message) = message {
            let _ = self.messages.lock().unwrap().send(Message::Event(message));
        }
        if !self.stopped.load(Ordering::Acquire) {
            let this: IMFAsyncCallback = self.to_interface();
            unsafe { generator.BeginGetEvent(&this, None) }?;
        }
        Ok(())
    }
}

/// An open hardware encoder: its events go to the channel it was given.
pub struct HardwareTransform {
    activate: IMFActivate,
    transform: IMFTransform,
    codec: Option<ICodecAPI>,
    _manager: IMFDXGIDeviceManager,
    stopped: Arc<AtomicBool>,
}

unsafe impl Send for HardwareTransform {}

impl HardwareTransform {
    pub fn open(
        activate: &IMFActivate,
        gpu: &Gpu,
        (width, height, frame_rate, bitrate): (u32, u32, u32, u32),
        messages: Sender<Message<Frame>>,
    ) -> Result<Self, String> {
        com();
        let fail = |what: &'static str| move |e: windows::core::Error| format!("{what}: {e}");
        let transform: IMFTransform = unsafe { activate.ActivateObject() }.map_err(fail("opening the hardware encoder"))?;
        // Until `Self` owns it, a failure shuts the activated encoder down here.
        struct Activated<'a>(Option<&'a IMFActivate>);
        impl Drop for Activated<'_> {
            fn drop(&mut self) {
                if let Some(activate) = self.0 {
                    let _ = unsafe { activate.ShutdownObject() };
                }
            }
        }
        let mut activated = Activated(Some(activate));
        let attributes = unsafe { transform.GetAttributes() }.map_err(fail("its attributes"))?;
        if unsafe { attributes.GetUINT32(&MF_TRANSFORM_ASYNC) }.unwrap_or(0) == 0 {
            return Err("the hardware encoder is not asynchronous".into());
        }
        unsafe { attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1) }.map_err(fail("unlocking it"))?;
        let _ = unsafe { attributes.SetUINT32(&MF_LOW_LATENCY, 1) };

        let mut token = 0u32;
        let mut manager = None;
        unsafe { MFCreateDXGIDeviceManager(&mut token, &mut manager) }.map_err(fail("the DXGI device manager"))?;
        let manager = manager.ok_or("no DXGI device manager")?;
        unsafe { manager.ResetDevice(&gpu.device, token) }.map_err(fail("giving it the device"))?;
        unsafe { transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize) }.map_err(fail("giving the encoder the device"))?;

        let codec = transform.cast::<ICodecAPI>().ok();
        if let Some(codec) = codec.as_ref() {
            set_codec(codec, &CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_UnconstrainedVBR.0 as u32);
            set_codec(codec, &CODECAPI_AVEncCommonMeanBitRate, bitrate);
            set_codec(codec, &CODECAPI_AVEncMPVGOPSize, frame_rate);
            set_codec(codec, &CODECAPI_AVEncMPVDefaultBPictureCount, 0);
            set_codec_flag(codec, &CODECAPI_AVLowLatencyMode, true);
        }
        let shape = |kind: &IMFMediaType| -> windows::core::Result<()> {
            unsafe {
                kind.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
                kind.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
                kind.SetUINT64(&MF_MT_FRAME_RATE, pack(frame_rate, 1))?;
                kind.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
                kind.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
                kind.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
                kind.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
                kind.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
                kind.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)
            }
        };
        let output = unsafe { MFCreateMediaType() }.map_err(fail("a media type"))?;
        (|| -> windows::core::Result<()> {
            shape(&output)?;
            unsafe {
                output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
                output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
                output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
                transform.SetOutputType(0, &output, 0)
            }
        })()
        .map_err(fail("the H.264 output format was refused"))?;
        let input = unsafe { MFCreateMediaType() }.map_err(fail("a media type"))?;
        (|| -> windows::core::Result<()> {
            shape(&input)?;
            unsafe {
                input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
                transform.SetInputType(0, &input, 0)
            }
        })()
        .map_err(fail("the NV12 input format was refused"))?;

        // Owned before its events are listened to: from here every failure drops it, which stops the listening and
        // shuts the encoder down, so the callback and the generator holding each other are released (review of 078).
        let opened = Self { activate: activate.clone(), transform, codec, _manager: manager, stopped: Arc::new(AtomicBool::new(false)) };
        activated.0 = None;
        let generator: IMFMediaEventGenerator = opened.transform.cast().map_err(fail("its events"))?;
        let events: IMFAsyncCallback =
            Events { generator: Mta(generator.clone()), messages: Mutex::new(messages), stopped: opened.stopped.clone() }.into();
        unsafe { generator.BeginGetEvent(&events, None) }.map_err(fail("listening to its events"))?;
        unsafe {
            opened.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).map_err(fail("starting it"))?;
            opened.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0).map_err(fail("starting it"))?;
        }
        Ok(opened)
    }
}

impl AsyncTransform for HardwareTransform {
    type Frame = Frame;

    fn input(&mut self, frame: &Frame, time: i64, duration: i64, key_frame: bool) -> Result<(), String> {
        let captured: &Captured = frame.get();
        if !matches!(captured.image, Image::Nv12) {
            return Err("the frame is not an NV12 texture (the video processor is missing)".into());
        }
        if key_frame {
            if let Some(codec) = self.codec.as_ref() {
                set_codec(codec, &CODECAPI_AVEncVideoForceKeyFrame, 1);
            }
        }
        unsafe {
            let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &captured.texture, 0, false).map_err(|e| format!("a surface buffer: {e}"))?;
            let input = MFCreateSample().map_err(|e| format!("a sample: {e}"))?;
            input.AddBuffer(&buffer).map_err(|e| e.to_string())?;
            input.SetSampleTime(time).map_err(|e| e.to_string())?;
            input.SetSampleDuration(duration).map_err(|e| e.to_string())?;
            self.transform.ProcessInput(0, &input, 0).map_err(|e| e.to_string())
        }
    }

    fn output(&mut self) -> Result<Output, String> {
        let info = unsafe { self.transform.GetOutputStreamInfo(0) }.map_err(|e| e.to_string())?;
        let provides = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        let own = if provides {
            None
        } else {
            unsafe {
                let buffer = MFCreateMemoryBuffer(info.cbSize.max(1 << 20)).map_err(|e| e.to_string())?;
                let sample = MFCreateSample().map_err(|e| e.to_string())?;
                sample.AddBuffer(&buffer).map_err(|e| e.to_string())?;
                Some(sample)
            }
        };
        let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: std::mem::ManuallyDrop::new(own),
            dwStatus: 0,
            pEvents: std::mem::ManuallyDrop::new(None),
        }];
        let mut status = 0u32;
        let result = unsafe { self.transform.ProcessOutput(0, &mut buffers, &mut status) };
        let [mut buffer] = buffers;
        let produced = unsafe { std::mem::ManuallyDrop::take(&mut buffer.pSample) };
        drop(unsafe { std::mem::ManuallyDrop::take(&mut buffer.pEvents) });
        match result {
            Ok(()) => match produced {
                Some(produced) => {
                    let (data, time) = bytes(&produced).map_err(|e| format!("reading a sample: {e}"))?;
                    Ok(Output::Sample { data, time })
                }
                None => Ok(Output::Nothing),
            },
            Err(error) if error.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                let offered = unsafe { self.transform.GetOutputAvailableType(0, 0) }.map_err(|e| e.to_string())?;
                unsafe { self.transform.SetOutputType(0, &offered, 0) }.map_err(|e| e.to_string())?;
                Ok(Output::StreamChanged)
            }
            Err(error) if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => Ok(Output::Nothing),
            Err(error) => Err(error.to_string()),
        }
    }

    fn drain(&mut self) -> Result<(), String> {
        unsafe { self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0) }.map_err(|e| e.to_string())
    }
}

impl Drop for HardwareTransform {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            if let Ok(shutdown) = self.transform.cast::<IMFShutdown>() {
                let _ = shutdown.Shutdown();
            }
            let _ = self.activate.ShutdownObject();
        }
    }
}

struct Collect(Mutex<Vec<Media>>);

impl VideoSink for Collect {
    fn media(&self, media: Media) {
        self.0.lock().unwrap().push(media);
    }
    fn failed(&self, _detail: String) {}
}

/// Mid-grey in NV12 (Y, Cb and Cr all 128): what the self-test encodes and expects back.
const GREY: u8 = 128;
const SELF_TEST_FRAMES: u64 = 6;

/// The self-test (plan 078): a few grey frames at the recording's size through the hardware encoder, decoded back by
/// Microsoft's software decoder, and the picture checked, because some drivers open a session and then emit green or
/// black frames without an error. The frames are NV12 textures made as the video processor's are.
pub fn self_test(activate: &IMFActivate, gpu: &Arc<Mta<Gpu>>, width: u32, height: u32, frame_rate: u32) -> Result<(), String> {
    let (sender, messages) = channel();
    let mut transform = HardwareTransform::open(activate, &gpu.0, (width, height, frame_rate, 2_000_000), sender.clone())?;
    let texture = grey_texture(&gpu.0, width, height).map_err(|e| format!("a test texture: {e}"))?;
    let frame: Frame = Arc::new(Mta(Captured::detached(texture, Image::Nv12)));
    for n in 0..SELF_TEST_FRAMES {
        let _ = sender.send(Message::Frame { frame: frame.clone(), pts_ns: n * 1_000_000_000 / u64::from(frame_rate.max(1)), key_frame: n == 0 });
    }
    let (done, flushed) = channel();
    let _ = sender.send(Message::Flush(done));
    let closer = sender.clone();
    std::thread::spawn(move || {
        // Closes the driver once the drain is answered, or gives up after the watchdog would have.
        let _ = flushed.recv_timeout(Duration::from_secs(4));
        let _ = closer.send(Message::Close);
    });
    drop(sender);
    let sink = Arc::new(Collect(Mutex::new(Vec::new())));
    let as_sink: Arc<dyn VideoSink> = sink.clone();
    let watchdog = Watchdog { silence: Duration::from_secs(3), ..Watchdog::default() };
    if let Ended::Failed { detail, .. } = drive(&mut transform, &messages, &as_sink, (width, height, frame_rate), watchdog) {
        return Err(detail);
    }
    drop(transform);
    let media = std::mem::take(&mut *sink.0.lock().unwrap());
    let share = grey_share(&media, width, height)?;
    if share < 0.85 {
        return Err(format!("the decoded test picture was not grey ({:.0}% of its bytes near grey)", share * 100.0));
    }
    Ok(())
}

fn grey_texture(gpu: &Gpu, width: u32, height: u32) -> windows::core::Result<ID3D11Texture2D> {
    let data = vec![GREY; (width * height * 3 / 2) as usize];
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let initial = D3D11_SUBRESOURCE_DATA { pSysMem: data.as_ptr().cast(), SysMemPitch: width, SysMemSlicePitch: 0 };
    let mut texture = None;
    unsafe { gpu.device.CreateTexture2D(&desc, Some(&initial), Some(&mut texture))? };
    Ok(texture.unwrap())
}

/// The share of the last decoded picture's bytes within 16 of mid-grey: Microsoft's software H.264 decoder reads the
/// encoded samples back to NV12. A grey picture is nearly all of them; a black one keeps only its chroma (a third), a
/// green one none.
pub fn grey_share(media: &[Media], width: u32, height: u32) -> Result<f64, String> {
    let avcc = media
        .iter()
        .find_map(|m| if let Media::VideoFormat { avcc, .. } = m { Some(avcc.clone()) } else { None })
        .ok_or("the encoder produced no format")?;
    let samples: Vec<&Vec<u8>> = media.iter().filter_map(|m| if let Media::Video { data, .. } = m { Some(data) } else { None }).collect();
    if samples.is_empty() {
        return Err("the encoder produced no sample".into());
    }
    super::media_foundation().map_err(|e| e.detail)?;
    let decoder: IMFTransform =
        unsafe { CoCreateInstance(&CLSID_MSH264DecoderMFT, None, CLSCTX_INPROC_SERVER) }.map_err(|e| format!("the H.264 decoder: {e}"))?;
    let fail = |what: &'static str| move |e: windows::core::Error| format!("{what}: {e}");
    unsafe {
        let input = MFCreateMediaType().map_err(fail("a media type"))?;
        input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(fail("the decoder's input"))?;
        input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(fail("the decoder's input"))?;
        input.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height)).map_err(fail("the decoder's input"))?;
        decoder.SetInputType(0, &input, 0).map_err(fail("the decoder's input"))?;
        let mut index = 0;
        loop {
            let offered = decoder.GetOutputAvailableType(0, index).map_err(fail("the decoder offers no NV12"))?;
            if offered.GetGUID(&MF_MT_SUBTYPE).ok() == Some(MFVideoFormat_NV12) {
                decoder.SetOutputType(0, &offered, 0).map_err(fail("the decoder's output"))?;
                break;
            }
            index += 1;
        }
        decoder.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).map_err(fail("starting the decoder"))?;
    }
    let picture_bytes = width * (height + 15) / 16 * 16 * 3 / 2;
    let mut last = None;
    for (n, data) in samples.iter().enumerate() {
        let stream = avc::annex_b(&avcc, data, n == 0).ok_or("a sample could not be read back")?;
        let input = sample(&stream, n as i64 * 333_333, 333_333).map_err(fail("a decoder sample"))?;
        unsafe { decoder.ProcessInput(0, &input, 0) }.map_err(fail("decoding"))?;
        last = outputs(&decoder, picture_bytes).map_err(fail("decoding"))?.pop().or(last);
    }
    unsafe { decoder.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0) }.map_err(fail("draining the decoder"))?;
    last = outputs(&decoder, picture_bytes).map_err(fail("decoding"))?.pop().or(last);
    let (picture, _) = bytes(&last.ok_or("the decoder produced no picture")?).map_err(fail("reading the picture"))?;
    let near = picture.iter().filter(|&&b| b.abs_diff(GREY) <= 16).count();
    Ok(near as f64 / picture.len().max(1) as f64)
}
