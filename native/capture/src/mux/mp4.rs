//! The hybrid MP4 writer (plan 076, D4): fragmented while recording, plain at save, as OBS's hybrid MP4 and the
//! closed plan 072's `mp4-finalize.ts` do.
//!
//! While recording, the file is an initialization segment (`ftyp`, a `moov` with `mvex` and empty sample tables) and
//! then one fragment (`moof` + `mdat`) per track per second or so, each written in one append. A file cut off at any
//! point is still a fragmented MP4 that players read up to its last whole fragment, which is what an interrupted
//! recording keeps. At `finish` the writer appends a `moov` indexing every sample where it already lies, syncs, then
//! writes a 64-bit `mdat` header over the start of the old `moov`, so the file reads ftyp, mdat, moov: plain, with an
//! index a player reads at once. Nothing is copied or moved. Interrupted between the two syncs, the file is still the
//! fragmented one with an unused index after it, which players read as before.
//!
//! Written from ISO/IEC 14496-12 (boxes) and 14496-14/-15 (`esds`, `avcC`); no code was taken from other muxers.

use std::io;

use super::boxes::{BoxWriter, UNITY_MATRIX, mdat_header_64};

/// Where the file goes: appends at the end, and positional writes for `finish`'s header rewrite.
pub trait Output {
    /// Writes `data` at `offset`; the writer only ever appends at its own end or rewrites the old `moov`.
    fn write_at(&mut self, data: &[u8], offset: u64) -> io::Result<()>;
    fn sync(&mut self) -> io::Result<()>;
    /// Drops everything from `len` on; used when `finish` could not write the whole index.
    fn truncate(&mut self, len: u64) -> io::Result<()>;
}

impl Output for std::fs::File {
    fn write_at(&mut self, data: &[u8], offset: u64) -> io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::FileExt::write_all_at(self, data, offset)
        }
        #[cfg(windows)]
        {
            let mut written = 0usize;
            while written < data.len() {
                let n = std::os::windows::fs::FileExt::seek_write(self, &data[written..], offset + written as u64)?;
                if n == 0 {
                    return Err(io::Error::new(io::ErrorKind::WriteZero, "write returned 0 bytes"));
                }
                written += n;
            }
            Ok(())
        }
    }

    fn sync(&mut self) -> io::Result<()> {
        self.sync_all()
    }

    fn truncate(&mut self, len: u64) -> io::Result<()> {
        self.set_len(len)
    }
}

/// An in-memory file, for tests and for checking what would be written.
impl Output for Vec<u8> {
    fn write_at(&mut self, data: &[u8], offset: u64) -> io::Result<()> {
        let offset = usize::try_from(offset).map_err(io::Error::other)?;
        if self.len() < offset + data.len() {
            self.resize(offset + data.len(), 0);
        }
        self[offset..offset + data.len()].copy_from_slice(data);
        Ok(())
    }

