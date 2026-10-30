//! Exports of real H.264 and AAC on this Mac (plan 085's gates): a fixture recording made with the recording's own
//! encoders, cut by `remux::export` with VideoToolbox and AudioToolbox, then decoded again and compared with the source.

use crate::edit::control::Control;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use objc2_core_foundation::CFRetained;
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferUnlockBaseAddress,
};

use super::audio::AacEncoder;
use super::compositor::test_frame;
use super::edit::{Decoder, MacCodecs};
use super::video::VideoEncoder;
use crate::core::VideoSink;
use crate::edit::remux::{self, ExportReport, JoinPolicy};
use crate::edit::source;
use crate::mux::mp4::{Codec, HybridMp4, Sample, TrackConfig};
use crate::writer::Media;

pub struct Fixture {
    pub path: PathBuf,
    /// The recording's `avcC`.
    pub avcc: Vec<u8>,
}

#[derive(Default)]
struct Collect(Mutex<Vec<Media>>);

impl VideoSink for Collect {
    fn media(&self, media: Media) {
        self.0.lock().unwrap().push(media);
    }
    fn failed(&self, detail: String) {
        panic!("{detail}");
    }
}

/// A picture that changes every frame: a moving texture, and a bright frame every `flash` frames (a sync marker).
fn picture(width: u32, height: u32, frame: usize, flash: Option<usize>) -> CFRetained<CVPixelBuffer> {
    let buffer = test_frame(width, height);
    let bright = flash.is_some_and(|every| frame.is_multiple_of(every));
    unsafe { CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
    for (plane, rows) in [(0, height as usize), (1, height as usize / 2)] {
        let base = CVPixelBufferGetBaseAddressOfPlane(&buffer, plane).cast::<u8>();
        let stride = CVPixelBufferGetBytesPerRowOfPlane(&buffer, plane);
        for y in 0..rows {
            let line = unsafe { std::slice::from_raw_parts_mut(base.add(y * stride), width as usize) };
            for (x, value) in line.iter_mut().enumerate() {
                *value = if plane == 1 {
                    128 + (((x / 2 + frame) % 32) as u8)
                } else if bright {
                    220
                } else {
                    40 + (((x + 3 * frame) / 4 + y / 4 + (x * y + frame * 7) % 9) % 120) as u8
                };
            }
        }
    }
    unsafe { CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
    buffer
}

/// Sound for `frames` frames at 48 kHz: a tone, or silence with a 30 ms beep at each marker.
pub fn sound(frames: usize, markers: Option<(usize, u32)>) -> Vec<f32> {
    (0..frames * 2)
        .map(|n| {
            let i = n / 2;
            let t = i as f64 / 48_000.0;
            match markers {
                None => ((std::f64::consts::TAU * 440.0 * t).sin() * 0.5) as f32,
                Some((every, fps)) => {
                    let period = 48_000 * every / fps as usize;
                    if i % period < 1440 { ((std::f64::consts::TAU * 1000.0 * t).sin() * 0.6) as f32 } else { 0.0 }
                }
            }
        })
        .collect()
}

/// Records a fixture as the engine records: pictures through the recording's encoder (a key frame at least every
/// second), sound through its AAC encoder with the priming skipped by the edit list.
pub fn fixture(path: &Path, seconds: usize, fps: u32, width: u32, height: u32, markers: Option<usize>) -> Fixture {
    let collect = Arc::new(Collect::default());
    let encoder = VideoEncoder::new(width, height, fps, 4_000_000, collect.clone()).unwrap();
    let frames = seconds * fps as usize;
    for frame in 0..frames {
        let pts = frame as u64 * 1_000_000_000 / u64::from(fps);
        encoder.encode(&picture(width, height, frame, markers), pts, false).unwrap();
    }
    encoder.flush();
    drop(encoder);
    let media = std::mem::take(&mut *collect.0.lock().unwrap());
    let avcc = media.iter().find_map(|m| if let Media::VideoFormat { avcc, .. } = m { Some(avcc.clone()) } else { None }).unwrap();
    let pictures: Vec<(Vec<u8>, bool)> =
        media.into_iter().filter_map(|m| if let Media::Video { data, sync, .. } = m { Some((data, sync)) } else { None }).collect();
    assert_eq!(pictures.len(), frames);
    let mut aac = AacEncoder::new(48_000, 2, 256_000).unwrap();
    let audio_frames = seconds * 48_000;
    aac.push(&sound(audio_frames, markers.map(|m| (m, fps))));
    let mut packets = Vec::new();
    aac.finish(&mut |p| packets.push(p)).unwrap();
    let record = avcc.clone();
    let video = TrackConfig { codec: Codec::H264 { avcc, width: width as u16, height: height as u16 }, timescale: 90_000, skip: 0 };
    let audio = TrackConfig {
        codec: Codec::Aac { config: aac.audio_specific_config(), sample_rate: 48_000, channels: 2, average_bitrate: 256_000, max_bitrate: 256_000 },
        timescale: 48_000,
        skip: aac.priming,
    };
    let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(path).unwrap();
    let mut mp4 = HybridMp4::create(file, vec![video, audio]).unwrap();
    let duration = 90_000 / fps;
    for second in pictures.chunks(fps as usize) {
        let samples: Vec<Sample> = second.iter().map(|(d, s)| Sample { data: d, duration, sync: *s }).collect();
        mp4.write_fragment(0, &samples).unwrap();
    }
    for second in packets.chunks(47) {
        let samples: Vec<Sample> = second.iter().map(|d| Sample { data: d, duration: 1024, sync: true }).collect();
        mp4.write_fragment(1, &samples).unwrap();
    }
    mp4.set_presented(1, audio_frames as u64);
    mp4.finish().unwrap();
    Fixture { path: path.to_owned(), avcc: record }
}

/// Every picture's luma, decoded with the description each sample names (`avccs[description - 1]`).
pub fn decode_luma(samples: &[(Vec<u8>, u32)], avccs: &[Vec<u8>], width: usize, height: usize) -> Vec<Vec<u8>> {
    let decoders: Vec<Decoder> = avccs.iter().map(|a| Decoder::new(a).unwrap()).collect();
    let mut out = Vec::with_capacity(samples.len());
    for (index, (data, description)) in samples.iter().enumerate() {
        let decoder = &decoders[*description as usize - 1];
        decoder.decode(data, index).unwrap();
        for (_, picture) in decoder.take() {
            let picture = picture.unwrap();
            let buffer: &CVPixelBuffer = &picture;
            unsafe { CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags(1)) };
            let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0).cast::<u8>();
            let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0);
            let mut luma = Vec::with_capacity(width * height);
            for row in 0..height {
                luma.extend_from_slice(unsafe { std::slice::from_raw_parts(base.add(row * stride), width) });
            }
            unsafe { CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags(1)) };
            out.push(luma);
        }
    }
    assert_eq!(out.len(), samples.len(), "every picture decodes");
    out
}

