/**
 * `probeEdges` against real tools on a fragmented MP4 like MediaRecorder's:
 * an intact file passes, and a file cut short shows a shorter duration and
 * tail decode errors, the two signals `measure:finalization --verify quick`
 * judges without decoding every frame.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeEdges } from "./media-tools.mts";

const has = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;

describe.skipIf(!has("ffmpeg") || !has("ffprobe"))("probeEdges (requires ffmpeg/ffprobe)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-edges-"));
    const made = spawnSync("ffmpeg", [
      "-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000",
      "-t", "3", "-c:v", "mpeg4", "-g", "30", "-c:a", "aac", "-ar", "48000", "-movflags", "frag_keyframe+empty_moov", path.join(dir, "whole.mp4"),
    ], { encoding: "utf8" });
    if (made.status !== 0) throw new Error(`could not generate media: ${made.stderr}`);
    const bytes = fs.readFileSync(path.join(dir, "whole.mp4"));
    fs.writeFileSync(path.join(dir, "cut.mp4"), bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("passes an intact file with both tracks, its duration and no decode errors", () => {
    const { info, decodeErrors } = probeEdges(path.join(dir, "whole.mp4"));
    expect(Number(info.format.duration)).toBeCloseTo(3, 0);
    expect(info.streams.map((s) => s.codec_type).sort()).toEqual(["audio", "video"]);
    expect(info.streams.every((s) => s.nb_read_frames === undefined)).toBe(true);
    expect(decodeErrors).toBe("");
  });

  it("shows a file cut short by its duration and tail decode errors", () => {
    const { info, decodeErrors } = probeEdges(path.join(dir, "cut.mp4"));
    expect(Number(info.format.duration)).toBeLessThan(2.5);
    expect(decodeErrors).not.toBe("");
  });
});
