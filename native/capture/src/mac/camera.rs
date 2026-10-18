//! The camera (plan 075, step 5; D12, D16): AVFoundation's `AVCaptureVideoDataOutput` in the engine, 1280×720 in the
//! camera's 4:2:0 YUV, delivered as IOSurface-backed pixel buffers on a serial queue and stamped on the host clock the
//! screen's frames use. Each frame goes to the core's `CameraFeed`, which keeps the newest only and tells the camera's
//! loss and return; the compositor takes the newest frame when it encodes one.
//!
//! No run loop is needed: the session delivers on its queue in a process whose main thread runs Node's event loop
//! (step 2, 2026-10-17: an iPhone's Continuity Camera delivered about 30 frames a second so). A MacBook's built-in
//! camera with its lid closed opens and runs but delivers nothing; its silence then tells the loss.
//!
//! As the microphone (078 step 6), the camera is watched every 250 ms on a thread of its own: a device that is no
//! longer connected is lost at once and its session closed, and a lost camera, gone or silent, is opened again by the
//! unique ID it was opened with, never another camera, retrying after 2 s and backing off to 30 s. Whether
//! AVFoundation tells a device's disconnection without a run loop is not known yet (step 2's device check, deferred);
//! the silence tells it either way. The watch thread opens, so the core's refresh thread never waits for a session to
//! start. The core closes the camera when capture ends (`CameraControl::close`), which turns its light off.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_av_foundation::{
    AVAuthorizationStatus, AVCaptureConnection, AVCaptureDevice, AVCaptureDeviceInput, AVCaptureOutput, AVCaptureSession,
    AVCaptureSessionPreset1280x720, AVCaptureVideoDataOutput, AVCaptureVideoDataOutputSampleBufferDelegate, AVMediaType, AVMediaTypeVideo,
};
use objc2_core_foundation::{CFRetained, CFString};
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::{CVImageBuffer, kCVPixelBufferPixelFormatTypeKey};
use objc2_foundation::{NSDictionary, NSNumber, NSObject, NSObjectProtocol, NSString};

use super::content::describe;
use super::{CaptureError, Unsent, host_ns, now_ns};
use crate::core::{CameraControl, CameraFeed, Events};

/// How often the open camera is checked to still be connected, and a lost one considered for opening again.
const CHECK: Duration = Duration::from_millis(250);
/// The waits between attempts to open a lost camera again, the last repeated.
const BACKOFF: [Duration; 5] = [Duration::from_secs(2), Duration::from_secs(4), Duration::from_secs(8), Duration::from_secs(16), Duration::from_secs(30)];

fn unavailable(detail: impl Into<String>) -> CaptureError {
    CaptureError::new("camera_unavailable", format!("camera: {}", detail.into()))
}

/// A camera frame: an IOSurface-backed pixel buffer, retained while the feed or the compositor holds it.
#[derive(Clone)]
pub struct Image(pub CFRetained<CVImageBuffer>);
unsafe impl Send for Image {}
unsafe impl Sync for Image {}

pub type Feed = CameraFeed<Image>;

pub struct DelegateIvars {
    feed: Arc<Feed>,
    events: Arc<dyn Events>,
    /// Frames AVFoundation dropped before delivering them (late, or no buffer free).
    dropped: Arc<AtomicU64>,
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
            let ivars = self.ivars();
            ivars.feed.deliver(Image(image), host_ns(unsafe { sample.presentation_time_stamp() }), now_ns(), &*ivars.events);
        }

        #[unsafe(method(captureOutput:didDropSampleBuffer:fromConnection:))]
        fn did_drop(&self, _output: &AVCaptureOutput, _sample: &CMSampleBuffer, _connection: &AVCaptureConnection) {
            self.ivars().dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
);

impl Delegate {
    fn new(feed: Arc<Feed>, events: Arc<dyn Events>, dropped: Arc<AtomicU64>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { feed, events, dropped });
        unsafe { msg_send![super(this), init] }
    }
}

/// The system's default camera (D9): the one macOS prefers (macOS 13, as RecordStuff needs), which follows a Continuity
/// Camera and the user's choice in other apps, else AVFoundation's default, else any camera connected, but never a
/// suspended one. On 2026-10-17 `systemPreferredCamera` answered nothing at times and `defaultDeviceWithMediaType` the
/// FaceTime HD camera behind a closed lid, which is connected but suspended and delivers nothing, while the iPhone's
/// camera was there.
fn system_default(media: &AVMediaType) -> Option<Retained<AVCaptureDevice>> {
    let usable = |device: &Retained<AVCaptureDevice>| unsafe { device.isConnected() && !device.isSuspended() };
    if let Some(device) = unsafe { AVCaptureDevice::systemPreferredCamera() }.filter(usable) {
        return Some(device);
    }
    if let Some(device) = unsafe { AVCaptureDevice::defaultDeviceWithMediaType(media) }.filter(usable) {
        return Some(device);
    }
    // The discovery session's replacement needs a device type per kind of camera; this one lists them all.
    #[allow(deprecated)]
    let devices = unsafe { AVCaptureDevice::devicesWithMediaType(media) };
    devices.iter().find(|device| usable(device))
        // Nothing usable: the default as before, which the session reports as delivering nothing.
        .or_else(|| unsafe { AVCaptureDevice::defaultDeviceWithMediaType(media) })
}

