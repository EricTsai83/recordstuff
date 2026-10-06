/**
 * Cleanup drills for the background hosts (plan 066 phase 1, ledger D01–D10). Each breaks a launch on purpose and
 * shows what the fixture does: a launch that fails leaves no process; an assertion failure, a timeout, a hung main
 * and a containment violation fail the test while its whole process tree still ends; a renderer crash ends normally;
 * and an interrupted run (SIGINT to the runner) leaves nothing behind. The tests that must fail are marked
 * `test.fail()`, and the test after each confirms from the process table that the broken launch's tree is gone,
 * so a drill passes only when the failure was reported and the cleanup actually happened.
 */
import { test, expect, ownedProcesses, alive, tearDown, ROOT, type Launched } from "./fixtures";
import { _electron } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eventually } from "./helpers";
import { scrubbedEnv } from "../../scripts/lib/runner/runner-env.mts";

test.describe.configure({ mode: "serial" });

/** Launch folders of the drills that failed on purpose, checked by the test after them. */
const ledger = path.join(os.tmpdir(), `recordstuff-ui-drills-${process.pid}.json`);
const remember = (launched: Launched): void => {
  const known = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, "utf8")) as Array<{ pid: number; data: string }> : [];
  fs.writeFileSync(ledger, JSON.stringify([...known, { pid: launched.pid, data: launched.data }]));
};
/** Every remembered launch has no process left: neither its main pid nor anything naming its folder. */
async function rememberedAreGone(): Promise<Array<{ pid: number; data: string; remaining: number[] }>> {
  const known = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, "utf8")) as Array<{ pid: number; data: string }> : [];
  fs.rmSync(ledger, { force: true });
  return known.map(({ pid, data }) => ({ pid, data, remaining: ownedProcesses(pid, data).filter(alive) }));
}

test("D01 a launch that fails before the app is up leaves no process and reports the failure", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-ui-drill-"));
  const broken = path.join(data, "broken-host.cjs");
  fs.writeFileSync(broken, `require("electron").app.whenReady().then(() => { console.error("drill: host failed on purpose"); process.exit(3); });`);
  const env = Object.fromEntries(Object.entries({ ...scrubbedEnv(), RECORDSTUFF_UI_DATA: data }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  let failure: unknown;
  let pid: number | undefined;
  try {
    const application = await _electron.launch({ args: [broken], cwd: ROOT, env, timeout: 15_000 });
    pid = application.process().pid;
    // Connected before it exited: it must still end on its own, with its failure code.
    await expect.poll(() => application.process().exitCode, { timeout: 10_000 }).toBe(3);
  } catch (error) { failure = error; }
  const remaining = pid ? ownedProcesses(pid, data).filter(alive) : ownedProcesses(-1, data).filter(alive);
  expect(remaining, `no process of the failed launch remains${failure ? ` (launch rejected: ${String(failure).split("\n")[0]})` : ""}`).toEqual([]);
  fs.rmSync(data, { recursive: true, force: true });
});

test("D02 an assertion failure still tears the app down", async ({ launchApp }) => {
  test.fail(true, "drill: fails on purpose");
  const app = await launchApp();
  remember(app);
  expect(1, "drill: an assertion that fails").toBe(2);
});

test("D02 confirmed: the failed drill left no process", async () => {
  const gone = await rememberedAreGone();
  expect(gone.length).toBe(1);
  expect(gone.flatMap(entry => entry.remaining)).toEqual([]);
});

test("D04 a renderer crash in the view host ends normally: the page goes, the host and its cleanup stay intact", async ({ launchView }) => {
  const { launched, page } = await launchView({ mode: "components" });
  await launched.evaluate(h => h.window().webContents.forcefullyCrashRenderer());
  expect(await eventually(() => page.isClosed() || launched.evaluate(h => h.window().webContents.isCrashed()), 5000), "the page crashed").toBe(true);
  // Teardown (fixtures.ts) then closes the host normally and confirms its tree is gone; a failure there fails this test.
});

test("D05 a hung main cannot pass: its normal close times out, its own tree is killed, and the report says so", async ({ launchApp }) => {
  test.setTimeout(60_000);
  const app = await launchApp();
  remember(app);
  // Blocks main's event loop for good: normal quit can no longer run.
  void app.application.evaluate(() => { for (;;) { /* hang */ } }).catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 500));
  const report = await tearDown(app);
  // The fixture fails a test on exactly these fields; this drill expects them, so its own teardown is cleared.
  app.teardown = { ...report, closedNormally: true, forced: false, error: undefined as never };
  expect({ closedNormally: report.closedNormally, forced: report.forced, remaining: report.remaining, error: /close timed out/.test(report.error ?? "") })
    .toEqual({ closedNormally: false, forced: true, remaining: [], error: true });
});

test("D06 a call that reaches a real OS API is a containment violation that fails the test", async ({ launchApp }) => {
  test.fail(true, "drill: bypasses the boundary on purpose");
  const app = await launchApp();
  remember(app);
  // The real module, not the boundary's: its guarded register records the bypass instead of taking the key.
  await app.evaluate(h => { h.realElectron.globalShortcut.register("Control+Shift+F19", () => {}); });
});

test("D05–D06 confirmed: the hung and violating drills left no process", async () => {
  const gone = await rememberedAreGone();
  expect(gone.length).toBe(2);
  expect(gone.flatMap(entry => entry.remaining)).toEqual([]);
});

