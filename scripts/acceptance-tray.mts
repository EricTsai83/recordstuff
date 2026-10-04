/**
 * `pnpm acceptance:tray` (plan 063, step 4; docs/system-design/tooling.md#tray-acceptance):
 * operates the running RecordStuff bundle's real status item and menu with
 * CoreGraphics clicks and keys and Accessibility actions, and judges what the
 * native menu, the app log and the output folder show. The menu of
 * idle, countdown and recording is compared with the production model's
 * `tray: menu opened` line for the same popup, in each requested language;
 * Start, Stop, Open RecordStuff (2026-10-04, formerly Settings…), Show last recording
 * (the window on Recordings with the newest take focused), a left click
 * that opens the menu when that is the choice, the three cancellations (second click,
 * Cancel recording, Quit), a Start chosen after the state moved on, keyboard
 * navigation and Quit RecordStuff are exercised. Screenshots of each menu are
 * saved for visual review, which this runner never claims. The round leaves
 * the app closed. macOS only; nothing here ships with the app.
 *
 * `--long-start <run>` (plan 065) instead drives a controlled acceptance build
 * whose `prepare=hold` fault keeps a start in starting: the shortcut within the
 * one-second grace (ignored and logged) and after it (cancelled), a left click
 * after it (cancelled, with the starting menu compared), and Quit while the
 * start is held (cancelled at once).
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
import { INTERRUPT_EXIT, escapeRegExp, pgrepPids, recordStuffPattern, recordStuffPids } from "./lib/processes.mts";
import { APP_LOG_PATH, APP_SETTINGS_PATH, readAppSettings, writeAppSettings } from "./lib/runner-env.mts";
import { StoredOverride } from "./lib/stored-override.mts";
import { TrayDriver, compareMenu, parseMenuLogLine, structureProblems, type TrayState } from "./lib/tray-driver.mts";
import { classifyTrayRound, recordingCardOpenId, renderTrayReport, type TrayCase } from "./lib/tray-acceptance.mts";
import { CONTROLLED_TOOL, SETTINGS_FILE_VERSION } from "./lib/controlled-acceptance.mts";
import { playPrefix } from "./lib/notification-acceptance.mts";
import { developmentAppPath } from "./lib/verification-timing.mts";
import { controlledPid, readJson, sendControlled, type Until } from "./lib/controlled-client.mts";
import type { ControlledCommand } from "./fixtures/controlled-acceptance";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `pnpm acceptance:tray [-- options]
  --languages en,zh-TW   languages to cover, in order (default: the stored language, then the other)
  --seconds <n>          how long each tray recording runs before Stop (default 3)
  --bundle <app>         the RecordStuff.app under test (default dist/mac-arm64/RecordStuff.app, dist/mac on Intel)
  --log <file>           its log (default ~/Library/Logs/recordstuff/recordstuff.log)
  --settings <file>      its settings.json (default the app's), read for the language, countdown and folder
  --long-start <run>     plan 065's long-start cases against the running controlled build of <run>
                         (pnpm acceptance:controlled -- launch); its bundle, log and settings are the defaults
Run after \`pnpm start:app\` (or \`pnpm open:app\`) with the app idle. Records two or more short takes of the
current display into the app's output folder and keeps them; quits the app at the end. --long-start records
nothing: each start is held before capture and cancelled.`;

const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) { console.error(`${name} needs a value\n${USAGE}`); process.exit(2); }
  return value;
};
if (argv.includes("--help")) { console.log(USAGE); process.exit(0); }
const known = new Set(["--languages", "--seconds", "--bundle", "--log", "--settings", "--long-start"]);
for (let i = 0; i < argv.length; i += 2) if (!known.has(argv[i]!)) { console.error(`unknown argument ${argv[i]}\n${USAGE}`); process.exit(2); }
/** The controlled run whose held starts plan 065's cases cancel; its data lives under the run directory. */
const longStartRun = option("--long-start") === undefined ? undefined : path.resolve(option("--long-start")!);
if (longStartRun && (argv.includes("--languages") || argv.includes("--seconds"))) { console.error(`--long-start runs in the stored language and records nothing\n${USAGE}`); process.exit(2); }
const runFile = (relative: string): string | undefined => longStartRun && path.join(longStartRun, relative);
const bundle = path.resolve(option("--bundle")
  ?? runFile(path.join("workspace/dist", process.arch === "arm64" ? "mac-arm64" : "mac", "RecordStuff.app"))
  ?? developmentAppPath(root)).replace(/\/$/, "");
