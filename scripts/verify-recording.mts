#!/usr/bin/env node
/**
 * `pnpm verify -- <mp4...> [--log <path>] [--screen WxH] [--sync] [--out] [--json <path>]`
 *
 * Plan 008 §A: measure one or more recordings with ffprobe / ffmpeg, pair
 * each with its `capture:` log line, judge against the threshold table and
 * print a table. `--out` appends the result to `plans/measurements/<date>.md`
 * (+ `.json`); `--json` writes the raw results somewhere of your choosing.
 * Development only (brew install ffmpeg); nothing here ships with the app.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolMissingError } from "./lib/media-tools.mts";
import {
  appendMeasurements,
  measurementsPath,
  parseDimensions,
  readLogPairs,
  verifyRecording,
  type VerifyResult,
  type VerifyRunOptions,
} from "./lib/verify-recording.mts";
import { formatText } from "./lib/verify.mts";

const DEFAULT_LOG = path.join(os.homedir(), "Library/Logs/recordstuff/recordstuff.log");

function usage(): never {
  console.error(
    "usage: pnpm verify -- <recording.mp4> [...] [--log <recordstuff.log>] [--screen 1920x1080] [--sync] [--out] [--json <file>]",
  );
  process.exit(2);
}

// `pnpm verify -- file` forwards the `--` itself.
const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
const files: string[] = [];
let logPath: string | undefined = fs.existsSync(DEFAULT_LOG) ? DEFAULT_LOG : undefined;
let jsonPath: string | undefined;
let out = false;
const options: VerifyRunOptions = {};
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i] ?? "";
  const next = (): string => {
    const value = argv[i + 1];
    if (value === undefined) usage();
    i += 1;
    return value;
  };
  if (arg === "--log") logPath = next();
  else if (arg === "--screen") {
    const screen = parseDimensions(next());
    if (!screen) usage();
    options.screen = screen;
  } else if (arg === "--sync") options.sync = true;
  else if (arg === "--out") out = true;
  else if (arg === "--json") jsonPath = next();
  else if (arg.startsWith("--")) usage();
  else files.push(arg);
}
if (files.length === 0) usage();

let pairs;
try {
  pairs = readLogPairs(logPath);
} catch (cause) {
  console.error(`無法讀取 log ${logPath}: ${String(cause)}`);
  process.exit(2);
}
if (!logPath) console.error("沒有 log 檔（--log），要求設定與目標位元率欄位會是 —");

const results: VerifyResult[] = [];
let failed = false;
for (const file of files) {
  try {
    const result = verifyRecording(file, pairs, options);
    results.push(result);
    console.log(formatText(file, result.entry, result.checks));
    console.log();
    if (result.verdict === "fail") failed = true;
  } catch (cause) {
    failed = true;
    console.error(`${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
    if (cause instanceof ToolMissingError) break;
  }
}

if (jsonPath && results.length > 0) {
  fs.writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(`JSON → ${jsonPath}`);
}
if (out && results.length > 0) {
  const target = measurementsPath();
  appendMeasurements(target, results, { title: (r) => path.basename(r.file), runLabel: "pnpm verify" });
  console.log(`已附加到 ${path.relative(process.cwd(), target)}（與同名 .json）`);
}
process.exit(failed ? 1 : 0);
