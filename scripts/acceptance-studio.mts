/**
 * `pnpm acceptance:studio [-- --skip-first-click] [--skip-hover] [--out <dir>]` (plan 082): the Recording Studio's
 * first click and its pacing on the packaged app, macOS only; never shipped. Build and quit the bundle first
 * (`pnpm start:app`, then Quit). The runner launches it, opens the Studio from the tray's Open Recording Studio…, moves
 * its window to another display and opens the moving test material full screen on the primary, so another app is in
 * front as during a recording made there. Then:
 *
 * - **First click.** Live preview pressed once with a CoreGraphics click, found through Chromium's accessibility tree
 *   (turned off again before the click), three ways: (a) as `measure:cpu` presses it, at once; (b) 2 s after the tree
 *   is turned off; (c) with RecordStuff made frontmost first. Each is judged by whether the press started a Live
 *   preview within 8 s (`recorder: session … prepared after`), and the frontmost app and focused window before the
 *   click are reported. On 2026-10-19 (a) and (b) started nothing and (c) did: the click an inactive window takes only
 *   to activate itself, which plan 082's D1 keeps as macOS has it. (a) and (b) are reported, (c) must start it.
 * - **Hover** (plan 081's D1). With a Live preview running and the material in front, the pointer is moved, never
 *   clicked, onto the Studio's preview and away again: the app's log must say `studio: preview at 10 a second` once
 *   it is over the window and `at 5` once it has been away longer than the Studio's 3 s.
 *
 * Each Live preview is stopped with Stop preview and its release (`cancelled (preview)`) awaited. The report,
 * `report.md` and `report.json`, goes under `docs/verification/measurements/<time>-studio-acceptance/` (gitignored).
 * The runner changes no setting, quits the app normally, confirms it exited and closes the material. Exit 0 when every
 * judged check passed, 1 when one failed or cleanup was incomplete, 2 when blocked (no Accessibility grant, a locked
 * screen, an app already running), 130/143 when interrupted.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { APP_LOG_PATH, APP_SETTINGS_PATH, readAppSettings, runnerArgs } from "./lib/runner/runner-env.mts";
import { INTERRUPT_EXIT, electronPattern, escapeRegExp, pgrepPids, recordStuffPids, signalPids, command } from "./lib/runner/processes.mts";
import { confirmedIdle, waitForLog } from "./lib/acceptance/acceptance-runtime.mts";
import { createMaterialProfile, currentRunId, materialOpenArgs, removeMaterialProfile } from "./lib/acceptance/acceptance.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/runner/desktop-session.mts";
import { LogReader, type LogCursor } from "./lib/runner/log-reader.mts";
import { AccessibilityBlockedError, centre, osascriptAx, type Frame } from "./lib/runner/native-ax.mts";
import { roundExit } from "./lib/runner/round-exit.mts";
import { developmentAppPath } from "./lib/runner/verification-timing.mts";
import { isLanguage, translate, type Language } from "../src/shared/i18n.ts";
import { TrayDriver } from "./lib/acceptance/tray-driver.mts";
import { STUDIO_ACTIVE_MS as ACTIVE_MS } from "../src/shared/studio-port.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = developmentAppPath(REPO_ROOT);
const EXECUTABLE = path.join(BUNDLE, "Contents/MacOS/RecordStuff");
const BUNDLE_ID = (): string => spawnSync("plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(BUNDLE, "Contents/Info.plist")], { encoding: "utf8" }).stdout?.trim() || "com.ericts.record";
const ELECTRON_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
const ELECTRON_APP_REAL = fs.existsSync(ELECTRON_APP) ? fs.realpathSync(ELECTRON_APP) : ELECTRON_APP;
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
/** How long a press may take to start a Live preview: preparing took under 1 s in 081's rounds. */
const PRESS_MS = 8000;
const LIVE_PREVIEW = ["Live preview", "即時預覽"];
const STOP_PREVIEW = ["Stop preview", "停止預覽"];

