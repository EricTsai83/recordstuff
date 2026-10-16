//! CoreAudio's hardware abstraction layer, for the microphone (plan 078 step 6): its devices, an AUHAL input unit on
//! one of them and an AudioConverter to 48 kHz. These are C interfaces, declared here as their headers do.
//!
//! The HAL keeps its device list current in a process that runs no main run loop, as the capture `utilityProcess`
//! does not: a probe on 2026-10-16 found it drop a disconnected Bluetooth headset at once, while AVFoundation still
//! listed it 27 s later. That is why the microphone is read here and not through AVCaptureSession, as Chromium's audio
//! service and Cap (through cpal) do.

use std::ffi::c_void;
use std::ptr::{NonNull, null, null_mut};

use objc2_core_audio_types::{AudioBuffer, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp, kAudioFormatFlagIsFloat, kAudioFormatFlagIsPacked, kAudioFormatLinearPCM};
use objc2_core_foundation::{CFRetained, CFString};

pub type ObjectId = u32;
type OsStatus = i32;
type AudioUnit = *mut c_void;
type AudioComponent = *mut c_void;
type AudioConverterRef = *mut c_void;

const fn code(text: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*text)
}

const SYSTEM_OBJECT: ObjectId = 1;
const DEVICES: u32 = code(b"dev#");
const DEFAULT_INPUT: u32 = code(b"dIn ");
const UID_TO_DEVICE: u32 = code(b"uidd");
const DEVICE_UID: u32 = code(b"uid ");
const NAME: u32 = code(b"lnam");
const STREAMS: u32 = code(b"stm#");
const ALIVE: u32 = code(b"livn");
const NOMINAL_RATE: u32 = code(b"nsrt");
const SCOPE_GLOBAL: u32 = code(b"glob");
const SCOPE_INPUT: u32 = code(b"inpt");
const ELEMENT_MAIN: u32 = 0;

#[repr(C)]
struct Address {
    selector: u32,
    scope: u32,
    element: u32,
}

#[repr(C)]
struct ComponentDescription {
    kind: u32,
    sub_kind: u32,
    manufacturer: u32,
    flags: u32,
    flags_mask: u32,
}

type RenderCallback = unsafe extern "C" fn(*mut c_void, *mut u32, *const AudioTimeStamp, u32, u32, *mut AudioBufferList) -> OsStatus;
type ConverterInput = unsafe extern "C" fn(AudioConverterRef, *mut u32, *mut AudioBufferList, *mut *mut c_void, *mut c_void) -> OsStatus;

#[repr(C)]
struct RenderCallbackStruct {
    proc: RenderCallback,
    refcon: *mut c_void,
}

#[repr(C)]
struct Timebase {
    numer: u32,
    denom: u32,
}

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioObjectGetPropertyDataSize(object: ObjectId, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: *mut u32) -> OsStatus;
    fn AudioObjectGetPropertyData(
        object: ObjectId,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> OsStatus;
}

#[link(name = "AudioToolbox", kind = "framework")]
unsafe extern "C" {
    fn AudioComponentFindNext(after: AudioComponent, description: *const ComponentDescription) -> AudioComponent;
    fn AudioComponentInstanceNew(component: AudioComponent, instance: *mut AudioUnit) -> OsStatus;
    fn AudioComponentInstanceDispose(instance: AudioUnit) -> OsStatus;
    fn AudioUnitSetProperty(unit: AudioUnit, property: u32, scope: u32, element: u32, data: *const c_void, size: u32) -> OsStatus;
    fn AudioUnitGetProperty(unit: AudioUnit, property: u32, scope: u32, element: u32, data: *mut c_void, size: *mut u32) -> OsStatus;
    fn AudioUnitInitialize(unit: AudioUnit) -> OsStatus;
    fn AudioUnitUninitialize(unit: AudioUnit) -> OsStatus;
    fn AudioOutputUnitStart(unit: AudioUnit) -> OsStatus;
    fn AudioOutputUnitStop(unit: AudioUnit) -> OsStatus;
    fn AudioUnitRender(unit: AudioUnit, flags: *mut u32, time: *const AudioTimeStamp, bus: u32, frames: u32, data: *mut AudioBufferList) -> OsStatus;
    fn AudioConverterNew(from: *const AudioStreamBasicDescription, to: *const AudioStreamBasicDescription, converter: *mut AudioConverterRef) -> OsStatus;
    fn AudioConverterDispose(converter: AudioConverterRef) -> OsStatus;
    fn AudioConverterFillComplexBuffer(
        converter: AudioConverterRef,
        input: ConverterInput,
        user: *mut c_void,
        packets: *mut u32,
        output: *mut AudioBufferList,
        descriptions: *mut c_void,
    ) -> OsStatus;
}

