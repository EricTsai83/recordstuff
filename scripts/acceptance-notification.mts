/**
 * Saved-notification acceptance against /Applications/RecordStuff.app.
 * See docs/system-design/tooling.md#notification-acceptance for prerequisites.
 * Default: five clicks, Finder closed, English. --full covers all three Finder states.
 * --install temporarily replaces the installed app with the signed dist bundle.
 * Each save gets a 5 s banner search, with no re-recording retries.
 * Ctrl-C cancels work; cleanup has a separate 120 s budget. Shortcut delivery and
 * Finder window creation finish their bounded command before cancellation.
 */
import { setTimeout as delay } from "node:timers/promises";
import { command, finishRecording } from "./lib/notification-runtime.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceleratorToKeystroke,
  currentState,
  findAfter,
  keystrokeScript,
  registeredAccelerator,
} from "./lib/acceptance.mts";
import {
  FINDER_SELECTED_ROW_SCRIPT,
  FINDER_SELECTION_SCRIPT,
  FINDER_STATES,
  FINDER_TARGET_SCRIPT,
  expectedBannerBody,
  fileSelected,
  finderSetupScript,
  judgeClick,
  pressBannerScript,
  summarize,
  type CaseResult,
  type ClickObservation,
  type FinderState,
  type Language,
} from "./lib/notification-acceptance.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_TITLE = "RecordStuff";
const INSTALLED_APP = "/Applications/RecordStuff.app";
const BUILT_APP = path.join(REPO_ROOT, "dist/mac-arm64/RecordStuff.app");
const LOG_PATH = path.join(os.homedir(), "Library/Logs/recordstuff/recordstuff.log");
const SETTINGS_PATH = path.join(os.homedir(), "Library/Application Support/recordstuff/settings.json");
const UI_TIMEOUT_MS = 30_000;
/** How long the frontmost app is sampled after the click; the OS activation lands ~110 ms after it. */
const SAMPLE_MS = 3000;

let install = false;
let clicks = 5;
let seconds = 2;
let languages: Language[] = ["en"];
let finderStates: FinderState[] = ["closed"];
let frontApp = "TextEdit";
let keepRecordings = false;
let outDir: string | undefined;
const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
const usage = (): never => {
  console.error(
    "usage: pnpm acceptance:notification [-- --install] [--full] [--clicks N] [--languages en,zh-TW] [--finder closed,behind,minimized] [--seconds N] [--front <app>] [--keep-recordings] [--out <dir>]",
  );
  process.exit(2);
};
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--install") install = true;
  else if (arg === "--full") {
    finderStates = [...FINDER_STATES];
  } else if (arg === "--clicks") clicks = Number(argv[++i]);
  else if (arg === "--seconds") seconds = Number(argv[++i]);
  else if (arg === "--languages") languages = (argv[++i] ?? "").split(",").filter(Boolean) as Language[];
  else if (arg === "--finder") finderStates = (argv[++i] ?? "").split(",").filter(Boolean) as FinderState[];
  else if (arg === "--front") frontApp = argv[++i] ?? usage();
  else if (arg === "--keep-recordings") keepRecordings = true;
  else if (arg === "--out") outDir = argv[++i] ?? usage();
  else usage();
}
if (!Number.isInteger(clicks) || clicks < 2 || clicks > 10) usage();
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) usage();
if (languages.length === 0 || languages.some((l) => l !== "en" && l !== "zh-TW")) usage();
if (finderStates.length === 0 || finderStates.some((s) => !FINDER_STATES.includes(s))) usage();
languages = [...new Set(languages)];
finderStates = [...new Set(finderStates)];

const controller = new AbortController();
let operationSignal = controller.signal;
const sleep = async (ms: number): Promise<void> => { await delay(ms, undefined, { signal: operationSignal }); };
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (!abortedBy) console.log(`received ${signal}; cancelling the run, then cleaning up (up to 120 s)`);
    abortedBy = signal;
    controller.abort(new Error(`interrupted by ${signal}`));
  });
}
const now = (): string => new Date().toISOString();
const readLines = (): string[] => (fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, "utf8").split(/\r?\n/) : []);
const nextIndex = (): number => {
  const lines = readLines();
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
};

class AcceptanceFailure extends Error {}
/** Signal received while the run was in progress; loops stop at their next check. */
let abortedBy: string | undefined;
function fail(message: string): never {
  throw new AcceptanceFailure(message);
}

