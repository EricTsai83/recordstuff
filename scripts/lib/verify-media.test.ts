/**
 * Plan 030 against real tools: generated stereo media through ffprobe/ffmpeg,
 * `verifyRecording` and the `pnpm verify` / `pnpm matrix` CLIs. Missing or
 * failing tools are simulated with a PATH of our own in a child process only;
 * the user's PATH and installed tools are untouched.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LogPairs } from "./verify.mts";
import { verifyRecording, type VerifyResult } from "./verify-recording.mts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const toolPath = (tool: string): string | undefined => {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : undefined;
};
const ffmpegPath = toolPath("ffmpeg");
const ffprobePath = toolPath("ffprobe");

describe.skipIf(!ffmpegPath || !ffprobePath)("controlled media through ffmpeg (requires ffmpeg/ffprobe)", () => {
  let dir: string;
  const file = (name: string): string => path.join(dir, name);
  const generate = (name: string, audio: string[], extra: string[] = []): void => {
    const result = spawnSync(ffmpegPath!, [
      "-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", ...audio,
      "-t", "3", "-c:v", "mpeg4", "-c:a", "aac", "-ar", "48000", ...extra, file(name),
    ], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`could not generate ${name}: ${result.stderr}`);
  };
  const tone = ["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000"];
  /** A PATH directory with ffprobe and, optionally, a fake ffmpeg script. */
  const tools = (name: string, ffmpegScript?: string): string => {
    const bin = file(name);
    fs.mkdirSync(bin);
    fs.symlinkSync(ffprobePath!, path.join(bin, "ffprobe"));
    if (ffmpegScript) fs.writeFileSync(path.join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in *-version*) echo "ffmpeg version fake"; exit 0;; esac\n${ffmpegScript}\n`, { mode: 0o755 });
    return bin;
  };
  const cli = (args: string[], PATH?: string): { status: number | null; stdout: string; stderr: string; json?: VerifyResult[] } => {
    const json = file(`result-${Math.random().toString(36).slice(2)}.json`);
    const result = spawnSync(process.execPath, [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/verify-recording.mts", ...args, "--log", file("empty.log"), "--json", json,
    ], { cwd: ROOT, encoding: "utf8", env: PATH === undefined ? process.env : { ...process.env, PATH } });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, ...(fs.existsSync(json) ? { json: JSON.parse(fs.readFileSync(json, "utf8")) as VerifyResult[] } : {}) };
  };
  const check = (result: VerifyResult, metric: string) => result.checks.find((c) => c.metric === metric);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-verify-media-"));
    fs.writeFileSync(file("empty.log"), "");
    generate("tone.mp4", [...tone, "-filter_complex", "[1:a]pan=stereo|c0=c0|c1=c0[a]", "-map", "0:v", "-map", "[a]"]);
    generate("silent.mp4", ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-map", "0:v", "-map", "1:a"]);
    generate("one-silent.mp4", [...tone, "-filter_complex", "[1:a]pan=stereo|c0=c0|c1=0*c0[a]", "-map", "0:v", "-map", "[a]"]);
    // Fragmented like MediaRecorder output, so a cut file still opens but cannot fully decode.
    generate("fragmented.mp4", [...tone, "-filter_complex", "[1:a]pan=stereo|c0=c0|c1=c0[a]", "-map", "0:v", "-map", "[a]"], ["-g", "30", "-movflags", "frag_keyframe+empty_moov+default_base_moof"]);
    const whole = fs.readFileSync(file("fragmented.mp4"));
    fs.writeFileSync(file("truncated.mp4"), whole.subarray(0, Math.floor(whole.length / 2)));
    fs.writeFileSync(file("garbage.mp4"), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251)));
  }, 60_000);
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("measures energy in both channels of a stereo tone, and fails silence and a silent channel", () => {
    const required = { required: { energy: true } };
    const good = verifyRecording(file("tone.mp4"), new LogPairs(), required);
    const energy = check(good, "Channel energy (RMS)");
    expect(energy?.verdict).toBe("pass");
    expect(good.measurement.audio?.channelRms).toMatchObject({ status: "measured", value: [expect.any(Number), expect.any(Number)] });
    expect(check(good, "Sample rate/channels")?.verdict).toBe("pass");
    expect(good.verdict).toBe("pass");
    const silent = verifyRecording(file("silent.mp4"), new LogPairs(), required);
    expect(check(silent, "Channel energy (RMS)")).toMatchObject({ verdict: "fail", actual: "−∞ / −∞", note: "channel 1 is silent; channel 2 is silent" });
    expect(check(silent, "Sample rate/channels")?.verdict).toBe("pass"); // format alone cannot vouch for energy
    expect(silent.verdict).toBe("fail");
    const oneSilent = verifyRecording(file("one-silent.mp4"), new LogPairs(), required);
    expect(check(oneSilent, "Channel energy (RMS)")?.note).toBe("channel 2 is silent");
    expect(oneSilent.verdict).toBe("fail");
  });

  it("fails a truncated recording and refuses unreadable input", () => {
    const truncated = verifyRecording(file("truncated.mp4"), new LogPairs(), { required: { energy: true } });
    expect(check(truncated, "Decodability (ffprobe full frame decode)")?.verdict).toBe("fail");
    expect(truncated.verdict).toBe("fail");
    expect(() => verifyRecording(file("garbage.mp4"), new LogPairs())).toThrow(/ffprobe exited 1/);
  });

  it("marks requested markers missing from non-material media as incomplete", () => {
    const result = verifyRecording(file("tone.mp4"), new LogPairs(), { sync: true, required: { energy: true, sync: true } });
    expect(result.measurement.sync).toMatchObject({ status: "measured", value: { flashes: 0, pairs: 0 } });
    expect(check(result, "Audio-video offset (flash/beep)")?.verdict).toBe("incomplete");
    expect(result.verdict).toBe("incomplete");
  });

  it("exits 0 for a good file, 1 for a failed or unreadable one, from the real CLI", () => {
    const good = cli([file("tone.mp4")]);
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toContain("✅ Channel energy (RMS)");
    expect(good.stdout).toContain("Result: ✅ pass");
    expect(cli([file("silent.mp4")]).status).toBe(1);
    const unreadable = cli([file("garbage.mp4")]);
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).toContain("ffprobe exited 1");
    const sync = cli([file("tone.mp4"), "--sync"]);
    expect(sync.status).toBe(1);
    expect(sync.stdout).toContain("⚠️ Audio-video offset (flash/beep)");
  });

  it("blocks required evidence when ffmpeg is missing, in an isolated PATH", () => {
    const blocked = cli([file("tone.mp4"), "--sync"], tools("bin-no-ffmpeg"));
    expect(blocked.status, blocked.stderr).toBe(2);
    expect(blocked.stdout).toContain("⛔ Channel energy (RMS)");
    expect(blocked.stdout).toContain("Result: ⛔ blocked");
    const result = blocked.json?.[0];
    expect(result?.measurement.audio?.channelRms).toEqual({ status: "unavailable", reason: "ffmpeg is missing; install it with brew install ffmpeg" });
    expect(result?.measurement.sync.status).toBe("unavailable");
    expect(check(result!, "Sample rate/channels")?.verdict).toBe("pass"); // metadata still measured independently
    // Without ffprobe nothing can be measured at all.
    const empty = file("bin-empty");
    fs.mkdirSync(empty);
    const none = cli([file("tone.mp4")], empty);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("ffprobe is missing");
  });

  it("does not accept partial RMS from an ffmpeg that failed or reported too few channels", () => {
    const partial = tools("bin-partial", [
      `echo "[Parsed_astats_0 @ 0x1] Channel: 1" >&2`,
      `echo "[Parsed_astats_0 @ 0x1] RMS level dB: -21.0" >&2`,
      `echo "[aac @ 0x2] Invalid data found when processing input" >&2`,
      "exit 1",
    ].join("\n"));
    const failed = cli([file("tone.mp4")], partial);
    expect(failed.status).toBe(1);
    const rms = failed.json?.[0]?.measurement.audio?.channelRms;
    expect(rms).toMatchObject({ status: "error", reason: expect.stringMatching(/^ffmpeg astats exited 1: .*Invalid data found when processing input$/) });
    expect(failed.stdout).toContain("❌ Channel energy (RMS)");
    const short = tools("bin-short", [
      `echo "[Parsed_astats_0 @ 0x1] Channel: 1" >&2`,
      `echo "[Parsed_astats_0 @ 0x1] RMS level dB: -21.0" >&2`,
      "exit 0",
    ].join("\n"));
    const incomplete = cli([file("tone.mp4")], short);
    expect(incomplete.status).toBe(1);
    expect(incomplete.json?.[0]?.measurement.audio?.channelRms).toMatchObject({ status: "error", reason: expect.stringContaining("reported 1 of 2 channels") });
  });

  it.skipIf(process.platform !== "darwin")("blocks the real matrix CLI before any recording when ffmpeg is missing", () => {
    // Only ffprobe on PATH: no ffmpeg, and no pgrep/open/pnpm either, so nothing past the preflight could run.
    const bin = tools("bin-matrix");
    const result = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/run-matrix.mts", "quick", "--screen", "1920x1080"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: bin }, timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("BLOCKED: ffmpeg missing (brew install ffmpeg); every case requires channel energy and sync evidence. No case was recorded.");
    expect(result.stdout).not.toContain("electron-vite build");
  });
}, 60_000);
