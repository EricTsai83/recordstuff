//! Sound through WASAPI, each stream one of the core's inputs: system audio through process loopback (Windows 10 2004
//! and later), everything the system plays except RecordStuff's process tree, whose root is main, so the countdown's
//! ticks stay out of the recording as they do on macOS; or only a chosen process tree's sound (step 4, engine only);
//! and the microphone (074's input). Every stream is opened at 48 kHz stereo 32-bit float, converted by the audio
//! engine when the device differs (a mono microphone is heard in both channels), and each packet goes to the core with
//! its QPC time.
//!
//! Process loopback sends no packets while nothing plays; the core's mixer advances the track past that (mixer.rs).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, E_ACCESSDENIED, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT;
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{BLOB, CLSCTX_ALL, CoCreateInstance, CoTaskMemFree, STGM_READ};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;
use windows::core::{HSTRING, IUnknown, Interface, implement};

use super::{CaptureError, com, hundreds_to_ns, now_ns, start_failed};
use crate::core::{CHANNELS, SAMPLE_RATE, Shared};
use crate::timing::PacketTimes;

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

/// What one stream captures.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Sound {
    /// Everything the system plays except this process tree.
    AllExcept(u32),
    /// Only this process tree's sound.
    Only(u32),
    /// An input device: its endpoint ID, or the default input.
    Microphone(Option<String>),
}

/// An audio client for the system's sound with or without `pid`'s process tree.
fn loopback_client(pid: u32, include: bool) -> Result<IAudioClient, CaptureError> {
    let mode = if include { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE } else { PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE };
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { TargetProcessId: pid, ProcessLoopbackMode: mode },
        },
    };
    // Never cleared: PROPVARIANT's Drop would free the blob, which points at `params` on this stack.
    let blob = std::mem::ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 { blob: BLOB { cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: (&raw mut params).cast() } },
            }),
        },
    });
    let (sender, done) = channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Activated(Mutex::new(Some(sender))).into();
    let operation = unsafe { ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*blob), &handler) }
        .map_err(|e| start_failed("system audio capture is not available (Windows 10 2004 or later is needed)", e))?;
    done.recv_timeout(ACTIVATE_TIMEOUT).map_err(|_| CaptureError::new("capture_start_failed", "system audio capture did not open within 5 s"))?;
    let mut result = windows::core::HRESULT(0);
    let mut client: Option<IUnknown> = None;
    unsafe { operation.GetActivateResult(&mut result, &mut client) }.map_err(|e| start_failed("system audio capture", e))?;
    result.ok().map_err(|e| start_failed("system audio capture was refused", e))?;
    client
        .ok_or_else(|| CaptureError::new("no_audio_track", "system audio capture gave no client"))?
        .cast()
        .map_err(|e| start_failed("system audio capture", e))
}

fn enumerator() -> Result<IMMDeviceEnumerator, CaptureError> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| start_failed("the audio devices could not be listed", e))
}

/// A microphone that cannot be opened refuses the recording (074); one lost while recording is told instead.
fn microphone_unavailable(detail: impl std::fmt::Display) -> CaptureError {
    CaptureError::new("microphone_unavailable", format!("microphone: {detail}"))
}

/// E_ACCESSDENIED is Settings > Privacy & security > Microphone refusing desktop apps, at Activate or Initialize
/// (Chromium maps it to a permission failure too); anything else is the device's.
fn microphone_refused(what: &str, e: &windows::core::Error) -> CaptureError {
    if e.code() == E_ACCESSDENIED {
        microphone_unavailable("access is not allowed (Settings > Privacy & security > Microphone)")
    } else {
        microphone_unavailable(format!("{what} ({e})"))
    }
}

/// An audio client for the input device `id`, or the default input, with the opened device's ID and name. A chosen
/// device that is not connected falls back to the default input, and the note says so (074).
fn microphone_client(id: Option<&str>) -> Result<(IAudioClient, Option<String>, String, String), CaptureError> {
    let devices = enumerator()?;
    let chosen = id.and_then(|id| active_device(&devices, id));
    let note = match (id, &chosen) {
        (Some(id), None) => Some(format!("microphone: {id} is not connected; the default input is used")),
        _ => None,
    };
    let device = match chosen {
        Some(device) => device,
        None => unsafe { devices.GetDefaultAudioEndpoint(eCapture, eConsole) }.map_err(|e| microphone_unavailable(format!("there is no audio input ({e})")))?,
    };
    let opened = unsafe { device.GetId() }.ok().map(take_id).unwrap_or_default();
    let client = unsafe { device.Activate::<IAudioClient>(CLSCTX_ALL, None) }.map_err(|e| microphone_refused("the device could not be opened", &e))?;
    let name = device_name(&device).unwrap_or_else(|| "an audio input".into());
    Ok((client, note, name, opened))
}

