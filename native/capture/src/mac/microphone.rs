//! The microphone, mixed into the recording's track (074's input; plan 076 step 4 builds it into the engine and its
//! tests only): an `AVCaptureSession` with the chosen device or the system's default input, its sound converted by
//! AVFoundation to what the track takes (48 kHz, stereo, 32-bit float; a mono microphone is heard in both channels) and
//! stamped on the host clock the screen's samples use.
//!
//! The usage description and the hardened runtime's audio-input entitlement, which a signed RecordStuff needs before
//! macOS lets it open a microphone, are 074's.

use std::sync::{Arc, Mutex};

use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_av_foundation::{
    AVAuthorizationStatus, AVCaptureAudioDataOutput, AVCaptureAudioDataOutputSampleBufferDelegate, AVCaptureConnection, AVCaptureDevice,
    AVCaptureDeviceInput, AVCaptureOutput, AVCaptureSession, AVMediaTypeAudio,
};
use objc2_core_media::{CMClock, CMSampleBuffer, CMSyncConvertTime};
use objc2_foundation::{NSDictionary, NSNumber, NSObject, NSObjectProtocol, NSString};

use super::session::{Shared, sound};
use super::{CaptureError, Unsent, host_ns};
use crate::core::{CHANNELS, Microphone, SAMPLE_RATE};

// AVFAudio's settings keys, re-exported by AVFoundation.
unsafe extern "C" {
    static AVFormatIDKey: &'static NSString;
    static AVSampleRateKey: &'static NSString;
    static AVNumberOfChannelsKey: &'static NSString;
    static AVLinearPCMBitDepthKey: &'static NSString;
    static AVLinearPCMIsFloatKey: &'static NSString;
    static AVLinearPCMIsNonInterleaved: &'static NSString;
    static AVLinearPCMIsBigEndianKey: &'static NSString;
}

/// kAudioFormatLinearPCM.
const LINEAR_PCM: u32 = u32::from_be_bytes(*b"lpcm");

fn unavailable(detail: impl Into<String>) -> CaptureError {
    CaptureError::new("capture_start_failed", format!("microphone: {}", detail.into()))
}

fn audio_type() -> Result<&'static objc2_av_foundation::AVMediaType, CaptureError> {
    unsafe { AVMediaTypeAudio }.ok_or_else(|| unavailable("AVFoundation has no audio media type"))
}

/// The audio input devices, the system's default marked.
pub fn list() -> Result<Vec<Microphone>, CaptureError> {
    let media = audio_type()?;
    #[allow(deprecated)]
    let devices = unsafe { AVCaptureDevice::devicesWithMediaType(media) };
    let default = unsafe { AVCaptureDevice::defaultDeviceWithMediaType(media) }.map(|device| unsafe { device.uniqueID() }.to_string());
    Ok(devices
        .iter()
        .map(|device| {
            let id = unsafe { device.uniqueID() }.to_string();
            Microphone { default: default.as_deref() == Some(id.as_str()), name: unsafe { device.localizedName() }.to_string(), id }
        })
        .collect())
}

/// AVFoundation's microphone authorization for this process: 0 not determined, 1 restricted, 2 denied, 3 authorized.
pub fn authorization() -> Result<isize, CaptureError> {
    Ok(unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio_type()?) }.0)
}

pub struct DelegateIvars {
    shared: Arc<Shared>,
    input: usize,
    /// The session's clock, whose times are converted to the host clock; set once the session runs.
    clock: Mutex<Option<Retained<CMClock>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl AVCaptureAudioDataOutputSampleBufferDelegate for Delegate {
        #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
        fn capture_output(&self, _output: &AVCaptureOutput, sample: &CMSampleBuffer, _connection: &AVCaptureConnection) {
            let ivars = self.ivars();
            if !ivars.shared.wants_sound() {
                return;
            }
            let time = unsafe { sample.presentation_time_stamp() };
            let time = match ivars.clock.lock().unwrap().as_ref() {
                Some(clock) => unsafe { CMSyncConvertTime(time, clock, &CMClock::host_time_clock()) },
                None => time,
            };
            if let Err(detail) = sound(&ivars.shared, ivars.input, sample, host_ns(time)) {
                ivars.shared.fail(format!("microphone: {detail}"));
            }
        }
    }
);

