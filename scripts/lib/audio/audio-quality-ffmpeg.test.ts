/**
 * The detector against real encodes, in a file of its own: it spends most of its time in FFmpeg and the CLI, so it
 * runs beside the signal cases in audio-quality.test.ts instead of after them. Skipped, and said so, without the tools.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixture, wav, type AudioReport } from "./audio-quality.mts";
import { inspectAudio } from "./audio-quality-tools.mts";

const failures = (r: AudioReport): string[] => r.checks.filter(c => !c.pass).map(c => c.metric);

const ffmpegAvailable = ["ffmpeg", "ffprobe"].every(tool => spawnSync(tool, ["-version"], { stdio: "ignore" }).status === 0);
describe.skipIf(!ffmpegAvailable)("FFmpeg audio quality integration (requires ffmpeg/ffprobe)", () => {
  it("passes PCM and AAC, fails actual low-pass and mono files, and exposes CLI exit status", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-audio-test-"));
    try {
      const source = path.join(dir, "reference.wav");
      fs.writeFileSync(source, wav(fixture()));
      expect(failures(inspectAudio(source))).toEqual([]);
      const encode = (name: string, args: string[]): string => {
        const file = path.join(dir, name);
        const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", source, ...args, file]);
        expect(result.status, result.stderr.toString()).toBe(0);
        return file;
      };
      const existing = spawnSync(process.execPath, ["scripts/audio-quality.mts", "record", dir], { encoding: "utf8" });
      expect(existing.status).toBe(2);
      expect(fs.readdirSync(dir)).toEqual(["reference.wav"]);
      const overwrite = spawnSync(process.execPath, ["scripts/audio-quality.mts", "fixture", source], { encoding: "utf8" });
      expect(overwrite.status).toBe(2);
      expect(fs.readFileSync(source)).toEqual(wav(fixture()));
      const aac = encode("good.m4a", ["-c:a", "aac", "-b:a", "256k"]);
      expect(failures(inspectAudio(aac))).toEqual([]);
      const lowpass = encode("muffled.wav", ["-af", "lowpass=f=3000"]);
      expect(failures(inspectAudio(lowpass))).toContain("L 8000 Hz response (dB)");
      const mono = encode("mono.wav", ["-ac", "1"]);
      expect(failures(inspectAudio(mono))).toEqual(["Channels"]);
      const silent = encode("silent.wav", ["-af", "volume=0"]);
      const wrongRate = encode("44100.wav", ["-ar", "44100"]);
      expect(failures(inspectAudio(wrongRate))).toEqual(["Sample rate"]);
      for (const [file, status] of [[aac, 0], [lowpass, 1], [silent, 2], [path.join(dir, "missing.wav"), 2]] as const) {
        const cli = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/audio-quality.mts", "verify", file], { encoding: "utf8" });
        expect(cli.status, cli.stderr || cli.stdout).toBe(status);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
