//! H.264 through Media Foundation (plan 076, D4): Microsoft's encoder transform, configured as VideoToolbox is on
//! macOS (no frame reordering, a key frame at least every second, the average bit rate `quality.ts` chose, BT.709 tags).
//! A GPU's hardware encoder records when encoder_choice.rs allows it and it passes its self-test (plan 078 step 4,
//! hardware.rs); otherwise the software encoder, which every Windows edition with media features has. A hardware
//! encoder that fails before its first sample reached the muxer hands its frames to the software encoder silently;
//! one that fails after ends the recording with what was written, as a capture failure, and either way later
//! recordings on that adapter and driver use the software encoder.
//!
//! A key frame comes at least every second of presentation time, not every so many frames: a still screen sends one
//! frame a second, and fragments close only at key frames.
//!
//! With the software encoder, `encode` reads the frame back to memory on the caller's thread and queues it; with the
//! hardware encoder it queues the GPU texture itself. Either transform runs on its own thread, so capture is never held
//! up by encoding. Its Annex B output becomes the muxer's length-prefixed samples (avc.rs).

use std::collections::VecDeque;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::core::Interface;

use super::capture::{Frame, Gpu, Readback};
use super::hardware::{self, HardwareTransform};
use super::mft::{bytes, outputs, pack, sample, set_codec, set_codec_flag};
use super::{CaptureError, Mta, com};
use crate::async_encoder::{self, Ended, Message, Watchdog};
use crate::avc;
use crate::core::{VideoEncode, VideoSink};
use crate::encoder_choice::{self, Adapter, Choice, Record};
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
    /// The hardware encoder's channel, when it records: frames go to it as textures.
    hardware: Mutex<Option<Sender<Message<Frame>>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
    /// Which encoder records, and why, for the log.
    pub description: String,
}

unsafe impl Send for H264Encoder {}
unsafe impl Sync for H264Encoder {}

impl H264Encoder {
    /// The hardware encoder when encoder_choice.rs allows it and it is there and works, the software encoder otherwise.
    pub fn new(gpu: Arc<Mta<Gpu>>, width: u32, height: u32, frame_rate: u32, bitrate: u32, sink: Arc<dyn VideoSink>) -> Result<Self, CaptureError> {
        let Some((adapter, luid)) = hardware::adapter(&gpu.0) else {
            return Self::software(gpu, width, height, frame_rate, bitrate, sink, "the adapter could not be read".into());
        };
        let mut record = Record::from_env();
        let choice = encoder_choice::choose(&adapter, (width, height), encoder_choice::forced_software(), &record);
        let why = match choice {
            Choice::Software(why) => why,
            Choice::Hardware | Choice::SelfTest => match hardware::find(luid) {
                Ok(None) => format!("{} has no hardware H.264 encoder", adapter.name),
                Err(why) => why,
                Ok(Some(activate)) => {
                    let tested = match choice {
                        Choice::SelfTest => hardware::self_test(&activate, &gpu, width, height, frame_rate),
                        _ => Ok(()),
                    };
                    match tested {
                        Err(why) => {
                            record.failed(&adapter, &why);
                            format!("{}'s hardware encoder failed its self-test: {why}", adapter.name)
                        }
                        Ok(()) => {
                            if choice == Choice::SelfTest {
                                record.passed(&adapter, (width, height));
                            }
                            // A fresh activation object: the self-test's shut its own down.
                            match hardware::find(luid) {
                                Ok(Some(activate)) => {
                                    match Self::hardware(gpu.clone(), activate, adapter.clone(), record, (width, height, frame_rate, bitrate), sink.clone()) {
                                        Ok(encoder) => return Ok(encoder),
                                        Err(why) => why,
                                    }
                                }
                                Ok(None) => format!("{}'s hardware encoder went away", adapter.name),
                                Err(why) => why,
                            }
                        }
                    }
                }
            },
        };
        Self::software(gpu, width, height, frame_rate, bitrate, sink, why)
    }

