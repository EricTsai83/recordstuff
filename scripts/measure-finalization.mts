#!/usr/bin/env node
/**
 * `pnpm measure:finalization -- --dir <absolute folder> [--seconds 15] [--repeat 5]
 *   [--quality economy|standard|high] [--fps 30|60] [--label name] [--keep]
 *   [--verify quick|full] [--no-open-material] [--no-build]`
 *
 * Plan 037's measurement gate; macOS developer tooling, never shipped. One
 * invocation is one desktop round: build once, open the test material once,
 * then record `--repeat` takes through the development app with
 * `RECORDSTUFF_AUTORECORD`, whose `outputDir` points at `--dir` (in memory
 * only; settings.json is never written). Each take's stop-to-ready time and
 * its phases come from the app log (`finalize timing`), its media from
 * ffprobe: `--verify quick` (default) fully decodes the first saved take and
 * checks the rest's streams, duration and first and last second, `full`
 * decodes every take. Files are deleted after verification unless `--keep`, so a
 * round never accumulates recordings on the volume. Evidence goes to
 * `docs/verification/measurements/<timestamp>-finalization-<label>/`.
 *
 * Use an isolated folder or disk image for slow, small or foreign file
 * systems; never fill the system disk. Exit 1 when a take failed, could not be
 * verified or outlived its bound (reported, killed or not), or cleanup left a process running; 2 when ffprobe is missing, the
 * app is already running or the desktop locked; 130/143 after SIGINT/SIGTERM,
 * also during the build, which runs in its own process group so the handler
 * can stop it.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { MEASUREMENTS_DIR } from "./lib/verification/verify-recording.mts";
import { APP_LOG_PATH, scrubbedEnv, runnerArgs } from "./lib/runner/runner-env.mts";
import fs from "node:fs";
import path from "node:path";
import { createMaterialProfile, materialOpenArgs, removeMaterialProfile } from "./lib/acceptance/acceptance.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound, type DesktopRound } from "./lib/runner/desktop-session.mts";
import { LAUNCHER_EXIT_MS, QUIT_GRACE_MS, stopDevApp, type AppStop } from "./lib/runner/dev-app.mts";
import { distribution, finalizationSample, formatDistribution, type FinalizationSample } from "./lib/verification/finalization-timing.mts";
import { LogReader } from "./lib/runner/log-reader.mts";
import { electronPattern, escapeRegExp, groupAlive, interruptExitCode, pgrepPids, recordStuffPids, signalPids, startBuild, stopGroup } from "./lib/runner/processes.mts";
import { freeBytes, volumeOf } from "./lib/verification/volume.mts";
import { hasTool, probe, probeEdges, requireMediaTimeout } from "./lib/verification/media-tools.mts";
import { REPO_ROOT } from "./lib/verification/verify-recording.mts";
import { parseAutorecordOutcome } from "./lib/verification/verify.mts";

const ELECTRON_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
const ELECTRON_APP_REAL = fs.existsSync(ELECTRON_APP) ? fs.realpathSync(ELECTRON_APP) : ELECTRON_APP;
const LOG_PATH = APP_LOG_PATH;
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
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
  /** `quick` decodes every frame of the first saved take only; the timings never depend on it. */
  verify: "quick" | "full";
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error("usage: pnpm measure:finalization -- --dir <absolute folder> [--seconds 15] [--repeat 5] [--quality economy|standard|high] [--fps 30|60] [--label name] [--keep] [--verify quick|full] [--no-open-material] [--no-build]");
  process.exit(2);
}

