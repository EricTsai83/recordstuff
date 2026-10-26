/**
 * Playwright fixtures for the background UI and integration suite (plan 066, docs/testing.md). Each launch is a
 * hidden, offscreen Electron on the production `out/` pages and preloads, in its own temporary userData, logs and
 * videos, with the inherited runner variables scrubbed. Two hosts:
 *
 * - `launchApp`: the production main (`out/main/index.js`) with only the OS boundary replaced (hosts/boundary.ts).
 *   Its evidence is production IPC, storage, window controllers and pages; OS effects are adapter calls.
 * - `launchView`: a fixture main that serves the production page and preload with the real `settingsView`,
 *   `RecordingResults` and `RecordingsLibrary`, but its own IPC handlers (hosts/view-host.ts). Its evidence is
 *   the page, the preload boundary, the IPC round trip and the media protocol, not `SettingsWindow`.
 *
 * Teardown, on pass, failure, timeout or interruption: the boundary is audited (a visible or focused native window,
 * an onscreen or unmuted page, or a call that reached a real OS API fails the test), the app is closed normally,
 * and every process of its tree is confirmed gone. A tree that needed killing, or whose end cannot be confirmed,
 * fails the test and keeps its temporary folder for diagnosis. Never touches a process it did not launch.
 */
import { test as base, expect, _electron, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scrubbedEnv } from "../../scripts/lib/runner/runner-env.mts";
import type { Boundary, AdapterCall, Violation } from "./hosts/boundary";
import { DesktopProbe, type ProbeReport } from "./desktop-probe";
import { processTableRows } from "./process-table";
import { ProcessOwnership } from "./process-ownership";

export { expect };
export const ROOT = path.resolve(__dirname, "../..");
const CLOSE_TIMEOUT_MS = 15_000;
/**
 * How long the rest of a launch's processes may take to end after its main process exited. Chromium's helpers end on
 * their own once main is gone, and on CI's Windows runners some took seconds to (plan 078 step 5: main exited 70–100 ms
 * into every close, the slowest helpers 1.8–7.7 s later), so Windows waits longer; a helper still running then is killed
 * and fails the test.
 */
const EXIT_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 5_000;
const SCAN_INTERVAL_MS = 1_000;
/** One line per launch's teardown (plan 078 step 5), read by `scripts/ui-close-timings.mts`. */
export const CLOSE_TIMINGS_FILE = path.join(process.cwd(), "test-results", "ui-close-timings.jsonl");

/**
 * A worker that dies between tests is reported by Playwright as "worker process exited unexpectedly" with nothing
 * else (Windows runners, 2026-10-08). The monitor only records what ended it, beside the run's other evidence; it
 * neither catches nor changes the crash.
 */