/// The cameras connected now, the system's default marked (D9). Read without access: listing them asks nothing.
pub fn list() -> Vec<crate::core::Camera> {
    let Some(media) = (unsafe { AVMediaTypeVideo }) else { return Vec::new() };
    let default = system_default(media).map(|device| unsafe { device.uniqueID() }.to_string());
    // The discovery session's replacement needs a device type per kind of camera; this one lists them all.
    #[allow(deprecated)]
    let devices = unsafe { AVCaptureDevice::devicesWithMediaType(media) };
    devices
        .iter()
        .filter(|device| unsafe { device.isConnected() })
        .map(|device| {
            let id = unsafe { device.uniqueID() }.to_string();
            crate::core::Camera { default: default.as_deref() == Some(id.as_str()), name: unsafe { device.localizedName() }.to_string(), id }
        })
        .collect()
}

/// AVFoundation's camera authorization for this process: 0 not determined, 1 restricted, 2 denied, 3 authorized.
pub fn authorization() -> Result<isize, CaptureError> {
    let media = unsafe { AVMediaTypeVideo }.ok_or_else(|| unavailable("AVFoundation has no video media type"))?;
    Ok(unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) }.0)
}

/// A running capture session of one device.
struct Opened {
    device: Unsent<AVCaptureDevice>,
    session: Unsent<AVCaptureSession>,
    _output: Unsent<AVCaptureVideoDataOutput>,
    _delegate: Unsent<Delegate>,
    _queue: DispatchRetained<DispatchQueue>,
}
unsafe impl Send for Opened {}

impl Opened {
    fn connected(&self) -> bool {
        unsafe { self.device.0.isConnected() }
    }
}

impl Drop for Opened {
    fn drop(&mut self) {
        unsafe { self.session.0.stopRunning() };
    }
}

/// How to find the device: the chosen one, falling back to the system's default when it is not connected (at the
/// start, D9), or exactly one unique ID (opening a lost camera again).
enum Wanted<'a> {
    Chosen(Option<&'a str>),
    Exactly(&'a str),
}

/// Opens and starts the camera; answers the device's unique ID and name with the session.
fn open(wanted: Wanted<'_>, feed: &Arc<Feed>, events: &Arc<dyn Events>, dropped: &Arc<AtomicU64>) -> Result<(Opened, String, String), CaptureError> {
    let status = AVAuthorizationStatus(authorization()?);
    if status != AVAuthorizationStatus::Authorized {
        // Never asked included: main asks when the Camera switch is turned on, and opening without access delivers
        // nothing.
        return Err(unavailable(format!("access is not allowed (status {})", status.0)));
    }
    let media = unsafe { AVMediaTypeVideo }.ok_or_else(|| unavailable("AVFoundation has no video media type"))?;
    let by_id = |id: &str| unsafe { AVCaptureDevice::deviceWithUniqueID(&NSString::from_str(id)) };
    let device = match wanted {
        Wanted::Chosen(id) => match id.and_then(by_id) {
            Some(device) => device,
            None => system_default(media).ok_or_else(|| unavailable("no camera is connected"))?,
        },
        Wanted::Exactly(id) => by_id(id).ok_or_else(|| unavailable(format!("{id} is not connected")))?,
    };
    if !unsafe { device.isConnected() } {
        return Err(unavailable("the camera is not connected"));
    }
    let name = unsafe { device.localizedName() }.to_string();
    let unique_id = unsafe { device.uniqueID() }.to_string();
    let input = unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&device) }
        .map_err(|error| unavailable(format!("{name} could not be opened: {}", describe(&error))))?;

    let session = unsafe { AVCaptureSession::new() };
    let delegate = Delegate::new(feed.clone(), events.clone(), dropped.clone());
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
        // kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, the screen's format, which the compositor reads in place.
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
    let opened = Opened { device: Unsent(device), session: Unsent(session), _output: Unsent(output), _delegate: Unsent(delegate), _queue: queue };
    Ok((opened, unique_id, name))
}

struct Inner {
    feed: Arc<Feed>,
    events: Arc<dyn Events>,
    dropped: Arc<AtomicU64>,
    /// Whether the recording is on, when a disconnection is told lost at once.
    recording: Box<dyn Fn() -> bool + Send + Sync>,
    unique_id: String,
    opened: Mutex<Option<Opened>>,
    closed: AtomicBool,
    reopened: AtomicU64,
}

