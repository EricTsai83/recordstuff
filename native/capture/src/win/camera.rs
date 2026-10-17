//! The camera on Windows (plan 075, D12, D16): Media Foundation's source reader in the engine, NV12 near 1280×720 at
//! up to 30 frames a second (the reader decodes a camera's MJPEG and scales, `ENABLE_ADVANCED_VIDEO_PROCESSING`), read
//! on a thread of its own, uploaded to the GPU and stamped on the host clock as each frame arrives. Each frame goes to
//! the core's `CameraFeed`, which keeps the newest only and tells the camera's loss and return; the compositor takes
//! the newest frame when it encodes one.
//!
//! Windows has no system default camera: the first one Media Foundation lists stands for it (D9). A camera is found
//! by its symbolic link, which stays the same while it is connected to the same port.
//!
//! A read that fails (the camera unplugged, its access withdrawn in Settings > Privacy & security > Camera, or taken
//! by another app that holds it exclusively) is a loss told at once; a camera that stalls is told lost by its silence
//! (the core's 2 s), and its source is then shut down, which ends a read that waits for it. The read thread then opens
//! the same camera again, by its symbolic link and never another, after 2 s and backing off to 30 s, the waits starting
//! over once a camera opened again has delivered. Closing shuts the media source down, which ends a read in progress
//! and turns the camera's light off.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows::Win32::Foundation::E_ACCESSDENIED;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::core::{GUID, Interface, PCWSTR, PWSTR};

use super::capture::Gpu;
use super::compositor::{CameraFrame, Feed};
use super::{CaptureError, Mta, com, media_foundation, now_ns};
use crate::camera_layout::CameraImage;
use crate::core::{CAMERA_SILENT_NS, CameraControl, Events};

/// The waits between attempts to open a lost camera again, the last repeated.
const BACKOFF: [Duration; 5] = [Duration::from_secs(2), Duration::from_secs(4), Duration::from_secs(8), Duration::from_secs(16), Duration::from_secs(30)];
/// How long `start` waits for the camera's first frame or its refusal before going on without either.
const FIRST_READ: Duration = Duration::from_secs(3);
const WANTED: (u32, u32) = (1280, 720);
const STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

fn unavailable(detail: impl Into<String>) -> CaptureError {
    CaptureError::new("camera_unavailable", format!("camera: {}", detail.into()))
}

/// Media Foundation's refusal, worded: E_ACCESSDENIED is Settings > Privacy & security > Camera refusing desktop apps.
fn refused(what: &str, e: &windows::core::Error) -> String {
    if e.code() == E_ACCESSDENIED {
        "access is not allowed (Settings > Privacy & security > Camera)".into()
    } else {
        format!("{what} ({e})")
    }
}

/// A camera as Media Foundation lists it.
struct Device {
    link: String,
    name: String,
}

fn string(activate: &IMFActivate, key: &GUID) -> Option<String> {
    let (mut value, mut length) = (PWSTR::null(), 0u32);
    unsafe { activate.GetAllocatedString(key, &mut value, &mut length) }.ok()?;
    let text = unsafe { value.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    text
}

fn video_capture_attributes() -> windows::core::Result<IMFAttributes> {
    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, 2)? };
    let attributes = attributes.unwrap();
    unsafe { attributes.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)? };
    Ok(attributes)
}

fn devices() -> windows::core::Result<Vec<Device>> {
    let attributes = video_capture_attributes()?;
    let (mut list, mut count) = (std::ptr::null_mut(), 0u32);
    unsafe { MFEnumDeviceSources(&attributes, &mut list, &mut count)? };
    let mut found = Vec::new();
    for index in 0..count as usize {
        let activate = unsafe { (*list.add(index)).take() };
        if let Some(activate) = activate {
            let link = string(&activate, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK);
            let name = string(&activate, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME);
            if let (Some(link), Some(name)) = (link, name) {
                found.push(Device { link, name });
            }
        }
    }
    unsafe { CoTaskMemFree(Some(list.cast())) };
    Ok(found)
}

