/** `pnpm acceptance:window-drag`: fresh build + isolated native Settings + CGEvent dragging + AX bounds. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture } from "./lib/runner/build-fixture.mts";
import { beginDesktopRound, DesktopBlockedError } from "./lib/runner/desktop-session.mts";
import { runIsolatedProcess } from "./lib/runner/isolated-process.mts";
import { scrubbedEnv, runnerArgs } from "./lib/runner/runner-env.mts";
import { electronPattern, pgrepPids, recordStuffPids, command } from "./lib/runner/processes.mts";
import { roundExit } from "./lib/runner/round-exit.mts";
import { releaseNativeMouse, restorePointer, type Point } from "./lib/runner/native-drag.mts";
import { parseWindowDragResults, windowDragFailed, type WindowDragResults } from "./lib/acceptance/window-drag.mts";
import { treeDigest, workingTreeIdentity } from "./lib/runner/verification-timing.mts";
import { runtimeInputDigest, runtimeInputFiles } from "./lib/runner/runtime-inputs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = runnerArgs();
function stop(message: string, code = 2): never { console.error(message); process.exit(code); }
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: pnpm acceptance:window-drag [-- --out <new-directory>] [--drill-cancel]\n"
    + "Builds the production page/preload, then tests real macOS window dragging in an isolated fixture.\n"
    + "Requires desktop handoff, an unlocked primary work area ≥1090×700 pt, Accessibility and Screen Recording.\n"
    + "Does not record media or modify app preferences. --drill-cancel interrupts after the first measured drag.\n"
    + "Exit: 0 pass, 1 fail/cleanup failure, 2 blocked, 130/143 clean interrupt. Reports include AX bounds and OS screenshots.");
  process.exit(0);
}
let output: string | undefined, drillCancel = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1] && !args[i + 1]!.startsWith("--")) output = args[++i];
  else if (args[i] === "--drill-cancel") drillCancel = true;
  else stop(`Unknown or incomplete option: ${args[i]}; see --help`);
}
if (process.platform !== "darwin") stop("BLOCKED: window drag acceptance requires macOS");
for (const input of ["out/preload/settings.js", "out/renderer/settings.html", "node_modules/.bin/electron"])
  if (!fs.existsSync(path.join(root, input))) stop(`BLOCKED: ${input} missing; run pnpm install / pnpm build`);
try {
  const electronApp = fs.realpathSync(path.join(root, "node_modules/electron/dist/Electron.app"));
  if (recordStuffPids().length || pgrepPids(electronPattern(electronApp, "main")).length)
    stop("BLOCKED: quit the running RecordStuff/development Electron before this isolated desktop round");
} catch (cause) { stop(`BLOCKED: cannot establish app/process prerequisites: ${String(cause)}`); }
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = output ? path.resolve(output) : path.join(root, "docs/verification/measurements", `${stamp}-window-drag`);
if (fs.existsSync(dir)) stop(`Refusing to overwrite evidence: ${dir}`);
fs.mkdirSync(dir, { recursive: true });
const fixture = await buildFixture("window-drag", dir);
const inputs = runtimeInputDigest(runtimeInputFiles(root)), artifact = treeDigest(path.join(root, "out"));
const source = workingTreeIdentity(root);
fs.writeFileSync(path.join(dir, "identity.json"), JSON.stringify({ inputs, artifact, source }, null, 2));
const controller = new AbortController();
let interrupted: "SIGINT" | "SIGTERM" | undefined;
const interrupt = (signal: "SIGINT" | "SIGTERM"): void => { interrupted ??= signal; controller.abort(); };
const onInt = (): void => interrupt("SIGINT"), onTerm = (): void => interrupt("SIGTERM");
process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
let desktop: Awaited<ReturnType<typeof beginDesktopRound>> | undefined;
let execution: Awaited<ReturnType<typeof runIsolatedProcess>> | undefined;
let launchAttempted = false;
let error: string | undefined, blocked = false;
let inputCleanupError: string | undefined;
const log = fs.openSync(path.join(dir, "electron.log"), "a");
let drill: ReturnType<typeof setInterval> | undefined;
try {
  desktop = await beginDesktopRound();
  if (drillCancel) drill = setInterval(() => {
    try {
      const result = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8")) as { cases?: unknown[] };
      if (result.cases?.length) { clearInterval(drill); interrupt("SIGTERM"); }
    } catch { /* The first case has not been flushed yet. */ }
  }, 50);
  launchAttempted = true;
  execution = await runIsolatedProcess({ executable: path.join(root, "node_modules/.bin/electron"),
    args: [fixture, dir, root], cwd: root, env: scrubbedEnv(), logFd: log, timeoutMs: 180_000, graceMs: 8000, signal: controller.signal });
} catch (cause) { error = String(cause); blocked = cause instanceof DesktopBlockedError; }
finally {
  clearInterval(drill);
  // A last recovery outside the fixture survives a killed helper/main process.
  if (launchAttempted) try {
    await releaseNativeMouse();
    const environmentFile = path.join(dir, "environment.json");
    if (fs.existsSync(environmentFile)) {
      const environment = JSON.parse(fs.readFileSync(environmentFile, "utf8")) as { pointer: Point };
      await restorePointer(environment.pointer);
    }
  } catch (cause) { inputCleanupError = String(cause); }
  desktop?.end(); fs.closeSync(log);
  process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
}
fs.writeFileSync(path.join(dir, "cleanup.json"), JSON.stringify({ execution, error, inputCleanupError, desktop: desktop?.summary }, null, 2));
let results: WindowDragResults | undefined;
try { results = parseWindowDragResults(fs.readFileSync(path.join(dir, "results.json"), "utf8")); }
catch (cause) { if (execution) error ??= `Missing/unreadable fixture results: ${String(cause)}`; }
const cleanupIncomplete = Boolean(launchAttempted && (!execution || !execution.groupGone || execution.error)) || Boolean(results?.cleanupError || inputCleanupError);
const inputsChanged = inputs !== runtimeInputDigest(runtimeInputFiles(root)) || artifact !== treeDigest(path.join(root, "out"));
const failed = inputsChanged || Boolean(error && !blocked) || Boolean(execution && windowDragFailed(results, execution.code, execution.stopped));
const verdict = roundExit({ cleanupIncomplete, interrupted, locked: Boolean(desktop?.lockedAt), failed, blocked: blocked || Boolean(results?.blocked) });
const provenanceSignal = new AbortController().signal;
const provenance = await command("git", ["-C", root, "rev-parse", "HEAD"], provenanceSignal, 3000).catch(() => "unknown");
const dirty = await command("git", ["-C", root, "status", "--short"], provenanceSignal, 3000).catch(() => "unknown");
const report = [
  `# Native window drag — ${stamp}`, "", `Result: **${verdict.outcome}** (exit ${verdict.code}).`, "",
  "Evidence: scripted native input. CGEvent mouseDown → leftMouseDragged → mouseUp; independent Accessibility bounds before/after.",
  "The fixture uses production settingsWindowOptions, built preload/page and an isolated idle model/userData. It is not signed-bundle entry or capture evidence.",
  "setBounds/zoom are used only for setup and restoration, never between a case's measured frame reads.",
  "Visual observation: not recorded by this runner; inspect the OS before/after PNGs separately.",
  "Desktop interference may affect results; known interference makes affected observations inconclusive. This runner checks focus/blur but does not monitor all physical input.",
  `Platform: ${process.platform}/${process.arch}; source: ${provenance.trim()}; working tree:\n\n\`\`\`\n${dirty.trim()}\n\`\`\``,
  `Input digest: ${inputs}; out digest: ${artifact}; changed during the run=${inputsChanged}. Full provenance: identity.json.`,
  `Cleanup: group gone=${execution?.groupGone ?? (launchAttempted ? "unconfirmed" : "not launched")}, forced=${execution?.forced ?? false}, error=${execution?.error ?? results?.cleanupError ?? inputCleanupError ?? "none"}.`,
  desktop?.summary ?? "Desktop round did not start.",
  ...(error || results?.error ? [`Error: ${error ?? results?.error}`] : []), "",
  ...(results?.cases ?? []).map(test => `- ${test.ok ? "PASS" : "FAIL"} ${test.name}: ${JSON.stringify(test.detail)}`), "",
  "Raw evidence: results.json, cleanup.json, environment.json, identity.json, electron.log and *-before/after.png.",
  `Cancellation drill requested: ${drillCancel}. A clean drill exits 143; it is not a product pass.`, "",
].join("\n");
fs.writeFileSync(path.join(dir, "report.md"), report);
for (const test of results?.cases ?? []) console.log(`${test.ok ? "PASS" : "FAIL"}: ${test.name}`);
console.log(`${verdict.outcome.toUpperCase()} (${verdict.code}). Evidence: ${dir}`);
process.exit(verdict.code);