impl Inner {
    /// One check of the watch thread; `next_try` is when a lost camera may be opened again, `attempt` how many tries
    /// have failed or stayed silent since it was lost. Opening takes about a second and is done without holding the
    /// session's lock, so a stop is never kept waiting for it (`CameraCapture::close`).
    fn check(&self, next_try: &mut Option<Instant>, attempt: &mut usize) {
        {
            let mut opened = self.opened.lock().unwrap();
            if self.closed.load(Ordering::Acquire) {
                return;
            }
            if opened.as_ref().is_some_and(|session| !session.connected()) {
                self.feed.lose("the camera was disconnected".into(), (self.recording)(), &*self.events);
                *opened = None;
            }
            if !self.feed.is_lost() {
                *next_try = None;
                *attempt = 0;
                return;
            }
            // Lost, gone or silent: once its time comes, the session is closed and the camera opened again by its
            // unique ID. A session opened again is kept until the next time, so its first frame can arrive and tell
            // the return; each attempt that fails or stays silent waits longer.
            let due = *next_try.get_or_insert(Instant::now() + BACKOFF[0]);
            if Instant::now() < due {
                return;
            }
            *opened = None;
        }
        let reopened = open(Wanted::Exactly(&self.unique_id), &self.feed, &self.events, &self.dropped).ok();
        *attempt += 1;
        // From when the attempt ended, so a slow open still leaves its session the whole wait for a first frame.
        *next_try = Some(Instant::now() + BACKOFF[(*attempt).min(BACKOFF.len() - 1)]);
        let Some((session, _, _)) = reopened else { return };
        let mut opened = self.opened.lock().unwrap();
        // Closed meanwhile: the new session is dropped here, which stops it and turns its light off.
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        *opened = Some(session);
        self.reopened.fetch_add(1, Ordering::Relaxed);
    }
}

pub struct CameraCapture {
    /// The device opened, by name.
    pub name: String,
    pub feed: Arc<Feed>,
    inner: Arc<Inner>,
    watch: Mutex<Option<JoinHandle<()>>>,
}

unsafe impl Send for CameraCapture {}
unsafe impl Sync for CameraCapture {}

impl CameraCapture {
    /// Opens `device` (its unique ID; the system's default camera when `None` or not connected, D9) and starts it and
    /// its watch. `recording` says whether the recording is on.
    pub fn start(device: Option<&str>, events: Arc<dyn Events>, recording: impl Fn() -> bool + Send + Sync + 'static) -> Result<Arc<Self>, CaptureError> {
        let feed = Arc::new(Feed::default());
        let dropped = Arc::new(AtomicU64::new(0));
        let (opened, unique_id, name) = open(Wanted::Chosen(device), &feed, &events, &dropped)?;
        let inner = Arc::new(Inner {
            feed: feed.clone(),
            events,
            dropped,
            recording: Box::new(recording),
            unique_id,
            opened: Mutex::new(Some(opened)),
            closed: AtomicBool::new(false),
            reopened: AtomicU64::new(0),
        });
        let watched = inner.clone();
        let watch = std::thread::Builder::new()
            .name("recordstuff-camera-watch".into())
            .spawn(move || {
                let (mut next_try, mut attempt) = (None, 0);
                while !watched.closed.load(Ordering::Acquire) {
                    std::thread::sleep(CHECK);
                    objc2::rc::autoreleasepool(|_| watched.check(&mut next_try, &mut attempt));
                }
            })
            .map_err(|e| unavailable(format!("camera watch thread: {e}")))?;
        Ok(Arc::new(Self { name, feed, inner, watch: Mutex::new(Some(watch)) }))
    }

    /// What the camera did, for the log: whether its session runs, frames delivered and dropped, losses and reopenings.
    pub fn state(&self) -> String {
        let running = self.inner.opened.lock().unwrap().as_ref().map(|opened| unsafe { opened.session.0.isRunning() });
        let (delivered, losses) = self.feed.counts();
        format!(
            "{}: running {}, {delivered} frame(s) delivered, {} dropped, {losses} loss(es), opened again {} time(s)",
            self.name,
            running.map_or("no (closed)".into(), |running| running.to_string()),
            self.inner.dropped.load(Ordering::Relaxed),
            self.inner.reopened.load(Ordering::Relaxed)
        )
    }
}

impl CameraControl for CameraCapture {
    fn judge(&self, now_ns: u64, since_ns: u64, events: &dyn Events) {
        self.feed.judge(now_ns, since_ns, true, events);
    }

    /// Never waits for the watch thread: an open in progress there ends on its own, finds the camera closed and drops
    /// its session, so a stop is never held up by a camera being opened again.
    fn close(&self) {
        if self.inner.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        // Stops the session: its light goes off.
        let session = self.inner.opened.lock().unwrap().take();
        drop(session);
        self.feed.clear();
        // The thread ends at its next check; it is not joined.
        drop(self.watch.lock().unwrap().take());
    }
}

impl Drop for CameraCapture {
    fn drop(&mut self) {
        self.close();
    }
}
