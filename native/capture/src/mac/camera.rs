//! The camera (plan 075, D16): AVFoundation's `AVCaptureVideoDataOutput` in the engine, 1280×720 in the camera's
//! 4:2:0 YUV, delivered as IOSurface-backed pixel buffers on a serial queue. Only the newest frame is kept (the
//! latest wins): the compositor takes it when it encodes a frame, so a camera slower or faster than the recording
//! never queues frames. Step 2's prototype: opened behind the development switch (camera_layout.rs) and closed with
//! the session, so the camera's light goes off at stop, cancel and failure.
//!
//! Whether AVFoundation follows a camera that leaves and returns without a main run loop is step 2's other question;
//! this module only counts what the camera delivered.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_av_foundation::{
    AVAuthorizationStatus, AVCaptureConnection, AVCaptureDevice, AVCaptureDeviceInput, AVCaptureOutput, AVCaptureSession,
    AVCaptureSessionPreset1280x720, AVCaptureVideoDataOutput, AVCaptureVideoDataOutputSampleBufferDelegate, AVMediaTypeVideo,
};
use objc2_core_foundation::{CFRetained, CFString};
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::{CVImageBuffer, kCVPixelBufferPixelFormatTypeKey};
use objc2_foundation::{NSDictionary, NSNumber, NSObject, NSObjectProtocol, NSString};

use super::content::describe;
use super::{CaptureError, Unsent, host_ns};

fn unavailable(detail: impl Into<String>) -> CaptureError {
    CaptureError::new("camera_unavailable", format!("camera: {}", detail.into()))
}

/// The newest camera frame and when it was captured, on the host clock the screen's frames use.
pub struct Latest {
    pub image: CFRetained<CVImageBuffer>,
    pub pts_ns: u64,
}
unsafe impl Send for Latest {}

#[derive(Default)]
pub struct Shared {
    latest: Mutex<Option<Latest>>,
    delivered: AtomicU64,
    /// Frames AVFoundation dropped before delivering them (late, or no buffer free).
    dropped: AtomicU64,
}

impl Shared {
    /// The newest frame, still held here for the next caller too.
    pub fn latest(&self) -> Option<(CFRetained<CVImageBuffer>, u64)> {
        self.latest.lock().unwrap().as_ref().map(|latest| (latest.image.clone(), latest.pts_ns))
    }

    pub fn delivered(&self) -> u64 {
        self.delivered.load(Ordering::Relaxed)
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
    /// Stands in for the camera in tests.
    #[cfg(test)]
    pub fn deliver(&self, image: CFRetained<CVImageBuffer>, pts_ns: u64) {
        *self.latest.lock().unwrap() = Some(Latest { image, pts_ns });
        self.delivered.fetch_add(1, Ordering::Relaxed);
    }
}

pub struct DelegateIvars {
    shared: Arc<Shared>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl AVCaptureVideoDataOutputSampleBufferDelegate for Delegate {
        #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
        fn did_output(&self, _output: &AVCaptureOutput, sample: &CMSampleBuffer, _connection: &AVCaptureConnection) {
            let Some(image) = (unsafe { sample.image_buffer() }) else { return };
            let pts_ns = host_ns(unsafe { sample.presentation_time_stamp() });
            let shared = &self.ivars().shared;
            *shared.latest.lock().unwrap() = Some(Latest { image, pts_ns });
            shared.delivered.fetch_add(1, Ordering::Relaxed);
        }

        #[unsafe(method(captureOutput:didDropSampleBuffer:fromConnection:))]
        fn did_drop(&self, _output: &AVCaptureOutput, _sample: &CMSampleBuffer, _connection: &AVCaptureConnection) {
            self.ivars().shared.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
);

impl Delegate {
    fn new(shared: Arc<Shared>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { shared });
        unsafe { msg_send![super(this), init] }
    }
}

/// AVFoundation's camera authorization for this process: 0 not determined, 1 restricted, 2 denied, 3 authorized.
pub fn authorization() -> Result<isize, CaptureError> {
    let media = unsafe { AVMediaTypeVideo }.ok_or_else(|| unavailable("AVFoundation has no video media type"))?;
    Ok(unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) }.0)
}

struct Opened {
    name: String,
    shared: Arc<Shared>,
    session: Unsent<AVCaptureSession>,
    output: Unsent<AVCaptureVideoDataOutput>,
    delegate: Unsent<Delegate>,
    queue: DispatchRetained<DispatchQueue>,
}
unsafe impl Send for Opened {}

