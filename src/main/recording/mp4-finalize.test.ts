import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { FragmentIndex, MDAT_HEADER_SIZE, mdatHeader } from "./mp4-finalize";
import { audio, box, fragment, ftyp, moov, sampleRecording, trak, u32, video, zeros } from "./mp4-fixture";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-finalize-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** `file` pushed in pieces of `step` bytes, then finalized. */
const finalize = (file: Buffer, step = file.length) => {
  const index = new FragmentIndex();
  for (let at = 0; at < file.length; at += step) index.push(file.subarray(at, at + step));
  return index.finalize(file.length);
};
/** What `FileWriter` makes of `file`: the index after it and the mdat header over the old moov. */
const plain = (file: Buffer, step?: number): Buffer => {
  const result = finalize(file, step);
  if ("reason" in result) throw new Error(result.reason);
  const out = Buffer.concat([file, result.moov]);
  mdatHeader(file.length - result.mdatAt).copy(out, result.mdatAt);
  return out;
};

/** Reads a plain MP4's boxes by path, such as "moov/trak/mdia/minf/stbl/stsz", returning each match's body. */
function find(data: Buffer, route: string, from = 0, to = data.length): Buffer[] {
  const [head, ...rest] = route.split("/");
  const found: Buffer[] = [];
  for (let at = from; at + 8 <= to;) {
    let size = data.readUInt32BE(at), header = 8;
    if (size === 1) { size = Number(data.readBigUInt64BE(at + 8)); header = 16; }
    if (data.toString("latin1", at + 4, at + 8) === head)
      found.push(...(rest.length ? find(data, rest.join("/"), at + header, at + size) : [data.subarray(at + header, at + size)]));
    at += size;
  }
  return found;
}
const words = (body: Buffer, from: number): number[] => Array.from({ length: (body.length - from) / 4 }, (_, n) => body.readUInt32BE(from + n * 4));