pub fn psnr(a: &[u8], b: &[u8]) -> f64 {
    let mse = a.iter().zip(b).map(|(&x, &y)| (f64::from(x) - f64::from(y)).powi(2)).sum::<f64>() / a.len() as f64;
    if mse == 0.0 { f64::INFINITY } else { 10.0 * (255.0f64 * 255.0 / mse).log10() }
}

/// A file's video samples with their descriptions, and its sound packets, through the test reader.
pub fn tracks(path: &Path) -> crate::mux::parse::Mp4 {
    crate::mux::parse::parse(&std::fs::read(path).unwrap()).unwrap()
}

fn samples_of(track: &crate::mux::parse::Track) -> Vec<(Vec<u8>, u32)> {
    track.samples.iter().map(|s| (s.data.clone(), s.description)).collect()
}

fn dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("recordstuff-export-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn export(source: &Path, output: &Path, removed: &[(u64, u64)], policy: JoinPolicy, codecs: &mut MacCodecs) -> ExportReport {
    let cancel = Control::new(false);
    remux::export(source, output, removed, policy, codecs, &mut |_| {}, &cancel).unwrap()
}

/// Source pictures for each output picture: the plan's parts in order.
fn kept_frames(report: &ExportReport) -> Vec<usize> {
    report.plan.parts.iter().flat_map(|p| p.first..p.end).collect()
}