const logPath = path.resolve(option("--log") ?? runFile("logs/recordstuff.log") ?? APP_LOG_PATH);
const settingsPath = path.resolve(option("--settings") ?? runFile("user-data/settings.json") ?? APP_SETTINGS_PATH);
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
const out = fs.mkdtempSync(path.join(root, "docs/verification/measurements", `${stamp}-${longStartRun ? "tray-long-start" : "tray-acceptance"}-`));
const cases: TrayCase[] = [];
const recordings: string[] = [];
const notes: string[] = [];
const cleanup: string[] = [];
let desktop: DesktopRound | undefined;
let driver: TrayDriver | undefined;
let pid: number | undefined;
let languageOverride: StoredOverride<unknown> | undefined;
/**
 * The icon's left click for the round (2026-10-04): the click cases need the click that records, and
 * the menu-click case the one that opens the menu. Set only while the app is quit; set back after the round.
 */
let clickOverride: StoredOverride<unknown> | undefined;
let roundError: string | undefined;
let blocked: string | undefined;
/** Set once preflight accepted this bundle and pid; cleanup operates no app it never took over (review pass 2). */
let owned = false;

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

/**
 * What the app's left click does with the stored settings, by its own rule (settings.ts `parseSettings`):
 * no file is a new install, which opens the menu; a file without the choice, or with one it does not
 * support, keeps the click that records.
 */
function effectiveTrayClick(): "menu" | "record" {
  const settings = readAppSettings(settingsPath);
  if (!settings) return "menu";
  return settings["trayClick"] === "menu" ? "menu" : "record";
}

/**
 * Sets one stored preference while the app is quit. Without a file the app runs on its defaults; a file
 * holding only this key would not parse (settings.ts needs a version and an absolute outputDir) and the
 * app would ignore it, so the new install's defaults are written with it, the click that opens the menu included.
 */
function writeSetting(key: string, value: unknown): void {
  const settings = readAppSettings(settingsPath)
    ?? { version: SETTINGS_FILE_VERSION, outputDir: path.join(os.homedir(), "Movies", "RecordStuff"), trayClick: "menu" };
  if (value === undefined) delete settings[key]; else settings[key] = value;
  writeAppSettings(settings, settingsPath);
}

function writeTrayClick(value: unknown): void {
  writeSetting("trayClick", value);
}

/** Quits the idle app, stores the click for the round and relaunches the same bundle. */
async function useClick(value: "menu" | "record"): Promise<void> {
  if (!clickOverride) {
    // Without a file the app's default is the menu: restoring "no key" would turn it into the click that records.
    const original = readAppSettings(settingsPath) ? storedSettings()["trayClick"] : "menu";
    clickOverride = new StoredOverride<unknown>({ quit: quitIdle, running: () => bundlePid() !== undefined, write: writeTrayClick, relaunch: launch }, original, value);
    await clickOverride.apply();
  } else {
    await quitIdle();
    writeTrayClick(value);
    await launch();
  }
  notes.push(`stored icon click set to ${value} for the round; relaunched the same bundle (pid ${pid})`);
}

function writeLanguage(value: unknown): void {
  writeSetting("language", value);
}

const t = (key: PlainMessageKey, language: Language): string => translate(key, language);
/** Why the countdown cases cannot run: with the stored countdown Off a start records at once. */
const COUNTDOWN_OFF = "the stored countdown is Off, so there is no countdown to cancel; set a countdown to run this case";

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
/** `YYYY-MM-DD HH-MM-SS` of an app-named recording (recorder.ts formatTimestamp), comparable as text; undefined for other names. */
function stampOf(file: string): string | undefined {
  return /^(\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2})(?:-\d+)?\.mp4$/.exec(path.basename(file))?.[1];
}

/** The title a Recordings card shows (settings-model.ts libraryView): the local time for an app-named file, else its name. */
function cardTitle(file: string, language: Language): string {
  const stamp = stampOf(file)?.match(/\d+/g)?.map(Number);
  if (!stamp) return path.basename(file).replace(/\.[^.]+$/, "");
  const [y, mo, d, h, mi, sec] = stamp as [number, number, number, number, number, number];
  return new Intl.DateTimeFormat(language, { hour: "numeric", minute: "2-digit" }).format(new Date(y, mo - 1, d, h, mi, sec));
}

