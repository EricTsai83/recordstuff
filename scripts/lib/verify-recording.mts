/**
 * Runs one recording through the recording verification (ffprobe → measure →
 * judge) and appends the result to `docs/verification/measurements/<date>.md` plus a
 * JSON file. Shared by `pnpm verify` and `pnpm matrix`. Development only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { channelRms, frameTimes, hasTool, probe, syncMarkers } from "./media-tools.mts";
import {
  formatMarkdown,
  judge,
  measure,
  overallVerdict,
  pairRecordingsWithLog,
  syncStats,
  type CaptureLogEntry,
  type Check,
  type Measurement,
  type SyncStats,
  type Verdict,
  type VerifyOptions,
} from "./verify.mts";
import type { Dimensions } from "../../src/shared/quality.ts";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MEASUREMENTS_DIR = path.join(REPO_ROOT, "docs", "verification", "measurements");

export interface VerifyRunOptions extends VerifyOptions {
  /** Detect the flash / beep markers of the test material page (needs ffmpeg, decodes the whole file). */
  sync?: boolean;
  cpu?: { averagePercent: number; peakPercent: number };
}

export interface VerifyResult {
  file: string;
  entry: CaptureLogEntry | undefined;
  measurement: Measurement;
  checks: Check[];
  verdict: Verdict;
}

/**
 * The active log preceded by its newest rotated archive (`recordstuff.1.log`,
 * see src/main/log.ts): a rotation can separate a session's `capture:` line
 * from its `saved` line (review pass 2).
 */
export function readLogText(logPath: string): string {
  const ext = path.extname(logPath);
  const rotated = `${logPath.slice(0, logPath.length - ext.length)}.1${ext}`;
  const previous = fs.existsSync(rotated) ? fs.readFileSync(rotated, "utf8") : "";
  return `${previous}\n${fs.readFileSync(logPath, "utf8")}`;
}

export function readLogPairs(logPath: string | undefined): Map<string, CaptureLogEntry> {
  if (!logPath) return new Map();
  return pairRecordingsWithLog(readLogText(logPath));
}

export function verifyRecording(
  file: string,
  logPairs: Map<string, CaptureLogEntry>,
  options: VerifyRunOptions = {},
): VerifyResult {
  const entry = logPairs.get(path.basename(file));
  const fileBytes = fs.statSync(file).size;
  const { info, decodeErrors } = probe(file);
  const parsedDuration = Number(info.format.duration);
  const duration = Number.isFinite(parsedDuration) ? parsedDuration : undefined;
  const intervals = frameTimes(file, duration);
  const ffmpeg = hasTool("ffmpeg");
  let sync: SyncStats | undefined;
  if (options.sync && ffmpeg) {
    const markers = syncMarkers(file, duration);
    sync = syncStats(markers.flashes, markers.beeps, duration === undefined ? {} : { durationSeconds: duration });
  }
  const extras: Parameters<typeof measure>[4] = { decodeErrors, syncAttempted: Boolean(options.sync && ffmpeg) };
  if (ffmpeg) extras.channelRmsDb = channelRms(file);
  if (sync) extras.sync = sync;
  if (options.cpu) extras.cpu = options.cpu;
  if (entry) extras.nominalFps = entry.requested.frameRate;
  const measurement = measure(file, fileBytes, info, intervals, extras);
  const judgeOptions: VerifyOptions = {};
  if (options.screen) judgeOptions.screen = options.screen;
  if (options.expectedDurationSeconds !== undefined) judgeOptions.expectedDurationSeconds = options.expectedDurationSeconds;
  // --sync only makes sense on the test material page, which moves continuously.
  if (options.movingMaterial ?? options.sync) judgeOptions.movingMaterial = true;
  const checks = judge(measurement, entry, judgeOptions);
  return { file, entry, measurement, checks, verdict: overallVerdict(checks) };
}

/** `1920x1080` → dimensions. */
export function parseDimensions(text: string): Dimensions | undefined {
  const match = /^(\d+)x(\d+)$/.exec(text.trim());
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}

function tryExec(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Machine, OS, Electron and display lines for the head of a measurements file. */
export function environmentSummary(): string[] {
  const electron = (() => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules/electron/package.json"), "utf8")) as { version: string }).version;
    } catch {
      return "unknown";
    }
  })();
  const lines = [
    `- Machine: ${tryExec("sysctl", ["-n", "machdep.cpu.brand_string"]) || os.cpus()[0]?.model || "unknown"}, ${Math.round(os.totalmem() / 1024 ** 3)} GB`,
    `- OS: ${process.platform} ${os.release()}${process.platform === "darwin" ? ` (macOS ${tryExec("sw_vers", ["-productVersion"])})` : ""}`,
    `- Electron: ${electron}; Node ${process.versions.node}`,
  ];
  if (process.platform === "darwin") {
    const displays = tryExec("system_profiler", ["SPDisplaysDataType"])
      .split("\n")
      .filter((line) => /Resolution:|UI Looks like:|Main Display:/.test(line))
      .map((line) => line.trim())
      .join("; ");
    if (displays) lines.push(`- Display: ${displays}`);
  }
  const ffmpeg = tryExec("ffmpeg", ["-version"]).split("\n")[0] ?? "";
  lines.push(`- ffmpeg: ${ffmpeg || "not installed"}`);
  return lines;
}

/** Local calendar date, matching the recording file names (`2026-09-13 02-26-31.mp4`). */
export function localDate(date = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

export function measurementsPath(date = new Date()): string {
  return path.join(MEASUREMENTS_DIR, `${localDate(date)}.md`);
}

/**
 * Append one section per result. A new file starts with the environment
 * summary so the numbers can be read years later without the machine.
 */
export function appendMeasurements(
  filePath: string,
  results: VerifyResult[],
  context: { title: (r: VerifyResult, i: number) => string; material?: string; note?: string; runLabel?: string },
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const parts: string[] = [];
  if (!fs.existsSync(filePath)) {
    parts.push(`# Measurements ${path.basename(filePath, ".md")}`, "", "Generated by `pnpm verify` / `pnpm matrix`. Thresholds: docs/system-design/tooling.md. Subjective comparison is completed manually.", "", ...environmentSummary(), "");
  }
  parts.push(`## ${new Date().toISOString()}${context.runLabel ? ` — ${context.runLabel}` : ""}`, "");
  results.forEach((r, i) => {
    const sectionContext: { material?: string; note?: string } = {};
    if (context.material) sectionContext.material = context.material;
    if (context.note) sectionContext.note = context.note;
    parts.push(formatMarkdown(context.title(r, i), r.file, r.entry, r.checks, sectionContext));
  });
  fs.appendFileSync(filePath, `${parts.join("\n")}\n`, "utf8");
  const jsonPath = filePath.replace(/\.md$/, ".json");
  const existing: unknown[] = fs.existsSync(jsonPath) ? (JSON.parse(fs.readFileSync(jsonPath, "utf8")) as unknown[]) : [];
  existing.push(
    ...results.map((r, i) => ({
      recordedAt: new Date().toISOString(),
      title: context.title(r, i),
      runLabel: context.runLabel,
      file: r.file,
      requested: r.entry?.requested,
      track: r.entry?.track,
      target: r.entry ? { videoBps: r.entry.targetVideoBps, audioBps: r.entry.targetAudioBps } : undefined,
      measurement: r.measurement,
      checks: r.checks,
      verdict: r.verdict,
    })),
  );
  fs.writeFileSync(jsonPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}
