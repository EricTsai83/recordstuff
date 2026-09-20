#!/usr/bin/env node
import { materialOpenArgs } from "./lib/acceptance.mts";
/**
 * `pnpm matrix -- <all|quick|levels|fps|long> [--no-open-material] [--screen WxH] [--dry-run]`
 *
 * Defaults do the right thing: the test material page is opened full screen
 * on the main display by Chrome (kiosk, private profile) and the main
 * display's size is detected for the aspect check. `--no-open-material`
 * when you are showing the material yourself; `--screen` to override.
 *
 * build the app once, then for each entry of the matrix launch
 * Electron.app with `RECORDSTUFF_AUTORECORD` so it records unattended and
 * quits; sample the CPU of every Electron process meanwhile; verify the new
 * file (with the flash / beep sync markers) and append everything to
 * `docs/verification/measurements/<date>.md`. macOS only (`open`, `ps`, `pgrep`); nothing
 * here ships with the app. Ten seconds of rest separate the runs so thermal
 * throttling does not colour the later ones.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QualitySettings } from "../src/shared/quality.ts";
import { ToolMissingError } from "./lib/media-tools.mts";
import {
  REPO_ROOT,
  appendMeasurements,
  measurementsPath,
  parseDimensions,
  readLogPairs,
  verifyRecording,
  type VerifyResult,
} from "./lib/verify-recording.mts";
import { formatText, parseAutorecordOutcome } from "./lib/verify.mts";

interface MatrixEntry {
  name: string;
  seconds: number;
  quality: Partial<QualitySettings>;
}

/** Fixed matrices; every entry merges over DEFAULT_QUALITY inside the app, not over settings.json. */
const MATRICES: Record<string, MatrixEntry[]> = {
  quick: [
    { name: "1440p Standard", seconds: 30, quality: { resolutionCap: "1440p", videoQuality: "standard", frameRate: 30 } },
    { name: "1440p High", seconds: 30, quality: { resolutionCap: "1440p", videoQuality: "high", frameRate: 30 } },
    { name: "Source Standard", seconds: 30, quality: { resolutionCap: "source", videoQuality: "standard", frameRate: 30 } },
  ],
  levels: [
    { name: "1080p Economy", seconds: 30, quality: { resolutionCap: "1080p", videoQuality: "economy", frameRate: 30 } },
    { name: "1080p Standard (original 8 Mbps baseline)", seconds: 30, quality: { resolutionCap: "1080p", videoQuality: "standard", frameRate: 30 } },
    { name: "1080p High", seconds: 30, quality: { resolutionCap: "1080p", videoQuality: "high", frameRate: 30 } },
  ],
  fps: [
    { name: "Source Standard 30 fps", seconds: 30, quality: { resolutionCap: "source", videoQuality: "standard", frameRate: 30 } },
    { name: "Source Standard 60 fps", seconds: 30, quality: { resolutionCap: "source", videoQuality: "standard", frameRate: 60 } },
  ],
  /**
   * The formal 10-minute CPU/sync baseline was recorded once
   * on 2026-09-13 (drift 3 ms at both 3 and 10 minutes). Regression runs use
   * 3 minutes since then; the length is a user decision, not a tool limit.
   */
  long: [
    { name: "1080p Standard 30 fps 3 minutes", seconds: 180, quality: { resolutionCap: "1080p", videoQuality: "standard", frameRate: 30 } },
  ],
};

/**
 * One sitting, about 7 minutes: 15 s is enough for size / fps / drop /
 * bitrate / offset statistics (the sync window needs ≥ 3 marker pairs), the
 * 30 fps source case is covered by `quick`, and drift is measured on a
 * 3-minute segment shared with `long`.
 */
const shorten = (entries: MatrixEntry[], seconds: number): MatrixEntry[] => entries.map((e) => ({ ...e, seconds }));
MATRICES["all"] = [
  ...shorten(MATRICES["levels"]!, 15),
  ...shorten(MATRICES["fps"]!.filter((e) => e.quality.frameRate === 60), 15),
  ...shorten(MATRICES["quick"]!, 15),
  ...MATRICES["long"]!.map((e) => ({ ...e, name: `${e.name} (drift)` })),
];

const REST_SECONDS = 10;
const ELECTRON_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
/** pnpm symlinks `node_modules/electron`; process command lines show the resolved `.pnpm/…` path. */
const ELECTRON_APP_REAL = fs.existsSync(ELECTRON_APP) ? fs.realpathSync(ELECTRON_APP) : ELECTRON_APP;
const LOG_PATH = path.join(os.homedir(), "Library/Logs/recordstuff/recordstuff.log");
const SETTINGS_PATH = path.join(os.homedir(), "Library/Application Support/recordstuff/settings.json");
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
const MATERIAL_PROFILE = path.join(os.tmpdir(), "recordstuff-material-profile");

function usage(): never {
  console.error(`usage: pnpm matrix -- <${Object.keys(MATRICES).join("|")}> [--no-open-material] [--screen 1920x1080] [--dry-run]`);
  process.exit(2);
}

