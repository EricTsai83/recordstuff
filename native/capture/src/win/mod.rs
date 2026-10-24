//! Windows capture (plan 076, steps 3 and 4): Windows.Graphics.Capture for the display, a window or part of the
//! display, WASAPI for system audio, a chosen process's sound and the microphone, and Media Foundation's H.264 and AAC
//! encoders. Every time is QueryPerformanceCounter time in nanoseconds: capture frames carry `SystemRelativeTime` and
//! audio packets their QPC position, both QPC in 100 ns units.

pub mod aac;
pub mod audio;
pub mod camera;
pub mod capture;
pub mod compositor;
pub mod edit;
pub mod hardware;
mod mft;
pub mod session;
pub mod video;

/// The audio inputs, for choosing the microphone.
pub mod microphone {
    pub use super::audio::microphones as list;
}

/// Settings' input level meter and the device list it follows (plan 079, D1 and D2).
pub mod meter {
    pub use super::audio::{DeviceWatch, Meter};
    pub use crate::core::meter::MeterEvent;
}

use std::sync::OnceLock;

use windows::Win32::Media::MediaFoundation::{MF_VERSION, MFSTARTUP_NOSOCKET, MFStartup};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

pub use crate::core::CaptureError;

/// Host time now, in nanoseconds of QueryPerformanceCounter.
pub fn now_ns() -> u64 {
    static FREQUENCY: OnceLock<u64> = OnceLock::new();
    let frequency = *FREQUENCY.get_or_init(|| {
        let mut frequency = 0i64;
        let _ = unsafe { QueryPerformanceFrequency(&mut frequency) };
        frequency.max(1) as u64
    });
    let mut counter = 0i64;
    let _ = unsafe { QueryPerformanceCounter(&mut counter) };
    (u128::from(counter.max(0) as u64) * 1_000_000_000 / u128::from(frequency)) as u64
}

/// Host time of a QPC value in 100 ns units, as capture frames and audio packets carry it.
pub fn hundreds_to_ns(time: i64) -> u64 {
    time.max(0) as u64 * 100
}

/// Joins this thread to the multithreaded apartment, which every COM and Media Foundation object here lives in. A
/// thread already in an apartment keeps it.
pub fn com() {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}

/// Starts Media Foundation once for the process. Failing to is a Windows without its media components (plan 078).
pub fn media_foundation() -> Result<(), CaptureError> {
    static STARTED: OnceLock<Result<(), String>> = OnceLock::new();
    STARTED
        .get_or_init(|| {
            com();
            unsafe { MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) }.map_err(|e| format!("Media Foundation could not start: {e}"))
        })
        .clone()
        .map_err(|detail| CaptureError::new("media_components_missing", detail))
}

/// REGDB_E_CLASSNOTREG and ERROR_MOD_NOT_FOUND as HRESULTs: a Media Foundation encoder that is not installed.
const CLASS_NOT_REGISTERED: i32 = 0x8004_0154_u32 as i32;
const MODULE_NOT_FOUND: i32 = 0x8007_007E_u32 as i32;

/// `start_failed` for creating one of Media Foundation's encoders, except that an encoder Windows does not have is
/// `media_components_missing` (plan 078): a Windows N edition without the Media Feature Pack.
pub fn encoder_missing(what: &'static str) -> impl Fn(windows::core::Error) -> CaptureError {
    move |error| {
        if [CLASS_NOT_REGISTERED, MODULE_NOT_FOUND].contains(&error.code().0) {
            CaptureError::new("media_components_missing", format!("{what}: {error}"))
        } else {
            start_failed(what, error)
        }
    }
}

/// A COM object handed to another thread. Every object here is created in the multithreaded apartment, where COM
/// lets any thread call it; windows-rs marks only some interfaces `Send`.
pub struct Mta<T>(pub T);
unsafe impl<T> Send for Mta<T> {}
unsafe impl<T> Sync for Mta<T> {}

impl<T> Mta<T> {
    /// The object; a closure calling this captures the whole wrapper, not just the field.
    pub fn get(&self) -> &T {
        &self.0
    }
}

#[cfg(test)]
mod live_test;
#[cfg(test)]
mod pipeline_test;

pub fn start_failed(what: &str, error: windows::core::Error) -> CaptureError {
    CaptureError::new("capture_start_failed", format!("{what}: {error}"))
}

/// `start_failed` for `map_err`.
pub fn failing(what: &'static str) -> impl Fn(windows::core::Error) -> CaptureError {
    move |error| start_failed(what, error)
}
