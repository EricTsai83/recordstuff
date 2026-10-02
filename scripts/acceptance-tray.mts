/**
 * `pnpm acceptance:tray` (plan 063, step 4; docs/system-design/tooling.md#tray-acceptance):
 * operates the running RecordStuff bundle's real status item and menu with
 * CoreGraphics clicks and keys and Accessibility actions, and judges what the
 * native menu, the app log, the output folder and Finder show. The menu of
 * idle, countdown and recording is compared with the production model's
 * `tray: menu opened` line for the same popup, in each requested language;
 * Start, Stop, Show last recording, the three cancellations (second click,
 * Cancel recording, Quit), a Start chosen after the state moved on, keyboard
 * navigation and Quit RecordStuff are exercised. Screenshots of each menu are
 * saved for visual review, which this runner never claims. The round leaves
 * the app closed. macOS only; nothing here ships with the app.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isLanguage, translate, type Language, type PlainMessageKey } from "../src/shared/i18n.ts";
import { acceleratorToKeystroke, currentState, keystrokeScript, registeredAccelerator, sessionBelongsTo } from "./lib/acceptance.mts";
import { command, confirmedIdle, recordingOutcome, waitForLog } from "./lib/acceptance-runtime.mts";
import { DesktopBlockedError, beginDesktopRound, type DesktopRound } from "./lib/desktop-session.mts";
import { LogReader, evidenceSince, type LogCursor } from "./lib/log-reader.mts";
import { AccessibilityBlockedError, FLAG, KEY, captureRect, osascriptAx, type Frame, type NativeMenuItem } from "./lib/native-ax.mts";
import { FINDER_SELECTED_ROW_SCRIPT, FINDER_SELECTION_SCRIPT, FINDER_TARGET_SCRIPT, fileSelected } from "./lib/notification-acceptance.mts";
import { INTERRUPT_EXIT, pgrepPids, recordStuffPattern, recordStuffPids } from "./lib/processes.mts";
import { APP_LOG_PATH, APP_SETTINGS_PATH, readAppSettings, writeAppSettings } from "./lib/runner-env.mts";
import { StoredOverride } from "./lib/stored-override.mts";
import { TrayDriver, compareMenu, parseMenuLogLine, structureProblems, type TrayState } from "./lib/tray-driver.mts";
import { classifyTrayRound, renderTrayReport, type TrayCase } from "./lib/tray-acceptance.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `pnpm acceptance:tray [-- options]
  --languages en,zh-TW   languages to cover, in order (default: the stored language, then the other)
  --seconds <n>          how long each tray recording runs before Stop (default 3)
  --bundle <app>         the RecordStuff.app under test (default dist/mac-arm64/RecordStuff.app)
  --log <file>           its log (default ~/Library/Logs/recordstuff/recordstuff.log)
  --settings <file>      its settings.json (default the app's), read for the language, countdown and folder
Run after \`pnpm start:app\` (or \`pnpm open:app\`) with the app idle. Records two or more short takes of the
current display into the app's output folder and keeps them; quits the app at the end.`;

const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) { console.error(`${name} needs a value\n${USAGE}`); process.exit(2); }
  return value;
};
if (argv.includes("--help")) { console.log(USAGE); process.exit(0); }
const known = new Set(["--languages", "--seconds", "--bundle", "--log", "--settings"]);
for (let i = 0; i < argv.length; i += 2) if (!known.has(argv[i]!)) { console.error(`unknown argument ${argv[i]}\n${USAGE}`); process.exit(2); }
const bundle = path.resolve(option("--bundle") ?? path.join(root, "dist/mac-arm64/RecordStuff.app")).replace(/\/$/, "");
const logPath = path.resolve(option("--log") ?? APP_LOG_PATH);
const settingsPath = path.resolve(option("--settings") ?? APP_SETTINGS_PATH);
/** The bundle identifier names its status-item window on the primary menu bar (clickTarget in tray-driver.mts). */
const bundleId = (() => {
  try { return execFileSync("plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(bundle, "Contents/Info.plist")], { encoding: "utf8" }).trim(); }
  catch { return "com.ericts.record"; }
})();
const seconds = Number(option("--seconds") ?? 3);
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) { console.error("--seconds must be between 1 and 60"); process.exit(2); }
const requestedLanguages = option("--languages")?.split(",");
if (requestedLanguages && (requestedLanguages.length === 0 || requestedLanguages.some(l => !isLanguage(l)) || new Set(requestedLanguages).size !== requestedLanguages.length)) {
  console.error(`--languages takes en, zh-TW or both, once each\n${USAGE}`); process.exit(2);
}

const controller = new AbortController();
let interrupted: keyof typeof INTERRUPT_EXIT | undefined;
for (const name of ["SIGINT", "SIGTERM"] as const) process.on(name, () => { interrupted = name; controller.abort(new Error(`interrupted: ${name}`)); });
const signal = controller.signal;
const sleep = (ms: number): Promise<void> => delay(ms, undefined, { signal });
const ax = osascriptAx(signal);
const appLog = new LogReader(logPath);
const lines = (from?: LogCursor): string[] => (from ? appLog.since(from).lines.map(line => line.text) : appLog.all());

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.mkdirSync(path.join(root, "docs/verification/measurements"), { recursive: true });
const out = fs.mkdtempSync(path.join(root, "docs/verification/measurements", `${stamp}-tray-acceptance-`));
const cases: TrayCase[] = [];
const recordings: string[] = [];
const notes: string[] = [];
const cleanup: string[] = [];
const ownedFinderWindows = new Set<number>();
let desktop: DesktopRound | undefined;
let driver: TrayDriver | undefined;
let pid: number | undefined;
let languageOverride: StoredOverride<unknown> | undefined;
let roundError: string | undefined;
let blocked: string | undefined;
/** Set once preflight accepted this bundle and pid; cleanup operates no app it never took over (review pass 2). */
let owned = false;
/** Finder windows open before a Show last recording, so cleanup can find one an interrupted reveal opened. */
let revealBaseline: { ids: Set<number>; folder: string } | undefined;

/** This pid wrote the log's latest session and it is idle: the only app state the runner acts from. */
const confirmedIdleFor = (text: readonly string[], expected: string): boolean => sessionBelongsTo(text, expected) && confirmedIdle(text);

class Refused extends Error {}
const refuse = (message: string): never => { throw new Refused(message); };

function bundlePid(): number | undefined {
  const pids = pgrepPids(recordStuffPattern(bundle));
  if (pids.length > 1) refuse(`several processes run ${bundle}; refusing to choose one`);
  return pids[0];
}

/** Waits until this pid's session has started and settled idle, as `pnpm acceptance` does. */
async function waitSession(expected: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!confirmedIdleFor(lines(), String(expected))) {
    if (Date.now() > deadline) refuse(`RecordStuff pid ${expected} did not log a settled idle session within 30 s (permission, another state or the log of another process)`);
    await sleep(250);
  }
}