unsafe extern "C" {
    fn mach_timebase_info(info: *mut Timebase) -> i32;
}

/// Nanoseconds of host time from mach absolute time, the clock `mHostTime` and the screen's samples share.
pub fn host_time_ns(host: u64) -> u64 {
    static TIMEBASE: std::sync::OnceLock<(u64, u64)> = std::sync::OnceLock::new();
    let (numer, denom) = *TIMEBASE.get_or_init(|| {
        let mut info = Timebase { numer: 1, denom: 1 };
        unsafe { mach_timebase_info(&mut info) };
        (u64::from(info.numer), u64::from(info.denom.max(1)))
    });
    (u128::from(host) * u128::from(numer) / u128::from(denom)) as u64
}

fn address(selector: u32, scope: u32) -> Address {
    Address { selector, scope, element: ELEMENT_MAIN }
}

/// One value of a fixed size.
fn value<T: Copy + Default>(object: ObjectId, selector: u32, scope: u32, qualifier: Option<(*const c_void, u32)>) -> Option<T> {
    let mut out = T::default();
    let mut size = size_of::<T>() as u32;
    let (data, length) = qualifier.unwrap_or((null(), 0));
    let status = unsafe { AudioObjectGetPropertyData(object, &address(selector, scope), length, data, &mut size, (&raw mut out).cast()) };
    (status == 0).then_some(out)
}

fn string(object: ObjectId, selector: u32) -> Option<String> {
    let text: *const CFString = value::<usize>(object, selector, SCOPE_GLOBAL, None)? as *const CFString;
    let text = unsafe { CFRetained::from_raw(NonNull::new(text.cast_mut())?) };
    Some(text.to_string())
}

/// Every audio device's id.
fn devices() -> Vec<ObjectId> {
    let mut size = 0u32;
    if unsafe { AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &address(DEVICES, SCOPE_GLOBAL), 0, null(), &mut size) } != 0 {
        return Vec::new();
    }
    let mut ids = vec![0 as ObjectId; size as usize / size_of::<ObjectId>()];
    let status = unsafe { AudioObjectGetPropertyData(SYSTEM_OBJECT, &address(DEVICES, SCOPE_GLOBAL), 0, null(), &mut size, ids.as_mut_ptr().cast()) };
    if status != 0 {
        return Vec::new();
    }
    ids.truncate(size as usize / size_of::<ObjectId>());
    ids
}

fn has_input(device: ObjectId) -> bool {
    let mut size = 0u32;
    unsafe { AudioObjectGetPropertyDataSize(device, &address(STREAMS, SCOPE_INPUT), 0, null(), &mut size) == 0 && size > 0 }
}

/// An input device: its HAL id, its UID (stable across connections and launches, and the string AVFoundation called
/// the device's unique ID, so a chosen device is still found) and its name.
#[derive(Clone, Debug)]
pub struct Input {
    pub id: ObjectId,
    pub uid: String,
    pub name: String,
}

fn input(id: ObjectId) -> Option<Input> {
    Some(Input { id, uid: string(id, DEVICE_UID)?, name: string(id, NAME).unwrap_or_default() })
}

/// The devices that have input, as the HAL lists them now.
pub fn inputs() -> Vec<Input> {
    devices().into_iter().filter(|&id| has_input(id)).filter_map(input).collect()
}

pub fn default_input() -> Option<Input> {
    value::<ObjectId>(SYSTEM_OBJECT, DEFAULT_INPUT, SCOPE_GLOBAL, None).filter(|&id| id != 0).and_then(input)
}

