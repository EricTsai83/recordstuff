//! The bounded reader an export takes its samples from (plan 085): the index of an MP4 the engine wrote, plain or
//! fragmented (plan 076's hybrid file, finished or interrupted), never the samples themselves, which the remux reads one
//! at a time where they lie. Anything else is refused with its reason: another muxer's file, more than one video or
//! sound track, a codec other than H.264 and AAC, reordered pictures, or more than one sample description.
//!
//! Every size read from the file is checked before it is used: the header boxes are read whole only up to
//! `INDEX_LIMIT`, a sample may not reach past the end of the file, and a cut-off fragment ends the reading as a player
//! stops at an interrupted recording's last whole fragment. The index costs about eight bytes a sample (its size and
//! duration, and a decode time for video), the only memory that grows with the file.

use std::io;

/// The largest `moov` or `moof` read: a two-hour 60 fps recording's index is about 4 MiB.
pub const INDEX_LIMIT: u64 = 32 * 1024 * 1024;
/// The largest sample: a 4K key frame at the highest quality is a few MiB.
pub const SAMPLE_LIMIT: u32 = 64 * 1024 * 1024;
/// More samples than any recording the engine can write (about 9 days at 60 fps): the index stays bounded.
pub const SAMPLES_LIMIT: usize = 1 << 25;

/// Positional reads of the source; the reader never writes and never moves a cursor others share.
pub trait ReadAt {
    fn read_at(&self, buffer: &mut [u8], offset: u64) -> io::Result<()>;
    fn size(&self) -> io::Result<u64>;
}

impl ReadAt for std::fs::File {
    fn read_at(&self, buffer: &mut [u8], offset: u64) -> io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::FileExt::read_exact_at(self, buffer, offset)
        }
        #[cfg(windows)]
        {
            let mut read = 0usize;
            while read < buffer.len() {
                let n = std::os::windows::fs::FileExt::seek_read(self, &mut buffer[read..], offset + read as u64)?;
                if n == 0 {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the file ended"));
                }
                read += n;
            }
            Ok(())
        }
    }

    fn size(&self) -> io::Result<u64> {
        Ok(self.metadata()?.len())
    }
}

impl ReadAt for Vec<u8> {
    fn read_at(&self, buffer: &mut [u8], offset: u64) -> io::Result<()> {
        let from = usize::try_from(offset).map_err(io::Error::other)?;
        let source = self.get(from..from + buffer.len()).ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "the file ended"))?;
        buffer.copy_from_slice(source);
        Ok(())
    }

    fn size(&self) -> io::Result<u64> {
        Ok(Vec::len(self) as u64)
    }
}

/// Why a file cannot be exported from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadError {
    /// `unsupported` (a file the engine did not write, or one it cannot cut), `malformed` (a damaged index) or
    /// `read_failed` (the file could not be read).
    pub code: &'static str,
    pub detail: String,
}

impl ReadError {
    fn unsupported(detail: impl Into<String>) -> Self {
        Self { code: "unsupported", detail: detail.into() }
    }

    fn malformed(detail: impl Into<String>) -> Self {
        Self { code: "malformed", detail: detail.into() }
    }

    fn io(error: io::Error) -> Self {
        Self { code: "read_failed", detail: error.to_string() }
    }
}

type Result<T> = std::result::Result<T, ReadError>;

/// One track's samples: where each lies and how long it lasts. Chunks are runs of consecutive samples in the file.
#[derive(Debug, Default, Clone)]
pub struct Samples {
    pub sizes: Vec<u32>,
    pub durations: Vec<u32>,
    /// (file offset, first sample) of each chunk, in sample order.
    pub chunks: Vec<(u64, u32)>,
}

impl Samples {
    pub fn len(&self) -> usize {
        self.sizes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sizes.is_empty()
    }

    /// Calls `each(index, offset, size)` for samples `from..to`, in order.
    pub fn locate(&self, from: usize, to: usize, mut each: impl FnMut(usize, u64, u32)) {
        if from >= to {
            return;
        }
        let mut chunk = self.chunks.partition_point(|&(_, first)| first as usize <= from) - 1;
        let mut offset = self.chunks[chunk].0;
        for index in self.chunks[chunk].1 as usize..from {
            offset += u64::from(self.sizes[index]);
        }
        for index in from..to {
            if chunk + 1 < self.chunks.len() && self.chunks[chunk + 1].1 as usize == index {
                chunk += 1;
                offset = self.chunks[chunk].0;
            }
            each(index, offset, self.sizes[index]);
            offset += u64::from(self.sizes[index]);
        }
    }
}

#[derive(Debug, Clone)]
pub struct VideoTrack {
    pub timescale: u32,
    /// The `AVCDecoderConfigurationRecord`.
    pub avcc: Vec<u8>,
    pub width: u16,
    pub height: u16,
    pub samples: Samples,
    /// Each sample's decode time, which is its presentation time: the engine never reorders pictures.
    pub times: Vec<u64>,
    /// Whether each sample is a key frame.
    pub sync: Vec<bool>,
}

impl VideoTrack {
    /// Where the video ends, in its timescale.
    pub fn end(&self) -> u64 {
        self.times.last().map_or(0, |&t| t + u64::from(*self.samples.durations.last().unwrap()))
    }
}

