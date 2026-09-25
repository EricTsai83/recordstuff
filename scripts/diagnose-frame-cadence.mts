#!/usr/bin/env node
/**
 * `pnpm diagnose:cadence -- [--rates 30,60] [--runs 2] [--seconds 30]
 *   [--request 30:30.6,60:62.4] [--ideal-only] [--load N] [--label text]
 *   [--no-open-material]`
 *
 * Plan 041's frame-cadence diagnostic; macOS developer tooling, never shipped.
 * Each run records the test material on the primary display through the
 * isolated `scripts/fixtures/frame-cadence.ts` (the production capture host
 * with renderer instrumentation) and compares three views of the same frames:
 * the timestamps the video track delivered before MediaRecorder, the track's
 * delivered/discarded counters and the file's pts. The runs alternate rates;
 * `--load N` keeps N busy processes running during each recording;
 * `--request` replaces the frame-rate constraint with `{ ideal, max }` (or
 * `{ ideal }` with `--ideal-only`) for the listed settings. Evidence goes to
 * `docs/verification/measurements/<timestamp>-frame-cadence/`. Media checks,
 * sync and bitrate stay with `pnpm matrix`; this tool only locates cadence.
 *
 * Exit 0 when every run produced its evidence and a classification, 1 when a
 * run did not or cleanup left a process behind, 2 when ffprobe is missing or
 * the desktop was locked, 130/143 after SIGINT/SIGTERM (its cleanup still
 * runs).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materialOpenArgs } from "./lib/acceptance.mts";
import { buildFixture } from "./lib/build-fixture.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound, type DesktopRound } from "./lib/desktop-session.mts";
import { cadenceStats, classifyCadence, counterDelta, type CadenceLayer, type CadenceStats, type CounterDelta } from "./lib/frame-cadence.mts";
import { frameTimes, hasTool, probe } from "./lib/media-tools.mts";
import { MEASUREMENTS_DIR, REPO_ROOT } from "./lib/verify-recording.mts";
import { FRAME_RATES, type FrameRate, type QualitySettings } from "../src/shared/quality.ts";

const ELECTRON_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
const ELECTRON_APP_REAL = fs.existsSync(ELECTRON_APP) ? fs.realpathSync(ELECTRON_APP) : ELECTRON_APP;
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
const MATERIAL_PROFILE = path.join(os.tmpdir(), "recordstuff-cadence-material-profile");
const REST_SECONDS = 5;

type Request = { ideal: number; max?: number };

interface Options {
  rates: FrameRate[];
  runs: number;
  seconds: number;
  requests: Partial<Record<FrameRate, number>>;
  idealOnly: boolean;
  load: number;
  label: string | undefined;
  openMaterial: boolean;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error("usage: pnpm diagnose:cadence -- [--rates 30,60] [--runs 2] [--seconds 30] [--request 30:30.6,60:62.4] [--ideal-only] [--load N] [--label text] [--no-open-material]");
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { rates: [30, 60], runs: 2, seconds: 30, requests: {}, idealOnly: false, load: 0, label: undefined, openMaterial: true };
  const value = (i: number): string => argv[i + 1] ?? usage(`${argv[i]} needs a value`);
  const rate = (text: string): FrameRate => {
    const n = Number(text);
    if (!(FRAME_RATES as readonly number[]).includes(n)) usage(`unsupported frame rate ${text}`);
    return n as FrameRate;
  };
  const positive = (text: string, max: number): number => {
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0 || n > max) usage(`expected a number in (0, ${max}], got ${text}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rates") { options.rates = value(i).split(",").map(rate); i += 1; }
    else if (arg === "--runs") { options.runs = Math.round(positive(value(i), 10)); i += 1; }
    else if (arg === "--seconds") { options.seconds = positive(value(i), 600); i += 1; }
    else if (arg === "--request") {
      for (const pair of value(i).split(",")) {
        const [setting, requested] = pair.split(":");
        options.requests[rate(setting ?? "")] = positive(requested ?? "", 120);
      }
      i += 1;
    } else if (arg === "--ideal-only") options.idealOnly = true;
    else if (arg === "--load") { options.load = Math.round(Number(value(i))); if (!(options.load >= 0 && options.load <= 64)) usage("--load takes 0–64"); i += 1; }
    else if (arg === "--label") { options.label = value(i); i += 1; }
    else if (arg === "--no-open-material") options.openMaterial = false;
    else usage(`unknown argument ${arg}`);
  }
  return options;
}

/** The constraint a run uses instead of the product's; null keeps the product request. */
function requestFor(options: Options, setting: FrameRate): Request | null {
  const requested = options.requests[setting];
  if (requested === undefined && !options.idealOnly) return null;
  const rate = requested ?? setting;
  return options.idealOnly ? { ideal: rate } : { ideal: rate, max: rate };
}