/// The connected device with this UID, if any.
pub fn device_for_uid(uid: &str) -> Option<ObjectId> {
    let text = CFString::from_str(uid);
    let pointer: *const CFString = &*text;
    let id = value::<ObjectId>(SYSTEM_OBJECT, UID_TO_DEVICE, SCOPE_GLOBAL, Some(((&raw const pointer).cast(), size_of::<*const CFString>() as u32)))?;
    (id != 0 && alive(id) && has_input(id)).then_some(id)
}

/// Whether the device is still there (a disconnected one stops being alive before it leaves the list).
pub fn alive(device: ObjectId) -> bool {
    value::<u32>(device, ALIVE, SCOPE_GLOBAL, None).is_some_and(|alive| alive != 0)
}

/// Mono 32-bit float at `rate`.
fn mono(rate: f64) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription {
        mSampleRate: rate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4,
        mFramesPerPacket: 1,
        mBytesPerFrame: 4,
        mChannelsPerFrame: 1,
        mBitsPerChannel: 32,
        mReserved: 0,
    }
}

const ENABLE_IO: u32 = 2003;
const CURRENT_DEVICE: u32 = 2000;
const SET_INPUT_CALLBACK: u32 = 2005;
const STREAM_FORMAT: u32 = 8;
const MAXIMUM_FRAMES_PER_SLICE: u32 = 14;
const SCOPE_UNIT_GLOBAL: u32 = 0;
const SCOPE_UNIT_INPUT: u32 = 1;
const SCOPE_UNIT_OUTPUT: u32 = 2;
/// The AUHAL's elements: 1 is the device's input, 0 its output.
const INPUT_ELEMENT: u32 = 1;
const OUTPUT_ELEMENT: u32 = 0;

/// Sound captured at `pts_ns` host time, mono at the device's rate.
pub struct Chunk {
    pub pts_ns: u64,
    pub samples: Vec<f32>,
}

struct Callback {
    unit: AudioUnit,
    buffer: Vec<f32>,
    chunks: std::sync::mpsc::SyncSender<Chunk>,
}

/// An AUHAL input unit running on one device. The HAL calls it on its real-time thread, which only renders the sound
/// and hands it on; resampling and the recording's mixing and encoding happen on the thread that reads `chunks`.
pub struct InputUnit {
    unit: AudioUnit,
    callback: *mut Callback,
    pub rate: f64,
}

unsafe impl Send for InputUnit {}