async function waitGone(what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (bundlePid() !== undefined) {
    if (Date.now() > deadline) throw new Error(`${what}: the app was still running after ${timeoutMs / 1000} s`);
    await sleep(200);
  }
}

async function launch(): Promise<void> {
  await command("open", ["-a", bundle], signal, 15_000);
  const deadline = Date.now() + 30_000;
  let next: number | undefined;
  while ((next = bundlePid()) === undefined) {
    if (Date.now() > deadline) refuse("the relaunched app did not start within 30 s");
    await sleep(200);
  }
  await waitSession(next);
  pid = next;
  driver = new TrayDriver(ax, next, signal, undefined, bundleId);
}

/** Quits an idle app the way the hotkey runner does; never a recording, never another bundle. */
async function quitIdle(): Promise<void> {
  const running = bundlePid();
  if (running === undefined) return;
  if (!confirmedIdleFor(lines(), String(running))) throw new Error("RecordStuff is not confirmed idle; refusing to quit it");
  await command("osascript", ["-e", `tell application ${JSON.stringify(bundle)} to quit`], signal, 15_000);
  await waitGone("quit");
}

function storedSettings(): Record<string, unknown> {
  return readAppSettings(settingsPath) ?? {};
}

function writeLanguage(value: unknown): void {
  const settings = storedSettings();
  if (value === undefined) delete settings["language"]; else settings["language"] = value;
  writeAppSettings(settings, settingsPath);
}

