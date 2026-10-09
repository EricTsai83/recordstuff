/**
 * Fragmented MP4s laid out as the capture host writes them, for the tests of mp4-finalize.ts and file-writer.ts.
 * Test support only: nothing in the app imports it.
 */
export const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
export const box = (type: string, ...parts: Buffer[]): Buffer => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 8), Buffer.from(type, "latin1"), body]); };
export const fullBox = (type: string, version: number, flags: number, ...parts: Buffer[]): Buffer =>
  box(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
export const zeros = (n: number): Buffer => Buffer.alloc(n);

/** A track as the capture host writes it: empty sample tables, durations 0. */
export const trak = (id: number, timescale: number, extra: Buffer[] = []): Buffer => box("trak",
  fullBox("tkhd", 0, 3, zeros(8), u32(id), zeros(4), u32(0), zeros(60)),
  ...extra,
  box("mdia", fullBox("mdhd", 0, 0, zeros(8), u32(timescale), u32(0), zeros(4)),
    box("minf", box("stbl", fullBox("stsd", 0, 0, u32(1), box("test", zeros(8))), fullBox("stts", 0, 0, u32(0)),
      fullBox("stsc", 0, 0, u32(0)), fullBox("stsz", 0, 0, u32(0), u32(0)), fullBox("stco", 0, 0, u32(0))))));
export const moov = (tracks: Buffer[] = [trak(1, 48000), trak(2, 90000)]): Buffer => box("moov",
  fullBox("mvhd", 0, 0, zeros(8), u32(1000), u32(0), zeros(80)), ...tracks,
  box("mvex", fullBox("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0x02000000)), fullBox("trex", 0, 0, u32(2), u32(1), u32(0), u32(0), u32(0x01010000))));

export interface Run { track: number; tfdt: number; samples: Array<{ duration: number; size: number; sync?: boolean }> }
/**
 * One fragment as the capture host writes it: default-base-is-moof, per-sample durations and sizes, the first
 * sample's flags, and every run's samples in one mdat after it, filled with the run's track number.
 */
export const fragment = (runs: Run[]): Buffer => {
  const trafs = (dataOffset: number): Buffer[] => {
    let at = dataOffset;
    return runs.map(run => {
      const offset = at;
      at += run.samples.reduce((sum, s) => sum + s.size, 0);
      const first = run.samples[0]?.sync ? 0x02000000 : 0x01010000;
      // Audio's samples are all sync by default, video's are not, as the capture host writes them.
      return box("traf", fullBox("tfhd", 0, 0x020020, u32(run.track), u32(run.track === 1 ? 0x02000000 : 0x01010000)),
        fullBox("tfdt", 1, 0, u32(0), u32(run.tfdt)),
        fullBox("trun", 1, 0x000305, u32(run.samples.length), u32(offset), u32(first), ...run.samples.flatMap(s => [u32(s.duration), u32(s.size)])));
    });
  };
  const sized = box("moof", fullBox("mfhd", 0, 0, u32(1)), ...trafs(0));
  const moof = box("moof", fullBox("mfhd", 0, 0, u32(1)), ...trafs(sized.length + 8));
  const media = Buffer.concat(runs.map(run => Buffer.alloc(run.samples.reduce((sum, s) => sum + s.size, 0), run.track)));
  return Buffer.concat([moof, box("mdat", media)]);
};
export const ftyp = box("ftyp", Buffer.from("isom", "latin1"), u32(0x200), Buffer.from("isomiso6", "latin1"));
export const audio = (tfdt: number, count: number): Run => ({ track: 1, tfdt, samples: Array.from({ length: count }, () => ({ duration: 1024, size: 6, sync: true })) });
export const video = (tfdt: number, durations: number[]): Run => ({ track: 2, tfdt, samples: durations.map((duration, n) => ({ duration, size: 100 + n, sync: n === 0 })) });

/** Two fragments of audio and video, the second correcting the first's last video duration by 500 ticks. */
export const sampleRecording = (): Buffer => Buffer.concat([ftyp, moov(),
  fragment([audio(0, 3), video(0, [3000, 3000, 3000])]),
  fragment([audio(3072, 2), video(9500, [3000, 3000])])]);