/// The input device `id` while it is connected.
fn active_device(devices: &IMMDeviceEnumerator, id: &str) -> Option<IMMDevice> {
    unsafe { devices.GetDevice(&HSTRING::from(id)) }.ok().filter(|device| unsafe { device.GetState() }.is_ok_and(|state| state == DEVICE_STATE_ACTIVE))
}

/// An endpoint ID as text, its COM string freed.
fn take_id(id: windows::core::PWSTR) -> String {
    let text = unsafe { id.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(id.0 as *const _)) };
    text
}

fn device_name(device: &IMMDevice) -> Option<String> {
    let store = unsafe { device.OpenPropertyStore(STGM_READ) }.ok()?;
    let value = unsafe { store.GetValue(&PKEY_Device_FriendlyName) }.ok()?;
    Some(value.to_string())
}

/// The active audio inputs, the default marked.
pub fn microphones() -> Result<Vec<crate::core::Microphone>, CaptureError> {
    super::com();
    let devices = enumerator()?;
    let default = unsafe { devices.GetDefaultAudioEndpoint(eCapture, eConsole) }.ok().and_then(|device| unsafe { device.GetId() }.ok().map(take_id));
    let collection =
        unsafe { devices.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) }.map_err(|e| start_failed("the audio inputs could not be listed", e))?;
    let count = unsafe { collection.GetCount() }.map_err(|e| start_failed("the audio inputs could not be counted", e))?;
    let mut found = Vec::new();
    for index in 0..count {
        let Ok(device) = (unsafe { collection.Item(index) }) else { continue };
        let Ok(id) = (unsafe { device.GetId() }) else { continue };
        let id = take_id(id);
        found.push(crate::core::Microphone { default: default.as_deref() == Some(id.as_str()), name: device_name(&device).unwrap_or_else(|| id.clone()), id });
    }
    Ok(found)
}

pub struct SoundCapture {
    /// What the recording should know about how this input was opened: a chosen microphone replaced by the default.
    pub note: Option<String>,
    /// The microphone's name, for the recording's report; None for system or apps' sound.
    pub name: Option<String>,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// A started WASAPI stream; dropping it stops the client, then closes the event it signals.
struct Stream {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    event: HANDLE,
}

// Created in the multithreaded apartment, as `Mta`'s objects are.
unsafe impl Send for Stream {}

impl Drop for Stream {
    fn drop(&mut self) {
        let _ = unsafe { self.client.Stop() };
        // Only once the client has stopped signalling it.
        if !self.event.is_invalid() {
            let _ = unsafe { CloseHandle(self.event) };
        }
    }
}

/// The waits between attempts to open a lost microphone again, the last repeated, as on macOS (plan 078 step 6).
const BACKOFF: [Duration; 5] = [Duration::from_secs(2), Duration::from_secs(4), Duration::from_secs(8), Duration::from_secs(16), Duration::from_secs(30)];

/// Initializes `client` for `sound`'s format and starts it.
fn open_stream(client: IAudioClient, microphone: bool) -> Result<Stream, CaptureError> {
    // A microphone in one channel, heard in both of the track's (074, as Cap does): Windows mixes a device's
    // channels down, so an audio interface's microphone on its first input is not in the left ear only.
    let channels: u16 = if microphone { 1 } else { CHANNELS as u16 };
    let block = 4 * channels;
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
        nChannels: channels,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * u32::from(block),
        nBlockAlign: block,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    let mut flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    if !microphone {
        flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
    }
    unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, BUFFER_100NS, 0, &format, None) }.map_err(|e| {
        if microphone { microphone_refused("the device refused 48 kHz mono", &e) } else { start_failed("system audio capture refused 48 kHz stereo", e) }
    })?;
    if microphone {
        // Opening a microphone can make Windows lower other apps' sound as for a call, which the recorded system
        // audio would carry (074 records it untouched): this stream opts out. Best effort, as an old Windows may
        // not offer it.
        if let Ok(control) = unsafe { client.GetService::<IAudioSessionControl>() }.and_then(|control| control.cast::<IAudioSessionControl2>()) {
            let _ = unsafe { control.SetDuckingPreference(true) };
        }
    }
    // A microphone's failures are the microphone's, with its own guidance (074); system sound keeps its own.
    let failed = |what: &str, e: windows::core::Error| {
        if microphone { microphone_unavailable(format!("{what} ({e})")) } else { start_failed(&format!("{what} for system audio"), e) }
    };
    let event = unsafe { CreateEventW(None, false, false, None) }.map_err(|e| failed("an audio event could not be made", e))?;
    let capture = match unsafe { client.GetService::<IAudioCaptureClient>() } {
        Ok(capture) => capture,
        Err(e) => {
            let _ = unsafe { CloseHandle(event) };
            return Err(failed("the audio capture service is unavailable", e));
        }
    };
    // From here the stream owns the event: an error below stops the client and closes it.
    let stream = Stream { client, capture, event };
    unsafe { stream.client.SetEventHandle(event) }.map_err(|e| failed("the audio event could not be set", e))?;
    unsafe { stream.client.Start() }.map_err(|e| failed("capture did not start", e))?;
    Ok(stream)
}

