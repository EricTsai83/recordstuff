/**
 * Keyboard-layout shortcut check against the production bundle; no recording.
 * Temporarily selects an enabled input source whose number row types no
 * digits, checks that a digit shortcut still fires from the number row and not
 * the keypad, and restores the input source (docs/system-design/tooling.md#keyboard-layout-shortcut-check).
 */
import { buildFixture } from "./lib/build-fixture.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runIsolatedProcess } from "./lib/isolated-process.mts";
import { command } from "./lib/acceptance-runtime.mts";
import { DesktopBlockedError, beginDesktopRound, type DesktopRound } from "./lib/desktop-session.mts";
import {
  INPUT_SOURCE_SCRIPT, InputSourceGuard, LAYOUT_ACCELERATOR, classify, layoutVerdict, needsActivation, orderCandidates,
  otherRecordStuffProcesses, parseSources, parseState, type Execution, type FixtureCleanup, type KeyResult, type LayoutState, type RestoreRecord,
} from "./lib/shortcut-layout.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const usage = "Usage: pnpm acceptance:shortcut-layout [-- --source <input source id>] [-- --drill-layout-aware]";
const args = process.argv.slice(2).filter(arg => arg !== "--");
let requested: string | undefined;
let drill = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--drill-layout-aware" && !drill) drill = true;
  else if (args[i] === "--source" && !requested && args[i + 1] && !args[i + 1]!.startsWith("--")) requested = args[++i];
  else throw new Error(usage);
}

class Blocked extends Error {}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDir = path.join(root, "docs/verification/measurements", `${stamp}-shortcut-layout${drill ? "-drill" : ""}`);
fs.mkdirSync(reportDir, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-shortcut-layout-"));
const helper = path.join(temporary, "input-source.js");
fs.writeFileSync(helper, INPUT_SOURCE_SCRIPT);
const logFd = fs.openSync(path.join(reportDir, "electron.log"), "w");
const controller = new AbortController();
let interruptedBy: string | undefined;
// Stay installed through the restore, so a second Ctrl+C cannot skip it.
const interrupt = (signal: NodeJS.Signals): void => { interruptedBy ??= signal; controller.abort(new Error(`interrupted: ${signal}`)); };
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const env = { ...process.env };
for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "RECORDSTUFF_AUTORECORD", "NODE_OPTIONS"]) delete env[key];
const log = (line: string): void => console.log(line);

interface FixtureResult {
  mode: string;
  accelerator: string;
  disableFeatures: string | null;
  attempts: Array<{ accelerator: string; registered: boolean }>;
  keys: KeyResult[];
  blocked?: string;
  error?: string;
  cleanup: FixtureCleanup & { trayDestroyed: boolean };
}
interface Attempt { source: string; activated: boolean; activationFocused?: boolean; state?: LayoutState; qualifies: boolean; reason: string }
const blocked: string[] = [];
const attempts: Attempt[] = [];
const executions: Array<Execution & { groupGone: boolean }> = [];
let error: string | undefined;
let desktop: DesktopRound | undefined;
let guard: InputSourceGuard | undefined;
let original: LayoutState | undefined;
let during: LayoutState | undefined;
let after: LayoutState | undefined;
let restored: LayoutState | undefined;
let restore: RestoreRecord | undefined;
let fixture: FixtureResult | undefined;

const helperCall = (argv: string[], signal = controller.signal) => command("osascript", ["-l", "JavaScript", helper, ...argv], signal);
const readState = async (signal?: AbortSignal) => parseState(await helperCall(["state"], signal));
async function pollState(until: (state: LayoutState) => boolean, ms: number): Promise<LayoutState> {
  const deadline = Date.now() + ms;
  let state = await readState();
  while (!until(state) && Date.now() < deadline) {
    await delay(200, undefined, { signal: controller.signal });
    state = await readState();
  }
  return state;
}
async function run(phase: string, mode: string, fixturePath: string, timeoutMs: number) {
  const phaseDir = path.join(reportDir, phase);
  fs.mkdirSync(phaseDir, { recursive: true });
  const execution = await runIsolatedProcess({
    executable: require("electron") as string, args: [fixturePath, root, temporary, phaseDir, mode],
    cwd: root, env, logFd, timeoutMs, signal: controller.signal,
  });
  executions.push({ phase, code: execution.code, stopped: execution.stopped, forced: execution.forced, groupGone: execution.groupGone, error: execution.error });
  return { execution, phaseDir };
}