const t = (key: PlainMessageKey, language: Language): string => translate(key, language);

async function screenshot(frame: Frame | undefined, name: string): Promise<string | undefined> {
  if (!frame) return undefined;
  const file = path.join(out, `${name}.png`);
  try {
    await command("screencapture", ["-x", "-R", captureRect(frame), file], signal, 10_000);
    return path.basename(file);
  } catch (error) {
    notes.push(`screenshot ${name} failed: ${String(error)}`);
    return undefined;
  }
}

/** Opens the menu, reads it, compares it with its log line and the state's rules, saves a screenshot and closes it. */
async function readMenu(c: TrayCase, state: TrayState, language: Language): Promise<NativeMenuItem[] | undefined> {
  const tray = driver!;
  const from = appLog.end();
  const menu = await tray.open();
  const hit = await waitForLog(appLog, from, /\] tray: menu opened in \w+: /, "the menu's `tray: menu opened` line", signal, 10_000);
  const logged = parseMenuLogLine(hit.line) ?? refuse(`unreadable menu log line: ${hit.line}`);
  const shot = await screenshot(menu.snapshot.menu?.frame, `${language}-${state}-menu`);
  if (shot) c.screenshots.push(shot);
  await tray.close();
  if (logged.state !== state) {
    c.status = "not run";
    c.details.push(`the menu opened in ${logged.state}, not ${state}`);
    return undefined;
  }
  const { problems, notes: comparisonNotes } = compareMenu(menu.items, logged.menu);
  c.problems.push(...problems, ...structureProblems(menu.items, state, language));
  c.details.push(...comparisonNotes, `${menu.items.length} entries: ${menu.items.map(item => item.title || "—").join(" | ")}`);
  return menu.items;
}

/** `settle` is off for a case nested inside another's session, which must keep running. */
async function runCase(id: string, title: string, language: Language | undefined, body: (c: TrayCase) => Promise<void>, settle = true): Promise<TrayCase> {
  const c: TrayCase = { id, title, language, status: undefined, evidence: "scripted input", problems: [], details: [], screenshots: [] };
  const started = Date.now();
  console.log(`▶ ${id}${language ? ` (${language})` : ""}: ${title}`);
  try {
    await body(c);
  } catch (error) {
    if (signal.aborted) { c.status = "not run"; c.details.push("interrupted"); cases.push(c); throw error; }
    if (error instanceof AccessibilityBlockedError || error instanceof DesktopBlockedError) { c.status = "blocked"; c.details.push(error.message); blocked = error.message; cases.push(c); throw error; }
    c.problems.push(error instanceof Error ? error.message : String(error));
  }
  // A failed step must not leave its menu open, or its session running, under the next case.
  await driver?.close().catch((error: unknown) => { c.problems.push(`menu left open: ${String(error)}`); });
  if (settle && driver?.alive()) await settleIfBusy(driver, signal).then(saved => { if (saved) { recordings.push(saved); c.details.push(`settled a session the case left running; saved ${saved}`); } })
    .catch((error: unknown) => { c.problems.push(`session left running: ${String(error)}`); });
  c.status ??= c.problems.length ? "fail" : "pass";
  const clicks = driver?.clicks.splice(0) ?? [];
  if (clicks.length) c.details.push(`clicks: ${clicks.join("; ")}`);
  c.details.push(`${((Date.now() - started) / 1000).toFixed(1)} s`);
  cases.push(c);
  console.log(`  ${c.status.toUpperCase()}${c.problems.length ? `: ${c.problems.join("; ")}` : ""}`);
  return c;
}

