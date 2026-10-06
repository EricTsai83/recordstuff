import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { mp4Duration } from "./mp4-duration";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-mp4-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type: string, ...parts: Buffer[]): Buffer => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 8), Buffer.from(type, "latin1"), body]); };
const fullBox = (type: string, version: number, flags: number, ...parts: Buffer[]): Buffer =>
  box(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
const zeros = (n: number): Buffer => Buffer.alloc(n);
/** A movie with one track of `timescale`, whose fragments default to `defaultDuration` ticks (trex). */
const moov = (timescale: number, defaultDuration = 0): Buffer => box("moov",
  fullBox("mvhd", 0, 0, zeros(8), u32(1000), u32(0), zeros(80)),
  box("trak", fullBox("tkhd", 0, 3, zeros(8), u32(1), zeros(68)), box("mdia", fullBox("mdhd", 0, 0, zeros(8), u32(timescale), u32(0), zeros(4)))),
  box("mvex", fullBox("trex", 0, 0, u32(1), u32(1), u32(defaultDuration), u32(0), u32(0))));
/** A fragment starting at `base` ticks: per-sample durations in trun, or `count` samples of the default. */
const fragment = (base: number, samples: number[] | { count: number; tfhdDefault?: number }): Buffer => {
  const tfhd = Array.isArray(samples) || samples.tfhdDefault === undefined ? fullBox("tfhd", 0, 0, u32(1)) : fullBox("tfhd", 0, 0x8, u32(1), u32(samples.tfhdDefault));
  const trun = Array.isArray(samples)
    ? fullBox("trun", 0, 0x100 | 0x200, u32(samples.length), ...samples.flatMap(d => [u32(d), u32(10)]))
    : fullBox("trun", 0, 0x200, u32(samples.count), ...Array.from({ length: samples.count }, () => u32(10)));
  return Buffer.concat([box("moof", fullBox("mfhd", 0, 0, u32(1)), box("traf", tfhd, fullBox("tfdt", 1, 0, Buffer.alloc(4), u32(base)), trun)), box("mdat", zeros(64))]);
};
const write = (name: string, ...parts: Buffer[]): string => { const file = path.join(dir, name); fs.writeFileSync(file, Buffer.concat(parts)); return file; };

describe("mp4Duration", () => {
  it("ends at the last fragment's start plus its samples, from per-sample, tfhd or trex durations", async () => {
    expect(await mp4Duration(write("samples.mp4", box("ftyp", zeros(8)), moov(90000), fragment(0, [3000, 3000]), fragment(90000, [3000, 3000, 3000])))).toBeCloseTo(1.1);
    expect(await mp4Duration(write("tfhd.mp4", moov(1000), fragment(0, { count: 30, tfhdDefault: 40 }), fragment(1200, { count: 30, tfhdDefault: 40 })))).toBeCloseTo(2.4);
    expect(await mp4Duration(write("trex.mp4", moov(48000, 1024), fragment(0, { count: 47 })))).toBeCloseTo(47 * 1024 / 48000);
  });
  it("keeps the last complete fragment of a file cut short, and says nothing for what is not an MP4", async () => {
    const head = Buffer.concat([moov(1000), fragment(0, { count: 10, tfhdDefault: 100 })]);
    // Cut inside the second fragment's moof: the first is the last one complete.
    expect(await mp4Duration(write("cut.mp4", head, fragment(1000, { count: 10, tfhdDefault: 100 }).subarray(0, 30)))).toBeCloseTo(1);
    expect(await mp4Duration(write("text.mp4", Buffer.from("not a movie at all")))).toBeUndefined();
    // A 64-bit movie header whose length is all ones says "unknown", not 1.8e19 / timescale seconds (review pass 1, F5).
    const unknown = box("moov", fullBox("mvhd", 1, 0, zeros(16), u32(1000), Buffer.alloc(8, 0xff), zeros(80)));
    expect(await mp4Duration(write("unknown64.mp4", unknown))).toBeUndefined();
    const known = box("moov", fullBox("mvhd", 1, 0, zeros(16), u32(1000), Buffer.from([0, 0, 0, 0, 0, 0, 0x0b, 0xb8]), zeros(80)));
    expect(await mp4Duration(write("known64.mp4", known))).toBe(3);
    expect(await mp4Duration(write("empty.mp4"))).toBeUndefined();
    expect(await mp4Duration(path.join(dir, "missing.mp4"))).toBeUndefined();
  });
  const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  it.skipIf(!ffmpeg)("matches ffprobe on a fragmented MP4 like the capture host's, and on a plain one", async () => {
    const make = (name: string, movflags: string[]): string => {
      const file = path.join(dir, name);
      spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=sample_rate=48000",
        "-t", "3.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", ...movflags, file]);
      return file;
    };
    const probe = (file: string): number => Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).stdout.toString());
    for (const file of [make("frag.mp4", ["-movflags", "frag_keyframe+empty_moov+default_base_moof"]), make("plain.mp4", [])])
      expect(await mp4Duration(file)).toBeCloseTo(probe(file), 2);
  });
});