#[derive(Debug, Clone)]
pub struct AudioTrack {
    pub timescale: u32,
    /// The `AudioSpecificConfig`.
    pub config: Vec<u8>,
    pub sample_rate: u32,
    pub channels: u16,
    pub average_bitrate: u32,
    pub max_bitrate: u32,
    /// Frames at the start that are not presented (the encoder's priming), from the edit list.
    pub skip: u32,
    /// Frames after `skip` the edit list presents, when it says.
    pub presented: Option<u64>,
    pub samples: Samples,
}

#[derive(Debug, Clone)]
pub struct SourceIndex {
    /// The picture players show: the screen, with the camera composed in today's recordings.
    pub video: VideoTrack,
    /// The sound players play: every input mixed in today's recordings, the first input's in an editable one.
    pub audio: Option<AudioTrack>,
    /// An editable recording's (plan 087) camera, a disabled video track, and its second sound, a disabled sound track.
    pub camera: Option<VideoTrack>,
    pub second_audio: Option<AudioTrack>,
    /// An editable recording's description (`udta/rsed`, editable.rs) as written, for main to read.
    pub description: Option<String>,
    /// Whether the file was read as fragments (an interrupted recording).
    pub fragmented: bool,
}

struct BoxHeader {
    kind: [u8; 4],
    /// Where the box starts and where its body does.
    start: u64,
    body: u64,
    end: u64,
}

/// The box at `at`, or none where the file ends inside its header or its size reaches past `limit`.
fn header(source: &dyn ReadAt, at: u64, limit: u64) -> Result<Option<BoxHeader>> {
    if at + 8 > limit {
        return Ok(None);
    }
    let mut head = [0u8; 16];
    source.read_at(&mut head[..8], at).map_err(ReadError::io)?;
    let kind: [u8; 4] = head[4..8].try_into().unwrap();
    let mut size = u64::from(u32::from_be_bytes(head[..4].try_into().unwrap()));
    let mut body = at + 8;
    if size == 1 {
        if at + 16 > limit {
            return Ok(None);
        }
        source.read_at(&mut head[8..16], at + 8).map_err(ReadError::io)?;
        size = u64::from_be_bytes(head[8..16].try_into().unwrap());
        body = at + 16;
    } else if size == 0 {
        // To the end of the file.
        size = limit - at;
    }
    if size < body - at || at.checked_add(size).is_none_or(|end| end > limit) {
        return Ok(None);
    }
    Ok(Some(BoxHeader { kind, start: at, body, end: at + size }))
}

/// A box read whole into memory, checked against `INDEX_LIMIT`.
fn read_box(source: &dyn ReadAt, b: &BoxHeader) -> Result<Vec<u8>> {
    let length = b.end - b.body;
    if length > INDEX_LIMIT {
        return Err(ReadError::unsupported(format!("a {} box of {length} bytes is larger than any the engine writes", fourcc(&b.kind))));
    }
    let mut data = vec![0u8; length as usize];
    source.read_at(&mut data, b.body).map_err(ReadError::io)?;
    Ok(data)
}

fn fourcc(kind: &[u8]) -> String {
    String::from_utf8_lossy(kind).into_owned()
}

/// A view of boxes in memory, every read bounds-checked.
#[derive(Clone, Copy)]
struct Bytes<'a>(&'a [u8]);

impl<'a> Bytes<'a> {
    fn get(&self, at: usize, len: usize) -> Result<&'a [u8]> {
        at.checked_add(len).and_then(|end| self.0.get(at..end)).ok_or_else(|| ReadError::malformed("a box ends before its fields"))
    }

    fn u8(&self, at: usize) -> Result<u8> {
        Ok(self.get(at, 1)?[0])
    }

    fn u16(&self, at: usize) -> Result<u16> {
        Ok(u16::from_be_bytes(self.get(at, 2)?.try_into().unwrap()))
    }

    fn u32(&self, at: usize) -> Result<u32> {
        Ok(u32::from_be_bytes(self.get(at, 4)?.try_into().unwrap()))
    }

    fn u64(&self, at: usize) -> Result<u64> {
        Ok(u64::from_be_bytes(self.get(at, 8)?.try_into().unwrap()))
    }

    /// The boxes in `from..to`, each as (kind, body range).
    fn children(&self, from: usize, to: usize) -> Result<Vec<([u8; 4], usize, usize)>> {
        let mut out = Vec::new();
        let mut at = from;
        while at < to {
            let size = self.u32(at)? as usize;
            let kind: [u8; 4] = self.get(at + 4, 4)?.try_into().unwrap();
            let (body, end) = if size == 1 {
                let size = usize::try_from(self.u64(at + 8)?).map_err(|_| ReadError::malformed("a box too large"))?;
                (at + 16, at.checked_add(size))
            } else {
                (at + 8, at.checked_add(size))
            };
            let end =
                end.filter(|&end| end >= body && end <= to).ok_or_else(|| ReadError::malformed(format!("the {} box overruns its parent", fourcc(&kind))))?;
            out.push((kind, body, end));
            at = end;
        }
        Ok(out)
    }

    fn child(&self, from: usize, to: usize, kind: &[u8; 4]) -> Result<Option<(usize, usize)>> {
        Ok(self.children(from, to)?.into_iter().find(|(k, ..)| k == kind).map(|(_, body, end)| (body, end)))
    }

    fn need(&self, from: usize, to: usize, kind: &[u8; 4]) -> Result<(usize, usize)> {
        self.child(from, to, kind)?.ok_or_else(|| ReadError::malformed(format!("no {} box", fourcc(kind))))
    }
}

enum Description {
    Avc { avcc: Vec<u8>, width: u16, height: u16 },
    Aac { config: Vec<u8>, sample_rate: u32, channels: u16, average_bitrate: u32, max_bitrate: u32 },
}

