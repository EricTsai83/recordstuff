//! What the H.264 and AAC encoders share: Media Foundation transforms driven synchronously, one sample in and every
//! ready sample out.

use std::mem::ManuallyDrop;

use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::Foundation::{VARIANT_FALSE, VARIANT_TRUE};
use windows::Win32::System::Variant::{VARENUM, VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL, VT_UI4};
use windows::core::GUID;

/// A sample holding `data`, at `time` and lasting `duration`, both in 100 ns units.
pub fn sample(data: &[u8], time: i64, duration: i64) -> windows::core::Result<IMFSample> {
    unsafe {
        let buffer = MFCreateMemoryBuffer(data.len().max(1) as u32)?;
        let mut pointer = std::ptr::null_mut();
        buffer.Lock(&mut pointer, None, None)?;
        std::ptr::copy_nonoverlapping(data.as_ptr(), pointer, data.len());
        buffer.Unlock()?;
        buffer.SetCurrentLength(data.len() as u32)?;
        let sample = MFCreateSample()?;
        sample.AddBuffer(&buffer)?;
        sample.SetSampleTime(time)?;
        sample.SetSampleDuration(duration)?;
        Ok(sample)
    }
}

/// The bytes of a sample's buffers, and its time in 100 ns units.
pub fn bytes(sample: &IMFSample) -> windows::core::Result<(Vec<u8>, i64)> {
    unsafe {
        let buffer = sample.ConvertToContiguousBuffer()?;
        let mut pointer = std::ptr::null_mut();
        let mut length = 0u32;
        buffer.Lock(&mut pointer, None, Some(&mut length))?;
        let data = std::slice::from_raw_parts(pointer, length as usize).to_vec();
        buffer.Unlock()?;
        Ok((data, sample.GetSampleTime().unwrap_or(0)))
    }
}

/// Every sample the transform has ready, in order. A stream change (the encoder settling its output type) is accepted
/// and the output continues.
pub fn outputs(transform: &IMFTransform, fallback_size: u32) -> windows::core::Result<Vec<IMFSample>> {
    let mut ready = Vec::new();
    loop {
        let info = unsafe { transform.GetOutputStreamInfo(0)? };
        let provides = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        let own = if provides {
            None
        } else {
            let size = if info.cbSize > 0 { info.cbSize } else { fallback_size };
            let buffer = unsafe { MFCreateMemoryBuffer(size)? };
            let sample = unsafe { MFCreateSample()? };
            unsafe { sample.AddBuffer(&buffer)? };
            Some(sample)
        };
        let mut output = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(own), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
        let mut status = 0u32;
        let result = unsafe { transform.ProcessOutput(0, &mut output, &mut status) };
        let [mut output] = output;
        let produced = unsafe { ManuallyDrop::take(&mut output.pSample) };
        drop(unsafe { ManuallyDrop::take(&mut output.pEvents) });
        match result {
            Ok(()) => {
                if let Some(sample) = produced {
                    ready.push(sample);
                }
            }
            Err(error) if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(ready),
            Err(error) if error.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                let offered = unsafe { transform.GetOutputAvailableType(0, 0)? };
                unsafe { transform.SetOutputType(0, &offered, 0)? };
            }
            Err(error) => return Err(error),
        }
    }
}

fn variant(vt: VARENUM, value: VARIANT_0_0_0) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 { vt, wReserved1: 0, wReserved2: 0, wReserved3: 0, Anonymous: value }),
        },
    }
}

/// Sets an encoder property of type VT_UI4 through ICodecAPI; false when the encoder does not take it.
pub fn set_codec(codec: &ICodecAPI, api: &GUID, value: u32) -> bool {
    unsafe { codec.SetValue(api, &variant(VT_UI4, VARIANT_0_0_0 { ulVal: value })) }.is_ok()
}

/// Sets an encoder property of type VT_BOOL; false when the encoder does not take it.
pub fn set_codec_flag(codec: &ICodecAPI, api: &GUID, value: bool) -> bool {
    let flag = if value { VARIANT_TRUE } else { VARIANT_FALSE };
    unsafe { codec.SetValue(api, &variant(VT_BOOL, VARIANT_0_0_0 { boolVal: flag })) }.is_ok()
}

pub fn pack(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}