try {
  if (process.platform !== "darwin") throw new Blocked("This check uses macOS input sources and System Events; it runs on macOS only.");
  for (const file of ["out/main/index.js", "out/preload/settings.js", "out/renderer/settings.html"]) {
    if (!fs.existsSync(path.join(root, file))) throw new Blocked(`Missing ${file}; run pnpm build first.`);
  }
  const others = otherRecordStuffProcesses((await command("ps", ["-axo", "pid=,command="], controller.signal)).split("\n"), root, [process.pid]);
  if (others.length) throw new Blocked(`Quit RecordStuff first; these processes own the same shortcuts:\n${others.join("\n")}`);
  // Real registrations, focus and System Events keys need an awake, unlocked desktop.
  desktop = await beginDesktopRound({ log }).catch((cause: unknown) => {
    throw cause instanceof DesktopBlockedError ? new Blocked(cause.message) : cause;
  });
  const access = await command("osascript", ["-e", 'tell application "System Events" to return UI elements enabled'], controller.signal)
    .catch((cause: unknown) => { throw new Blocked(`System Events is unavailable: ${String(cause)}`); });
  if (access !== "true") throw new Blocked("System Events reports that Accessibility access is off for this terminal; grant it in System Settings → Privacy & Security → Accessibility.");
  const sources = parseSources(await helperCall(["list"]));
  original = await readState();
  log(`Input source: ${original.source} (layout ${original.layout})`);
  const choice = orderCandidates(sources, original.source, requested);
  if ("blocked" in choice) throw new Blocked(choice.blocked);
  const fixturePath = await buildFixture("shortcut-layout", reportDir);
  // Never aborted: the same calls restore the source after an interrupt, bounded by command's timeout.
  const restoreSignal = new AbortController().signal;
  guard = new InputSourceGuard({
    current: async () => (await readState(restoreSignal)).source,
    select: async id => { await helperCall(["select", id], restoreSignal); },
    wait: ms => delay(ms),
  }, original.source);
  for (const candidate of choice.candidates) {
    controller.signal.throwIfAborted();
    const attempt: Attempt = { source: candidate.id, activated: false, qualifies: false, reason: "" };
    attempts.push(attempt);
    const switching = candidate.id !== (await readState()).source;
    if (switching) await guard.select(candidate.id);
    log(`${switching ? "Selected" : "Already on"} ${candidate.id}${needsActivation(candidate) ? "; activating it in an owned text field" : ""}`);
    let state = await pollState(value => value.source === candidate.id, 3000);
    if (state.source === candidate.id && needsActivation(candidate)) {
      attempt.activated = true;
      fs.rmSync(path.join(temporary, "activation-done"), { force: true });
      const activation = run(`activate-${attempts.length}`, "activate", fixturePath, 20_000);
      activation.catch(() => undefined); // Awaited below; an early rejection must not end the runner before the restore.
      try {
        state = await pollState(value => value.source === candidate.id && layoutVerdict(value).qualifies, 8000);
      } finally {
        fs.writeFileSync(path.join(temporary, "activation-done"), "");
        const { phaseDir } = await activation;
        const report = path.join(phaseDir, "activation.json");
        if (fs.existsSync(report)) attempt.activationFocused = (JSON.parse(fs.readFileSync(report, "utf8")) as { focused: boolean }).focused;
      }
      // The layout must survive the activation window closing.
      state = await readState();
    }
    attempt.state = state;
    const verdict = state.source === candidate.id ? layoutVerdict(state) : { qualifies: false, reason: `selection reported ${state.source}` };
    Object.assign(attempt, verdict);
    log(`${verdict.qualifies ? "Using" : "Skipping"} ${candidate.id}: ${verdict.reason}`);
    if (verdict.qualifies) { during = state; break; }
  }
  if (!during) {
    throw new Blocked(`No enabled input source had a number row without digits within the wait: ${attempts.map(a => `${a.source} (${a.reason})`).join("; ")}. Enable one such as Zhuyin; this runner never enables sources.`);
  }
  log(`Checking ${LAYOUT_ACCELERATOR}${drill ? " with layout lookup on (negative-control drill)" : ""}`);
  const { phaseDir } = await run("check", drill ? "layout-aware" : "check", fixturePath, 60_000);
  const resultsFile = path.join(phaseDir, "results.json");
  if (fs.existsSync(resultsFile)) fixture = JSON.parse(fs.readFileSync(resultsFile, "utf8")) as FixtureResult;
  controller.signal.throwIfAborted();
  if (!fixture) throw new Error("The check fixture wrote no results.");
  if (fixture.blocked) blocked.push(fixture.blocked);
  if (fixture.error) throw new Error(`Fixture error: ${fixture.error}`);
  after = await readState();
  if (after.source !== during.source || after.layout !== during.layout) {
    blocked.push(`The input source changed during the check: ${during.source}/${during.layout} → ${after.source}/${after.layout}.`);
  }
} catch (cause) {
  if (cause instanceof Blocked) blocked.push(cause.message);
  else if (!controller.signal.aborted) error = cause instanceof Error ? cause.message : String(cause);
} finally {
  if (guard) {
    restore = await guard.restore();
    restored = await readState(new AbortController().signal).catch(() => undefined);
  }
  desktop?.end();
  fs.closeSync(logFd);
}
const processesGone = executions.every(execution => execution.groupGone);
if (processesGone) fs.rmSync(temporary, { recursive: true, force: true });
process.removeListener("SIGINT", interrupt);
process.removeListener("SIGTERM", interrupt);