describe("FragmentIndex", () => {
  // Video's last guess in the first fragment was 3000 ticks; the second starts 500 later, as the capture host corrects it.
  const file = sampleRecording();

  it("makes the same plain MP4 however the bytes arrive", () => {
    const whole = plain(file);
    for (const step of [1, 7, 1000]) expect(plain(file, step)).toEqual(whole);
  });

  it("turns everything from the old moov into one mdat and puts the whole index after it", () => {
    const out = plain(file);
    const moovAt = ftyp.length;
    expect(out.subarray(0, moovAt)).toEqual(ftyp);
    expect(out.readUInt32BE(moovAt)).toBe(1);
    expect(out.toString("latin1", moovAt + 4, moovAt + 8)).toBe("mdat");
    expect(Number(out.readBigUInt64BE(moovAt + 8))).toBe(file.length - moovAt);
    // Top level: ftyp, mdat, moov; the moov has no mvex left.
    expect(find(out, "mvex")).toEqual([]);
    expect(find(out, "moov/mvex")).toEqual([]);
    expect(find(out, "moov/trak")).toHaveLength(2);
  });

  it("lists every sample's size, duration, sync and place, with the next fragment's start correcting the last guess", () => {
    const out = plain(file);
    const [audioTable, videoTable] = find(out, "moov/trak/mdia/minf/stbl");
    const table = (stbl: Buffer, type: string): Buffer => find(stbl, type)[0]!;
    // Audio: five samples of 1024 ticks, all sync, so no stss.
    expect(words(table(audioTable!, "stts"), 4)).toEqual([1, 5, 1024]);
    expect(words(table(audioTable!, "stsz"), 4)).toEqual([0, 5, 6, 6, 6, 6, 6]);
    expect(find(audioTable!, "stss")).toEqual([]);
    // Video: the third sample takes the 500 ticks the next fragment starts later.
    expect(words(table(videoTable!, "stts"), 4)).toEqual([3, 2, 3000, 1, 3500, 2, 3000]);
    expect(words(table(videoTable!, "stss"), 4)).toEqual([2, 1, 4]);
    expect(words(table(videoTable!, "stsc"), 4)).toEqual([2, 1, 3, 1, 2, 2, 1]);
    // Every chunk offset points at that track's own bytes.
    for (const [stbl, track] of [[audioTable!, 1], [videoTable!, 2]] as const) {
      const offsets = words(table(stbl, "stco"), 4).slice(1);
      expect(offsets).toHaveLength(2);
      for (const offset of offsets) expect(out[offset]).toBe(track);
    }
    // Durations: mdhd in the track's ticks, tkhd and mvhd in the movie's milliseconds.
    expect(find(out, "moov/trak/mdia/mdhd").map(body => body.readUInt32BE(16))).toEqual([5 * 1024, 15500]);
    expect(find(out, "moov/trak/tkhd").map(body => body.readUInt32BE(20))).toEqual([107, 172]);
    expect(find(out, "moov/mvhd")[0]!.readUInt32BE(16)).toBe(172);
  });

  it("keeps the file fragmented for what it cannot represent or did not see whole", () => {
    const reason = (result: ReturnType<typeof finalize>): string | undefined => "reason" in result ? result.reason : undefined;
    const late = Buffer.concat([ftyp, moov(), fragment([audio(512, 2)])]);
    expect(reason(finalize(late))).toMatch(/starts at 512/);
    // The correction would leave the last sample with no duration at all.
    const back = Buffer.concat([ftyp, moov(), fragment([video(0, [3000, 3000])]), fragment([video(3000, [3000])])]);
    expect(reason(finalize(back))).toMatch(/goes back/);
    expect(reason(finalize(file.subarray(0, file.length - 3)))).toMatch(/ends inside a box/);
    const index = new FragmentIndex();
    index.push(file);
    expect(reason(index.finalize(file.length + 10))).toMatch(/were followed/);
    const edited = Buffer.concat([ftyp, moov([trak(1, 48000, [box("edts", zeros(8))]), trak(2, 90000)]), fragment([audio(0, 2)])]);
    expect(reason(finalize(edited))).toMatch(/edit list/);
    expect(reason(finalize(Buffer.from("not a movie at all, and long enough to read a header")))).toBeDefined();
    expect(reason(finalize(Buffer.concat([ftyp, fragment([audio(0, 2)])])))).toMatch(/before the moov/);
  });

  it("writes a 64-bit mdat header, so a file over 4 GiB needs no other", () => {
    expect(mdatHeader(2 ** 33)).toHaveLength(MDAT_HEADER_SIZE);
    expect(mdatHeader(2 ** 33)).toEqual(Buffer.concat([u32(1), Buffer.from("mdat", "latin1"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])]));
  });

  const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  it.skipIf(!ffmpeg)("keeps every packet of an ffmpeg-made fragmented MP4, with or without B-frames", () => {
    /**
     * Each packet's stream, decode and presentation time, size and checksum: not its duration, nor the side data
     * ffmpeg derives from its own fragmented AAC's end trimming, which the capture host does not write.
     */
    const packets = (file: string): string => spawnSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0", "-c", "copy", "-f", "framemd5", "-"])
      .stdout.toString().split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split(",").filter((_, n) => n < 6 && n !== 3).join(",")).join("\n");
    const probe = (file: string): string => spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).stdout.toString().trim();
    for (const bframes of ["0", "2"]) {
      const source = path.join(dir, `frag-bf${bframes}.mp4`);
      spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=sample_rate=48000",
        "-t", "3.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-bf", bframes, "-c:a", "aac",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof", source]);
      const result = finalize(fs.readFileSync(source), 4096);
      // An encoder delay is written as an edit list, which keeps the file as it was rather than shifting it.
      if ("reason" in result) { expect(result.reason).toMatch(/edit list/); continue; }
      const out = path.join(dir, `plain-bf${bframes}.mp4`);
      fs.writeFileSync(out, plain(fs.readFileSync(source), 4096));
      expect(packets(out)).toBe(packets(source));
      expect(probe(out)).toBe(probe(source));
    }
  });
});
