//! Windows capture (plan 076, steps 3 and 4): Windows.Graphics.Capture for the display, a window or part of the
//! display, WASAPI for system audio, a chosen process's sound and the microphone, and Media Foundation's H.264 and AAC
//! encoders. Every time is QueryPerformanceCounter time in nanoseconds: capture frames carry `SystemRelativeTime` and
//! audio packets their QPC position, both QPC in 100 ns units.

pub mod aac;
pub mod audio;
pub mod capture;
mod mft;
pub mod session;
pub mod video;

/// The audio inputs, for choosing the microphone.
pub mod microphone {
    pub use super::audio::microphones as list;
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

/// Starts Media Foundation once for the process.
pub fn media_foundation() -> Result<(), CaptureError> {
    static STARTED: OnceLock<Result<(), String>> = OnceLock::new();
    STARTED
        .get_or_init(|| {
            com();
            unsafe { MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) }.map_err(|e| format!("Media Foundation could not start: {e}"))
        })
        .clone()
        .map_err(|detail| CaptureError::new("capture_start_failed", detail))
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