    /// The hardware encoder on its own thread, driven by async_encoder.rs.
    fn hardware(
        gpu: Arc<Mta<Gpu>>,
        activate: windows::Win32::Media::MediaFoundation::IMFActivate,
        adapter: Adapter,
        mut record: Record,
        (width, height, frame_rate, bitrate): (u32, u32, u32, u32),
        sink: Arc<dyn VideoSink>,
    ) -> Result<Self, String> {
        let (sender, messages) = channel::<Message<Frame>>();
        let (ready, made) = channel::<Result<(), String>>();
        let events = sender.clone();
        let thread_gpu = gpu.clone();
        let activate = Mta(activate);
        let name = adapter.name.clone();
        let thread = std::thread::Builder::new()
            .name("recordstuff-h264-hardware".into())
            .spawn(move || {
                com();
                let mut transform = match HardwareTransform::open(activate.get(), &thread_gpu.0, (width, height, frame_rate, bitrate), events) {
                    Ok(transform) => transform,
                    Err(why) => {
                        let _ = ready.send(Err(why));
                        return;
                    }
                };
                let _ = ready.send(Ok(()));
                let ended = async_encoder::drive(&mut transform, &messages, &sink, (width, height, frame_rate), Watchdog::default());
                drop(transform);
                let Ended::Failed { detail, fallback } = ended else { return };
                record.failed(&adapter, &detail);
                match fallback {
                    // Nothing reached the muxer: the software encoder takes over silently, from the first frame.
                    Some(fallback) => {
                        eprintln!("H.264: {}'s hardware encoder failed before its first sample ({detail}); the software encoder records", adapter.name);
                        let transform = match Transform::new(width, height, frame_rate, bitrate) {
                            Ok(transform) => transform,
                            Err(error) => {
                                sink.failed(format!("the hardware H.264 encoder failed ({detail}) and the software encoder could not start: {}", error.detail));
                                return;
                            }
                        };
                        let mut readback = (Readback::new(width, height), Vec::new());
                        let mut read = move |frame: &Frame| -> Result<Vec<u8>, String> {
                            readback.0.read(&thread_gpu.0, frame.get(), &mut readback.1)?;
                            Ok(readback.1.clone())
                        };
                        let held: Vec<Result<Job, String>> = fallback
                            .frames
                            .into_iter()
                            .map(|(frame, pts_ns, key_frame)| read(&frame).map(|data| Job::Frame { data, pts_ns, key_frame }))
                            .chain(fallback.flush.map(|done| Ok(Job::Flush(done))))
                            .collect();
                        let rest = messages.iter().map_while(|message| match message {
                            Message::Close => None,
                            Message::Frame { frame, pts_ns, key_frame } => Some(Some(read(&frame).map(|data| Job::Frame { data, pts_ns, key_frame }))),
                            Message::Flush(done) => Some(Some(Ok(Job::Flush(done)))),
                            Message::Event(_) => Some(None),
                        });
                        transform.run(held.into_iter().chain(rest.flatten()), sink, width, height);
                    }
                    None => sink.failed(format!("the hardware H.264 encoder stopped: {detail}")),
                }
            })
            .map_err(|e| format!("H.264 thread: {e}"))?;
        made.recv().unwrap_or_else(|_| Err("the hardware H.264 encoder's thread ended".into()))?;
        Ok(Self {
            readback: Mutex::new((Readback::new(width, height), Vec::new())),
            gpu,
            jobs: Mutex::new(None),
            hardware: Mutex::new(Some(sender)),
            thread: Mutex::new(Some(thread)),
            description: format!("H.264: the hardware encoder of {name}"),
        })
    }

    /// The preview's encoder (plan 075, D17): Microsoft's software encoder, leaving the GPU's to the recording.
    pub fn for_preview(gpu: Arc<Mta<Gpu>>, width: u32, height: u32, frame_rate: u32, bitrate: u32, sink: Arc<dyn VideoSink>) -> Result<Self, CaptureError> {
        Self::software(gpu, width, height, frame_rate, bitrate, sink, "the preview".into())
    }

    /// Microsoft's software encoder, and why it records.
    fn software(
        gpu: Arc<Mta<Gpu>>,
        width: u32,
        height: u32,
        frame_rate: u32,
        bitrate: u32,
        sink: Arc<dyn VideoSink>,
        why: String,
    ) -> Result<Self, CaptureError> {
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
                        transform.run(received.into_iter().map(Ok), sink, width, height);
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                    }
                }
            })
            .map_err(|e| CaptureError::new("capture_start_failed", format!("H.264 thread: {e}")))?;
        made.recv().unwrap_or_else(|_| Err(CaptureError::new("capture_start_failed", "the H.264 encoder thread ended")))?;
        Ok(Self {
            gpu,
            readback: Mutex::new((readback, Vec::new())),
            jobs: Mutex::new(Some(jobs)),
            hardware: Mutex::new(None),
            thread: Mutex::new(Some(thread)),
            description: format!("H.264: the software encoder ({why})"),
        })
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
        if let Some(hardware) = self.hardware.lock().unwrap().as_ref() {
            return hardware.send(Message::Frame { frame: frame.clone(), pts_ns, key_frame }).map_err(|_| "the H.264 encoder has stopped".to_string());
        }
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
        let sent = match self.hardware.lock().unwrap().as_ref() {
            Some(hardware) => hardware.send(Message::Flush(done)).is_ok(),
            None => self.jobs.lock().unwrap().as_ref().is_some_and(|jobs| jobs.send(Job::Flush(done)).is_ok()),
        };
        if sent {
            let _ = flushed.recv();
        }
    }
}