async function run(commandName: string, args: string[], what: string, timeout = 10_000): Promise<string> {
  try { return await command(commandName, args, operationSignal, timeout); }
  catch (error) { return fail(`${what}: ${String(error)}`); }
}

async function osascript(script: string, what: string, timeout = 10_000): Promise<string> {
  return run("osascript", ["-e", script], what, timeout);
}

async function appPid(): Promise<string | undefined> {
  return (await command("pgrep", ["-f", "RecordStuff.app/Contents/MacOS/RecordStuff$"], operationSignal, 5000, [0, 1])).split("\n")[0] || undefined;
}

async function frontmost(): Promise<string> {
  const asn = (await run("lsappinfo", ["front"], "frontmost app")).trim();
  const info = await run("lsappinfo", ["info", "-only", "name", asn], "frontmost app name");
  return /"LSDisplayName"="([^"]*)"/.exec(info)?.[1] ?? info.trim();
}

async function quitApp(): Promise<void> {
  if (!await appPid()) return;
  const state = currentState(readLines());
  if (state === "recording" || state === "starting" || state === "stopping")
    fail(`RecordStuff is ${state}; not interrupting a recording`);
  await osascript(`tell application "${APP_TITLE}" to quit`, "quit RecordStuff");
  const deadline = Date.now() + 10_000;
  while (await appPid() && Date.now() < deadline) await sleep(250);
  if (await appPid()) fail("RecordStuff did not quit within 10 s");
}

async function launchApp(): Promise<string> {
  const from = nextIndex();
  await run("open", ["-a", INSTALLED_APP], "launch RecordStuff");
  await waitFor(from, /hotkey: registered/, "`hotkey: registered` after launch");
  await sleep(1000);
  const lines = readLines();
  const state = currentState(lines);
  if (state !== undefined && state !== "idle") fail(`the launched app is in state ${state}; it must be idle`);
  return (
    registeredAccelerator(lines) ??
    fail("the launched app did not register a shortcut (disabled or refused); the script needs it to record")
  );
}

async function waitFor(from: number, pattern: RegExp, what: string): Promise<{ line: string; index: number }> {
  const deadline = Date.now() + UI_TIMEOUT_MS;
  while (Date.now() < deadline) {
    operationSignal.throwIfAborted();
    const lines = readLines();
    const hit = findAfter(lines, from, pattern);
    if (hit) return { line: lines[hit.index] ?? "", index: hit.index };
    await sleep(200);
  }
  const tail = readLines().slice(from).filter(Boolean).slice(-6).join("\n  ");
  return fail(`timed out after ${UI_TIMEOUT_MS / 1000} s waiting for ${what}. Log:\n  ${tail || "(nothing)"}`);
}

