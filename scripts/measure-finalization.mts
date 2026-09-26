#!/usr/bin/env node
/**
 * `pnpm measure:finalization -- --dir <absolute folder> [--seconds 15] [--repeat 5]
 *   [--quality economy|standard|high] [--fps 30|60] [--label name] [--keep]
 *   [--no-open-material] [--no-build]`
 *
 * Plan 037's measurement gate; macOS developer tooling, never shipped. One
 * invocation is one desktop round: build once, open the test material once,
 * then record `--repeat` takes through the development app with
 * `RECORDSTUFF_AUTORECORD`, whose `outputDir` points at `--dir` (in memory
 * only; settings.json is never written). Each take's stop-to-ready time and
 * its phases come from the app log (`finalize timing`), its media from a full
 * ffprobe decode. Files are deleted after verification unless `--keep`, so a
 * round never accumulates recordings on the volume. Evidence goes to
 * `docs/verification/measurements/<timestamp>-finalization-<label>/`.
 *
 * Use an isolated folder or disk image for slow, small or foreign file
 * systems; never fill the system disk. Exit 1 when a take failed, could not be
 * verified or outlived its bound (reported, killed or not), or cleanup left a process running; 2 when ffprobe is missing, the
 * app is already running or the desktop locked; 130/143 after SIGINT/SIGTERM.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materialOpenArgs } from "./lib/acceptance.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound, type DesktopRound } from "./lib/desktop-session.mts";
import { distribution, finalizationSample, formatDistribution, type FinalizationSample } from "./lib/finalization-timing.mts";
import { LogGapError, LogReader, type LogCursor } from "./lib/log-reader.mts";
import { hasTool, probe } from "./lib/media-tools.mts";
import { REPO_ROOT } from "./lib/verify-recording.mts";
import { parseAutorecordOutcome } from "./lib/verify.mts";

const ELECTRON_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
const ELECTRON_APP_REAL = fs.existsSync(ELECTRON_APP) ? fs.realpathSync(ELECTRON_APP) : ELECTRON_APP;
const LOG_PATH = path.join(os.homedir(), "Library/Logs/recordstuff/recordstuff.log");
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
const MATERIAL_PROFILE = path.join(os.tmpdir(), "recordstuff-material-profile");
const MEASUREMENTS_DIR = path.join(REPO_ROOT, "docs/verification/measurements");
const QUIT_GRACE_MS = 30_000;
/**
 * How long after a launch its app may still appear: `open` hands the request
 * to Launch Services, and stopping the launcher does not withdraw it.
 */
const LAUNCH_SETTLE_MS = 5_000;
/** A take's app may take this long beyond its recording to launch, stop, publish and quit. */
const TAKE_MARGIN_MS = 120_000;

interface Options {
  dir: string;
  seconds: number;
  repeat: number;
  quality: "economy" | "standard" | "high";
  fps: 30 | 60;
  label: string;
  keep: boolean;
  openMaterial: boolean;
  build: boolean;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error("usage: pnpm measure:finalization -- --dir <absolute folder> [--seconds 15] [--repeat 5] [--quality economy|standard|high] [--fps 30|60] [--label name] [--keep] [--no-open-material] [--no-build]");
  process.exit(2);
}