/// Opens and starts the camera. No run loop is needed: the session delivers on its queue in a process whose main
/// thread runs Node's event loop (step 2, 2026-10-17: an iPhone's Continuity Camera delivered about 23 frames a second
/// so). A MacBook's built-in camera with its lid closed opens and runs but delivers nothing; `state` shows it.
fn open(device: Option<&str>) -> Result<Opened, CaptureError> {
    let status = AVAuthorizationStatus(authorization()?);
    if status != AVAuthorizationStatus::Authorized {
        // Never asked included: main asks before recording (step 4), and opening without access delivers nothing.
        return Err(unavailable(format!("access is not allowed (status {})", status.0)));
    }
    let media = unsafe { AVMediaTypeVideo }.ok_or_else(|| unavailable("AVFoundation has no video media type"))?;
    let chosen = device.and_then(|id| unsafe { AVCaptureDevice::deviceWithUniqueID(&NSString::from_str(id)) });
    let device = match chosen {
        Some(device) => device,
        None => unsafe { AVCaptureDevice::defaultDeviceWithMediaType(media) }.ok_or_else(|| unavailable("no camera is connected"))?,
    };
    let name = unsafe { device.localizedName() }.to_string();
    let input = unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&device) }
        .map_err(|error| unavailable(format!("{name} could not be opened: {}", describe(&error))))?;

    let session = unsafe { AVCaptureSession::new() };
    let shared = Arc::new(Shared::default());
    let delegate = Delegate::new(shared.clone());
    let queue = DispatchQueue::new("com.ericts.record.capture.camera", None);
    let output = unsafe { AVCaptureVideoDataOutput::new() };
    unsafe {
        session.beginConfiguration();
        if session.canSetSessionPreset(AVCaptureSessionPreset1280x720) {
            session.setSessionPreset(AVCaptureSessionPreset1280x720);
        }
        if !session.canAddInput(&input) {
            session.commitConfiguration();
            return Err(unavailable(format!("{name} cannot be added to a capture session")));
        }
        session.addInput(&input);
        // kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, the screen's format, which Core Image reads without a copy.
        let key: &NSString = &*(kCVPixelBufferPixelFormatTypeKey as *const CFString as *const NSString);
        let format = NSNumber::new_u32(u32::from_be_bytes(*b"420v"));
        let format: &AnyObject = &format;
        let settings = NSDictionary::<NSString, AnyObject>::from_slices(&[key], &[format]);
        output.setVideoSettings(Some(&settings));
        output.setAlwaysDiscardsLateVideoFrames(true);
        output.setSampleBufferDelegate_queue(Some(ProtocolObject::from_ref(&*delegate)), Some(&queue));
        if !session.canAddOutput(&output) {
            session.commitConfiguration();
            return Err(unavailable(format!("{name} gives no frames this engine can read")));
        }
        session.addOutput(&output);
        session.commitConfiguration();
        session.startRunning();
    }
    Ok(Opened { name, shared, session: Unsent(session), output: Unsent(output), delegate: Unsent(delegate), queue })
}

pub struct CameraCapture {
    /// The device opened, by name.
    pub name: String,
    pub shared: Arc<Shared>,
    session: Unsent<AVCaptureSession>,
    _output: Unsent<AVCaptureVideoDataOutput>,
    _delegate: Unsent<Delegate>,
    _queue: DispatchRetained<DispatchQueue>,
}

unsafe impl Send for CameraCapture {}

impl CameraCapture {
    /// Opens `device` (its unique ID; the system's default camera when `None` or not connected) and starts it.
    pub fn start(device: Option<&str>) -> Result<Self, CaptureError> {
        let opened = open(device)?;
        Ok(Self {
            name: opened.name,
            shared: opened.shared,
            session: opened.session,
            _output: opened.output,
            _delegate: opened.delegate,
            _queue: opened.queue,
        })
    }

    /// What the camera did, for the log: whether its session runs or was interrupted, frames delivered and dropped.
    pub fn state(&self) -> String {
        let session = &self.session.0;
        format!(
            "{}: running {}, interrupted {}, {} frame(s) delivered, {} dropped",
            self.name,
            unsafe { session.isRunning() },
            unsafe { session.isInterrupted() },
            self.shared.delivered(),
            self.shared.dropped()
        )
    }

    /// Stops the camera; its light goes off. Frames arriving meanwhile are dropped with the session.
    pub fn stop(self) {}
}

impl Drop for CameraCapture {
    fn drop(&mut self) {
        unsafe { self.session.0.stopRunning() };
        *self.shared.latest.lock().unwrap() = None;
    }
}
