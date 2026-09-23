/**
 * The settings window (docs/system-design/desktop.md): one sandboxed panel
 * that opens from the tray, stays open while the user changes preferences,
 * and never becomes a second source of truth.
 *
 * Main owns every decision. The panel receives a rendered view and returns a
 * group/choice id; this class validates the sender, resolves the id against a
 * freshly built model and hands the resulting action to the same handler the
 * tray uses. Closing the window does not quit the menu-bar app.
 */
import { BrowserWindow, app, ipcMain, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import type { SettingsChoiceResult, SettingsView } from "../shared/settings-panel";
import type { RecordingState } from "../shared/state";

import { settingsAction, settingsChecked, settingsView } from "./settings-model";
import { preferencesUnlocked } from "./ui-model";
import { validateAccelerator } from "../shared/hotkey";
import { translate } from "../shared/i18n";
import type { AppAction, AppContext } from "./ui-model";

export interface SettingsWindowOptions {
  state: () => RecordingState;
  context: () => AppContext;
  /**
   * The same handler the tray uses; it re-checks the recording state itself.
   * An action with no committed value reports its own outcome as a boolean;
   * anything else is judged by whether the requested choice is committed now.
   */
  act: (action: AppAction) => Promise<boolean | void>;
  capture?: (armed: boolean) => void;
  log?: (message: string) => void;
}

export class SettingsWindow {
  private capturing = false;
  private committingHotkey = false;
  private captureTimer: ReturnType<typeof setTimeout> | undefined;
  private window: BrowserWindow | undefined;
  /** One save at a time, in request order: a queued request is never a failure. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SettingsWindowOptions) {
    const authorize = (event: IpcMainInvokeEvent): void => {
      const contents = this.window?.webContents;
      if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
        throw new Error("Invalid settings sender");
      }
    };
    ipcMain.handle("settings:capture", (event, armed: unknown) => {
      authorize(event);
      if (armed === false) this.endCapture();
      else if (armed === true && this.window?.isFocused() && preferencesUnlocked(this.options.state())) {
        if (!this.capturing) {
          this.options.capture?.(true);
          this.capturing = true;
          this.captureTimer = setTimeout(() => { this.endCapture(); this.refresh(); }, 15_000);
        }
      }
      return this.view();
    });
    ipcMain.handle("settings:read", (event) => {
      authorize(event);
      return this.view();
    });
    ipcMain.handle("settings:choose", (event, group: unknown, choice: unknown) => {
      authorize(event);
      const run = this.queue.then(() => this.apply(group, choice));
      this.queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    });
  }

  show(): void {
    // A menu-bar app has no Dock icon, so showing a window does not bring the
    // app forward on its own; without this the panel can open behind the
    // frontmost app, the same reason index.ts focuses before a file dialog.
    if (process.platform === "darwin") app.focus({ steal: true });
    const existing = this.window;
    if (existing) {
      existing.show();
      existing.focus();
      return;
    }
    const view = this.view();
    const window = new BrowserWindow({
      width: 460,
      height: 560,
      minWidth: 380,
      minHeight: 360,
      show: false,
      title: view.title,
      maximizable: false,
      fullscreenable: false,
      // Windows and Linux would otherwise draw an empty application menu.
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "../preload/settings.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.once("ready-to-show", () => {
      window.show();
      window.focus();
    });
    window.on("blur", () => { this.endCapture(); this.refresh(); });
    window.webContents.on("render-process-gone", () => this.endCapture());
    window.on("closed", () => {
      this.endCapture();
      if (this.window === window) this.window = undefined;
    });
    // The panel needs a language before it can read anything, so that it can
    // report a failed read in the user's language.
    const devUrl = app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
    const loading = devUrl
      ? window.loadURL(`${new URL("settings.html", devUrl).href}?lang=${view.language}`)
      : window.loadFile(path.join(__dirname, "../renderer/settings.html"), { query: { lang: view.language } });
    void loading.catch((cause: unknown) => {
      this.log(`settings window: load failed: ${String(cause)}`);
      if (!window.isDestroyed()) window.destroy();
    });
  }

  /** Push the current projection; a closed panel needs nothing. */
  refresh(): void {
    if (!preferencesUnlocked(this.options.state())) this.endCapture();
    const window = this.window;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    const view = this.view();
    window.setTitle(view.title);
    window.webContents.send("settings:changed", view);
  }

  destroy(): void {
    this.endCapture();
    ipcMain.removeHandler("settings:capture");
    ipcMain.removeHandler("settings:read");
    ipcMain.removeHandler("settings:choose");
    this.window?.destroy();
    this.window = undefined;
  }

  private view(): SettingsView {
    const view = settingsView(this.options.state(), this.options.context());
    const shortcut = view.groups.find(group => group.kind === "shortcut");
    if (shortcut) {
      shortcut.capturing = this.capturing;
      if (this.capturing) delete shortcut.note;
    }
    return view;
  }

  private endCapture(): void {
    if (!this.capturing || this.committingHotkey) return;
    this.capturing = false;
    clearTimeout(this.captureTimer);
    this.captureTimer = undefined;
    this.options.capture?.(false);
  }

  private async apply(group: unknown, choice: unknown): Promise<SettingsChoiceResult> {
    const action = settingsAction(this.options.state(), this.options.context(), group, choice);
    if (!action) {
      this.log(`settings window: refused ${JSON.stringify({ group, choice })}`);
      this.endCapture();
      const view = this.view();
      if (group === "hotkey" && choice !== "off") {
        const error = validateAccelerator(choice).error;
        const shortcut = view.groups.find(entry => entry.id === "hotkey");
        if (error && shortcut) shortcut.note = translate(error, view.language);
      }
      return { view, applied: false };
    }
    this.committingHotkey = this.capturing && typeof action !== "string" && "setHotkey" in action;
    let outcome: boolean | void;
    try {
      outcome = await this.options.act(action);
    } finally {
      this.committingHotkey = false;
      this.endCapture();
    }
    return {
      view: this.view(),
      applied: typeof outcome === "boolean"
        ? outcome
        : action === "checkUpdates" || action === "openUpdate" || settingsChecked(this.options.state(), this.options.context(), group, choice),
    };
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}
