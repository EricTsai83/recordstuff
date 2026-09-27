/**
 * Plan 035's controlled acceptance build: a signed copy of the app with isolated data, a labeled
 * tray and fault points the runner arms, so the maintainer can operate states that real faults
 * cannot produce on demand. The maintainer performs every native action; this runner only builds,
 * seeds, arms, releases, reports and quits. Only `selftest` drives the app itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { copySourceWorkspace } from "./lib/update-acceptance.mts";
import {
  CONTROLLED_TOOL, USAGE, bundleProcessPattern, instrumentControlledAcceptance, latestRun, nextRequestNumber, parseControlledArgs,
  seedFiles, selfTestFiles, writeSeedFiles, type ControlledArgs, type RunMarker, type Seed,
} from "./lib/controlled-acceptance.mts";
import { FAULT_MODES, HOLD_TARGETS, type FaultName } from "./fixtures/controlled-modes.ts";
import type { ControlledCommand, ControlledConfig, ControlledResponse, ControlledSnapshot } from "./fixtures/controlled-acceptance";
import type { RecordingResult } from "../src/shared/recording-result.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PARENT = path.join(ROOT, "docs/verification/measurements");
const BLOCKED = 2;
class Blocked extends Error {}

const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "RECORDSTUFF_AUTORECORD"]) delete env[key];
let child: ReturnType<typeof spawn> | undefined;
let cancelled = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  cancelled = true;
  if (child?.pid) try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
});

const sha256 = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const appPath = (dir: string): string => path.join(dir, "workspace/dist", process.arch === "arm64" ? "mac-arm64" : "mac", "RecordStuff.app");
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Any RecordStuff bundle, normal or controlled: two would fight over the shortcut and the tray. */
function runningRecordStuff(): string[] {
  const result = spawnSync("pgrep", ["-fl", "(^|/)RecordStuff\\.app/Contents/MacOS/RecordStuff($| )"], { encoding: "utf8" });
  if (result.error || ![0, 1].includes(result.status ?? -1)) throw new Blocked("Could not check for a running RecordStuff.");
  return result.stdout.trim().split("\n").filter(Boolean);
}
function requireNoRecordStuff(): void {
  const running = runningRecordStuff();
  if (running.length) throw new Blocked(`Quit RecordStuff from its menu first (never interrupt a recording):\n${running.join("\n")}`);
}

/** Waits for `read` to return a value; cleanup passes `stoppable: false` to keep waiting after an interrupt. */
async function until<T>(read: () => T | undefined, label: string, timeoutMs: number, stoppable = true): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cancelled && stoppable) throw new Error("interrupted");
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await pause(100);
  }
}
const readJson = <T,>(file: string): T | undefined => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return undefined; }
};

async function run(program: string, args: string[], cwd: string, logFile: string, timeoutMs: number): Promise<void> {
  const fd = fs.openSync(logFile, "a");
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = child = spawn(program, args, { cwd, env, stdio: ["ignore", fd, fd], detached: true });
      const timer = setTimeout(() => { try { if (proc.pid) process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ } }, timeoutMs);
      proc.on("error", error => { clearTimeout(timer); child = undefined; reject(error); });
      proc.on("exit", (code, signal) => {
        clearTimeout(timer); child = undefined;
        if (code === 0) resolve();
        else reject(new Error(`${program} ${args.join(" ")} ${signal ? `ended by ${signal}` : `exited ${code}`}; see ${logFile}`));
      });
    });
  } finally { fs.closeSync(fd); }
}

async function send(dir: string, command: ControlledCommand, stoppable = true): Promise<Extract<ControlledResponse, { ok: true }>> {
  const ready = readJson<ControlledSnapshot>(path.join(dir, "ready.json"));
  if (!ready || !alive(ready.pid)) throw new Error(`The controlled app of ${dir} is not running; use reopen.`);
  const requests = path.join(dir, "requests");
  const name = `${nextRequestNumber(fs.readdirSync(requests))}.json`;
  fs.writeFileSync(path.join(requests, `${name}.tmp`), JSON.stringify(command));
  fs.renameSync(path.join(requests, `${name}.tmp`), path.join(requests, name));
  const response = await until(() => readJson<ControlledResponse>(path.join(dir, "responses", name)), `a reply to ${command.kind}`, 15_000, stoppable);
  if (!response.ok) throw new Error(response.error);
  return response;
}
const status = async (dir: string): Promise<ControlledSnapshot> => (await send(dir, { kind: "status" })).snapshot;