impl InputUnit {
    pub fn open(device: ObjectId, chunks: std::sync::mpsc::SyncSender<Chunk>) -> Result<Self, String> {
        let description = ComponentDescription { kind: code(b"auou"), sub_kind: code(b"ahal"), manufacturer: code(b"appl"), flags: 0, flags_mask: 0 };
        let component = unsafe { AudioComponentFindNext(null_mut(), &description) };
        if component.is_null() {
            return Err("the HAL input unit is not available".into());
        }
        let mut unit: AudioUnit = null_mut();
        let status = unsafe { AudioComponentInstanceNew(component, &mut unit) };
        if status != 0 || unit.is_null() {
            return Err(format!("the HAL input unit could not be made: {status}"));
        }
        let mut opened = Self { unit, callback: null_mut(), rate: 0.0 };
        let set = |property: u32, scope: u32, element: u32, data: *const c_void, size: usize, what: &str| -> Result<(), String> {
            let status = unsafe { AudioUnitSetProperty(unit, property, scope, element, data, size as u32) };
            if status == 0 { Ok(()) } else { Err(format!("{what}: {status}")) }
        };
        let (on, off) = (1u32, 0u32);
        set(ENABLE_IO, SCOPE_UNIT_INPUT, INPUT_ELEMENT, (&raw const on).cast(), 4, "enabling input")?;
        set(ENABLE_IO, SCOPE_UNIT_OUTPUT, OUTPUT_ELEMENT, (&raw const off).cast(), 4, "disabling output")?;
        set(CURRENT_DEVICE, SCOPE_UNIT_GLOBAL, OUTPUT_ELEMENT, (&raw const device).cast(), 4, "choosing the device")?;
        // The device's own rate: the AUHAL does not convert rates on input (Apple's TN2091), so the client format takes
        // it and AudioConverter goes to 48 kHz.
        let rate = value::<f64>(device, NOMINAL_RATE, SCOPE_GLOBAL, None).filter(|rate| *rate > 0.0).ok_or("the device has no sample rate")?;
        let format = mono(rate);
        set(STREAM_FORMAT, SCOPE_UNIT_OUTPUT, INPUT_ELEMENT, (&raw const format).cast(), size_of::<AudioStreamBasicDescription>(), "the sound format")?;
        let mut frames = 0u32;
        let mut size = 4u32;
        unsafe { AudioUnitGetProperty(unit, MAXIMUM_FRAMES_PER_SLICE, SCOPE_UNIT_GLOBAL, 0, (&raw mut frames).cast(), &mut size) };
        let callback = Box::into_raw(Box::new(Callback { unit, buffer: vec![0.0; frames.clamp(4096, 16384) as usize], chunks }));
        opened.callback = callback;
        let render = RenderCallbackStruct { proc: render, refcon: callback.cast() };
        set(SET_INPUT_CALLBACK, SCOPE_UNIT_GLOBAL, OUTPUT_ELEMENT, (&raw const render).cast(), size_of::<RenderCallbackStruct>(), "the input callback")?;
        let status = unsafe { AudioUnitInitialize(unit) };
        if status != 0 {
            return Err(format!("the HAL input unit could not start: {status}"));
        }
        let status = unsafe { AudioOutputUnitStart(unit) };
        if status != 0 {
            unsafe { AudioUnitUninitialize(unit) };
            return Err(format!("the device did not start: {status}"));
        }
        opened.rate = rate;
        Ok(opened)
    }
}

impl Drop for InputUnit {
    fn drop(&mut self) {
        unsafe {
            AudioOutputUnitStop(self.unit);
            AudioUnitUninitialize(self.unit);
            AudioComponentInstanceDispose(self.unit);
            if !self.callback.is_null() {
                drop(Box::from_raw(self.callback));
            }
        }
    }
}

unsafe extern "C" fn render(refcon: *mut c_void, flags: *mut u32, time: *const AudioTimeStamp, bus: u32, frames: u32, _data: *mut AudioBufferList) -> OsStatus {
    let callback = unsafe { &mut *(refcon as *mut Callback) };
    if frames as usize > callback.buffer.len() {
        return -50;
    }
    let mut list = AudioBufferList {
        mNumberBuffers: 1,
        mBuffers: [AudioBuffer { mNumberChannels: 1, mDataByteSize: frames * 4, mData: callback.buffer.as_mut_ptr().cast() }],
    };
    let status = unsafe { AudioUnitRender(callback.unit, flags, time, bus, frames, &mut list) };
    if status != 0 {
        return status;
    }
    let host = unsafe { time.as_ref() }.map_or(0, |time| time.mHostTime);
    let pts_ns = if host == 0 { super::now_ns() } else { host_time_ns(host) };
    // A full queue drops this buffer: the reading thread is behind, and the core treats the gap as silence.
    let _ = callback.chunks.try_send(Chunk { pts_ns, samples: callback.buffer[..frames as usize].to_vec() });
    0
}

/// Mono float from a device's rate to 48 kHz.
pub struct Resampler {
    converter: AudioConverterRef,
    ratio: f64,
    pending: Vec<f32>,
    given: bool,
}

unsafe impl Send for Resampler {}

/// What the converter's input callback answers once this call's samples are given: no more for now.
const NO_MORE_FOR_NOW: OsStatus = code(b"nmfn") as OsStatus;

impl Resampler {
    pub fn new(from: f64, to: f64) -> Result<Self, String> {
        let mut converter: AudioConverterRef = null_mut();
        let status = unsafe { AudioConverterNew(&mono(from), &mono(to), &mut converter) };
        if status != 0 || converter.is_null() {
            return Err(format!("a sample rate converter from {from} Hz could not be made: {status}"));
        }
        Ok(Self { converter, ratio: to / from, pending: Vec::new(), given: false })
    }

