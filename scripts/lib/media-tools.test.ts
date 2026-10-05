/**
 * The test material's flash box through real ffmpeg: the page sizes it in `vmin`, so the crop must land inside it on
 * a landscape and a portrait display alike (2026-10-05: on a 1080×1920 display a height-based crop found no flash).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncMarkers } from "./media-tools.mts";

const ffmpegPath = ((): string | undefined => {
  const found = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : undefined;
})();

describe.skipIf(!ffmpegPath)("sync markers through ffmpeg (requires ffmpeg)", () => {
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-markers-")); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  /** The page's box: black, 15 vmin square at the top-right corner, white for the first 100 ms of every second. */
  const clip = (width: number, height: number): string => {
    const box = Math.round(Math.min(width, height) * 0.15);
    const file = path.join(dir, `${width}x${height}.mp4`);
    const result = spawnSync(ffmpegPath!, [
      "-v", "error", "-nostdin", "-f", "lavfi", "-i", `color=c=0x202020:size=${width}x${height}:rate=30`,
      // The beeps are read from the same file; silence is enough here.
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-vf", `drawbox=x=${width - box}:y=0:w=${box}:h=${box}:color=black:t=fill,drawbox=x=${width - box}:y=0:w=${box}:h=${box}:color=white:t=fill:enable='lt(mod(t\\,1)\\,0.1)'`,
      "-t", "4.5", "-c:v", "mpeg4", "-q:v", "2", "-c:a", "aac", file,
    ], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`could not generate ${file}: ${result.stderr}`);
    return file;
  };

  it.each([[640, 360], [360, 640]])("finds one flash a second in the box of a %ix%i recording", (width, height) => {
    const { flashes } = syncMarkers(clip(width, height), 4.5);
    // Flashes at 1, 2, 3 and 4 s; the first, at 0 s, has no black before it to end.
    expect(flashes.map(time => Math.round(time))).toEqual([1, 2, 3, 4]);
  });
});
