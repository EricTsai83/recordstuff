import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { verifyRecording } from "./verify-recording.mts";
import { LogPairs, parseCaptureLine } from "./verify.mts";

vi.mock("./media-tools.mts", async importOriginal => ({
  ...await importOriginal<typeof import("./media-tools.mts")>(),
  probe: () => ({ decodeErrors: "", info: { format: { duration: "1" }, streams: [
    { codec_type: "video", codec_name: "h264", width: 1280, height: 700, duration: "1", r_frame_rate: "30/1" },
  ] } }),
  frameTimes: () => [Array.from({ length: 30 }, (_, i) => i / 30)],
  hasTool: () => true,
}));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("passes independent source dimensions through the full verifyRecording call chain", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-source-")); dirs.push(dir);
  const file = path.join(dir, "recording.mp4"); fs.writeFileSync(file, "synthetic probe fixture");
  const pairs = new LogPairs();
  const entry = parseCaptureLine("recorder: session s capture: requested video=standard cap=1080p fps=30; track size=1280x700 fps=30 sampleRate=48000 Hz channels=2; target videoBps=8100000 audioBps=256000")!;
  pairs.claim(file, { key: "s", status: "matched", entry });
  const dimensions = (sourceSize: { width: number; height: number }) => verifyRecording(file, pairs, { sourceSize }).checks
    .find(c => c.metric === "Output dimensions");
  expect(dimensions({ width: 1280, height: 700 })?.verdict).toBe("pass");
  expect(dimensions({ width: 3840, height: 2100 })).toMatchObject({ verdict: "fail", expected: "1920x1050", actual: "1280x700" });
});
