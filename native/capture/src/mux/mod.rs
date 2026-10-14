//! Platform-independent muxing: ISO BMFF boxes, the hybrid MP4 file and a recording's fragmenting.
pub mod boxes;
pub mod mp4;
#[cfg(test)]
pub mod parse;
pub mod session;
