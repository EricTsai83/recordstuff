#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fixture, wav, type AudioReport } from "./lib/audio-quality.mts";
import { inspectAudio, recordAudio } from "./lib/audio-quality-tools.mts";
import { DesktopBlockedError, beginDesktopRound } from "./lib/desktop-session.mts";
import { summarize } from "./lib/audio-quality-summary.mts";

const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--"));
const [mode, target, repeatFlag, count] = args;
const repeats = count === undefined ? 1 : Number(count);
if (!mode || !target || !["fixture", "verify", "record"].includes(mode) ||
    !(args.length === 2 || (mode === "record" && args.length === 4 && repeatFlag === "--repeat")) ||
    !Number.isInteger(repeats) || repeats < 1 || repeats > 10) {
  console.error("usage: pnpm audio:quality -- fixture <new.wav> | verify <fixture-v2-recording> | record <new-directory> [--repeat 1..10]");
  process.exit(2);
}
const exitCode = (verdict: string): number => verdict === "pass" ? 0 : verdict === "invalid" ? 2 : 1;
const implementation = Object.fromEntries(["./lib/audio-quality.mts", "./lib/audio-quality-tools.mts", "../src/renderer/capture-host.ts"].map(file => [file, createHash("sha256").update(fs.readFileSync(new URL(file, import.meta.url))).digest("hex")]));
const environment = { implementation, fixtureSha256: createHash("sha256").update(wav(fixture())).digest("hex"), platform: process.platform, release: os.release(), arch: process.arch, node: process.version };
const inspect = (file: string) => ({ date: new Date().toISOString(), file, environment, ...inspectAudio(file) });
let output: string | undefined;
try {
  if (mode === "fixture") {
    fs.writeFileSync(path.resolve(target), wav(fixture()), { flag: "wx" });
    console.log(`Fixture v2 → ${path.resolve(target)}`);
  } else if (mode === "verify") {
    const report = inspect(path.resolve(target));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = exitCode(report.verdict);
  } else {
    // Capture records the primary display: keep it awake and refuse a locked session (exit 2).
    const desktop = await beginDesktopRound();
    // Assign only after mkdir succeeds: an existing evidence directory is never changed.
    const directory = path.resolve(target);
    fs.mkdirSync(directory);
    output = directory;
    const read = (tool: string, argv: string[]): string | null => {
      const r = spawnSync(tool, argv, { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
      return r.error || r.status !== 0 ? null : r.stdout.trim();
    };
    const context = () => ({ ...environment, date: new Date().toISOString(),
      audioDevices: process.platform === "darwin" ? read("system_profiler", ["SPAudioDataType", "-json"]) : null,
      volume: process.platform === "darwin" ? read("osascript", ["-e", "get volume settings"]) : null,
      ffmpeg: read("ffmpeg", ["-version"]),
      electron: JSON.parse(fs.readFileSync(new URL("../node_modules/electron/package.json", import.meta.url), "utf8")).version as string,
    });
    const before = context();
    fs.writeFileSync(path.join(output, "environment-before.json"), JSON.stringify(before, null, 2));
    const reports: AudioReport[] = [];
    for (let i = 0; i < repeats; i++) {
      const run: string = repeats === 1 ? directory : path.join(directory, `run-${i + 1}`);
      if (run !== output) fs.mkdirSync(run);
      const file = await recordAudio(run);
      const report = inspect(file);
      fs.writeFileSync(path.join(run, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
      reports.push(report);
      // Persist completed runs even if a later run fails to execute.
      fs.writeFileSync(path.join(output, "summary.json"), `${JSON.stringify({ ...summarize(reports, repeats), verdict: "incomplete" }, null, 2)}\n`);
      console.log(`Run ${i + 1}/${repeats}: ${report.verdict}; ${path.join(run, "report.json")}`);
    }
    desktop.end();
    const after = { ...context(), desktop: desktop.summary };
    fs.writeFileSync(path.join(output, "environment-after.json"), JSON.stringify(after, null, 2));
    const environmentConsistency = before.volume === null || after.volume === null || before.audioDevices === null || after.audioDevices === null
      ? "unknown" : before.volume === after.volume && before.audioDevices === after.audioDevices ? "unchanged" : "changed";
    const summary = { ...summarize(reports, repeats), environmentConsistency, desktop: desktop.summary };
    if (environmentConsistency === "changed" || desktop.lockedAt) summary.verdict = "invalid";
    fs.writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`Audio quality: ${summary.verdict}; ${summary.passed} pass, ${summary.failed} fail, ${summary.invalid} invalid`);
    process.exitCode = exitCode(summary.verdict);
  }
} catch (cause) {
  const error = `${cause instanceof DesktopBlockedError ? "BLOCKED: " : ""}${cause instanceof Error ? cause.message : String(cause)}`;
  if (output) fs.writeFileSync(path.join(output, "error.json"), `${JSON.stringify({ date: new Date().toISOString(), verdict: "error", error }, null, 2)}\n`);
  console.error(error);
  process.exitCode = 2;
}
