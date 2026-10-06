/**
 * Electron main for `pnpm acceptance:settings-native` (plan 066): the Settings cases that need the desktop, kept from
 * the former settings fixture when its other cases moved to the background Playwright suite (tests/ui). The built
 * preload and page in the app's own window (`settingsWindowOptions`, with the frame macOS draws), shown and
 * activated, with real Electron input events sent to the page:
 *
 * - N-S001: the window has the app's frame (no title bar on macOS; the native one elsewhere).
 * - N-S103: a window another one deactivated draws no focus border, and it returns with the window.
 * - N-S105: a day rollover while another window is in front keeps the focused action for when it returns.
 *
 * Activation-dependent cases are judged only when the window stayed active around them (plan 057,
 * settings-activation.mts); otherwise they did not run and the round is blocked. Never a production entry.
 * Compiled by acceptance-settings-native.mts before Electron loads it.
 */
import { app, BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RecordingResults } from "../../src/main/recording/recording-result";
import { settingsView } from "../../src/main/settings/settings-model";
import { DEFAULT_QUALITY } from "../../src/shared/quality";
import { DEFAULT_HOTKEY } from "../../src/shared/hotkey";
import type { AppContext } from "../../src/main/app/ui-model";
import type { SettingsView } from "../../src/shared/settings-panel";
import { settingsWindowOptions } from "../../src/main/settings/settings-window";
import { activation, judgeActive, lsappinfoName, windowActive, type Activation, type FixtureFailure, type SettingsCase, type WindowState } from "../lib/acceptance/settings-activation.mts";

const [outDir, root] = (() => {
  const [output, repository] = process.argv.slice(-2);
  if (!output || !repository) throw new Error("Expected output and repository directories");
  return [output, repository] as const;
})();
const out = path.join(root, "out");
app.setPath("userData", path.join(outDir, "user-data"));
const results: SettingsCase[] = [];
const push = (result: SettingsCase): void => {
  results.push(result);
  console.log(`case ${results.length}: ${result.notRun ? "NOT RUN" : result.ok ? "PASS" : "FAIL"} — ${result.name}`);
};
const record = (name: string, ok: boolean, detail: string): void => push({ name, ok, detail });
const writeResults = (): void => fs.writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
/** A `capturePage()` that threw, with the file it was for and the window at that moment (plan 057). */
class CaptureFailed extends Error {
  constructor(readonly failure: FixtureFailure) { super(`capturePage() failed for ${failure.screenshot}: ${failure.error}`); }
}
const frontmost = (): string | undefined => {
  if (process.platform !== "darwin") return undefined;
  const asn = spawnSync("lsappinfo", ["front"], { encoding: "utf8", timeout: 2000 }).stdout?.trim();
  if (!asn) return undefined;
  return lsappinfoName(spawnSync("lsappinfo", ["info", "-only", "name", asn], { encoding: "utf8", timeout: 2000 }).stdout ?? "");
};
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check: () => Promise<boolean>, timeout = 3000): Promise<boolean> => {
  const deadline = Date.now() + timeout;
  do { try { if (await check()) return true; } catch { /* not yet */ } await settle(25); } while (Date.now() < deadline);
  return false;
};
const read = <T = unknown>(window: BrowserWindow, script: string): Promise<T> =>
  (window.webContents.executeJavaScript(script) as Promise<T>).catch((error: unknown) => {
    throw new Error(`${String(error)} in: ${script.trim().split("\n")[0]!.slice(0, 160)}`);
  });

const version = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
const ctx: AppContext = { platform: process.platform, language: "en", outputDir: "/tmp", homeDir: "/tmp", version,
  quality: DEFAULT_QUALITY, countdown: 3, countdownSound: true, hotkey: { ...DEFAULT_HOTKEY, registered: true }, notifications: false,
  updates: { enabled: true, state: { kind: "idle" } }, display: { kind: "primary" },
  displays: [{ id: "1", label: "Built-in Display", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: true, primary: true }] };