/// The cameras connected now, the first marked as the default (D9). Listing asks for no access.
pub fn list() -> Vec<crate::core::Camera> {
    com();
    if media_foundation().is_err() {
        return Vec::new();
    }
    devices()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, device)| crate::core::Camera { id: device.link, name: device.name, default: index == 0 })
        .collect()
}

/// Two 32-bit values packed in an attribute, as Media Foundation stores sizes and rates.
fn pair(media_type: &IMFMediaType, key: &GUID) -> Option<(u32, u32)> {
    let packed = unsafe { media_type.GetUINT64(key) }.ok()?;
    Some(((packed >> 32) as u32, packed as u32))
}

/// The camera's own format nearest 1280×720 at a rate of at least 15 frames a second, at most 30 preferred.
fn choose_native(reader: &IMFSourceReader) -> Option<IMFMediaType> {
    let mut best: Option<(u64, IMFMediaType)> = None;
    for index in 0.. {
        let Ok(media_type) = (unsafe { reader.GetNativeMediaType(STREAM, index) }) else { break };
        let Some((width, height)) = pair(&media_type, &MF_MT_FRAME_SIZE) else { continue };
        let rate = pair(&media_type, &MF_MT_FRAME_RATE).map_or(0.0, |(n, d)| f64::from(n) / f64::from(d.max(1)));
        let size_miss = u64::from(width.abs_diff(WANTED.0)) + u64::from(height.abs_diff(WANTED.1));
        let rate_miss = if rate < 15.0 { 10_000 } else if rate > 30.5 { 100 } else { ((30.0 - rate) * 10.0) as u64 };
        let score = size_miss * 10 + rate_miss;
        if best.as_ref().is_none_or(|(least, _)| score < *least) {
            best = Some((score, media_type));
        }
    }
    best.map(|(_, media_type)| media_type)
}

/// An opened camera: its media source, which `close` shuts down, and its reader.
struct Opened {
    source: Mta<IMFMediaSource>,
    reader: Mta<IMFSourceReader>,
    image: CameraImage,
    /// Bytes from one row to the next in a buffer without a 2D view (`MF_MT_DEFAULT_STRIDE`, else the width).
    stride: usize,
}

/// The rows' stride a media type says, at least `width`.
fn stride_of(media_type: Option<&IMFMediaType>, width: u32) -> usize {
    let stride = media_type.and_then(|current| unsafe { current.GetUINT32(&MF_MT_DEFAULT_STRIDE) }.ok()).map(|stride| (stride as i32).unsigned_abs());
    stride.unwrap_or(width).max(width) as usize
}