/** Electron and Node may space a time differently (U+202F before PM): compare without spaces. */
const squeeze = (text: string): string => text.replace(/[\s\u00a0\u202f]/g, "");

/** A case this round cannot reach, listed as not run with why, so the report never implies it passed. */
function notRun(id: string, title: string, language: Language | undefined, reason: string): void {
  console.log(`▶ ${id}${language ? ` (${language})` : ""}: ${title}\n  NOT RUN: ${reason}`);
  cases.push({ id, title, language, status: "not run", evidence: "scripted input", problems: [], details: [reason], screenshots: [] });
}

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
  // An interruption during this is not the case's failure: the round's cleanup closes and settles instead.
  await driver?.close().catch((error: unknown) => { if (!signal.aborted) c.problems.push(`menu left open: ${String(error)}`); });
  if (settle && driver?.alive() && !signal.aborted) await settleIfBusy(driver, signal).then(saved => { if (saved) { recordings.push(saved); c.details.push(`settled a session the case left running; saved ${saved}`); } })
    .catch((error: unknown) => { if (!signal.aborted) c.problems.push(`session left running: ${String(error)}`); });
  if (signal.aborted && !c.problems.length) { c.status = "not run"; c.details.push("interrupted"); cases.push(c); throw signal.reason; }
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
  const toggle = async (): Promise<void> => {
    try { if (!tray) throw new Error("no driver"); await tray.click(); }
    catch (error) {
      const accelerator = registeredAccelerator(lines());
      const keystroke = accelerator ? acceleratorToKeystroke(accelerator) : undefined;
      if (!keystroke) throw new Error(`could not click the status item (${String(error)}) and no shortcut is registered`, { cause: error });
      await command("osascript", ["-e", keystrokeScript(keystroke)], bound, 5000);
    }
  };
  await toggle();
  let retoggled = false;
  for (const deadline = Date.now() + 30_000; ; await delay(200, undefined, { signal: bound })) {
    const since = lines(from);
    const outcome = recordingOutcome(since);
    const state = currentState(since);
    if (outcome.settled && state === "idle") return outcome.saved;
    // Within a start's first second the toggle is only logged (START_CANCEL_GRACE_MS); once the start moved on, toggle again.
    if (!retoggled && (state === "countdown" || state === "recording") && since.some(line => line.includes(" toggle ignored while starting "))) {
      retoggled = true;
      await toggle();
    }
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

/** A cancellation leaves no file, no failure and no notification, and idle offers Start recording again. */
async function judgeCancelled(c: TrayCase, from: LogCursor, folder: string, before: Set<string>, language: Language, quit = false): Promise<void> {
  const since = lines(from);
  const outcome = recordingOutcome(since);
  if (!outcome.settled || !outcome.cancelled) c.problems.push(`expected a cancelled countdown, the log shows ${JSON.stringify(outcome)}`);
  const added = [...listing(folder)].filter(name => !before.has(name));
  if (added.length) c.problems.push(`new entries in the output folder: ${added.join(", ")}`);
  if (since.some(line => /\] notification: show requested/.test(line))) c.problems.push("a notification was requested");
  if (quit) return;
  const menu = await driver!.open();
  const kept = menu.items.some(item => item.title === t("Start recording", language) && item.enabled);
  await driver!.close();
  if (!kept) c.problems.push("idle does not offer Start recording again");
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
    } else notRun("menu-countdown", "Countdown menu against the model", language, COUNTDOWN_OFF);
    await waitState(from, "recording", (countdown + 10) * 1000);
    await sleep(seconds * 1000);
    await runCase("menu-recording", "Recording menu against the model, folder items greyed", language, async inner => { await readMenu(inner, "recording", language); }, false);
    const stopFrom = appLog.end();
    await driver!.open();
    await driver!.select(t("Stop", language));
    const outcome = await waitSettled(stopFrom);
    if (!outcome.saved) c.problems.push(`Stop did not save: ${JSON.stringify(outcome)}`);
    else { saved = outcome.saved; recordings.push(saved); c.details.push(`saved ${saved}`); }
    // The saved banner follows 500 ms after the save (saved-notification.ts): let it land here, or the next
    // case, which would otherwise start inside that half second, counts it as one of its own.
    if (saved) {
      const name = path.basename(saved);
      await waitForLog(appLog, stopFrom, new RegExp(`notification: (?!saved scheduled).*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the saved notification's outcome", signal, 3000).catch(() => undefined);
    }
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
  // The click cases toggle with a left click: a stored "menu" (a new install) is set to "record" for the round.
  if (effectiveTrayClick() === "menu") await useClick("record");
  const windowsAtStart = (await ax.windows(pid!)).windows.map(window => window.title);
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
      await runCase("keyboard", "Arrow keys move the selection, Return chooses Open RecordStuff, ⌘W closes it", language, async c => {
        if (windowsAtStart.some(title => title === "RecordStuff")) { c.status = "not run"; c.details.push("a Settings window was already open"); return; }
        const menu = await driver!.open();
        const enabled = menu.items.filter(item => item.enabled).map(item => item.title);
        const firstDown = await driver!.navigate(KEY.down);
        const secondDown = await driver!.navigate(KEY.down);
        const up = await driver!.navigate(KEY.up);
        c.details.push(`Down → ${firstDown}, Down → ${secondDown}, Up → ${up}`);
        if (firstDown !== enabled[0] || secondDown !== enabled[1] || up !== enabled[0]) c.problems.push(`expected ${enabled[0]}, ${enabled[1]}, ${enabled[0]}`);
        const settingsLabel = t("Open RecordStuff", language);
        for (let i = 0; i < menu.items.length && (await driver!.status()).menu?.items.find(item => item.selected)?.title !== settingsLabel; i += 1) await driver!.navigate(KEY.down);
        if ((await driver!.status()).menu?.items.find(item => item.selected)?.title !== settingsLabel) { c.problems.push("the arrow keys never reached Open RecordStuff"); return; }
        await ax.key(KEY.return);
        await driver!.waitClosed();
        const title = "RecordStuff";
        const opened = await driver!.until("the Settings window", async () => {
          const snapshot = await ax.windows(pid!);
          return snapshot.windows.some(window => window.title === title) ? snapshot : undefined;
        });
        const others = opened.windows.filter(window => window.title !== title).length;
        // ⌘W goes to the frontmost app: never send it unless that is RecordStuff with Settings focused.
        if (opened.frontmostPid !== pid || opened.focusedWindow !== title) { c.problems.push("RecordStuff with its window focused is not frontmost after Open RecordStuff; ⌘W not sent, the window left open"); return; }
        await ax.key(KEY.w, FLAG.command);
        await driver!.until("the Settings window to close", async () => ((await ax.windows(pid!)).windows.some(window => window.title === title) ? undefined : true));
        if (others) c.details.push(`${others} other RecordStuff window(s) stayed as they were`);
      });
    }

    await startStopFromMenu(language, countdown);

    if (first) {
      await runCase("show-last", "Show last recording opens RecordStuff on Recordings with the newest recording focused, not the folder", language, async c => {
        if ((await ax.windows(pid!)).windows.some(window => window.title === "RecordStuff")) { c.status = "not run"; c.details.push("a RecordStuff window was already open"); return; }
        const saved = recordings.at(-1);
        const from = appLog.end();
        await driver!.open();
        await driver!.select(t("Show last recording", language));
        const entry = await waitForLog(appLog, from, /\] show last recording: (.*)$/, "the Show last recording entry", signal, 10_000);
        c.details.push(entry.line.split("] ")[1]!);
        // The app picks the Recordings tab's first card. Only an app-named file older than this round's save is wrong:
        // a newer one, or a file the folder dates by its birth time, can rightly come first (review pass 1, F1).
        const target = /show last recording: Recordings with (.+)$/.exec(entry.line)?.[1];
        if (!target) { c.problems.push("no recording was named, although this round saved one"); return; }
        const older = saved !== undefined && target !== saved && stampOf(target) !== undefined && stampOf(saved) !== undefined && stampOf(target)! < stampOf(saved)!;
        if (older) c.problems.push(`it named ${target}, older than this round's save ${saved}`);
        else if (saved !== undefined && target !== saved) c.details.push(`the folder's first card is ${target}, not this round's save`);
        const title = "RecordStuff";
        const opened = await driver!.until("the RecordStuff window", async () => {
          const snapshot = await ax.windows(pid!);
          return snapshot.windows.some(window => window.title === title) ? snapshot : undefined;
        });
        // What the page focused once it rendered the entry; Chromium builds its accessibility tree only when asked, asynchronously.
        await ax.enableWebAccessibility(pid!);
        let focused = "", domId = "";
        for (const until = Date.now() + 3000; ; await delay(150)) {
          const now = (await ax.windows(pid!)).focused;
          focused = now ? now.description || now.title : "";
          domId = now?.domId ?? "";
          if (focused.startsWith(playPrefix(language)) || Date.now() > until) break;
        }
        c.details.push(`focused: ${focused || "nothing"}${domId ? ` (#${domId})` : ""}`);
        // That card's own Play button, by its id, which names the file (review pass 2): titles repeat within a minute.
        // Without an id from Accessibility the title is the weaker check, and the details say so (review pass 1, F2).
        const expectedId = recordingCardOpenId(target);
        const titleOf = cardTitle(target, language);
        if (!focused.startsWith(playPrefix(language))) c.problems.push("no recording's Play button is focused");
        else if (domId) { if (domId !== expectedId) c.problems.push(`the focused Play button is #${domId}, not ${path.basename(target)}'s #${expectedId}`); }
        else {
          c.details.push("Accessibility gave no element id; judged by the card's title");
          if (!squeeze(focused).includes(squeeze(titleOf))) c.problems.push(`the focused Play button is not ${path.basename(target)}'s (its title ${titleOf} is not in the name)`);
        }
        if (lines(from).some(line => /openPath|reveal|Finder/.test(line))) c.problems.push("it opened the folder");
        // ⌘W goes to the frontmost app: never send it unless that is RecordStuff with its window focused.
        const front = await ax.windows(pid!);
        if (front.frontmostPid !== pid || front.focusedWindow !== title) { c.problems.push("RecordStuff with its window focused is not frontmost; ⌘W not sent, the window left open"); return; }
        await ax.key(KEY.w, FLAG.command);
        await driver!.until("the RecordStuff window to close", async () => ((await ax.windows(pid!)).windows.some(window => window.title === title) ? undefined : true));
        if (opened.windows.length > 1) c.details.push(`${opened.windows.length - 1} other RecordStuff window(s) stayed as they were`);
      });
    }

    if (first && countdown > 0) {
      await runCase("cancel-second-click", "A second click on the status item cancels the countdown", language, async c => {
        const before = listing(folder);
        const from = appLog.end();
        await driver!.click();
        await waitState(from, "countdown", 10_000);
        await driver!.click();
        await waitSettled(from);
        await judgeCancelled(c, from, folder, before, language, false);
      });
      await runCase("cancel-menu", "Cancel recording in the countdown menu cancels it", language, async c => {
        const before = listing(folder);
        const from = appLog.end();
        await driver!.click();
        await waitState(from, "countdown", 10_000);
        await driver!.open();
        await driver!.select(t("Cancel recording", language));
        await waitSettled(from);
        await judgeCancelled(c, from, folder, before, language, false);
      });
    } else if (first) {
      notRun("cancel-second-click", "A second click on the status item cancels the countdown", language, COUNTDOWN_OFF);
      notRun("cancel-menu", "Cancel recording in the countdown menu cancels it", language, COUNTDOWN_OFF);
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

    if (first && !last && countdown === 0) notRun("quit-countdown", "Quit RecordStuff during the countdown cancels it and exits", language, COUNTDOWN_OFF);
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
      await runCase("menu-click", "With the menu as the icon's click, a left click opens the idle menu and starts nothing", language, async c => {
        await useClick("menu");
        const from = appLog.end();
        await driver!.click();
        const menu = await driver!.until("the menu from a left click", async () => {
          const snapshot = await driver!.status();
          return snapshot.menu?.items.length ? snapshot.menu : undefined;
        }, 5000).catch(() => undefined);
        if (!menu) { c.problems.push("a left click opened no menu"); return; }
        c.details.push(`${menu.items.length} items; ${menu.items.some(item => item.title === t("Start recording", language)) ? "Start recording offered" : "no Start recording"}`);
        if (!menu.items.some(item => item.title === t("Start recording", language))) c.problems.push("the menu a left click opened offers no Start recording");
        await driver!.close();
        await sleep(500);
        const moved = lines(from).find(line => /\] state → /.test(line));
        if (moved) c.problems.push(`the left click changed the state: ${moved.split("] ")[1]}`);
      });
      await runCase("quit", "Quit RecordStuff from the idle menu exits every process", language, async () => {
        await driver!.open();
        await driver!.select(t("Quit RecordStuff", language));
        await waitGone("Quit RecordStuff");
        pid = undefined;
      });
    }
  }
}

