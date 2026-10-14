//! AAC facts both platforms' encoders share.

/// The AudioSpecificConfig for AAC-LC at this rate and channel count (ISO/IEC 14496-3, 1.6.2.1).
pub fn audio_specific_config(sample_rate: u32, channels: u8) -> Vec<u8> {
    const RATES: [u32; 12] = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000];
    let index = RATES.iter().position(|&rate| rate == sample_rate).unwrap_or(3) as u16;
    // audioObjectType 2 (AAC LC), samplingFrequencyIndex, channelConfiguration, then three zero flags.
    let bits: u16 = (2 << 11) | (index << 7) | (u16::from(channels) << 3);
    bits.to_be_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_specific_config_for_common_rates() {
        assert_eq!(audio_specific_config(48_000, 2), [0x11, 0x90]);
        assert_eq!(audio_specific_config(44_100, 2), [0x12, 0x10]);
        assert_eq!(audio_specific_config(48_000, 1), [0x11, 0x88]);
    }
}
