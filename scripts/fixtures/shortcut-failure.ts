/** Test-only Electron launcher. Runs the actual built app; no production test hook. */
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
const settingsPhase = drill === 'settings';
const accelerator = 'Control+Shift+F20';
const owned = new Map<string, () => void>();
const recordingAttempts = () => attempts.filter(attempt => attempt.accelerator === accelerator);
let lastMenu: Menu | undefined;
const settingsFile = path.join(temporary, 'userData/settings.json');
for (const name of ['userData', 'logs', 'sessionData', 'videos'] as const) {
  const folder = path.join(temporary, name);
  fs.mkdirSync(folder, { recursive: true });
  app.setPath(name, folder);
}
app.setName('RecordStuff Shortcut Integration');
app.getAppPath = () => root;
if (drill !== 'restart') fs.writeFileSync(settingsFile, JSON.stringify({
  version: 3, outputDir: path.join(temporary, 'videos'),
  quality: { videoQuality: 'standard', resolutionCap: 'source', frameRate: 30 },
  language: 'en', hotkey: settingsPhase ? { enabled: true, accelerator: 'Alt+CommandOrControl+,' } : { enabled: false, accelerator },
  notifications: true, updates: { enabled: false },
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
    lastMenu = menu;
    const settings = menu.items.find(item => item.label.startsWith('Settings') || item.label.startsWith('設定'));
    if (!settings) throw new Error('Production tray no longer offers Settings');
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
  return panel.webContents.executeJavaScript(code, true) as Promise<T>;
};
async function waitFor(check: () => unknown | Promise<unknown>, detail: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out: ' + detail);
}
const failureNotifications = () => notifications.filter(n => n.body?.startsWith('Could not register the shortcut '));
const group = () => evaluate<SettingsGroup>("window.settings.read().then(v => v.groups.find(g => g.id === 'hotkey'))");
async function arm() {
  if (!panel) throw new Error('Settings window is not ready');
  panel.show(); panel.focus();
  await waitFor(() => panel?.isFocused(), 'settings focused');
  await evaluate("document.getElementById('shortcut-capture').click()");
  await waitFor(async () => (await group()).capturing, 'capture armed');
}
async function key(code: string, key: string, modifiers: Record<string, boolean> = {}) {
  await evaluate(`document.getElementById('shortcut-capture').dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ code, key, bubbles: true, cancelable: true, ...modifiers })}))`);
}
async function commit() {
  await arm();
  await key('F20', 'F20', { ctrlKey: true, shiftKey: true });
  await waitFor(async () => !(await group()).capturing, 'capture committed');
}
async function choose(id: string, value: string) {
  await evaluate(`(() => { const select = document.getElementById(${JSON.stringify('setting-' + id)}); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change')); })()`);
  await waitFor(() => evaluate(`document.getElementById('shortcut-capture').disabled === false`), 'save settled');
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
    record('legacy equivalent key retains recording ownership and value', attempts.length === 1 && owned.has(settingsKey)
      && (await group()).choices.some(c => c.id === settingsKey && c.checked)
      && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hotkey.accelerator === 'Alt+CommandOrControl+,', JSON.stringify(attempts));
    record('legacy collision keeps tray access with recovery explanation', lastMenu?.items.some(i => i.label.includes('change the recording shortcut through the tray Settings entry.')), lastMenu?.items.map(i => i.label).join(' | ') ?? '');
    await commit();
    await waitFor(() => owned.has(settingsKey) && owned.has(accelerator), 'independent registrations after legacy recovery');
    record('changing legacy key recovers Settings independently', owned.size === 2, [...owned.keys()].join(', '));
    const opened = panel!;
    const count = BrowserWindow.getAllWindows().length;
    opened.minimize();
    await waitFor(() => opened.isMinimized(), 'actual Electron minimized state');
    owned.get(settingsKey)!();
    await waitFor(() => !opened.isMinimized() && opened.isFocused(), 'callback restores and focuses');
    owned.get(settingsKey)!();
    record('Settings callback restores real minimized window without duplication', panel === opened && BrowserWindow.getAllWindows().length === count, `windows=${count}; minimized=${opened.isMinimized()}; focused=${opened.isFocused()}`);
    await arm();
    record('capture suspends both registrations', owned.size === 0, [...owned.keys()].join(', '));
    await key('Comma', ',', { metaKey: true, altKey: true });
    await waitFor(async () => !(await group()).capturing, 'reserved candidate completes');
    record('reserved commit rejected and ownership restored', owned.size === 2 && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hotkey.accelerator === accelerator
      && await evaluate("document.getElementById('feedback').textContent.includes('reserved for Settings')"), 'saved recording shortcut retained');
    failRegistration = true;
    await arm(); await key('Escape', 'Escape');
    await waitFor(async () => !(await group()).capturing, 'failed resume');
    for (const language of ['en', 'zh-TW']) {
      await evaluate(`window.settings.choose('language', '${language}')`);
      tray.emit('right-click');
      record(`${language} Settings registration failure is explained without working label`, lastMenu?.items.some(i => i.label.includes(language === 'en' ? 'Settings shortcut unavailable:' : '設定快捷鍵無法使用：'))
        && !lastMenu?.items.some(i => i.label.includes('⌘⌥,')), lastMenu?.items.map(i => i.label).join(' | ') ?? '');
    }
    const beforeRefresh = attempts.length;
    tray.emit('right-click'); tray.emit('right-click');
    record('tray refresh does not retry failed registrations', attempts.length === beforeRefresh, `attempts=${attempts.length}`);
    failRegistration = false;
    await arm(); await key('Escape', 'Escape');
    await waitFor(() => owned.size === 2, 'cancel recovery');
    await arm();
    opened.webContents.forcefullyCrashRenderer();
    await waitFor(() => owned.size === 2, 'renderer crash restores both registrations');
    record('renderer crash restores shortcut ownership', owned.has(settingsKey) && owned.has(accelerator), [...owned.keys()].join(', '));
    opened.destroy();
    owned.get(settingsKey)!();
    await waitFor(() => { panel = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('settings.html')); return panel && panel !== opened; }, 'new settings window');
    await waitFor(() => evaluate("Boolean(document.getElementById('tab-general'))"), 'reopened renderer');
    record('close and callback reopen a usable replacement panel', panel !== opened && BrowserWindow.getAllWindows().length === count, `windows=${BrowserWindow.getAllWindows().length}`);
    finish(); return;
  }
  if (drill === 'restart') {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const restored = await group();
    record('restart loads failed custom selection without reseeding', saved.hotkey.enabled && saved.hotkey.accelerator === accelerator && restored.choices.some(c => c.id === accelerator && c.checked), JSON.stringify(saved.hotkey));
    record('restart retries registration and renders failure', recordingAttempts().length === 1 && recordingAttempts()[0]?.registered === false && restored.note === 'Unavailable: another app is using this shortcut.' && await evaluate("document.getElementById('setting-hotkey-note').textContent === 'Unavailable: another app is using this shortcut.'"), JSON.stringify(attempts));
    record('restart requests failure notification', failureNotifications().length === 1 && failureNotifications()[0]?.body?.includes('F20'), JSON.stringify(failureNotifications()));
    finish();
    return;
  }
  await commit();
  const failed = await group();
  const persisted = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  record('real Electron registration failure and persistence', recordingAttempts().at(-1)?.registered === false && recordingAttempts().at(-1)?.forcedFailure && persisted.hotkey.enabled && persisted.hotkey.accelerator === accelerator, JSON.stringify({ attempt: recordingAttempts().at(-1), hotkey: persisted.hotkey }));
  record('failure note rendered by production page', failed.note === 'Unavailable: another app is using this shortcut.' && await evaluate("document.getElementById('setting-hotkey-note').textContent === 'Unavailable: another app is using this shortcut.'"), failed.note ?? '');
  record('notification requested with shortcut and recovery direction', failureNotifications().length === 1 && failureNotifications()[0]?.body?.includes('F20') && failureNotifications()[0]?.body?.includes('Settings'), JSON.stringify(failureNotifications()));
  if (drill === '--drill-failure') throw new Error('Intentional assertion-failure cleanup drill');
  if (drill === '--drill-timeout') { console.log('DRILL_READY'); await new Promise(() => {}); }
  await arm();
  await key('Escape', 'Escape');
  await waitFor(async () => !(await group()).capturing, 'Escape cancelled');
  record('cancel does not repeat notification', failureNotifications().length === 1 && recordingAttempts().at(-1)?.registered === false, `notifications=${failureNotifications().length}`);
  await commit();
  record('explicit resave repeats failure notification', failureNotifications().length === 2, `notifications=${failureNotifications().length}`);
  await choose('hotkey', 'off');
  record('Off retains value and removes failure note', !(await group()).note && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hotkey.enabled === false && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hotkey.accelerator === accelerator && !globalShortcut.isRegistered(accelerator), 'saved disabled; no note or registration');
  await choose('notifications', 'off');
  await commit();
  record('notification preference respected on failure', failureNotifications().length === 2 && Boolean((await group()).note), `notifications=${failureNotifications().length}; note retained`);
  failRegistration = false;
  await commit();
  record('registration recovery clears error and retains selection', globalShortcut.isRegistered(accelerator) && !(await group()).note && (await group()).choices.some(c => c.id === accelerator && c.checked), JSON.stringify(recordingAttempts().at(-1)));
  await arm();
  await key('KeyR', 'r');
  record('invalid candidate does not change saved shortcut', JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hotkey.accelerator === accelerator && await evaluate("document.getElementById('feedback').textContent.includes('Command or Control')"), 'bare R refused');
  await key('Escape', 'Escape');
  await waitFor(async () => !(await group()).capturing, 'final cancel');
  await evaluate("window.settings.choose('language', 'zh-TW')");
  record('other preferences remain usable after failure/recovery', JSON.parse(fs.readFileSync(settingsFile, 'utf8')).language === 'zh-TW', 'language save succeeded');
  await evaluate("window.settings.choose('language', 'en')");
  await choose('notifications', 'on');
  failRegistration = true;
  await commit();
  record('leave failed selection for fresh process', Boolean((await group()).note) && recordingAttempts().at(-1)?.registered === false && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hotkey.enabled, 'failed custom selection saved through production IPC');
  finish();
})().catch(finish);
