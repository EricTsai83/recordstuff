#!/usr/bin/env node
/**
 * `pnpm verify -- <mp4...> [--log <path>] [--screen WxH] [--moving] [--test-material] [--sync] [--out] [--json <path>]`
 *
 * measure one or more recordings with ffprobe / ffmpeg, pair
 * each with its session in the log (by the file's full path; by name only when
 * a single session names it), judge against the threshold table and
 * print a table. `--out` appends the result to `docs/verification/measurements/<date>.md`
 * (+ `.json`); `--json` writes the raw results somewhere of your choosing.
 * `--moving` states that the recorded content moved continuously (the test
 * material page) so frame-rate and drop checks are judged; `--test-material` says the
 * audio is the page's sparse beeps so the audio bitrate is reported, not judged;
 * `--sync` implies both.
 *
 * Channel energy is required evidence; with `--sync` so are the markers
 * (plan 030). Exit 1 when a check failed or required evidence is incomplete
 * (too few markers) or a file could not be read; 2 when a required tool is
 * missing (blocked) or for usage errors; 0 otherwise.
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
import { formatText, verdictExitCode, type Verdict } from "./lib/verify.mts";

const DEFAULT_LOG = path.join(os.homedir(), "Library/Logs/recordstuff/recordstuff.log");

function usage(): never {
  console.error(
    "usage: pnpm verify -- <recording.mp4> [...] [--log <recordstuff.log>] [--screen 1920x1080] [--moving] [--test-material] [--sync] [--out] [--json <file>]",
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
  else if (arg === "--moving") options.movingMaterial = true;
  else if (arg === "--test-material") options.testMaterial = true;
  else if (arg === "--out") out = true;
  else if (arg === "--json") jsonPath = next();
  else if (arg.startsWith("--")) usage();
  else files.push(arg);
}
if (files.length === 0) usage();
options.required = { energy: true, sync: options.sync === true };

let pairs;
try {
  pairs = readLogPairs(logPath);
} catch (cause) {
  console.error(`Cannot read log ${logPath}: ${String(cause)}`);
  process.exit(2);
}
if (!logPath) console.error("No log file (--log); requested settings and target bitrate fields will be unavailable");

const results: VerifyResult[] = [];
/** One per file; a file that could not be measured fails, a missing tool blocks the rest. */
const verdicts: Verdict[] = [];
for (const file of files) {
  try {
    const result = verifyRecording(file, pairs, options);
    results.push(result);
    verdicts.push(result.verdict);
    console.log(formatText(file, result.entry, result.checks, result.pairing));
    console.log();
  } catch (cause) {
    console.error(`${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
    if (cause instanceof ToolMissingError) {
      verdicts.push("blocked");
      break;
    }
    verdicts.push("fail");
  }
}

if (jsonPath && results.length > 0) {
  fs.writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(`JSON → ${jsonPath}`);
}
if (out && results.length > 0) {
  const target = measurementsPath();
  appendMeasurements(target, results, { title: (r) => path.basename(r.file), runLabel: "pnpm verify" });
  console.log(`Appended to ${path.relative(process.cwd(), target)} (and matching .json)`);
}
process.exit(verdictExitCode(verdicts));