    /// Converts `input` and appends what comes out to `out`; the converter keeps what it needs for the next call.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) -> Result<(), String> {
        self.pending.clear();
        self.pending.extend_from_slice(input);
        self.given = false;
        let capacity = (input.len() as f64 * self.ratio).ceil() as usize + 64;
        let start = out.len();
        out.resize(start + capacity, 0.0);
        let mut packets = capacity as u32;
        let mut list = AudioBufferList {
            mNumberBuffers: 1,
            mBuffers: [AudioBuffer { mNumberChannels: 1, mDataByteSize: packets * 4, mData: out[start..].as_mut_ptr().cast() }],
        };
        let status = unsafe { AudioConverterFillComplexBuffer(self.converter, supply, (self as *mut Self).cast(), &mut packets, &mut list, null_mut()) };
        out.truncate(start + packets as usize);
        if status == 0 || status == NO_MORE_FOR_NOW { Ok(()) } else { Err(format!("sample rate conversion failed: {status}")) }
    }
}

impl Drop for Resampler {
    fn drop(&mut self) {
        unsafe { AudioConverterDispose(self.converter) };
    }
}

unsafe extern "C" fn supply(_converter: AudioConverterRef, packets: *mut u32, data: *mut AudioBufferList, _descriptions: *mut *mut c_void, user: *mut c_void) -> OsStatus {
    let resampler = unsafe { &mut *(user as *mut Resampler) };
    let data = unsafe { &mut *data };
    if resampler.given || resampler.pending.is_empty() {
        unsafe { *packets = 0 };
        data.mBuffers[0].mDataByteSize = 0;
        return NO_MORE_FOR_NOW;
    }
    resampler.given = true;
    unsafe { *packets = resampler.pending.len() as u32 };
    data.mBuffers[0] = AudioBuffer { mNumberChannels: 1, mDataByteSize: resampler.pending.len() as u32 * 4, mData: resampler.pending.as_mut_ptr().cast() };
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tone_keeps_its_pitch_through_the_resampler_and_comes_out_at_the_new_rate() {
        // 1 s of 1 kHz at 16 kHz, a Bluetooth headset's rate, in the sizes the HAL hands over.
        let input: Vec<f32> = (0..16_000).map(|n| (n as f32 * 1000.0 * std::f32::consts::TAU / 16_000.0).sin() * 0.5).collect();
        let mut resampler = Resampler::new(16_000.0, 48_000.0).unwrap();
        let mut out = Vec::new();
        for chunk in input.chunks(160) {
            resampler.process(chunk, &mut out).unwrap();
        }
        // About three times as many frames, less what the converter still holds.
        assert!((47_000..=48_000).contains(&out.len()), "{} frames", out.len());
        // Zero crossings of a 1 kHz tone: about 2000 a second, after the converter's start.
        let settled = &out[4_800..];
        let crossings = settled.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count() as f64;
        let per_second = crossings / (settled.len() as f64 / 48_000.0);
        assert!((per_second - 2000.0).abs() < 20.0, "{per_second} crossings a second");
        let peak = settled.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!((0.45..0.55).contains(&peak), "peak {peak}");
    }

    #[test]
    fn host_time_converts_with_the_machine_timebase() {
        // The same instant through both clocks: mach absolute time and CoreMedia's host clock.
        unsafe extern "C" {
            fn mach_absolute_time() -> u64;
        }
        let host = host_time_ns(unsafe { mach_absolute_time() });
        let core_media = super::super::now_ns();
        assert!(core_media.abs_diff(host) < 5_000_000, "{host} vs {core_media}");
    }

    #[test]
    fn devices_with_input_have_a_uid_and_can_be_found_by_it() {
        // Needs no permission: listing devices is not capture. A machine without inputs (CI) lists none.
        for input in inputs() {
            assert!(!input.uid.is_empty());
            assert_eq!(device_for_uid(&input.uid), Some(input.id), "{}", input.name);
        }
        assert_eq!(device_for_uid("no-such-device-uid"), None);
    }
}
