/**
 * `pnpm acceptance:shortcut-native [-- --drill-failure|--drill-timeout]` (plan 066): the shortcut cases that need the
 * desktop, against the production bundles: Electron's real registration refused through `setSuspended`, and real
 * Settings window state (minimize, restore, focus, the platform close key and reopening). Every other former
 * `acceptance:shortcut` case runs in the background suite (tests/ui/shortcut-integration.spec.ts, `pnpm test:ui`).
 * A desktop round: it shows and focuses windows, so it follows the readiness handoff in docs/testing.md. No screen
 * recording. The drills are intentional failures that exercise this runner's cleanup.
 */
import { buildFixture } from "./lib/runner/build-fixture.mts";
import { scrubbedEnv, runnerArgs } from "./lib/runner/runner-env.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runIsolatedProcess } from "./lib/runner/isolated-process.mts";
import { roundExit } from "./lib/runner/round-exit.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/runner/desktop-session.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDir = path.join(root, "docs/verification/measurements", `${stamp}-shortcut-native`);
const args = runnerArgs();
// Cleanup drills are intentional failures, not successful acceptance runs.
const drill = args[0];
// A usage error or a missing build is not a failed round: exit 2, as the other runners do.
if (args.length > 1 || (drill && !["--drill-failure", "--drill-timeout"].includes(drill))) {
  console.error("Usage: pnpm acceptance:shortcut-native [-- --drill-failure|--drill-timeout]");
  process.exit(2);
}
for (const file of ["out/main/index.js", "out/preload/settings.js", "out/renderer/settings.html"]) {
  if (!fs.existsSync(path.join(root, file))) { console.error(`BLOCKED: missing ${file}; run pnpm build first.`); process.exit(2); }
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
/** The first signal names the exit code (round-exit.mts). */
let interruptedBy: "SIGINT" | "SIGTERM" | undefined;
const interrupt = (name: "SIGINT" | "SIGTERM") => (): void => { interruptedBy ??= name; controller.abort(); };
const onSigint = interrupt("SIGINT"), onSigterm = interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
const env = scrubbedEnv();
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
  for (const name of drill ? [drill] : ["registration", "windows"]) {
    controller.signal.throwIfAborted();
    const phaseDir = path.join(reportDir, name);
    fs.mkdirSync(phaseDir);
    groupsGone = false; // Unknown until the process supervisor confirms cleanup.
    const execution = await runIsolatedProcess({
      executable, args: [fixture, root, temporary, phaseDir, name],
      cwd: root, env, logFd, timeoutMs: name === "--drill-timeout" ? 8000 : 90_000,
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
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}
const clean = groupsGone && !fs.existsSync(temporary);
const passed = !error && !drill && phases.length === 2 && clean && phases.every(phase =>
  !phase.execution.error && phase.execution.code === 0 && !phase.execution.stopped
  && phase.execution.groupGone && resultPassed(phase.result));
const end = roundExit({ cleanupIncomplete: !clean, interrupted: interruptedBy, locked: desktop.lockedAt !== undefined, failed: !passed });
const result = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED", interrupted: `INTERRUPTED (${interruptedBy})` }[end.outcome];
const summary = { passed, outcome: end.outcome, blocked: desktop.lockedAt !== undefined, desktop: desktop.summary, phases, error, temporary, temporaryRemoved: !fs.existsSync(temporary) };
fs.writeFileSync(path.join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(reportDir, "report.md"), [
  "# Shortcut native acceptance", "", `Result: ${result}`, "", desktop.summary, "",
  "Production main, settings IPC/preload/page and persistence. Registration phase: Electron's real registration returns false through test-only suspension.",
  "Windows phase: a controlled registration adapter, so the callbacks are called as the OS would, on real, shown and focused windows: minimize, restore, focus, the platform close key and reopening. Key and mouse input are Electron input events, not OS delivery. Notification.show is observed, not delivered. Tray and capture-permission adapters are isolated. No OS banner or recording claim. Every other shortcut case: `pnpm test:ui` (tests/ui/shortcut-integration.spec.ts).", "",
  ...phases.flatMap(phase => (phase.result?.cases ?? []).map(test => `- ${test.ok ? "PASS" : "FAIL"} [${phase.name}]: ${test.name} — ${test.detail}`)), "",
  `Cleanup: all groups gone=${groupsGone}; temp removed=${!fs.existsSync(temporary)}.`,
  `Error: ${error ?? "none"}. Phase exit/stop details: summary.json; electron.log.`, "",
].join("\n"));
console.log(`${result}: shortcut native acceptance; cleanup=${clean ? "complete" : "INCOMPLETE"}\n${reportDir}`);
process.exitCode = end.code;