struct TrakInfo {
    id: u32,
    /// The tkhd's enabled flag: an editable recording's camera and second sound are disabled alternates.
    enabled: bool,
    timescale: u32,
    description: Description,
    /// The edit list's single entry: (segment duration in the movie's timescale, media time).
    edit: Option<(u64, i64)>,
    samples: Samples,
    syncs: Option<Vec<u32>>,
}

/// Reads the index of `source`, an MP4 the engine wrote.
pub fn read(source: &dyn ReadAt) -> Result<SourceIndex> {
    let length = source.size().map_err(ReadError::io)?;
    let mut at = 0;
    let mut first = true;
    let mut moov = None;
    let mut tops = Vec::new();
    while let Some(b) = header(source, at, length)? {
        if first && &b.kind != b"ftyp" {
            return Err(ReadError::unsupported("not an MP4 file"));
        }
        first = false;
        at = b.end;
        if &b.kind == b"moov" && moov.is_none() {
            moov = Some(read_box(source, &b)?);
        } else if &b.kind == b"moof" {
            tops.push(b);
        } else if &b.kind == b"mdat" {
            // Kept with the fragments: a moof's samples are in the mdat after it.
            tops.push(b);
        }
    }
    if first {
        return Err(ReadError::unsupported("not an MP4 file"));
    }
    let moov = moov.ok_or_else(|| ReadError::unsupported("the file has no index (moov): it is not a recording the engine wrote"))?;
    let m = Bytes(&moov);
    let (body, end) = (0, moov.len());
    let (mvhd, _) = m.need(body, end, b"mvhd")?;
    let movie_timescale = if m.u8(mvhd)? == 1 { m.u32(mvhd + 20)? } else { m.u32(mvhd + 12)? };
    let fragmented = m.child(body, end, b"mvex")?.is_some();
    let mut traks = Vec::new();
    for (kind, from, to) in m.children(body, end)? {
        if &kind == b"trak" {
            traks.push(trak(m, from, to, fragmented)?);
        }
    }
    if fragmented {
        read_fragments(source, &tops, length, &mut traks)?;
    }
    // The enabled track of each kind is what players present; an editable recording (plan 087), and only one, adds a
    // disabled one of each kind and describes itself in its `udta`.
    let description = editable_description(m, body, end)?;
    let (mut video, mut audio, mut camera, mut second_audio) = (None, None, None, None);
    for t in traks {
        let slot = match (&t.description, t.enabled) {
            (Description::Avc { .. }, true) => &mut video,
            (Description::Aac { .. }, true) => &mut audio,
            (Description::Avc { .. }, false) => &mut camera,
            (Description::Aac { .. }, false) => &mut second_audio,
        };
        if slot.is_some() {
            return Err(ReadError::unsupported(match t.description {
                Description::Avc { .. } => "more than one video track",
                Description::Aac { .. } => "more than one sound track",
            }));
        }
        *slot = Some(t);
    }
    if (camera.is_some() || second_audio.is_some()) && description.is_none() {
        return Err(ReadError::unsupported("a disabled track in a file that is not an editable recording"));
    }
    let video = video.ok_or_else(|| ReadError::unsupported("no video track"))?;
    let video = video_track(video)?;
    let audio = audio.map(|a| audio_track(a, movie_timescale)).transpose()?;
    // A recording that ended without its stop may hold no fragment of the camera or the second sound yet, though its
    // header names them: what it does hold, the screen and its sound, is kept (plan 087's recovery), the empty track
    // left out.
    let camera = camera.filter(|t| !t.samples.is_empty()).map(video_track).transpose()?;
    let second_audio = second_audio.filter(|t| !t.samples.is_empty()).map(|a| audio_track(a, movie_timescale)).transpose()?;
    for samples in [Some(&video.samples), audio.as_ref().map(|a| &a.samples), camera.as_ref().map(|c| &c.samples), second_audio.as_ref().map(|a| &a.samples)]
        .into_iter()
        .flatten()
    {
        check_sizes(samples, length)?;
    }
    Ok(SourceIndex { video, audio, camera, second_audio, description, fragmented })
}

fn video_track(t: TrakInfo) -> Result<VideoTrack> {
    let Description::Avc { avcc, width, height } = t.description else { unreachable!() };
    if t.samples.is_empty() {
        return Err(ReadError::unsupported("the video track has no pictures"));
    }
    if let Some((_, media_time)) = t.edit
        && media_time != 0
    {
        return Err(ReadError::unsupported("the video track starts with an edit the engine never writes"));
    }
    let count = t.samples.len();
    let mut sync = vec![t.syncs.is_none(); count];
    if let Some(syncs) = &t.syncs {
        for &number in syncs {
            let index =
                number.checked_sub(1).map(|n| n as usize).filter(|&n| n < count).ok_or_else(|| ReadError::malformed("a key frame past the last picture"))?;
            sync[index] = true;
        }
    }
    if !sync[0] {
        return Err(ReadError::malformed("the first picture is not a key frame"));
    }
    let mut times = Vec::with_capacity(count);
    let mut time = 0u64;
    for &duration in &t.samples.durations {
        times.push(time);
        time += u64::from(duration);
    }
    Ok(VideoTrack { timescale: t.timescale, avcc, width, height, samples: t.samples, times, sync })
}

