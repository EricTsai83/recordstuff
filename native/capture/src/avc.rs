//! H.264 from an Annex B byte stream into the MP4 form (ISO/IEC 14496-15): Media Foundation's encoder writes NAL
//! units after start codes, with the parameter sets in band before each key frame, while the muxer takes
//! length-prefixed NAL units and an `AVCDecoderConfigurationRecord`. Only this module knows both forms.

/// NAL unit types (ITU-T H.264, table 7-1).
const IDR: u8 = 5;
const SPS: u8 = 7;
const PPS: u8 = 8;
const ACCESS_UNIT_DELIMITER: u8 = 9;

/// The NAL units of an Annex B stream, without their start codes.
pub fn nal_units(stream: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= stream.len() {
        if stream[i] == 0 && stream[i + 1] == 0 && stream[i + 2] == 1 {
            starts.push((i, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut units = Vec::with_capacity(starts.len());
    for (n, &(_, from)) in starts.iter().enumerate() {
        let mut to = starts.get(n + 1).map_or(stream.len(), |&(code, _)| code);
        // A four-byte start code's leading zero, and trailing zero bytes, belong to no unit.
        while to > from && stream[to - 1] == 0 {
            to -= 1;
        }
        if to > from {
            units.push(&stream[from..to]);
        }
    }
    units
}

fn kind(unit: &[u8]) -> u8 {
    unit[0] & 0x1f
}

/// One access unit for the muxer: its picture's NAL units, each after its length as four bytes, without the parameter
/// sets (they are in `avcC`) or access unit delimiters; and whether it is a key frame.
pub fn sample(stream: &[u8]) -> (Vec<u8>, bool) {
    let mut out = Vec::with_capacity(stream.len() + 16);
    let mut key = false;
    for unit in nal_units(stream) {
        match kind(unit) {
            SPS | PPS | ACCESS_UNIT_DELIMITER => continue,
            IDR => key = true,
            _ => {}
        }
        out.extend_from_slice(&(unit.len() as u32).to_be_bytes());
        out.extend_from_slice(unit);
    }
    (out, key)
}

/// The first sequence and picture parameter sets in `stream`.
pub fn parameter_sets(stream: &[u8]) -> Option<(&[u8], &[u8])> {
    let units = nal_units(stream);
    let sps = units.iter().find(|unit| kind(unit) == SPS && unit.len() >= 4)?;
    let pps = units.iter().find(|unit| kind(unit) == PPS)?;
    Some((sps, pps))
}

/// The `AVCDecoderConfigurationRecord` (the body of `avcC`) for one SPS and one PPS, with four-byte lengths. For the
/// High profiles it carries the 4:2:0, 8-bit format the encoder is given.
pub fn decoder_config(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let profile = sps[1];
    let mut record = vec![1, profile, sps[2], sps[3], 0xfc | 3, 0xe0 | 1];
    record.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    record.extend_from_slice(sps);
    record.push(1);
    record.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    record.extend_from_slice(pps);
    if matches!(profile, 100 | 110 | 122 | 144) {
        // chroma_format_idc 1, bit depths 8 (minus 8 is 0), no SPS extensions.
        record.extend_from_slice(&[0xfc | 1, 0xf8, 0xf8, 0]);
    }
    record
}

/// Back to Annex B, for a decoder (plan 078's self-test of a hardware encoder): `sample`'s length-prefixed NAL units
/// after start codes, preceded by the parameter sets of `avcc` (a `decoder_config` record) when asked.
pub fn annex_b(avcc: &[u8], sample: &[u8], with_parameter_sets: bool) -> Option<Vec<u8>> {
    const START: [u8; 4] = [0, 0, 0, 1];
    let mut out = Vec::with_capacity(sample.len() + avcc.len() + 16);
    if with_parameter_sets {
        let sps_len = usize::from(u16::from_be_bytes(avcc.get(6..8)?.try_into().ok()?));
        let sps = avcc.get(8..8 + sps_len)?;
        let at = 8 + sps_len + 1;
        let pps_len = usize::from(u16::from_be_bytes(avcc.get(at..at + 2)?.try_into().ok()?));
        let pps = avcc.get(at + 2..at + 2 + pps_len)?;
        for unit in [sps, pps] {
            out.extend_from_slice(&START);
            out.extend_from_slice(unit);
        }
    }
    let mut at = 0;
    while at < sample.len() {
        let length = u32::from_be_bytes(sample.get(at..at + 4)?.try_into().ok()?) as usize;
        out.extend_from_slice(&START);
        out.extend_from_slice(sample.get(at + 4..at + 4 + length)?);
        at += 4 + length;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS_UNIT: [u8; 6] = [0x67, 100, 0, 40, 0xac, 0xd9];
    const PPS_UNIT: [u8; 4] = [0x68, 0xeb, 0xe3, 0xcb];
    const IDR_UNIT: [u8; 5] = [0x65, 0x88, 0x84, 0x00, 0x21];
    const SLICE_UNIT: [u8; 3] = [0x41, 0x9a, 0x02];

    fn stream(units: &[&[u8]], long_codes: bool) -> Vec<u8> {
        let mut out = Vec::new();
        for unit in units {
            out.extend_from_slice(if long_codes { &[0, 0, 0, 1][..] } else { &[0, 0, 1][..] });
            out.extend_from_slice(unit);
        }
        out
    }

    #[test]
    fn units_are_split_at_three_and_four_byte_start_codes() {
        let mut data = stream(&[&SPS_UNIT, &PPS_UNIT], true);
        data.extend(stream(&[&IDR_UNIT], false));
        assert_eq!(nal_units(&data), [&SPS_UNIT[..], &PPS_UNIT[..], &IDR_UNIT[..]]);
    }

    #[test]
    fn a_key_frame_loses_its_parameter_sets_and_delimiter_and_gains_lengths() {
        let data = stream(&[&[0x09, 0xf0], &SPS_UNIT, &PPS_UNIT, &IDR_UNIT], true);
        let (sample, key) = sample(&data);
        assert!(key);
        assert_eq!(sample, [&[0, 0, 0, 5][..], &IDR_UNIT[..]].concat());
    }

    #[test]
    fn a_predicted_frame_is_not_a_key_frame() {
        let (sample, key) = sample(&stream(&[&SLICE_UNIT], true));
        assert!(!key);
        assert_eq!(sample, [&[0, 0, 0, 3][..], &SLICE_UNIT[..]].concat());
    }

    #[test]
    fn the_decoder_config_carries_the_parameter_sets_and_the_high_profile_format() {
        let data = stream(&[&SPS_UNIT, &PPS_UNIT, &IDR_UNIT], true);
        let (sps, pps) = parameter_sets(&data).unwrap();
        let record = decoder_config(sps, pps);
        assert_eq!(&record[..6], [1, 100, 0, 40, 0xff, 0xe1]);
        assert_eq!(&record[6..8], [0, 6]);
        assert_eq!(&record[8..14], SPS_UNIT);
        assert_eq!(&record[14..17], [1, 0, 4]);
        assert_eq!(&record[17..21], PPS_UNIT);
        assert_eq!(&record[21..], [0xfd, 0xf8, 0xf8, 0]);
    }

    #[test]
    fn the_main_profile_has_no_format_extension() {
        let sps = [0x67, 77, 0, 31, 0xab];
        assert_eq!(decoder_config(&sps, &PPS_UNIT).len(), 6 + 2 + sps.len() + 1 + 2 + PPS_UNIT.len());
    }

    #[test]
    fn a_stream_without_parameter_sets_has_none() {
        assert!(parameter_sets(&stream(&[&IDR_UNIT], true)).is_none());
    }

    #[test]
    fn a_sample_goes_back_to_annex_b_with_its_parameter_sets() {
        let stream = [0, 0, 0, 1, 0x67, 0x64, 0, 0x1f, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80, 0, 0, 1, 0x65, 0x88, 0x84];
        let (sps, pps) = parameter_sets(&stream).unwrap();
        let avcc = decoder_config(sps, pps);
        let (data, _) = sample(&stream);
        let back = annex_b(&avcc, &data, true).unwrap();
        assert_eq!(nal_units(&back), nal_units(&stream));
        assert_eq!(nal_units(&annex_b(&avcc, &data, false).unwrap()), [&[0x65, 0x88, 0x84][..]]);
        assert_eq!(annex_b(&avcc, &[0, 0, 0, 9, 1], false), None, "a length past the end");
    }
}