/// Opens the camera with symbolic link `link` and sets its reader to NV12.
fn open(link: &str) -> Result<Opened, String> {
    let attributes = video_capture_attributes().map_err(|e| format!("attributes ({e})"))?;
    let wide: Vec<u16> = link.encode_utf16().chain([0]).collect();
    unsafe { attributes.SetString(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, PCWSTR(wide.as_ptr())) }.map_err(|e| format!("attributes ({e})"))?;
    let source = unsafe { MFCreateDeviceSource(&attributes) }.map_err(|e| refused("it could not be opened", &e))?;
    let shut = |detail: String| {
        let _ = unsafe { source.Shutdown() };
        detail
    };
    let mut reader_attributes = None;
    unsafe { MFCreateAttributes(&mut reader_attributes, 1) }.map_err(|e| shut(format!("reader attributes ({e})")))?;
    let reader_attributes = reader_attributes.unwrap();
    unsafe { reader_attributes.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1) }.map_err(|e| shut(format!("reader attributes ({e})")))?;
    let reader = unsafe { MFCreateSourceReaderFromMediaSource(&source, &reader_attributes) }.map_err(|e| shut(refused("no reader", &e)))?;
    if let Some(native) = choose_native(&reader) {
        // A format the camera cannot take leaves its default, which the reader still converts.
        let _ = unsafe { reader.SetCurrentMediaType(STREAM, None, &native) };
    }
    let size = unsafe { reader.GetCurrentMediaType(STREAM) }.ok().and_then(|current| pair(&current, &MF_MT_FRAME_SIZE)).unwrap_or(WANTED);
    // NV12 needs even dimensions.
    let (width, height) = (size.0 & !1, size.1 & !1);
    let output = unsafe { MFCreateMediaType() }.map_err(|e| shut(format!("a media type ({e})")))?;
    let set = || -> windows::core::Result<()> {
        unsafe {
            output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            output.SetUINT64(&MF_MT_FRAME_SIZE, (u64::from(width) << 32) | u64::from(height))?;
            reader.SetCurrentMediaType(STREAM, None, &output)
        }
    };
    set().map_err(|e| shut(format!("it gives no NV12 frames ({e})")))?;
    // BT.601 unless the camera says otherwise: webcams' MJPEG and YUV are.
    let current = unsafe { reader.GetCurrentMediaType(STREAM) }.ok();
    let matrix = current.as_ref().and_then(|current| unsafe { current.GetUINT32(&MF_MT_YUV_MATRIX) }.ok());
    let bt601 = matrix != Some(MFVideoTransferMatrix_BT709.0 as u32);
    let stride = stride_of(current.as_ref(), width);
    Ok(Opened { source: Mta(source), reader: Mta(reader), image: CameraImage { width, height, bt601 }, stride })
}

/// One sample's NV12 bytes, tightly packed, from a buffer whose rows may be padded: by its 2D view's pitch, else by
/// `stride`, the media type's.
fn nv12(sample: &IMFSample, image: CameraImage, stride: usize, out: &mut Vec<u8>) -> Result<(), String> {
    let buffer = unsafe { sample.ConvertToContiguousBuffer() }.map_err(|e| e.to_string())?;
    let (width, height) = (image.width as usize, image.height as usize);
    let rows = height + height / 2;
    out.clear();
    if let Ok(two_d) = buffer.cast::<IMF2DBuffer>() {
        let (mut base, mut pitch) = (std::ptr::null_mut(), 0i32);
        unsafe { two_d.Lock2D(&mut base, &mut pitch) }.map_err(|e| e.to_string())?;
        // The chroma rows follow the luma plane's `height` rows of `pitch` bytes (negative: from the bottom up).
        for row in 0..rows {
            out.extend_from_slice(unsafe { std::slice::from_raw_parts(base.offset(row as isize * pitch as isize), width) });
        }
        unsafe { two_d.Unlock2D() }.map_err(|e| e.to_string())?;
        return Ok(());
    }
    let (mut base, mut length) = (std::ptr::null_mut(), 0u32);
    unsafe { buffer.Lock(&mut base, None, Some(&mut length)) }.map_err(|e| e.to_string())?;
    let needed = stride * (rows - 1) + width;
    if (length as usize) < needed {
        let _ = unsafe { buffer.Unlock() };
        return Err(format!("a {width}x{height} frame of {length} bytes, at a stride of {stride}"));
    }
    for row in 0..rows {
        out.extend_from_slice(unsafe { std::slice::from_raw_parts(base.add(row * stride), width) });
    }
    unsafe { buffer.Unlock() }.map_err(|e| e.to_string())?;
    Ok(())
}

struct Inner {
    gpu: Arc<Mta<Gpu>>,
    feed: Arc<Feed>,
    events: Arc<dyn Events>,
    recording: Box<dyn Fn() -> bool + Send + Sync>,
    link: String,
    /// The source being read, shut down by `close`.
    source: Mutex<Option<Mta<IMFMediaSource>>>,
    closed: AtomicBool,
    /// The open source was shut down for its silence (`silence`), so it is not shut down again.
    silenced: AtomicBool,
    /// Host time the open source opened or last delivered.
    heard_ns: AtomicU64,
    reopened: AtomicU64,
    failed_reads: AtomicU64,
}

