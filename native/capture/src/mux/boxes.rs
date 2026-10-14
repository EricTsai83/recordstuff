//! ISO BMFF (ISO/IEC 14496-12) box building: big-endian fields appended to a byte buffer, with each box's size
//! patched in when it closes. Only what the muxer writes; nothing here parses.

/// A byte buffer that boxes are written into. `open` returns the box's start; `close` writes its size there.
#[derive(Default)]
pub struct BoxWriter {
    pub bytes: Vec<u8>,
}

impl BoxWriter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn u8(&mut self, value: u8) -> &mut Self {
        self.bytes.push(value);
        self
    }

    pub fn u16(&mut self, value: u16) -> &mut Self {
        self.bytes.extend_from_slice(&value.to_be_bytes());
        self
    }

    pub fn u24(&mut self, value: u32) -> &mut Self {
        self.bytes.extend_from_slice(&value.to_be_bytes()[1..]);
        self
    }

    pub fn u32(&mut self, value: u32) -> &mut Self {
        self.bytes.extend_from_slice(&value.to_be_bytes());
        self
    }

    pub fn u64(&mut self, value: u64) -> &mut Self {
        self.bytes.extend_from_slice(&value.to_be_bytes());
        self
    }

    pub fn i32(&mut self, value: i32) -> &mut Self {
        self.bytes.extend_from_slice(&value.to_be_bytes());
        self
    }

    pub fn fourcc(&mut self, code: &[u8; 4]) -> &mut Self {
        self.bytes.extend_from_slice(code);
        self
    }

    pub fn raw(&mut self, data: &[u8]) -> &mut Self {
        self.bytes.extend_from_slice(data);
        self
    }

    pub fn zeros(&mut self, count: usize) -> &mut Self {
        self.bytes.resize(self.bytes.len() + count, 0);
        self
    }

    /// Starts a box of `kind`; its 32-bit size is written by `close`.
    pub fn open(&mut self, kind: &[u8; 4]) -> usize {
        let start = self.bytes.len();
        self.u32(0).fourcc(kind);
        start
    }

    /// Starts a full box: a box whose body begins with a version byte and 24 bits of flags.
    pub fn open_full(&mut self, kind: &[u8; 4], version: u8, flags: u32) -> usize {
        let start = self.open(kind);
        self.u8(version).u24(flags);
        start
    }

    pub fn close(&mut self, start: usize) {
        let size = u32::try_from(self.bytes.len() - start).expect("a header box over 4 GiB");
        self.bytes[start..start + 4].copy_from_slice(&size.to_be_bytes());
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }
}

/// The 3×3 transformation matrix of `mvhd` and `tkhd`: identity, in 16.16 and 2.30 fixed point.
pub const UNITY_MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

/// The 16-byte header that turns `size` bytes from where it is written into one `mdat` (a 64-bit size).
pub fn mdat_header_64(size: u64) -> [u8; 16] {
    let mut header = [0u8; 16];
    header[0..4].copy_from_slice(&1u32.to_be_bytes());
    header[4..8].copy_from_slice(b"mdat");
    header[8..16].copy_from_slice(&size.to_be_bytes());
    header
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_writes_the_size_of_nested_boxes() {
        let mut w = BoxWriter::new();
        let outer = w.open(b"moov");
        let inner = w.open_full(b"mvhd", 1, 0x000102);
        w.u32(7);
        w.close(inner);
        w.close(outer);
        assert_eq!(&w.bytes[0..8], &[0, 0, 0, 24, b'm', b'o', b'o', b'v']);
        assert_eq!(&w.bytes[8..20], &[0, 0, 0, 16, b'm', b'v', b'h', b'd', 1, 0, 1, 2]);
        assert_eq!(&w.bytes[20..24], &[0, 0, 0, 7]);
    }

    #[test]
    fn mdat_header_uses_the_large_size_form() {
        let header = mdat_header_64(0x1_0000_0010);
        assert_eq!(&header[0..8], &[0, 0, 0, 1, b'm', b'd', b'a', b't']);
        assert_eq!(&header[8..16], &0x1_0000_0010u64.to_be_bytes());
    }
}