impl Delegate {
    fn new(shared: Arc<Shared>, input: usize) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { shared, input, clock: Mutex::new(None) });
        unsafe { msg_send![super(this), init] }
    }
}

pub struct MicrophoneCapture {
    session: Unsent<AVCaptureSession>,
    _delegate: Unsent<Delegate>,
    _queue: DispatchRetained<DispatchQueue>,
}

unsafe impl Send for MicrophoneCapture {}

impl MicrophoneCapture {
    /// Opens `device` (the system's default input when `None`) and hands its sound to `shared` as `input`.
    pub fn start(device: Option<&str>, shared: Arc<Shared>, input: usize) -> Result<Self, CaptureError> {
        let media = audio_type()?;
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) };
        if status == AVAuthorizationStatus::Denied || status == AVAuthorizationStatus::Restricted {
            return Err(unavailable("access is not allowed (System Settings > Privacy & Security > Microphone)"));
        }
        // Never asked: AVFoundation would deliver silence without a prompt, and a narration would be lost unnoticed.
        // Main asks before recording (074).
        if status == AVAuthorizationStatus::NotDetermined {
            return Err(unavailable("access is not allowed yet: macOS has not asked for it"));
        }
        let device = match device {
            Some(id) => unsafe { AVCaptureDevice::deviceWithUniqueID(&NSString::from_str(id)) }
                .ok_or_else(|| unavailable(format!("device {id} is not connected")))?,
            None => unsafe { AVCaptureDevice::defaultDeviceWithMediaType(media) }.ok_or_else(|| unavailable("there is no audio input"))?,
        };
        let name = unsafe { device.localizedName() }.to_string();
        let input_device = unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&device) }
            .map_err(|error| unavailable(format!("{name} could not be opened: {}", super::content::describe(&error))))?;

        let session = unsafe { AVCaptureSession::new() };
        let output = unsafe { AVCaptureAudioDataOutput::new() };
        // NSNumber is an NSValue is an NSObject.
        let object = |n: Retained<NSNumber>| -> Retained<AnyObject> { Retained::into_super(Retained::into_super(Retained::into_super(n))) };
        let number = |value: f64| object(NSNumber::new_f64(value));
        let settings = unsafe {
            NSDictionary::from_retained_objects(
                &[AVFormatIDKey, AVSampleRateKey, AVNumberOfChannelsKey, AVLinearPCMBitDepthKey, AVLinearPCMIsFloatKey, AVLinearPCMIsNonInterleaved, AVLinearPCMIsBigEndianKey],
                &[
                    number(f64::from(LINEAR_PCM)),
                    number(f64::from(SAMPLE_RATE)),
                    number(f64::from(CHANNELS)),
                    number(32.0),
                    object(NSNumber::new_bool(true)),
                    object(NSNumber::new_bool(false)),
                    object(NSNumber::new_bool(false)),
                ],
            )
        };
        unsafe { output.setAudioSettings(Some(&settings)) };
        let delegate = Delegate::new(shared, input);
        let queue = DispatchQueue::new("com.ericts.record.capture.microphone", None);
        unsafe {
            output.setSampleBufferDelegate_queue(Some(ProtocolObject::from_ref(&*delegate)), Some(&queue));
            session.beginConfiguration();
            if !session.canAddInput(&input_device) {
                return Err(unavailable(format!("{name} cannot be added to a capture session")));
            }
            session.addInput(&input_device);
            if !session.canAddOutput(&output) {
                return Err(unavailable("its sound cannot be read"));
            }
            session.addOutput(&output);
            session.commitConfiguration();
            session.startRunning();
        }
        if !unsafe { session.isRunning() } {
            return Err(unavailable(format!("{name} did not start")));
        }
        let clock = unsafe { session.synchronizationClock() };
        *delegate.ivars().clock.lock().unwrap() = clock;
        Ok(Self { session: Unsent(session), _delegate: Unsent(delegate), _queue: queue })
    }

    pub fn stop(&self) {
        unsafe { self.session.0.stopRunning() };
    }
}

impl Drop for MicrophoneCapture {
    fn drop(&mut self) {
        self.stop();
    }
}