/**
 * Ends a countdown or recording that a failed case left behind: the status item's toggle when it
 * can be clicked, otherwise the registered recording shortcut. Resolves with a saved file, if any.
 */
async function settleIfBusy(tray: TrayDriver | undefined, bound: AbortSignal): Promise<string | undefined> {
  const state = currentState(lines());
  if (state !== "countdown" && state !== "recording" && state !== "starting") return undefined;
  const from = appLog.end();
  try { if (!tray) throw new Error("no driver"); await tray.click(); }
  catch (error) {
    const accelerator = registeredAccelerator(lines());
    const keystroke = accelerator ? acceleratorToKeystroke(accelerator) : undefined;
    if (!keystroke) throw new Error(`could not click the status item (${String(error)}) and no shortcut is registered`, { cause: error });
    await command("osascript", ["-e", keystrokeScript(keystroke)], bound, 5000);
  }
  for (const deadline = Date.now() + 30_000; ; await delay(200, undefined, { signal: bound })) {
    const since = lines(from);
    const outcome = recordingOutcome(since);
    if (outcome.settled && currentState(since) === "idle") return outcome.saved;
    if (Date.now() > deadline) throw new Error("the session did not settle within 30 s");
  }
}

async function waitState(from: LogCursor, state: string, timeoutMs = 30_000): Promise<void> {
  await waitForLog(appLog, from, new RegExp(`state → ${state}\\b`), `state → ${state}`, signal, timeoutMs);
}

/** The session's outcome once the app is idle again, read only from `from` on. */
async function waitSettled(from: LogCursor, timeoutMs = 30_000): Promise<ReturnType<typeof recordingOutcome> & { settled: true }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const since = lines(from);
    const outcome = recordingOutcome(since);
    if (outcome.settled && currentState(since) === "idle") return outcome;
    if (Date.now() > deadline) throw new Error(`the session did not settle in idle within ${timeoutMs / 1000} s`);
    await sleep(150);
  }
}

function listing(folder: string): Set<string> {
  try { return new Set(fs.readdirSync(folder)); } catch { return new Set(); }
}

/** A cancellation leaves no file, no failure and no notification, and idle still offers Show last recording. */
async function judgeCancelled(c: TrayCase, from: LogCursor, folder: string, before: Set<string>, language: Language, quit = false, hadLastRecording = true): Promise<void> {
  const since = lines(from);
  const outcome = recordingOutcome(since);
  if (!outcome.settled || !outcome.cancelled) c.problems.push(`expected a cancelled countdown, the log shows ${JSON.stringify(outcome)}`);
  const added = [...listing(folder)].filter(name => !before.has(name));
  if (added.length) c.problems.push(`new entries in the output folder: ${added.join(", ")}`);
  if (since.some(line => /\] notification: show requested/.test(line))) c.problems.push("a notification was requested");
  if (quit) return;
  const menu = await driver!.open();
  const kept = menu.items.some(item => item.title === t("Show last recording", language));
  await driver!.close();
  if (hadLastRecording && !kept) c.problems.push("idle no longer offers Show last recording");
}

async function frontmost(): Promise<string> {
  const asn = (await command("lsappinfo", ["front"], signal)).trim();
  const info = await command("lsappinfo", ["info", "-only", "name", asn], signal);
  return /"LSDisplayName"="([^"]*)"/.exec(info)?.[1] ?? info.trim();
}

async function finderWindowIds(): Promise<number[]> {
  const text = await command("osascript", ["-e", 'tell application "Finder" to get id of every Finder window'], signal);
  return text.split(",").map(part => Number(part.trim())).filter(Number.isInteger);
}

async function closeOwnedFinderWindows(): Promise<void> {
  for (const id of ownedFinderWindows) {
    await command("osascript", ["-e", `tell application "Finder"\nif exists Finder window id ${id} then close Finder window id ${id}\nend tell`], signal);
    ownedFinderWindows.delete(id);
  }
}