const WORKER_LOG = path.join(ROOT, "test-results", "ui", "worker-exits.log");
const recordWorker = (line: string): void => {
  try { fs.mkdirSync(path.dirname(WORKER_LOG), { recursive: true }); fs.appendFileSync(WORKER_LOG, `${new Date().toISOString()} pid ${process.pid} ${line}\n`); }
  catch { /* Evidence only. */ }
};
process.on("uncaughtExceptionMonitor", (error, origin) => {
  recordWorker(`${origin}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});
// Inside process.exit the stack names its caller; a worker that ran out of work names only Node's own frames.
process.on("exit", code => { if (code !== 0) recordWorker(`exit ${code}: ${new Error("exit").stack ?? ""}`); });

/** Stored preferences the app host starts from; anything not given takes the production default. */
export interface SeedSettings {
  language?: "en" | "zh-TW";
  appearance?: "system" | "light" | "dark";
  hotkey?: { enabled: boolean; accelerator: string };
  notifications?: boolean;
  outputDir?: string;
  countdown?: number;
  countdownSound?: boolean;
  trayClick?: "menu" | "record";
  [key: string]: unknown;
}

export interface LaunchAppOptions {
  /** Simulates an offline update check before production startup, avoiding live network requests. */
  offline?: boolean;
  /** Written as settings.json before launch; `false` launches with no settings file at all. */
  settings?: SeedSettings | false;
  /** Saved Settings window size (settings-window.json). */
  windowSize?: { width: number; height: number };
  /** Accelerators whose registration fails from the start; `"*"` fails all. */
  failingShortcuts?: string[];
  /** Reuses an earlier launch's data folder: a restart of the same app. */
  data?: string;
}

/** One launched Electron: its Playwright handle, folders and process. */
export class Launched {
  readonly pageErrors: string[] = [];
  /** Console errors a test expects (a resource it serves as missing on purpose); every other one fails it. */
  readonly expectedErrors: RegExp[] = [];
  readonly pages: Page[] = [];
  readonly probe: DesktopProbe;
  /** Electron's main process, kept from launch: the handle stays readable after it exits. */
  readonly child: ChildProcess;
  readonly ownership: ProcessOwnership;
  closed = false;
  /** The teardown a test ran itself (`close`), which the fixture reports instead of running another. */
  teardown: Teardown | undefined;
  constructor(readonly kind: "app" | "view", readonly application: ElectronApplication, readonly data: string, readonly pid: number) {
    this.probe = new DesktopProbe(pid);
    this.child = application.process();
    this.ownership = new ProcessOwnership(pid, data, electronExecutable(), process.pid);
    const watch = (page: Page): void => {
      this.pages.push(page);
      page.on("pageerror", error => this.pageErrors.push(`${page.url().split("?")[0]!.split("/").pop()}: ${error.message}`));
      page.on("console", message => {
        if (message.type() !== "error") return;
        const text = `${page.url().split("?")[0]!.split("/").pop()}: ${message.text()}${message.location().url ? ` (${message.location().url})` : ""}`;
        if (!this.expectedErrors.some(pattern => pattern.test(text))) this.pageErrors.push(text);
      });
    };
    for (const page of application.windows()) watch(page);
    application.on("window", watch);
  }
  /** Runs `fn` in the host's main process with its test controls (`globalThis.__recordstuff`). */
  evaluate<R, A = undefined>(fn: (host: HostGlobals, arg: A, electron: typeof import("electron")) => R | Promise<R>, arg?: A): Promise<R> {
    return this.application.evaluate((electron, [source, value]) => {
      const host = (globalThis as unknown as { __recordstuff: unknown }).__recordstuff;
      // eslint-disable-next-line no-new-func
      return (new Function("host", "arg", "electron", `return (${source})(host, arg, electron);`) as (host: unknown, arg: unknown, electron: unknown) => unknown)(host, value, electron);
    }, [fn.toString(), arg] as const) as Promise<R>;
  }
  /**
   * The next page whose URL contains `fragment`, or one already open, once its document has committed. Playwright
   * reports a window by the URL it is loading, before main's `webContents.getURL()` has it, so a host control that
   * finds the window by its URL (`settingsWindow`) could still miss it on a slow runner (2026-10-08, macOS CI).
   */
  async page(fragment: string, timeout = 10_000): Promise<Page> {
    const page = this.application.windows().find(candidate => candidate.url().includes(fragment)) ??
      await this.application.waitForEvent("window", { predicate: candidate => candidate.url().includes(fragment), timeout });
    await page.waitForLoadState("domcontentloaded", { timeout });
    return page;
  }
  calls(): Promise<AdapterCall[]> { return this.evaluate(host => host.boundary.calls); }
  /** Audits, quits normally and confirms the end of this launch now (a restart); its findings fail the test at teardown. */
  async close(): Promise<Teardown> { this.teardown = await tearDown(this); return this.teardown; }
}

/** The host's test controls, as `Launched.evaluate` sees them. Functions run in Electron main. */
export interface HostGlobals {
  kind: "app" | "view";
  boundary: Boundary;
  [control: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * The processes one launch owns, from one process-table snapshot: every pid whose parent chain reaches its main
 * process, and every process whose command line names its unique temporary folder (a helper that outlived main,
 * such as the local-data cleanup worker, is reparented away from it).
 */
export async function ownedProcesses(root: number, marker: string): Promise<number[]> {
  return new ProcessOwnership(root, marker, electronExecutable(), process.pid).read(await processTableRows()).map(row => row.pid);
}

/** The command line each pid last had in a table read, to name a process a teardown could not end. */
const lastCommands = new Map<number, string>();
export const describeProcess = (pid: number): string => {
  const command = lastCommands.get(pid);
  return command ? `${pid} (${command.length > 160 ? `${command.slice(0, 160)}…` : command})` : String(pid);
};

/** The checkout's Electron executable, as its processes' command lines start (pnpm's symlinks resolved). */
let executablePath: string | undefined;
export function electronExecutable(): string {
  executablePath ??= fs.realpathSync(createRequire(__filename)("electron") as string);
  return executablePath;
}

export const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

const until = async (check: () => boolean | Promise<boolean>, timeout: number): Promise<boolean> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return true; await new Promise(resolve => setTimeout(resolve, 50)); }
  return check();
};

/** What one launch's teardown found; a failure in any part fails the test. */
export interface Teardown {
  violations: Violation[];
  desktop?: ProbeReport;
  closedNormally: boolean;
  forced: boolean;
  remaining: number[];
  pageErrors: string[];
  error?: string;
  /**
   * How long each part of the teardown took, in ms (plan 078 step 5): the boundary audit, the normal close (which a
   * timeout ends at `CLOSE_TIMEOUT_MS`), and the wait for every process to end, including after a timed-out close.
   */
  phases?: { audit?: number; close?: number; exit?: number; killed?: boolean; quit?: Record<string, number> };
}

/**
 * Audits, closes and confirms the end of one launch. Exported for the cleanup drills, which call it on a launch they
 * broke on purpose; the fixture calls it for every launch a test made.
 */
export async function tearDown(launched: Launched): Promise<Teardown> {
  const result: Teardown = { violations: [], closedNormally: false, forced: false, remaining: [], pageErrors: launched.pageErrors };
  const errors: string[] = [];
  /** Every process seen to belong to the launch, rescanned while it shuts down: a helper started by quit counts too. */
  let tree: number[] = [launched.pid];
  // A read is a CIM query on Windows (process-table.ts), so waiting for the end rescans about once a second, not per poll.
  let scanned = 0;
  const scan = async (): Promise<boolean> => {
    scanned = Date.now();
    try {
      const owned = launched.ownership.read(await processTableRows());
      tree = owned.map(row => row.pid);
      for (const row of owned) lastCommands.set(row.pid, row.command);
      return true;
    }
    catch (error) { if (!errors.some(text => text.startsWith("process table"))) errors.push(`process table unreadable: ${describeFailure(error)}`); }
    return false;
  };
  await scan();
  result.desktop = await launched.probe.stop();
  const phases: NonNullable<Teardown["phases"]> = {};
  result.phases = phases;
  let lap = Date.now();
  const elapsed = (): number => { const now = Date.now(), ms = now - lap; lap = now; return ms; };
  if (launched.child.exitCode === null && launched.child.signalCode === null && !launched.closed) {
    try { await Promise.race([launched.evaluate(host => { host.prepareClose?.(); host.boundary.audit(); }), timeoutAfter(5000, "audit")]); }
    catch (error) { errors.push(`boundary audit failed: ${String(error)}`); }
    phases.audit = elapsed();
    await scan();
    elapsed();
    const closeStarted = Date.now();
    // A normal close is production's quit ending the main process. Playwright's own close resolves only once every
    // process holding the launch's output has ended, which on Windows included helpers that lingered after main had
    // exited (plan 078 step 5); their end is the exit wait's to confirm below, not the close's.
    const child = launched.child;
    const mainExited = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    const closing = launched.application.close();
    closing.catch(() => undefined);
    try {
      await Promise.race([Promise.race([mainExited, closing]), timeoutAfter(CLOSE_TIMEOUT_MS, "close")]);
      result.closedNormally = true;
    } catch (error) { errors.push(`normal close failed: ${String(error)}`); }
    phases.close = elapsed();
    // The host's quit steps (hosts/boundary.ts), in ms after the close began, read from its log once it has ended.
    phases.quit = { started: closeStarted };
  } else {
    // It ended before teardown: normally only when it quit itself with success (a test that quits the app).
    result.closedNormally = launched.closed || launched.child.exitCode === 0;
    if (!result.closedNormally) errors.push(`exited before teardown (code ${launched.child.exitCode}, signal ${launched.child.signalCode})`);
  }
  launched.closed = true;
  scanned = 0; // the first check after close always rescans: a helper started by quit counts too
  const ended = (): boolean => [...tree].every(pid => !alive(pid));
  // The end is only confirmed by a table read after every known process ended: one started late is found then.
  const gone = async (): Promise<boolean> => {
    const before = scanned;
    if (Date.now() - scanned >= SCAN_INTERVAL_MS) await scan();
    if (!ended()) return false;
    if (scanned === before) await scan();
    return ended();
  };
  const exited = await until(gone, EXIT_TIMEOUT_MS);
  phases.exit = elapsed();
  if (!exited) {
    // Only processes this launch owns are ever signalled: its main's descendants and its own Electron helpers.
    result.forced = true;
    phases.killed = true;
    // A failed read must never authorize signalling identities from an older snapshot.
    if (await scan()) for (const pid of [...tree].reverse()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await until(gone, EXIT_TIMEOUT_MS);
  }
  result.remaining = [...tree].filter(alive);
  if (phases.quit) {
    const started = phases.quit.started!;
    const steps: Record<string, number> = {};
    try {
      for (const match of fs.readFileSync(path.join(launched.data, "electron.log"), "utf8").matchAll(/^\[quit\] (.+) at (\d+)$/gm)) steps[match[1]!] ??= Number(match[2]) - started;
    } catch { /* no log */ }
    phases.quit = steps;
  }
  // The boundary appended every violation as it happened, so a launch that quit itself or hung still reports them.
  const file = path.join(launched.data, "violations.jsonl");
  try {
    if (fs.existsSync(file)) result.violations = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Violation);
  } catch (error) { errors.push(`violations unreadable: ${String(error)}`); }
  if (errors.length) result.error = errors.join("; ");
  return result;
}

/**
 * A failed command with its exit status and stderr: 3221225794 (0xC0000142, STATUS_DLL_INIT_FAILED) means Windows
 * could not start the process at all, a runner-wide condition rather than a fault in the launch under test.
 */
const describeFailure = (error: unknown): string => {
  const { status, signal, stderr } = error as { status?: number | null; signal?: string | null; stderr?: string | Buffer };
  const details = [
    status != null ? `status ${status}${status > 0xffff ? ` (0x${status.toString(16).toUpperCase()})` : ""}` : "",
    signal ? `signal ${signal}` : "",
    String(stderr ?? "").trim().slice(0, 500),
  ].filter(Boolean);
  return `${String(error).split("\n")[0]}${details.length ? ` [${details.join("; ")}]` : ""}`;
};

const timeoutAfter = <T = never>(ms: number, what: string): Promise<T> =>
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms).unref());

/** Default stored preferences for the app host: English, no network, no shortcut taken, notifications allowed. */
export function seedSettings(data: string, seed: SeedSettings = {}): Record<string, unknown> {
  return {
    version: 4,
    outputDir: path.join(data, "videos/RecordStuff"),
    quality: { videoQuality: "standard", resolutionCap: "source", frameRate: 30 },
    language: "en",
    hotkey: { enabled: false, accelerator: "Control+Shift+F20" },
    appearance: "light",
    notifications: true,
    updates: { enabled: false },
    trayClick: "menu",
    ...seed,
  };
}

const hostsDir = (): string => {
  const dir = process.env.RECORDSTUFF_UI_HOSTS;
  if (!dir) throw new Error("RECORDSTUFF_UI_HOSTS is not set: run through `pnpm test:ui` (playwright.config.ts global setup)");
  return dir;
};

async function launch(kind: "app" | "view" | "countdown", data: string, extra: Record<string, string>, testInfo: TestInfo): Promise<Launched> {
  const env = Object.fromEntries(Object.entries(scrubbedEnv()).filter((entry): entry is [string, string] => entry[1] !== undefined));
  Object.assign(env, { RECORDSTUFF_UI_ROOT: ROOT, RECORDSTUFF_UI_DATA: data, ...extra });
  const application = await _electron.launch({
    args: [path.join(hostsDir(), `${kind}-host.cjs`)],
    // `null`: no emulated colour scheme, so the pages follow `nativeTheme` as in the app (Playwright emulates light by default).
    cwd: ROOT, env, timeout: 20_000, colorScheme: null,
  });
  const pid = application.process().pid;
  if (!pid) throw new Error("Electron started without a pid");
  application.process().stdout?.on("data", chunk => { fs.appendFileSync(path.join(data, "electron.log"), chunk); });
  application.process().stderr?.on("data", chunk => { fs.appendFileSync(path.join(data, "electron.log"), chunk); });
  // Playwright's `trace`/`screenshot` options reach only browser contexts its fixtures create, never an Electron launch:
  // its trace is started here, and kept with screenshots of its windows only when the test fails (`keepEvidence`).
  // DOM snapshots only: the screencast adds work to every frame of every case, where the timings are asserted.
  // Bounded, as every step around a launch is: a start that hangs must not keep the launch from its caller, which
  // registers it for teardown.
  await Promise.race([application.context().tracing.start({ title: testInfo.titlePath.slice(1).join(" › "), snapshots: true, screenshots: false }),
    timeoutAfter(5000, "starting the trace")])
    .catch((error: unknown) => console.warn(`ui: the launch's trace could not start: ${String(error)}`));
  return new Launched(kind === "countdown" ? "view" : kind, application, data, pid);
}

export interface Fixtures {
  /** Launches the production main; resolves once it has logged `ready;`. */
  launchApp: (options?: LaunchAppOptions) => Promise<Launched>;
  /** Launches the view host (`panel`: the former settings fixture; `components`: the synthetic view); resolves once its page has loaded. */
  /** `env`: the host's own variables, as the thumbnail measurement sets them (hosts/view-host.ts `measuredFolder`). */
  launchView: (options?: { mode?: "panel" | "components"; env?: Record<string, string> }) => Promise<{ launched: Launched; page: Page }>;
  /** Launches the countdown host; resolves once the production overlay is constructed. */
  launchCountdown: () => Promise<Launched>;
  /** Every launch this test made, for tests that inspect teardown. */
  launches: Launched[];
}

const launchers = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  launches: async ({}, use) => { await use([]); },
  launchApp: async ({ launches }, use, testInfo) => {
    await use(async (options = {}) => {
      const data = options.data ?? fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-ui-app-"));
      for (const name of ["userData", "logs", "videos/RecordStuff"]) fs.mkdirSync(path.join(data, name), { recursive: true });
      fs.writeFileSync(path.join(data, "userData/tray-hint-shown"), "");
      if (options.settings !== false && (!options.data || options.settings)) {
        fs.writeFileSync(path.join(data, "userData/settings.json"), JSON.stringify(seedSettings(data, options.settings || {}), null, 2));
      }
      if (options.windowSize) fs.writeFileSync(path.join(data, "userData/settings-window.json"), JSON.stringify(options.windowSize));
      fs.rmSync(path.join(data, "logs/recordstuff.log"), { force: true });
      const launched = await launch("app", data, { RECORDSTUFF_UI_FAILING_SHORTCUTS: (options.failingShortcuts ?? []).join(","), RECORDSTUFF_UI_OFFLINE: options.offline ? "1" : "0" }, testInfo);
      launches.push(launched);
      // Register for teardown before the read can fail; record identity before the test can quit main.
      launched.ownership.read(await processTableRows());
      const log = path.join(data, "logs/recordstuff.log");
      await expect.poll(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("ready;"), { message: "production main logged ready;", timeout: 15_000 }).toBe(true);
      return launched;
    });
  },
  launchCountdown: async ({ launches }, use, testInfo) => {
    await use(async () => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-ui-countdown-"));
      const launched = await launch("countdown", data, {}, testInfo);
      launches.push(launched);
      launched.ownership.read(await processTableRows());
      await expect.poll(() => launched.evaluate(h => h.ready === true), { message: "countdown host ready" }).toBe(true);
      return launched;
    });
  },
  launchView: async ({ launches }, use, testInfo) => {
    await use(async (options = {}) => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-ui-view-"));
      const launched = await launch("view", data, { ...options.env, RECORDSTUFF_UI_VIEW: options.mode ?? "panel" }, testInfo);
      launches.push(launched);
      launched.ownership.read(await processTableRows());
      const page = await launched.page("settings.html");
      await page.waitForLoadState("domcontentloaded");
      return { launched, page };
    });
  },
});

