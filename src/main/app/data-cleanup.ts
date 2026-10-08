import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { messageOf } from "../lib/errors";

export const CLEANUP_MARKER = ".data-cleanup.json";
export interface CleanupPlan {
  userData: string;
  logs: string;
  sessionData: string;
  outputDir: string;
  /** Also protect media named by the failure history, including partial recordings. */
  media: string[];
  parentPid: number;
}

/**
 * Self-contained Node program: Electron owns profile files until it exits. Deleting
 * them inside before-quit lets Chromium recreate them during shutdown. The helper
 * only deletes after both explicit commit and parent exit, never on startup alone.
 * Keep all worker dependencies inside this function so its built source can run
 * with ELECTRON_RUN_AS_NODE, without extra packaged files or a resident service.
 */
async function cleanupWorker(): Promise<void> {
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");
  const plan = JSON.parse(process.argv[1]!) as CleanupPlan;
  const marker = path.join(plan.userData, ".data-cleanup.json");
  const temporary = `${marker}.${process.pid}.tmp`;
  let owned = false;
  const writeStatus = async (status: Record<string, unknown>, create = false): Promise<void> => {
    const handle = await fs.open(temporary, "w", 0o600);
    try { await handle.writeFile(JSON.stringify(status)); await handle.sync(); }
    finally { await handle.close(); }
    try {
      if (create) await fs.link(temporary, marker); // Exclusive: never replace another helper's marker.
      else await fs.rename(temporary, marker);
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  };
  const inside = (base: string, target: string): boolean => {
    const relative = path.relative(base, target);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  const delay = () => new Promise<void>(resolve => setTimeout(resolve, 100));
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  try {
    if (![plan.userData, plan.logs, plan.sessionData, plan.outputDir, ...plan.media].every(value => typeof value === "string" && path.isAbsolute(value)) || !Number.isSafeInteger(plan.parentPid) || plan.parentPid <= 0)
      throw new Error("Invalid app data cleanup plan");
    const canonical = async (value: string): Promise<string> => fs.realpath(value).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return path.resolve(value);
      throw error;
    });
    const roots = [...new Set([plan.userData, plan.logs, plan.sessionData].map(value => path.resolve(value)))];
    for (const root of roots) {
      const actual = await canonical(root);
      if (inside(actual, await canonical(os.homedir())) || inside(actual, await canonical(os.tmpdir())) || actual === path.parse(actual).root)
        throw new Error("Refusing to clear a broad system or home directory");
      const stat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("App data root is not a plain directory");
    }
    const output = path.resolve(plan.outputDir), actualOutput = await canonical(output);
    // If a recording folder contains a data root, its arbitrary files cannot be
    // distinguished safely from app data. Refuse instead of deleting user files.
    const deletionRoots = [...new Set(await Promise.all(roots.map(canonical)))];
    if (deletionRoots.some(root => inside(actualOutput, root))) throw new Error("The output folder overlaps app data; move recordings outside app data first");
    const originalPaths = [output, ...plan.media.map(value => path.resolve(value))];
    const protectedPaths = [...originalPaths, ...await Promise.all(originalPaths.map(canonical))];
    await fs.mkdir(plan.userData, { recursive: true });
    await writeStatus({ version: 1, pid: process.pid, status: "waiting" }, true);
    owned = true;
    const actualMarker = await canonical(marker);
    let committed = false, cancelled = false;
    process.on("message", message => {
      if (message === "commit") committed = true;
      if (message === "cancel") cancelled = true;
    });
    if (process.connected) process.send?.("ready");
    const deadline = Date.now() + 60_000;
    while (!committed && !cancelled && alive(plan.parentPid) && Date.now() < deadline) await delay();
    if (!committed || cancelled) { await fs.unlink(marker); return; }
    await writeStatus({ version: 1, pid: process.pid, status: "committed" });
    if (process.connected) process.send?.("committed");
    while (alive(plan.parentPid)) {
      if (cancelled) { await fs.unlink(marker); return; }
      if (Date.now() >= deadline) throw new Error("App did not exit; no data was cleared");
      await delay();
    }
    if (cancelled) { await fs.unlink(marker); return; }
    // Never follow directory symlinks. Retain every MP4, including partials not
    // listed in history, and an output folder nested in app data in its entirety.
    const remove = async (target: string): Promise<void> => {
      if (target === marker || target === actualMarker || protectedPaths.some(keep => inside(keep, target)) || /\.mp4$/i.test(target)) return;
      const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) return;
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        for (const entry of await fs.readdir(target)) await remove(path.join(target, entry));
        await fs.rmdir(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
        });
      } else await fs.unlink(target);
    };
    // An outer root owns its nested roots; process it once, without losing the
    // marker that makes a simultaneous new launch wait until cleanup is done.
    for (const root of deletionRoots.filter(root => !deletionRoots.some(other => other !== root && inside(other, root)))) await remove(root);
    await fs.unlink(marker);
    await fs.rmdir(plan.userData).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
    });
  } catch (error) {
    if (owned) await writeStatus({ version: 1, pid: process.pid, status: "failed", error: String(error) }).catch(() => undefined);
    if (process.connected) process.send?.({ error: String(error) });
    process.exitCode = 1;
  } finally { if (process.connected) process.disconnect?.(); }
}