let panel: BrowserWindow | undefined;
let resultContext: AppContext = ctx;
let lastFocus = 0;
const resultView = (): SettingsView => ({ ...settingsView({ type: "idle" }, { ...resultContext, recordingResults: recordingResults.all }), resultFocus: lastFocus });
const recordingResults = new RecordingResults({ load: async () => [], save: async () => { await settle(120); } }, () => {},
  () => { if (panel && !panel.isDestroyed()) panel.webContents.send("settings:changed", resultView()); }, [3_600_000]);
ipcMain.handle("settings:read", () => resultView());
ipcMain.handle("settings:ready", () => {});
ipcMain.handle("settings:zoom", () => {});
ipcMain.handle("settings:capture", () => resultView());
ipcMain.handle("settings:choose", () => ({ view: resultView(), applied: false }));

async function run(): Promise<boolean> {
  const window = new BrowserWindow(settingsWindowOptions({ platform: process.platform, preloadPath: path.join(out, "preload/settings.js"),
    title: "RecordStuff", size: { width: 380, height: 360 }, workArea: screen.getPrimaryDisplay().workArea }));
  panel = window;
  let blurs = 0;
  let shown = false;
  window.on("blur", () => { blurs += 1; });
  const windowState = async (): Promise<WindowState> => ({ focused: window.isFocused(), visible: window.isVisible(),
    page: await read<string>(window, `document.documentElement.dataset.window ?? ""`).catch(() => "unreadable") });
  /** Asks for activation the way SettingsWindow does when the window is not active, then waits for it to hold. */
  const activate = async (): Promise<WindowState> => {
    shown = true;
    let state = await windowState();
    if (windowActive(state)) return state;
    if (process.platform === "darwin") app.focus({ steal: true });
    window.show(); window.focus();
    await until(async () => windowActive(state = await windowState()), 2000);
    return state;
  };
  type Span = { before: WindowState; blurs: number };
  const activeSpan = async (): Promise<Span> => ({ before: await activate(), blurs });
  const recordActive = async (span: Span, name: string, ok: boolean, detail: string): Promise<void> => {
    const active: Activation = activation(span.before, await windowState(), blurs - span.blurs, frontmost);
    push(judgeActive(name, active, ok, detail));
  };
  const shot = async (file: string): Promise<void> => {
    let image: Electron.NativeImage;
    try { image = await window.webContents.capturePage(); }
    catch (error) { throw new CaptureFailed({ error: String(error), screenshot: file, window: await windowState().catch(() => undefined), shown, frontmost: frontmost() }); }
    fs.writeFileSync(path.join(outDir, file), image.toPNG());
  };
  const press = (keyCode: string): void => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    if (keyCode === "Return") window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  };
  const consoleErrors: string[] = [];
  window.webContents.on("console-message", event => { if (event.level === "error") consoleErrors.push(event.message); });

  nativeTheme.themeSource = "light";
  await window.loadFile(path.join(out, "renderer/settings.html"), { query: { lang: "en" } });
  await settle(700);
  // N-S001: the window is the app's, so its frame is the one the app opens.
  const frame = window.getBounds(), content = window.getContentBounds();
  record(process.platform === "darwin" ? "N-S001 the window has the app's frame: no title bar, the page fills it under the inset window controls"
    : "N-S001 the window has the app's frame: the native title bar above the page",
  process.platform === "darwin" ? content.y === frame.y && content.height === frame.height : content.height < frame.height, JSON.stringify({ frame, content }));

  // Seven settled failures over four days, as the former fixture's failures tab had them; the newest first.
  const day = (daysAgo: number, hour: number): string => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 5, 0, 0); return d.toISOString(); };
  const failure = { id: "", occurredAt: "", code: "disk_full" as const, detail: "ENOSPC: controlled fixture", outcome: "pending" as const };
  for (const [id, daysAgo, hour, reviewed] of [["t-old-unread", 6, 12, false], ["t-old", 5, 12, true], ["t-y1", 1, 9, true], ["t-y2", 1, 18, true],
    ["t-d1", 0, 1, true], ["t-d2", 0, 2, true], ["t-d3", 0, 3, true]] as Array<[string, number, number, boolean]>) {
    recordingResults.update({ ...failure, id, occurredAt: day(daysAgo, hour) });
    recordingResults.update({ ...failure, id, occurredAt: day(daysAgo, hour), outcome: "empty" });
    if (reviewed) await recordingResults.acknowledge(id);
  }
  await recordingResults.persist();
  await activate();
  lastFocus = 1;
  window.webContents.send("settings:changed", resultView());
  await settle(200);
  if (!await until(() => read<boolean>(window, `Boolean(document.querySelector(".recording-result"))`))) throw new Error("the failures tab did not show its rows");
  const colours = await read<{ accent: string }>(window, `(() => { const probe = document.createElement("div"); document.body.append(probe);
    probe.style.color = "var(--focus)"; const accent = getComputedStyle(probe).color; probe.remove(); return { accent }; })()`);

  // N-S103: a keyboard-focused header, then another window in front.
  await read(window, `document.querySelectorAll(".recording-result > .result-summary")[0].focus()`); press("Down"); press("Up"); await settle(60);
  const before = await read<string>(window, `getComputedStyle(document.querySelector(".recording-result")).borderTopColor`);
  const other = new BrowserWindow({ width: 240, height: 160, show: true });
  other.focus(); await settle(300);
  const inactive = await read<{ colour: string; window: string | undefined }>(window, `({ colour: getComputedStyle(document.querySelector(".recording-result")).borderTopColor, window: document.documentElement.dataset.window })`);
  await shot("inactive-window-en-light.png");
  // Destroying the front window can hand activation to another app, which `window.focus()` alone does not take back.
  other.destroy();
  const back = await activeSpan(); await settle(300);
  const reactivated = await read<string>(window, `getComputedStyle(document.querySelector(".recording-result")).borderTopColor`);
  await recordActive(back, "N-S103 an inactive window shows no focus border, and it returns with the window",
    before === colours.accent && inactive.colour === "rgba(0, 0, 0, 0)" && inactive.window === "inactive" && reactivated === colours.accent, JSON.stringify({ before, inactive, reactivated, colours }));

  // N-S105: an action focused inside an open row, another window in front, and a day rollover meanwhile.
  const where = (): Promise<{ active: string; day: string }> => read(window, `({ active: document.activeElement.id || document.activeElement.dataset.action || document.activeElement.tagName,
    day: document.activeElement.closest(".result-day")?.dataset.day ?? "" })`);
  const rollover = async (days: number): Promise<void> => {
    resultContext = { ...ctx, now: new Date(Date.now() + days * 86_400_000) };
    window.webContents.send("settings:changed", resultView());
    await settle(150);
  };
  await activate();
  await read(window, `document.querySelectorAll(".recording-result > .result-summary")[1].focus()`); press("Down"); press("Up"); await settle(60);
  press("Return"); await settle(80); press("Tab"); await settle(240);
  const actionBefore = await where();
  const inFront = new BrowserWindow({ width: 240, height: 160, show: true });
  inFront.focus(); await settle(300);
  await rollover(3);
  inFront.destroy();
  const returned = await activeSpan(); await settle(300);
  const inactiveRollover = await where();
  await recordActive(returned, "N-S105 a day rollover while the window is inactive keeps the focused action for when it returns",
    actionBefore.active !== "BODY" && inactiveRollover.active === actionBefore.active, JSON.stringify({ actionBefore, inactiveRollover }));
  await shot("panel.png");
  record("N-S000 the page ran without console errors", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  writeResults();
  return results.every(result => result.ok);
}

app.on("window-all-closed", () => undefined);
app.whenReady()
  .then(run)
  .then(ok => app.exit(ok ? 0 : 1))
  .catch(error => {
    fs.writeFileSync(path.join(outDir, "error.txt"), String(error?.stack ?? error));
    const failure: FixtureFailure = error instanceof CaptureFailed ? error.failure : { error: String(error?.message ?? error) };
    fs.writeFileSync(path.join(outDir, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`);
    writeResults();
    app.exit(2);
  });