/** Start from the menu, read the countdown and recording menus, then Stop; returns the saved file. */
async function startStopFromMenu(language: Language, countdown: number): Promise<void> {
  let saved: string | undefined;
  await runCase("start-stop", "Start recording and Stop from the tray menu; countdown and recording menus", language, async c => {
    const from = appLog.end();
    await driver!.open();
    await driver!.select(t("Start recording", language));
    if (countdown > 0) {
      await waitState(from, "countdown", 10_000);
      const countdownCase = await runCase("menu-countdown", "Countdown menu against the model", language, async inner => { await readMenu(inner, "countdown", language); }, false);
      if (countdownCase.status === "fail") c.details.push("the countdown menu differed (see menu-countdown)");
    }
    await waitState(from, "recording", (countdown + 10) * 1000);
    await sleep(seconds * 1000);
    await runCase("menu-recording", "Recording menu against the model, folder items greyed", language, async inner => { await readMenu(inner, "recording", language); }, false);
    const stopFrom = appLog.end();
    await driver!.open();
    await driver!.select(t("Stop", language));
    const outcome = await waitSettled(stopFrom);
    if (!outcome.saved) c.problems.push(`Stop did not save: ${JSON.stringify(outcome)}`);
    else { saved = outcome.saved; recordings.push(saved); c.details.push(`saved ${saved}`); }
  });
  if (!saved) return;
  await runCase("show-last-recording", "Show last recording brings Finder forward with the file selected", language, async c => {
    const before = new Set(await finderWindowIds());
    revealBaseline = { ids: before, folder: path.dirname(saved!) };
    await driver!.open();
    await driver!.select(t("Show last recording", language));
    const fronts: string[] = [];
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      const front = await frontmost();
      if (fronts.at(-1) !== front) fronts.push(front);
      await sleep(100);
    }
    const run = (script: string): Promise<string> => command("osascript", ["-e", script], signal, 10_000);
    const selected = await run(FINDER_SELECTION_SCRIPT) || undefined;
    const selectedRow = await run(FINDER_SELECTED_ROW_SCRIPT) || undefined;
    const windowTarget = await run(FINDER_TARGET_SCRIPT) || undefined;
    for (const id of await finderWindowIds()) if (!before.has(id)) ownedFinderWindows.add(id);
    c.details.push(`front: ${fronts.join(" → ")}; row ${selectedRow ?? "none"} in ${windowTarget ?? "no window"}`);
    if (fronts.at(-1) !== "Finder") c.problems.push(`frontmost after 3 s is ${fronts.at(-1)}, not Finder`);
    if (!fileSelected(saved!, { selected, selectedRow, windowTarget })) c.problems.push(`Finder does not show ${path.basename(saved!)} selected`);
    await closeOwnedFinderWindows();
    revealBaseline = undefined;
  });
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") refuse("macOS only");
  const any = recordStuffPids();
  pid = bundlePid() ?? refuse(`${bundle} is not running; start it with \`pnpm start:app\` first`);
  if (any.some(other => other !== pid)) refuse("another RecordStuff bundle is running; quit it first, since both would own the same shortcuts");
  try { desktop = await beginDesktopRound(); }
  catch (error) { if (error instanceof DesktopBlockedError) { blocked = error.message; return; } throw error; }
  await waitSession(pid);
  driver = new TrayDriver(ax, pid, signal, undefined, bundleId);
  // Fails as blocked without Accessibility access, before the round owns anything.
  const status = await driver.status();
  owned = true;
  if (status.menu) await driver.close();
  const settings = storedSettings();
  const stored = isLanguage(settings["language"]) ? settings["language"] : "en";
  const countdown = typeof settings["countdown"] === "number" ? settings["countdown"] : 3;
  const folder = typeof settings["outputDir"] === "string" ? settings["outputDir"] : path.join(os.homedir(), "Movies/RecordStuff");
  const languages = (requestedLanguages as Language[] | undefined) ?? [stored, stored === "en" ? "zh-TW" : "en"] as Language[];
  const accelerator = registeredAccelerator(lines());
  notes.push(`bundle ${bundle}, pid ${pid}; stored language ${stored}; countdown ${countdown} s; output folder ${folder}; recording shortcut ${accelerator ?? "not registered"}`);
  const windowsAtStart = (await ax.windows(pid)).windows.map(window => window.title);
  if (windowsAtStart.length) notes.push(`RecordStuff windows at the start: ${JSON.stringify(windowsAtStart)}`);

  for (const [index, language] of languages.entries()) {
    const first = index === 0;
    const last = index === languages.length - 1;
    // The app reads its language at launch: write it only while the app is quit, set it back once it is gone.
    if (!first) await quitIdle();
    if (language !== stored && !languageOverride) {
      languageOverride = new StoredOverride<unknown>({ quit: quitIdle, running: () => bundlePid() !== undefined, write: writeLanguage, relaunch: launch }, settings["language"], language);
      await languageOverride.apply();
      notes.push(`stored language set to ${language} for the round; relaunched the same bundle (pid ${pid})`);
    } else if (language === stored && languageOverride?.pending) {
      const problem = await languageOverride.restore(false);
      if (problem) refuse(problem);
      await launch();
      notes.push(`stored language set back to ${language}; relaunched the same bundle (pid ${pid})`);
    } else if (!first) await launch();

    const idle = await runCase("menu-idle", "Idle menu against the model and the group rules", language, async c => {
      const items = await readMenu(c, "idle", language);
      // The count sits inside the text in Traditional Chinese (…：4 筆), so match both sides of it.
      const [head = "", tail = ""] = translate("Unreviewed recording failures: {value}", language, { value: "\u0000" }).split("\u0000");
      const unread = items?.some(item => item.title.startsWith(head) && item.title.endsWith(tail));
      c.details.push(unread ? "the unread-failures group is shown (N33a: idle with an unread failure)" : "no unread failure in this app's history: the unread group was not observed");
    });
    if (idle.status === "blocked") return;

    if (first) {
      await runCase("keyboard", "Arrow keys move the selection, Return chooses Settings…, ⌘W closes it", language, async c => {
        if (windowsAtStart.some(title => title.startsWith("RecordStuff - "))) { c.status = "not run"; c.details.push("a Settings window was already open"); return; }
        const menu = await driver!.open();
        const enabled = menu.items.filter(item => item.enabled).map(item => item.title);
        const firstDown = await driver!.navigate(KEY.down);
        const secondDown = await driver!.navigate(KEY.down);
        const up = await driver!.navigate(KEY.up);
        c.details.push(`Down → ${firstDown}, Down → ${secondDown}, Up → ${up}`);
        if (firstDown !== enabled[0] || secondDown !== enabled[1] || up !== enabled[0]) c.problems.push(`expected ${enabled[0]}, ${enabled[1]}, ${enabled[0]}`);
        const settingsLabel = t("Settings…", language);
        for (let i = 0; i < menu.items.length && (await driver!.status()).menu?.items.find(item => item.selected)?.title !== settingsLabel; i += 1) await driver!.navigate(KEY.down);
        if ((await driver!.status()).menu?.items.find(item => item.selected)?.title !== settingsLabel) { c.problems.push("the arrow keys never reached Settings…"); return; }
        await ax.key(KEY.return);
        await driver!.waitClosed();
        const title = t("RecordStuff - Settings", language);
        const opened = await driver!.until("the Settings window", async () => {
          const snapshot = await ax.windows(pid!);
          return snapshot.windows.some(window => window.title === title) ? snapshot : undefined;
        });
        const others = opened.windows.filter(window => window.title !== title).length;
        // ⌘W goes to the frontmost app: never send it unless that is RecordStuff with Settings focused.
        if (opened.frontmostPid !== pid || opened.focusedWindow !== title) { c.problems.push("RecordStuff with Settings focused is not frontmost after Settings… opened it; ⌘W not sent, Settings left open"); return; }
        await ax.key(KEY.w, FLAG.command);
        await driver!.until("the Settings window to close", async () => ((await ax.windows(pid!)).windows.some(window => window.title === title) ? undefined : true));
        if (others) c.details.push(`${others} other RecordStuff window(s) stayed as they were`);
      });
    }

    await startStopFromMenu(language, countdown);

    if (first && countdown > 0) {
      await runCase("cancel-second-click", "A second click on the status item cancels the countdown", language, async c => {
        const before = listing(folder);
        const from = appLog.end();
        await driver!.click();
        await waitState(from, "countdown", 10_000);
        await driver!.click();
        await waitSettled(from);
        await judgeCancelled(c, from, folder, before, language, false, recordings.length > 0);
      });
      await runCase("cancel-menu", "Cancel recording in the countdown menu cancels it", language, async c => {
        const before = listing(folder);
        const from = appLog.end();
        await driver!.click();
        await waitState(from, "countdown", 10_000);
        await driver!.open();
        await driver!.select(t("Cancel recording", language));
        await waitSettled(from);
        await judgeCancelled(c, from, folder, before, language, false, recordings.length > 0);
      });
    }

    if (first) {
      await runCase("stale-start", "A Start chosen after the state moved on does nothing", language, async c => {
        const keystroke = accelerator ? acceleratorToKeystroke(accelerator) : undefined;
        if (!keystroke) { c.status = "not run"; c.details.push("no registered recording shortcut to move the state while the menu is open"); return; }
        const from = appLog.end();
        await driver!.open();
        // Delivered once the menu closes: it reaches the app before the menu item's action does, if macOS queues it first.
        await command("osascript", ["-e", keystrokeScript(keystroke)], AbortSignal.any([signal, AbortSignal.timeout(5000)]), 5000);
        await driver!.select(t("Start recording", language));
        // Either the Start is ignored, or it won and a countdown (or, with the countdown Off, a recording) began.
        const hit = await waitForLog(appLog, from, /\] tray: Start recording ignored in state \w+$|state → (countdown|recording)\b/, "the ignored Start or the new session", signal, 5000).catch(() => undefined);
        const ignored = hit && /ignored/.test(hit.line) ? hit : await waitForLog(appLog, from, /\] tray: Start recording ignored in state \w+$/, "the ignored Start", signal, 500).catch(() => undefined);
        // Settle at once, so a countdown is cancelled before it records.
        const state = currentState(lines(from));
        if (state === "countdown" || state === "recording") await driver!.click();
        const outcome = await waitSettled(from);
        if (outcome.saved) { recordings.push(outcome.saved); c.details.push(`the shortcut's recording was saved as ${outcome.saved}`); }
        if (ignored) c.details.push(ignored.line.split("] ")[1]!);
        else { c.status = "not run"; c.details.push("macOS delivered the menu's Start before the queued shortcut, so the state had not moved on; nothing was ignored"); }
      });
    }

    if (first && !last && countdown > 0) {
      await runCase("quit-countdown", "Quit RecordStuff during the countdown cancels it and exits", language, async c => {
        const before = listing(folder);
        const from = appLog.end();
        await driver!.click();
        await waitState(from, "countdown", 10_000);
        await driver!.open();
        await driver!.select(t("Quit RecordStuff", language));
        await waitGone("Quit during the countdown");
        await judgeCancelled(c, from, folder, before, language, true);
        pid = undefined;
      });
      continue;
    }

    if (last) {
      await runCase("quit", "Quit RecordStuff from the idle menu exits every process", language, async () => {
        await driver!.open();
        await driver!.select(t("Quit RecordStuff", language));
        await waitGone("Quit RecordStuff");
        pid = undefined;
      });
    }
  }
}

