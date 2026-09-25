/**
 * Test-only Electron launcher for `pnpm acceptance:shortcut-layout`. `check` and
 * `layout-aware` run the actual built app behind the shortcut-failure boundary
 * pattern and send System Events keys to its real registrations; `activate`
 * only opens a focused text field so an input method applies its layout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
// Internal CommonJS hook: keep the substitution at this test-only boundary.
const Module = require('node:module') as {
  _load: (name: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};
const electron = require('electron') as typeof import('electron');
const { app, BrowserWindow, globalShortcut } = electron;
const [root, temporary, reportDir, mode] = (() => {
  const [repository, temporary, report, mode] = process.argv.slice(-4);
  if (!repository || !temporary || !report || !['check', 'layout-aware', 'activate'].includes(mode ?? '')) {
    throw new Error('Expected root, temporary and report directories and check, layout-aware or activate');
  }
  return [repository, temporary, report, mode] as const;
})();
// Mirrors LAYOUT_ACCELERATOR and SETTINGS_SHORTCUT; this entry is not bundled.
const accelerator = 'CommandOrControl+Control+Alt+Shift+7';
const settingsKey = 'CommandOrControl+Alt+,';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => unknown, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await pause(25);
  }
  return Boolean(check());
}

// Every mode, the activation window included, keeps Chromium's profile and logs in the run directory.
for (const name of ['userData', 'logs', 'sessionData', 'videos'] as const) {
  const folder = path.join(temporary, mode === 'activate' ? 'activation' : 'app', name);
  fs.mkdirSync(folder, { recursive: true });
  app.setPath(name, folder);
}
if (mode === 'activate') activate();
else check();

/**
 * Selecting an input method from a background process leaves its layout
 * override unset, so macOS keeps typing with the previous layout. A focused
 * text field in an owned window makes the method apply its own layout, as
 * typing in any app would. The runner writes `activation-done` once the
 * layout reports the change; ten seconds bound the window either way.
 */
function activate() {
  app.dock?.hide();
  app.on('window-all-closed', () => {});
  const quit = () => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.quit(); };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 360, height: 120, show: false, alwaysOnTop: true, title: 'RecordStuff layout check' });
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<title>RecordStuff layout check</title><p>Activating the input source for the shortcut layout check…</p><textarea aria-label="activation"></textarea>'));
    window.show();
    app.focus({ steal: true });
    window.focus();
    window.webContents.focus();
    await window.webContents.executeJavaScript("document.querySelector('textarea').focus()");
    const focused = await waitFor(() => window.isFocused(), 2000);
    fs.writeFileSync(path.join(reportDir, 'activation.json'), JSON.stringify({ focused }));
    await waitFor(() => fs.existsSync(path.join(temporary, 'activation-done')), 10_000);
    quit();
  });
}

