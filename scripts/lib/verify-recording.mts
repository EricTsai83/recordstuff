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
import { readRetainedLog } from "./log-reader.mts";
import { ToolMissingError, channelRms, frameTimes, hasTool, probe, syncMarkers } from "./media-tools.mts";
import {
  LogPairs,
  formatMarkdown,
  judge,
  measure,
  overallVerdict,
  pairRecordingsWithLog,
  syncStats,
  type CaptureLogEntry,
  type Check,
  type Evidence,
  type LogPairing,
  type Measurement,
  type Verdict,
  type VerifyOptions,
} from "./verify.mts";
import type { Dimensions } from "../../src/shared/quality.ts";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MEASUREMENTS_DIR = path.join(REPO_ROOT, "docs", "verification", "measurements");

export interface VerifyRunOptions extends VerifyOptions {
  /** Detect the flash / beep markers of the test material page (needs ffmpeg, decodes the whole file). Whether they are required is `required.sync`. */
  sync?: boolean;
  cpu?: { averagePercent: number; peakPercent: number };
}

export interface VerifyResult {
  file: string;
  /** How the log metadata was found; without an entry, checks against requested settings are n/a. */
  pairing: LogPairing;
  entry: CaptureLogEntry | undefined;
  measurement: Measurement;
  checks: Check[];
  verdict: Verdict;
}

/**
 * Every retained file, archives first (src/main/log.ts rotates into
 * `.1`…`.3`): a rotation can separate a session's capture record from its
 * outcome. Throws when the named log itself does not exist.
 */
export function readLogText(logPath: string): string {
  if (!fs.existsSync(logPath)) throw new Error(`no log at ${logPath}`);
  return readRetainedLog(logPath);
}

export function readLogPairs(logPath: string | undefined): LogPairs {
  if (!logPath) return new LogPairs();
  return pairRecordingsWithLog(readLogText(logPath));
}

/**
 * One ffmpeg measurement as evidence: a missing tool is `unavailable`, any
 * other failure (nonzero exit, incomplete output) an `error` with its reason.
 */
function attempt<T>(measurement: () => T): Evidence<T> {
  try {
    return { status: "measured", value: measurement() };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { status: cause instanceof ToolMissingError ? "unavailable" : "error", reason };
  }
}

/**
 * ffprobe facts are needed for any verdict, so its failure throws; ffmpeg
 * energy and sync become evidence that the caller's `required` judges.
 */
export function verifyRecording(
  file: string,
  logPairs: LogPairs,
  options: VerifyRunOptions = {},
): VerifyResult {
  const pairing = logPairs.lookup(file);
  const entry = pairing.entry;
  const fileBytes = fs.statSync(file).size;
  const { info, decodeErrors } = probe(file);
  const parsedDuration = Number(info.format.duration);
  const duration = Number.isFinite(parsedDuration) ? parsedDuration : undefined;
  const intervals = frameTimes(file, duration);
  const ffmpegMissing: Evidence<never> | undefined = hasTool("ffmpeg") ? undefined : { status: "unavailable", reason: new ToolMissingError("ffmpeg").message };
  const extras: Parameters<typeof measure>[4] = { decodeErrors };
  const audio = info.streams.find((s) => s.codec_type === "audio");
  // Without an audio stream there is nothing for astats to read; judge reports the missing track.
  if (audio) extras.channelRms = ffmpegMissing ?? attempt(() => channelRms(file, audio.channels));
  if (options.sync) {
    extras.sync = ffmpegMissing ?? attempt(() => {
      const markers = syncMarkers(file, duration);
      return syncStats(markers.flashes, markers.beeps, duration === undefined ? {} : { durationSeconds: duration });
    });
  }
  if (options.cpu) extras.cpu = options.cpu;
  if (entry) extras.nominalFps = entry.requested.frameRate;
  const measurement = measure(file, fileBytes, info, intervals, extras);
  const judgeOptions: VerifyOptions = {};
  if (options.screen) judgeOptions.screen = options.screen;
  if (options.expectedDurationSeconds !== undefined) judgeOptions.expectedDurationSeconds = options.expectedDurationSeconds;
  if (options.required) judgeOptions.required = options.required;
  // --sync only makes sense on the test material page, which moves continuously and has sparse audio.
  if (options.movingMaterial ?? options.sync) judgeOptions.movingMaterial = true;
  if (options.testMaterial ?? options.sync) judgeOptions.testMaterial = true;
  const checks = judge(measurement, entry, judgeOptions);
  return { file, pairing, entry, measurement, checks, verdict: overallVerdict(checks) };
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
    parts.push(formatMarkdown(context.title(r, i), r.file, r.entry, r.checks, { ...sectionContext, pairing: r.pairing }));
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
      pairing: r.pairing,
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