fn audio_track(t: TrakInfo, movie_timescale: u32) -> Result<AudioTrack> {
    let Description::Aac { config, sample_rate, channels, average_bitrate, max_bitrate } = t.description else { unreachable!() };
    if t.samples.durations[..t.samples.len().saturating_sub(1)].iter().any(|&d| d != 1024) {
        return Err(ReadError::unsupported("sound packets that are not 1024 frames each"));
    }
    if channels == 0 || !(8_000..=96_000).contains(&sample_rate) || u64::from(sample_rate) != u64::from(t.timescale) {
        return Err(ReadError::unsupported(format!("sound at {sample_rate} Hz in a timescale of {} with {channels} channels", t.timescale)));
    }
    let (skip, presented) = match t.edit {
        Some((segment, media_time)) => {
            let skip = u32::try_from(media_time).map_err(|_| ReadError::unsupported("a sound edit the engine never writes"))?;
            let presented = (segment > 0).then(|| (u128::from(segment) * u128::from(t.timescale) / u128::from(movie_timescale.max(1))) as u64);
            (skip, presented)
        }
        None => (0, None),
    };
    Ok(AudioTrack { timescale: t.timescale, config, sample_rate, channels, average_bitrate, max_bitrate, skip, presented, samples: t.samples })
}

fn check_sizes(samples: &Samples, length: u64) -> Result<()> {
    let mut bad = None;
    samples.locate(0, samples.len(), |index, offset, size| {
        if bad.is_none() && offset.checked_add(u64::from(size)).is_none_or(|end| end > length) {
            bad = Some(index);
        }
    });
    match bad {
        Some(index) => Err(ReadError::malformed(format!("sample {index} lies past the end of the file"))),
        None => Ok(()),
    }
}

/// The `moov`'s `udta/rsed` (editable.rs), as text: an editable recording's description, which main reads.
fn editable_description(m: Bytes, from: usize, to: usize) -> Result<Option<String>> {
    let Some((udta, udta_end)) = m.child(from, to, b"udta")? else { return Ok(None) };
    let Some((rsed, rsed_end)) = m.child(udta, udta_end, crate::mux::mp4::METADATA_BOX)? else { return Ok(None) };
    if rsed_end - rsed > crate::editable::MAX_BYTES {
        return Err(ReadError::unsupported(format!("an editable description of {} bytes", rsed_end - rsed)));
    }
    let text = String::from_utf8(m.get(rsed, rsed_end - rsed)?.to_vec()).map_err(|_| ReadError::malformed("an editable description that is not text"))?;
    Ok(Some(text))
}

fn trak(m: Bytes, from: usize, to: usize, fragmented: bool) -> Result<TrakInfo> {
    let (tkhd, _) = m.need(from, to, b"tkhd")?;
    let id = m.u32(tkhd + if m.u8(tkhd)? == 1 { 20 } else { 12 })?;
    let enabled = m.u32(tkhd)? & 1 != 0;
    let edit = match m.child(from, to, b"edts")? {
        Some((edts, edts_end)) => {
            let (elst, _) = m.need(edts, edts_end, b"elst")?;
            let version = m.u8(elst)?;
            let count = m.u32(elst + 4)?;
            if count != 1 {
                return Err(ReadError::unsupported(format!("an edit list of {count} entries")));
            }
            Some(if version == 1 { (m.u64(elst + 8)?, m.u64(elst + 16)? as i64) } else { (u64::from(m.u32(elst + 8)?), i64::from(m.u32(elst + 12)? as i32)) })
        }
        None => None,
    };
    let (mdia, mdia_end) = m.need(from, to, b"mdia")?;
    let (mdhd, _) = m.need(mdia, mdia_end, b"mdhd")?;
    let timescale = if m.u8(mdhd)? == 1 { m.u32(mdhd + 20)? } else { m.u32(mdhd + 12)? };
    if timescale == 0 {
        return Err(ReadError::malformed("a track with a timescale of 0"));
    }
    let (minf, minf_end) = m.need(mdia, mdia_end, b"minf")?;
    let (stbl, stbl_end) = m.need(minf, minf_end, b"stbl")?;
    let (stsd, stsd_end) = m.need(stbl, stbl_end, b"stsd")?;
    let entries = m.u32(stsd + 4)?;
    if entries != 1 {
        return Err(ReadError::unsupported(format!("{entries} sample descriptions: a file exported with mixed parameter sets cannot be cut again")));
    }
    let description = sample_entry(m, stsd + 8, stsd_end)?;
    if m.child(stbl, stbl_end, b"ctts")?.is_some() {
        return Err(ReadError::unsupported("reordered pictures (ctts), which the engine never writes"));
    }
    let syncs = match m.child(stbl, stbl_end, b"stss")? {
        Some((stss, _)) => {
            let count = m.u32(stss + 4)? as usize;
            m.get(stss + 8, count.checked_mul(4).ok_or_else(|| ReadError::malformed("stss count"))?)?;
            Some((0..count).map(|n| m.u32(stss + 8 + n * 4)).collect::<Result<Vec<u32>>>()?)
        }
        None => None,
    };
    let samples = if fragmented { Samples::default() } else { plain_samples(m, stbl, stbl_end)? };
    Ok(TrakInfo { id, enabled, timescale, description, edit, samples, syncs })
}

