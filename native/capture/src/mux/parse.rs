//! A reader for what `HybridMp4` writes, plain or fragmented, used by the tests to check every sample's bytes,
//! decode time and sync flag. It reads only the boxes and fields the writer uses; a box cut off at the end of the
//! file ends the reading, as a player stops at an interrupted recording's last whole fragment.

use std::collections::BTreeMap;

pub struct Mp4 {
    pub top: Vec<String>,
    pub tracks: Vec<Track>,
}

#[derive(Default)]
pub struct Track {
    pub id: u32,
    pub timescale: u32,
    pub duration: u64,
    pub movie_duration: u64,
    /// The tkhd duration, in the movie's timescale.
    pub track_duration: u64,
    /// The single edit: segment duration (movie timescale) and media time.
    pub edit: Option<(u64, i64)>,
    pub fragmented: bool,
    pub stss: Option<Vec<u32>>,
    /// The `stsd` entries' four-character codes.
    pub descriptions: Vec<String>,
    pub samples: Vec<ParsedSample>,
}

pub struct ParsedSample {
    pub data: Vec<u8>,
    pub decode_time: u64,
    pub sync: bool,
    /// The sample description, 1-based.
    pub description: u32,
}

struct Box_ {
    kind: String,
    start: usize,
    header: usize,
    end: usize,
}

fn boxes(data: &[u8], from: usize, to: usize) -> Vec<Box_> {
    let mut out = Vec::new();
    let mut at = from;
    while at + 8 <= to {
        let mut size = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
        let mut header = 8;
        if size == 1 {
            if at + 16 > to {
                break;
            }
            size = u64::from_be_bytes(data[at + 8..at + 16].try_into().unwrap()) as usize;
            header = 16;
        }
        if size < header || at + size > to {
            break;
        }
        out.push(Box_ { kind: String::from_utf8_lossy(&data[at + 4..at + 8]).into(), start: at, header, end: at + size });
        at += size;
    }
    out
}

fn child<'a>(list: &'a [Box_], kind: &str) -> Option<&'a Box_> {
    list.iter().find(|b| b.kind == kind)
}

fn inside(data: &[u8], b: &Box_) -> Vec<Box_> {
    boxes(data, b.start + b.header, b.end)
}

fn u32_at(data: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(data[at..at + 4].try_into().unwrap())
}

fn u64_at(data: &[u8], at: usize) -> u64 {
    u64::from_be_bytes(data[at..at + 8].try_into().unwrap())
}

/// A full box's version, flags and the offset its fields start at.
fn full(data: &[u8], b: &Box_) -> (u8, u32, usize) {
    let at = b.start + b.header;
    (data[at], u32_at(data, at) & 0xff_ffff, at + 4)
}

pub fn parse(data: &[u8]) -> Result<Mp4, String> {
    let top = boxes(data, 0, data.len());
    let moov = child(&top, "moov").ok_or("no moov")?;
    let moov_children = inside(data, moov);
    let mvhd = child(&moov_children, "mvhd").ok_or("no mvhd")?;
    let (version, _, at) = full(data, mvhd);
    let movie_duration = if version == 1 { u64_at(data, at + 20) } else { u64::from(u32_at(data, at + 12)) };
    let fragmented = child(&moov_children, "mvex").is_some();
    let mut tracks: BTreeMap<u32, Track> = BTreeMap::new();
    for trak in moov_children.iter().filter(|b| b.kind == "trak") {
        let parts = inside(data, trak);
        let (v, _, at) = full(data, child(&parts, "tkhd").ok_or("no tkhd")?);
        let id = u32_at(data, at + if v == 1 { 16 } else { 8 });
        let track_duration = if v == 1 { u64_at(data, at + 24) } else { u64::from(u32_at(data, at + 16)) };
        let edit = child(&parts, "edts").map(|edts| {
            let (_, _, at) = full(data, child(&inside(data, edts), "elst").expect("edts without elst"));
            assert_eq!(u32_at(data, at), 1, "one edit");
            (u64_at(data, at + 4), u64_at(data, at + 12) as i64)
        });
        let mdia = inside(data, child(&parts, "mdia").ok_or("no mdia")?);
        let (v, _, at) = full(data, child(&mdia, "mdhd").ok_or("no mdhd")?);
        let (timescale, duration) =
            if v == 1 { (u32_at(data, at + 16), u64_at(data, at + 20)) } else { (u32_at(data, at + 8), u64::from(u32_at(data, at + 12))) };
        let minf = inside(data, child(&mdia, "minf").ok_or("no minf")?);
        let stbl = inside(data, child(&minf, "stbl").ok_or("no stbl")?);
        let mut track = Track { id, timescale, duration, movie_duration, track_duration, edit, fragmented, ..Default::default() };
        let stsd = child(&stbl, "stsd").ok_or("no stsd")?;
        let (_, _, at) = full(data, stsd);
        track.descriptions = boxes(data, at + 4, stsd.end).iter().map(|b| b.kind.clone()).collect();
        if let Some(stss) = child(&stbl, "stss") {
            let (_, _, at) = full(data, stss);
            track.stss = Some((0..u32_at(data, at) as usize).map(|n| u32_at(data, at + 4 + n * 4)).collect());
        }
        if !fragmented {
            read_plain(data, &stbl, &mut track)?;
        }
        tracks.insert(id, track);
    }
    // A fragment is whole once a box follows its moof; the last one of a cut-off file is not.
    for (index, moof) in top.iter().enumerate().filter(|(_, b)| b.kind == "moof") {
        if index + 1 < top.len() {
            read_fragment(data, moof, &mut tracks)?;
        }
    }
    Ok(Mp4 { top: top.iter().map(|b| b.kind.clone()).collect(), tracks: tracks.into_values().collect() })
}