/** Processes of this run's bundle only, matched literally by executable path. */
function bundleProcesses(dir: string): string[] {
  const result = spawnSync("pgrep", ["-fl", bundleProcessPattern(appPath(dir))], { encoding: "utf8" });
  if (result.error || ![0, 1].includes(result.status ?? -1)) throw new Error(`Could not check for the controlled app of ${dir}.`);
  return result.stdout.trim().split("\n").filter(Boolean);
}

/** Opens the run's bundle (building it first when `build`) and waits for the instrumented app to report ready. */
async function openApp(dir: string, build: boolean): Promise<ControlledSnapshot> {
  requireNoRecordStuff();
  for (const file of ["ready.json", "stopped.json"]) fs.rmSync(path.join(dir, file), { force: true });
  try {
    await run("pnpm", [build ? "start:app" : "open:app"], path.join(dir, "workspace"), path.join(dir, build ? "build.log" : "open.log"), 600_000);
    return await until(() => readJson<ControlledSnapshot>(path.join(dir, "ready.json")), "the controlled app to report ready", 60_000);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await abandonLaunch(dir)}`);
  }
}

/**
 * `open` hands the bundle to LaunchServices, beyond the launcher's process group, so an
 * interrupt or failure can leave it starting. Wait briefly for it: a ready app quits through
 * the production path; one that never reports ready is named for the user to quit.
 */
async function abandonLaunch(dir: string): Promise<string> {
  const began = Date.now();
  const ready = (): boolean => fs.existsSync(path.join(dir, "ready.json"));
  while (!ready() && Date.now() - began < 15_000 && (Date.now() - began < 5000 || bundleProcesses(dir).length)) await pause(250);
  if (ready()) {
    try { await quitApp(dir, false); return "The controlled app had started; it quit normally."; }
    catch (error) { return `The controlled app started but did not quit: ${String(error)}`; }
  }
  const left = bundleProcesses(dir);
  return left.length ? `The controlled app started without reporting ready and still runs; quit it from its menu:\n${left.join("\n")}` : "No controlled app process remains.";
}

function createRun(out: string | undefined, seed: Seed, selftest: boolean, holdHistoryLoad: boolean): string {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Blocked("The controlled build needs macOS arm64 or x64.");
  requireNoRecordStuff();
  fs.mkdirSync(PARENT, { recursive: true });
  const dir = out ? path.resolve(out) : path.join(PARENT, `${new Date().toISOString().replace(/[:.]/g, "-")}-controlled${selftest ? "-selftest" : ""}`);
  fs.mkdirSync(dir); // An existing directory is refused, never reused.
  const workspace = path.join(dir, "workspace");
  copySourceWorkspace(ROOT, workspace);
  const entry = path.join(workspace, "src/main/index.ts");
  fs.writeFileSync(entry, instrumentControlledAcceptance(fs.readFileSync(entry, "utf8"), dir));
  const now = Date.now();
  const config: ControlledConfig = { holdHistoryLoad };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  writeSeedFiles(dir, { ...seedFiles(seed, dir, now), ...(selftest ? selfTestFiles(dir) : {}) });
  const git = (...args: string[]): string => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const marker: RunMarker = { tool: CONTROLLED_TOOL, createdAt: new Date(now).toISOString(), seed, selftest };
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ ...marker, head: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain").split("\n").filter(Boolean), os: `${os.type()} ${os.release()} ${process.arch}` }, null, 2));
  return dir;
}

function recordArtifact(dir: string): void {
  const app = appPath(dir);
  fs.writeFileSync(path.join(dir, "artifact.json"), JSON.stringify({ appPath: app,
    asarSha256: sha256(path.join(app, "Contents/Resources/app.asar")) }, null, 2));
}

function describeRow(r: RecordingResult): string {
  const flags = [r.acknowledged ? "read" : "unread", r.restored ? "restored" : "", r.saving ? `saving ${r.saving}` : "",
    r.persistenceFailed ? `unsaved (${r.persistenceFailed})` : ""].filter(Boolean).join(", ");
  const file = r.partialPath ?? r.recordingPath;
  return `  ${r.occurredAt} ${r.code} → ${r.outcome} [${flags}] ${r.id}${file ? `\n      ${file}` : ""}`;
}
function describe(s: ControlledSnapshot): string {
  const held = Object.entries(s.held).filter(([, n]) => n > 0).map(([t, n]) => `${t} ×${n}`).join(", ") || "none";
  return [`pid ${s.pid} ${s.label}`, `state: ${s.state?.type ?? "starting up"}${s.historyLoading ? "; history loading" : ""}`,
    `faults: ${Object.entries(s.faults).map(([k, v]) => `${k}=${v}`).join(" ")}; held: ${held}`,
    `userData: ${s.userData}`, ...(s.outputDir ? [`output folder: ${s.outputDir}`] : []),
    `failure history (${s.history?.length ?? 0}):`, ...(s.history ?? []).map(describeRow)].join("\n");
}

async function quitApp(dir: string, stoppable = true): Promise<void> {
  const ready = readJson<ControlledSnapshot>(path.join(dir, "ready.json"));
  if (!ready || !alive(ready.pid)) return;
  await send(dir, { kind: "quit" }, stoppable);
  // A recording is saved first; pending media or unsaved reminders defer or question the exit.
  await until(() => fs.existsSync(path.join(dir, "stopped.json")) ? true : undefined, "a normal exit (answer any quit prompt in the app)", 60_000, stoppable);
  await until(() => alive(ready.pid) ? undefined : true, `process ${ready.pid} to exit`, 30_000, stoppable);
}

function clean(dir: string): void {
  const running = bundleProcesses(dir);
  if (running.length) throw new Error(`The controlled app still runs; quit it first:\n${running.join("\n")}`);
  fs.rmSync(path.join(dir, "workspace"), { recursive: true, force: true });
}

/** Turns every fault off, then lets every held operation go, so the next quit is a plain one. */
async function disarm(dir: string): Promise<void> {
  const ready = readJson<ControlledSnapshot>(path.join(dir, "ready.json"));
  if (!ready || !alive(ready.pid)) return;
  for (const name of Object.keys(FAULT_MODES) as FaultName[]) await send(dir, { kind: "fault", name, mode: "off" }, false);
  for (const target of HOLD_TARGETS) await send(dir, { kind: "release", target }, false);
}

function target(args: { dir?: string }): string {
  const dir = args.dir ? path.resolve(args.dir) : latestRun(PARENT);
  if (!dir || !fs.existsSync(path.join(dir, "run.json"))) throw new Error("No controlled run found; start one with launch or pass --dir.");
  return dir;
}

/**
 * Builds and drives one labeled app without recording: a start failure through an
 * unwritable isolated folder with a held cleanup, rejected and held history saves, a
 * normal quit, and a relaunch whose history load is held. It proves the tool, not the
 * product: the write and close faults need real capture and rest on the unit tests.
 */
async function selftest(out: string | undefined): Promise<number> {
  const dir = createRun(out, "none", true, false);
  const recordings = path.join(dir, "recordings");
  const steps: Array<{ name: string; status: "pass" | "fail" | "blocked" | "not run"; detail: string }> = [];
  const names = ["build, sign and launch the labeled build", "held cleanup keeps the start failure pending", "release settles it as empty",
    "a rejected history save flags the reminder unsaved", "retry saves it and a held save delays Got it", "quit exits normally",
    "a relaunch with a held history load restores the history", "final quit and cleanup"];
  let snapshot: ControlledSnapshot | undefined;
  const wait = async (label: string, test: (s: ControlledSnapshot) => boolean, timeoutMs = 15_000): Promise<ControlledSnapshot> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      snapshot = await status(dir);
      if (test(snapshot)) return snapshot;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}:\n${describe(snapshot)}`);
      await pause(150);
    }
  };
  const row = (s: ControlledSnapshot): RecordingResult | undefined => s.history?.[0];
  const act = (action: "acknowledge" | "retry"): Promise<unknown> => send(dir, { kind: "action", action: { recordingResult: { id: row(snapshot!)!.id, action } } });
  const checks: Array<() => Promise<string>> = [
    async () => {
      snapshot = await openApp(dir, true);
      recordArtifact(dir);
      assert(snapshot.tooltip.startsWith(snapshot.label), "tray tooltip carries the label");
      assert.equal(snapshot.userData, path.join(dir, "user-data"));
      assert.equal(snapshot.outputDir, recordings);
      snapshot = await wait("idle", s => s.state?.type === "idle" || s.state?.type === "needsPermission");
      if (snapshot.state?.type !== "idle") throw new Blocked("Screen recording permission is missing for this signing identity; the self-test starts no capture but needs an idle recorder.");
      assert.deepEqual(snapshot.history, []);
      return `pid ${snapshot.pid}, label in tooltip, isolated userData and output folder`;
    },
    async () => {
      fs.chmodSync(recordings, 0o555);
      await send(dir, { kind: "fault", name: "cleanup", mode: "hold" });
      await send(dir, { kind: "fault", name: "history-save", mode: "fail" });
      await send(dir, { kind: "toggle" });
      const s = await wait("a pending failure", s => row(s)?.outcome === "pending" && s.held.cleanup === 1 && s.state?.type === "idle");
      await pause(1000);
      const later = await status(dir);
      assert.equal(row(later)?.outcome, "pending", "still pending after a second");
      assert.equal(row(s)?.code, "output_open_failed");
      return `output_open_failed stays pending while held (${row(s)!.id})`;
    },
    async () => {
      assert.equal((await send(dir, { kind: "release", target: "cleanup" })).released, 1);
      const s = await wait("the settled result", r => row(r)?.outcome === "empty" && r.held.cleanup === 0);
      return `outcome empty, nothing held; unsaved flag ${row(s)!.persistenceFailed ?? "none"}`;
    },
    async () => {
      const s = await wait("the unsaved flag", r => row(r)?.persistenceFailed === "io");
      assert.equal(row(s)?.acknowledged, false);
      return "persistenceFailed io, still unread";
    },
    async () => {
      await send(dir, { kind: "fault", name: "cleanup", mode: "off" });
      await send(dir, { kind: "fault", name: "history-save", mode: "off" });
      await act("retry");
      await wait("the retried save", r => row(r)?.persistenceFailed === undefined);
      await send(dir, { kind: "fault", name: "history-save", mode: "hold" });
      await act("acknowledge");
      await wait("a held acknowledgement", r => row(r)?.saving === "acknowledge" && r.held["history-save"] === 1 && row(r)?.acknowledged === false);
      await send(dir, { kind: "fault", name: "history-save", mode: "off" });
      assert.equal((await send(dir, { kind: "release", target: "history-save" })).released, 1);
      await wait("the durable acknowledgement", r => row(r)?.acknowledged === true && row(r)?.saving === undefined);
      return "retry cleared the flag; Got it stayed saving while held and committed after release";
    },
    async () => { await quitApp(dir); return "stopped.json written and the process exited"; },
    async () => {
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ holdHistoryLoad: true } satisfies ControlledConfig));
      snapshot = await openApp(dir, false);
      const held = await wait("a held load", s => s.historyLoading === true && s.held["history-load"] === 1);
      assert.deepEqual(held.history, []);
      assert.equal((await send(dir, { kind: "release", target: "history-load" })).released, 1);
      const s = await wait("the loaded history", r => r.historyLoading === false && r.history?.length === 1);
      assert.equal(row(s)?.acknowledged, true); assert.equal(row(s)?.restored, true); assert.equal(row(s)?.code, "output_open_failed");
      return "loading while held; after release one restored, acknowledged row";
    },
    async () => {
      await quitApp(dir);
      fs.chmodSync(recordings, 0o755);
      clean(dir);
      assert.deepEqual(runningRecordStuff(), []);
      return "normal exit, folder writable again, workspace removed, no RecordStuff process";
    },
  ];
  let failed = false;
  for (const [index, check] of checks.entries()) {
    if (failed || cancelled) { steps.push({ name: names[index]!, status: "not run", detail: failed ? "an earlier step did not pass" : "interrupted" }); continue; }
    try {
      steps.push({ name: names[index]!, status: "pass", detail: await check() });
    } catch (error) {
      failed = true;
      steps.push({ name: names[index]!, status: error instanceof Blocked ? "blocked" : "fail", detail: String(error) });
    }
    console.log(`${steps.at(-1)!.status}: ${steps.at(-1)!.name} — ${steps.at(-1)!.detail}`);
  }
  if (failed || cancelled) {
    try { fs.chmodSync(recordings, 0o755); } catch { /* reported below */ }
    // A held cleanup would defer the exit and a failing save would ask about reminders, with nobody to answer.
    try { await disarm(dir); await quitApp(dir, false); }
    catch (error) { steps.push({ name: "cleanup after failure", status: "fail", detail: String(error) }); }
  }
  const exit = steps.some(s => s.status === "fail") ? 1 : steps.every(s => s.status === "pass") ? 0 : BLOCKED;
  const left = runningRecordStuff();
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ exit, steps, runningAfter: left }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "report.md"), [`# Controlled acceptance build self-test`, "",
    `Result: ${exit === 0 ? "PASS" : exit === BLOCKED ? "BLOCKED / INCOMPLETE" : "FAIL"}`, "",
    "Scope: the labeled signed build, its isolated data, the command channel, the cleanup hold, rejected and held history saves, a normal quit and a held history load at relaunch, driven by the runner (toggle and actions through the production handlers, not native clicks). No capture: the write and close faults are covered by unit tests only.", "",
    ...steps.map(s => `- **${s.status}** ${s.name}: ${s.detail}`), "",
    `RecordStuff processes after the run: ${left.length ? left.join("; ") : "none"}.`, "",
    "Evidence: run.json, artifact.json, build.log, open.log, events.jsonl, requests/, responses/, logs/, user-data/.", ""].join("\n"));
  console.log(`Report: ${path.join(dir, "report.md")}`);
  return exit;
}