const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
let matrixName: string | undefined;
let openMaterial = true;
let dryRun = false;
let screen: { width: number; height: number } | undefined;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i] ?? "";
  if (arg === "--open-material") openMaterial = true;
  else if (arg === "--no-open-material") openMaterial = false;
  else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--screen") {
    screen = parseDimensions(argv[i + 1] ?? "");
    if (!screen) usage();
    i += 1;
  } else if (arg.startsWith("--")) usage();
  else matrixName = arg;
}
const matrix = matrixName ? MATRICES[matrixName] : undefined;
if (!matrixName || !matrix) usage();
screen ??= mainDisplaySize();
if (!screen) console.error("Primary display size unavailable; aspect checks may be unavailable (use --screen WxH)");
if (process.platform !== "darwin") {
  console.error("pnpm matrix currently requires macOS (open/ps/pgrep); other platforms are unverified");
  process.exit(2);
}

/**
 * Logical size of the main display (the one the app records) from
 * `system_profiler`: the block marked `Main Display: Yes`, using `UI Looks
 * like` when present (HiDPI) and `Resolution` otherwise.
 */
function mainDisplaySize(): { width: number; height: number } | undefined {
  const text = spawnSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8" }).stdout ?? "";
  const blocks = text.split(/\n(?=\s{8}\S)/);
  const main = blocks.find((block) => /Main Display: Yes/.test(block));
  if (!main) return undefined;
  const ui = /UI Looks like:\s*(\d+) x (\d+)/.exec(main) ?? /Resolution:\s*(\d+) x (\d+)/.exec(main);
  return ui ? { width: Number(ui[1]), height: Number(ui[2]) } : undefined;
}

function outputDir(): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as { outputDir?: string };
    if (parsed.outputDir) return parsed.outputDir;
  } catch {
    // no settings yet: the app uses the default
  }
  return path.join(os.homedir(), "Movies/RecordStuff");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** PIDs of every process inside this repo's Electron.app bundle (main + helpers), not the `open` launcher. */
function electronPids(): number[] {
  const result = spawnSync("pgrep", ["-f", `${ELECTRON_APP_REAL}/Contents/`], { encoding: "utf8" });
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function cpuPercent(pids: number[]): number {
  if (pids.length === 0) return 0;
  const result = spawnSync("ps", ["-o", "%cpu=", "-p", pids.join(",")], { encoding: "utf8" });
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => a + b, 0);
}


interface RunOutcome {
  /** The path from the app's `autorecord: saved` line; undefined unless the run completed. */
  file: string | undefined;
  /** The `autorecord: failed: …` reason, when the app reported one. */
  failure: string | undefined;
  cpu: { averagePercent: number; peakPercent: number };
  elapsedSeconds: number;
  timedOut: boolean;
}

interface LogPosition {
  size: number;
  /** Inode of the active file; a rotation replaces it (src/main/log.ts). */
  ino: number | undefined;
}

/** Where the log ends now; only text after this belongs to the run. */
function logPosition(): LogPosition {
  try {
    const stat = fs.statSync(LOG_PATH);
    return { size: stat.size, ino: stat.ino };
  } catch {
    return { size: 0, ino: undefined };
  }
}