const verdict = classify({
  drill, blocked, locked: desktop?.lockedAt !== undefined, interrupted: interruptedBy !== undefined, error,
  keys: fixture?.keys ?? [], restore, processesGone, executions, fixtureCleanup: fixture?.cleanup,
});
const describeState = (state?: LayoutState) => state ? `${state.source} (layout ${state.layout})` : "not read";
const summary = {
  status: verdict.status, exitCode: verdict.exitCode, reasons: verdict.reasons, drill, drillDetected: verdict.drillDetected,
  requested: requested ?? null, accelerator: LAYOUT_ACCELERATOR, interruptedBy: interruptedBy ?? null,
  inputSource: { original, attempts, during, after, restored, restore },
  fixture, executions, desktop: desktop?.summary ?? null, error: error ?? null,
  temporary, temporaryRemoved: !fs.existsSync(temporary),
};
fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(summary, null, 2));
const title = drill ? `${verdict.status} (negative-control drill${verdict.drillDetected ? ": layout lookup detected" : verdict.drillDetected === false ? ": NOT detected" : ""})` : verdict.status;
fs.writeFileSync(path.join(reportDir, "report.md"), [
  "# Keyboard-layout shortcut check", "", `Result: ${title}`, "",
  ...verdict.reasons.map(reason => `- ${reason}`), ...(verdict.reasons.length ? [""] : []),
  desktop?.summary ?? "Desktop: not reached.", "",
  drill
    ? `Mode: negative-control drill. The fixture removed production's \`disable-features\` before app ready (observed: ${fixture ? fixture.disableFeatures ?? "none" : "not read"}), so Chromium's layout-aware lookup is on as before plan 043; the number-row key is expected not to fire.`
    : `Mode: production switches (\`disable-features=${fixture?.disableFeatures ?? "not read"}\`).`,
  "Production main registers through the real Electron globalShortcut; presses are recorded instead of calling the production toggle, so no capture starts. Keys are synthetic System Events key codes, not physical presses.", "",
  "## Input source", "",
  `- Original: ${describeState(original)}${requested ? `; requested ${requested}` : ""}`,
  ...attempts.map(attempt => `- Tried ${attempt.source}${attempt.activated ? ` (activated in an owned text field; focused=${attempt.activationFocused ?? "unknown"})` : ""}: ${attempt.reason}`),
  `- During the check: ${describeState(during)}${during ? `; number row types ${[29, 18, 19, 20, 21, 23, 22, 26, 28, 25].map(code => during!.keys[code]).join(" ")}, keypad 7 types ${during.keys[89]}` : ""}`,
  `- After the check: ${describeState(after)}`,
  `- Restored: ${describeState(restored)}; ${restore ? (restore.confirmed ? `confirmed ${restore.original}${restore.selected ? "" : " (no switch was needed)"}` : `NOT confirmed: ${restore.error}`) : "nothing was changed"}`, "",
  "## Keys", "",
  `Accelerator: \`${LAYOUT_ACCELERATOR}\`. Registrations: ${fixture?.attempts.map(a => `${a.accelerator} ${a.registered ? "registered" : "refused"}`).join(", ") || "none"}.`, "",
  ...(fixture?.keys.length ? fixture.keys.map(key => `- ${key.observed === key.expected && !key.error ? "PASS" : "FAIL"}: ${key.name} — expected ${key.expected ? "to fire" : "not to fire"}, ${key.error ?? `${key.presses} press(es)`}`) : ["- No keys were sent."]), "",
  "## Cleanup", "",
  `Process groups gone: ${processesGone}; temporary removed: ${!fs.existsSync(temporary)}; fixture cleanup: ${fixture ? JSON.stringify(fixture.cleanup) : "not reported"}.`,
  `Interrupted: ${interruptedBy ?? "no"}. Error: ${error ?? "none"}. Details: report.json, electron.log, check/app.log.`, "",
].join("\n"));
console.log([
  `${title}: keyboard-layout shortcut check; input source ${restore ? (restore.confirmed ? `restored to ${restore.original}` : "NOT RESTORED") : "unchanged"}`,
  ...verdict.reasons.map(reason => `- ${reason}`), reportDir,
].join("\n"));
process.exitCode = verdict.exitCode;
