/**
 * Settings entry by its global shortcut. Without options this is the System Events entry step
 * only (the callback), and the panel is judged by observation. `--observe` (plan 063, step 5)
 * also asserts through Accessibility that the window opened in front with focus, that Tab moves
 * the focused control, that the application menu binds no Reload or Developer Tools shortcut and
 * that ⌘R and ⌘⌥I leave the focus where it was, and that minimize, restore, close and reopen work,
 * as scripted evidence kept apart from the callback. Layout and appearance stay with the Settings
 * fixture screenshots. `--quit` then ends the round with ⌘Q and asserts that every process of the
 * bundle exits; without it the panel is left open for the next step.
 */
import fs from "node:fs";
import { escapeRegExp } from "./lib/processes.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS_SHORTCUT } from "../src/shared/hotkey.ts";
import { acceleratorToKeystroke, keystrokeScript, lastStartIndex, registeredSettingsAccelerator } from "./lib/acceptance.mts";
import { command, waitForLog } from "./lib/acceptance-runtime.mts";
import { LogReader, evidenceSince } from "./lib/log-reader.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound, type DesktopRound } from "./lib/desktop-session.mts";
import { AccessibilityBlockedError, FLAG, KEY, judgeAppMenu, osascriptAx, type WindowSnapshot } from "./lib/native-ax.mts";
import { APP_LOG_PATH, APP_SETTINGS_PATH, readAppSettings } from "./lib/runner-env.mts";
import { isLanguage, translate } from "../src/shared/i18n.ts";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(root, "dist/mac-arm64/RecordStuff.app/Contents/MacOS/RecordStuff");
const logPath = APP_LOG_PATH;
const args = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
const observe = args[0] === "--observe";
const quit = observe && args[1] === "--quit";
if (args.length !== (quit ? 2 : observe ? 1 : 0)) throw new Error("usage: pnpm acceptance:settings-shortcut [-- --observe [--quit]]");
fs.mkdirSync(path.join(root, "docs/verification/measurements"), { recursive: true });
const out = fs.mkdtempSync(path.join(root, "docs/verification/measurements/", `${new Date().toISOString().replaceAll(":", "-")}-settings-entry-`));
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort(new Error(`interrupted: ${signal}`)));
const appLog = new LogReader(logPath);
const roundFrom = appLog.end();
let evidence = "";
/** Accessibility checks of `--observe`, each `pass`/`fail` with what was seen; empty without it. */
const observations: Array<{ check: string; ok: boolean; seen: string }> = [];
let desktop: DesktopRound | undefined;
const sleep = (ms: number): Promise<void> => delay(ms, undefined, { signal: controller.signal });
try {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This runner requires the local macOS arm64 pnpm start:app bundle.");
  // The panel this opens is judged by native observation on an awake, unlocked display.
  desktop = await beginDesktopRound();
  // pgrep exits 1 when nothing matches; that is the not-running case the check below explains.
  const pid = (await command("pgrep", ["-f", `^${escapeRegExp(appPath)}$`], controller.signal, 5000, [0, 1])).trim();
  if (!/^\d+$/.test(pid)) throw new Error("Expected exactly one local RecordStuff bundle process.");
  const lines = appLog.all();
  const start = lines[lastStartIndex(lines)];
  if (!start?.endsWith(`; executable ${appPath}`)) throw new Error("Latest app log does not belong to the local bundle.");
  if (registeredSettingsAccelerator(lines) !== SETTINGS_SHORTCUT) throw new Error("Settings shortcut is not currently registered (conflict, capture, failure or older build). No key sent.");
  const script = keystrokeScript(acceleratorToKeystroke(SETTINGS_SHORTCUT)!);
  evidence = `PID: ${pid}\nExecutable: ${appPath}\nSent: ${SETTINGS_SHORTCUT}\nAppleScript: ${script}\n`;
  /** One System Events send and its callback, the only route this runner opens Settings by. */
  const send = async (): Promise<void> => {
    const from = appLog.end();
    await command("osascript", ["-e", script], controller.signal);
    const hit = await waitForLog(appLog, from, new RegExp(`\\] settings shortcut: ${escapeRegExp(SETTINGS_SHORTCUT)} pressed$`), "Settings shortcut callback", controller.signal);
    evidence += `Observed: ${hit.line}\n`;
  };
  const ax = osascriptAx(controller.signal);
  const settings = readAppSettings(APP_SETTINGS_PATH) ?? {};
  const title = translate("RecordStuff - Settings", isLanguage(settings["language"]) ? settings["language"] : "en");
  const settingsWindow = (snapshot: WindowSnapshot) => snapshot.windows.find(window => window.title === title);
  /** Polls the app's windows for up to 30 s, the skill's limit for one UI state. */
  const until = async (what: string, accept: (snapshot: WindowSnapshot) => boolean): Promise<WindowSnapshot> => {
    let snapshot = await ax.windows(Number(pid));
    for (const deadline = Date.now() + 30_000; !accept(snapshot); snapshot = await ax.windows(Number(pid))) {
      if (Date.now() > deadline) throw new Error(`${what} did not happen within 30 s: ${JSON.stringify(snapshot)}`);
      await sleep(150);
    }
    return snapshot;
  };
  const check = (name: string, ok: boolean, seen: string): void => { observations.push({ check: name, ok, seen }); };
  /** Command chords go to the frontmost app: send them only while RecordStuff is in front with Settings focused (review pass 2). */
  const chord = async (code: number, what: string, flags: number = FLAG.command): Promise<void> => {
    const snapshot = await ax.windows(Number(pid));
    if (snapshot.frontmostPid !== Number(pid) || snapshot.focusedWindow !== title) throw new Error(`${what} not sent: RecordStuff with Settings focused is not frontmost (${JSON.stringify(snapshot)})`);
    await ax.key(code, flags);
  };
  const inFront = (snapshot: WindowSnapshot, when: string): void => {
    const window = settingsWindow(snapshot);
    check(`${when}: the Settings window is main and focused, and RecordStuff is frontmost`,
      Boolean(window?.main && !window.minimized && snapshot.focusedWindow === title && snapshot.frontmostPid === Number(pid)),
      `window ${JSON.stringify(window)}, focused window ${JSON.stringify(snapshot.focusedWindow)}, frontmost pid ${snapshot.frontmostPid}`);
  };
  if (observe) {
    if (settingsWindow(await ax.windows(Number(pid)))) throw new Error("Settings is already open; close it so the round opens it from another app. No key sent.");
    // Another app in front first, as the native entry case requires; Finder is always running and activating it opens no window.
    await command("osascript", ["-e", 'tell application "Finder" to activate'], controller.signal);
    await sleep(500);
  }
  await send();
  if (observe) {
    inFront(await until("the Settings window to open in front", snapshot => settingsWindow(snapshot)?.main === true && snapshot.frontmostPid === Number(pid)), "open");
    // Chromium builds its accessibility tree only for assistive software; this is the switch they use, and it changes nothing visible.
    await ax.enableWebAccessibility(Number(pid));
    const before = await until("a focused control in Settings", snapshot => snapshot.focused !== null);
    await ax.key(KEY.tab);
    const describe = (snapshot: WindowSnapshot): string => JSON.stringify(snapshot.focused);
    const after = await until("Tab to move the focus", snapshot => snapshot.focused !== null && describe(snapshot) !== describe(before)).catch(() => undefined);
    check("Tab moves the focused control", after !== undefined, `${describe(before)} → ${after ? describe(after) : "unchanged"}`);
    // Electron's default menu would bind Reload and Developer Tools, which may open docked and
    // add no window; the menu shows either binding whatever the panel does.
    const menus = await ax.menuBar(Number(pid));
    const { bound, missing } = judgeAppMenu(menus);
    check("the application menu binds neither ⌘R (Reload) nor ⌘⌥I (Developer Tools) and keeps ⌘C, ⌘V, ⌘M and ⌘Q",
      bound.length === 0 && missing.length === 0,
      `menus ${menus.map(menu => menu.title).join(", ")}${bound.length ? `; bound ${bound.join(", ")}` : ""}${missing.length ? `; missing ${missing.join(", ")}` : ""}`);
    // A reload resets the focus Tab placed, and Developer Tools would take it.
    for (const [code, flags, name] of [[KEY.r, FLAG.command, "⌘R"], [KEY.i, FLAG.command | FLAG.option, "⌘⌥I"]] as const) {
      const kept = describe(await ax.windows(Number(pid)));
      await chord(code, name, flags);
      let moved: WindowSnapshot | undefined;
      for (const deadline = Date.now() + 2000; !moved && Date.now() < deadline; await sleep(150)) {
        const snapshot = await ax.windows(Number(pid));
        if (describe(snapshot) !== kept || settingsWindow(snapshot)?.main !== true) moved = snapshot;
      }
      check(`${name} neither reloads Settings nor opens Developer Tools: the focus stays`, moved === undefined, moved ? `${kept} → ${describe(moved)}` : `${kept} for 2 s`);
    }
    await chord(KEY.m, "⌘M");
    const minimized = await until("⌘M to minimize Settings", snapshot => settingsWindow(snapshot)?.minimized === true).catch(() => undefined);
    check("⌘M minimizes the Settings window", minimized !== undefined, JSON.stringify(minimized ? settingsWindow(minimized) : "not minimized"));
    await send();
    inFront(await until("the shortcut to restore Settings", snapshot => settingsWindow(snapshot)?.minimized === false && snapshot.frontmostPid === Number(pid)), "restored by a second send");
    await chord(KEY.w, "⌘W");
    const closed = await until("⌘W to close Settings", snapshot => !settingsWindow(snapshot)).catch(() => undefined);
    check("⌘W closes the Settings window", closed !== undefined, closed ? "no Settings window" : "still open");
    await send();
    inFront(await until("the shortcut to reopen Settings", snapshot => settingsWindow(snapshot)?.main === true && snapshot.frontmostPid === Number(pid)), "reopened by a third send");
    if (quit) {
      await chord(KEY.q, "⌘Q");
      // The main process and every helper run from inside the bundle.
      const bundle = `^${escapeRegExp(path.resolve(appPath, "../../.."))}/`;
      let left = "";
      for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(250)) {
        left = (await command("pgrep", ["-f", bundle], controller.signal, 5000, [0, 1])).trim();
        if (!left) break;
      }
      check("⌘Q quits RecordStuff: every process of the bundle exits", !left, left ? `still running after 30 s: pids ${left.split("\n").join(", ")}` : "no process left");
    }
  }
  desktop.end();
  if (desktop.lockedAt) throw new DesktopBlockedError(desktop.summary);
  const failed = observations.filter(observation => !observation.ok);
  const table = observations.length ? `\n## Accessibility observation (scripted, --observe)\n\n| Check | Result | Seen |\n| --- | --- | --- |\n${observations.map(o => `| ${o.check} | ${o.ok ? "PASS" : "FAIL"} | ${o.seen.replaceAll("|", "\\|")} |`).join("\n")}\n` : "";
  const verdict = failed.length ? "FAIL" : "PASS";
  fs.writeFileSync(path.join(out, "report.md"), `# Settings shortcut entry — ${verdict}${observe ? "" : " (callback only)"}\n\n## Callback (scripted input)\n\n${evidence}${desktop.summary}\nNo IPC or test-only opening route.\n${table}\n${observe
    ? `Accessibility state is scripted evidence: it does not judge layout, appearance or legibility, which stay with the \`pnpm acceptance:settings\` screenshots or an observation. ${quit ? "The round ended with ⌘Q." : "The panel is left open, as the entry step always leaves it."}`
    : "Panel visibility, focus, keyboard navigation and recording continuity are NOT verified by this script. Run it with `-- --observe` or continue with an observation; do not report full UI acceptance from this exit code."}\n`);
  if (failed.length) {
    console.error(`FAIL: ${failed.map(o => o.check).join("; ")}\nEvidence: ${out}`);
    process.exitCode = 1;
  } else console.log(`PASS: Settings callback received${observe ? "; Accessibility checks passed" : ". Continue with an observation of the panel"}. Evidence: ${out}`);
} catch (error) {
  desktop?.end();
  const blocked = error instanceof DesktopBlockedError || error instanceof AccessibilityBlockedError;
  const seen = observations.map(o => `${o.ok ? "PASS" : "FAIL"} ${o.check}: ${o.seen}`).join("\n");
  fs.writeFileSync(path.join(out, "report.md"), `# Settings shortcut entry — ${blocked ? "BLOCKED" : "FAIL"}\n\n${evidence}\n${seen ? `${seen}\n\n` : ""}${String(error)}\n\nNo permission settings were changed. Check System Events/Accessibility permission if macOS refused the command.\n`);
  console.error(`${blocked ? "BLOCKED: " : ""}${String(error)}\nEvidence: ${out}`);
  process.exitCode = blocked ? DESKTOP_BLOCKED_EXIT : 1;
} finally {
  if (fs.existsSync(logPath)) fs.writeFileSync(path.join(out, "app.log"), evidenceSince(appLog, roundFrom).join("\n"));
}
