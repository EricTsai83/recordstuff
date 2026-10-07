/**
 * Test-only Electron launcher for `pnpm acceptance:shortcut-native` (plan 066): the actual built app behind a test
 * boundary, for the shortcut cases that need the desktop. Every other former `acceptance:shortcut` case runs in the
 * background Playwright suite (tests/ui/shortcut-integration.spec.ts). Phases:
 *
 * - `registration`: Electron's real `globalShortcut.register`, refused through `setSuspended` and then recovered by Retry, and the production
 *   page, note, saved choice and notification request that follow (N-K01–N-K04).
 * - `windows`: real window state: a minimized Settings window restored and focused by its shortcut's callback, and
 *   the platform close key on a focused window followed by reopening it from the callback and the tray (N-K05–N-K08).
 *
 * `--drill-failure` and `--drill-timeout` are the runner's cleanup drills. No production test hook.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { BrowserWindow as ElectronWindow, Menu, NotificationConstructorOptions } from 'electron';
import type { SettingsGroup } from '../../src/shared/settings-panel';
// Internal CommonJS hook: keep the assertion at this test-only boundary.
const Module = require('node:module') as {
  _load: (name: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};
const electron = require('electron') as typeof import('electron');
const { app, BrowserWindow, globalShortcut } = electron;
const [root, temporary, reportDir, drill] = (() => {
  const [repository, temporary, report, drill] = process.argv.slice(-4);
  if (!repository || !temporary || !report) throw new Error('Expected root, temporary and report directories');
  return [repository, temporary, report, drill] as const;
})();
const cases: Array<{ name: string; ok: boolean; detail: string }> = [];
const attempts: Array<{ accelerator: string; registered: boolean; forcedFailure: boolean }> = [];
const notifications: NotificationConstructorOptions[] = [];
let failRegistration = true;
let tray: TestTray | undefined;
let finishing = false;
let panel: ElectronWindow | undefined;
const settingsKey = 'CommandOrControl+Alt+,';
const settingsPhase = drill === 'windows';
const accelerator = 'Control+Shift+F20';
const owned = new Map<string, () => void>();
const recordingAttempts = () => attempts.filter(attempt => attempt.accelerator === accelerator);
const settingsFile = path.join(temporary, 'userData/settings.json');
for (const name of ['userData', 'logs', 'sessionData', 'videos'] as const) {
  const folder = path.join(temporary, name);
  fs.mkdirSync(folder, { recursive: true });
  app.setPath(name, folder);
}
app.setName('RecordStuff Shortcut Integration');
app.getAppPath = () => root;
fs.writeFileSync(settingsFile, JSON.stringify({
  version: 4, outputDir: path.join(temporary, 'videos'),
  quality: { videoQuality: 'standard', resolutionCap: 'source', frameRate: 30 },
  // Windows phase: the recording shortcut is the fixture's key, so ⌥⌘, is the Settings shortcut whose callback opens Settings.
  language: 'en', hotkey: settingsPhase ? { enabled: true, accelerator } : { enabled: false, accelerator },
  appearance: 'dark', notifications: true, updates: { enabled: false },
}));
fs.writeFileSync(path.join(temporary, 'userData/tray-hint-shown'), '');
class TestTray extends EventEmitter {
  destroyed = false;
  constructor() { super(); tray = this; this.destroyed = false; }
  setIgnoreDoubleClickEvents() {}
  setImage() {}
  setTitle() {}
  setToolTip() {}
  destroy() { this.destroyed = true; this.removeAllListeners(); }
  popUpContextMenu(menu: Menu) {
    // The window's entry (formerly Settings…, Open RecordStuff since 2026-10-04) in either language.
    const settings = menu.items.find(item => item.label === 'Open RecordStuff' || item.label === '開啟 RecordStuff');
    if (!settings) throw new Error('Production tray no longer offers Open RecordStuff');
    settings.click(undefined, undefined, { triggeredByAccelerator: false });
  }
}
class ObservedNotification extends EventEmitter {
  static isSupported() { return true; }
  readonly options: NotificationConstructorOptions;
  constructor(options: NotificationConstructorOptions) { super(); this.options = options; }
  show() { notifications.push(this.options); }
  close() { this.emit('close'); }
}
// Only environmental boundaries are replaced. SettingsWindow, main's action handler,
// RecordingHotkey, AppTray's notification policy, storage and page are production code.
const boundary = {
  ...electron,
  Tray: TestTray,
  Notification: ObservedNotification,
  desktopCapturer: { getSources: async () => [{ id: 'test-display' }] },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  dialog: { showErrorBox: (_title: string, detail: string) => finish(new Error(detail)) },
  globalShortcut: {
    register(value: string, callback: () => void) {
      if (settingsPhase) {
        const registered = !failRegistration && !owned.has(value);
        if (registered) owned.set(value, callback);
        attempts.push({ accelerator: value, registered, forcedFailure: failRegistration });
        return registered;
      }
      globalShortcut.setSuspended(failRegistration);
      try {
        const registered = globalShortcut.register(value, callback);
        attempts.push({ accelerator: value, registered, forcedFailure: failRegistration });
        return registered;
      } finally { globalShortcut.setSuspended(false); }
    },
    unregister: (value: string) => { owned.delete(value); globalShortcut.unregister(value); },
  },
};
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === 'electron' ? boundary : originalLoad.call(this, name, ...args);
};

const record = (name: string, ok: unknown, detail: string) => {
  cases.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw new Error(name + ': ' + detail);
};
const evaluate = <T = unknown>(code: string): Promise<T> => {
  if (!panel) throw new Error('Settings window is not ready');
  return (panel.webContents.executeJavaScript(code, true) as Promise<T>).catch((error: unknown) => {
    throw new Error(`Renderer evaluation failed: ${code}`, { cause: error });
  });
};
async function waitFor(check: () => unknown | Promise<unknown>, detail: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out: ' + detail);
}
const failureNotifications = () => notifications.filter(n => n.body?.startsWith('Could not register '));
const group = () => evaluate<SettingsGroup>("window.settings.read().then(v => v.groups.find(g => g.id === 'hotkey'))");
async function arm() {
  if (!panel) throw new Error('Settings window is not ready');
  panel.show(); panel.focus();
  await waitFor(() => panel?.isFocused(), 'settings focused');
  // The shortcut menu is a shadcn Select (2026-10-07): open it from its trigger and choose Custom shortcut…, as a click does.
  await evaluate(`(async () => {
    const press = el => { for (const [type, Kind] of [["pointerdown", PointerEvent], ["mousedown", MouseEvent], ["pointerup", PointerEvent], ["mouseup", MouseEvent]])
      el.dispatchEvent(new Kind(type, { bubbles: true, button: 0, pointerType: "mouse" })); el.click(); };
    press(document.getElementById('setting-hotkey'));
    for (let i = 0; i < 100; i++) { const item = document.querySelector('[data-slot=select-item][data-value=custom]');
      if (item) { press(item); return; } await new Promise(done => setTimeout(done, 20)); }
    throw new Error('the shortcut menu did not open');
  })()`);
  await waitFor(async () => (await group()).capturing, 'capture armed');
}
async function key(code: string, key: string, modifiers: Record<string, boolean> = {}) {
  await evaluate(`document.getElementById('shortcut-capture').dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ code, key, bubbles: true, cancelable: true, ...modifiers })}))`);
}
async function clickConfirm() { await click('shortcut-confirm'); }
/** Chromium input events on the real page, not DOM-dispatched events. */
async function click(id: string) {
  const point = await evaluate<{ x: number; y: number }>(`(() => {
    const button = document.getElementById(${JSON.stringify(id)});
    button.scrollIntoView({ block: 'nearest' });
    const bounds = button.getBoundingClientRect();
    return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
  })()`);
  panel!.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  panel!.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
}
let previewVerified = false;
async function commit() {
  const before = fs.readFileSync(settingsFile, "utf8");
  await arm();
  await key('F20', 'F20', { ctrlKey: true, shiftKey: true });
  if (!previewVerified) {
    record('N-K01 shortcut preview leaves saved preferences unchanged until Confirm', fs.readFileSync(settingsFile, 'utf8') === before
      && (await group()).capturing && await evaluate("!document.getElementById('shortcut-confirm').disabled"), 'candidate stays local');
    previewVerified = true;
  }
  await clickConfirm();
  await waitFor(async () => !(await group()).capturing, 'capture committed');
}
function finish(error?: unknown) {
  if (finishing) return;
  finishing = true;
  if (error) cases.push({ name: 'fixture completion', ok: false, detail: error instanceof Error ? error.stack ?? error.message : String(error) });
  if (fs.existsSync(path.join(temporary, 'logs/recordstuff.log'))) {
    fs.copyFileSync(path.join(temporary, 'logs/recordstuff.log'), path.join(reportDir, 'app.log'));
  }
  // Production will-quit handlers run first; the final observer checks their result,
  // then releases anything left so even a failed cleanup assertion is contained.
  app.once('will-quit', () => {
    const cleanup = {
      windows: BrowserWindow.getAllWindows().length,
      registered: globalShortcut.isRegistered(accelerator) || globalShortcut.isRegistered(settingsKey) || owned.size > 0,
      suspended: globalShortcut.isSuspended(),
      trayDestroyed: Boolean(tray?.destroyed),
    };
    globalShortcut.unregisterAll();
    globalShortcut.setSuspended(false);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    fs.writeFileSync(path.join(reportDir, 'results.json'), JSON.stringify({ cases, attempts, notifications, cleanup }, null, 2));
  });
  app.quit();
}
process.on('SIGTERM', () => finish(new Error('Fixture interrupted (SIGTERM)')));
process.on('SIGINT', () => finish(new Error('Fixture interrupted (SIGINT)')));
fs.rmSync(path.join(temporary, 'logs/recordstuff.log'), { force: true });
if (settingsPhase) failRegistration = false;
require(path.join(root, 'out/main/index.js'));
(async () => {
  await app.whenReady();
  await waitFor(() => fs.existsSync(path.join(temporary, 'logs/recordstuff.log')) && fs.readFileSync(path.join(temporary, 'logs/recordstuff.log'), 'utf8').includes('ready;'), 'production app ready');
  if (!tray) throw new Error('Production tray is not ready');
  tray.emit('right-click');
  await waitFor(() => { panel = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('settings.html')); return panel; }, 'settings window');
  await waitFor(() => evaluate("Boolean(document.getElementById('tab-general'))"), 'production renderer');
  await evaluate("document.getElementById('tab-general').click()");
  if (settingsPhase) {
    const settingsWindows = () => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('settings.html'));
    if (!owned.has(settingsKey) || !owned.has(accelerator)) throw new Error(`Expected both shortcuts registered: ${[...owned.keys()].join(', ')}`);
    const opened = panel!;
    const count = BrowserWindow.getAllWindows().length;
    opened.show(); opened.focus();
    await waitFor(() => opened.isFocused(), 'Settings focused before minimizing');
    opened.minimize();
    await waitFor(() => opened.isMinimized(), 'actual Electron minimized state');
    owned.get(settingsKey)!();
    await waitFor(() => !opened.isMinimized() && opened.isFocused(), 'callback restores and focuses');
    owned.get(settingsKey)!();
    record('N-K05 the Settings callback restores the real minimized window, focused, without duplication', panel === opened && BrowserWindow.getAllWindows().length === count,
      `windows=${count}; minimized=${opened.isMinimized()}; focused=${opened.isFocused()}; visible=${opened.isVisible()}`);
    const closeWithKey = async () => {
      const closing = panel!;
      closing.show(); closing.focus(); closing.webContents.focus();
      await waitFor(() => closing.isFocused(), 'entry panel focused before close');
      const modifiers: Array<'meta' | 'control'> = process.platform === 'darwin' ? ['meta'] : ['control'];
      closing.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'w', modifiers });
      closing.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'w', modifiers });
      await waitFor(() => closing.isDestroyed() && settingsWindows().length === 0, 'platform close key closes Settings');
    };
    const waitForPanel = async () => {
      await waitFor(() => { panel = settingsWindows()[0]; return panel?.isVisible() && panel.isFocused(); }, 'entry opens visible focused panel');
      await waitFor(() => evaluate("Boolean(document.getElementById('tab-general'))"), 'entry renderer ready');
    };
    const savedBeforeEntry = fs.readFileSync(settingsFile, 'utf8');
    await closeWithKey();
    record('N-K06 the platform close key on the focused window closes Settings and keeps the app', !tray!.destroyed && owned.has(settingsKey), 'window destroyed; tray and registration kept');
    owned.get(settingsKey)!();
    await waitForPanel();
    const fromShortcut = panel;
    owned.get(settingsKey)!();
    record('N-K07 the shortcut reopens one visible, focused Settings window and a second press reuses it', settingsWindows().length === 1 && panel === fromShortcut && panel!.isFocused() && panel!.isVisible(),
      `windows=${settingsWindows().length}; focused=${panel!.isFocused()}; visible=${panel!.isVisible()}`);
    await closeWithKey();
    tray!.emit('right-click');
    await waitForPanel();
    record('N-K08 after the close key the tray reopens a visible, focused Settings window without changing preferences', panel !== fromShortcut && settingsWindows().length === 1
      && panel!.isFocused() && fs.readFileSync(settingsFile, 'utf8') === savedBeforeEntry, 'production tray menu handler');
    finish(); return;
  }
  await commit();
  const failed = await group();
  const persisted = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  record('N-K02 real Electron registration failure and persistence', recordingAttempts().at(-1)?.registered === false && recordingAttempts().at(-1)?.forcedFailure && persisted.hotkey.enabled && persisted.hotkey.accelerator === accelerator, JSON.stringify({ attempt: recordingAttempts().at(-1), hotkey: persisted.hotkey }));
  record('N-K03 failure note rendered by production page', failed.diagnostics?.[0]?.reason === 'Another app may be using this shortcut.' && await evaluate("document.querySelector('#setting-hotkey-diagnostics .diagnostic p').textContent === 'Another app may be using this shortcut.'"), failed.diagnostics?.[0]?.reason ?? '');
  record('N-K04 notification requested with shortcut and recovery direction', failureNotifications().length === 1 && failureNotifications()[0]?.body?.includes('F20') && failureNotifications()[0]?.body?.includes('Open RecordStuff'), JSON.stringify(failureNotifications()));
  if (drill === '--drill-failure') throw new Error('Intentional assertion-failure cleanup drill');
  if (drill === '--drill-timeout') { console.log('DRILL_READY'); await new Promise(() => {}); }
  // Recovery through Electron's real registration: no longer suspended, Retry registers the saved key for real.
  failRegistration = false;
  await waitFor(() => evaluate("document.getElementById('setting-hotkey-retryRegistration')?.disabled === false"), 'retry button enabled');
  await click('setting-hotkey-retryRegistration');
  await waitFor(async () => globalShortcut.isRegistered(accelerator) && !(await group()).diagnostics?.length, 'real registration after retry');
  record('N-K04b Retry registers the saved key through Electron\'s real registration, clears the note and keeps the selection', globalShortcut.isRegistered(accelerator)
    && !(await group()).diagnostics?.length && (await group()).choices.some(c => c.id === accelerator && c.checked), JSON.stringify(recordingAttempts().at(-1)));
  finish();
})().catch(finish);
