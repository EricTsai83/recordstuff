import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CLEANUP_MARKER, cleanupWorkerSource, prepareDataCleanup, releaseFailedCleanup, waitForDataCleanup, type CleanupPlan } from "./data-cleanup";

let directory: string, plan: CleanupPlan;
const children: ChildProcess[] = [];
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-cleanup-"));
  plan = { userData: path.join(directory, "data"), logs: path.join(directory, "logs"), sessionData: path.join(directory, "data"),
    outputDir: path.join(directory, "videos"), media: [], parentPid: process.pid };
  await fs.mkdir(plan.userData); await fs.mkdir(plan.logs); await fs.mkdir(plan.outputDir);
  await fs.writeFile(path.join(plan.userData, "settings.json"), "settings");
  await fs.writeFile(path.join(plan.logs, "recordstuff.log"), "log");
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill(); await exited;
    }
  }
  await fs.rm(directory, { recursive: true, force: true });
});
const parent = () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child); return child;
};
function worker(input = plan) {
  const child = spawn(process.execPath, ["-e", cleanupWorkerSource(), JSON.stringify(input)], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(child);
  const messages: unknown[] = [];
  child.on("message", message => messages.push(message));
  const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  return { child, messages, exited };
}
const readSettings = () => fs.readFile(path.join(plan.userData, "settings.json"), "utf8");
const marker = () => path.join(plan.userData, CLEANUP_MARKER);

it("requires commit and parent exit, then removes old settings, backups, history, cache and logs without recreating them", async () => {
  const owner = parent(); plan.parentPid = owner.pid!;
  for (const name of ["settings.json.migration-backup", "settings.json.unreadable", "recording-result.json", "recording-history.json", "settings-window.json", "tray-hint-shown"])
    await fs.writeFile(path.join(plan.userData, name), "old data");
  await fs.mkdir(path.join(plan.userData, "Cache")); await fs.writeFile(path.join(plan.userData, "Cache", "cache"), "cache");
  await fs.writeFile(path.join(plan.outputDir, "video.mp4"), "recording");
  const run = worker();
  await vi.waitFor(() => expect(run.messages).toContain("ready"));
  expect(await readSettings()).toBe("settings");
  run.child.send("commit"); await vi.waitFor(() => expect(run.messages).toContain("committed"));
  const starting = waitForDataCleanup(plan.userData);
  let started = false; void starting.then(() => { started = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(started).toBe(false); expect(await readSettings()).toBe("settings");
  owner.kill();
  expect(await run.exited).toBe(0); await starting;
  await expect(fs.access(plan.userData)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.access(plan.logs)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(plan.outputDir, "video.mp4"), "utf8")).toBe("recording");
});

it("an uncommitted helper never deletes data when its parent exits", async () => {
  const owner = parent(); plan.parentPid = owner.pid!;
  const run = worker(); await vi.waitFor(() => expect(run.messages).toContain("ready"));
  owner.kill(); expect(await run.exited).toBe(0);
  expect(await readSettings()).toBe("settings");
  await expect(fs.access(marker())).rejects.toMatchObject({ code: "ENOENT" });
});

it("cancelling a committed helper keeps the data, even if the parent quits later", async () => {
  const owner = parent(); plan.parentPid = owner.pid!;
  const run = worker(); await vi.waitFor(() => expect(run.messages).toContain("ready"));
  run.child.send("commit"); await vi.waitFor(() => expect(run.messages).toContain("committed"));
  run.child.send("cancel"); expect(await run.exited).toBe(0);
  owner.kill(); expect(await readSettings()).toBe("settings");
});

it("preserves nested output folders, all MP4s and known media, without following directory links", async () => {
  const owner = parent(); plan.parentPid = owner.pid!;
  plan.outputDir = path.join(plan.userData, "recordings");
  await fs.mkdir(plan.outputDir); await fs.writeFile(path.join(plan.outputDir, "notes.txt"), "user notes");
  await fs.writeFile(path.join(plan.userData, ".recording.mp4"), "partial");
  const known = path.join(plan.logs, "known.part"); plan.media = [known]; await fs.writeFile(known, "known media");
  const external = path.join(directory, "external"); await fs.mkdir(external); await fs.writeFile(path.join(external, "keep.txt"), "outside");
  await fs.symlink(external, path.join(plan.userData, "link"), process.platform === "win32" ? "junction" : "dir");
  const run = worker(); await vi.waitFor(() => expect(run.messages).toContain("ready"));
  run.child.send("commit"); await vi.waitFor(() => expect(run.messages).toContain("committed")); owner.kill();
  expect(await run.exited).toBe(0);
  expect(await fs.readFile(path.join(plan.outputDir, "notes.txt"), "utf8")).toBe("user notes");
  expect(await fs.readFile(path.join(plan.userData, ".recording.mp4"), "utf8")).toBe("partial");
  expect(await fs.readFile(known, "utf8")).toBe("known media");
  expect(await fs.readFile(path.join(external, "keep.txt"), "utf8")).toBe("outside");
  await expect(fs.access(path.join(plan.userData, "link"))).rejects.toThrow();
  await expect(readSettings()).rejects.toThrow();
  await expect(fs.access(marker())).rejects.toThrow();
});

it.each(["home", "ancestor", "output", "relative", "symlink"])("refuses unsafe %s roots without deleting data", async kind => {
  const input = { ...plan };
  if (kind === "home") input.logs = os.homedir();
  if (kind === "ancestor") input.logs = path.dirname(os.homedir());
  if (kind === "output") input.outputDir = directory;
  if (kind === "relative") input.logs = "relative";
  if (kind === "symlink") {
    input.logs = path.join(directory, "linked-root");
    await fs.symlink(plan.logs, input.logs, process.platform === "win32" ? "junction" : "dir");
  }
  const run = worker(input);
  expect(await run.exited).toBe(1);
  expect(run.messages).not.toContain("ready");
  expect(await readSettings()).toBe("settings");
});

it("preparation reports errors and retains settings instead of silently admitting quit", async () => {
  await expect(prepareDataCleanup({ ...plan, outputDir: directory })).rejects.toThrow(/overlaps/);
  expect(await readSettings()).toBe("settings");
});

it("protects an output folder reached through a symlink outside the data root", async () => {
  const owner = parent(); plan.parentPid = owner.pid!;
  const actual = path.join(plan.userData, "actual-output"); await fs.mkdir(actual);
  await fs.writeFile(path.join(actual, "notes.txt"), "user notes");
  const link = path.join(directory, "output-link");
  await fs.symlink(actual, link, process.platform === "win32" ? "junction" : "dir");
  plan.outputDir = link;
  const run = worker(); await vi.waitFor(() => expect(run.messages).toContain("ready"));
  run.child.send("commit"); await vi.waitFor(() => expect(run.messages).toContain("committed")); owner.kill();
  expect(await run.exited).toBe(0);
  expect(await fs.readFile(path.join(actual, "notes.txt"), "utf8")).toBe("user notes");
  await expect(readSettings()).rejects.toThrow();
});

it("startup detects an interrupted or failed cleanup, rather than overwriting its status", async () => {
  const owner = parent(); const exited = new Promise<void>(resolve => owner.once("exit", () => resolve())); owner.kill(); await exited;
  await fs.writeFile(marker(), JSON.stringify({ version: 1, pid: owner.pid, status: "committed" }));
  await expect(waitForDataCleanup(plan.userData)).rejects.toThrow(/interrupted/);
  await fs.writeFile(marker(), JSON.stringify({ version: 1, pid: owner.pid, status: "failed", error: "permission denied" }));
  await expect(waitForDataCleanup(plan.userData)).rejects.toThrow(/permission denied/);
  expect(await readSettings()).toBe("settings");
});

it("startup releases only a marker whose helper has stopped, and keeps one it cannot trust", async () => {
  // No marker: nothing to release.
  await releaseFailedCleanup(plan.userData);
  // A live helper may still be deleting: the marker stays.
  const owner = parent();
  await fs.writeFile(marker(), JSON.stringify({ version: 1, pid: owner.pid, status: "committed" }));
  await expect(releaseFailedCleanup(plan.userData)).rejects.toThrow(/still active/);
  await fs.access(marker());
  // A failed helper has stopped, even if its pid now belongs to another process.
  await fs.writeFile(marker(), JSON.stringify({ version: 1, pid: owner.pid, status: "failed", error: "permission denied" }));
  await releaseFailedCleanup(plan.userData);
  await expect(fs.access(marker())).rejects.toMatchObject({ code: "ENOENT" });
  // An interrupted helper is gone.
  const exited = new Promise<void>(resolve => owner.once("exit", () => resolve())); owner.kill(); await exited;
  await fs.writeFile(marker(), JSON.stringify({ version: 1, pid: owner.pid, status: "waiting" }));
  await releaseFailedCleanup(plan.userData);
  await expect(fs.access(marker())).rejects.toMatchObject({ code: "ENOENT" });
  // Unreadable or invalid: kept, with a reason instead of a bare parse error.
  for (const content of ["{not json", JSON.stringify({ version: 2, pid: 1, status: "failed" })]) {
    await fs.writeFile(marker(), content);
    await expect(releaseFailedCleanup(plan.userData)).rejects.toThrow(/original marker retained/);
    await fs.access(marker());
  }
  expect(await readSettings()).toBe("settings");
});
