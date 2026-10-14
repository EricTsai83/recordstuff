//! System audio through WASAPI process loopback (Windows 10 2004 and later): everything the system plays except
//! RecordStuff's process tree, whose root is main, so the countdown's ticks stay out of the recording as they do on
//! macOS. The stream is opened at 48 kHz stereo 32-bit float, converted by the audio engine when the mix differs, and
//! each packet goes to the core with its QPC time.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT;
use windows::Win32::System::Com::BLOB;
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;
use windows::core::{IUnknown, Interface, implement};

use super::{CaptureError, Mta, com, hundreds_to_ns, start_failed};
use crate::core::{CHANNELS, SAMPLE_RATE, Shared};

const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(5);
/// The engine's buffer: long enough that a busy moment loses nothing.
const BUFFER_100NS: i64 = 2_000_000;

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Activated(Mutex<Option<Sender<()>>>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(&self, _operation: windows::core::Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        if let Some(sender) = self.0.lock().unwrap().take() {
            let _ = sender.send(());
        }
        Ok(())
    }
}

/// An audio client for the system's sound without `exclude_pid`'s process tree.
fn loopback_client(exclude_pid: u32) -> Result<IAudioClient, CaptureError> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: exclude_pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let blob = PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: (&raw mut params).cast(),
                    },
                },
            }),
        },
    };
    let (sender, done) = channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Activated(Mutex::new(Some(sender))).into();
    let operation =
        unsafe { ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&blob), &handler) }
            .map_err(|e| start_failed("system audio capture is not available (Windows 10 2004 or later is needed)", e))?;
    done.recv_timeout(ACTIVATE_TIMEOUT)
        .map_err(|_| CaptureError::new("capture_start_failed", "system audio capture did not open within 5 s"))?;
    let mut result = windows::core::HRESULT(0);
    let mut client: Option<IUnknown> = None;
    unsafe { operation.GetActivateResult(&mut result, &mut client) }.map_err(|e| start_failed("system audio capture", e))?;
    result.ok().map_err(|e| start_failed("system audio capture was refused", e))?;
    client
        .ok_or_else(|| CaptureError::new("no_audio_track", "system audio capture gave no client"))?
        .cast()
        .map_err(|e| start_failed("system audio capture", e))
}

pub struct SoundCapture {
    client: Mta<IAudioClient>,
    event: Mta<HANDLE>,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl SoundCapture {
    pub fn start(exclude_pid: u32, shared: Arc<Shared<super::session::Win>>) -> Result<Self, CaptureError> {
        let client = loopback_client(exclude_pid)?;
        let block = 4 * CHANNELS as u16;
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
            nChannels: CHANNELS as u16,
            nSamplesPerSec: SAMPLE_RATE,
            nAvgBytesPerSec: SAMPLE_RATE * u32::from(block),
            nBlockAlign: block,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
        unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, BUFFER_100NS, 0, &format, None) }
            .map_err(|e| start_failed("system audio capture refused 48 kHz stereo", e))?;
        let event = unsafe { CreateEventW(None, false, false, None) }.map_err(|e| start_failed("an audio event", e))?;
        unsafe { client.SetEventHandle(event) }.map_err(|e| start_failed("the audio event", e))?;
        let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(|e| start_failed("the audio capture service", e))?;
        unsafe { client.Start() }.map_err(|e| start_failed("starting system audio capture", e))?;

        let running = Arc::new(AtomicBool::new(true));
        let event_handle = event;
        let (capture, event) = (Mta(capture), Mta(event));
        let thread = {
            let running = running.clone();
            std::thread::Builder::new()
                .name("recordstuff-sound".into())
                .spawn(move || {
                    com();
                    let (capture, event) = (capture, event);
                    if let Err(detail) = pump(&capture.0, event.0, &running, &shared) {
                        if running.load(Ordering::Acquire) {
                            shared.fail(detail);
                        }
                    }
                })
                .map_err(|e| CaptureError::new("capture_start_failed", format!("audio thread: {e}")))?
        };
        Ok(Self { client: Mta(client), event: Mta(event_handle), running, thread: Some(thread) })
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = unsafe { self.client.0.Stop() };
        // Only once the client has stopped signalling it.
        if !self.event.0.is_invalid() {
            let _ = unsafe { CloseHandle(self.event.0) };
            self.event.0 = HANDLE::default();
        }
    }
}

impl Drop for SoundCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Hands every packet to the core until stopped. Packets are read even while the core takes no sound, so the engine's
/// buffer never fills.
fn pump(capture: &IAudioCaptureClient, event: HANDLE, running: &AtomicBool, shared: &Shared<super::session::Win>) -> Result<(), String> {
    while running.load(Ordering::Acquire) {
        if unsafe { WaitForSingleObject(event, 100) } != WAIT_OBJECT_0 {
            continue;
        }
        loop {
            let size = unsafe { capture.GetNextPacketSize() }.map_err(|e| format!("system audio: {e}"))?;
            if size == 0 {
                break;
            }
            let (mut data, mut frames, mut flags, mut qpc) = (std::ptr::null_mut(), 0u32, 0u32, 0u64);
            unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc)) }.map_err(|e| format!("system audio: {e}"))?;
            if shared.wants_sound() && frames > 0 {
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null();
                let samples = if silent {
                    &[][..]
                } else {
                    unsafe { std::slice::from_raw_parts(data.cast::<f32>(), frames as usize * CHANNELS as usize) }
                };
                let channels = CHANNELS as usize;
                let result = shared.sound(hundreds_to_ns(qpc as i64), frames as usize, |frame, channel| {
                    if silent { 0.0 } else { samples[frame * channels + channel] }
                });
                if let Err(detail) = result {
                    let _ = unsafe { capture.ReleaseBuffer(frames) };
                    return Err(detail);
                }
            }
            unsafe { capture.ReleaseBuffer(frames) }.map_err(|e| format!("system audio: {e}"))?;
        }
    }
    Ok(())
}