/// The microphone `id` opened again, once it is connected.
fn reopen_microphone(id: &str) -> Result<Option<Stream>, String> {
    let devices = enumerator().map_err(|e| e.detail)?;
    let Some(device) = active_device(&devices, id) else { return Ok(None) };
    let client = unsafe { device.Activate::<IAudioClient>(CLSCTX_ALL, None) }.map_err(|e| e.to_string())?;
    open_stream(client, true).map(Some).map_err(|e| e.detail)
}

impl SoundCapture {
    /// Opens `sound` and hands it to `shared` as `input`.
    pub fn start(sound: &Sound, input: usize, shared: Arc<Shared<super::session::Win>>) -> Result<Self, CaptureError> {
        let (client, note, name, device) = match sound {
            Sound::AllExcept(pid) => (loopback_client(*pid, false)?, None, None, None),
            Sound::Only(pid) => (loopback_client(*pid, true)?, None, None, None),
            Sound::Microphone(id) => {
                let (client, note, name, device) = microphone_client(id.as_deref())?;
                (client, note, Some(name), Some(device))
            }
        };
        let microphone = matches!(sound, Sound::Microphone(_));
        let channels = if microphone { 1 } else { CHANNELS as usize };
        let stream = open_stream(client, microphone)?;
        let running = Arc::new(AtomicBool::new(true));
        let thread = {
            let running = running.clone();
            let label = name.clone().unwrap_or_default();
            std::thread::Builder::new()
                .name("recordstuff-sound".into())
                .spawn(move || {
                    com();
                    let mut stream = Some(stream);
                    let mut attempts = 0usize;
                    while running.load(Ordering::Acquire) {
                        let Some(open) = stream.as_ref() else { break };
                        let Err(detail) = pump(&open.capture, open.event, &running, &shared, input, microphone, channels) else { break };
                        if !running.load(Ordering::Acquire) {
                            break;
                        }
                        if !microphone {
                            shared.fail(detail);
                            break;
                        }
                        // An unplugged microphone (AUDCLNT_E_DEVICE_INVALIDATED) loses the microphone, not the
                        // recording, and is opened again by its endpoint ID once it is connected (plan 078 step 6): the
                        // device opened at the start, the default input's included, never a new default.
                        shared.lose_microphone(detail.replacen("system audio", "microphone", 1));
                        stream = None;
                        let Some(id) = device.as_deref().filter(|id| !id.is_empty()) else { break };
                        while running.load(Ordering::Acquire) && stream.is_none() {
                            let wait = match reopen_microphone(id) {
                                Ok(Some(reopened)) => {
                                    eprintln!("microphone: {label} opened again");
                                    stream = Some(reopened);
                                    attempts = 0;
                                    continue;
                                }
                                // Not connected: looked for again in a second.
                                Ok(None) => Duration::from_secs(1),
                                Err(why) => {
                                    let wait = BACKOFF[attempts.min(BACKOFF.len() - 1)];
                                    attempts += 1;
                                    eprintln!("microphone: {label} could not be opened again ({why}); retrying in {} s", wait.as_secs());
                                    wait
                                }
                            };
                            let until = std::time::Instant::now() + wait;
                            while running.load(Ordering::Acquire) && std::time::Instant::now() < until {
                                std::thread::sleep(Duration::from_millis(100));
                            }
                        }
                    }
                })
                .map_err(|e| CaptureError::new("capture_start_failed", format!("audio thread: {e}")))?
        };
        Ok(Self { note, name, running, thread: Some(thread) })
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::Release);
        // The thread drops its stream, stopping the client and closing its event, before it ends.
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
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
fn pump(
    capture: &IAudioCaptureClient,
    event: HANDLE,
    running: &AtomicBool,
    shared: &Shared<super::session::Win>,
    input: usize,
    microphone: bool,
    channels: usize,
) -> Result<(), String> {
    // Only a microphone's positions are checked: loopback's come from the render clock the recording is timed by.
    let mut times = microphone.then(PacketTimes::default);
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
            let mut pts = hundreds_to_ns(qpc as i64);
            if let Some(times) = times.as_mut().filter(|_| frames > 0) {
                let error = flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0;
                pts = times.time(pts, now_ns(), u64::from(frames), SAMPLE_RATE, error);
            }
            if shared.reads_sound() && frames > 0 {
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null();
                let samples = if silent { &[][..] } else { unsafe { std::slice::from_raw_parts(data.cast::<f32>(), frames as usize * channels) } };
                let result = shared.sound(
                    input,
                    pts,
                    frames as usize,
                    |frame, channel| {
                        if silent { 0.0 } else { samples[frame * channels + channel.min(channels - 1)] }
                    },
                );
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