function parseOptions(argv: string[]): Options {
  const options: Options = { dir: "", seconds: 15, repeat: 5, quality: "standard", fps: 60, label: "", keep: false, openMaterial: true, build: true, verify: "quick" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => { const next = argv[++i]; if (next === undefined || next.startsWith("--")) usage(`${arg} needs a value`); return next; };
    if (arg === "--dir") options.dir = value();
    else if (arg === "--seconds") options.seconds = Number(value());
    else if (arg === "--repeat") options.repeat = Number(value());
    else if (arg === "--quality") options.quality = value() as Options["quality"];
    else if (arg === "--fps") options.fps = Number(value()) as Options["fps"];
    else if (arg === "--label") options.label = value();
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--no-open-material") options.openMaterial = false;
    else if (arg === "--no-build") options.build = false;
    else if (arg === "--verify") options.verify = value() as Options["verify"];
    else usage(`unknown argument ${arg}`);
  }
  if (!path.isAbsolute(options.dir)) usage("--dir must be an absolute folder");
  if (!(options.seconds > 0 && options.seconds <= 3600)) usage("--seconds must be in (0, 3600]");
  if (!(Number.isInteger(options.repeat) && options.repeat >= 1 && options.repeat <= 50)) usage("--repeat must be 1–50");
  if (!["economy", "standard", "high"].includes(options.quality)) usage("--quality must be economy, standard or high");
  if (options.fps !== 30 && options.fps !== 60) usage("--fps must be 30 or 60");
  if (options.verify !== "quick" && options.verify !== "full") usage("--verify must be quick or full");
  if (!/^[\w.-]*$/.test(options.label)) usage("--label may use letters, digits, dot, dash and underscore");
  return options;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every process inside this checkout's Electron.app bundle (main + helpers), not the `open` launcher. */
const electronPids = (): number[] => pgrepPids(electronPattern(ELECTRON_APP_REAL, "bundle"));

/**
 * What this round started: the build (its own process group), the take's
 * `open -W` launcher and the material browser with the private profile
 * created for it, which cleanup removes.
 */
const owned: { desktop?: DesktopRound; build?: ChildProcess; launcher?: ChildProcess; launchedAt?: number; material?: ChildProcess; materialProfile?: string } = {};
const materialPids = (): number[] => owned.materialProfile ? pgrepPids(escapeRegExp(owned.materialProfile)) : [];
let interrupted = false;
const halt = (): Promise<never> => new Promise<never>(() => undefined);

/** Stops a take's app through its normal quit (see `stopDevApp`). */
const stopApp = (): Promise<AppStop> => stopDevApp(ELECTRON_APP_REAL, owned.launchedAt === undefined ? {} : { launchedAt: owned.launchedAt });

let cleaning: Promise<string[]> | undefined;
/** Idempotent; rejects when `pgrep` fails, because nothing then proves the round's processes exited. */
function cleanup(): Promise<string[]> {
  cleaning ??= (async () => {
    await stopGroup(owned.build?.pid);
    const app = await stopApp();
    if (app === "forced") console.error(`cleanup: the app did not quit within ${QUIT_GRACE_MS / 1000} s and was killed`);
    if (owned.launcher && owned.launcher.exitCode === null) owned.launcher.kill("SIGTERM");
    // `open` returns once Launch Services started Chrome; before that, pkill could find nothing.
    const material = owned.material;
    if (material && material.exitCode === null && material.signalCode === null) {
      await Promise.race([new Promise((resolve) => material.once("exit", resolve)), sleep(10_000)]);
    }
    for (let i = 0; i < 10; i += 1) {
      signalPids(materialPids(), "SIGTERM");
      if (electronPids().length === 0 && materialPids().length === 0) break;
      await sleep(500);
    }
    owned.desktop?.end();
    const left: string[] = [];
    if (groupAlive(owned.build?.pid)) left.push("the build");
    const electron = electronPids();
    if (electron.length > 0) left.push(`Electron.app processes ${electron.join(", ")}`);
    if (materialPids().length > 0) left.push("the material browser");
    // A launch that never settled may still start Chrome and recreate the profile.
    else if (material && material.exitCode === null && material.signalCode === null) left.push("the material launch (`open`), which may still start Chrome");
    else if (owned.materialProfile) {
      const problem = await removeMaterialProfile(owned.materialProfile);
      if (problem) left.push(problem);
      else delete owned.materialProfile;
    }
    return left;
  })();
  return cleaning;
}

function interrupt(name: "SIGINT" | "SIGTERM"): void {
  if (interrupted) return;
  interrupted = true;
  console.error(`${name}: stopping this round's build, app and material; no report is written`);
  void interruptExitCode(name, cleanup).then((exit) => process.exit(exit));
}

interface Take {
  index: number;
  outcome: "saved" | "failed" | "no outcome";
  detail?: string;
  /** The app outlived the take's bound; how it was then stopped. Always a failed take. */
  timedOut?: AppStop;
  sample?: FinalizationSample;
  /** Partial `.recording.mp4` files a take that saved nothing left in `--dir`, removed unless `--keep`. */
  partials?: { files: string[]; removed: boolean };
  sizeBytes?: number;
  media?: { durationSeconds?: number; video: boolean; audio: boolean; decodeErrors: string; decoded: "all frames" | "first and last second" };
  verified: boolean;
  deleted: boolean;
  freeBeforeBytes: number;
}

const appLog = new LogReader(LOG_PATH);
/** In quick mode, only the first saved take is decoded frame by frame. */
let fullyDecoded = false;


async function recordTake(options: Options, index: number): Promise<Take> {
  const take: Take = { index, outcome: "no outcome", verified: false, deleted: false, freeBeforeBytes: freeBytes(options.dir) };
  const cursor = appLog.end();
  const env: NodeJS.ProcessEnv = { ...scrubbedEnv(), RECORDSTUFF_AUTORECORD: JSON.stringify({
    seconds: options.seconds, quality: { videoQuality: options.quality, resolutionCap: "source", frameRate: options.fps }, outputDir: options.dir,
  }) };
  owned.launchedAt = Date.now();
  const child = spawn("open", ["-W", "-a", ELECTRON_APP, "--args", REPO_ROOT], { env, stdio: "inherit" });
  owned.launcher = child;
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  const timedOut = await Promise.race([exited.then(() => false), sleep(options.seconds * 1000 + TAKE_MARGIN_MS).then(() => true)]);
  if (interrupted) await halt();
  if (timedOut) {
    take.timedOut = await stopApp();
    // The next take's `open` must launch a new app, not bring this one forward.
    await Promise.race([exited, sleep(LAUNCHER_EXIT_MS)]);
    if (interrupted) await halt();
  }
  const { lines, gap } = appLog.textSince(cursor);
  if (gap) take.detail = `log evidence gap: ${gap}`;
  const outcome = parseAutorecordOutcome(lines.join("\n"));
  if (outcome.failed) { take.outcome = "failed"; take.detail = outcome.failed; }
  const sample = finalizationSample(lines);
  if (sample) take.sample = sample;
  if (!outcome.saved) {
    // A failed or killed take keeps its partial file (FileWriter.abandon); without this they would pile up on the volume.
    const partials = partialsSince(options.dir, owned.launchedAt);
    if (partials.length) {
      if (!options.keep) for (const file of partials) fs.rmSync(file, { force: true });
      take.partials = { files: partials, removed: !options.keep };
    }
    return take;
  }
  take.outcome = "saved";
  try {
    take.sizeBytes = fs.statSync(outcome.saved).size;
    const full = options.verify === "full" || !fullyDecoded;
    const { info, decodeErrors } = full ? probe(outcome.saved) : probeEdges(outcome.saved);
    fullyDecoded = true;
    const duration = Number(info.format.duration);
    take.media = {
      ...(Number.isFinite(duration) ? { durationSeconds: duration } : {}),
      // Edges leave nb_read_frames unset; their decode proved frames exist.
      video: info.streams.some((s) => s.codec_type === "video" && (full ? Number(s.nb_read_frames) > 0 : Number(s.width) > 0)),
      audio: info.streams.some((s) => s.codec_type === "audio"),
      decodeErrors: decodeErrors.trim(),
      decoded: full ? "all frames" : "first and last second",
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
  // A save that could not remove its temporary name (the writer's `cleanupError`) leaves it beside the file, a full
  // copy after a copy publication: it goes with the take, or long takes would pile up on the volume.
  const leftovers = partialsSince(options.dir, owned.launchedAt);
  if (leftovers.length) {
    if (!options.keep) for (const file of leftovers) fs.rmSync(file, { force: true });
    take.partials = { files: leftovers, removed: !options.keep };
  }
  return take;
}

/** `.recording.mp4` files in `dir` created at or after `since` (epoch ms): the takes' own temporary files. */
function partialsSince(dir: string, since: number): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".recording.mp4")).map((name) => path.join(dir, name))
      .filter((file) => { try { return fs.statSync(file).birthtimeMs >= since - 1000; } catch { return false; } });
  } catch { return []; }
}

