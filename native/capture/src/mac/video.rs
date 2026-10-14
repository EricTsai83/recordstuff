//! H.264 through VideoToolbox (plan 076, D4), which uses the Mac's media engine when it has one. Configured for
//! recording rather than streaming latency: no frame reordering (decode order is presentation order, so the file
//! needs no composition offsets), a key frame at least every second (each fragment starts at one), the average
//! bit rate `quality.ts` chose, and BT.709 colour tags.

use std::ffi::c_void;
use std::ptr::{NonNull, null_mut};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use objc2_core_foundation::{CFBoolean, CFData, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_media::{
    CMSampleBuffer, CMTime, CMTimeFlags, CMVideoFormatDescriptionGetDimensions, kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms,
    kCMSampleAttachmentKey_NotSync, kCMTimeInvalid, kCMVideoCodecType_H264,
};
use objc2_core_video::{
    CVImageBuffer, kCVImageBufferColorPrimaries_ITU_R_709_2, kCVImageBufferTransferFunction_ITU_R_709_2,
    kCVImageBufferYCbCrMatrix_ITU_R_709_2,
};
use objc2_video_toolbox::{
    VTCompressionSession, VTEncodeInfoFlags, VTSessionSetProperty, kVTCompressionPropertyKey_AllowFrameReordering,
    kVTCompressionPropertyKey_AverageBitRate, kVTCompressionPropertyKey_ColorPrimaries, kVTCompressionPropertyKey_ExpectedFrameRate,
    kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, kVTCompressionPropertyKey_ProfileLevel, kVTCompressionPropertyKey_RealTime,
    kVTCompressionPropertyKey_TransferFunction, kVTCompressionPropertyKey_YCbCrMatrix, kVTEncodeFrameOptionKey_ForceKeyFrame,
    kVTProfileLevel_H264_High_AutoLevel,
};

use super::{CaptureError, host_ns};
use crate::writer::Media;

/// Where encoded samples go, and who hears that encoding failed. Called on VideoToolbox's thread.
pub trait VideoSink: Send + Sync {
    fn media(&self, media: Media);
    fn failed(&self, detail: String);
}

struct Callback {
    sink: Arc<dyn VideoSink>,
    format_sent: AtomicBool,
}

pub struct VideoEncoder {
    session: CFRetained<VTCompressionSession>,
    /// The callback's context, owned here and freed after the session is invalidated.
    callback: *const Callback,
}

// The session is thread-safe; the callback context is only read through shared references.
unsafe impl Send for VideoEncoder {}
unsafe impl Sync for VideoEncoder {}

fn set(session: &VTCompressionSession, key: &CFString, value: &CFType) -> Result<(), CaptureError> {
    let status = unsafe { VTSessionSetProperty(session, key, Some(value)) };
    if status == 0 { Ok(()) } else { Err(CaptureError::new("capture_start_failed", format!("encoder property {key} refused: {status}"))) }
}

impl VideoEncoder {
    pub fn new(width: u32, height: u32, frame_rate: u32, bitrate: u32, sink: Arc<dyn VideoSink>) -> Result<Self, CaptureError> {
        let callback = Arc::into_raw(Arc::new(Callback { sink, format_sent: AtomicBool::new(false) }));
        let mut session: *mut VTCompressionSession = null_mut();
        let status = unsafe {
            VTCompressionSession::create(
                None,
                width as i32,
                height as i32,
                kCMVideoCodecType_H264,
                None,
                None,
                None,
                Some(output),
                callback.cast_mut().cast(),
                NonNull::from(&mut session),
            )
        };
        let Some(session) = NonNull::new(session).filter(|_| status == 0) else {
            drop(unsafe { Arc::from_raw(callback) });
            return Err(CaptureError::new("capture_start_failed", format!("H.264 encoder could not be created: {status}")));
        };
        let encoder = Self { session: unsafe { CFRetained::from_raw(session) }, callback: callback.cast() };
        let s = &encoder.session;
        set(s, unsafe { kVTCompressionPropertyKey_RealTime }, CFBoolean::new(true))?;
        set(s, unsafe { kVTCompressionPropertyKey_AllowFrameReordering }, CFBoolean::new(false))?;
        set(s, unsafe { kVTCompressionPropertyKey_ProfileLevel }, unsafe { kVTProfileLevel_H264_High_AutoLevel })?;
        set(s, unsafe { kVTCompressionPropertyKey_AverageBitRate }, &CFNumber::new_i64(i64::from(bitrate)))?;
        set(s, unsafe { kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration }, &CFNumber::new_f64(1.0))?;
        set(s, unsafe { kVTCompressionPropertyKey_ExpectedFrameRate }, &CFNumber::new_i32(frame_rate as i32))?;
        set(s, unsafe { kVTCompressionPropertyKey_ColorPrimaries }, unsafe { kCVImageBufferColorPrimaries_ITU_R_709_2 })?;
        set(s, unsafe { kVTCompressionPropertyKey_TransferFunction }, unsafe { kCVImageBufferTransferFunction_ITU_R_709_2 })?;
        set(s, unsafe { kVTCompressionPropertyKey_YCbCrMatrix }, unsafe { kCVImageBufferYCbCrMatrix_ITU_R_709_2 })?;
        let status = unsafe { s.prepare_to_encode_frames() };
        if status != 0 {
            return Err(CaptureError::new("capture_start_failed", format!("H.264 encoder could not prepare: {status}")));
        }
        Ok(encoder)
    }

    /// Queues `image`, captured at `pts_ns` host time; the encoded sample arrives at the sink.
    pub fn encode(&self, image: &CVImageBuffer, pts_ns: u64, key_frame: bool) -> Result<(), String> {
        let pts = CMTime { value: pts_ns as i64, timescale: 1_000_000_000, flags: CMTimeFlags::Valid, epoch: 0 };
        let options = key_frame.then(|| {
            let key: &CFString = unsafe { kVTEncodeFrameOptionKey_ForceKeyFrame };
            CFDictionary::<CFString, CFBoolean>::from_slices(&[key], &[CFBoolean::new(true)])
        });
        let status = unsafe {
            self.session.encode_frame(
                image,
                pts,
                kCMTimeInvalid,
                options.as_deref().map(|d| d.as_opaque()),
                null_mut(),
                null_mut(),
            )
        };
        if status == 0 { Ok(()) } else { Err(format!("frame encode failed: {status}")) }
    }

    /// Emits every queued frame; returns once their samples have reached the sink.
    pub fn flush(&self) {
        unsafe { self.session.complete_frames(kCMTimeInvalid) };
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        unsafe { self.session.invalidate() };
        drop(unsafe { Arc::from_raw(self.callback) });
    }
}

unsafe extern "C-unwind" fn output(
    refcon: *mut c_void,
    _frame: *mut c_void,
    status: i32,
    _flags: VTEncodeInfoFlags,
    sample: *mut CMSampleBuffer,
) {
    let callback = unsafe { &*(refcon as *const Callback) };
    if status != 0 {
        callback.sink.failed(format!("H.264 encoding failed: {status}"));
        return;
    }
    // A frame the encoder dropped: nothing to write.
    let Some(sample) = (unsafe { sample.as_ref() }) else { return };
    if !callback.format_sent.load(Ordering::Acquire) {
        match unsafe { video_format(sample) } {
            Some(format) => {
                callback.format_sent.store(true, Ordering::Release);
                callback.sink.media(format);
            }
            None => {
                callback.sink.failed("the H.264 encoder produced no avcC configuration".into());
                return;
            }
        }
    }
    let Some(block) = (unsafe { sample.data_buffer() }) else { return };
    let length = unsafe { block.data_length() };
    let mut data = vec![0u8; length];
    let status = unsafe { block.copy_data_bytes(0, length, NonNull::new(data.as_mut_ptr().cast()).unwrap()) };
    if status != 0 {
        callback.sink.failed(format!("encoded frame could not be read: {status}"));
        return;
    }
    let pts_ns = host_ns(unsafe { sample.presentation_time_stamp() });
    callback.sink.media(Media::Video { data, pts_ns, sync: unsafe { is_sync(sample) } });
}

/// A sample is a sync sample unless its attachments say NotSync.
unsafe fn is_sync(sample: &CMSampleBuffer) -> bool {
    let Some(attachments) = (unsafe { sample.sample_attachments_array(false) }) else { return true };
    let Some(first) = (unsafe { attachments.cast_unchecked::<CFType>() }).get(0) else { return true };
    let Ok(dictionary) = first.downcast::<CFDictionary>() else { return true };
    let dictionary = unsafe { dictionary.cast_unchecked::<CFString, CFType>() };
    let not_sync = dictionary.get(unsafe { kCMSampleAttachmentKey_NotSync });
    !not_sync.and_then(|value| value.downcast::<CFBoolean>().ok()).is_some_and(|value| value.as_bool())
}

/// The `avcC` record and coded size from the first sample's format description.
unsafe fn video_format(sample: &CMSampleBuffer) -> Option<Media> {
    let format = unsafe { sample.format_description() }?;
    let atoms = unsafe { format.extension(kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) }?;
    let atoms = atoms.downcast::<CFDictionary>().ok()?;
    let atoms = unsafe { atoms.cast_unchecked::<CFString, CFType>() };
    let avcc = atoms.get(&CFString::from_static_str("avcC"))?.downcast::<CFData>().ok()?.to_vec();
    let dimensions = unsafe { CMVideoFormatDescriptionGetDimensions(&format) };
    Some(Media::VideoFormat { avcc, width: dimensions.width as u16, height: dimensions.height as u16 })
}
