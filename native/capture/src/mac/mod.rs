//! macOS capture: ScreenCaptureKit for the display and system audio, VideoToolbox and AudioToolbox for encoding.

pub mod audio;
pub mod camera;
pub mod camera_track;
pub mod compositor;
pub mod content;
pub mod edit;
pub mod hal;
pub mod meter;
pub mod microphone;
pub mod render;
pub mod session;
pub mod video;

use objc2::rc::Retained;
use objc2_core_media::{CMClock, CMTime, CMTimeFlags};

pub use crate::core::CaptureError;

/// An Objective-C object moved to the thread that waits for it. The frameworks' objects used here are thread-safe;
/// objc2 marks them neither Send nor Sync because not every class is.
pub struct Unsent<T: objc2::Message>(pub Retained<T>);
unsafe impl<T: objc2::Message> Send for Unsent<T> {}
unsafe impl<T: objc2::Message> Sync for Unsent<T> {}

/// Nanoseconds of host time, the clock ScreenCaptureKit stamps samples with; 0 for an invalid time.
pub fn host_ns(time: CMTime) -> u64 {
    if !time.flags.contains(CMTimeFlags::Valid) || time.timescale <= 0 || time.value < 0 {
        return 0;
    }
    (i128::from(time.value) * 1_000_000_000 / i128::from(time.timescale)) as u64
}

/// Host time now, on the same clock.
pub fn now_ns() -> u64 {
    host_ns(unsafe { CMClock::host_time_clock().time() })
}

#[cfg(test)]
mod edit_test;
#[cfg(test)]
mod live_test;
#[cfg(test)]
mod pipeline_test;