function check() {
  interface Press { accelerator: string; at: string }
  interface KeyResult { name: string; keyCode: number; accelerator: string; expected: boolean; observed: boolean; presses: number; error?: string }
  const attempts: Array<{ accelerator: string; registered: boolean }> = [];
  const presses: Press[] = [];
  const keys: KeyResult[] = [];
  let tray: TestTray | undefined;
  let finishing = false;
  let blocked: string | undefined;
  app.setName('RecordStuff Shortcut Layout');
  app.getAppPath = () => root;
  const logFile = path.join(temporary, 'app/logs/recordstuff.log');
  fs.writeFileSync(path.join(temporary, 'app/userData/settings.json'), JSON.stringify({
    version: 3, outputDir: path.join(temporary, 'app/videos'),
    quality: { videoQuality: 'standard', resolutionCap: 'source', frameRate: 30 },
    language: 'en', hotkey: { enabled: true, accelerator },
    appearance: 'system', notifications: false, updates: { enabled: false },
  }));
  fs.writeFileSync(path.join(temporary, 'app/userData/tray-hint-shown'), '');
  class TestTray extends EventEmitter {
    destroyed = false;
    constructor() { super(); tray = this; }
    setIgnoreDoubleClickEvents() {}
    setImage() {}
    setTitle() {}
    setToolTip() {}
    popUpContextMenu() {}
    destroy() { this.destroyed = true; this.removeAllListeners(); }
  }
  class SilentNotification extends EventEmitter {
    static isSupported() { return true; }
    show() {}
    close() { this.emit('close'); }
  }
  // Environmental boundaries only. Registration reaches the real globalShortcut;
  // a press is recorded instead of calling production's toggle or Settings entry,
  // so nothing records and no capture permission is requested.
  const boundary = {
    ...electron,
    Tray: TestTray,
    Notification: SilentNotification,
    desktopCapturer: { getSources: async () => [{ id: 'test-display' }] },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
    dialog: { showErrorBox: (_title: string, detail: string) => finish(new Error(detail)) },
    globalShortcut: {
      register(value: string, _callback: () => void) {
        const registered = globalShortcut.register(value, () => { presses.push({ accelerator: value, at: new Date().toISOString() }); });
        attempts.push({ accelerator: value, registered });
        return registered;
      },
      unregister: (value: string) => globalShortcut.unregister(value),
    },
  };
  const originalLoad = Module._load;
  Module._load = function (name, ...args) {
    return name === 'electron' ? boundary : originalLoad.call(this, name, ...args);
  };
  const sendKey = (keyCode: number, modifiers: string) => new Promise<void>((resolve, reject) => {
    execFile('osascript', ['-e', `tell application "System Events" to key code ${keyCode} using {${modifiers}}`],
      { timeout: 10_000 }, (error, _stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve());
  });
  let failure: unknown;
  let observing = false;
  // Production's will-quit handlers are registered by the time it logs ready and
  // run first; this observer checks what they left. It is registered then, not
  // at finish, because Chromium answers SIGTERM with a normal quit that never
  // reaches finish.
  function observeQuit() {
    if (observing) return;
    observing = true;
    app.once('will-quit', () => {
      if (fs.existsSync(logFile)) fs.copyFileSync(logFile, path.join(reportDir, 'app.log'));
      const cleanup = {
        registered: globalShortcut.isRegistered(accelerator) || globalShortcut.isRegistered(settingsKey),
        windows: BrowserWindow.getAllWindows().length,
        trayDestroyed: Boolean(tray?.destroyed),
      };
      globalShortcut.unregisterAll();
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      const error = failure ?? (finishing ? undefined : new Error('Quit before the check finished (interrupted or quit from outside the fixture)'));
      fs.writeFileSync(path.join(reportDir, 'results.json'), JSON.stringify({
        mode, accelerator, settingsKey,
        disableFeatures: app.commandLine.hasSwitch('disable-features') ? app.commandLine.getSwitchValue('disable-features') : null,
        attempts, presses, keys, blocked,
        error: error ? (error instanceof Error ? error.stack ?? error.message : String(error)) : undefined,
        cleanup,
      }, null, 2));
    });
  }
  function finish(error?: unknown) {
    if (finishing) return;
    finishing = true;
    failure = error;
    observeQuit();
    app.quit();
  }
  process.on('SIGTERM', () => finish(new Error('Fixture interrupted (SIGTERM)')));
  process.on('SIGINT', () => finish(new Error('Fixture interrupted (SIGINT)')));
  require(path.join(root, 'out/main/index.js'));
  // Negative control: undo production's switch before app ready, so Chromium's
  // layout-aware lookup is on exactly as before plan 043.
  if (mode === 'layout-aware') app.commandLine.removeSwitch('disable-features');
  (async () => {
    await app.whenReady();
    const ready = await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('ready;'), 10_000);
    if (!ready) throw new Error('Production app did not log ready');
    observeQuit();
    const registered = await waitFor(() => [accelerator, settingsKey].every(value => attempts.some(a => a.accelerator === value)), 5000);
    const refused = [accelerator, settingsKey].filter(value => !attempts.some(a => a.accelerator === value && a.registered));
    if (!registered || refused.length) {
      blocked = `Registration did not succeed for ${refused.join(', ')}; another app may own the combination.`;
      finish(); return;
    }
    const all = 'command down, control down, option down, shift down';
    // The control proves delivery; the number row must fire before the keypad
    // window opens, so a late press cannot be credited to the wrong key.
    const plan = [
      { name: 'Settings control ⌘⌥, (key code 43)', keyCode: 43, modifiers: 'command down, option down', accelerator: settingsKey, expected: true },
      { name: 'number-row ⌘⌃⌥⇧7 (key code 26)', keyCode: 26, modifiers: all, accelerator, expected: true },
      { name: 'keypad ⌘⌃⌥⇧7 (key code 89)', keyCode: 89, modifiers: all, accelerator, expected: false },
    ];
    for (const key of plan) {
      const count = () => presses.filter(press => press.accelerator === key.accelerator).length;
      const before = count();
      const result: KeyResult = { name: key.name, keyCode: key.keyCode, accelerator: key.accelerator, expected: key.expected, observed: false, presses: 0, error: 'not completed' };
      keys.push(result);
      try {
        await sendKey(key.keyCode, key.modifiers);
      } catch (error) {
        blocked = `System Events could not send ${key.name}: ${error instanceof Error ? error.message : String(error)}`;
        result.error = 'not sent';
        break;
      }
      if (key.expected) await waitFor(() => count() > before, 3000);
      else await pause(1500);
      result.presses = count() - before;
      result.observed = result.presses > 0;
      delete result.error;
    }
    finish();
  })().catch(finish);
}