/**
 * A launch still open when its test failed: its trace and a picture of each of its windows, attached to the test (in
 * test-results/ui/, which CI uploads). A test that passed discards the trace. Bounded, so a launch that hangs still
 * reaches its teardown.
 */
async function keepEvidence(launched: Launched, index: number, failed: boolean, testInfo: TestInfo): Promise<void> {
  const tracing = launched.application.context().tracing;
  if (!failed) { await Promise.race([tracing.stop(), timeoutAfter(5000, "discarding the trace")]).catch(() => undefined); return; }
  for (const [n, page] of launched.application.windows().entries()) {
    const file = testInfo.outputPath(`launch-${index}-window-${n}-${page.url().split("?")[0]!.split("/").pop() || "page"}.png`);
    try {
      await Promise.race([page.screenshot({ path: file }), timeoutAfter(5000, "a screenshot")]);
      await testInfo.attach(path.basename(file, ".png"), { path: file, contentType: "image/png" });
    } catch { /* A window that closed or cannot draw: the trace still holds its DOM. */ }
  }
  const trace = testInfo.outputPath(`launch-${index}-trace.zip`);
  try {
    await Promise.race([tracing.stop({ path: trace }), timeoutAfter(10_000, "saving the trace")]);
    await testInfo.attach(`launch-${index}-trace`, { path: trace, contentType: "application/zip" });
  } catch { /* Evidence only: the failure itself is the test's. */ }
}