test("D06 the teardown reports a violation and a forced cleanup as failures, not as passes", async ({ launchApp }) => {
  // The same checks the fixture fails on, read from tearDown's own report.
  const app = await launchApp();
  await app.evaluate(h => { void h.realElectron.shell.openExternal("https://example.invalid/drill"); });
  const report = await tearDown(app);
  app.teardown = { ...report, violations: [] };
  expect(report.violations.map(violation => violation.kind), "the bypass is reported").toContain("shell.openExternal");
  expect({ closedNormally: report.closedNormally, forced: report.forced, remaining: report.remaining }).toEqual({ closedNormally: true, forced: false, remaining: [] });
});

test("D08 the real dialog, notification, activation and unmute paths are violations too, and none reaches the desktop", async ({ launchApp }) => {
  const app = await launchApp();
  await app.evaluate(h => h.rightClickTray());
  const waiting = app.page("settings.html");
  await app.evaluate(h => h.clickTrayItem("^Open RecordStuff$"));
  await waiting;
  await app.evaluate(h => {
    const real = h.realElectron;
    real.dialog.showErrorBox("drill", "a bypass");
    new real.Notification({ title: "drill", body: "a bypass" }).show();
    real.app.focus({ steal: true });
    h.settingsWindow().webContents.setAudioMuted(false);
  });
  const muted = await app.evaluate(h => h.settingsWindow().webContents.isAudioMuted());
  const report = await tearDown(app);
  app.teardown = { ...report, violations: [] };
  expect(muted, "an unmute request leaves the page muted").toBe(true);
  expect(report.violations.map(violation => violation.kind).sort()).toEqual(["Notification.prototype.show", "app.focus", "audio:unmute", "dialog.showErrorBox"]);
  expect({ closedNormally: report.closedNormally, remaining: report.remaining }).toEqual({ closedNormally: true, remaining: [] });
});

test("D09 a violation is still reported when the app quits itself before teardown", async ({ launchApp }) => {
  const app = await launchApp();
  await app.evaluate(h => { void h.realElectron.shell.openExternal("https://example.invalid/drill"); });
  await app.evaluate((_h, _a, electron) => { setTimeout(() => electron.app.quit(), 100); });
  await expect.poll(() => app.child.exitCode, { timeout: 15_000 }).toBe(0);
  const report = await tearDown(app);
  app.teardown = { ...report, violations: [] };
  expect({ kinds: report.violations.map(violation => violation.kind), closedNormally: report.closedNormally, remaining: report.remaining })
    .toEqual({ kinds: ["shell.openExternal"], closedNormally: true, remaining: [] });
});

test("D10 a process of someone else that names the launch's folder is neither adopted nor ended", async ({ launchApp }) => {
  test.skip(process.platform === "win32", "uses tail(1)");
  const app = await launchApp();
  const log = path.join(app.data, "electron.log");
  fs.appendFileSync(log, "");
  const watcher = spawn("tail", ["-f", log], { stdio: "ignore" });
  try {
    expect(ownedProcesses(app.pid, app.data)).not.toContain(watcher.pid);
    const report = await tearDown(app);
    expect({ watcherAlive: alive(watcher.pid!), remaining: report.remaining, forced: report.forced }).toEqual({ watcherAlive: true, remaining: [], forced: false });
  } finally { watcher.kill("SIGTERM"); }
});

/**
 * Runs drill-target.spec.ts in a child Playwright run, waits for its app, then lets it time out or interrupts the
 * runner's process group with SIGINT, and returns how the runner ended and whether the app's tree is gone.
 */
async function childRun(mode: "timeout" | "interrupt"): Promise<{ code: number | "hung"; appGone: boolean; output: string }> {
  const marker = path.join(os.tmpdir(), `recordstuff-ui-drill-${mode}-${process.pid}.json`);
  fs.rmSync(marker, { force: true });
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules/@playwright/test/cli.js"), "test", "tests/ui/drill-target.spec.ts", "--reporter=line", `--output=test-results/ui-drill-${mode}`], {
    cwd: ROOT, env: { ...scrubbedEnv(), RECORDSTUFF_UI_DRILL: mode, RECORDSTUFF_UI_DRILL_MARKER: marker }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const exited = new Promise<number>(resolve => child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : -1))));
  if (!await eventually(() => fs.existsSync(marker), 60_000)) throw new Error(`the drill target never launched its app\n${output}`);
  const target = JSON.parse(fs.readFileSync(marker, "utf8")) as { pid: number; data: string };
  const tree = ownedProcesses(target.pid, target.data);
  if (mode === "interrupt") process.kill(-child.pid!, "SIGINT");
  const code = await Promise.race([exited, new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 60_000))]);
  if (code === "hung") { try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL"); } catch { /* gone */ } }
  const appGone = await eventually(() => [...tree, ...ownedProcesses(target.pid, target.data)].every(pid => !alive(pid)), 10_000);
  fs.rmSync(marker, { force: true });
  if (appGone) fs.rmSync(target.data, { recursive: true, force: true });
  return { code, appGone, output };
}

test("D03 a test that times out fails, and its teardown still ends the app", async () => {
  test.setTimeout(120_000);
  const run = await childRun("timeout");
  expect({ code: run.code, timedOut: run.output.includes("Test timeout of 8000ms exceeded"), appGone: run.appGone }, run.output.slice(-2000))
    .toEqual({ code: 1, timedOut: true, appGone: true });
});

test("D07 an interrupted run (SIGINT to the runner) leaves no process of its app", async () => {
  test.skip(process.platform === "win32", "process-group interruption drill: macOS/Linux; Windows CI runs the other drills");
  test.setTimeout(120_000);
  const run = await childRun("interrupt");
  expect({ runnerEnded: run.code !== "hung", interrupted: run.code !== 0, appGone: run.appGone }, `runner exit ${String(run.code)}\n${run.output.slice(-2000)}`)
    .toEqual({ runnerEnded: true, interrupted: true, appGone: true });
});