impl Inner {
    /// Reads `opened` until it fails or the camera is closed; `first` hears the first frame's arrival or the failure.
    /// Answers whether it delivered a frame.
    fn read(&self, opened: Opened, first: &mut Option<std::sync::mpsc::Sender<Result<(), String>>>) -> bool {
        *self.source.lock().unwrap() = Some(Mta(opened.source.0.clone()));
        self.heard_ns.store(now_ns(), Ordering::Release);
        self.silenced.store(false, Ordering::Release);
        if self.closed.load(Ordering::Acquire) {
            let _ = unsafe { opened.source.0.Shutdown() };
            return false;
        }
        let mut delivered = false;
        let mut image = opened.image;
        let mut stride = opened.stride;
        let mut bytes = Vec::new();
        loop {
            let (mut flags, mut sample) = (0u32, None);
            let read = unsafe { opened.reader.0.ReadSample(STREAM, 0, None, Some(&mut flags), None, Some(&mut sample)) };
            if self.closed.load(Ordering::Acquire) {
                break;
            }
            let failure = match read {
                Err(e) => Some(refused("a read failed", &e)),
                Ok(()) if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 => Some("the camera reported an error".into()),
                Ok(()) if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 => Some("the camera's stream ended".into()),
                Ok(()) => None,
            };
            if let Some(detail) = failure {
                self.failed_reads.fetch_add(1, Ordering::Relaxed);
                match first.take() {
                    Some(first) => {
                        let _ = first.send(Err(detail));
                    }
                    None => self.feed.lose(detail, (self.recording)(), &*self.events),
                }
                break;
            }
            if flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32 != 0 {
                let current = unsafe { opened.reader.0.GetCurrentMediaType(STREAM) }.ok();
                if let Some((width, height)) = current.as_ref().and_then(|current| pair(current, &MF_MT_FRAME_SIZE)) {
                    (image.width, image.height) = (width & !1, height & !1);
                    stride = stride_of(current.as_ref(), image.width);
                }
            }
            let Some(sample) = sample else { continue };
            let arrived = now_ns();
            let frame = nv12(&sample, image, stride, &mut bytes).and_then(|()| CameraFrame::from_nv12(&self.gpu.0, image, &bytes));
            match frame {
                Ok(frame) => {
                    self.feed.deliver(Arc::new(Mta(frame)), arrived, arrived, &*self.events);
                    self.heard_ns.store(arrived, Ordering::Release);
                    delivered = true;
                    if let Some(first) = first.take() {
                        let _ = first.send(Ok(()));
                    }
                }
                Err(detail) => eprintln!("camera: a frame was skipped: {detail}"),
            }
        }
        if let Some(source) = self.source.lock().unwrap().take() {
            let _ = unsafe { source.0.Shutdown() };
        }
        delivered
    }

    /// A camera told lost whose source has delivered nothing for `CAMERA_SILENT_NS` since it opened or last delivered
    /// (`judge`): the source is shut down, which ends a read that waits, so the read thread opens it again. A source
    /// just opened again has its own time to deliver; each is shut down once.
    fn silence(&self, now_ns: u64) {
        let quiet = now_ns.saturating_sub(self.heard_ns.load(Ordering::Acquire)) > CAMERA_SILENT_NS;
        if !self.feed.is_lost() || !quiet || self.silenced.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(source) = self.source.lock().unwrap().as_ref() {
            eprintln!("camera: silent, opened again");
            let _ = unsafe { source.0.Shutdown() };
        }
    }

    /// The read thread: the camera opened at the start, then opened again after each loss, until it is closed.
    fn run(&self, opened: Opened, mut first: Option<std::sync::mpsc::Sender<Result<(), String>>>) {
        com();
        let mut attempt = usize::from(!self.read(opened, &mut first));
        while !self.closed.load(Ordering::Acquire) {
            std::thread::sleep(BACKOFF[attempt.min(BACKOFF.len() - 1)]);
            if self.closed.load(Ordering::Acquire) {
                break;
            }
            attempt += 1;
            match open(&self.link) {
                Ok(opened) => {
                    self.reopened.fetch_add(1, Ordering::Relaxed);
                    // A camera that delivered again before failing starts its waits over.
                    if self.read(opened, &mut None) {
                        attempt = 0;
                    }
                }
                Err(detail) => eprintln!("camera: not opened again ({detail})"),
            }
        }
    }
}