function electronPids(): number[] {
  const result = spawnSync("pgrep", ["-f", `${ELECTRON_APP_REAL}/Contents/`], { encoding: "utf8" });
  return result.stdout.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
}

function recordStuffRunning(): boolean {
  return spawnSync("pgrep", ["-f", "RecordStuff.app/Contents/MacOS/"], { encoding: "utf8" }).stdout.trim() !== "";
}

function cpuPercent(pids: number[]): number {
  if (pids.length === 0) return 0;
  const result = spawnSync("ps", ["-o", "%cpu=", "-p", pids.join(",")], { encoding: "utf8" });
  return result.stdout.split("\n").map((line) => Number(line.trim())).filter((n) => Number.isFinite(n)).reduce((a, b) => a + b, 0);
}

function environment(): Record<string, string | undefined> {
  const displays = spawnSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8" }).stdout ?? "";
  const main = displays.split(/\n(?=\s{8}\S)/).find((block) => /Main Display: Yes/.test(block));
  const electron = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules/electron/package.json"), "utf8")) as { version: string };
  return {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    macos: spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim() || undefined,
    cpu: spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).stdout.trim() || undefined,
    cores: String(os.cpus().length),
    electron: electron.version,
    primaryDisplay: main ? /UI Looks like:\s*(.+)/.exec(main)?.[1]?.trim() ?? /Resolution:\s*(.+)/.exec(main)?.[1]?.trim() : undefined,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything this round started, so an interruption or a timeout stops
 * exactly its own processes (review F2): the busy workers, the fixture
 * (matched by its path inside this round's directory, because `open` does not
 * make it a child), the material browser and the display assertion.
 */
const owned: { busy: Set<ChildProcess>; fixture?: string; material?: ChildProcess; desktop?: DesktopRound } = { busy: new Set() };

function stopBusy(): void {
  for (const busy of owned.busy) busy.kill("SIGKILL");
  owned.busy.clear();
}

function stopFixture(): void {
  if (owned.fixture) spawnSync("pkill", ["-f", owned.fixture]);
}

function stillRunning(): string[] {
  const left: string[] = [];
  const electron = electronPids();
  if (electron.length > 0) left.push(`Electron.app processes ${electron.join(", ")}`);
  if (owned.material && spawnSync("pgrep", ["-f", MATERIAL_PROFILE], { encoding: "utf8" }).stdout.trim() !== "") left.push("the material browser");
  return left;
}

/** Idempotent; waits up to 5 s for the owned processes to exit and returns any still running. */
async function cleanup(): Promise<string[]> {
  stopBusy();
  stopFixture();
  if (owned.material) spawnSync("pkill", ["-f", MATERIAL_PROFILE]);
  owned.desktop?.end();
  for (let i = 0; i < 10 && stillRunning().length > 0; i += 1) await sleep(500);
  return stillRunning();
}

let interrupted = false;
/**
 * After a signal the handler owns cleanup and the exit code; stopping the
 * fixture also releases `open -W`, so the round must not go on to write a
 * summary or exit first.
 */
const halt = (): Promise<never> => new Promise<never>(() => undefined);
function interrupt(signal: NodeJS.Signals, code: number): void {
  if (interrupted) return;
  interrupted = true;
  console.error(`${signal}: stopping this round's fixture, load and material; no summary is written`);
  void cleanup().then((left) => {
    if (left.length > 0) console.error(`CLEANUP INCOMPLETE: ${left.join("; ")} still running`);
    else console.error("cleanup: every owned process exited");
    process.exit(left.length > 0 ? 1 : code);
  });
}
process.on("SIGINT", () => interrupt("SIGINT", 130));
process.on("SIGTERM", () => interrupt("SIGTERM", 143));

interface FixtureResult {
  outcome: string;
  bytes: number;
  capture?: { frameRate?: number; width?: number; height?: number; videoBitsPerSecond: number; warnings: string[] };
  versions?: Record<string, string>;
  display?: { displayFrequency?: number };
  probe: {
    requests: { call: string; asked: unknown; used: unknown }[];
    frames: { timestamp: number | null; at: number }[];
    samples: { at: number; delivered?: number; discarded?: number; total?: number; frameRate?: number }[];
    recorderStart?: number;
    recorderStop?: number;
    processor: string;
    errors: string[];
  } | null;
}

interface RunReport {
  index: number;
  setting: FrameRate;
  request: Request | null;
  load: number;
  outcome: string;
  dir: string;
  error?: string;
  requests?: { call: string; asked: unknown; used: unknown }[];
  versions?: Record<string, string>;
  captureFrameRate?: number;
  displayFrequency?: number;
  settingsFrameRates?: number[];
  delivered?: CadenceStats;
  arrival?: CadenceStats;
  file?: CadenceStats;
  fileAverageFps?: number;
  trackCounters?: CounterDelta;
  cpu: { averagePercent: number; peakPercent: number };
  layer?: CadenceLayer;
  reason?: string;
}

function analyse(run: RunReport, result: FixtureResult, recording: string): void {
  const p = result.probe;
  run.outcome = result.outcome;
  if (result.capture?.frameRate !== undefined) run.captureFrameRate = result.capture.frameRate;
  if (result.display?.displayFrequency !== undefined) run.displayFrequency = result.display.displayFrequency;
  if (result.versions) run.versions = result.versions;
  if (!p) { run.error = "renderer probe missing"; return; }
  run.requests = p.requests;
  const begin = p.recorderStart ?? 0;
  const end = p.recorderStop ?? Number.POSITIVE_INFINITY;
  const during = p.frames.filter((frame) => frame.at >= begin && frame.at <= end);
  const stamped = during.map((frame) => frame.timestamp).filter((t): t is number => typeof t === "number").map((t) => t / 1e6);
  const delivered = cadenceStats(stamped, run.setting);
  if (delivered) run.delivered = delivered;
  const arrival = cadenceStats(during.map((frame) => frame.at / 1000), run.setting);
  if (arrival) run.arrival = arrival;
  const rates = [...new Set(p.samples.filter((s) => s.at >= begin).map((s) => s.frameRate).filter((r): r is number => r !== undefined).map((r) => Math.round(r * 100) / 100))];
  run.settingsFrameRates = rates;
  const counters = counterDelta(p.samples, begin, end);
  if (counters) run.trackCounters = counters;
  if (p.errors.length > 0) run.error = p.errors.join("; ");
  if (fs.existsSync(recording) && fs.statSync(recording).size > 0) {
    const [times] = frameTimes(recording, undefined);
    const file = cadenceStats(times ?? [], run.setting);
    if (file) run.file = file;
    const video = probe(recording).info.streams.find((s) => s.codec_type === "video");
    const frames = Number(video?.nb_read_frames);
    const duration = Number(video?.duration);
    if (Number.isFinite(frames) && Number.isFinite(duration) && duration > 0) run.fileAverageFps = frames / duration;
  }
  const classified = classifyCadence({
    nominalFps: run.setting, delivered: run.delivered, file: run.file,
    discardedFrames: run.trackCounters?.discarded, totalFrames: run.trackCounters?.total,
  });
  run.layer = classified.layer;
  run.reason = classified.reason;
}

async function recordOnce(run: RunReport, fixture: string, config: object, seconds: number): Promise<void> {
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(path.join(run.dir, "config.json"), JSON.stringify(config, null, 2));
  for (let i = 0; i < run.load; i += 1) owned.busy.add(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
  const env = { ...process.env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "RECORDSTUFF_AUTORECORD", "NODE_OPTIONS"]) delete env[key];
  const started = Date.now();
  const child = spawn("open", ["-W", "-n", "-a", ELECTRON_APP, "--args", fixture, run.dir], { env, stdio: "ignore" });
  let exited = false;
  child.on("exit", () => { exited = true; });
  const samples: number[] = [];
  const deadline = (seconds + 60) * 1000;
  try {
    while (!exited) {
      await sleep(1000);
      const pids = electronPids();
      if (pids.length > 0) samples.push(cpuPercent(pids));
      if (Date.now() - started > deadline) {
        run.error = `fixture still running after ${deadline / 1000} s; terminated`;
        stopFixture();
        await sleep(2000);
        break;
      }
    }
  } finally {
    stopBusy();
  }
  const recording = samples.slice(3);
  const source = recording.length > 0 ? recording : samples;
  run.cpu = {
    averagePercent: source.length > 0 ? source.reduce((a, b) => a + b, 0) / source.length : 0,
    peakPercent: source.length > 0 ? Math.max(...source) : 0,
  };
  const resultPath = path.join(run.dir, "result.json");
  if (!fs.existsSync(resultPath)) {
    run.error ??= "fixture wrote no result.json (see fixture.log)";
    return;
  }
  analyse(run, JSON.parse(fs.readFileSync(resultPath, "utf8")) as FixtureResult, path.join(run.dir, "recording.mp4"));
}

const f = (value: number | undefined, digits = 2): string => (value === undefined ? "—" : value.toFixed(digits));

function describeStats(stats: CadenceStats | undefined): string {
  if (!stats) return "—";
  return `${f(stats.averageFps)} fps; median ${f(stats.medianIntervalMs)} ms (p05 ${f(stats.p05IntervalMs)}, p95 ${f(stats.p95IntervalMs)}, min ${f(stats.minIntervalMs)}, max ${f(stats.maxIntervalMs)}); short ${stats.short}, on-period ${stats.onPeriod}, doubled ${stats.doubled} of ${stats.frames - 1}`;
}

function markdown(runs: RunReport[], env: Record<string, string | undefined>, options: Options, desktop: string): string {
  const lines = [
    `# Frame-cadence diagnostic${options.label ? ` — ${options.label}` : ""}`,
    "",
    `Environment: ${Object.entries(env).map(([k, v]) => `${k} ${v ?? "unknown"}`).join("; ")}.`,
    `Material: scripts/test-material.html${options.openMaterial ? " (Chrome kiosk, primary display)" : " (opened manually)"}; ${options.seconds} s per run; load ${options.load} busy process(es).`,
    desktop,
    "",
    "| Run | Setting | Request | Layer | Delivered (track, before MediaRecorder) | File pts | Track counters | getSettings fps | CPU avg |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...runs.map((run) => `| ${run.index} | ${run.setting} | ${run.request ? JSON.stringify(run.request) : "product"} | ${run.layer ?? "—"} | ${describeStats(run.delivered)} | ${describeStats(run.file)}; container ${f(run.fileAverageFps)} fps | ${run.trackCounters ? `delivered ${run.trackCounters.delivered ?? "?"}, discarded ${run.trackCounters.discarded ?? "?"}, total ${run.trackCounters.total ?? "?"}` : "unavailable"} | ${run.settingsFrameRates?.join(", ") || "—"} | ${f(run.cpu.averagePercent, 0)}% |`),
    "",
    ...runs.flatMap((run) => [
      `- Run ${run.index}: ${run.outcome}${run.error ? `; error: ${run.error}` : ""}. Arrival (performance.now): ${describeStats(run.arrival)}. ${run.reason ?? ""} Requests: ${JSON.stringify(run.requests ?? [])}. Evidence: ${path.basename(run.dir)}/`,
    ]),
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--")));
  if (process.platform !== "darwin") usage("the cadence diagnostic requires macOS");
  if (!hasTool("ffprobe")) { console.error("BLOCKED: ffprobe missing (brew install ffmpeg). Nothing was recorded."); process.exit(2); }
  if (electronPids().length > 0 || recordStuffRunning()) {
    console.error("RecordStuff or this project's Electron.app is running; quit it first so only the diagnostic captures");
    process.exit(1);
  }
  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message} Nothing was recorded.`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });
  owned.desktop = desktop;
  const dir = path.join(MEASUREMENTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-frame-cadence`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Frame-cadence diagnostic: rates ${options.rates.join(", ")}; ${options.runs} run(s) each; ${options.seconds} s; load ${options.load}; evidence ${dir}`);
  console.log("electron-vite build …");
  const built = spawnSync("pnpm", ["exec", "electron-vite", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  if (built.status !== 0) { desktop.end(); process.exit(built.status ?? 1); }
  const fixture = await buildFixture("frame-cadence", dir);
  owned.fixture = fixture;
  const rendererScript = await buildFixture("frame-cadence-renderer", dir);
  const preloadPath = path.join(REPO_ROOT, "out/preload/index.js");

  const runs: RunReport[] = [];
  let left: string[] = [];
  const env = environment();
  try {
    if (options.openMaterial) {
      owned.material = spawn("open", materialOpenArgs(MATERIAL, MATERIAL_PROFILE), { stdio: "ignore" });
      console.log("Opened the test material in Chrome kiosk on the primary display; waiting 5 seconds");
    } else console.log(`Open ${path.relative(REPO_ROOT, MATERIAL)} full screen on the primary display; starting in 5 seconds`);
    await sleep(5000);
    // Rates alternate so neither one always runs first or warmest.
    const order = Array.from({ length: options.runs }, () => options.rates).flat();
    for (const [i, setting] of order.entries()) {
      if (i > 0) await sleep(REST_SECONDS * 1000);
      if (interrupted) await halt();
      const request = requestFor(options, setting);
      const quality: QualitySettings = { videoQuality: "standard", resolutionCap: "source", frameRate: setting };
      const run: RunReport = {
        index: i + 1, setting, request, load: options.load, outcome: "not run",
        dir: path.join(dir, `run-${i + 1}-${setting}fps`), cpu: { averagePercent: 0, peakPercent: 0 },
      };
      console.log(`▶ Run ${run.index}: ${setting} fps, request ${request ? JSON.stringify(request) : "product"}${options.load ? `, load ${options.load}` : ""}`);
      await recordOnce(run, fixture, { seconds: options.seconds, quality, request, preloadPath, rendererScript }, options.seconds);
      if (interrupted) await halt();
      runs.push(run);
      console.log(`  ${run.outcome}${run.error ? ` (${run.error})` : ""}; layer ${run.layer ?? "—"}`);
      console.log(`  delivered: ${describeStats(run.delivered)}`);
      console.log(`  file:      ${describeStats(run.file)}; container ${f(run.fileAverageFps)} fps`);
      console.log(`  counters:  ${JSON.stringify(run.trackCounters ?? "unavailable")}; getSettings ${run.settingsFrameRates?.join(", ") || "—"}; CPU ${f(run.cpu.averagePercent, 0)}%`);
    }
  } finally {
    if (interrupted) await halt();
    left = await cleanup();
    // A signal during that wait belongs to the handler too (review pass 2).
    if (interrupted) await halt();
  }
  if (left.length > 0) console.error(`CLEANUP INCOMPLETE: ${left.join("; ")} still running`);
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ options, environment: env, desktop: desktop.summary, runs }, null, 2));
  fs.writeFileSync(path.join(dir, "summary.md"), markdown(runs, env, options, desktop.summary));
  console.log(`\nSummary: ${path.join(dir, "summary.md")}`);
  if (desktop.lockedAt) process.exit(DESKTOP_BLOCKED_EXIT);
  const complete = runs.every((run) => run.outcome === "stopped" && !run.error && run.delivered && run.file && run.layer !== "undetermined");
  process.exit(complete && left.length === 0 ? 0 : 1);
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  process.exit(1);
});