/** The controlled build's command channel, bounded by `bound`. */
let prepareArmed = false;
/** The long-start round's language, for cleanup's Cancel recording. */
let longStartLanguage: Language = "en";
function control(dir: string, request: ControlledCommand, bound: AbortSignal = signal): ReturnType<typeof sendControlled> {
  const until: Until = async (read, label, timeoutMs) => {
    for (const deadline = Date.now() + timeoutMs; ; await delay(100, undefined, { signal: bound })) {
      const value = read();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    }
  };
  return sendControlled(dir, request, until);
}

/** The host answered and the build holds that answer: the start is held, not merely slow. */
async function waitHeld(dir: string): Promise<void> {
  for (const deadline = Date.now() + 30_000; ; await sleep(150)) {
    if ((await control(dir, { kind: "status" })).snapshot.held.prepare > 0) return;
    if (Date.now() > deadline) throw new Error("the capture host's prepared reply was not held within 30 s");
  }
}

/**
 * Releases the held reply of a cancelled start; the Recorder stops it as a stale session's.
 * Also judges what plan 065 requires of a cancel: no failure entry in the history.
 */
async function releaseCancelled(c: TrayCase, dir: string, from: LogCursor, historyBefore: number): Promise<void> {
  const { released, snapshot } = await control(dir, { kind: "release", target: "prepare" });
  if (released !== 1) c.problems.push(`released ${released} held prepared replies, expected 1`);
  const stale = await waitForLog(appLog, from, /\] recorder: stopping stale session \S+ \(prepared\)$/, "the released reply stopped as stale", signal, 10_000).catch(() => undefined);
  if (stale) c.details.push(stale.line.split("] ")[1]!);
  else c.problems.push("the released prepared reply was not stopped as a stale session's");
  if ((snapshot.history?.length ?? 0) !== historyBefore) c.problems.push(`the failure history changed from ${historyBefore} to ${snapshot.history?.length ?? 0} entries`);
}