const mb = (bytes: number | undefined): string => bytes === undefined ? "?" : (bytes / 1024 / 1024).toFixed(1);

function describeTake(take: Take): string {
  const s = take.sample;
  const phases = s ? `stop→ready ${s.stopToReadyMs} ms (host ${s.hostMs ?? "?"}, writes ${s.writesMs ?? "?"}, flush ${s.flushMs ?? "?"}, close ${s.closeMs ?? "?"}, publish ${s.publishMs ?? "?"} by ${s.method ?? "?"}, cleanup ${s.cleanupMs ?? "?"}, checkpoint ${s.checkpointMs ?? "?"}, ui ${s.uiMs ?? "?"})` : "no stop→ready sample";
  const media = take.media ? `; ${take.media.durationSeconds?.toFixed(2) ?? "?"} s, video ${take.media.video}, audio ${take.media.audio}, decoded ${take.media.decoded}${take.media.decodeErrors ? `, decode errors: ${take.media.decodeErrors.slice(0, 200)}` : ""}` : "";
  const late = take.timedOut ? `; TIMED OUT, app ${take.timedOut === "forced" ? `killed after ${QUIT_GRACE_MS / 1000} s` : take.timedOut === "quit" ? "quit on SIGTERM" : "already gone"}` : "";
  const partials = take.partials ? `; partial ${take.partials.files.map((file) => path.basename(file)).join(", ")} ${take.partials.removed ? "removed" : "kept (--keep)"}` : "";
  return `${take.outcome}${take.detail ? ` (${take.detail})` : ""}${late}${partials}; ${mb(take.sizeBytes)} MiB${s?.stoppedEarly ? " (stopped early)" : ""}; ${phases}${media}; verified ${take.verified}`;
}

