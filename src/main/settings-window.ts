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
import { DEFAULT_SETTINGS_SIZE, MIN_SETTINGS_SIZE, fitSettingsSize, type SettingsWindowState, type WindowSize } from "./settings-window-state";
import { BrowserWindow, app, ipcMain, screen, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { SETTINGS_CHANNELS, type SettingsChoiceResult, type SettingsTab, type SettingsView } from "../shared/settings-panel";
import type { RecordingState } from "../shared/state";

import { proposesHotkey, settingsAction, settingsChecked, settingsView } from "./settings-model";
import { preferencesUnlocked } from "./ui-model";
import { validateAccelerator, isSettingsShortcut, SETTINGS_SHORTCUT_RESERVED } from "../shared/hotkey";
import { translate } from "../shared/i18n";
import type { AppAction, AppContext } from "./ui-model";

const HISTORY_PAGE_ROWS = 50;
/** How long a painted page that never reports its content may stay hidden: a broken page still opens. */
const REVEAL_FALLBACK_MS = 1000;

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
  geometry?: Pick<SettingsWindowState, "size" | "save"> & Partial<Pick<SettingsWindowState, "flush">>;
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
  submitted?: boolean;
}

export class SettingsWindow {
  private resultFocus = 0;
  private revision = 0;
  /** Failure rows sent to the page; "Show more failures" pages through the rest until the window closes. */
  private historyLimit = HISTORY_PAGE_ROWS;
  private resultEntry = false;
  private entryTab: SettingsTab = "failures";
  /** Holds both global shortcuts suspended; never held by a pending save. */
  private lease: CaptureLease | undefined;
  private captureTimedOut = false;
  private window: BrowserWindow | undefined;
  /** The current window was shown with its content; before that, its own reveal shows it. */
  private painted = false;
  /** Shows the current window once its page reports its first content, or `ready-to-show` plus a fallback. */
  private reveal: (() => void) | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSize: WindowSize | undefined;
  /** One save at a time, in request order: a queued request is never a failure. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The last view the page received by any route; an identical refresh is not pushed again. */
  private delivered: string | undefined;

  constructor(private readonly options: SettingsWindowOptions) {
    const authorize = (event: IpcMainInvokeEvent): BrowserWindow => {
      const window = this.window;
      const contents = window?.webContents;
      if (!window || !contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
        throw new Error("Invalid settings sender");
      }
      return window;
    };
    ipcMain.handle(SETTINGS_CHANNELS.capture, (event, armed: unknown) => {
      const window = authorize(event);
      if (armed === false) this.release(this.leaseOf(window));
      else if (armed === true && !this.lease && window.isFocused() && preferencesUnlocked(this.options.state())) {
        this.captureTimedOut = false;
        const lease: CaptureLease = { window, timer: setTimeout(() => {
          if (this.lease !== lease) return;
          this.captureTimedOut = !lease.submitted;
          this.release(lease);
          this.refresh();
        }, 15_000) };
        this.lease = lease;
        this.options.capture?.(true);
      }
      return this.deliver(this.view());
    });
    ipcMain.handle(SETTINGS_CHANNELS.ready, (event) => {
      authorize(event);
      this.reveal?.();
    });
    ipcMain.handle(SETTINGS_CHANNELS.read, (event) => {
      authorize(event);
      return this.deliver(this.view());
    });
    ipcMain.handle(SETTINGS_CHANNELS.choose, (event, group: unknown, choice: unknown) => {
      const window = authorize(event);
      if (group === "history" && choice === "more") {
        this.historyLimit += HISTORY_PAGE_ROWS;
        return this.deliver({ view: this.view(), applied: true });
      }
      // A result action waits for durable history; it must not hold preference saves or shortcut capture.
      if (typeof group === "string" && group.startsWith("recordingResult:")) return this.applyResult(group, choice, window);
      // Completing a request ends the capture it was sent from, never a later one.
      const lease = this.leaseOf(window);
      if (group === "hotkey") {
        this.captureTimedOut = false;
        if (lease) lease.submitted = true;
      }
      const run = this.queue.then(() => this.apply(group, choice, lease, window));
      this.queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    });
  }

  showRecordingResult(): void {
    this.showEntry("failures");
  }

  /** The shortcut-failure banner's entry: General, where the shortcut card is. */
  showShortcut(): void {
    this.showEntry("general");
  }

  /** The capture-warning banner's entry: Recording, where the resolution warning is shown. */
  showRecording(): void {
    this.showEntry("recording");
  }

  /** An explicit entry: a new token makes the page select `tab` once, however it was left. */
  private showEntry(tab: SettingsTab): void {
    this.entryTab = tab;
    this.resultFocus++;
    this.show(true);
  }