#[test]
fn a_smart_cut_join_shows_the_requested_frame_and_copies_the_rest() {
    let dir = dir("smart");
    // Large enough for a level the encoder can be set to (3.1), as every real recording's is.
    let (width, height) = (1280, 720);
    let fixture = fixture(&dir.join("source.mp4"), 4, 30, width, height, None);
    let source_bytes = std::fs::read(&fixture.path).unwrap();
    let output = dir.join("out.mp4");
    // Remove 1.0 s .. 2.5 s: the part resumes at frame 75, inside the group from 60.
    let report = export(&fixture.path, &output, &[(90_000, 225_000)], JoinPolicy::Auto, &mut MacCodecs::default());
    assert_eq!(std::fs::read(&fixture.path).unwrap(), source_bytes, "the source is unchanged");
    let source = tracks(&fixture.path);
    let out = tracks(&output);
    let run = report.plan.parts[1].reencode.clone().expect("a smart cut");
    eprintln!("re-encoded {}..{} decoded from {}", 75, run.until, run.key);
    // At the source's level the re-encoded pictures' parameter sets are the source's: one description.
    assert!(!report.second_description);
    assert_eq!(out.tracks[0].descriptions, ["avc1"]);
    let avccs = vec![fixture.avcc.clone()];
    let decoded_source = decode_luma(&samples_of(&source.tracks[0]), &avccs[..1], width as usize, height as usize);
    let decoded_out = decode_luma(&samples_of(&out.tracks[0]), &avccs, width as usize, height as usize);
    let kept = kept_frames(&report);
    assert_eq!(decoded_out.len(), kept.len());
    let mut worst = f64::INFINITY;
    for (n, &frame) in kept.iter().enumerate() {
        let quality = psnr(&decoded_out[n], &decoded_source[frame]);
        if (75..run.until).contains(&frame) {
            worst = worst.min(quality);
        } else {
            assert_eq!(out.tracks[0].samples[n].data, source.tracks[0].samples[frame].data, "copied picture {frame}");
        }
    }
    eprintln!("re-encoded pictures: worst PSNR {worst:.1} dB; first {:.1} dB", psnr(&decoded_out[30], &decoded_source[75]));
    assert!(psnr(&decoded_out[30], &decoded_source[75]) >= 40.0);
    assert!(worst >= 40.0, "{worst}");
    // Frame-exact length: the kept parts, as nudged for the sound's packet grid.
    assert_eq!(out.tracks[0].duration, report.plan.duration);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_forced_key_frame_join_resumes_at_the_next_key_frame_and_drops_a_short_part() {
    let dir = dir("keyframe");
    let (width, height) = (320, 240);
    let fixture = fixture(&dir.join("source.mp4"), 4, 30, width, height, None);
    let output = dir.join("out.mp4");
    // Kept: 0..1 s, 1.5..1.8 s (no key frame: dropped), 2.5..4 s (resumes at the key frame at 3.0 s).
    let report = export(&fixture.path, &output, &[(90_000, 135_000), (162_000, 225_000)], JoinPolicy::KeyFrame, &mut MacCodecs::default());
    assert_eq!(report.plan.dropped.len(), 1);
    assert_eq!(report.plan.parts.len(), 2);
    let resumed = &report.plan.parts[1];
    assert!(resumed.fell_back);
    assert_eq!((resumed.requested, resumed.first), (75, 90));
    let source = tracks(&fixture.path);
    let out = tracks(&output);
    // Copied only: every output picture is a source picture, and none from a removed or dropped range.
    let kept = kept_frames(&report);
    assert_eq!(out.tracks[0].samples.len(), kept.len());
    for (n, &frame) in kept.iter().enumerate() {
        assert!(!(30..90).contains(&frame), "frame {frame} was removed");
        assert_eq!(out.tracks[0].samples[n].data, source.tracks[0].samples[frame].data);
    }
    assert!(out.tracks[0].samples[30].sync);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn differing_parameter_sets_decode_from_a_second_description_when_the_fixture_asks() {
    let dir = dir("second");
    let (width, height) = (320, 240);
    let fixture = fixture(&dir.join("source.mp4"), 3, 30, width, height, None);
    let output = dir.join("out.mp4");
    let mut codecs = MacCodecs { cavlc: true };
    let report = export(&fixture.path, &output, &[(30_000, 105_000)], JoinPolicy::SecondDescription, &mut codecs);
    assert!(report.second_description);
    let out = tracks(&output);
    assert_eq!(out.tracks[0].descriptions, ["avc1", "avc1"]);
    let source_bytes = std::fs::read(&fixture.path).unwrap();
    let source_avcc = source::read(&source_bytes).unwrap().video.avcc;
    let alternate = codecs.probe_avcc(&source_avcc, &source_bytes);
    assert_ne!(alternate, source_avcc);
    let decoded = decode_luma(&samples_of(&out.tracks[0]), &[source_avcc.clone(), alternate], width as usize, height as usize);
    let decoded_source = decode_luma(&samples_of(&tracks(&fixture.path).tracks[0]), &[source_avcc], width as usize, height as usize);
    let kept = kept_frames(&report);
    for (n, &frame) in kept.iter().enumerate() {
        assert!(psnr(&decoded[n], &decoded_source[frame]) >= 40.0, "picture {n} (source {frame})");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Decodes a file's whole sound track to presentation order: its edit list's skip and length applied. (Through the test
/// reader: an export with a second description is not one the export reader takes again.)
fn presented_sound(path: &Path) -> Vec<f32> {
    let parsed = tracks(path);
    let audio = &parsed.tracks[1];
    let packets: Vec<Vec<u8>> = audio.samples.iter().map(|s| s.data.clone()).collect();
    let format = remux::AudioFormat { config: vec![0x11, 0x90], sample_rate: 48_000, channels: 2 };
    let pcm = super::edit::AacDecoder::new(&format).unwrap().decode(&packets).unwrap();
    let (presented, skip) = audio.edit.unwrap();
    // The movie's timescale is the sound's here (mp4.rs), so the edit's length is in its frames.
    let skip = skip as usize * 2;
    pcm[skip..(skip + presented as usize * 2).min(pcm.len())].to_vec()
}

#[test]
fn joins_are_inaudible_on_a_tone() {
    let dir = dir("tone");
    let fixture = fixture(&dir.join("source.mp4"), 6, 30, 160, 120, None);
    let output = dir.join("out.mp4");
    // Two joins in the middle and a head cut, none on a packet boundary.
    let report = export(&fixture.path, &output, &[(0, 12_000), (100_000, 190_000), (300_000, 401_000)], JoinPolicy::Auto, &mut MacCodecs::default());
    let pcm = presented_sound(&output);
    let audio = report.plan.audio.as_ref().unwrap();
    assert_eq!(pcm.len() as u64, audio.presented * 2);
    // A 440 Hz tone at 0.5 changes by at most 0.029 between frames; a step at a join or a splice would be larger.
    let natural = 0.5 * std::f64::consts::TAU * 440.0 / 48_000.0;
    let mut worst = 0f64;
    let mut at = 0;
    for i in 1..pcm.len() / 2 {
        let step = f64::from((pcm[i * 2] - pcm[(i - 1) * 2]).abs());
        if step > worst {
            worst = step;
            at = i;
        }
    }
    let joins: Vec<u64> = audio.parts.iter().skip(1).map(|p| p.out_start).collect();
    eprintln!("largest step {worst:.4} at frame {at} (natural {natural:.4}); joins at {joins:?}; windows {:?}", audio.windows);
    assert!(worst <= natural * 1.25, "a step of {worst} at frame {at}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_av_offset_after_every_join_stays_the_source_s() {
    let dir = dir("sync");
    // A flash and a beep together every half second.
    let fixture = fixture(&dir.join("source.mp4"), 8, 30, 160, 120, Some(15));
    let output = dir.join("out.mp4");
    let report = export(&fixture.path, &output, &[(40_000, 100_000), (250_000, 412_000), (500_000, 560_000)], JoinPolicy::Auto, &mut MacCodecs::default());
    let source_bytes = std::fs::read(&fixture.path).unwrap();
    let alternate = MacCodecs::default().probe_avcc(&fixture.avcc, &source_bytes);
    let offsets = |path: &Path| -> Vec<f64> {
        let parsed = tracks(path);
        let avccs = vec![fixture.avcc.clone(), alternate.clone()];
        let luma = decode_luma(&samples_of(&parsed.tracks[0]), &avccs, 160, 120);
        let flashes: Vec<f64> = luma
            .iter()
            .enumerate()
            .filter(|(_, l)| l.iter().map(|&v| u64::from(v)).sum::<u64>() / l.len() as u64 > 200)
            .map(|(n, _)| parsed.tracks[0].samples[n].decode_time as f64 / 90_000.0)
            .collect();
        let pcm = presented_sound(path);
        // Beep onsets: the first loud frame after at least 20 ms of quiet (a join can bring two markers 70 ms apart).
        let mut beeps = Vec::new();
        let mut quiet = 48_000;
        for i in 0..pcm.len() / 2 {
            if pcm[i * 2].abs() > 0.05 {
                if quiet >= 960 {
                    beeps.push(i as f64 / 48_000.0);
                }
                quiet = 0;
            } else {
                quiet += 1;
            }
        }
        // Each flash's nearest beep within 100 ms.
        flashes.iter().filter_map(|&f| beeps.iter().map(|&b| b - f).filter(|d| d.abs() < 0.1).min_by(|a, b| a.abs().total_cmp(&b.abs()))).collect()
    };
    let before = offsets(&fixture.path);
    let after = offsets(&output);
    let (low, high) = before.iter().fold((f64::MAX, f64::MIN), |(l, h), &o| (l.min(o), h.max(o)));
    eprintln!("source offsets {low:.4}..{high:.4} s over {}; export {:?}", before.len(), after.iter().map(|o| format!("{o:.4}")).collect::<Vec<_>>());
    assert!(after.len() >= report.plan.parts.len(), "a marker after every join");
    for offset in after {
        assert!(offset >= low - 0.0015 && offset <= high + 0.0015, "offset {offset} outside the source's {low}..{high}");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Writes exports for checking players by hand or by script (D2's second-description rule): set `EXPORT_FIXTURES` to a
/// folder. A smart cut with one description, one whose re-encoded pictures carry a second, and a forced key-frame join.
#[test]
#[ignore]
fn export_fixtures_for_players() {
    let Ok(folder) = std::env::var("EXPORT_FIXTURES") else { return };
    let folder = PathBuf::from(folder);
    std::fs::create_dir_all(&folder).unwrap();
    let source = folder.join("source.mp4");
    let _ = std::fs::remove_file(&source);
    fixture(&source, 6, 30, 1280, 720, Some(15));
    // Removed 1.0 .. 2.5 s and 4.1 .. 4.6 s: both resume inside a group of pictures.
    let removed = [(90_000, 225_000), (369_000, 414_000)];
    for (name, policy, cavlc) in [
        ("smart-cut.mp4", JoinPolicy::Auto, false),
        ("two-descriptions.mp4", JoinPolicy::SecondDescription, true),
        ("key-frame.mp4", JoinPolicy::KeyFrame, false),
    ] {
        let output = folder.join(name);
        let _ = std::fs::remove_file(&output);
        let report = export(&source, &output, &removed, policy, &mut MacCodecs { cavlc });
        eprintln!(
            "{name}: {} bytes, second description {}, parts {:?}",
            report.bytes,
            report.second_description,
            report.plan.parts.iter().map(|p| (p.start, p.out_start, p.fell_back)).collect::<Vec<_>>()
        );
    }
}

/// Writes the synthetic sources `pnpm bench:export` measures (plan 085's gate) into `EXPORT_BENCH_SOURCES`, sizes in
/// `EXPORT_BENCH_SIZES` (`64m`, `2g`: 1080p30 at about 12 Mbps; `2h60`: two hours at 60 fps, the most samples). Each is
/// one second of pictures encoded by the recording's encoder (a key frame each second) and sound by its AAC encoder,
/// repeated with continuous times, in the engine's own file layout.
#[test]
#[ignore]
fn bench_sources() {
    let Ok(folder) = std::env::var("EXPORT_BENCH_SOURCES") else { return };
    let folder = PathBuf::from(folder);
    std::fs::create_dir_all(&folder).unwrap();
    for size in std::env::var("EXPORT_BENCH_SIZES").unwrap_or_else(|_| "64m".into()).split(',') {
        let (width, height, fps, bitrate, target) = match size {
            "2h60" => (640, 360, 60u32, 1_000_000, None),
            other => {
                let bytes = if let Some(g) = other.strip_suffix('g') {
                    g.parse::<u64>().unwrap() << 30
                } else {
                    other.trim_end_matches('m').parse::<u64>().unwrap() << 20
                };
                (1920, 1080, 30, 12_000_000, Some(bytes))
            }
        };
        let collect = Arc::new(Collect::default());
        let encoder = VideoEncoder::new(width, height, fps, bitrate, collect.clone()).unwrap();
        for frame in 0..fps as usize {
            encoder.encode(&picture(width, height, frame, Some(fps as usize)), frame as u64 * 1_000_000_000 / u64::from(fps), frame == 0).unwrap();
        }
        encoder.flush();
        drop(encoder);
        let media = std::mem::take(&mut *collect.0.lock().unwrap());
        let avcc = media.iter().find_map(|m| if let Media::VideoFormat { avcc, .. } = m { Some(avcc.clone()) } else { None }).unwrap();
        let second: Vec<(Vec<u8>, bool)> =
            media.into_iter().filter_map(|m| if let Media::Video { data, sync, .. } = m { Some((data, sync)) } else { None }).collect();
        assert!(second[0].1 && second[1..].iter().all(|s| !s.1), "one key frame a second");
        let second_bytes: u64 = second.iter().map(|s| s.0.len() as u64).sum();
        let seconds = target.map_or(7200, |bytes| bytes.div_ceil(second_bytes + 32_000));
        // Ten seconds of a tone, repeated: 469 packets, a whole number of them a repetition.
        let mut aac = AacEncoder::new(48_000, 2, 256_000).unwrap();
        aac.push(&sound(10 * 48_000, None));
        let mut packets = Vec::new();
        aac.drain(&mut |p| packets.push(p)).unwrap();
        let path = folder.join(format!("bench-{size}.mp4"));
        let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&path).unwrap();
        let video = TrackConfig { codec: Codec::H264 { avcc, width: width as u16, height: height as u16 }, timescale: 90_000, skip: 0 };
        let audio = TrackConfig {
            codec: Codec::Aac { config: aac.audio_specific_config(), sample_rate: 48_000, channels: 2, average_bitrate: 256_000, max_bitrate: 256_000 },
            timescale: 48_000,
            skip: aac.priming,
        };
        let mut mp4 = HybridMp4::create(file, vec![video, audio]).unwrap();
        let duration = 90_000 / fps;
        let video_samples: Vec<Sample> = second.iter().map(|(d, s)| Sample { data: d, duration, sync: *s }).collect();
        let mut written_packets = 0u64;
        for n in 0..seconds {
            mp4.write_fragment(0, &video_samples).unwrap();
            let target = ((n + 1) * 48_000 + u64::from(aac.priming)).div_ceil(1024);
            let mut chunk = Vec::new();
            while written_packets < target {
                chunk.push(&packets[(written_packets as usize) % packets.len()]);
                written_packets += 1;
            }
            let audio_samples: Vec<Sample> = chunk.iter().map(|d| Sample { data: d, duration: 1024, sync: true }).collect();
            mp4.write_fragment(1, &audio_samples).unwrap();
        }
        mp4.set_presented(1, seconds * 48_000);
        let (report, _) = mp4.finish().unwrap();
        eprintln!("{}: {} bytes, {seconds} s at {fps} fps, {} video samples", path.display(), report.bytes, seconds * u64::from(fps));
    }
}