// Teardown for every launch, in its own fixture so it runs after the test body on every outcome.
export const test = launchers.extend<{ containment: void }>({
  containment: [async ({ launches }, use, testInfo) => {
    await use();
    const failed = testInfo.status !== testInfo.expectedStatus;
    for (const [index, launched] of launches.entries()) {
      if (!launched.closed && !launched.teardown) await keepEvidence(launched, index, failed, testInfo);
    }
    const reports: Array<Teardown & { kind: string; data: string }> = [];
    for (const launched of launches) reports.push({ kind: launched.kind, data: launched.data, ...launched.teardown ?? await tearDown(launched) });
    await testInfo.attach("teardown.json", { body: JSON.stringify(reports, null, 2), contentType: "application/json" });
    // Every launch's close, passing or not, for the job's summary of the slowest (scripts/ui-close-timings.mts).
    try {
      const timings = reports.map(report => JSON.stringify({ test: testInfo.titlePath.slice(1).join(" › "), kind: report.kind, closedNormally: report.closedNormally, ...report.phases }));
      fs.mkdirSync(path.dirname(CLOSE_TIMINGS_FILE), { recursive: true });
      fs.appendFileSync(CLOSE_TIMINGS_FILE, timings.map(line => `${line}\n`).join(""));
    } catch { /* a diagnostic only */ }
    if (process.env.RECORDSTUFF_UI_VERBOSE) console.log(JSON.stringify(reports.map(({ data: _data, ...report }) => report)));
    const problems = reports.flatMap(report => [
      ...report.violations.map(violation => `${report.kind}: containment violation ${violation.kind}: ${violation.detail}`),
      ...(report.desktop?.onscreen.map(sample => `${report.kind}: a window was on screen: ${JSON.stringify(sample.onscreen)}`) ?? []),
      ...(report.desktop?.frontmost.length ? [`${report.kind}: the test app became the frontmost app (${report.desktop.frontmost.length} samples)`] : []),
      ...(report.desktop?.supported && !report.desktop.samples ? [`${report.kind}: the window server could not be sampled: ${report.desktop.errors.join("; ")}`] : []),
      // A supervision or audit error means containment or cleanup was not confirmed: never a pass.
      ...(report.error && report.closedNormally ? [`${report.kind}: ${report.error}`] : []),
      ...(report.closedNormally ? [] : [`${report.kind}: did not close normally (${report.error ?? "unknown"})`]),
      ...(report.forced ? [`${report.kind}: process tree needed SIGKILL`] : []),
      ...(report.remaining.length ? [`${report.kind}: processes still running: ${report.remaining.map(describeProcess).join(", ")}`] : []),
      ...report.pageErrors.map(error => `${report.kind}: page error ${error}`),
    ]);
    for (const report of reports) {
      if (problems.length || testInfo.status !== testInfo.expectedStatus) {
        for (const file of ["electron.log", "logs/recordstuff.log"]) {
          const log = path.join(report.data, file);
          if (fs.existsSync(log)) await testInfo.attach(`${report.kind}-${path.basename(file)}`, { path: log });
        }
      }
      // A tree whose end is confirmed leaves nothing; otherwise, or when supervision failed, its folder stays for
      // diagnosis. A restart shares its folder.
      if (!reports.some(other => other.data === report.data && (other.remaining.length || other.error))) {
        // Windows can keep profile handles locked briefly after a killed process disappears from CIM.
        // Bounded retries allow those handles to drain; a persistent lock still fails and retains evidence.
        try { await fs.promises.rm(report.data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
        catch (error) { problems.push(`${report.kind}: temporary folder cleanup failed: ${String(error)}`); }
      }
    }
    expect(problems, "containment and cleanup").toEqual([]);
  }, { auto: true }],
});