/** Plan 065, step 4: long starts held by a controlled build, cancelled by the real shortcut, click and Quit. */
async function longStart(dir: string): Promise<void> {
  if (process.platform !== "darwin") refuse("macOS only");
  if (readJson<{ tool?: string }>(path.join(dir, "run.json"))?.tool !== CONTROLLED_TOOL) refuse(`${dir} is not an acceptance:controlled run`);
  const any = recordStuffPids();
  pid = bundlePid() ?? refuse(`${bundle} is not running; start it with \`pnpm acceptance:controlled -- launch\` first`);
  if (any.some(other => other !== pid)) refuse("another RecordStuff bundle is running; quit it first, since both would own the same shortcuts");
  if (controlledPid(dir) !== pid) refuse(`pid ${pid} is not the app ${path.join(dir, "ready.json")} reported`);
  try { desktop = await beginDesktopRound(); }
  catch (error) { if (error instanceof DesktopBlockedError) { blocked = error.message; return; } throw error; }
  await waitSession(pid);
  driver = new TrayDriver(ax, pid, signal, undefined, bundleId);
  const status = await driver.status();
  owned = true;
  if (status.menu) await driver.close();
  const settings = storedSettings();
  const language: Language = isLanguage(settings["language"]) ? settings["language"] : "en";
  longStartLanguage = language;
  const folder = typeof settings["outputDir"] === "string" ? settings["outputDir"] : path.join(dir, "recordings");
  const accelerator = registeredAccelerator(lines());
  const historyBefore = (await control(dir, { kind: "status" })).snapshot.history?.length ?? 0;
  await control(dir, { kind: "fault", name: "prepare", mode: "hold" });
  prepareArmed = true;
  notes.push(`long-start mode: controlled run ${dir}; bundle ${bundle}, pid ${pid}; language ${language}; output folder ${folder}; recording shortcut ${accelerator ?? "not registered"}; prepare=hold armed; ${historyBefore} history entries`);
  // The grace is measured from the start; each cancelling press waits past it with a margin.
  const pastGrace = 1300;
  // A controlled run cannot be relaunched with another icon click: when the click opens the menu, a held
  // start begins from the menu's Start recording instead, and the case about the click's cancel cannot run.
  const clickRecords = effectiveTrayClick() === "record";
  const startHeld = async (): Promise<void> => {
    if (clickRecords) await driver!.click();
    else { await driver!.open(); await driver!.select(t("Start recording", language)); }
  };
  notes.push(`icon click ${clickRecords ? "starts and stops recording" : "opens the menu; held starts begin from Start recording"}`);

  await runCase("long-start-shortcut", "The shortcut within the grace is ignored and logged; after it, it cancels the held start", language, async c => {
    const keystroke = accelerator ? acceleratorToKeystroke(accelerator) : undefined;
    if (!keystroke) { c.status = "not run"; c.details.push("no registered recording shortcut"); return; }
    const before = listing(folder);
    const from = appLog.end();
    // One script, so the second press follows the first by the delay rather than by another osascript launch.
    await command("osascript", ["-e", `${keystrokeScript(keystroke)}\ndelay 0.2\n${keystrokeScript(keystroke)}`], signal, 10_000);
    await waitState(from, "starting", 10_000);
    const ignored = await waitForLog(appLog, from, /\] recorder: session \S+ toggle ignored while starting \((\d+) ms after the start\)$/, "the ignored second press", signal, 5000);
    const ms = Number(/\((\d+) ms after/.exec(ignored.line)?.[1]);
    c.details.push(`second press: ${ignored.line.split("] ")[1]}`);
    if (!(ms < 1000)) c.problems.push(`the ignored press came ${ms} ms after the start, not within the grace`);
    await waitHeld(dir);
    await sleep(pastGrace);
    if (currentState(lines(from)) !== "starting") { c.problems.push(`the held start left starting before the third press: ${currentState(lines(from))}`); return; }
    await command("osascript", ["-e", keystrokeScript(keystroke)], signal, 10_000);
    const cancelled = await waitForLog(appLog, from, /\] recorder: session \S+ cancelled \(toggle\) while preparing capture$/, "the shortcut's cancel", signal, 10_000);
    c.details.push(`third press: ${cancelled.line.split("] ")[1]}`);
    await waitSettled(from);
    await releaseCancelled(c, dir, from, historyBefore);
    await judgeCancelled(c, from, folder, before, language, false);
  });

  await runCase("long-start-click", "The starting menu names the shortcut; a left click after the grace cancels the held start", language, async c => {
    if (!clickRecords) { c.status = "not run"; c.details.push("the stored icon click opens the menu; set Icon click to Start / stop recording for this run"); return; }
    const before = listing(folder);
    const from = appLog.end();
    await driver!.click();
    await waitState(from, "starting", 10_000);
    // Seen after the state was logged, so never earlier than the Recorder's own start (review pass 1).
    const startedBy = Date.now();
    await waitHeld(dir);
    await readMenu(c, "starting", language);
    if (c.status === "not run") return;
    const cancel = (await waitForLog(appLog, from, /\] tray: menu opened in starting: /, "the starting menu line", signal, 1000)).line;
    if (accelerator && !cancel.includes(`"accelerator":"${accelerator}"`)) c.problems.push(`the starting menu does not name ${accelerator}`);
    await sleep(Math.max(0, pastGrace - (Date.now() - startedBy)));
    if (currentState(lines(from)) !== "starting") { c.problems.push(`the held start left starting before the click: ${currentState(lines(from))}`); return; }
    await driver!.click();
    const cancelled = await waitForLog(appLog, from, /\] recorder: session \S+ cancelled \(toggle\) while preparing capture$/, "the click's cancel", signal, 10_000);
    c.details.push(cancelled.line.split("] ")[1]!);
    await waitSettled(from);
    await releaseCancelled(c, dir, from, historyBefore);
    await judgeCancelled(c, from, folder, before, language, false);
  });

  await runCase("long-start-quit", "Quit RecordStuff while the start is held cancels it at once and exits", language, async c => {
    const before = listing(folder);
    const from = appLog.end();
    await startHeld();
    await waitState(from, "starting", 10_000);
    await waitHeld(dir);
    await driver!.open();
    // Timed from before the press: select() itself waits until the menu, or the app, is gone (review pass 1).
    const chosen = Date.now();
    await driver!.select(t("Quit RecordStuff", language));
    await waitGone("Quit while the start is held", 20_000);
    const seconds = (Date.now() - chosen) / 1000;
    pid = undefined;
    prepareArmed = false;
    c.details.push(`exited ${seconds.toFixed(1)} s after Quit RecordStuff`);
    if (seconds > 10) c.problems.push(`the exit took ${seconds.toFixed(1)} s, as if it waited for the capture request`);
    const since = lines(from);
    const line = since.find(text => /\] recorder: session \S+ cancelled \(quit\) while preparing capture$/.test(text));
    if (line) c.details.push(line.split("] ")[1]!);
    else c.problems.push("no `cancelled (quit) while preparing capture` line");
    if (since.some(text => /capture request timed out after cancel \(quit\)/.test(text))) c.problems.push("the quit waited for the capture request to time out");
    await judgeCancelled(c, from, folder, before, language, true);
  });
}