function readFrom(filePath: string, offset: number): string {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.max(0, size - offset));
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * Log text written since `start`. If the logger rotated meanwhile (the
 * active file's inode changed), the run's lines are the tail of
 * `recordstuff.1.log` plus the whole new file (review pass 2).
 */
function logSince(start: LogPosition): string {
  const now = logPosition();
  if (start.ino !== undefined && now.ino !== undefined && now.ino !== start.ino) {
    const ext = path.extname(LOG_PATH);
    const rotated = `${LOG_PATH.slice(0, LOG_PATH.length - ext.length)}.1${ext}`;
    return `${readFrom(rotated, start.size)}\n${readFrom(LOG_PATH, 0)}`;
  }
  return readFrom(LOG_PATH, start.size);
}

async function recordOnce(entry: MatrixEntry): Promise<RunOutcome> {
  const logStart = logPosition();
  const env: NodeJS.ProcessEnv = { ...process.env, RECORDSTUFF_AUTORECORD: JSON.stringify({ seconds: entry.seconds, quality: entry.quality }) };
  delete env["ELECTRON_RUN_AS_NODE"];
  const started = Date.now();
  const child = spawn("open", ["-W", "-a", ELECTRON_APP, "--args", REPO_ROOT], { env, stdio: "inherit" });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const samples: number[] = [];
  const deadlineMs = (entry.seconds + 90) * 1000;
  let timedOut = false;
  while (!exited) {
    await sleep(1000);
    const pids = electronPids();
    if (pids.length > 0) samples.push(cpuPercent(pids));
    if (Date.now() - started > deadlineMs) {
      timedOut = true;
      console.error(`  Still running after ${deadlineMs / 1000} s; terminating Electron`);
      spawnSync("pkill", ["-f", `${ELECTRON_APP_REAL}/Contents/`]);
      await sleep(2000);
      break;
    }
  }
  const app = parseAutorecordOutcome(logSince(logStart));
  const cpuSamples = samples.slice(3); // the first seconds are start-up, not recording
  const source = cpuSamples.length > 0 ? cpuSamples : samples;
  return {
    file: timedOut ? undefined : app.saved,
    failure: app.failed,
    cpu: {
      averagePercent: source.length > 0 ? source.reduce((a, b) => a + b, 0) / source.length : 0,
      peakPercent: source.length > 0 ? Math.max(...source) : 0,
    },
    elapsedSeconds: (Date.now() - started) / 1000,
    timedOut,
  };
}

async function main(): Promise<void> {
  const dir = outputDir();
  console.log(`Matrix ${matrixName}: ${matrix!.length} cases; output ${dir}; log ${LOG_PATH}; primary display ${screen ? `${screen.width}x${screen.height}` : "unknown"}; material ${openMaterial ? "automatic (Chrome kiosk)" : "manual"}`);
  if (dryRun) {
    for (const entry of matrix!) console.log(`  ${entry.name}: ${entry.seconds} s ${JSON.stringify(entry.quality)}`);
    return;
  }
  if (electronPids().length > 0) {
    console.error("This project's Electron.app is running; quit it first (the single-instance lock would ignore automatic recording settings)");
    process.exit(1);
  }

  console.log("electron-vite build …");
  const build = spawnSync("pnpm", ["exec", "electron-vite", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);

  let material: ReturnType<typeof spawn> | undefined;
  if (openMaterial) {
    // A private profile makes Chrome start a new instance that honours the
    // flags even when the user's Chrome is already running. The window is
    // placed at the global origin, which is always on the main display — the
    // one the app records; without this, Chrome may pick another screen.
    material = spawn(
      "open",
      materialOpenArgs(MATERIAL, MATERIAL_PROFILE),
      { stdio: "ignore" },
    );
    console.log("Opened test material in Chrome kiosk on the primary display; waiting 5 seconds for fullscreen");
    await sleep(5000);
  } else {
    console.log(`Open ${path.relative(REPO_ROOT, MATERIAL)} fullscreen and click Start; keep volume fixed. Starting in 5 seconds.`);
    await sleep(5000);
  }

  const results: { entry: MatrixEntry; result: VerifyResult | undefined; outcome: RunOutcome; error?: string }[] = [];
  try {
    for (const [index, entry] of matrix!.entries()) {
      if (index > 0) {
        console.log(`  Rest ${REST_SECONDS} s`);
        await sleep(REST_SECONDS * 1000);
      }
      console.log(`▶ ${entry.name} (${entry.seconds} s)`);
      const outcome = await recordOnce(entry);
      if (!outcome.file) {
        const error = outcome.timedOut
          ? `Timed out (${outcome.elapsedSeconds.toFixed(0)} s); terminated${outcome.failure ? `; app reported ${outcome.failure}` : ""}`
          : outcome.failure
            ? `app reported autorecord: failed: ${outcome.failure}`
            : "app exited without an autorecord: saved log entry";
        results.push({ entry, result: undefined, outcome, error });
        console.error(`  ✗ ${error}`);
        continue;
      }
      console.log(`  File ${outcome.file}; CPU average ${outcome.cpu.averagePercent.toFixed(0)}%/peak ${outcome.cpu.peakPercent.toFixed(0)}%`);
      try {
        const options: Parameters<typeof verifyRecording>[2] = { sync: true, cpu: outcome.cpu, expectedDurationSeconds: entry.seconds };
        if (screen) options.screen = screen;
        const result = verifyRecording(outcome.file, readLogPairs(LOG_PATH), options);
        results.push({ entry, result, outcome });
        console.log(formatText(outcome.file, result.entry, result.checks));
      } catch (cause) {
        results.push({ entry, result: undefined, outcome, error: cause instanceof Error ? cause.message : String(cause) });
        console.error(`  ✗ verification failed: ${results[results.length - 1]?.error}`);
        if (cause instanceof ToolMissingError) break;
      }
    }
  } finally {
    if (material) {
      spawnSync("pkill", ["-f", MATERIAL_PROFILE]);
    }
  }

  const verified = results.filter((r) => r.result !== undefined);
  const target = measurementsPath();
  if (verified.length > 0) {
    appendMeasurements(
      target,
      verified.map((r) => r.result!),
      {
        title: (_result, i) => `${verified[i]?.entry.name ?? ""} (${verified[i]?.entry.seconds ?? 0} s)`,
        material: `scripts/test-material.html${openMaterial ? " (Chrome kiosk)" : ""}`,
        runLabel: `pnpm matrix -- ${matrixName}`,
      },
    );
    console.log(`\nAppended to ${path.relative(process.cwd(), target)} (and matching .json)`);
  }
  const failures = results.filter((r) => r.error !== undefined);
  if (failures.length > 0) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `\n## ${new Date().toISOString()} — pnpm matrix -- ${matrixName} incomplete cases\n\n${failures.map((f) => `- ${f.entry.name}: ${f.error}`).join("\n")}\n`, "utf8");
    for (const f of failures) console.error(`✗ ${f.entry.name}: ${f.error}`);
  }
  process.exit(failures.length > 0 || verified.some((r) => r.result?.verdict === "fail") ? 1 : 0);
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  process.exit(1);
});
