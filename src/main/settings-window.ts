import { DEFAULT_SETTINGS_SIZE, MIN_SETTINGS_SIZE, fitSettingsSize, type SettingsWindowState, type WindowSize } from "./settings-window-state";
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
import { BrowserWindow, app, ipcMain, screen, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import type { SettingsChoiceResult, SettingsView } from "../shared/settings-panel";
import type { RecordingState } from "../shared/state";

import { settingsAction, settingsChecked, settingsView } from "./settings-model";
import { preferencesUnlocked } from "./ui-model";
import { validateAccelerator, isSettingsShortcut, SETTINGS_SHORTCUT_RESERVED } from "../shared/hotkey";
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
  geometry?: Pick<SettingsWindowState, "size" | "save">;
  log?: (message: string) => void;
}

/**
 * One custom-shortcut capture. The object is its ownership token: only the
 * window that armed it, its own timeout, or the request sent from it can end
 * it, so a late event from an older window never ends a newer capture.
 */
interface CaptureLease {
  readonly window: BrowserWindow;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class SettingsWindow {
  private resultFocus = 0;
  private resultEntry = false;
  /** Holds both global shortcuts suspended; never held by a pending save. */
  private lease: CaptureLease | undefined;
  private window: BrowserWindow | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSize: WindowSize | undefined;
  private rememberedSize: WindowSize | undefined;
  /** One save at a time, in request order: a queued request is never a failure. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SettingsWindowOptions) {
    const authorize = (event: IpcMainInvokeEvent): BrowserWindow => {
      const window = this.window;
      const contents = window?.webContents;
      if (!window || !contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
        throw new Error("Invalid settings sender");
      }
      return window;
    };
    ipcMain.handle("settings:capture", (event, armed: unknown) => {
      const window = authorize(event);
      if (armed === false) this.release(this.leaseOf(window));
      else if (armed === true && !this.lease && window.isFocused() && preferencesUnlocked(this.options.state())) {
        const lease: CaptureLease = { window, timer: setTimeout(() => { this.release(lease); this.refresh(); }, 15_000) };
        this.lease = lease;
        this.options.capture?.(true);
      }
      return this.view();
    });
    ipcMain.handle("settings:read", (event) => {
      authorize(event);
      return this.view();
    });
    ipcMain.handle("settings:choose", (event, group: unknown, choice: unknown) => {
      const window = authorize(event);
      // A result action waits for durable history; it must not hold preference saves or shortcut capture.
      if (typeof group === "string" && group.startsWith("recordingResult:")) return this.applyResult(group, choice);
      // Completing a request ends the capture it was sent from, never a later one.
      const lease = this.leaseOf(window);
      const run = this.queue.then(() => this.apply(group, choice, lease));
      this.queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    });
  }

  showRecordingResult(): void {
    this.resultFocus++;
    this.show(true);
    this.refresh();
  }

  show(resultEntry = false): void {
    this.resultEntry = resultEntry;
    // A menu-bar app has no Dock icon, so showing a window does not bring the
    // app forward on its own; without this the panel can open behind the
    // frontmost app, the same reason index.ts focuses before a file dialog.
    if (process.platform === "darwin") app.focus({ steal: true });
    const existing = this.window;
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    const view = this.view();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const workArea = display.workAreaSize;
    const size = fitSettingsSize(this.rememberedSize ?? this.options.geometry?.size ?? DEFAULT_SETTINGS_SIZE, workArea);
    const window = new BrowserWindow({
      ...size,
      x: Math.round(display.workArea.x + (workArea.width - size.width) / 2),
      y: Math.round(display.workArea.y + (workArea.height - size.height) / 2),
      minWidth: Math.min(MIN_SETTINGS_SIZE.width, workArea.width),
      minHeight: Math.min(MIN_SETTINGS_SIZE.height, workArea.height),
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
    let lastSize = size;
    window.on("resize", () => {
      if (window.isMinimized()) return;
      const [width, height] = window.getSize();
      if (width === undefined || height === undefined) return;
      if (width === lastSize.width && height === lastSize.height) return;
      lastSize = { width, height };
      this.pendingSize = this.rememberedSize = lastSize;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.flushSize(), 250);
    });
    window.on("close", () => this.flushSize());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.once("ready-to-show", () => {
      window.show();
      window.focus();
    });
    window.on("blur", () => { this.release(this.leaseOf(window)); this.refresh(); });
    // A dead page cannot be revived in place; the next show creates a fresh
    // window instead. No automatic reload, so a page that keeps crashing
    // cannot loop.
    window.webContents.on("render-process-gone", (_event, details) => {
      this.log(`settings window: renderer gone (${details.reason}); disposing the window`);
      this.retire(window);
      if (!window.isDestroyed()) window.destroy();
    });
    window.on("closed", () => {
      this.flushSize();
      this.retire(window);
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
    if (!preferencesUnlocked(this.options.state())) this.release(this.lease);
    const window = this.window;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    const view = this.view();
    window.setTitle(view.title);
    window.webContents.send("settings:changed", view);
  }

  destroy(): void {
    this.flushSize();
    this.release(this.lease);
    ipcMain.removeHandler("settings:capture");
    ipcMain.removeHandler("settings:read");
    ipcMain.removeHandler("settings:choose");
    this.window?.destroy();
    this.window = undefined;
  }

  private flushSize(): void {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
    if (this.pendingSize) {
      this.options.geometry?.save(this.pendingSize);
      this.pendingSize = undefined;
    }
  }

  private view(): SettingsView {
    const view = settingsView(this.options.state(), this.options.context());
    view.resultFocus = this.resultEntry ? this.resultFocus : 0;
    const shortcut = view.groups.find(group => group.kind === "shortcut");
    if (shortcut) {
      shortcut.capturing = this.lease !== undefined;
      if (this.lease) { delete shortcut.note; delete shortcut.diagnostics; }
    }
    return view;
  }

  private leaseOf(window: BrowserWindow): CaptureLease | undefined {
    return this.lease?.window === window ? this.lease : undefined;
  }

  /**
   * Resume the committed registrations, even while a save is pending: the
   * save registers its own result once persisted. Idempotent, and a lease
   * that already ended cannot end its successor.
   */
  private release(lease: CaptureLease | undefined): void {
    if (!lease || this.lease !== lease) return;
    this.lease = undefined;
    clearTimeout(lease.timer);
    this.options.capture?.(false);
  }

  /** Close and crash act only on their own window, never on its replacement. */
  private retire(window: BrowserWindow): void {
    this.release(this.leaseOf(window));
    if (this.window === window) this.window = undefined;
  }

  private async applyResult(group: string, choice: unknown): Promise<SettingsChoiceResult> {
    const action = settingsAction(this.options.state(), this.options.context(), group, choice);
    if (!action) this.log(`settings window: refused ${JSON.stringify({ group, choice })}`);
    const applied = action ? await this.options.act(action) === true : false;
    const view = this.view();
    return { view, applied, ...(applied ? {} : { failure: view.failure }) };
  }

  private async apply(group: unknown, choice: unknown, lease: CaptureLease | undefined): Promise<SettingsChoiceResult> {
    const action = settingsAction(this.options.state(), this.options.context(), group, choice);
    if (!action) {
      this.log(`settings window: refused ${JSON.stringify({ group, choice })}`);
      this.release(lease);
      const view = this.view();
      let failure = view.failure;
      if (group === "hotkey" && choice !== "off") {
        const error = isSettingsShortcut(choice, this.options.context().platform)
          ? SETTINGS_SHORTCUT_RESERVED : validateAccelerator(choice).error;
        const shortcut = view.groups.find(entry => entry.id === "hotkey");
        if (error && shortcut) { failure = translate(error, view.language); shortcut.note = failure; }
      }
      return { view, applied: false, failure };
    }
    let outcome: boolean | void;
    try {
      // A confirmed save runs to completion even after its window has gone.
      outcome = await this.options.act(action);
    } finally {
      this.release(lease);
    }
    return {
      view: this.view(),
      ...(group === "about" ? { failure: translate("Could not open the link. Try again.", this.options.context().language) } : {}),
      applied: typeof outcome === "boolean"
        ? outcome
        : action === "checkUpdates" || action === "openUpdate" || settingsChecked(this.options.state(), this.options.context(), group, choice),
    };
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}
