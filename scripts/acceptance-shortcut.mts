/** Deterministic failure-path integration against the production bundles; no screen recording. */
import { buildFixture } from "./lib/build-fixture.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runIsolatedProcess } from "./lib/isolated-process.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/desktop-session.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDir = path.join(root, "docs/verification/measurements", `${stamp}-shortcut-failure`);
const args = process.argv.slice(2).filter(arg => arg !== "--");
// Cleanup drills are intentional failures, not successful acceptance runs.
const drill = args[0];
if (args.length > 1 || (drill && !["--drill-failure", "--drill-timeout"].includes(drill))) {
  throw new Error("Usage: pnpm acceptance:shortcut [-- --drill-failure|--drill-timeout]");
}
for (const file of ["out/main/index.js", "out/preload/settings.js", "out/renderer/settings.html"]) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing ${file}; run pnpm build first.`);
}
// Real windows, focus and shortcut registration need an awake, unlocked desktop.
const desktop = await beginDesktopRound().catch((cause: unknown) => {
  if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message}`); process.exit(DESKTOP_BLOCKED_EXIT); }
  throw cause;
});
fs.mkdirSync(reportDir, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-shortcut-test-"));
const logFd = fs.openSync(path.join(reportDir, "electron.log"), "w");
const controller = new AbortController();
const interrupt = (): void => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const env = { ...process.env };
for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "RECORDSTUFF_AUTORECORD", "NODE_OPTIONS"]) delete env[key];
type Execution = Awaited<ReturnType<typeof runIsolatedProcess>>;
interface Result {
  cases: Array<{ name: string; ok: boolean; detail: string }>;
  cleanup?: { windows: number; registered: boolean; suspended: boolean; trayDestroyed: boolean };
}
const phases: Array<{ name: string; execution: Execution; result?: Result }> = [];
let error: string | undefined;
let groupsGone = true;
const resultPassed = (result: Result | undefined): boolean => Boolean(result?.cases.length
  && result.cases.every(test => test.ok) && result.cleanup?.windows === 0
  && !result.cleanup.registered && !result.cleanup.suspended && result.cleanup.trayDestroyed);
try {
  const fixture = await buildFixture("shortcut-failure", reportDir);
  const executable = require("electron") as string;
  for (const name of drill ? [drill] : ["normal", "restart", "settings"]) {
    controller.signal.throwIfAborted();
    const phaseDir = path.join(reportDir, name);
    fs.mkdirSync(phaseDir);
    groupsGone = false; // Unknown until the process supervisor confirms cleanup.
    const execution = await runIsolatedProcess({
      executable, args: [fixture, root, temporary, phaseDir, name],
      cwd: root, env, logFd, timeoutMs: name === "--drill-timeout" ? 8000 : 60_000,
      signal: controller.signal,
    });
    groupsGone = execution.groupGone;
    const phase: (typeof phases)[number] = { name, execution };
    phases.push(phase);
    const resultsFile = path.join(phaseDir, "results.json");
    if (fs.existsSync(resultsFile)) phase.result = JSON.parse(fs.readFileSync(resultsFile, "utf8")) as Result;
    if (execution.error || execution.code !== 0 || execution.stopped || !groupsGone || !resultPassed(phase.result)) break;
  }
} catch (cause) {
  error = String(cause);
} finally {
  desktop.end();
  fs.closeSync(logFd);
  // Build failures have no child; unknown process status retains data for diagnosis.
  if (groupsGone) fs.rmSync(temporary, { recursive: true, force: true });
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
const clean = groupsGone && !fs.existsSync(temporary);
const passed = !error && !drill && phases.length === 3 && clean && phases.every(phase =>
  !phase.execution.error && phase.execution.code === 0 && !phase.execution.stopped
  && phase.execution.groupGone && resultPassed(phase.result));
const summary = { passed, blocked: desktop.lockedAt !== undefined, desktop: desktop.summary, phases, error, temporary, temporaryRemoved: !fs.existsSync(temporary) };
fs.writeFileSync(path.join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(reportDir, "report.md"), [
  "# Shortcut failure integration", "", `Result: ${desktop.lockedAt ? "BLOCKED" : passed ? "PASS" : "FAIL"}`, "", desktop.summary, "",
  "Production main, settings IPC/preload/page and persistence; real Electron registration returns false via test-only suspension.",
  "Settings phase uses a controlled registration adapter to test legacy conflict, real-window restore and renderer crash, and a fixture-only settings.json rename gate to hold confirmed saves; key and mouse input are Chromium input events, not OS delivery. Notification.show is observed, not delivered. Tray and capture-permission adapters are isolated. No OS banner or recording claim.", "",
  ...phases.flatMap(phase => (phase.result?.cases ?? []).map(test => `- ${test.ok ? "PASS" : "FAIL"} [${phase.name}]: ${test.name} — ${test.detail}`)), "",
  `Cleanup: all groups gone=${groupsGone}; temp removed=${!fs.existsSync(temporary)}.`,
  `Error: ${error ?? "none"}. Phase exit/stop details: summary.json; electron.log.`, "",
].join("\n"));
console.log(`${desktop.lockedAt ? "BLOCKED" : passed ? "PASS" : "FAIL"}: shortcut failure integration; cleanup=${clean ? "complete" : "INCOMPLETE"}\n${reportDir}`);
process.exitCode = desktop.lockedAt ? DESKTOP_BLOCKED_EXIT : passed ? 0 : 1;
