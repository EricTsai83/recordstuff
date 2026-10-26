//! The rendered export's pictures and sound on macOS (plan 087, edit/render.rs): VideoToolbox decodes the screen and
//! the camera into IOSurface-backed 4:2:0 pictures, the recording's Metal compositor (compositor.rs) composes the
//! camera's newest decoded picture onto each screen picture where the edit placed its bubble, and the recording's H.264
//! encoder (video.rs), not in real time, at the source's level, encodes the result. A camera left out, throughout or
//! over a stretch the edit hides it in, skips the compositor: the screen's own picture is encoded. Pictures in flight in the encoder are bounded, so decoding never
//! runs far ahead of it. Sound uses 085's AAC decoder and the recording's AAC encoder (edit.rs, audio.rs).

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::audio::AacEncoder;
use super::camera::{Feed, Image};
use super::compositor::Compositor;
use super::edit::{AacDecoder, Decoder, Picture};
use super::video::{EncoderOptions, VideoEncoder};
use crate::camera_layout::Layout;
use crate::core::{AudioEncode, Events, VideoSink};
use crate::edit::remux::{AudioFormat, VideoFormat};
use crate::edit::render::{Renderer, VideoRender};
use crate::writer::{Media, WriteFailure};

/// Pictures handed to the encoder and not yet back, at most: enough to keep it busy, bounded so memory is.
const IN_FLIGHT: usize = 8;
/// How long the encoder may hold one picture before the export is told it stalled.
const ENCODER_STALL: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct MacRenderer;

impl Renderer for MacRenderer {
    fn video(&mut self, screen: &VideoFormat, camera: Option<(&VideoFormat, Layout)>, bitrate: u32) -> Result<Box<dyn VideoRender>, String> {
        let (width, height) = (u32::from(screen.width), u32::from(screen.height));
        let feed = Arc::new(Feed::default());
        let composed = match camera {
            Some((format, layout)) => Some((Compositor::new(width, height, layout, feed.clone())?, Decoder::with_forward(&format.avcc, None)?)),
            None => None,
        };
        let encoded = Arc::new(Encoded::default());
        let options = EncoderOptions { real_time: false, level: screen.avcc.get(3).copied(), ..EncoderOptions::RECORDING };
        let encoder = VideoEncoder::with_options(width, height, screen.frame_rate, bitrate, options, encoded.clone()).map_err(|e| e.detail)?;
        Ok(Box::new(MacVideo { screen: Decoder::with_forward(&screen.avcc, None)?, composed, feed, encoder, encoded, first: true, decoded: 0 }))
    }

    fn decode_audio(&mut self, format: &AudioFormat, packets: &[Vec<u8>]) -> Result<Vec<f32>, String> {
        AacDecoder::new(format)?.decode(packets)
    }

    fn audio_encoder(&mut self, format: &AudioFormat, bitrate: u32) -> Result<Box<dyn AudioEncode>, String> {
        Ok(Box::new(AacEncoder::new(format.sample_rate, u32::from(format.channels), bitrate).map_err(|e| e.detail)?))
    }
}

/// The encoder's output, and how many pictures it still holds.
#[derive(Default)]
struct Encoded {
    state: Mutex<EncodedState>,
    changed: Condvar,
}

#[derive(Default)]
struct EncodedState {
    media: Vec<Media>,
    in_flight: usize,
    failure: Option<String>,
}

impl VideoSink for Encoded {
    fn media(&self, media: Media) {
        let mut state = self.state.lock().unwrap();
        if matches!(media, Media::Video { .. }) {
            state.in_flight = state.in_flight.saturating_sub(1);
        }
        state.media.push(media);
        self.changed.notify_all();
    }

    fn failed(&self, detail: String) {
        let mut state = self.state.lock().unwrap();
        state.failure.get_or_insert(detail);
        self.changed.notify_all();
    }

    fn dropped(&self) {
        // A dropped picture would leave a gap the export cannot show: a failure, not a shorter file.
        self.failed("the H.264 encoder dropped a picture".into());
    }
}

impl Encoded {
    /// Waits until fewer than `limit` pictures are in the encoder.
    fn wait_below(&self, limit: usize) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        while state.in_flight >= limit && state.failure.is_none() {
            let (next, timeout) = self.changed.wait_timeout(state, ENCODER_STALL).unwrap();
            state = next;
            if timeout.timed_out() && state.in_flight >= limit {
                return Err(format!("the H.264 encoder held a picture for {} s", ENCODER_STALL.as_secs()));
            }
        }
        state.failure.clone().map_or(Ok(()), Err)
    }

    fn take(&self) -> Result<Vec<Media>, String> {
        let mut state = self.state.lock().unwrap();
        if let Some(failure) = state.failure.clone() {
            return Err(failure);
        }
        Ok(std::mem::take(&mut state.media))
    }
}

/// A camera's events offline: no one is told anything.
struct Quiet;

impl Events for Quiet {
    fn progress(&self, _bytes: u64) {}
    fn write_failed(&self, _failure: WriteFailure) {}
    fn capture_failed(&self, _code: &'static str, _detail: String) {}
    fn microphone_lost(&self, _detail: String) {}
    fn microphone_resumed(&self, _detail: String) {}
}

struct MacVideo {
    screen: Decoder,
    /// The compositor and the camera's decoder, when the camera is composed.
    composed: Option<(Compositor, Decoder)>,
    feed: Arc<Feed>,
    encoder: VideoEncoder,
    encoded: Arc<Encoded>,
    /// The next picture encoded is the export's first, a key frame.
    first: bool,
    /// Samples decoded so far, numbering them for the decoder.
    decoded: usize,
}

impl MacVideo {
    /// Decodes `data` synchronously with `decoder`; the picture, when it was wanted.
    fn decode(decoder: &Decoder, data: &[u8], index: usize, output: bool) -> Result<Option<Picture>, String> {
        decoder.decode_with(data, index, false, output)?;
        Ok(decoder.take().pop().map(|(_, picture)| picture))
    }
}

impl VideoRender for MacVideo {
    fn camera(&mut self, data: &[u8]) -> Result<(), String> {
        let Some((_, decoder)) = self.composed.as_ref() else { return Ok(()) };
        self.decoded += 1;
        if let Some(picture) = Self::decode(decoder, data, self.decoded, true)? {
            self.feed.deliver(Image(picture?), 0, 0, &Quiet);
        }
        Ok(())
    }

    fn screen(&mut self, data: &[u8], out_ns: Option<u64>, with_camera: bool) -> Result<(), String> {
        self.decoded += 1;
        let picture = Self::decode(&self.screen, data, self.decoded, out_ns.is_some())?;
        let (Some(at), Some(picture)) = (out_ns, picture) else {
            return if out_ns.is_some() { Err("a kept picture did not decode".into()) } else { Ok(()) };
        };
        let picture = picture?;
        self.encoded.wait_below(IN_FLIGHT)?;
        self.encoded.state.lock().unwrap().in_flight += 1;
        let key = std::mem::replace(&mut self.first, false);
        match self.composed.as_ref().filter(|_| with_camera) {
            Some((compositor, _)) => {
                let composed = compositor.compose(&picture, at)?;
                self.encoder.encode(&composed, at, key)
            }
            None => self.encoder.encode(&picture, at, key),
        }
    }

    fn take(&mut self) -> Result<Vec<Media>, String> {
        self.encoded.take()
    }

    fn finish(&mut self) -> Result<Vec<Media>, String> {
        self.encoder.flush();
        self.encoded.take()
    }
}