fn sample_entry(m: Bytes, from: usize, to: usize) -> Result<Description> {
    let entry = m.children(from, to)?;
    let (kind, body, end) = *entry.first().ok_or_else(|| ReadError::malformed("an empty stsd"))?;
    match &kind {
        b"avc1" => {
            let width = m.u16(body + 24)?;
            let height = m.u16(body + 26)?;
            // The visual sample entry's 78 bytes, then its boxes.
            let (avcc, avcc_end) = m.need(body + 78, end, b"avcC")?;
            Ok(Description::Avc { avcc: m.get(avcc, avcc_end - avcc)?.to_vec(), width, height })
        }
        b"mp4a" => {
            let channels = m.u16(body + 16)?;
            let sample_rate = m.u32(body + 24)? >> 16;
            let (esds, esds_end) = m.need(body + 28, end, b"esds")?;
            let (config, average_bitrate, max_bitrate) = esds_fields(m.get(esds + 4, esds_end - esds - 4)?)?;
            Ok(Description::Aac { config, sample_rate, channels, average_bitrate, max_bitrate })
        }
        other => Err(ReadError::unsupported(format!("a {} track: only H.264 and AAC recordings can be cut", fourcc(other)))),
    }
}

/// The AudioSpecificConfig and bit rates from an `ES_Descriptor` (ISO/IEC 14496-1).
fn esds_fields(data: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    fn descriptor(data: &[u8], at: usize) -> Result<(u8, usize, usize)> {
        let tag = *data.get(at).ok_or_else(|| ReadError::malformed("esds ends"))?;
        let mut length = 0usize;
        let mut i = at + 1;
        for _ in 0..4 {
            let byte = *data.get(i).ok_or_else(|| ReadError::malformed("esds ends"))?;
            length = (length << 7) | usize::from(byte & 0x7f);
            i += 1;
            if byte & 0x80 == 0 {
                break;
            }
        }
        if i + length > data.len() {
            return Err(ReadError::malformed("an esds descriptor overruns it"));
        }
        Ok((tag, i, i + length))
    }
    let (tag, es, es_end) = descriptor(data, 0)?;
    if tag != 0x03 {
        return Err(ReadError::malformed("esds without an ES descriptor"));
    }
    let flags = *data.get(es + 2).ok_or_else(|| ReadError::malformed("esds ends"))?;
    let mut at = es + 3;
    if flags & 0x80 != 0 {
        at += 2;
    }
    if flags & 0x40 != 0 {
        at += 1 + usize::from(*data.get(at).ok_or_else(|| ReadError::malformed("esds ends"))?);
    }
    if flags & 0x20 != 0 {
        at += 2;
    }
    let (tag, config_at, config_end) = descriptor(data, at)?;
    if tag != 0x04 || config_end > es_end || config_end < config_at + 13 {
        return Err(ReadError::malformed("esds without a decoder configuration"));
    }
    if data[config_at] != 0x40 {
        return Err(ReadError::unsupported("sound that is not MPEG-4 audio"));
    }
    let max_bitrate = u32::from_be_bytes(data[config_at + 5..config_at + 9].try_into().unwrap());
    let average_bitrate = u32::from_be_bytes(data[config_at + 9..config_at + 13].try_into().unwrap());
    let (tag, specific, specific_end) = descriptor(data, config_at + 13)?;
    if tag != 0x05 || specific_end > config_end {
        return Err(ReadError::malformed("esds without an AudioSpecificConfig"));
    }
    Ok((data[specific..specific_end].to_vec(), average_bitrate, max_bitrate))
}

fn table_count(m: Bytes, at: usize, entry: usize) -> Result<usize> {
    let count = m.u32(at)? as usize;
    if count > SAMPLES_LIMIT {
        return Err(ReadError::unsupported(format!("{count} entries: more than any recording the engine writes")));
    }
    m.get(at + 4, count * entry)?;
    Ok(count)
}

fn plain_samples(m: Bytes, stbl: usize, stbl_end: usize) -> Result<Samples> {
    let (stts, _) = m.need(stbl, stbl_end, b"stts")?;
    let mut durations = Vec::new();
    for n in 0..table_count(m, stts + 4, 8)? {
        let (count, value) = (m.u32(stts + 8 + n * 8)? as usize, m.u32(stts + 12 + n * 8)?);
        if durations.len() + count > SAMPLES_LIMIT {
            return Err(ReadError::unsupported("more samples than any recording the engine writes"));
        }
        durations.extend(std::iter::repeat_n(value.max(1), count));
    }
    let (stsz, _) = m.need(stbl, stbl_end, b"stsz")?;
    let fixed = m.u32(stsz + 4)?;
    let count = m.u32(stsz + 8)? as usize;
    if count != durations.len() {
        return Err(ReadError::malformed(format!("{} durations for {count} sizes", durations.len())));
    }
    let sizes: Vec<u32> = if fixed != 0 {
        vec![fixed; count]
    } else {
        table_count(m, stsz + 8, 4)?;
        (0..count).map(|n| m.u32(stsz + 12 + n * 4)).collect::<Result<_>>()?
    };
    if let Some(&size) = sizes.iter().find(|&&s| s > SAMPLE_LIMIT) {
        return Err(ReadError::unsupported(format!("a sample of {size} bytes")));
    }
    let (stsc, _) = m.need(stbl, stbl_end, b"stsc")?;
    let stsc_entries: Vec<(u32, u32)> =
        (0..table_count(m, stsc + 4, 12)?).map(|n| Ok((m.u32(stsc + 8 + n * 12)?, m.u32(stsc + 12 + n * 12)?))).collect::<Result<_>>()?;
    let offsets: Vec<u64> = if let Some((stco, _)) = m.child(stbl, stbl_end, b"stco")? {
        (0..table_count(m, stco + 4, 4)?).map(|n| m.u32(stco + 8 + n * 4).map(u64::from)).collect::<Result<_>>()?
    } else {
        let (co64, _) = m.need(stbl, stbl_end, b"co64")?;
        (0..table_count(m, co64 + 4, 8)?).map(|n| m.u64(co64 + 8 + n * 8)).collect::<Result<_>>()?
    };
    let mut chunks = Vec::with_capacity(offsets.len());
    let mut sample = 0usize;
    for (index, &offset) in offsets.iter().enumerate() {
        let number = index as u32 + 1;
        let per_chunk = stsc_entries.iter().rev().find(|(first, _)| *first <= number).ok_or_else(|| ReadError::malformed("a chunk without stsc"))?.1 as usize;
        if per_chunk == 0 {
            continue;
        }
        if sample + per_chunk > count {
            return Err(ReadError::malformed("chunks hold more samples than the track"));
        }
        chunks.push((offset, sample as u32));
        sample += per_chunk;
    }
    if sample != count {
        return Err(ReadError::malformed(format!("chunks cover {sample} of {count} samples")));
    }
    Ok(Samples { sizes, durations, chunks })
}