function parseOptions(argv: string[]): Options {
  const options: Options = { dir: "", seconds: 15, repeat: 5, quality: "standard", fps: 60, label: "", keep: false, openMaterial: true, build: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => { const next = argv[++i]; if (next === undefined) usage(`${arg} needs a value`); return next; };
    if (arg === "--dir") options.dir = value();
    else if (arg === "--seconds") options.seconds = Number(value());
    else if (arg === "--repeat") options.repeat = Number(value());
    else if (arg === "--quality") options.quality = value() as Options["quality"];
    else if (arg === "--fps") options.fps = Number(value()) as Options["fps"];
    else if (arg === "--label") options.label = value();
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--no-open-material") options.openMaterial = false;
    else if (arg === "--no-build") options.build = false;
    else usage(`unknown argument ${arg}`);
  }
  if (!path.isAbsolute(options.dir)) usage("--dir must be an absolute folder");
  if (!(options.seconds > 0 && options.seconds <= 3600)) usage("--seconds must be in (0, 3600]");
  if (!(Number.isInteger(options.repeat) && options.repeat >= 1 && options.repeat <= 50)) usage("--repeat must be 1–50");
  if (!["economy", "standard", "high"].includes(options.quality)) usage("--quality must be economy, standard or high");
  if (options.fps !== 30 && options.fps !== 60) usage("--fps must be 30 or 60");
  if (!/^[\w.-]*$/.test(options.label)) usage("--label may use letters, digits, dot, dash and underscore");
  return options;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function pgrep(pattern: string): number[] {
  return spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout
    .split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
}
const electronPids = (): number[] => pgrep(`${ELECTRON_APP_REAL}/Contents/`);

/** File system type and mount point of the volume holding `dir`, from `df` and `mount`. */
function volumeOf(dir: string): { mount: string; type: string } {
  const df = spawnSync("df", ["-P", dir], { encoding: "utf8" }).stdout.trim().split("\n").at(-1) ?? "";
  const mount = df.split(/\s+/).slice(5).join(" ");
  const line = spawnSync("mount", [], { encoding: "utf8" }).stdout.split("\n").find((entry) => entry.includes(` on ${mount} (`));
  return { mount, type: /\(([^,)]+)/.exec(line ?? "")?.[1] ?? "unknown" };
}

function freeBytes(dir: string): number {
  const stat = fs.statfsSync(dir);
  return stat.bavail * stat.bsize;
}

const owned: { desktop?: DesktopRound; launcher?: ChildProcess; launchedAt?: number; material?: ChildProcess } = {};
let interrupted = false;
const halt = (): Promise<never> => new Promise<never>(() => undefined);

/**
 * SIGTERM reaches Electron's before-quit, which stops and saves a recording in
 * progress first. A launch still in flight is waited for, so it cannot start
 * recording after cleanup.
 */
async function stopApp(): Promise<"none" | "quit" | "forced"> {
  const settled = (owned.launchedAt ?? 0) + LAUNCH_SETTLE_MS;
  while (electronPids().length === 0) {
    if (Date.now() >= settled) return "none";
    await sleep(250);
  }
  for (const pid of pgrep(`${ELECTRON_APP_REAL}/Contents/MacOS/`)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  for (const deadline = Date.now() + QUIT_GRACE_MS; Date.now() < deadline;) {
    if (electronPids().length === 0) return "quit";
    await sleep(250);
  }
  for (const pid of electronPids()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  return "forced";
}

let cleaning: Promise<string[]> | undefined;
function cleanup(): Promise<string[]> {
  cleaning ??= (async () => {
    const app = await stopApp();
    if (app === "forced") console.error(`cleanup: the app did not quit within ${QUIT_GRACE_MS / 1000} s and was killed`);
    if (owned.launcher && owned.launcher.exitCode === null) owned.launcher.kill("SIGTERM");
    // `open` returns once Launch Services started Chrome; before that, pkill could find nothing.
    const material = owned.material;
    if (material && material.exitCode === null && material.signalCode === null) {
      await Promise.race([new Promise((resolve) => material.once("exit", resolve)), sleep(10_000)]);
    }
    for (let i = 0; i < 10; i += 1) {
      if (owned.material) spawnSync("pkill", ["-f", MATERIAL_PROFILE]);
      if (electronPids().length === 0 && (!owned.material || pgrep(MATERIAL_PROFILE).length === 0)) break;
      await sleep(500);
    }
    owned.desktop?.end();
    const left: string[] = [];
    if (electronPids().length > 0) left.push(`Electron.app processes ${electronPids().join(", ")}`);
    if (owned.material && pgrep(MATERIAL_PROFILE).length > 0) left.push("the material browser");
    return left;
  })();
  return cleaning;
}

function interrupt(name: NodeJS.Signals, code: number): void {
  if (interrupted) return;
  interrupted = true;
  console.error(`${name}: stopping this round's app and material; no report is written`);
  void cleanup().then((left) => {
    if (left.length > 0) console.error(`CLEANUP INCOMPLETE: ${left.join("; ")} still running`);
    process.exit(left.length > 0 ? 1 : code);
  });
}

interface Take {
  index: number;
  outcome: "saved" | "failed" | "no outcome";
  detail?: string;
  /** The app outlived the take's bound; how it was then stopped. Always a failed take. */
  timedOut?: "quit" | "forced" | "none";
  sample?: FinalizationSample;
  sizeBytes?: number;
  media?: { durationSeconds?: number; video: boolean; audio: boolean; decodeErrors: string };
  verified: boolean;
  deleted: boolean;
  freeBeforeBytes: number;
}

const appLog = new LogReader(LOG_PATH);

function linesSince(cursor: LogCursor): string[] {
  try {
    return appLog.since(cursor).lines.map((line) => line.text);
  } catch (cause) {
    if (cause instanceof LogGapError) return [];
    throw cause;
  }
}

async function recordTake(options: Options, index: number): Promise<Take> {
  const take: Take = { index, outcome: "no outcome", verified: false, deleted: false, freeBeforeBytes: freeBytes(options.dir) };
  const cursor = appLog.end();
  const env: NodeJS.ProcessEnv = { ...process.env, RECORDSTUFF_AUTORECORD: JSON.stringify({
    seconds: options.seconds, quality: { videoQuality: options.quality, resolutionCap: "source", frameRate: options.fps }, outputDir: options.dir,
  }) };
  delete env["ELECTRON_RUN_AS_NODE"];
  owned.launchedAt = Date.now();
  const child = spawn("open", ["-W", "-a", ELECTRON_APP, "--args", REPO_ROOT], { env, stdio: "inherit" });
  owned.launcher = child;
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  const timedOut = await Promise.race([exited.then(() => false), sleep(options.seconds * 1000 + TAKE_MARGIN_MS).then(() => true)]);
  if (interrupted) await halt();
  if (timedOut) {
    take.timedOut = await stopApp();
    if (interrupted) await halt();
  }
  const lines = linesSince(cursor);
  const outcome = parseAutorecordOutcome(lines.join("\n"));
  if (outcome.failed) { take.outcome = "failed"; take.detail = outcome.failed; }
  const sample = finalizationSample(lines);
  if (sample) take.sample = sample;
  if (!outcome.saved) return take;
  take.outcome = "saved";
  try {
    take.sizeBytes = fs.statSync(outcome.saved).size;
    const { info, decodeErrors } = probe(outcome.saved);
    const duration = Number(info.format.duration);
    take.media = {
      ...(Number.isFinite(duration) ? { durationSeconds: duration } : {}),
      video: info.streams.some((s) => s.codec_type === "video" && Number(s.nb_read_frames) > 0),
      audio: info.streams.some((s) => s.codec_type === "audio"),
      decodeErrors: decodeErrors.trim(),
    };
    const expected = sample?.stoppedEarly ? undefined : options.seconds;
    take.verified = take.media.video && take.media.audio && take.media.decodeErrors === ""
      && (expected === undefined || (duration > expected - 2 && duration < expected + 2));
  } catch (cause) {
    take.detail = `verification failed: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  if (!options.keep) {
    try { fs.unlinkSync(outcome.saved); take.deleted = true; } catch { /* reported as kept */ }
  }
  return take;
}

const mb = (bytes: number | undefined): string => bytes === undefined ? "?" : (bytes / 1024 / 1024).toFixed(1);

function describeTake(take: Take): string {
  const s = take.sample;
  const phases = s ? `stop→ready ${s.stopToReadyMs} ms (host ${s.hostMs ?? "?"}, writes ${s.writesMs ?? "?"}, flush ${s.flushMs ?? "?"}, close ${s.closeMs ?? "?"}, publish ${s.publishMs ?? "?"} by ${s.method ?? "?"}, cleanup ${s.cleanupMs ?? "?"}, ui ${s.uiMs ?? "?"})` : "no stop→ready sample";
  const media = take.media ? `; ${take.media.durationSeconds?.toFixed(2) ?? "?"} s, video ${take.media.video}, audio ${take.media.audio}${take.media.decodeErrors ? `, decode errors: ${take.media.decodeErrors.slice(0, 200)}` : ""}` : "";
  const late = take.timedOut ? `; TIMED OUT, app ${take.timedOut === "forced" ? `killed after ${QUIT_GRACE_MS / 1000} s` : take.timedOut === "quit" ? "quit on SIGTERM" : "already gone"}` : "";
  return `${take.outcome}${take.detail ? ` (${take.detail})` : ""}${late}; ${mb(take.sizeBytes)} MiB${s?.stoppedEarly ? " (stopped early: low disk)" : ""}; ${phases}${media}; verified ${take.verified}`;
}

function summary(options: Options, volume: { mount: string; type: string }, takes: Take[], desktop: string): string {
  const samples = takes.flatMap((take) => take.sample ? [take.sample] : []);
  const pick = (key: keyof FinalizationSample): number[] => samples.flatMap((s) => typeof s[key] === "number" ? [s[key] as number] : []);
  const rows: Array<[string, number[]]> = [
    ["stop→ready", pick("stopToReadyMs")], ["host handoff", pick("hostMs")], ["queued writes", pick("writesMs")], ["flush", pick("flushMs")],
    ["close", pick("closeMs")], ["publish", pick("publishMs")], ["cleanup", pick("cleanupMs")], ["UI settle", pick("uiMs")],
  ];
  const methods = [...new Set(samples.map((s) => s.method ?? "?"))].join(", ") || "—";
  return [
    `# Finalization measurement — ${options.label || "unlabelled"}`,
    "",
    `- Run: ${new Date().toISOString()}; ${takes.length} take(s) of ${options.seconds} s at ${options.quality} ${options.fps} fps, source resolution`,
    `- Folder: \`${options.dir}\` on ${volume.type} (${volume.mount}); publication method ${methods}`,
    `- Machine: ${spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).stdout.trim()}, macOS ${spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim()}; commit ${spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim()}${spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim() ? " plus uncommitted changes" : ""}`,
    `- ${desktop}`,
    `- File size: ${formatDistribution(distribution(takes.flatMap((t) => t.sizeBytes === undefined ? [] : [Math.round(t.sizeBytes / 1024 / 1024)])), "MiB")}`,
    "",
    "| Phase | Distribution |",
    "| --- | --- |",
    ...rows.map(([name, values]) => `| ${name} | ${formatDistribution(distribution(values))} |`),
    "",
    "## Takes",
    "",
    ...takes.map((take) => `${take.index}. ${describeTake(take)}`),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--")));
  if (process.platform !== "darwin") { console.error("measure:finalization requires macOS"); process.exit(2); }
  if (!hasTool("ffprobe")) { console.error("BLOCKED: ffprobe is required to verify each take"); process.exit(2); }
  if (electronPids().length > 0 || pgrep("RecordStuff.app/Contents/MacOS/").length > 0) {
    console.error("RecordStuff or this project's Electron.app is running; quit it first so only this round records");
    process.exit(2);
  }
  fs.mkdirSync(options.dir, { recursive: true });
  process.on("SIGINT", () => interrupt("SIGINT", 130));
  process.on("SIGTERM", () => interrupt("SIGTERM", 143));
  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message} Nothing was recorded.`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });
  owned.desktop = desktop;
  const volume = volumeOf(options.dir);
  const report = path.join(MEASUREMENTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-finalization${options.label ? `-${options.label}` : ""}`);
  fs.mkdirSync(report, { recursive: true });
  console.log(`Finalization measurement: ${options.repeat} × ${options.seconds} s at ${options.quality} ${options.fps} fps into ${options.dir} (${volume.type}); evidence ${report}`);
  if (options.build) {
    const built = spawnSync("pnpm", ["exec", "electron-vite", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
    if (built.status !== 0) { desktop.end(); process.exit(built.status ?? 1); }
  }
  const takes: Take[] = [];
  let left: string[] = [];
  try {
    if (options.openMaterial) {
      owned.material = spawn("open", materialOpenArgs(MATERIAL, MATERIAL_PROFILE), { stdio: "ignore" });
      console.log("Opened the test material in Chrome kiosk on the primary display; waiting 5 seconds");
    } else console.log("Show representative moving content on the primary display; starting in 5 seconds");
    await sleep(5000);
    for (let i = 1; i <= options.repeat; i += 1) {
      if (interrupted) await halt();
      console.log(`▶ Take ${i}/${options.repeat}`);
      const take = await recordTake(options, i);
      takes.push(take);
      console.log(`  ${describeTake(take)}`);
    }
  } finally {
    if (interrupted) await halt();
    left = await cleanup();
    if (interrupted) await halt();
  }
  if (left.length > 0) console.error(`CLEANUP INCOMPLETE: ${left.join("; ")} still running`);
  const text = summary(options, volume, takes, desktop.summary);
  fs.writeFileSync(path.join(report, "summary.md"), text);
  fs.writeFileSync(path.join(report, "summary.json"), JSON.stringify({ options, volume, desktop: desktop.summary, takes }, null, 2));
  console.log(`\n${text}\nSummary: ${path.join(report, "summary.md")}`);
  if (desktop.lockedAt) process.exit(DESKTOP_BLOCKED_EXIT);
  process.exit(takes.every((take) => take.outcome === "saved" && take.verified && !take.timedOut) && left.length === 0 ? 0 : 1);
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  process.exit(1);
});