const usage = "usage: pnpm acceptance:studio [-- --skip-first-click] [--skip-hover] [--out <dir>]";
let skipFirstClick = false, skipHover = false;
let outDir: string | undefined;
const argv = runnerArgs();
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--skip-first-click") skipFirstClick = true;
  else if (arg === "--skip-hover") skipHover = true;
  else if (arg === "--out" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) outDir = argv[++i];
  else { console.error(usage); process.exit(2); }
}
if (skipFirstClick && skipHover) { console.error(usage); process.exit(2); }

const controller = new AbortController();
let interruptedBy: keyof typeof INTERRUPT_EXIT | undefined;
for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.on(name, () => { interruptedBy ??= name; controller.abort(new Error(`interrupted by ${name}`)); });
}
const sleep = (ms: number): Promise<void> => delay(ms, undefined, { signal: controller.signal });
const log = new LogReader(APP_LOG_PATH);
const events: string[] = [];
const note = (text: string): void => { events.push(`${new Date().toISOString()} ${text}`); console.log(text); };
class Failure extends Error {}
const fail = (message: string): never => { throw new Failure(message); };
/** A missing prerequisite (no second display, no material in front): the round is blocked, not failed (exit 2). */
class Blocked extends Error {}
const blocked = (message: string): never => { throw new Blocked(message); };
const running = (): number | undefined => recordStuffPids()[0];

interface Check { check: string; expected: string; actual: string; verdict: "pass" | "fail" | "report" }