  show(resultEntry = false): void {
    this.resultEntry = resultEntry;
    // A menu-bar app has no Dock icon, so showing a window does not bring the
    // app forward on its own; without this the panel can open behind the
    // frontmost app, the same reason index.ts focuses before a file dialog.
    if (process.platform === "darwin") app.focus({ steal: true });
    const existing = this.window;
    if (existing && !existing.isDestroyed()) {
      // A window still loading would show blank; its own reveal shows and focuses it.
      if (this.painted) {
        if (existing.isMinimized()) existing.restore();
        existing.show();
        existing.focus();
      }
      this.refresh();
      return;
    }
    // A new window starts from the first page, however far the previous one paged.
    this.historyLimit = HISTORY_PAGE_ROWS;
    const view = this.view();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const workArea = display.workAreaSize;
    const size = fitSettingsSize(this.options.geometry?.size ?? DEFAULT_SETTINGS_SIZE, workArea);
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
      webPreferences: {
        preload: path.join(__dirname, "../preload/settings.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.window = window;
    this.painted = false;
    this.delivered = undefined;
    let lastSize = size;
    window.on("resize", () => {
      if (window.isMinimized()) return;
      const [width, height] = window.getSize();
      if (width === undefined || height === undefined) return;
      if (width === lastSize.width && height === lastSize.height) return;
      lastSize = { width, height };
      this.pendingSize = lastSize;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.flushSize(), 250);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    // `ready-to-show` is the first frame, painted before the page has read its view, so
    // showing then flashes an empty window; the page reports when its content is painted.
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    const reveal = (): void => {
      clearTimeout(revealTimer);
      if (this.window !== window || this.painted || window.isDestroyed()) return;
      this.painted = true;
      window.show();
      window.focus();
    };
    this.reveal = reveal;
    window.once("ready-to-show", () => {
      if (this.window === window && !this.painted) revealTimer = setTimeout(reveal, REVEAL_FALLBACK_MS);
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
      clearTimeout(revealTimer);
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

  /**
   * Push the current projection; a closed panel needs nothing. Many events
   * refresh without changing what the panel shows (display metrics, a state
   * the panel does not project), so a view identical to the last one the page
   * received is not sent: the page would only redo its reconciliation.
   */
  refresh(): void {
    if (!preferencesUnlocked(this.options.state())) this.release(this.lease);
    const window = this.window;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    const view = this.view();
    const serialized = JSON.stringify({ ...view, revision: undefined });
    if (serialized === this.delivered) return;
    this.delivered = serialized;
    window.setTitle(view.title);
    window.webContents.send(SETTINGS_CHANNELS.changed, view);
  }

  /** A view returned by an invoke: the page renders it, so it is what the page holds now. */
  private deliver<T extends SettingsView | SettingsChoiceResult>(result: T, recipient = this.window): T {
    if (recipient === this.window) this.delivered = JSON.stringify({ ...("view" in result ? result.view : result), revision: undefined });
    return result;
  }

  destroy(): void {
    this.flushSize();
    this.delivered = undefined;
    this.release(this.lease);
    ipcMain.removeHandler(SETTINGS_CHANNELS.capture);
    ipcMain.removeHandler(SETTINGS_CHANNELS.read);
    ipcMain.removeHandler(SETTINGS_CHANNELS.ready);
    ipcMain.removeHandler(SETTINGS_CHANNELS.choose);
    this.window?.destroy();
    this.window = undefined;
  }

  async flush(): Promise<void> { this.flushSize(); await this.options.geometry?.flush?.(); }

  private flushSize(): void {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
    if (this.pendingSize) {
      this.options.geometry?.save(this.pendingSize);
      this.pendingSize = undefined;
    }
  }

  private view(): SettingsView {
    const view = settingsView(this.options.state(), { ...this.options.context(), historyLimit: this.historyLimit });
    view.revision = ++this.revision;
    view.resultFocus = this.resultEntry ? this.resultFocus : 0;
    if (this.resultEntry && this.entryTab !== "failures") view.entryTab = this.entryTab;
    const shortcut = view.groups.find(group => group.kind === "shortcut");
    if (shortcut) {
      shortcut.capturing = this.lease !== undefined;
      if (this.captureTimedOut) shortcut.captureTimedOut = true;
      // Capture suspends the registration; that is not a failure to report or retry.
      if (this.lease) { delete shortcut.diagnostics; delete shortcut.actions; }
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
    if (this.window === window) { this.window = undefined; this.reveal = undefined; this.captureTimedOut = false; }
  }

  private async applyResult(group: string, choice: unknown, recipient: BrowserWindow): Promise<SettingsChoiceResult> {
    const action = settingsAction(this.options.state(), this.options.context(), group, choice);
    if (!action) this.log(`settings window: refused ${JSON.stringify({ group, choice })}`);
    const applied = action ? await this.options.act(action) === true : false;
    const view = this.view();
    return this.deliver({ view, applied, ...(applied ? {} : { failure: view.failure }) }, recipient);
  }

  private async apply(group: unknown, choice: unknown, lease: CaptureLease | undefined, recipient: BrowserWindow): Promise<SettingsChoiceResult> {
    const action = settingsAction(this.options.state(), this.options.context(), group, choice);
    if (!action) {
      this.log(`settings window: refused ${JSON.stringify({ group, choice })}`);
      this.release(lease);
      const view = this.view();
      // A refused shortcut says why once, in the card's own error; its diagnostics keep describing the registration.
      const platform = this.options.context().platform;
      const error = proposesHotkey(group, choice)
        ? isSettingsShortcut(choice, platform) ? SETTINGS_SHORTCUT_RESERVED : validateAccelerator(choice, platform).error
        : undefined;
      return this.deliver({ view, applied: false, ...(error ? { failure: translate(error, view.language), refused: true as const } : { failure: view.failure }) }, recipient);
    }
    let outcome: boolean | void;
    try {
      // A confirmed save runs to completion even after its window has gone.
      outcome = await this.options.act(action);
    } finally {
      this.release(lease);
    }
    const applied = typeof outcome === "boolean"
      ? outcome
      : settingsChecked(this.options.state(), this.options.context(), group, choice);
    // An action that opened nothing says what failed, not that a setting could not be applied.
    const language = this.options.context().language;
    const actionFailure = group === "about" || action === "openUpdate" ? translate("Could not open the link. Try again.", language)
      : action === "openNotificationSettings" ? translate("Could not open System Settings. Allow RecordStuff in System Settings → Notifications.", language)
      : action === "retryShortcuts" ? translate("The shortcut is still unavailable; another app may be using it.", language)
      : undefined;
    return this.deliver({
      view: this.view(),
      applied,
      ...(actionFailure && !applied ? { failure: actionFailure } : {}),
    }, recipient);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}