    fn sync(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn truncate(&mut self, len: u64) -> io::Result<()> {
        self.truncate(usize::try_from(len).map_err(io::Error::other)?);
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub enum Codec {
    /// H.264 in AVCC form: `avcc` is the `AVCDecoderConfigurationRecord` (the body of `avcC`), samples are
    /// length-prefixed NAL units.
    H264 { avcc: Vec<u8>, width: u16, height: u16 },
    /// AAC: `config` is the `AudioSpecificConfig`, samples are raw access units.
    Aac { config: Vec<u8>, sample_rate: u32, channels: u16, average_bitrate: u32, max_bitrate: u32 },
}

#[derive(Clone, Debug)]
pub struct TrackConfig {
    pub codec: Codec,
    /// Ticks per second of every duration and decode time of this track.
    pub timescale: u32,
    /// Ticks at the start of the media that are not presented (the AAC encoder's priming): an edit list skips them,
    /// so presentation time 0 is the first captured frame.
    pub skip: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Sample<'a> {
    pub data: &'a [u8],
    /// In the track's timescale; at least 1.
    pub duration: u32,
    /// A sync sample (a key frame); every audio sample is one.
    pub sync: bool,
}

/// What `finish` did, for the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinishReport {
    /// The file's size once finished.
    pub bytes: u64,
    /// Why the file was left fragmented, when it was.
    pub fragmented: Option<String>,
}

/// trun sample flags: sample_depends_on = 2 (an I frame).
const SYNC_FLAGS: u32 = 0x0200_0000;
/// trun sample flags: sample_depends_on = 1 and sample_is_non_sync_sample.
const NON_SYNC_FLAGS: u32 = 0x0101_0000;
/// The movie's timescale without an edited track; with one, that track's, so its edit ends on a sample exactly.
const MOVIE_TIMESCALE: u32 = 1000;

fn movie_timescale(tracks: &[TrackState]) -> u32 {
    tracks.iter().find(|t| t.config.skip > 0 || t.presented.is_some()).map_or(MOVIE_TIMESCALE, |t| t.config.timescale)
}

struct TrackState {
    config: TrackConfig,
    id: u32,
    sizes: Vec<u32>,
    durations: Vec<u32>,
    /// 1-based numbers of the sync samples; kept from the first non-sync sample, before which every sample is one.
    syncs: Option<Vec<u32>>,
    /// One chunk per fragment: where its samples start in the file and how many there are.
    chunk_offsets: Vec<u64>,
    chunk_counts: Vec<u32>,
    /// Each chunk's sample description, 1-based: 2 is `alternate`.
    chunk_descriptions: Vec<u32>,
    /// A second sample description (plan 085): an export's re-encoded pictures whose parameter sets differ from the
    /// source's, in the same track.
    alternate: Option<Codec>,
    /// The decode time the next fragment starts at.
    decode_end: u64,
    /// Ticks after `skip` that hold captured sound, when known: the rest is the encoder's padding.
    presented: Option<u64>,
}

impl TrackState {
    /// How long the track plays, in `timescale`: its media less what the edit list skips and any trailing padding.
    fn duration_in(&self, timescale: u32) -> u64 {
        let media = self.decode_end.saturating_sub(u64::from(self.config.skip));
        let ticks = self.presented.map_or(media, |presented| presented.min(media));
        (u128::from(ticks) * u128::from(timescale) / u128::from(self.config.timescale)) as u64
    }
}

pub struct HybridMp4<O: Output> {
    out: O,
    tracks: Vec<TrackState>,
    /// The append position: every byte before it has been written.
    end: u64,
    /// The fragmented `moov`, rewritten into an `mdat` header at `finish`.
    moov_at: u64,
    moov_size: u64,
    /// The fragmented `moov`'s first 16 bytes, put back when the `mdat` header over them was not wholly written.
    moov_head: Vec<u8>,
    sequence: u32,
    finished: bool,
}

impl<O: Output> HybridMp4<O> {
    /// Writes the initialization segment for `tracks`, in order (track IDs 1, 2, ...).
    pub fn create(out: O, tracks: Vec<TrackConfig>) -> io::Result<Self> {
        Self::create_with_alternate(out, tracks, None)
    }

    /// As `create`, with a second sample description for one track (plan 085): `(track, codec)`, used by the
    /// fragments written with `write_fragment_described(track, _, 2)`.
    pub fn create_with_alternate(mut out: O, tracks: Vec<TrackConfig>, alternate: Option<(usize, Codec)>) -> io::Result<Self> {
        assert!(!tracks.is_empty(), "a movie needs a track");
        let mut alternate = alternate;
        let tracks: Vec<TrackState> = tracks
            .into_iter()
            .enumerate()
            .map(|(index, config)| TrackState {
                config,
                id: index as u32 + 1,
                sizes: Vec::new(),
                durations: Vec::new(),
                syncs: None,
                chunk_offsets: Vec::new(),
                chunk_counts: Vec::new(),
                chunk_descriptions: Vec::new(),
                alternate: alternate.take_if(|(track, _)| *track == index).map(|(_, codec)| codec),
                decode_end: 0,
                presented: None,
            })
            .collect();
        let mut w = BoxWriter::new();
        write_ftyp(&mut w);
        let moov_at = w.len() as u64;
        write_moov(&mut w, &tracks, false);
        let moov_size = w.len() as u64 - moov_at;
        let moov_head = w.bytes[moov_at as usize..][..16].to_vec();
        out.write_at(&w.bytes, 0)?;
        Ok(Self { out, end: w.len() as u64, tracks, moov_at, moov_size, moov_head, sequence: 0, finished: false })
    }

    /// Bytes written so far.
    pub fn bytes_written(&self) -> u64 {
        self.end
    }

    /// Decode time the next fragment of `track` starts at, in its timescale.
    pub fn decode_end(&self, track: usize) -> u64 {
        self.tracks[track].decode_end
    }

    /// What has been written, for tests that read an unfinished file.
    #[cfg(test)]
    pub fn output(&self) -> &O {
        &self.out
    }

    pub fn sample_count(&self, track: usize) -> usize {
        self.tracks[track].sizes.len()
    }

    pub fn sync(&mut self) -> io::Result<()> {
        self.out.sync()
    }

    /// Appends one fragment of `track` (0-based) holding `samples`, in one write. An empty list writes nothing.
    pub fn write_fragment(&mut self, track: usize, samples: &[Sample<'_>]) -> io::Result<()> {
        self.write_fragment_described(track, samples, 1)
    }

    /// As `write_fragment`, the samples using sample description `description` (1, or 2 for the track's alternate).
    pub fn write_fragment_described(&mut self, track: usize, samples: &[Sample<'_>], description: u32) -> io::Result<()> {
        assert!(!self.finished, "write_fragment after finish");
        assert!(description == 1 || description == 2 && self.tracks[track].alternate.is_some(), "no sample description {description}");
        if samples.is_empty() {
            return Ok(());
        }
        self.sequence += 1;
        let state = &self.tracks[track];
        let mut w = BoxWriter::new();
        let moof = w.open(b"moof");
        let mfhd = w.open_full(b"mfhd", 0, 0);
        w.u32(self.sequence);
        w.close(mfhd);
        let traf = w.open(b"traf");
        // default-base-is-moof: data offsets count from this moof's first byte; the description only when not the first.
        let tfhd = w.open_full(b"tfhd", 0, 0x02_0000 | if description == 1 { 0 } else { 0x00_0002 });
        w.u32(state.id);
        if description != 1 {
            w.u32(description);
        }
        w.close(tfhd);
        let tfdt = w.open_full(b"tfdt", 1, 0);
        w.u64(state.decode_end);
        w.close(tfdt);
        // data-offset, sample-duration, sample-size and sample-flags present.
        let trun = w.open_full(b"trun", 0, 0x00_0001 | 0x00_0100 | 0x00_0200 | 0x00_0400);
        w.u32(samples.len() as u32);
        let data_offset_at = w.len();
        w.i32(0);
        let payload: u64 = samples.iter().map(|s| s.data.len() as u64).sum();
        for sample in samples {
            w.u32(sample.duration.max(1)).u32(sample.data.len() as u32);
            w.u32(if sample.sync { SYNC_FLAGS } else { NON_SYNC_FLAGS });
        }
        w.close(trun);
        w.close(traf);
        w.close(moof);
        let large = payload + 8 > u64::from(u32::MAX);
        let mdat_header = if large { 16 } else { 8 };
        let data_offset = w.len() + mdat_header;
        w.bytes[data_offset_at..data_offset_at + 4].copy_from_slice(&(data_offset as i32).to_be_bytes());
        if large {
            w.u32(1).fourcc(b"mdat").u64(payload + 16);
        } else {
            w.u32((payload + 8) as u32).fourcc(b"mdat");
        }
        let fragment_at = self.end;
        let media_at = fragment_at + data_offset as u64;
        let mut bytes = w.bytes;
        bytes.reserve(payload as usize);
        for sample in samples {
            bytes.extend_from_slice(sample.data);
        }
        self.out.write_at(&bytes, fragment_at)?;
        self.end += bytes.len() as u64;

        // Only once written: the index describes the file, not what was meant to be in it.
        let state = &mut self.tracks[track];
        state.chunk_offsets.push(media_at);
        state.chunk_counts.push(samples.len() as u32);
        state.chunk_descriptions.push(description);
        for sample in samples {
            let number = state.sizes.len() as u32 + 1;
            state.sizes.push(sample.data.len() as u32);
            state.durations.push(sample.duration.max(1));
            state.decode_end += u64::from(sample.duration.max(1));
            match (&mut state.syncs, sample.sync) {
                (Some(syncs), true) => syncs.push(number),
                (None, false) => state.syncs = Some((1..number).collect()),
                _ => {}
            }
        }
        Ok(())
    }

    /// How many ticks after its skipped start `track` presents; ticks past them are padding the edit list leaves out.
    pub fn set_presented(&mut self, track: usize, ticks: u64) {
        self.tracks[track].presented = Some(ticks);
    }

    /// Makes the file plain (see the module comment) and syncs it. Never leaves a file players cannot read: when the
    /// index cannot be written the file is truncated back to the fragmented one and the reason is returned.
    pub fn finish(mut self) -> io::Result<(FinishReport, O)> {
        self.finished = true;
        self.out.sync()?;
        let end = self.end;
        let mut w = BoxWriter::new();
        write_moov(&mut w, &self.tracks, true);
        if self.moov_size < 16 {
            return Ok((FinishReport { bytes: end, fragmented: Some("a moov too small for an mdat header".into()) }, self.out));
        }
        if let Err(cause) = self.out.write_at(&w.bytes, end).and_then(|_| self.out.sync()) {
            let _ = self.out.truncate(end).and_then(|_| self.out.sync());
            return Ok((FinishReport { bytes: end, fragmented: Some(format!("index not written: {cause}")) }, self.out));
        }
        let total = end + w.len() as u64;
        if let Err(cause) = self.out.write_at(&mdat_header_64(end - self.moov_at), self.moov_at) {
            // Part of the header may have been written, which neither form reads: put the fragmented one back.
            return match self.out.write_at(&self.moov_head, self.moov_at).and_then(|_| self.out.sync()) {
                Ok(()) => Ok((FinishReport { bytes: total, fragmented: Some(format!("header not written: {cause}")) }, self.out)),
                Err(restore) => Err(io::Error::new(cause.kind(), format!("header not written ({cause}) nor restored ({restore})"))),
            };
        }
        if let Err(cause) = self.out.sync() {
            // Written whole but not confirmed: sixteen bytes in one sector land on disk whole or not at all.
            return Ok((FinishReport { bytes: total, fragmented: Some(format!("header not confirmed: {cause}")) }, self.out));
        }
        Ok((FinishReport { bytes: total, fragmented: None }, self.out))
    }
}

fn write_ftyp(w: &mut BoxWriter) {
    let ftyp = w.open(b"ftyp");
    w.fourcc(b"isom").u32(0x200);
    for brand in [b"isom", b"iso2", b"iso6", b"avc1", b"mp41"] {
        w.fourcc(brand);
    }
    w.close(ftyp);
}

/// The fragmented `moov` (empty sample tables and `mvex`) or, with `plain`, the whole movie's index.
fn write_moov(w: &mut BoxWriter, tracks: &[TrackState], plain: bool) {
    let moov = w.open(b"moov");
    let timescale = movie_timescale(tracks);
    let movie_duration = if plain { tracks.iter().map(|t| t.duration_in(timescale)).max().unwrap_or(0) } else { 0 };
    let mvhd = w.open_full(b"mvhd", 1, 0);
    w.u64(0).u64(0).u32(timescale).u64(movie_duration);
    w.u32(0x0001_0000).u16(0x0100).zeros(10);
    for value in UNITY_MATRIX {
        w.u32(value);
    }
    w.zeros(24).u32(tracks.len() as u32 + 1);
    w.close(mvhd);
    for track in tracks {
        write_trak(w, track, plain, timescale);
    }
    if !plain {
        let mvex = w.open(b"mvex");
        for track in tracks {
            let trex = w.open_full(b"trex", 0, 0);
            w.u32(track.id).u32(1).u32(0).u32(0).u32(0);
            w.close(trex);
        }
        w.close(mvex);
    }
    w.close(moov);
}

fn write_trak(w: &mut BoxWriter, track: &TrackState, plain: bool, movie_timescale: u32) {
    let (video, width, height) = match &track.config.codec {
        Codec::H264 { width, height, .. } => (true, *width, *height),
        Codec::Aac { .. } => (false, 0, 0),
    };
    let trak = w.open(b"trak");
    // Enabled and in the movie.
    let tkhd = w.open_full(b"tkhd", 1, 0x3);
    w.u64(0).u64(0).u32(track.id).u32(0);
    w.u64(if plain { track.duration_in(movie_timescale) } else { 0 });
    w.zeros(8).u16(0).u16(0).u16(if video { 0 } else { 0x0100 }).u16(0);
    for value in UNITY_MATRIX {
        w.u32(value);
    }
    w.u32(u32::from(width) << 16).u32(u32::from(height) << 16);
    w.close(tkhd);
    if track.config.skip > 0 || track.presented.is_some() {
        // One edit from `skip` on. A fragmented movie's length is unknown, which a zero duration states.
        let edts = w.open(b"edts");
        let elst = w.open_full(b"elst", 1, 0);
        w.u32(1).u64(if plain { track.duration_in(movie_timescale) } else { 0 }).u64(u64::from(track.config.skip));
        w.u16(1).u16(0);
        w.close(elst);
        w.close(edts);
    }

    let mdia = w.open(b"mdia");
    let mdhd = w.open_full(b"mdhd", 1, 0);
    w.u64(0).u64(0).u32(track.config.timescale).u64(if plain { track.decode_end } else { 0 });
    // Language "und", packed ISO-639-2/T.
    w.u16(0x55c4).u16(0);
    w.close(mdhd);
    let hdlr = w.open_full(b"hdlr", 0, 0);
    w.u32(0).fourcc(if video { b"vide" } else { b"soun" }).zeros(12);
    w.raw(if video { b"VideoHandler\0" } else { b"SoundHandler\0" });
    w.close(hdlr);

    let minf = w.open(b"minf");
    if video {
        let vmhd = w.open_full(b"vmhd", 0, 1);
        w.zeros(8);
        w.close(vmhd);
    } else {
        let smhd = w.open_full(b"smhd", 0, 0);
        w.zeros(4);
        w.close(smhd);
    }
    let dinf = w.open(b"dinf");
    let dref = w.open_full(b"dref", 0, 0);
    w.u32(1);
    // Self-contained: the media is in this file.
    let url = w.open_full(b"url ", 0, 1);
    w.close(url);
    w.close(dref);
    w.close(dinf);

    let stbl = w.open(b"stbl");
    write_stsd(w, &track.config.codec, track.alternate.as_ref());
    if plain {
        write_sample_tables(w, track);
    } else {
        for kind in [b"stts", b"stsc", b"stco"] {
            let table = w.open_full(kind, 0, 0);
            w.u32(0);
            w.close(table);
        }
        let stsz = w.open_full(b"stsz", 0, 0);
        w.u32(0).u32(0);
        w.close(stsz);
    }
    w.close(stbl);
    w.close(minf);
    w.close(mdia);
    w.close(trak);
}

fn write_stsd(w: &mut BoxWriter, codec: &Codec, alternate: Option<&Codec>) {
    let stsd = w.open_full(b"stsd", 0, 0);
    w.u32(if alternate.is_some() { 2 } else { 1 });
    write_sample_entry(w, codec);
    if let Some(alternate) = alternate {
        write_sample_entry(w, alternate);
    }
    w.close(stsd);
}

fn write_sample_entry(w: &mut BoxWriter, codec: &Codec) {
    match codec {
        Codec::H264 { avcc, width, height } => {
            let avc1 = w.open(b"avc1");
            w.zeros(6).u16(1);
            w.zeros(16).u16(*width).u16(*height);
            // 72 dpi, reserved, one frame per sample, an empty compressor name, 24-bit depth, no colour table.
            w.u32(0x0048_0000).u32(0x0048_0000).u32(0).u16(1).zeros(32).u16(0x18).u16(0xffff);
            let avcc_box = w.open(b"avcC");
            w.raw(avcc);
            w.close(avcc_box);
            // BT.709 primaries, transfer and matrix, limited range: what the encoder is configured to produce.
            let colr = w.open(b"colr");
            w.fourcc(b"nclx").u16(1).u16(1).u16(1).u8(0);
            w.close(colr);
            w.close(avc1);
        }
        Codec::Aac { config, sample_rate, channels, average_bitrate, max_bitrate } => {
            let mp4a = w.open(b"mp4a");
            w.zeros(6).u16(1);
            w.zeros(8).u16(*channels).u16(16).u16(0).u16(0);
            // 16.16 fixed point; rates above 65535 Hz cannot be stated here, and AAC does not use them.
            w.u32((*sample_rate).min(0xffff) << 16);
            write_esds(w, config, *average_bitrate, *max_bitrate);
            w.close(mp4a);
        }
    }
}

/// ISO/IEC 14496-1 descriptors: an `ES_Descriptor` holding the decoder configuration and the AAC config.
fn write_esds(w: &mut BoxWriter, config: &[u8], average_bitrate: u32, max_bitrate: u32) {
    let esds = w.open_full(b"esds", 0, 0);
    let decoder_specific = descriptor(0x05, config);
    let mut decoder_config = vec![0x40, 0x15, 0, 0, 0];
    decoder_config.extend_from_slice(&max_bitrate.to_be_bytes());
    decoder_config.extend_from_slice(&average_bitrate.to_be_bytes());
    decoder_config.extend_from_slice(&decoder_specific);
    let mut es = vec![0, 0, 0];
    es.extend_from_slice(&descriptor(0x04, &decoder_config));
    es.extend_from_slice(&descriptor(0x06, &[0x02]));
    w.raw(&descriptor(0x03, &es));
    w.close(esds);
}

fn descriptor(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let len = body.len();
    assert!(len < 1 << 28, "a descriptor over 256 MiB");
    // Sizes of 7 bits per byte, the high bit saying another byte follows.
    let mut groups = vec![(len & 0x7f) as u8];
    let mut rest = len >> 7;
    while rest > 0 {
        groups.push((rest & 0x7f) as u8 | 0x80);
        rest >>= 7;
    }
    groups.reverse();
    out.extend_from_slice(&groups);
    out.extend_from_slice(body);
    out
}

fn write_sample_tables(w: &mut BoxWriter, track: &TrackState) {
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for &duration in &track.durations {
        match runs.last_mut() {
            Some((count, value)) if *value == duration => *count += 1,
            _ => runs.push((1, duration)),
        }
    }
    let stts = w.open_full(b"stts", 0, 0);
    w.u32(runs.len() as u32);
    for (count, value) in runs {
        w.u32(count).u32(value);
    }
    w.close(stts);

    if let Some(syncs) = &track.syncs {
        let stss = w.open_full(b"stss", 0, 0);
        w.u32(syncs.len() as u32);
        for &number in syncs {
            w.u32(number);
        }
        w.close(stss);
    }

    // stsc names a chunk only where its sample count or description changes from the one before.
    let mut entries: Vec<(u32, u32, u32)> = Vec::new();
    for (index, (&count, &description)) in track.chunk_counts.iter().zip(&track.chunk_descriptions).enumerate() {
        if entries.last().is_none_or(|&(_, previous, described)| previous != count || described != description) {
            entries.push((index as u32 + 1, count, description));
        }
    }
    let stsc = w.open_full(b"stsc", 0, 0);
    w.u32(entries.len() as u32);
    for (first, count, description) in entries {
        w.u32(first).u32(count).u32(description);
    }
    w.close(stsc);

    let stsz = w.open_full(b"stsz", 0, 0);
    w.u32(0).u32(track.sizes.len() as u32);
    for &size in &track.sizes {
        w.u32(size);
    }
    w.close(stsz);

    let wide = track.chunk_offsets.iter().any(|&offset| offset > u64::from(u32::MAX));
    let table = w.open_full(if wide { b"co64" } else { b"stco" }, 0, 0);
    w.u32(track.chunk_offsets.len() as u32);
    for &offset in &track.chunk_offsets {
        if wide {
            w.u64(offset);
        } else {
            w.u32(offset as u32);
        }
    }
    w.close(table);
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::mux::parse::{Mp4, parse};

    pub fn video_config() -> TrackConfig {
        // A minimal AVCDecoderConfigurationRecord: version 1, High profile, level 4.0, 4-byte lengths, one SPS and PPS.
        let avcc = vec![1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee];
        TrackConfig { codec: Codec::H264 { avcc, width: 1920, height: 1080 }, timescale: 90_000, skip: 0 }
    }

    pub fn audio_config() -> TrackConfig {
        TrackConfig {
            codec: Codec::Aac { config: vec![0x11, 0x90], sample_rate: 48_000, channels: 2, average_bitrate: 256_000, max_bitrate: 256_000 },
            timescale: 48_000,
            skip: 0,
        }
    }

    fn frames(count: usize, first_sync_every: usize) -> Vec<(Vec<u8>, bool)> {
        (0..count).map(|n| (vec![n as u8; 10 + n % 7], n % first_sync_every == 0)).collect()
    }

    #[test]
    fn a_fragmented_file_reads_back_sample_for_sample() {
        let mut mp4 = HybridMp4::create(Vec::new(), vec![video_config(), audio_config()]).unwrap();
        let video = frames(60, 30);
        for chunk in video.chunks(30) {
            let samples: Vec<Sample> = chunk.iter().map(|(d, s)| Sample { data: d, duration: 3000, sync: *s }).collect();
            mp4.write_fragment(0, &samples).unwrap();
        }
        let audio: Vec<Vec<u8>> = (0..47).map(|n| vec![0xa0 | (n as u8 & 0xf); 5]).collect();
        let samples: Vec<Sample> = audio.iter().map(|d| Sample { data: d, duration: 1024, sync: true }).collect();
        mp4.write_fragment(1, &samples).unwrap();
        let written = mp4.bytes_written();
        let Mp4 { top, tracks } = parse(&mp4.out).unwrap();
        assert_eq!(top, ["ftyp", "moov", "moof", "mdat", "moof", "mdat", "moof", "mdat"]);
        assert_eq!(written as usize, mp4.out.len());
        assert!(tracks[0].fragmented);
        assert_eq!(tracks[0].samples.len(), 60);
        for (n, sample) in tracks[0].samples.iter().enumerate() {
            assert_eq!(sample.data, video[n].0);
            assert_eq!(sample.decode_time, n as u64 * 3000);
            assert_eq!(sample.sync, video[n].1);
        }
        assert_eq!(tracks[1].samples.len(), 47);
        assert_eq!(tracks[1].samples[46].data, audio[46]);
    }

    #[test]
    fn finish_makes_a_plain_file_indexing_the_same_samples() {
        let mut mp4 = HybridMp4::create(Vec::new(), vec![video_config(), audio_config()]).unwrap();
        let video = frames(90, 30);
        let durations = [3000u32, 3003, 2997];
        for (index, chunk) in video.chunks(30).enumerate() {
            let samples: Vec<Sample> = chunk.iter().map(|(d, s)| Sample { data: d, duration: durations[index], sync: *s }).collect();
            mp4.write_fragment(0, &samples).unwrap();
            let audio = vec![vec![7u8; 6]; 47];
            let samples: Vec<Sample> = audio.iter().map(|d| Sample { data: d, duration: 1024, sync: true }).collect();
            mp4.write_fragment(1, &samples).unwrap();
        }
        let (report, out) = mp4.finish().unwrap();
        assert_eq!(report.fragmented, None);
        assert_eq!(report.bytes as usize, out.len());
        let Mp4 { top, tracks } = parse(&out).unwrap();
        assert_eq!(top, ["ftyp", "mdat", "moov"]);
        assert!(!tracks[0].fragmented);
        assert_eq!(tracks[0].samples.len(), 90);
        let mut time = 0;
        for (n, sample) in tracks[0].samples.iter().enumerate() {
            assert_eq!(sample.data, video[n].0, "sample {n}");
            assert_eq!(sample.decode_time, time);
            assert_eq!(sample.sync, video[n].1);
            time += u64::from(durations[n / 30]);
        }
        assert_eq!(tracks[0].duration, time);
        assert_eq!(tracks[1].samples.len(), 141);
        assert_eq!(tracks[1].duration, 141 * 1024);
        // The movie lasts as long as its longest track, here the audio, in milliseconds.
        assert_eq!(tracks[0].movie_duration, 141 * 1024 * 1000 / 48_000);
    }

    #[test]
    fn a_file_cut_inside_a_fragment_still_reads_its_whole_fragments() {
        let mut mp4 = HybridMp4::create(Vec::new(), vec![video_config(), audio_config()]).unwrap();
        let video = frames(60, 30);
        for chunk in video.chunks(30) {
            let samples: Vec<Sample> = chunk.iter().map(|(d, s)| Sample { data: d, duration: 3000, sync: *s }).collect();
            mp4.write_fragment(0, &samples).unwrap();
        }
        let mut out = mp4.out;
        out.truncate(out.len() - 5);
        let parsed = parse(&out).unwrap();
        assert_eq!(parsed.tracks[0].samples.len(), 30);
    }

    #[test]
    fn a_failed_index_write_leaves_the_fragmented_file() {
        struct FailAfter(Vec<u8>, usize);
        impl Output for FailAfter {
            fn write_at(&mut self, data: &[u8], offset: u64) -> io::Result<()> {
                if self.1 == 0 {
                    return Err(io::Error::new(io::ErrorKind::StorageFull, "disk full"));
                }
                self.1 -= 1;
                self.0.write_at(data, offset)
            }
            fn sync(&mut self) -> io::Result<()> {
                Ok(())
            }
            fn truncate(&mut self, len: u64) -> io::Result<()> {
                Output::truncate(&mut self.0, len)
            }
        }
        let mut mp4 = HybridMp4::create(FailAfter(Vec::new(), 2), vec![video_config()]).unwrap();
        let frame = [1u8; 12];
        mp4.write_fragment(0, &[Sample { data: &frame, duration: 3000, sync: true }]).unwrap();
        let before = mp4.bytes_written();
        let (report, out) = mp4.finish().unwrap();
        assert!(report.fragmented.unwrap().starts_with("index not written"));
        assert_eq!(out.0.len() as u64, before);
        assert_eq!(parse(&out.0).unwrap().tracks[0].samples.len(), 1);
    }

    #[test]
    fn a_partly_written_mdat_header_is_put_back_to_the_fragmented_one() {
        /// Writes only the first half of the 16-byte header, once, then fails.
        struct HalfHeader(Vec<u8>, bool);
        impl Output for HalfHeader {
            fn write_at(&mut self, data: &[u8], offset: u64) -> io::Result<()> {
                if data.len() == 16 && !self.1 {
                    self.1 = true;
                    self.0.write_at(&data[..8], offset)?;
                    return Err(io::Error::other("I/O error"));
                }
                self.0.write_at(data, offset)
            }
            fn sync(&mut self) -> io::Result<()> {
                Ok(())
            }
            fn truncate(&mut self, len: u64) -> io::Result<()> {
                Output::truncate(&mut self.0, len)
            }
        }
        let mut mp4 = HybridMp4::create(HalfHeader(Vec::new(), false), vec![video_config()]).unwrap();
        let frame = [1u8; 12];
        mp4.write_fragment(0, &[Sample { data: &frame, duration: 3000, sync: true }]).unwrap();
        let (report, out) = mp4.finish().unwrap();
        assert!(report.fragmented.unwrap().starts_with("header not written"));
        let parsed = parse(&out.0).unwrap();
        assert_eq!(parsed.top[..4], ["ftyp", "moov", "moof", "mdat"]);
        assert!(parsed.tracks[0].fragmented);
        assert_eq!(parsed.tracks[0].samples.len(), 1);
    }

    #[test]
    fn priming_is_skipped_by_an_edit_and_padding_left_out_of_the_duration() {
        let audio = TrackConfig { skip: 2112, ..audio_config() };
        let mut mp4 = HybridMp4::create(Vec::new(), vec![video_config(), audio]).unwrap();
        let data = [0u8; 4];
        mp4.write_fragment(0, &[Sample { data: &data, duration: 90_000, sync: true }]).unwrap();
        let fragmented = parse(&mp4.out).unwrap();
        assert_eq!(fragmented.tracks[0].edit, None);
        // A fragmented movie's edit runs to its end.
        assert_eq!(fragmented.tracks[1].edit, Some((0, 2112)));
        // 50 packets: the priming, one second of sound and padding.
        let packets = vec![Sample { data: &data, duration: 1024, sync: true }; 50];
        mp4.write_fragment(1, &packets).unwrap();
        // Not a whole millisecond: the movie counts in samples, so the edit ends on the last one exactly.
        mp4.set_presented(1, 48_128);
        let (_, out) = mp4.finish().unwrap();
        let tracks = parse(&out).unwrap().tracks;
        assert_eq!(tracks[1].duration, 50 * 1024);
        assert_eq!(tracks[1].edit, Some((48_128, 2112)));
        assert_eq!(tracks[1].track_duration, 48_128);
        assert_eq!(tracks[1].movie_duration, 48_128);
        // The video's second, in the same timescale.
        assert_eq!(tracks[0].track_duration, 48_000);
    }

    #[test]
    fn non_sync_samples_get_an_stss_and_all_sync_tracks_none() {
        let mut mp4 = HybridMp4::create(Vec::new(), vec![video_config(), audio_config()]).unwrap();
        let data = [0u8; 4];
        let video: Vec<Sample> = (0..4).map(|n| Sample { data: &data, duration: 3000, sync: n == 0 || n == 3 }).collect();
        mp4.write_fragment(0, &video).unwrap();
        mp4.write_fragment(1, &[Sample { data: &data, duration: 1024, sync: true }]).unwrap();
        let (_, out) = mp4.finish().unwrap();
        let parsed = parse(&out).unwrap();
        assert_eq!(parsed.tracks[0].stss, Some(vec![1, 4]));
        assert_eq!(parsed.tracks[1].stss, None);
    }

    #[test]
    fn an_alternate_description_is_named_by_its_fragments_and_chunks() {
        let other = Codec::H264 { avcc: vec![1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xef], width: 1920, height: 1080 };
        let mut mp4 = HybridMp4::create_with_alternate(Vec::new(), vec![video_config(), audio_config()], Some((0, other))).unwrap();
        let data = [0u8; 4];
        let three: Vec<Sample> = (0..3).map(|n| Sample { data: &data, duration: 3000, sync: n == 0 }).collect();
        mp4.write_fragment(0, &three).unwrap();
        mp4.write_fragment_described(0, &three, 2).unwrap();
        mp4.write_fragment(0, &three[..2]).unwrap();
        mp4.write_fragment(1, &[Sample { data: &data, duration: 1024, sync: true }]).unwrap();
        let fragmented = parse(&mp4.out).unwrap();
        let described: Vec<u32> = fragmented.tracks[0].samples.iter().map(|s| s.description).collect();
        assert_eq!(described, [1, 1, 1, 2, 2, 2, 1, 1]);
        assert_eq!(fragmented.tracks[0].descriptions, ["avc1", "avc1"]);
        assert_eq!(fragmented.tracks[1].descriptions, ["mp4a"]);
        let (_, out) = mp4.finish().unwrap();
        let plain = parse(&out).unwrap();
        let described: Vec<u32> = plain.tracks[0].samples.iter().map(|s| s.description).collect();
        assert_eq!(described, [1, 1, 1, 2, 2, 2, 1, 1]);
        assert_eq!(plain.tracks[0].descriptions, ["avc1", "avc1"]);
    }

    #[test]
    fn descriptor_sizes_use_continuation_bytes_past_127() {
        assert_eq!(descriptor(5, &[1, 2]), vec![5, 2, 1, 2]);
        let long = descriptor(5, &[0; 200]);
        assert_eq!(&long[..3], &[5, 0x81, 0x48]);
    }
}
