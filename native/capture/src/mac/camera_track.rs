//! The camera's own track (plan 087's editable recording, step 1's prototype): instead of being composed into the
//! screen's frames, the camera's newest frame is encoded at its capture time by an encoder of its own into the file's
//! last track, so an editor can place it later. Its encoder is made at `prepare` and given one black frame there, whose
//! sample is dropped: the file's header, written with the screen's first frame, needs the track's parameter sets
//! however late the camera's first frame comes. Later frames come from the same compression session, whose parameter
//! sets do not change.
//!
//! A thread polls the camera's feed twice per frame interval while recording; the track's first frame is at the
//! recording's start (`Shared::camera_pts`), so the track starts with the screen's. While the camera delivers nothing
//! the last frame lasts on; the track ends at the stop with the screen's. While the user hides the camera (075's D13)
//! the track is black, on the clock whether the camera delivers or not, so nothing it sees then enters the file. A
//! camera that delivers another size than the 720p preset's (an iPhone's Continuity Camera gives 1920×1080) is scaled
//! into the track by the compression session's own pixel transfer; one of another shape is stretched to 16:9.

use std::ptr::{NonNull, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use objc2_core_foundation::{CFDictionary, CFRetained, CFString, CFType};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferCreate, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane, CVPixelBufferGetHeight,
    CVPixelBufferGetHeightOfPlane, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
    kCVPixelBufferIOSurfacePropertiesKey,
};

use super::camera::Feed;
use super::now_ns;
use super::session::Shared;
use super::video::VideoEncoder;
use crate::core::{CaptureError, VideoSink};
use crate::writer::{Media, VideoSpec};

/// The camera track's size: AVCaptureSession's 1280×720 preset (camera.rs); other sizes are scaled to it.
pub const WIDTH: u32 = 1280;
pub const HEIGHT: u32 = 720;
/// Its bit rate: the screen's per pixel, not below this.
const MIN_BITRATE: u32 = 2_000_000;

/// The camera track's bit rate for a screen of `width`×`height` encoded at `bitrate`: the same bits per pixel.
pub fn bitrate(width: u32, height: u32, bitrate: u32) -> u32 {
    let scaled = u64::from(bitrate) * u64::from(WIDTH * HEIGHT) / u64::from(width.max(1) * height.max(1)).max(1);
    (scaled.min(u64::from(bitrate)) as u32).max(MIN_BITRATE)
}

/// Passes the encoder's samples on once primed, keeping its configuration.
struct Output {
    inner: Arc<dyn VideoSink>,
    format: Mutex<Option<VideoSpec>>,
    primed: AtomicBool,
}

impl VideoSink for Output {
    fn media(&self, media: Media) {
        match media {
            Media::VideoFormat { avcc, width, height } => *self.format.lock().unwrap() = Some(VideoSpec { avcc, width, height }),
            // The black frame's sample: never the recording's.
            media if !self.primed.load(Ordering::Acquire) => drop(media),
            media => self.inner.media(media),
        }
    }

    fn failed(&self, detail: String) {
        self.inner.failed(detail);
    }
}

/// The camera track's encoder, made and primed at `prepare`.
pub struct CameraTrack {
    encoder: Arc<VideoEncoder>,
    black: crate::mac::camera::Image,
    pub spec: VideoSpec,
}

impl CameraTrack {
    pub fn new(shared: &Arc<Shared>, frame_rate: u32, bitrate: u32) -> Result<Self, CaptureError> {
        let output = Arc::new(Output { inner: shared.camera_track_sink(), format: Mutex::new(None), primed: AtomicBool::new(false) });
        let encoder = VideoEncoder::new(WIDTH, HEIGHT, frame_rate, bitrate, output.clone())?;
        let black = black_frame(WIDTH as usize, HEIGHT as usize).map_err(|detail| CaptureError::new("capture_start_failed", detail))?;
        encoder.encode(&black, 0, true).map_err(|detail| CaptureError::new("capture_start_failed", format!("camera track: {detail}")))?;
        encoder.flush();
        let spec = output.format.lock().unwrap().clone().ok_or_else(|| CaptureError::new("capture_start_failed", "camera track: no parameter sets"))?;
        output.primed.store(true, Ordering::Release);
        Ok(Self { encoder: Arc::new(encoder), black: crate::mac::camera::Image(black), spec })
    }

