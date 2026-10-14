//! H.264 through Media Foundation (plan 076, D4): Microsoft's encoder transform, configured as VideoToolbox is on
//! macOS (no frame reordering, a key frame at least every second, the average bit rate `quality.ts` chose, BT.709 tags).
//! This prototype uses the software encoder, which every Windows edition with media features has; a GPU's hardware
//! encoder (an asynchronous transform) is step 4's.
//!
//! A key frame comes at least every second of presentation time, not every so many frames: a still screen sends one
//! frame a second, and fragments close only at key frames.
//!
//! `encode` reads the frame back to memory on the caller's thread and queues it; the transform runs on its own thread,
//! so capture is never held up by encoding. Its Annex B output becomes the muxer's length-prefixed samples (avc.rs).

use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::core::Interface;

use super::capture::{Frame, Gpu, Readback};
use super::mft::{bytes, outputs, pack, sample, set_codec, set_codec_flag};
use super::{CaptureError, Mta, com};
use crate::avc;
use crate::core::{VideoEncode, VideoSink};
use crate::timing::NANOS_PER_SECOND;
use crate::writer::Media;

enum Job {
    Frame { data: Vec<u8>, pts_ns: u64, key_frame: bool },
    Flush(Sender<()>),
}

pub struct H264Encoder {
    gpu: Arc<Mta<Gpu>>,
    readback: Mutex<(Readback, Vec<u8>)>,
    jobs: Mutex<Option<Sender<Job>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

unsafe impl Send for H264Encoder {}
unsafe impl Sync for H264Encoder {}

impl H264Encoder {
    pub fn new(gpu: Arc<Mta<Gpu>>, width: u32, height: u32, frame_rate: u32, bitrate: u32, sink: Arc<dyn VideoSink>) -> Result<Self, CaptureError> {
        let readback = Readback::new(width, height);
        let (jobs, received) = channel::<Job>();
        let (ready, made) = channel::<Result<(), CaptureError>>();
        let thread = std::thread::Builder::new()
            .name("recordstuff-h264".into())
            .spawn(move || {
                com();
                match Transform::new(width, height, frame_rate, bitrate) {
                    Ok(transform) => {
                        let _ = ready.send(Ok(()));
                        transform.run(received, sink, width, height);
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                    }
                }
            })
            .map_err(|e| CaptureError::new("capture_start_failed", format!("H.264 thread: {e}")))?;
        made.recv().unwrap_or_else(|_| Err(CaptureError::new("capture_start_failed", "the H.264 encoder thread ended")))?;
        Ok(Self { gpu, readback: Mutex::new((readback, Vec::new())), jobs: Mutex::new(Some(jobs)), thread: Mutex::new(Some(thread)) })
    }
}

impl H264Encoder {
    /// Queues a frame already in memory: NV12, tightly packed.
    pub(crate) fn queue(&self, data: Vec<u8>, pts_ns: u64, key_frame: bool) -> Result<(), String> {
        let jobs = self.jobs.lock().unwrap();
        let jobs = jobs.as_ref().ok_or("the H.264 encoder has stopped")?;
        jobs.send(Job::Frame { data, pts_ns, key_frame }).map_err(|_| "the H.264 encoder has stopped".to_string())
    }
}

impl VideoEncode<Frame> for H264Encoder {
    fn encode(&self, frame: &Frame, pts_ns: u64, key_frame: bool) -> Result<(), String> {
        let data = {
            let mut guard = self.readback.lock().unwrap();
            let (readback, scratch) = &mut *guard;
            readback.read(&self.gpu.0, &frame.0, scratch)?;
            scratch.clone()
        };
        self.queue(data, pts_ns, key_frame)
    }