pub struct CameraCapture {
    /// The device opened, by name.
    pub name: String,
    pub feed: Arc<Feed>,
    inner: Arc<Inner>,
}

impl CameraCapture {
    /// Opens `device` (its symbolic link; the first camera listed when `None` or not connected, D9), starts reading
    /// it and waits up to `FIRST_READ` for its first frame, so a camera that refuses refuses the start.
    pub fn start(
        gpu: Arc<Mta<Gpu>>,
        device: Option<&str>,
        events: Arc<dyn Events>,
        recording: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Result<Arc<Self>, CaptureError> {
        com();
        media_foundation()?;
        let connected = devices().map_err(|e| unavailable(format!("the cameras could not be listed ({e})")))?;
        let chosen = device.and_then(|id| connected.iter().find(|candidate| candidate.link == id)).or_else(|| connected.first());
        let Some(chosen) = chosen else { return Err(unavailable("no camera is connected")) };
        let (link, name) = (chosen.link.clone(), chosen.name.clone());
        let opened = open(&link).map_err(|detail| unavailable(format!("{name}: {detail}")))?;
        let feed = Arc::new(Feed::default());
        let inner = Arc::new(Inner {
            gpu,
            feed: feed.clone(),
            events,
            recording: Box::new(recording),
            link,
            source: Mutex::new(None),
            closed: AtomicBool::new(false),
            silenced: AtomicBool::new(false),
            heard_ns: AtomicU64::new(now_ns()),
            reopened: AtomicU64::new(0),
            failed_reads: AtomicU64::new(0),
        });
        let (first, heard) = channel();
        let reading = inner.clone();
        let opened = Mta(opened);
        std::thread::Builder::new()
            .name("recordstuff-camera".into())
            .spawn(move || {
                let opened = opened;
                reading.run(opened.0, Some(first));
            })
            .map_err(|e| unavailable(format!("camera thread: {e}")))?;
        let capture = Arc::new(Self { name: name.clone(), feed, inner });
        match heard.recv_timeout(FIRST_READ) {
            Ok(Ok(())) | Err(RecvTimeoutError::Timeout) => Ok(capture),
            Ok(Err(detail)) => {
                capture.close();
                Err(unavailable(format!("{name}: {detail}")))
            }
            Err(RecvTimeoutError::Disconnected) => {
                capture.close();
                Err(unavailable(format!("{name}: the camera thread ended")))
            }
        }
    }

    /// What the camera did, for the log.
    pub fn state(&self) -> String {
        let (delivered, losses) = self.feed.counts();
        format!(
            "{}: {}, {delivered} frame(s) delivered, {losses} loss(es), {} failed read(s), opened again {} time(s)",
            self.name,
            if self.inner.source.lock().unwrap().is_some() { "reading" } else { "not reading" },
            self.inner.failed_reads.load(Ordering::Relaxed),
            self.inner.reopened.load(Ordering::Relaxed)
        )
    }
}

impl CameraControl for CameraCapture {
    fn judge(&self, now_ns: u64, since_ns: u64, events: &dyn Events) {
        self.feed.judge(now_ns, since_ns, true, events);
        self.inner.silence(now_ns);
    }

    /// Shuts the media source down, which ends a read in progress and turns the camera's light off; never waits for
    /// the read thread, which ends on its own.
    fn close(&self) {
        if self.inner.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(source) = self.inner.source.lock().unwrap().take() {
            let _ = unsafe { source.0.Shutdown() };
        }
        self.feed.clear();
    }
}

impl Drop for CameraCapture {
    fn drop(&mut self) {
        self.close();
    }
}