/// Reads every whole fragment after the index. A fragment is whole when its `mdat` holds all its samples; the first
/// that does not ends the reading, as it ends a player's.
fn read_fragments(source: &dyn ReadAt, tops: &[BoxHeader], length: u64, traks: &mut [TrakInfo]) -> Result<()> {
    let mut syncs: Vec<Vec<u32>> = traks.iter().map(|_| Vec::new()).collect();
    let mut all_sync: Vec<bool> = traks.iter().map(|_| true).collect();
    'fragments: for (index, moof) in tops.iter().enumerate() {
        if &moof.kind != b"moof" {
            continue;
        }
        let Some(mdat) = tops.get(index + 1).filter(|b| &b.kind == b"mdat") else { break };
        let data = read_box(source, moof)?;
        let m = Bytes(&data);
        // Parsed first, applied only once the whole fragment checks out.
        let mut pending = Vec::new();
        for (kind, from, to) in m.children(0, data.len())? {
            if &kind != b"traf" {
                continue;
            }
            let (tfhd, _) = m.need(from, to, b"tfhd")?;
            let flags = m.u32(tfhd)? & 0xff_ffff;
            if flags & 0x02_0000 == 0 {
                return Err(ReadError::unsupported("fragments the engine did not write"));
            }
            if flags & 0x00_0002 != 0 && m.u32(tfhd + 8)? != 1 {
                return Err(ReadError::unsupported("a second sample description: a file exported with mixed parameter sets cannot be cut again"));
            }
            let id = m.u32(tfhd + 4)?;
            let track = traks.iter().position(|t| t.id == id).ok_or_else(|| ReadError::malformed("a fragment of an unknown track"))?;
            let (trun, _) = m.need(from, to, b"trun")?;
            if m.u32(trun)? & 0xff_ffff != 0x701 {
                return Err(ReadError::unsupported("fragments the engine did not write"));
            }
            let count = m.u32(trun + 4)? as usize;
            if count > SAMPLES_LIMIT {
                return Err(ReadError::unsupported("a fragment with more samples than the engine writes"));
            }
            let data_offset = i64::from(m.u32(trun + 8)? as i32);
            let start =
                (moof.start as i64).checked_add(data_offset).filter(|&s| s >= 0).ok_or_else(|| ReadError::malformed("a fragment's data offset"))? as u64;
            let mut entries = Vec::with_capacity(count);
            let mut end = start;
            for n in 0..count {
                let field = trun + 12 + n * 12;
                let (duration, size, flags) = (m.u32(field)?, m.u32(field + 4)?, m.u32(field + 8)?);
                if size > SAMPLE_LIMIT {
                    return Err(ReadError::unsupported(format!("a sample of {size} bytes")));
                }
                entries.push((duration.max(1), size, flags & 0x1_0000 == 0));
                end += u64::from(size);
            }
            if start < mdat.body || end > mdat.end.min(length) {
                break 'fragments;
            }
            pending.push((track, start, entries));
        }
        for (track, start, entries) in pending {
            let t = &mut traks[track];
            if t.samples.len() + entries.len() > SAMPLES_LIMIT {
                return Err(ReadError::unsupported("more samples than any recording the engine writes"));
            }
            t.samples.chunks.push((start, t.samples.len() as u32));
            for (duration, size, sync) in entries {
                if sync {
                    syncs[track].push(t.samples.len() as u32 + 1);
                } else {
                    all_sync[track] = false;
                }
                t.samples.sizes.push(size);
                t.samples.durations.push(duration);
            }
        }
    }
    for (index, t) in traks.iter_mut().enumerate() {
        t.syncs = if all_sync[index] { None } else { Some(std::mem::take(&mut syncs[index])) };
        if t.samples.chunks.first().is_some_and(|&(_, first)| first != 0) {
            return Err(ReadError::malformed("chunks out of order"));
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::mux::mp4::tests::{audio_config, video_config};
    use crate::mux::mp4::{HybridMp4, Sample, TrackConfig};

    fn recording(fragments: usize, finish: bool) -> (Vec<u8>, Vec<Vec<u8>>) {
        let audio = TrackConfig { skip: 2112, ..audio_config() };
        let mut mp4 = HybridMp4::create(Vec::new(), vec![video_config(), audio]).unwrap();
        let mut frames = Vec::new();
        for f in 0..fragments {
            let chunk: Vec<Vec<u8>> = (0..30).map(|n| vec![(f * 30 + n) as u8; 20 + n]).collect();
            let samples: Vec<Sample> = chunk.iter().enumerate().map(|(n, d)| Sample { data: d, duration: 3000, sync: n % 15 == 0 }).collect();
            mp4.write_fragment(0, &samples).unwrap();
            let sound = vec![vec![7u8; 9]; 47];
            let samples: Vec<Sample> = sound.iter().map(|d| Sample { data: d, duration: 1024, sync: true }).collect();
            mp4.write_fragment(1, &samples).unwrap();
            frames.extend(chunk);
        }
        mp4.set_presented(1, fragments as u64 * 47 * 1024 - 2112);
        if finish {
            let (_, out) = mp4.finish().unwrap();
            (out, frames)
        } else {
            (mp4.output().clone(), frames)
        }
    }

    fn sample_bytes(source: &Vec<u8>, samples: &Samples, index: usize) -> Vec<u8> {
        let mut out = Vec::new();
        samples.locate(index, index + 1, |_, offset, size| {
            let mut buffer = vec![0u8; size as usize];
            source.read_at(&mut buffer, offset).unwrap();
            out = buffer;
        });
        out
    }

    #[test]
    fn a_finished_recording_reads_back_its_samples_times_and_key_frames() {
        let (file, frames) = recording(3, true);
        let index = read(&file).unwrap();
        assert!(!index.fragmented);
        let video = &index.video;
        assert_eq!((video.timescale, video.width, video.height), (90_000, 1920, 1080));
        assert_eq!(video.samples.len(), 90);
        assert_eq!(video.times[31], 31 * 3000);
        assert_eq!(video.end(), 90 * 3000);
        assert_eq!(video.sync.iter().filter(|&&s| s).count(), 6);
        assert!(video.sync[45] && !video.sync[46]);
        for n in [0, 29, 30, 89] {
            assert_eq!(sample_bytes(&file, &video.samples, n), frames[n], "sample {n}");
        }
        let audio = index.audio.unwrap();
        assert_eq!((audio.sample_rate, audio.channels, audio.skip), (48_000, 2, 2112));
        assert_eq!(audio.config, [0x11, 0x90]);
        assert_eq!(audio.samples.len(), 141);
        assert_eq!(audio.presented, Some(141 * 1024 - 2112));
    }

    #[test]
    fn an_interrupted_recording_reads_its_whole_fragments() {
        let (mut file, frames) = recording(3, false);
        let index = read(&file).unwrap();
        assert!(index.fragmented);
        assert_eq!(index.video.samples.len(), 90);
        assert_eq!(sample_bytes(&file, &index.video.samples, 60), frames[60]);
        // Cut inside the last fragment's media: its samples are not there, so the fragment is left out.
        file.truncate(file.len() - 5);
        let index = read(&file).unwrap();
        assert_eq!(index.video.samples.len(), 90);
        assert_eq!(index.audio.unwrap().samples.len(), 94);
    }

    #[test]
    fn other_files_and_damaged_indexes_are_refused_with_a_reason() {
        assert_eq!(read(&b"not a movie at all".to_vec()).unwrap_err().code, "unsupported");
        assert_eq!(read(&Vec::new()).unwrap_err().code, "unsupported");
        let (file, _) = recording(1, true);
        // The index cut off: no moov is whole. (The fragmented index is still inside the finished file's mdat, so
        // the changes below look for the last box of each kind.)
        let cut = file[..file.len() - 40].to_vec();
        assert_eq!(read(&cut).unwrap_err().code, "unsupported");
        // A stsz claiming more samples than stts.
        let mut wrong = file.clone();
        let at = wrong.windows(4).rposition(|w| w == b"stsz").unwrap();
        wrong[at + 12..at + 16].copy_from_slice(&1000u32.to_be_bytes());
        assert_eq!(read(&wrong).unwrap_err().code, "malformed");
        // A chunk offset past the end.
        let mut far = file.clone();
        let at = far.windows(4).rposition(|w| w == b"stco").unwrap();
        far[at + 12..at + 16].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(read(&far).unwrap_err().code, "malformed");
        // A codec other than H.264.
        let mut other = file.clone();
        let at = other.windows(4).rposition(|w| w == b"avc1").unwrap();
        other[at..at + 4].copy_from_slice(b"hvc1");
        assert_eq!(read(&other).unwrap_err().code, "unsupported");
    }

    #[test]
    fn every_truncation_of_a_recording_is_refused_or_read_never_panics() {
        let (file, _) = recording(2, true);
        for length in (0..file.len()).step_by(7) {
            let _ = read(&file[..length].to_vec());
        }
        let (file, _) = recording(2, false);
        for length in (0..file.len()).step_by(5) {
            let _ = read(&file[..length].to_vec());
        }
    }

    #[test]
    fn flipped_bytes_in_the_index_never_panic() {
        let (file, _) = recording(1, true);
        let moov = file.windows(4).rposition(|w| w == b"moov").unwrap() - 4;
        for at in moov..file.len() {
            for value in [0u8, 0xff, 0x80] {
                let mut damaged = file.clone();
                damaged[at] = value;
                let _ = read(&damaged);
            }
        }
    }

    #[test]
    fn locate_walks_chunks() {
        let samples = Samples { sizes: vec![1, 2, 3, 4, 5], durations: vec![1; 5], chunks: vec![(100, 0), (500, 2), (900, 4)] };
        let mut seen = Vec::new();
        samples.locate(1, 5, |i, o, s| seen.push((i, o, s)));
        assert_eq!(seen, [(1, 101, 2), (2, 500, 3), (3, 503, 4), (4, 900, 5)]);
    }

    /// An editable recording (plan 087) as the writer lays it out: screen, system sound, microphone, camera, and its
    /// description; `finish` or as an interrupted recording leaves it.
    pub(crate) fn editable_recording(fragments: usize, finish: bool) -> Vec<u8> {
        let audio = TrackConfig { skip: 2112, ..audio_config() };
        let camera = TrackConfig {
            codec: crate::mux::mp4::Codec::H264 {
                avcc: vec![1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 2, 0x68, 0xee],
                width: 1280,
                height: 720,
            },
            ..video_config()
        };
        let description = crate::editable::Description {
            sounds: vec![crate::editable::Sound::System, crate::editable::Sound::Microphone],
            camera: Some(crate::camera_layout::Layout::default()),
        };
        let mut mp4 = HybridMp4::create_with_metadata(Vec::new(), vec![video_config(), audio.clone(), audio, camera], Some(description.to_bytes())).unwrap();
        for f in 0..fragments {
            for (track, mark) in [(0usize, 1u8), (3, 4)] {
                let chunk: Vec<Vec<u8>> = (0..30).map(|n| vec![mark, (f * 30 + n) as u8]).collect();
                let samples: Vec<Sample> = chunk.iter().enumerate().map(|(n, d)| Sample { data: d, duration: 3000, sync: n == 0 }).collect();
                mp4.write_fragment(track, &samples).unwrap();
            }
            for (track, mark) in [(1usize, 2u8), (2, 3)] {
                let sound = vec![vec![mark; 9]; 47];
                let samples: Vec<Sample> = sound.iter().map(|d| Sample { data: d, duration: 1024, sync: true }).collect();
                mp4.write_fragment(track, &samples).unwrap();
            }
        }
        for track in [1, 2] {
            mp4.set_presented(track, fragments as u64 * 47 * 1024 - 2112);
        }
        if finish { mp4.finish().unwrap().1 } else { mp4.output().clone() }
    }

    #[test]
    fn an_editable_recording_reads_its_camera_second_sound_and_description_finished_or_interrupted() {
        for finish in [true, false] {
            let file = editable_recording(2, finish);
            let index = read(&file).unwrap();
            assert_eq!(index.fragmented, !finish);
            assert_eq!(sample_bytes(&file, &index.video.samples, 0), [1, 0]);
            assert_eq!(sample_bytes(&file, &index.audio.as_ref().unwrap().samples, 0), [2; 9]);
            let camera = index.camera.as_ref().expect("the camera track");
            assert_eq!((camera.width, camera.height, camera.times.len()), (1280, 720, 60));
            assert_eq!(sample_bytes(&file, &camera.samples, 31), [4, 31]);
            assert_eq!(sample_bytes(&file, &index.second_audio.as_ref().unwrap().samples, 3), [3; 9]);
            let description: serde_json::Value = serde_json::from_str(index.description.as_deref().unwrap()).unwrap();
            assert_eq!(description["sounds"], serde_json::json!(["system", "microphone"]));
        }
    }

    #[test]
    fn today_s_recording_has_no_camera_second_sound_or_description() {
        let (file, _) = recording(2, true);
        let index = read(&file).unwrap();
        assert!(index.camera.is_none() && index.second_audio.is_none() && index.description.is_none());
    }

    #[test]
    fn a_disabled_track_without_a_description_is_not_an_editable_recording() {
        // Two tracks of a kind make the second a disabled alternate (mux/mp4.rs); without the description it is refused.
        let mut mp4 = HybridMp4::create(Vec::new(), vec![video_config(), video_config()]).unwrap();
        let samples = [Sample { data: &[1], duration: 3000, sync: true }];
        mp4.write_fragment(0, &samples).unwrap();
        mp4.write_fragment(1, &samples).unwrap();
        let (_, file) = mp4.finish().unwrap();
        let error = read(&file).unwrap_err();
        assert!(error.detail.contains("not an editable recording"), "{}", error.detail);
    }

    #[test]
    fn an_interrupted_editable_recording_whose_camera_wrote_nothing_yet_keeps_its_screen_and_sound() {
        // Codex's review of plan 087: the screen's and the sounds' first fragments written, the camera's not yet.
        let audio = TrackConfig { skip: 2112, ..audio_config() };
        let description = crate::editable::Description {
            sounds: vec![crate::editable::Sound::System, crate::editable::Sound::Microphone],
            camera: Some(crate::camera_layout::Layout::default()),
        };
        let mut mp4 =
            HybridMp4::create_with_metadata(Vec::new(), vec![video_config(), audio.clone(), audio, video_config()], Some(description.to_bytes())).unwrap();
        let screen: Vec<Vec<u8>> = (0..30).map(|n| vec![1, n as u8]).collect();
        mp4.write_fragment(0, &screen.iter().enumerate().map(|(n, d)| Sample { data: d, duration: 3000, sync: n == 0 }).collect::<Vec<_>>()).unwrap();
        let sound = vec![vec![2u8; 9]; 47];
        mp4.write_fragment(1, &sound.iter().map(|d| Sample { data: d, duration: 1024, sync: true }).collect::<Vec<_>>()).unwrap();
        let file = mp4.output().clone();
        let index = read(&file).unwrap();
        assert_eq!(index.video.times.len(), 30);
        assert!(index.audio.is_some() && index.camera.is_none() && index.second_audio.is_none() && index.description.is_some());
    }
}