function summary(options: Options, volume: { mount: string; type: string }, takes: Take[], desktop: string): string {
  const samples = takes.flatMap((take) => take.sample ? [take.sample] : []);
  const pick = (key: keyof FinalizationSample): number[] => samples.flatMap((s) => typeof s[key] === "number" ? [s[key] as number] : []);
  const rows: Array<[string, number[]]> = [
    ["stop→ready", pick("stopToReadyMs")], ["host handoff", pick("hostMs")], ["queued writes", pick("writesMs")], ["flush", pick("flushMs")],
    ["close", pick("closeMs")], ["publish", pick("publishMs")], ["cleanup", pick("cleanupMs")], ["checkpoint", pick("checkpointMs")], ["UI settle", pick("uiMs")],
  ];
  const methods = [...new Set(samples.map((s) => s.method ?? "?"))].join(", ") || "—";
  return [
    `# Finalization measurement — ${options.label || "unlabelled"}`,
    "",
    `- Run: ${new Date().toISOString()}; ${takes.length} take(s) of ${options.seconds} s at ${options.quality} ${options.fps} fps, source resolution`,
    `- Folder: \`${options.dir}\` on ${volume.type} (${volume.mount}); publication method ${methods}`,
    `- Verification: ${options.verify === "full" ? "every take fully decoded" : "first saved take fully decoded; the others' streams, duration and first and last second"}`,
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
  const options = parseOptions(runnerArgs());
  if (process.platform !== "darwin") { console.error("measure:finalization requires macOS"); process.exit(2); }
  requireMediaTimeout();
  if (!hasTool("ffprobe")) { console.error("BLOCKED: ffprobe is required to verify each take"); process.exit(2); }
  if (electronPids().length > 0 || recordStuffPids().length > 0) {
    console.error("BLOCKED: RecordStuff or this project's Electron.app is running; quit it first so only this round records");
    process.exit(2);
  }
  fs.mkdirSync(options.dir, { recursive: true });
  process.on("SIGINT", () => interrupt("SIGINT"));
  process.on("SIGTERM", () => interrupt("SIGTERM"));
  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message} Nothing was recorded.`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });
  owned.desktop = desktop;
  const volume = volumeOf(options.dir);
  const report = path.join(MEASUREMENTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-finalization${options.label ? `-${options.label}` : ""}`);
  fs.mkdirSync(report, { recursive: true });
  console.log(`Finalization measurement: ${options.repeat} × ${options.seconds} s at ${options.quality} ${options.fps} fps into ${options.dir} (${volume.type}); evidence ${report}`);
  if (interrupted) await halt();
  if (options.build) {
    // Asynchronous and in its own process group: a signal meanwhile reaches the handler, which stops the build.
    const build = startBuild(REPO_ROOT);
    owned.build = build.child;
    const built = await build.done;
    if (interrupted) await halt();
    if (built !== 0) { desktop.end(); process.exit(built); }
  }
  const takes: Take[] = [];
  let left: string[] = [];
  try {
    if (options.openMaterial) {
      owned.materialProfile = createMaterialProfile("finalization");
      owned.material = spawn("open", materialOpenArgs(MATERIAL, owned.materialProfile), { stdio: "ignore" });
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
  // Leftovers fail the round even when the screen locked, so the next round never starts over them (round-exit.mts).
  if (desktop.lockedAt && left.length === 0) process.exit(DESKTOP_BLOCKED_EXIT);
  process.exit(takes.every((take) => take.outcome === "saved" && take.verified && !take.timedOut) && left.length === 0 ? 0 : 1);
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  process.exit(1);
});