    fn flush(&self) {
        let (done, flushed) = channel();
        let sent = self.jobs.lock().unwrap().as_ref().is_some_and(|jobs| jobs.send(Job::Flush(done)).is_ok());
        if sent {
            let _ = flushed.recv();
        }
    }
}

impl Drop for H264Encoder {
    fn drop(&mut self) {
        self.jobs.lock().unwrap().take();
        if let Some(thread) = self.thread.lock().unwrap().take() {
            let _ = thread.join();
        }
    }
}

struct Transform {
    transform: IMFTransform,
    codec: Option<ICodecAPI>,
    frame_duration: i64,
    frame_bytes: u32,
}

impl Transform {
    fn new(width: u32, height: u32, frame_rate: u32, bitrate: u32) -> Result<Self, CaptureError> {
        super::media_foundation()?;
        let fail = super::failing;
        let transform: IMFTransform =
            unsafe { CoCreateInstance(&CLSID_MSH264EncoderMFT, None, CLSCTX_INPROC_SERVER) }.map_err(fail("the H.264 encoder is not available"))?;
        let codec = transform.cast::<ICodecAPI>().map_err(fail("the H.264 encoder has no settings interface"))?;
        // Set before the media types, which some settings are read with. Low latency means no reordering and every
        // frame out as it goes in, which the timestamps rely on: the encoder must take it.
        set_codec(&codec, &CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_UnconstrainedVBR.0 as u32);
        set_codec(&codec, &CODECAPI_AVEncCommonMeanBitRate, bitrate);
        set_codec(&codec, &CODECAPI_AVEncMPVGOPSize, frame_rate);
        set_codec(&codec, &CODECAPI_AVEncMPVDefaultBPictureCount, 0);
        if !set_codec_flag(&codec, &CODECAPI_AVLowLatencyMode, true) {
            return Err(CaptureError::new("capture_start_failed", "the H.264 encoder refused low-latency mode"));
        }
        let codec = Some(codec);
        let colour = |kind: &IMFMediaType| -> windows::core::Result<()> {
            unsafe {
                kind.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
                kind.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
                kind.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
                kind.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)
            }
        };
        let shape = |kind: &IMFMediaType| -> windows::core::Result<()> {
            unsafe {
                kind.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
                kind.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
                kind.SetUINT64(&MF_MT_FRAME_RATE, pack(frame_rate, 1))?;
                kind.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
                kind.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            }
        };
        let output = unsafe { MFCreateMediaType() }.map_err(fail("a media type"))?;
        (|| -> windows::core::Result<()> {
            shape(&output)?;
            colour(&output)?;
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
            colour(&input)?;
            unsafe {
                input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
                transform.SetInputType(0, &input, 0)
            }
        })()
        .map_err(fail("the NV12 input format was refused"))?;
        unsafe {
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).map_err(fail("starting the H.264 encoder"))?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0).map_err(fail("starting the H.264 encoder"))?;
        }
        Ok(Self { transform, codec, frame_duration: 10_000_000 / i64::from(frame_rate.max(1)), frame_bytes: width * height * 3 / 2 })
    }

    fn run(self, jobs: Receiver<Job>, sink: Arc<dyn VideoSink>, width: u32, height: u32) {
        let mut format_sent = false;
        // Each frame's encoder time (100 ns units from the first frame) and its capture time in ns: an output's own
        // time finds its frame, so a frame the encoder left out cannot shift the others' times.
        let mut times: VecDeque<(i64, u64)> = VecDeque::new();
        let mut origin = None;
        // A key frame at least every second of presentation time, as on macOS, however few frames a still screen
        // sends: video fragments close at key frames.
        let mut last_key: Option<u64> = None;
        let mut deliver = |samples: Vec<IMFSample>, times: &mut VecDeque<(i64, u64)>, origin: u64| -> Result<(), String> {
            for produced in samples {
                let (data, time) = bytes(&produced).map_err(|e| format!("reading an H.264 sample: {e}"))?;
                while times.front().is_some_and(|&(queued, _)| queued < time) {
                    times.pop_front();
                }
                let pts_ns = match times.front() {
                    Some(&(queued, pts)) if queued == time => {
                        times.pop_front();
                        pts
                    }
                    _ => origin + time.max(0) as u64 * 100,
                };
                if !format_sent {
                    let (sps, pps) = avc::parameter_sets(&data).ok_or("the first H.264 sample has no parameter sets")?;
                    sink.media(Media::VideoFormat { avcc: avc::decoder_config(sps, pps), width: width as u16, height: height as u16 });
                    format_sent = true;
                }
                let (data, sync) = avc::sample(&data);
                sink.media(Media::Video { data, pts_ns, sync });
            }
            Ok(())
        };
        for job in jobs {
            let result = match job {
                Job::Frame { data, pts_ns, key_frame } => {
                    let origin = *origin.get_or_insert(pts_ns);
                    let due = last_key.is_none_or(|last| pts_ns.saturating_sub(last) >= NANOS_PER_SECOND);
                    if key_frame || due {
                        if let Some(codec) = self.codec.as_ref() {
                            set_codec(codec, &CODECAPI_AVEncVideoForceKeyFrame, 1);
                        }
                        last_key = Some(pts_ns);
                    }
                    let time = ((pts_ns - origin) / 100) as i64;
                    times.push_back((time, pts_ns));
                    sample(&data, time, self.frame_duration)
                        .and_then(|input| unsafe { self.transform.ProcessInput(0, &input, 0) })
                        .and_then(|()| outputs(&self.transform, self.frame_bytes))
                        .map_err(|e| format!("H.264 encoding failed: {e}"))
                        .and_then(|samples| deliver(samples, &mut times, origin))
                }
                Job::Flush(done) => {
                    let origin = origin.unwrap_or(0);
                    let result = unsafe { self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0) }
                        .and_then(|()| outputs(&self.transform, self.frame_bytes))
                        .map_err(|e| format!("H.264 encoding failed: {e}"))
                        .and_then(|samples| deliver(samples, &mut times, origin));
                    let _ = done.send(());
                    result
                }
            };
            if let Err(detail) = result {
                sink.failed(detail);
                return;
            }
        }
    }
}
