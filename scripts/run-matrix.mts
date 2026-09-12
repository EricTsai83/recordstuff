#!/usr/bin/env node
/**
 * `pnpm matrix -- <quick|levels|fps|long> [--open-material] [--screen WxH] [--dry-run]`
 *
 * Plan 008 §B: build the app once, then for each entry of the matrix launch
 * Electron.app with `RECORDSTUFF_AUTORECORD` so it records unattended and
 * quits; sample the CPU of every Electron process meanwhile; verify the new
 * file (with the flash / beep sync markers) and append everything to
 * `plans/measurements/<date>.md`. macOS only (`open`, `ps`, `pgrep`); nothing
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
    { name: "1440p 標準", seconds: 30, quality: { resolutionCap: "1440p", videoQuality: "standard", frameRate: 30 } },
    { name: "1440p 高品質", seconds: 30, quality: { resolutionCap: "1440p", videoQuality: "high", frameRate: 30 } },
    { name: "原尺寸 標準", seconds: 30, quality: { resolutionCap: "source", videoQuality: "standard", frameRate: 30 } },
  ],
  levels: [
    { name: "1080p 精省", seconds: 30, quality: { resolutionCap: "1080p", videoQuality: "economy", frameRate: 30 } },
    { name: "1080p 標準（原 8 Mbps 基準）", seconds: 30, quality: { resolutionCap: "1080p", videoQuality: "standard", frameRate: 30 } },
    { name: "1080p 高品質", seconds: 30, quality: { resolutionCap: "1080p", videoQuality: "high", frameRate: 30 } },
  ],
  fps: [
    { name: "原尺寸 標準 30 fps", seconds: 30, quality: { resolutionCap: "source", videoQuality: "standard", frameRate: 30 } },
    { name: "原尺寸 標準 60 fps", seconds: 30, quality: { resolutionCap: "source", videoQuality: "standard", frameRate: 60 } },
  ],
  long: [
    { name: "1080p 標準 30 fps 10 分鐘", seconds: 600, quality: { resolutionCap: "1080p", videoQuality: "standard", frameRate: 30 } },
  ],
};

const REST_SECONDS = 10;
const ELECTRON_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
/** pnpm symlinks `node_modules/electron`; process command lines show the resolved `.pnpm/…` path. */
const ELECTRON_APP_REAL = fs.existsSync(ELECTRON_APP) ? fs.realpathSync(ELECTRON_APP) : ELECTRON_APP;
const LOG_PATH = path.join(os.homedir(), "Library/Logs/recordstuff/recordstuff.log");
const SETTINGS_PATH = path.join(os.homedir(), "Library/Application Support/recordstuff/settings.json");
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
const MATERIAL_PROFILE = path.join(os.tmpdir(), "recordstuff-material-profile");

function usage(): never {
  console.error(`usage: pnpm matrix -- <${Object.keys(MATRICES).join("|")}> [--open-material] [--screen 1920x1080] [--dry-run]`);
  process.exit(2);
}

const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
let matrixName: string | undefined;
let openMaterial = false;
let dryRun = false;
let screen: { width: number; height: number } | undefined;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i] ?? "";
  if (arg === "--open-material") openMaterial = true;
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
if (process.platform !== "darwin") {
  console.error("pnpm matrix 目前只支援 macOS（open／ps／pgrep）；Windows 由 plan 005 決定啟動方式");
  process.exit(2);
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
      console.error(`  超過 ${deadlineMs / 1000} s 仍未結束，強制結束 Electron`);
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
  console.log(`矩陣 ${matrixName}：${matrix!.length} 段；輸出 ${dir}；log ${LOG_PATH}`);
  if (dryRun) {
    for (const entry of matrix!) console.log(`  ${entry.name}: ${entry.seconds} s ${JSON.stringify(entry.quality)}`);
    return;
  }
  if (electronPids().length > 0) {
    console.error("這個 repo 的 Electron.app 已在執行；先結束它（單一實例鎖會讓自動錄製設定被忽略）");
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
      [
        "-na", "Google Chrome", "--args",
        `--user-data-dir=${MATERIAL_PROFILE}`, "--kiosk", "--window-position=0,0",
        "--autoplay-policy=no-user-gesture-required", "--no-first-run", `file://${MATERIAL}?auto=1`,
      ],
      { stdio: "ignore" },
    );
    console.log("已用 Chrome kiosk 在主螢幕開啟測試素材頁；等 5 秒讓它全螢幕");
    await sleep(5000);
  } else {
    console.log(`請先把 ${path.relative(REPO_ROOT, MATERIAL)} 開到全螢幕並點一下開始（音量固定）。5 秒後開始。`);
    await sleep(5000);
  }

  const results: { entry: MatrixEntry; result: VerifyResult | undefined; outcome: RunOutcome; error?: string }[] = [];
  try {
    for (const [index, entry] of matrix!.entries()) {
      if (index > 0) {
        console.log(`  休息 ${REST_SECONDS} s`);
        await sleep(REST_SECONDS * 1000);
      }
      console.log(`▶ ${entry.name}（${entry.seconds} s）`);
      const outcome = await recordOnce(entry);
      if (!outcome.file) {
        const error = outcome.timedOut
          ? `逾時（${outcome.elapsedSeconds.toFixed(0)} s），已強制結束${outcome.failure ? `；app 回報 ${outcome.failure}` : ""}`
          : outcome.failure
            ? `app 回報 autorecord: failed: ${outcome.failure}`
            : "app 結束但 log 沒有 autorecord: saved 行";
        results.push({ entry, result: undefined, outcome, error });
        console.error(`  ✗ ${error}`);
        continue;
      }
      console.log(`  檔案 ${outcome.file}；CPU 平均 ${outcome.cpu.averagePercent.toFixed(0)}%／峰值 ${outcome.cpu.peakPercent.toFixed(0)}%`);
      try {
        const options: Parameters<typeof verifyRecording>[2] = { sync: true, cpu: outcome.cpu, expectedDurationSeconds: entry.seconds };
        if (screen) options.screen = screen;
        const result = verifyRecording(outcome.file, readLogPairs(LOG_PATH), options);
        results.push({ entry, result, outcome });
        console.log(formatText(outcome.file, result.entry, result.checks));
      } catch (cause) {
        results.push({ entry, result: undefined, outcome, error: cause instanceof Error ? cause.message : String(cause) });
        console.error(`  ✗ 驗收失敗：${results[results.length - 1]?.error}`);
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
        title: (r, i) => `${verified[i]?.entry.name ?? ""}（${verified[i]?.entry.seconds ?? 0} s）`,
        material: `scripts/test-material.html${openMaterial ? "（Chrome kiosk）" : ""}`,
        runLabel: `pnpm matrix -- ${matrixName}`,
      },
    );
    console.log(`\n已附加到 ${path.relative(process.cwd(), target)}（與同名 .json）`);
  }
  const failures = results.filter((r) => r.error !== undefined);
  if (failures.length > 0) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `\n## ${new Date().toISOString()} — pnpm matrix -- ${matrixName} 未完成的段\n\n${failures.map((f) => `- ${f.entry.name}：${f.error}`).join("\n")}\n`, "utf8");
    for (const f of failures) console.error(`✗ ${f.entry.name}: ${f.error}`);
  }
  process.exit(failures.length > 0 || verified.some((r) => r.result?.verdict === "fail") ? 1 : 0);
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  process.exit(1);
});