let exitCode: number = 1;
const roundFrom = appLog.end();
try {
  await (longStartRun ? longStart(longStartRun) : main());
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
    // A held start is cancelled before its reply is released: released first, with the countdown Off it
    // would send `record` and save a recording this mode never makes (review pass 1). Nothing stays armed.
    if (longStartRun && prepareArmed) await step("cancel a held start, then turn prepare=hold off and release held replies", async () => {
      if (currentState(lines()) === "starting") {
        const from = appLog.end();
        await tray.open();
        await tray.select(t("Cancel recording", longStartLanguage));
        await waitForLog(appLog, from, /\] cancelled: session \S+ /, "the held start's cancel", bounded, 10_000);
      }
      await control(longStartRun, { kind: "fault", name: "prepare", mode: "off" }, bounded);
      await control(longStartRun, { kind: "release", target: "prepare" }, bounded);
      prepareArmed = false;
    });
    await step("settle the round's recording", async () => {
      const saved = await settleIfBusy(tray, bounded);
      if (saved) recordings.push(saved);
    });
    await step("close Settings", async () => {
      const snapshot = await cleanupAx.windows(running);
      if (snapshot.frontmostPid === running && snapshot.focusedWindow === "RecordStuff") await cleanupAx.key(KEY.w, FLAG.command);
    });
  }
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
  if (clickOverride?.pending) {
    await step("restore the stored icon click", async () => {
      const problem = await clickOverride!.restore(false);
      if (problem) throw new Error(`${problem}; quit RecordStuff, then set "trayClick" back in ${settingsPath}`);
    });
  }
  const remaining = (() => { try { return pgrepPids(`^${escapeRegExp(bundle)}/Contents/`); } catch (error) { return [String(error)]; } })();
  if (remaining.length) cleanup.push(`processes of ${bundle} still running: ${remaining.join(", ")}`);
  desktop?.end();
  if (fs.existsSync(logPath)) fs.writeFileSync(path.join(out, "app.log"), `${evidenceSince(appLog, roundFrom).join("\n")}\n`);
  const verdict = classifyTrayRound({ cases, cleanup, roundError, blocked, lockedAt: desktop?.lockedAt, interrupted: interrupted !== undefined });
  const report = renderTrayReport({ verdict, cases, cleanup, notes, recordings, roundError, blocked, desktop: desktop?.summary, bundle, interrupted });
  fs.writeFileSync(path.join(out, "report.md"), report);
  fs.writeFileSync(path.join(out, "result.json"), `${JSON.stringify({ verdict, cases, cleanup, notes, recordings, roundError, blocked, desktop: desktop?.summary, bundle }, null, 2)}\n`);
  // The counts, not "every case passed": a not-run case did not pass.
  const tally = `${verdict.counts.pass} passed${verdict.counts["not run"] ? `, ${verdict.counts["not run"]} not run` : ""}`;
  console.log(`${verdict.status}: ${verdict.reasons.join("; ") || tally}\nReport: ${path.join(out, "report.md")}`);
  // An interrupted round that left nothing behind exits 130/143, as the other runners do.
  exitCode = verdict.status === "INTERRUPTED" && interrupted ? INTERRUPT_EXIT[interrupted] : verdict.exitCode;
}
process.exit(exitCode);