    /// Starts encoding the feed's frames into the track, black ones while `hidden`; called once the recording is
    /// started.
    pub fn start(&self, shared: Arc<Shared>, feed: Arc<Feed>, frame_rate: u32, hidden: Arc<AtomicBool>) -> Result<Running, CaptureError> {
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let encoder = self.encoder.clone();
        let black = self.black.clone();
        let interval = Duration::from_nanos(crate::timing::NANOS_PER_SECOND / u64::from(frame_rate.max(1)) / 2);
        let thread = std::thread::Builder::new()
            .name("recordstuff-camera-track".into())
            .spawn(move || {
                // Moved whole: a closure would otherwise capture only its field, which is not Send.
                let black = black;
                let mut last = None;
                let mut wrong_size = false;
                // When black was last encoded while hidden; None while shown.
                let mut black_at: Option<u64> = None;
                while !stopping.load(Ordering::Acquire) {
                    std::thread::sleep(interval);
                    if hidden.load(Ordering::Acquire) {
                        // On the clock, not the camera's frames: a camera that stalled or was lost before it was hidden
                        // delivers none, and its last picture must not last through the hidden time. Black at once,
                        // then once a second, as a still screen is refreshed.
                        let now = now_ns();
                        if black_at.is_some_and(|at| now < at + crate::timing::NANOS_PER_SECOND) {
                            continue;
                        }
                        let Some((pts, first)) = shared.camera_pts(now, last) else { continue };
                        if let Err(detail) = encoder.encode(&black.0, pts, first) {
                            eprintln!("camera track: {detail}");
                            shared.camera_track_sink().failed(detail);
                            return;
                        }
                        last = Some(now.max(pts));
                        black_at = Some(now);
                        continue;
                    }
                    black_at = None;
                    if let Some((image, captured)) = feed.latest()
                        && let Some((pts, first)) = shared.camera_pts(captured, last)
                    {
                        let size = (CVPixelBufferGetWidth(&image.0), CVPixelBufferGetHeight(&image.0));
                        if size != (WIDTH as usize, HEIGHT as usize) && !wrong_size {
                            // VideoToolbox scales it into the track (its pixel transfer); said once for the log.
                            wrong_size = true;
                            eprintln!("camera track: the camera delivers {}x{} frames, scaled to {WIDTH}x{HEIGHT}", size.0, size.1);
                        }
                        if let Err(detail) = encoder.encode(&image.0, pts, first) {
                            eprintln!("camera track: {detail}");
                            shared.camera_track_sink().failed(detail);
                            return;
                        }
                        // The capture time, not the track's: a first frame stamped at the start is followed by the
                        // camera's next one.
                        last = Some(captured.max(pts));
                    }
                }
            })
            .map_err(|e| CaptureError::new("capture_start_failed", format!("camera track thread: {e}")))?;
        Ok(Running { stop, thread: Some(thread), encoder: self.encoder.clone() })
    }
}

/// The camera track while recording.
pub struct Running {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    encoder: Arc<VideoEncoder>,
}

impl Running {
    /// Ends the track: no frame after this is encoded, and every encoded one has reached the writer.
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.encoder.flush();
    }
}

/// A black 4:2:0 video-range frame, IOSurface-backed as capture's are.
fn black_frame(width: usize, height: usize) -> Result<CFRetained<CVPixelBuffer>, String> {
    let surface = CFDictionary::<CFString, CFType>::from_slices(&[], &[]);
    let key: &CFString = unsafe { kCVPixelBufferIOSurfacePropertiesKey };
    let attributes = CFDictionary::<CFString, CFType>::from_slices(&[key], &[surface.as_ref()]);
    let mut buffer: *mut CVPixelBuffer = null_mut();
    let status = unsafe { CVPixelBufferCreate(None, width, height, u32::from_be_bytes(*b"420v"), Some(attributes.as_opaque()), NonNull::from(&mut buffer)) };
    let buffer = NonNull::new(buffer).filter(|_| status == 0).ok_or_else(|| format!("camera track: no {width}x{height} frame: {status}"))?;
    let buffer = unsafe { CFRetained::from_raw(buffer) };
    unsafe { CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
    for (plane, value) in [(0usize, 16u8), (1, 128)] {
        let base = CVPixelBufferGetBaseAddressOfPlane(&buffer, plane).cast::<u8>();
        let bytes = CVPixelBufferGetBytesPerRowOfPlane(&buffer, plane) * CVPixelBufferGetHeightOfPlane(&buffer, plane);
        unsafe { std::ptr::write_bytes(base, value, bytes) };
    }
    unsafe { CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_camera_track_keeps_the_screen_s_bits_per_pixel_within_bounds() {
        // 1080p at 12 Mbps: 720p is 4/9 of its pixels.
        assert_eq!(bitrate(1920, 1080, 12_000_000), 5_333_333);
        // A small screen: the floor, above its own rate; a large one: its bits per pixel.
        assert_eq!(bitrate(640, 360, 1_000_000), MIN_BITRATE);
        assert_eq!(bitrate(2880, 1800, 20_000_000), 3_555_555);
    }
}
