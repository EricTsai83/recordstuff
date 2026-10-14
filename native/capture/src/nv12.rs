//! BGRA to NV12 on the CPU, for Windows machines whose Direct3D device has no video processor (WARP on a virtual
//! machine or a runner without a GPU): full-range BGRA in, BT.709 limited range out, as the GPU path converts.
//! Scaling picks the nearest source pixel to each output pixel's centre; chroma is the average of its 2×2 block.

/// Converts `source` (`source_width`×`source_height` BGRA rows `pitch` bytes apart) into `out`, NV12 at
/// `width`×`height` tightly packed: the luma rows, then the interleaved chroma rows. Both output dimensions are even.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn from_bgra(source: &[u8], pitch: usize, source_width: usize, source_height: usize, out: &mut Vec<u8>, width: usize, height: usize) {
    debug_assert!(width.is_multiple_of(2) && height.is_multiple_of(2));
    out.clear();
    out.resize(width * height * 3 / 2, 0);
    let columns: Vec<usize> = (0..width).map(|x| ((2 * x + 1) * source_width / (2 * width)).min(source_width - 1) * 4).collect();
    let rows: Vec<usize> = (0..height).map(|y| ((2 * y + 1) * source_height / (2 * height)).min(source_height - 1) * pitch).collect();
    let (luma, chroma) = out.split_at_mut(width * height);
    for y in (0..height).step_by(2) {
        for x in (0..width).step_by(2) {
            let (mut red, mut green, mut blue) = (0i32, 0i32, 0i32);
            for dy in 0..2 {
                for dx in 0..2 {
                    let at = rows[y + dy] + columns[x + dx];
                    let (b, g, r) = (i32::from(source[at]), i32::from(source[at + 1]), i32::from(source[at + 2]));
                    luma[(y + dy) * width + x + dx] = (((47 * r + 157 * g + 16 * b + 128) >> 8) + 16) as u8;
                    (red, green, blue) = (red + r, green + g, blue + b);
                }
            }
            let at = y / 2 * width + x;
            chroma[at] = ((((-26 * red - 86 * green + 112 * blue) / 4 + 128) >> 8) + 128) as u8;
            chroma[at + 1] = ((((112 * red - 102 * green - 10 * blue) / 4 + 128) >> 8) + 128) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: usize, height: usize, pitch: usize, bgr: [u8; 3]) -> Vec<u8> {
        let mut image = vec![0xEE; pitch * height];
        for y in 0..height {
            for x in 0..width {
                image[y * pitch + x * 4..][..4].copy_from_slice(&[bgr[0], bgr[1], bgr[2], 255]);
            }
        }
        image
    }

    #[test]
    fn white_black_and_red_get_bt709_limited_values() {
        let mut out = Vec::new();
        for (bgr, expected) in [([255, 255, 255], [235, 128, 128]), ([0, 0, 0], [16, 128, 128]), ([0, 0, 255], [63, 102, 240])] {
            from_bgra(&solid(2, 2, 8, bgr), 8, 2, 2, &mut out, 2, 2);
            assert_eq!(out, [expected[0]; 4].into_iter().chain([expected[1], expected[2]]).collect::<Vec<_>>(), "{bgr:?}");
        }
    }

    #[test]
    fn row_padding_is_skipped_and_scaling_picks_the_nearest_pixel() {
        // 8×4 with 40-byte rows: the left half black, the right white, scaled to 4×2.
        let mut image = solid(8, 4, 40, [0, 0, 0]);
        for y in 0..4 {
            for x in 4..8 {
                image[y * 40 + x * 4..][..3].copy_from_slice(&[255, 255, 255]);
            }
        }
        let mut out = Vec::new();
        from_bgra(&image, 40, 8, 4, &mut out, 4, 2);
        assert_eq!(out, [16, 16, 235, 235, 16, 16, 235, 235, 128, 128, 128, 128]);
    }

    #[test]
    fn chroma_averages_its_block() {
        // One red and three black pixels: a quarter of red's chroma offset.
        let mut image = solid(2, 2, 8, [0, 0, 0]);
        image[2] = 255;
        let mut out = Vec::new();
        from_bgra(&image, 8, 2, 2, &mut out, 2, 2);
        assert_eq!(out[..4], [63, 16, 16, 16]);
        assert_eq!(out[4..], [((-26 * 255 / 4 + 128) >> 8) + 128, ((112 * 255 / 4 + 128) >> 8) + 128].map(|v: i32| v as u8));
    }
}