async function main(): Promise<number> {
  if (process.platform !== "darwin" || !fs.existsSync(EXECUTABLE)) {
    console.error(process.platform !== "darwin" ? "BLOCKED: macOS only" : `BLOCKED: no bundle at ${BUNDLE}: build it with \`pnpm start:app\`, then quit it`);
    return 2;
  }
  if (running() !== undefined || pgrepPids(electronPattern(ELECTRON_APP_REAL, "bundle")).length > 0) {
    console.error("BLOCKED: RecordStuff or this project's Electron.app is running: quit it first; this runner launches the bundle itself");
    return 2;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = outDir ?? path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-studio-acceptance`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) fail("output directory is not empty");
  fs.mkdirSync(dir, { recursive: true });
  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message}`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });
  const checks: Check[] = [];
  const cleanup: string[] = [];
  let runError: unknown;
  let appPid = 0;
  let launchIssued = false;
  let previewing = false;
  /** The material's `open`, kept so cleanup waits for a launch still on its way (as measure-cpu.mts does). */
  let launcher: ChildProcess | undefined;
  const profile = createMaterialProfile("studio");
  const materialPids = (): number[] => pgrepPids(escapeRegExp(profile));
  const ax = () => osascriptAx(controller.signal, 30_000);
  const stored = readAppSettings(APP_SETTINGS_PATH)?.["language"];
  const language: Language = isLanguage(stored) ? stored : "en";

  /** Launches the bundle and waits for idle with screen recording allowed and the startup work settled. */
  const launch = async (): Promise<void> => {
    const from = log.end();
    launchIssued = true;
    await command("open", ["-a", BUNDLE], AbortSignal.timeout(15_000));
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const start = await waitForLog(log, from, /\] start: /, "`start:`", signal, 60_000);
    await waitForLog(log, start.at, /\] ready;/, "`ready;`", signal, 60_000);
    await waitForLog(log, start.at, /recording history: (loaded|load failed)/, "the history load", signal, 60_000);
    while (!confirmedIdle(log.since(start.at).lines.map((line) => line.text))) {
      if (signal.aborted && !controller.signal.aborted) fail("RecordStuff did not confirm idle with screen-recording permission within 60 s");
      await sleep(200);
    }
    appPid = running() ?? fail("RecordStuff did not stay running after launch");
    launchIssued = false;
    note(`RecordStuff pid ${appPid}, run ${currentRunId([start.line, ...log.since(start.at).lines.map((line) => line.text)]) ?? "?"}`);
  };
  const quitApp = async (): Promise<void> => {
    if (launchIssued && running() === undefined) for (const end = Date.now() + 10_000; running() === undefined && Date.now() < end;) await delay(250);
    if (running() === undefined) return;
    await command("osascript", ["-e", `tell application ${JSON.stringify(BUNDLE)} to quit`], AbortSignal.timeout(15_000));
    for (const end = Date.now() + 30_000; running() !== undefined;) {
      if (Date.now() > end) fail("RecordStuff did not exit within 30 s of Quit");
      await delay(200);
    }
  };
  /** The Settings window's frame, as the window list reads it. */
  const studioFrame = async (): Promise<Frame> =>
    (await ax().windows(appPid)).windows.find((window) => window.title === "RecordStuff")?.frame ?? fail("the Recording Studio's window is not open");
  /** Who is in front and which window is focused, said before each press. */
  const front = async (): Promise<string> => {
    const snapshot = await ax().windows(appPid);
    return snapshot.frontmostPid === appPid ? `RecordStuff frontmost, focused window ${snapshot.focusedWindow ?? "none"}` : `another app frontmost (pid ${snapshot.frontmostPid ?? "none"})`;
  };
  /**
   * Brings the material's browser to the front, as when a recording is made in another app; a round that cannot is
   * blocked, since every case here assumes another app in front.
   */
  const materialToFront = async (): Promise<void> => {
    const pids = materialPids();
    if (!pids.length) blocked("the material browser is not running, so no other app can be in front");
    await command("osascript", ["-l", "JavaScript", "-e", `const se = Application("System Events");
      for (const pid of ${JSON.stringify(pids)}) { const p = se.processes.whose({ unixId: pid }); if (p.length) { p[0].frontmost = true; break; } }`], AbortSignal.timeout(10_000));
    await sleep(800);
    const snapshot = await ax().windows(appPid);
    if (snapshot.frontmostPid === appPid || snapshot.frontmostPid === null || !materialPids().includes(snapshot.frontmostPid)) {
      blocked(`the material browser did not come to the front (frontmost pid ${snapshot.frontmostPid ?? "none"})`);
    }
  };
  const appToFront = async (): Promise<void> => {
    await command("osascript", ["-e", `tell application id ${JSON.stringify(BUNDLE_ID())} to activate`], AbortSignal.timeout(10_000));
    await sleep(800);
  };
  /** Where the named control is, read through the accessibility tree, which is then turned off again. */
  const locate = async (titles: readonly string[]): Promise<{ x: number; y: number }> => {
    await ax().enableWebAccessibility(appPid);
    let frame: Frame | undefined;
    try {
      for (let attempt = 0; attempt < 20 && !frame; attempt += 1) {
        const layout = await ax().layout(appPid, "RecordStuff", { width: 10_000, height: 10_000 });
        frame = layout.clickable.find((element) => titles.includes(element.title))?.frame;
        if (!frame) await sleep(250);
      }
    } finally {
      await ax().enableWebAccessibility(appPid, false);
    }
    return centre(frame ?? fail(`no element titled ${titles.join(" or ")} in Settings`));
  };
  const started = (from: LogCursor): Promise<boolean> =>
    waitForLog(log, from, /recorder: session \S+ prepared after|studio: Live preview not started/, "the Live preview's start", controller.signal, PRESS_MS)
      .then((hit) => hit.line.includes("prepared after"), (error: unknown) => { if (controller.signal.aborted) throw error; return false; });
  const stopPreview = async (): Promise<void> => {
    if (!previewing) return;
    await appToFront();
    const point = await locate(STOP_PREVIEW);
    const from = log.end();
    await ax().mouse("left", point.x, point.y);
    await waitForLog(log, from, /cancelled \(preview\)/, "the Live preview let go of", controller.signal, 15_000);
    previewing = false;
  };
  /** One press of Live preview from another app in front, prepared `how`; judged by whether it started the preview. */
  const press = async (label: string, how: "at once" | "after 2 s" | "app in front", expected: "starts" | "report"): Promise<void> => {
    await materialToFront();
    const point = await locate(LIVE_PREVIEW);
    if (how === "after 2 s") await sleep(2000);
    if (how === "app in front") await appToFront();
    const before = await front();
    const from = log.end();
    await ax().mouse("left", point.x, point.y);
    const ok = await started(from);
    if (ok) previewing = true;
    checks.push({ check: `First click, ${label}: one press of Live preview, ${how}`, expected: "a Live preview starts",
      actual: `${ok ? "started" : "nothing started within 8 s"}; before the click: ${before}`,
      verdict: expected === "report" ? "report" : ok ? "pass" : "fail" });
    note(`${label}: ${ok ? "started" : "nothing"} (${before})`);
    await stopPreview();
  };

  try {
    await launch();
    const tray = new TrayDriver(ax(), appPid, controller.signal, undefined, BUNDLE_ID());
    await tray.open();
    await tray.select(translate("Open Recording Studio…", language));
    await sleep(3000);
    // To another display, as measure:cpu stands it, so the material's full screen does not hide it.
    const aside = await command("osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit");
      const screens = $.NSScreen.screens, main = screens.objectAtIndex(0).frame;
      let target = null;
      for (let i = 1; i < screens.count; i++) { const f = screens.objectAtIndex(i).frame; target = { x: f.origin.x + 40, y: main.size.height - (f.origin.y + f.size.height) + 80 }; break; }
      if (target) { const p = Application("System Events").processes.whose({ unixId: ${appPid} })[0]; p.windows[0].position = [Math.round(target.x), Math.round(target.y)]; }
      JSON.stringify(target)`], AbortSignal.timeout(10_000)).then((output) => output.trim(), () => "null");
    if (aside === "null") blocked("the Recording Studio needs a second display to stand beside the material");
    await sleep(1500);
    const frame = await studioFrame();
    note(`the Recording Studio at ${frame.x},${frame.y} ${frame.width}x${frame.height}`);
    launcher = spawn("open", materialOpenArgs(MATERIAL, profile), { stdio: "ignore" });
    note("test material opened full screen on the primary display; waiting 5 s");
    await sleep(5000);
    if (!materialPids().length) blocked("the test material did not open (Google Chrome is needed)");

    if (!skipFirstClick) {
      // (a) and (b) show the first click on an inactive window, which D1 leaves to activate it: reported, not judged.
      await press("(a)", "at once", "report");
      await press("(b)", "after 2 s", "report");
      await press("(c)", "app in front", "starts");
    }
    if (!skipHover) {
      await materialToFront();
      const point = await locate(LIVE_PREVIEW);
      await appToFront();
      const from = log.end();
      await ax().mouse("left", point.x, point.y);
      if (!await started(from)) fail("Hover: Live preview did not start with RecordStuff in front");
      previewing = true;
      await materialToFront();
      // The pointer on the material, then away for longer than the Studio's full rate lasts after the click.
      const primary = await command("osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit"); const f = $.NSScreen.screens.objectAtIndex(0).frame; JSON.stringify({ x: f.size.width / 2, y: f.size.height / 2 })`], AbortSignal.timeout(10_000));
      const away = JSON.parse(primary) as { x: number; y: number };
      await ax().move(away.x, away.y);
      await sleep(ACTIVE_MS + 1500);
      const studio = await studioFrame();
      // Over the preview, which takes the top of the Studio: no control there takes a hover.
      const over = { x: Math.round(studio.x + studio.width / 2), y: Math.round(studio.y + Math.min(studio.height / 3, 260)) };
      const enter = log.end();
      await ax().move(over.x, over.y);
      const full = await waitForLog(log, enter, /studio: preview at 10 a second/, "`preview at 10 a second`", controller.signal, 5000).then(() => true, (error: unknown) => { if (controller.signal.aborted) throw error; return false; });
      checks.push({ check: "Hover: the pointer moved onto the Studio, no click, another app in front", expected: "`studio: preview at 10 a second` within 5 s",
        actual: full ? "logged" : "not logged", verdict: full ? "pass" : "fail" });
      await sleep(1500);
      const leave = log.end();
      await ax().move(away.x, away.y);
      const rest = await waitForLog(log, leave, /studio: preview at 5 a second/, "`preview at 5 a second`", controller.signal, 3000).then(() => true, (error: unknown) => { if (controller.signal.aborted) throw error; return false; });
      checks.push({ check: "Hover: the pointer moved away again", expected: "`studio: preview at 5 a second` within 3 s (no input since the click)",
        actual: rest ? "logged" : "not logged", verdict: rest ? "pass" : "fail" });
      note(`hover: full rate ${full ? "logged" : "missing"}, resting ${rest ? "logged" : "missing"}`);
      await stopPreview();
    }
  } catch (error) {
    runError = error;
  } finally {
    // Interrupted, the round's signal is spent: the quit below releases a Live preview, as it does any held session.
    if (previewing && !controller.signal.aborted) {
      try { await stopPreview(); } catch (error) { cleanup.push(`could not stop the Live preview: ${String(error)}`); }
    } else if (previewing) note("interrupted with a Live preview running: the quit releases it");
    // Nothing here may skip the quit, the desktop round's end or the report.
    try {
      // `open` returns once Launch Services started Chrome; before that there may be nothing yet to close.
      const opening = launcher;
      if (opening && opening.exitCode === null && opening.signalCode === null) await Promise.race([new Promise((resolve) => opening.once("exit", resolve)), delay(10_000)]);
      for (let attempt = 0; attempt < 40 && materialPids().length > 0; attempt += 1) { signalPids(materialPids(), "SIGTERM"); await delay(250); }
      if (opening && opening.exitCode === null && opening.signalCode === null) cleanup.push("the material launch (`open`) had not settled, so Chrome may still start");
      else if (materialPids().length > 0) cleanup.push(`could not close the material browser (private profile ${profile})`);
      else {
        const problem = await removeMaterialProfile(profile);
        if (problem) cleanup.push(`could not remove the material profile: ${problem}`);
      }
    } catch (error) { cleanup.push(`could not close the material browser: ${String(error)}`); }
    try { await quitApp(); } catch (error) { cleanup.push(String(error)); }
    desktop.end();
  }

  const failed = checks.some((check) => check.verdict === "fail");
  const cleanupIncomplete = cleanup.length > 0;
  const prerequisite = runError instanceof AccessibilityBlockedError || runError instanceof Blocked;
  const errored = Boolean(runError) && !prerequisite;
  const { outcome, code } = roundExit({ cleanupIncomplete, interrupted: interruptedBy, locked: desktop.lockedAt !== undefined, failed: failed || errored, blocked: prerequisite });
  const result = cleanupIncomplete ? "INCOMPLETE CLEANUP" : outcome.toUpperCase();
  const report = [
    "# Recording Studio acceptance (`pnpm acceptance:studio`)", "",
    `Result: **${result}**.${runError ? ` Stopped by: ${runError instanceof Error ? runError.message : String(runError)}.` : ""}`, "",
    "| Check | Expected | Actual | Verdict |", "| --- | --- | --- | --- |",
    ...checks.map((check) => `| ${check.check} | ${check.expected} | ${check.actual} | ${check.verdict} |`), "",
    "## Cleanup", "", cleanupIncomplete ? cleanup.map((line) => `- ${line}`).join("\n") : "Complete: RecordStuff exited and the material closed; no setting was changed.", "",
    "## Desktop", "", desktop.summary, "",
    "## Events", "", ...events.map((line) => `- ${line}`), "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify({ result, checks, cleanup, events, error: runError ? String(runError) : null }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "report.md"), report);
  console.log(`Report ${path.relative(REPO_ROOT, dir)}/report.md`);
  console.log(result);
  return code;
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof Failure ? `FAIL: ${error.message}` : error);
  process.exit(error instanceof Failure ? 1 : 2);
});