export function cleanupWorkerSource(): string { return `(${cleanupWorker.toString()})()`; }

/** Prepare the helper, then commit only once normal quit has admitted exit. */
export async function prepareDataCleanup(plan: CleanupPlan): Promise<void> {
  const child = spawn(process.execPath, ["-e", cleanupWorkerSource(), JSON.stringify(plan)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    cwd: os.tmpdir(), detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  // A late IPC transport error must not become an uncaught main-process error.
  child.on("error", () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { finish(new Error("Data cleanup helper did not become ready")); }, 5000);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        child.removeListener("message", onMessage);
        if (error) reject(error); else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onExit = () => finish(new Error("Data cleanup helper exited before confirmation"));
      const onMessage = (message: unknown) => {
        if (message === "ready") child.send("commit", error => { if (error) finish(error); });
        else if (message === "committed") finish();
        else if (message && typeof message === "object" && "error" in message) finish(new Error(String(message.error)));
      };
      child.on("error", onError); child.on("exit", onExit); child.on("message", onMessage);
    });
    child.disconnect();
    child.unref();
  } catch (error) {
    if (child.connected) child.send("cancel", () => { if (child.connected) child.disconnect(); });
    child.unref();
    throw error;
  }
}

interface CleanupStatus { pid: number; status: "waiting" | "committed" | "failed"; error?: unknown }

/** The marker's status, or undefined when there is none; a marker that cannot be read or validated throws. */
async function readCleanupStatus(marker: string): Promise<CleanupStatus | undefined> {
  let value: { version?: unknown; pid?: unknown; status?: unknown; error?: unknown };
  try { value = JSON.parse(await fs.readFile(marker, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read local data cleanup status: ${String(error)}`);
  }
  if (!value || value.version !== 1 || !["waiting", "committed", "failed"].includes(String(value.status)) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0)
    throw new Error("Invalid local data cleanup status");
  return { pid: Number(value.pid), status: value.status as CleanupStatus["status"], error: value.error };
}

/** Whether `pid` still runs; a process this user may not signal counts as running. */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

/** A new instance must not create settings/cache while the previous one clears them. */
export async function waitForDataCleanup(userData: string): Promise<void> {
  const marker = path.join(userData, CLEANUP_MARKER);
  const deadline = Date.now() + 65_000;
  for (;;) {
    const value = await readCleanupStatus(marker);
    if (!value) return;
    if (value.status === "failed") throw new Error(`Local data cleanup failed: ${String(value.error)}`);
    if (!processAlive(value.pid)) throw new Error("Local data cleanup was interrupted; the data was kept where possible");
    if (Date.now() >= deadline) throw new Error("Local data cleanup is still running");
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
}

/**
 * After `waitForDataCleanup` reported a failed or interrupted cleanup and the user was told, remove its
 * marker so this launch can continue. Never while a live helper could still be deleting the profile, and
 * never for a marker that cannot be validated: both throw and keep the marker.
 */
export async function releaseFailedCleanup(userData: string): Promise<void> {
  const marker = path.join(userData, CLEANUP_MARKER);
  const value = await readCleanupStatus(marker).catch((cause: unknown) => {
    throw new Error(`${messageOf(cause)}; original marker retained`);
  });
  if (!value) return;
  if (value.status !== "failed" && processAlive(value.pid)) throw new Error("Cleanup helper is still active");
  await fs.unlink(marker).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}