fn read_plain(data: &[u8], stbl: &[Box_], track: &mut Track) -> Result<(), String> {
    let (_, _, at) = full(data, child(stbl, "stts").ok_or("no stts")?);
    let mut durations = Vec::new();
    for n in 0..u32_at(data, at) as usize {
        let (count, value) = (u32_at(data, at + 4 + n * 8), u32_at(data, at + 8 + n * 8));
        durations.extend(std::iter::repeat_n(value, count as usize));
    }
    let (_, _, at) = full(data, child(stbl, "stsz").ok_or("no stsz")?);
    let sizes: Vec<u32> = (0..u32_at(data, at + 4) as usize).map(|n| u32_at(data, at + 8 + n * 4)).collect();
    let (_, _, at) = full(data, child(stbl, "stsc").ok_or("no stsc")?);
    let stsc: Vec<(u32, u32, u32)> =
        (0..u32_at(data, at) as usize).map(|n| (u32_at(data, at + 4 + n * 12), u32_at(data, at + 8 + n * 12), u32_at(data, at + 12 + n * 12))).collect();
    let offsets: Vec<u64> = if let Some(stco) = child(stbl, "stco") {
        let (_, _, at) = full(data, stco);
        (0..u32_at(data, at) as usize).map(|n| u64::from(u32_at(data, at + 4 + n * 4))).collect()
    } else {
        let (_, _, at) = full(data, child(stbl, "co64").ok_or("no chunk offsets")?);
        (0..u32_at(data, at) as usize).map(|n| u64_at(data, at + 4 + n * 8)).collect()
    };
    if durations.len() != sizes.len() {
        return Err(format!("{} durations for {} sizes", durations.len(), sizes.len()));
    }
    let mut sample = 0usize;
    let mut time = 0u64;
    for (chunk, &offset) in offsets.iter().enumerate() {
        let number = chunk as u32 + 1;
        let &(_, per_chunk, description) = stsc.iter().rev().find(|(first, _, _)| *first <= number).ok_or("chunk without stsc")?;
        let mut at = offset as usize;
        for _ in 0..per_chunk {
            let size = sizes[sample] as usize;
            let sync = track.stss.as_ref().is_none_or(|s| s.contains(&(sample as u32 + 1)));
            track.samples.push(ParsedSample { data: data[at..at + size].to_vec(), decode_time: time, sync, description });
            time += u64::from(durations[sample]);
            at += size;
            sample += 1;
        }
    }
    if sample != sizes.len() {
        return Err(format!("chunks cover {sample} of {} samples", sizes.len()));
    }
    Ok(())
}

fn read_fragment(data: &[u8], moof: &Box_, tracks: &mut BTreeMap<u32, Track>) -> Result<(), String> {
    for traf in inside(data, moof).iter().filter(|b| b.kind == "traf") {
        let parts = inside(data, traf);
        let (_, flags, at) = full(data, child(&parts, "tfhd").ok_or("no tfhd")?);
        if flags & 0x02_0000 == 0 {
            return Err("only default-base-is-moof is read".into());
        }
        let track = tracks.get_mut(&u32_at(data, at)).ok_or("fragment of an unknown track")?;
        let description = if flags & 0x02 != 0 { u32_at(data, at + 4) } else { 1 };
        let (v, _, at) = full(data, child(&parts, "tfdt").ok_or("no tfdt")?);
        let mut time = if v == 1 { u64_at(data, at) } else { u64::from(u32_at(data, at)) };
        let trun = child(&parts, "trun").ok_or("no trun")?;
        let (_, flags, at) = full(data, trun);
        if flags != 0x701 {
            return Err(format!("trun flags {flags:#x}"));
        }
        let count = u32_at(data, at) as usize;
        let mut position = moof.start + u32_at(data, at + 4) as usize;
        for n in 0..count {
            let field = at + 8 + n * 12;
            let (duration, size, sample_flags) = (u32_at(data, field), u32_at(data, field + 4) as usize, u32_at(data, field + 8));
            if position + size > data.len() {
                return Err("sample past the end of the file".into());
            }
            track.samples.push(ParsedSample {
                data: data[position..position + size].to_vec(),
                decode_time: time,
                sync: sample_flags & 0x1_0000 == 0,
                description,
            });
            position += size;
            time += u64::from(duration);
        }
    }
    Ok(())
}
