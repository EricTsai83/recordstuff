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
const accelerator = 'Control+Shift+F20';
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
  language: 'en', hotkey: { enabled: false, accelerator },
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
    const settings = menu.items.find(item => item.label === 'Settings');
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
      globalShortcut.setSuspended(failRegistration);
      try {
        const registered = globalShortcut.register(value, callback);
        attempts.push({ accelerator: value, registered, forcedFailure: failRegistration });
        return registered;
      } finally { globalShortcut.setSuspended(false); }
    },
    unregister: (value: string) => globalShortcut.unregister(value),
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
      registered: globalShortcut.isRegistered(accelerator),
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
require(path.join(root, 'out/main/index.js'));
(async () => {
  await app.whenReady();
  await waitFor(() => fs.existsSync(path.join(temporary, 'logs/recordstuff.log')) && fs.readFileSync(path.join(temporary, 'logs/recordstuff.log'), 'utf8').includes('ready;'), 'production app ready');
  if (!tray) throw new Error('Production tray is not ready');
  tray.emit('right-click');
  await waitFor(() => { panel = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('settings.html')); return panel; }, 'settings window');
  await waitFor(() => evaluate("Boolean(document.getElementById('tab-general'))"), 'production renderer');
  await evaluate("document.getElementById('tab-general').click()");
  if (drill === 'restart') {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const restored = await group();
    record('restart loads failed custom selection without reseeding', saved.hotkey.enabled && saved.hotkey.accelerator === accelerator && restored.choices.some(c => c.id === accelerator && c.checked), JSON.stringify(saved.hotkey));
    record('restart retries registration and renders failure', attempts.length === 1 && attempts[0]?.accelerator === accelerator && attempts[0]?.registered === false && restored.note === 'Unavailable: another app is using this shortcut.' && await evaluate("document.getElementById('setting-hotkey-note').textContent === 'Unavailable: another app is using this shortcut.'"), JSON.stringify(attempts));
    record('restart requests failure notification', failureNotifications().length === 1 && failureNotifications()[0]?.body?.includes('F20'), JSON.stringify(failureNotifications()));
    finish();
    return;
  }
  await commit();
  const failed = await group();
  const persisted = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  record('real Electron registration failure and persistence', attempts.at(-1)?.registered === false && attempts.at(-1)?.forcedFailure && persisted.hotkey.enabled && persisted.hotkey.accelerator === accelerator, JSON.stringify({ attempt: attempts.at(-1), hotkey: persisted.hotkey }));
  record('failure note rendered by production page', failed.note === 'Unavailable: another app is using this shortcut.' && await evaluate("document.getElementById('setting-hotkey-note').textContent === 'Unavailable: another app is using this shortcut.'"), failed.note ?? '');
  record('notification requested with shortcut and recovery direction', failureNotifications().length === 1 && failureNotifications()[0]?.body?.includes('F20') && failureNotifications()[0]?.body?.includes('Settings'), JSON.stringify(failureNotifications()));
  if (drill === '--drill-failure') throw new Error('Intentional assertion-failure cleanup drill');
  if (drill === '--drill-timeout') { console.log('DRILL_READY'); await new Promise(() => {}); }
  await arm();
  await key('Escape', 'Escape');
  await waitFor(async () => !(await group()).capturing, 'Escape cancelled');
  record('cancel does not repeat notification', failureNotifications().length === 1 && attempts.at(-1)?.registered === false, `notifications=${failureNotifications().length}`);
  await commit();
  record('explicit resave repeats failure notification', failureNotifications().length === 2, `notifications=${failureNotifications().length}`);
  await choose('hotkey', 'off');
  record('Off retains value and removes failure note', !(await group()).note && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hotkey.enabled === false && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hotkey.accelerator === accelerator && !globalShortcut.isRegistered(accelerator), 'saved disabled; no note or registration');
  await choose('notifications', 'off');
  await commit();
  record('notification preference respected on failure', failureNotifications().length === 2 && Boolean((await group()).note), `notifications=${failureNotifications().length}; note retained`);
  failRegistration = false;
  await commit();
  record('registration recovery clears error and retains selection', globalShortcut.isRegistered(accelerator) && !(await group()).note && (await group()).choices.some(c => c.id === accelerator && c.checked), JSON.stringify(attempts.at(-1)));
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
  record('leave failed selection for fresh process', Boolean((await group()).note) && attempts.at(-1)?.registered === false && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hotkey.enabled, 'failed custom selection saved through production IPC');
  finish();
})().catch(finish);