async function main(args: ControlledArgs): Promise<number> {
  switch (args.command) {
    case "launch": {
      const dir = createRun(args.out, args.seed, false, args.holdHistoryLoad);
      console.log(`Run: ${dir}\nBuilding and signing the controlled build (see build.log)…`);
      const s = await openApp(dir, true);
      recordArtifact(dir);
      console.log(`${describe(s)}\nApp: ${appPath(dir)}`);
      return 0;
    }
    case "selftest":
      return selftest(args.out);
    case "reopen": {
      const dir = target(args);
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ holdHistoryLoad: args.holdHistoryLoad } satisfies ControlledConfig));
      console.log(`Run: ${dir}`);
      console.log(describe(await openApp(dir, false)));
      return 0;
    }
    case "fault": {
      const dir = target(args);
      let s: ControlledSnapshot | undefined;
      for (const f of args.faults) s = (await send(dir, { kind: "fault", name: f.name, mode: f.mode })).snapshot;
      console.log(describe(s!));
      return 0;
    }
    case "release": {
      const dir = target(args);
      const response = await send(dir, { kind: "release", target: args.target });
      console.log(`released ${response.released} held ${args.target}\n${describe(response.snapshot)}`);
      return 0;
    }
    case "status":
      console.log(describe(await status(target(args))));
      return 0;
    case "quit":
      await quitApp(target(args));
      console.log("The controlled app exited normally.");
      return 0;
    case "clean": {
      const dir = target(args);
      clean(dir);
      console.log(`Removed ${path.join(dir, "workspace")}; evidence kept in ${dir}.`);
      return 0;
    }
  }
}

let args: ControlledArgs;
try { args = parseControlledArgs(process.argv.slice(2)); }
catch (error) { console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`); process.exit(BLOCKED); }
try { process.exitCode = await main(args); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof Blocked ? BLOCKED : 1;
}