let exitCode: number = 1;
const roundFrom = appLog.end();
try {
  await main();
} catch (error) {
  if (error instanceof Refused) roundError = error.message;
  else if (error instanceof AccessibilityBlockedError) blocked ??= error.message;
  else if (!signal.aborted) roundError = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  const bounded = AbortSignal.timeout(60_000);
  const step = async (what: string, action: () => Promise<void>): Promise<void> => {
    try { await action(); } catch (error) { cleanup.push(`${what}: ${String(error)}`); }
  };
  const cleanupAx = osascriptAx(bounded);
  const running = owned ? (() => { try { return bundlePid(); } catch { return undefined; } })() : undefined;
  if (running !== undefined) {
    const tray = new TrayDriver(cleanupAx, running, bounded, 10_000, bundleId);
    await step("close the menu", () => tray.close());
    await step("settle the round's recording", async () => {
      const saved = await settleIfBusy(tray, bounded);
      if (saved) recordings.push(saved);
    });
    await step("close Settings", async () => {
      const snapshot = await cleanupAx.windows(running);
      if (snapshot.frontmostPid === running && snapshot.focusedWindow?.startsWith("RecordStuff - ")) await cleanupAx.key(KEY.w, FLAG.command);
    });
  }
  await step("close Finder windows this round opened", async () => {
    // A reveal interrupted before its windows were listed: new windows showing the recordings' folder are the round's.
    if (revealBaseline) {
      const listed = await command("osascript", ["-e", `tell application "Finder"\nset found to {}\nrepeat with w in Finder windows\ntry\nif POSIX path of (target of w as alias) is ${JSON.stringify(`${revealBaseline.folder}/`)} then set end of found to id of w\nend try\nend repeat\nreturn found\nend tell`], bounded);
      for (const id of listed.split(",").map(part => Number(part.trim())).filter(Number.isInteger)) if (!revealBaseline.ids.has(id)) ownedFinderWindows.add(id);
    }
    for (const id of ownedFinderWindows) {
      await command("osascript", ["-e", `tell application "Finder"\nif exists Finder window id ${id} then close Finder window id ${id}\nend tell`], bounded);
    }
    ownedFinderWindows.clear();
  });
  if (owned) {
    await step("quit RecordStuff", async () => {
      const left = bundlePid();
      if (left === undefined) return;
      if (!confirmedIdleFor(lines(), String(left))) throw new Error(`pid ${left} is not confirmed idle; left running`);
      await command("osascript", ["-e", `tell application ${JSON.stringify(bundle)} to quit`], bounded, 15_000);
      for (const deadline = Date.now() + 30_000; bundlePid() !== undefined; await delay(200)) if (Date.now() > deadline) throw new Error("still running 30 s after quit");
    });
  }
  // After the quit, with no dependency on the round's (possibly aborted) signal: a running app would write the round's value back.
  if (languageOverride?.pending) {
    await step("restore the stored language", async () => {
      const problem = await languageOverride!.restore(false);
      if (problem) throw new Error(`${problem}; quit RecordStuff, then set "language" back in ${settingsPath}`);
    });
  }
  const remaining = (() => { try { return pgrepPids(`^${bundle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/Contents/`); } catch (error) { return [String(error)]; } })();
  if (remaining.length) cleanup.push(`processes of ${bundle} still running: ${remaining.join(", ")}`);
  desktop?.end();
  if (fs.existsSync(logPath)) fs.writeFileSync(path.join(out, "app.log"), `${evidenceSince(appLog, roundFrom).join("\n")}\n`);
  const verdict = classifyTrayRound({ cases, cleanup, roundError, blocked, lockedAt: desktop?.lockedAt, interrupted: interrupted !== undefined });
  const report = renderTrayReport({ verdict, cases, cleanup, notes, recordings, roundError, blocked, desktop: desktop?.summary, bundle, interrupted });
  fs.writeFileSync(path.join(out, "report.md"), report);
  fs.writeFileSync(path.join(out, "result.json"), `${JSON.stringify({ verdict, cases, cleanup, notes, recordings, roundError, blocked, desktop: desktop?.summary, bundle }, null, 2)}\n`);
  console.log(`${verdict.status}: ${verdict.reasons.join("; ") || "every case passed"}\nReport: ${path.join(out, "report.md")}`);
  // An interrupted round that left nothing behind exits 130/143, as the other runners do.
  exitCode = verdict.status === "INTERRUPTED" && interrupted ? INTERRUPT_EXIT[interrupted] : verdict.exitCode;
}
process.exit(exitCode);