impl Drop for H264Encoder {
    fn drop(&mut self) {
        self.jobs.lock().unwrap().take();
        if let Some(hardware) = self.hardware.lock().unwrap().take() {
            let _ = hardware.send(Message::Close);
        }
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

/// An `avcC` record and the samples encoded with it, each with whether it is a key frame.
pub(crate) type Encoded = (Vec<u8>, Vec<(Vec<u8>, bool)>);

/// Encodes NV12 pictures already in memory (tightly packed), the first a key frame, with the recording's settings at
/// the H.264 level `level` (`level_idc`): an export's re-encoded pictures (plan 085). Returns the `avcC` record and one
/// sample per picture.
pub(crate) fn encode_pictures(
    width: u32,
    height: u32,
    frame_rate: u32,
    bitrate: u32,
    level: Option<u8>,
    pictures: impl Iterator<Item = Result<(Vec<u8>, u64), String>>,
) -> Result<Encoded, String> {
    struct Collect(Mutex<(Vec<Media>, Option<String>)>);
    impl VideoSink for Collect {
        fn media(&self, media: Media) {
            self.0.lock().unwrap().0.push(media);
        }
        fn failed(&self, detail: String) {
            self.0.lock().unwrap().1.get_or_insert(detail);
        }
    }
    let transform = Transform::with_level(width, height, frame_rate, bitrate, level).map_err(|e| e.detail)?;
    let collect = Arc::new(Collect(Mutex::new((Vec::new(), None))));
    let (done, _flushed) = channel();
    let jobs = pictures
        .enumerate()
        .map(|(n, picture)| picture.map(|(data, pts_ns)| Job::Frame { data, pts_ns, key_frame: n == 0 }))
        .chain(std::iter::once(Ok(Job::Flush(done))));
    transform.run(jobs, collect.clone(), width, height);
    let (media, failure) = std::mem::take(&mut *collect.0.lock().unwrap());
    if let Some(failure) = failure {
        return Err(failure);
    }
    let mut avcc = None;
    let mut samples = Vec::new();
    for item in media {
        match item {
            Media::VideoFormat { avcc: record, .. } => avcc = Some(record),
            Media::Video { data, sync, .. } => samples.push((data, sync)),
            Media::Audio { .. } => {}
        }
    }
    Ok((avcc.ok_or("the H.264 encoder produced no parameter sets")?, samples))
}

impl Transform {
    fn new(width: u32, height: u32, frame_rate: u32, bitrate: u32) -> Result<Self, CaptureError> {
        Self::with_level(width, height, frame_rate, bitrate, None)
    }

    fn with_level(width: u32, height: u32, frame_rate: u32, bitrate: u32, level: Option<u8>) -> Result<Self, CaptureError> {
        super::media_foundation()?;
        let fail = super::failing;
        let transform: IMFTransform = unsafe { CoCreateInstance(&CLSID_MSH264EncoderMFT, None, CLSCTX_INPROC_SERVER) }
            .map_err(super::encoder_missing("the H.264 encoder is not available"))?;
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
                // eAVEncH264VLevel's values are level_idc.
                if let Some(level) = level {
                    output.SetUINT32(&MF_MT_MPEG2_LEVEL, u32::from(level))?;
                }
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

    /// Encodes each job in turn; a job that could not be made (a frame not read back) ends the stream as a failure.
    fn run(self, jobs: impl Iterator<Item = Result<Job, String>>, sink: Arc<dyn VideoSink>, width: u32, height: u32) {
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
            let job = match job {
                Ok(job) => job,
                Err(detail) => {
                    sink.failed(detail);
                    return;
                }
            };
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