interface Settings {
  language?: string;
  [key: string]: unknown;
}
function readSettings(): Settings | undefined {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Settings;
  } catch {
    return undefined;
  }
}
function writeLanguage(language: string | undefined): void {
  const settings = readSettings();
  if (!settings) fail(`cannot read ${SETTINGS_PATH}; launch the app once first`);
  if (language === undefined) delete settings.language;
  else settings.language = language;
  const tmp = `${SETTINGS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, SETTINGS_PATH);
}

async function verifySignature(app: string): Promise<void> {
  await run("codesign", ["--verify", "--deep", "--strict", app], `signature of ${app}`);
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") fail("macOS only");
  const stamp = now().replace(/:/g, "");
  const dir = outDir ?? path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-notification-acceptance`);
  fs.mkdirSync(dir, { recursive: true });
  const events: string[] = [];
  const note = (s: string): void => {
    events.push(`${now()} ${s}`);
    console.log(s);
  };

  // Preflight before touching anything.
  try {
    await osascript('tell application "System Events" to tell process "Finder" to count windows', "Accessibility check");
  } catch (error) {
    fail(
      `this terminal needs Accessibility access (System Settings > Privacy & Security > Accessibility) and Automation access to Finder: ${String(error)}`,
    );
  }
  if (install && !fs.existsSync(BUILT_APP)) fail(`${BUILT_APP} is missing; run \`pnpm start:app\` first`);
  if (!install && !fs.existsSync(INSTALLED_APP)) fail(`${INSTALLED_APP} is missing; install the app or pass --install`);
  if (install) await verifySignature(BUILT_APP);
  const finderCount = await osascript('tell application "Finder" to count Finder windows', "Finder preflight");
  if (finderCount !== "0") fail("close Finder windows before this dedicated desktop test; existing windows are not closed by the script");
  const initialState = currentState(readLines());
  if (await appPid() && initialState && initialState !== "idle") fail(`RecordStuff is ${initialState}; not interrupting it`);

  const originalSettings = readSettings() ?? fail("cannot read settings; launch the app once first");
  const wasRunning = Boolean(await appPid());
  /** A backup is used for restoration only after its signature passes. */
  let backup: string | undefined;
  /** True once /Applications no longer holds the original app; restoration is owed. */
  let installedReplaced = false;
  /** A recording this script started that has not been saved yet. */
  let recordingFrom: number | undefined;
  let stopSent = false;
  let currentKey: string | undefined;
  let runError: string | undefined;
  const results: CaseResult[] = [];
  const recordings: string[] = [];
  const finderWindows = new Set<number>();
  const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-notification-desktop-"));
  let documentPath: string | undefined;
  let textEditUsed = false;
  const planned = languages.length * finderStates.length * clicks;
  const logFrom = nextIndex();


  note(`planned ${planned} clicks; each banner search is limited to 5 s; Ctrl-C cancels and cleans up`);
  try {
    await quitApp();
    if (install) {
      if (fs.existsSync(INSTALLED_APP)) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-acceptance-backup-"));
        backup = dir;
        await run("ditto", [INSTALLED_APP, path.join(dir, "RecordStuff.app")], "back up the installed app", 60_000);
        await verifySignature(path.join(dir, "RecordStuff.app"));
      }
      // Restoration is owed from the first destructive step, so a partial delete is recovered too.
      operationSignal.throwIfAborted();
      installedReplaced = true;
      fs.rmSync(INSTALLED_APP, { recursive: true, force: true });
      await run("ditto", [BUILT_APP, INSTALLED_APP], "install the built app", 60_000);
      await verifySignature(INSTALLED_APP);
      note(
        `installed ${path.relative(REPO_ROOT, BUILT_APP)} into ${INSTALLED_APP}${backup ? ` (previous app backed up in ${backup})` : " (nothing was installed before)"}`,
      );
    }
    for (const language of languages) {
      operationSignal.throwIfAborted();
      writeLanguage(language);
      const accelerator = await launchApp();
      const keystroke =
        acceleratorToKeystroke(accelerator) ?? fail(`cannot type accelerator ${accelerator} through System Events`);
      currentKey = keystrokeScript(keystroke);
      note(`launched ${INSTALLED_APP} (pid ${await appPid()}), language ${language}, shortcut ${accelerator}`);

      for (const finderState of finderStates) {
        for (let click = 1; click <= clicks; click += 1) {
          results.push(await runClick(language, finderState, click));
        }
      }
      await quitApp();
    }
  } catch (error) {
    runError = error instanceof AcceptanceFailure ? error.message : String(error);
    throw error;
  } finally {
    await cleanupAndReport();
  }

  async function runClick(language: Language, finderState: FinderState, click: number): Promise<CaseResult> {
    operationSignal.throwIfAborted();
    const started = Date.now();
    note(`[${language} ${finderState} click ${click}] starting (${results.length + 1}/${planned})`);
    const key = currentKey ?? fail("shortcut unknown");
    await closeDesktop();
    if (await osascript('tell application "Finder" to count Finder windows', "Finder windows") !== "0")
      fail("an unrelated Finder window is open; leaving it untouched");
    operationSignal.throwIfAborted();
    const windowId = await command("osascript", ["-e", finderSetupScript(finderState)], AbortSignal.timeout(5000), 5000);
    if (/^\d+$/.test(windowId)) finderWindows.add(Number(windowId));
    if (frontApp === "TextEdit") {
      textEditUsed = true;
      documentPath = path.join(desktopDir, `${language}-${finderState}-${click}.txt`);
      fs.writeFileSync(documentPath, "RecordStuff notification acceptance\n");
      await osascript(`tell application "TextEdit" to open POSIX file ${JSON.stringify(documentPath)}`, "open test document");
    }
    await osascript(`tell application ${JSON.stringify(frontApp)} to activate`, `activate ${frontApp}`);
    await sleep(1200);
    const frontBefore = await frontmost();

    operationSignal.throwIfAborted();
    const before = nextIndex();
    recordingFrom = before;
    stopSent = false;
    await command("osascript", ["-e", key], AbortSignal.timeout(5000), 5000);
    await waitFor(before, /state → recording/, "`state → recording`");
    await sleep(seconds * 1000);
    const beforeStop = nextIndex();
    operationSignal.throwIfAborted();
    await command("osascript", ["-e", key], AbortSignal.timeout(5000), 5000);
    stopSent = true;
    const saved = await waitFor(beforeStop, /\] saved (.+)$/, "`saved <path>`");
    recordingFrom = undefined;
    const savedPath = /\] saved (.+)$/.exec(saved.line)?.[1];
    if (savedPath) recordings.push(savedPath);

    // Press the banner while it is still on screen (about 5 s).
    let pressed: string | undefined;
    let bannerBody: string | undefined;
    const attempts: { at: string; elapsedMs: number; output?: string; error?: string }[] = [];
    const bannerDeadline = Date.now() + 5000;
    while (!pressed && Date.now() < bannerDeadline) {
      let out: string;
      const attemptStarted = Date.now();
      try {
        out = await osascript(pressBannerScript(APP_TITLE, expectedBannerBody(savedPath ?? "", language)), "find notification", Math.max(1, bannerDeadline - Date.now()));
        attempts.push({ at: now(), elapsedMs: Date.now() - attemptStarted, output: out });
      } catch (error) {
        attempts.push({ at: now(), elapsedMs: Date.now() - attemptStarted, error: String(error) });
        operationSignal.throwIfAborted();
        if (Date.now() < bannerDeadline) throw error;
        break;
      }
      if (out.startsWith("pressed")) {
        pressed = now();
        bannerBody = out.split("\t")[1] || undefined;
      } else await sleep(Math.min(200, Math.max(0, bannerDeadline - Date.now())));
    }

    let observation: ClickObservation | undefined;
    if (pressed) {
      const fronts: string[] = [];
      const end = Date.now() + SAMPLE_MS;
      while (Date.now() < end) {
        const f = await frontmost();
        if (fronts[fronts.length - 1] !== f) fronts.push(f);
        await sleep(80);
      }
      const selected = await osascript(FINDER_SELECTION_SCRIPT, "Finder selection") || undefined;
      const selectedRow = await osascript(FINDER_SELECTED_ROW_SCRIPT, "Finder selected row") || undefined;
      const windowTarget = await osascript(FINDER_TARGET_SCRIPT, "Finder window folder") || undefined;
      if (savedPath && windowTarget?.replace(/\/$/, "") === path.dirname(savedPath)) {
        const id = await osascript('tell application "Finder" to return id of front Finder window', "revealed window id");
        if (/^\d+$/.test(id)) finderWindows.add(Number(id));
      }
      const appLogLines = readLines()
        .slice(saved.index + 1)
        .filter((l) => /notification|reveal/.test(l));
      observation = {
        finalFront: fronts[fronts.length - 1] ?? "",
        fronts,
        selected,
        selectedRow,
        windowTarget,
        bannerBody,
        appLog: appLogLines,
      };
    }
    const result = judgeClick(language, finderState, click, savedPath, observation);
    let accessibilityAfter: string | undefined;
    if (result.verdict !== "pass") {
      try {
        accessibilityAfter = await osascript(pressBannerScript(APP_TITLE, expectedBannerBody(savedPath ?? "", language), false), "notification diagnostic snapshot", 5000);
      } catch (error) { accessibilityAfter = `snapshot failed: ${String(error)}`; }
    }
    const diagnosticFile = `${language}-${finderState}-${click}-diagnostics.json`;
    fs.writeFileSync(path.join(dir, diagnosticFile), JSON.stringify({
      language, finderState, click, savedPath, verdict: result.verdict, attempts,
      accessibilityAfter, appEvents: readLines().slice(saved.index + 1).filter((line) => line.includes("notification:")),
    }, null, 2) + "\n");
    if (result.verdict !== "pass") note(`diagnostics: ${diagnosticFile}`);
    note(
      `[${language} ${finderState} click ${click}] front before ${frontBefore}; ${
        observation
          ? `after click: ${observation.fronts.join(" → ")}; row ${observation.selectedRow ?? "none"} in ${observation.windowTarget ?? "no window"}`
          : "banner not pressed"
      } → ${result.verdict} (${((Date.now() - started) / 1000).toFixed(1)} s)${result.reasons.length ? ` (${result.reasons.join("; ")})` : ""}`,
    );
    return result;
  }

  async function closeDesktop(): Promise<void> {
    for (const id of finderWindows) {
      await osascript(`tell application "Finder"
if exists Finder window id ${id} then close Finder window id ${id}
end tell`, "close test Finder window");
      finderWindows.delete(id);
    }
    if (documentPath) {
      await osascript(`tell application "TextEdit"
repeat with d in documents
  if path of d is ${JSON.stringify(documentPath)} then close d saving no
end repeat
end tell`, "close test document");
      documentPath = undefined;
    }
  }

  async function cleanupAndReport(): Promise<void> {
    // Restore owned resources; unrecognized windows are left for manual cleanup.
    // Anything that could not be restored marks the run as failed.
    const cleanup: string[] = [];
    let cleanupFailed = false;
    const problem = (message: string): void => {
      cleanupFailed = true;
      cleanup.push(message);
    };
    note("cleanup: settling recording and restoring resources (120 s budget)");
    operationSignal = AbortSignal.timeout(120_000);
    let recordingSettled = recordingFrom === undefined;
    if (recordingFrom !== undefined) {
      try {
        const savedPath = await finishRecording({
          read: readLines, from: recordingFrom, stopSent, signal: operationSignal,
          stop: () => run("osascript", ["-e", currentKey ?? fail("shortcut unknown")], "stop the script's recording"),
        });
        if (savedPath && !recordings.includes(savedPath)) recordings.push(savedPath);
        recordingSettled = true;
        cleanup.push(`recording settled${savedPath ? ` and saved (${savedPath})` : " without a saved file"}`);
      } catch (error) { problem(`could not settle the script's recording: ${String(error)}`); }
    }
    try {
      if (recordingSettled) await quitApp();
    } catch (error) {
      problem(`quit: ${String(error)}`);
    }
    // The bundle is only replaced once no process runs from it.
    let appStillRunning = true;
    try { appStillRunning = Boolean(await appPid()); }
    catch (error) { problem(`could not check app process: ${String(error)}`); }
    if (appStillRunning) problem("RecordStuff is still running after the quit attempt");
    try {
      await closeDesktop();
      fs.rmSync(desktopDir, { recursive: true, force: true });
      if (await osascript('tell application "Finder" to count Finder windows', "remaining Finder windows") !== "0")
        problem("untracked Finder windows left open; close them manually before another run");
    } catch (error) { problem(`desktop: ${String(error)}`); }
    if (textEditUsed) {
      try {
        const result = await osascript(`tell application "TextEdit"
if (count documents) > 0 then return "kept open: other documents remain"
quit
return "quit"
end tell`, "quit empty TextEdit");
        if (result === "quit") {
          const deadline = Date.now() + 5000;
          while (await command("pgrep", ["-x", "TextEdit"], operationSignal, 5000, [0, 1])) {
            if (Date.now() >= deadline) fail("TextEdit did not quit within 5 s");
            await sleep(100);
          }
        }
        cleanup.push(`TextEdit: ${result}`);
      } catch (error) { problem(`TextEdit: ${String(error)}`); }
    }
    if (installedReplaced) {
      if (appStillRunning) {
        problem(
          `NOT restoring ${INSTALLED_APP} while a process still runs from it; the previous app remains in ${backup ?? "(none)"}`,
        );
      } else {
        try {
          operationSignal.throwIfAborted();
          fs.rmSync(INSTALLED_APP, { recursive: true, force: true });
          if (backup) {
            await run("ditto", [path.join(backup, "RecordStuff.app"), INSTALLED_APP], "restore the previous app", 60_000);
            await verifySignature(INSTALLED_APP);
            cleanup.push(`restored the previous app from ${backup}`);
          } else cleanup.push("removed the built app again (nothing was installed before)");
          installedReplaced = false;
        } catch (error) {
          problem(`RESTORE FAILED, previous app remains in ${backup ?? "(none)"}: ${String(error)}`);
        }
      }
    }
    if (backup && !installedReplaced) {
      try { fs.rmSync(backup, { recursive: true, force: true }); }
      catch (error) { problem(`remove backup: ${String(error)}`); }
    }
    if (originalSettings && !appStillRunning) {
      try {
        writeLanguage(originalSettings.language);
      } catch (error) {
        problem(`settings: ${String(error)}`);
      }
    }
    if (!keepRecordings) {
      for (const file of recordings) {
        try {
          fs.rmSync(file, { force: true });
        } catch (error) {
          problem(`delete ${file}: ${String(error)}`);
        }
      }
      if (recordings.length) cleanup.push(`deleted ${recordings.length} recording(s) made by this run`);
    }
    if (wasRunning && !appStillRunning && !installedReplaced) {
      try {
        await run("open", ["-a", INSTALLED_APP], "relaunch RecordStuff");
        cleanup.push("relaunched RecordStuff because it was running before");
      } catch (error) {
        problem(`relaunch: ${String(error)}`);
      }
    } else if (wasRunning && !appStillRunning) problem("RecordStuff was running before and could not be relaunched");
    for (const c of cleanup) note(`cleanup: ${c}`);

    // The verdict covers the whole requested matrix: an interrupted run (even when the
    // signal arrived after the last check), a case that threw or anything left
    // unrestored is a failed run even when every judged click passed.
    const summary = summarize(results);
    const incomplete =
      results.length < planned ? `${results.length} of ${planned} planned clicks completed` : undefined;
    const ok = summary.ok && !incomplete && !runError && !cleanupFailed && !abortedBy;
    const problems = [
      incomplete,
      runError && `run stopped: ${runError}`,
      abortedBy && !runError && `interrupted by ${abortedBy}`,
      summary.uncovered.length > 0 &&
        `fewer than two passing clicks for ${summary.uncovered.join(", ")} (use --clicks 2 or more)`,
      cleanupFailed && "cleanup left something unrestored (see events)",
    ].filter(Boolean) as string[];
    fs.writeFileSync(path.join(dir, "cases.json"), JSON.stringify(results, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "app-session.log"), readLines().slice(logFrom).filter(Boolean).join("\n") + "\n");
    const rows = results.map(
      (r) =>
        `| ${r.language} | ${r.finderState} | ${r.click} | ${r.observation?.fronts.join(" → ") ?? "—"} | ${
          r.observation && r.savedPath ? (fileSelected(r.savedPath, r.observation) ? "yes" : "no") : "—"
        } | ${r.verdict}${r.reasons.length ? `: ${r.reasons.join("; ")}` : ""} |`,
    );
    fs.writeFileSync(
      path.join(dir, "report.md"),
      [
        "# Saved-notification click acceptance (`pnpm acceptance:notification`)",
        "",
        `Run ${now()} on ${os.hostname()}, Darwin ${os.release()}. App under test: \`${INSTALLED_APP}\`${install ? ` (installed from \`${path.relative(REPO_ROOT, BUILT_APP)}\` for this run)` : " (as installed)"}. ${clicks} click(s) per Finder state in one app process, ${seconds} s recordings, foreground app ${frontApp}, languages ${languages.join(", ")}. The banner was pressed through Accessibility; the frontmost app was sampled for ${SAMPLE_MS / 1000} s after the press.`,
        "",
        `Result: **${ok ? "pass" : "fail"}** (${summary.pass} pass, ${summary.fail} fail, ${summary.notRun} not run${problems.length ? `; ${problems.join("; ")}` : ""}). A click passes only when Finder is frontmost at the end of the window and its selection is the saved file; the two are reported separately below.`,
        "",
        "| Language | Finder | Click | Frontmost after click | Selected saved file | Verdict |",
        "| --- | --- | --- | --- | --- | --- |",
        ...rows,
        "",
        "## Events",
        "",
        ...events.map((e) => `- ${e}`),
        "",
        "Evidence: [cases.json](cases.json), [app-session.log](app-session.log). Not covered: tray menu reveal, other Spaces, clicks from the Notification Center list after the banner left.",
      ].join("\n"),
    );
    console.log(`Report ${path.relative(REPO_ROOT, dir)}/report.md`);
    if (!ok) {
      const bad = results
        .filter((r) => r.verdict !== "pass")
        .map((r) => `${r.language}/${r.finderState}/click ${r.click}: ${r.verdict}`);
      console.error(
        `✗ notification acceptance failed (${summary.fail} fail, ${summary.notRun} not run${problems.length ? `; ${problems.join("; ")}` : ""})${bad.length ? `: ${bad.join("; ")}` : ""}`,
      );
      process.exitCode = 1;
    } else console.log("✅ notification acceptance passed");
  }
}

main().catch((error: unknown) => {
  if (error instanceof AcceptanceFailure) console.error(`✗ ${error.message}`);
  else console.error(error);
  process.exit(1);
});
