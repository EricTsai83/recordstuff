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
import { BrowserWindow, app, ipcMain, screen, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent, type Rectangle, type WebContents } from "electron";
import path from "node:path";
import { SETTINGS_CHANNELS, SHORTCUT_CAPTURE_TIMEOUT_MS, isRenameChoice, type RenameChoice, type SettingsChoiceResult, type SettingsTab, type SettingsView } from "../../shared/settings-panel";
import { fileNameProblemText, fileNameTemplateProblem } from "../../shared/file-name";
import type { RenameProblem } from "../library/recordings-library";
import type { RecordingState } from "../../shared/state";

import { proposesHotkey, settingsAction, settingsChecked, settingsView } from "./settings-model";
import { TRAFFIC_LIGHT_POSITION } from "../../shared/window-controls";
import { preferencesUnlocked } from "../recording/recording-lock";
import { validateAccelerator, isSettingsShortcut, SETTINGS_SHORTCUT_RESERVED } from "../../shared/hotkey";
import { translate } from "../../shared/i18n";
import { isFullScreenChoice, type FullScreenChoice } from "../../shared/video-player";
import type { VideoFullScreen } from "../library/video-fullscreen";
import type { AppAction, AppContext } from "../app/ui-model";

const HISTORY_PAGE_ROWS = 50;
/** Escapes this soon after a video's fullscreen ended belong to the press that ended it. */
const FULLSCREEN_ESCAPE_QUIET_MS = 1000;
/**
 * The page's zoom steps (2026-10-05): ⌘+ and ⌘- (Ctrl elsewhere) move one step, ⌘0 returns to 100%. Kept between
 * 80% and 150%, where the sidebar layout and the cards still fit the default window.
 */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export type ZoomRequest = "in" | "out" | "reset";
/** The step a zoom request lands on from `current`, which may lie between steps (a value saved by another version). */
export function nextZoom(current: number, request: ZoomRequest): number {
  if (request === "reset") return 1;
  const steps = request === "in" ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  return steps.find(step => request === "in" ? step > current + 0.001 : step < current - 0.001) ?? steps.at(-1)!;
}
/** The zoom key a keyboard event is, by the key it types: ⌘= or ⌘+ zooms in (with or without Shift), ⌘- out, ⌘0 resets. */
export function zoomRequest(input: { type: string; key: string; meta: boolean; control: boolean; alt: boolean }, platform: NodeJS.Platform): ZoomRequest | undefined {
  const command = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  if (input.type !== "keyDown" || !command || input.alt) return undefined;
  return input.key === "=" || input.key === "+" ? "in" : input.key === "-" || input.key === "_" ? "out" : input.key === "0" ? "reset" : undefined;
}
/**
 * The one description of the Settings window, for the app and for the Settings fixture alike, so the fixture's
 * screenshots show the window the app opens (same frame, same content size) and cannot drift from it: `size`
 * is fitted to `workArea` and centred in it, and the minimum follows `MIN_SETTINGS_SIZE` within it.
 */
export function settingsWindowOptions(options: {
  platform: NodeJS.Platform; preloadPath: string; title: string; size: WindowSize; workArea: Rectangle;
}): BrowserWindowConstructorOptions & WindowSize {
  const { workArea } = options;
  const size = fitSettingsSize(options.size, workArea);
  return {
    ...size,
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / 2),
    minWidth: Math.min(MIN_SETTINGS_SIZE.width, workArea.width),
    minHeight: Math.min(MIN_SETTINGS_SIZE.height, workArea.height),
    show: false,
    title: options.title,
    // Zoom and full screen stay the system's own (2026-10-08, the maintainer's request): the green button, a double
    // click on the page's drag regions as System Settings says, Window → Zoom and View → Toggle Full Screen.
    // macOS: the sidebar runs to the top edge with the window controls inset in it; the page draws
    // its own drag region and keeps the title for the window list and accessibility. Elsewhere the native frame stays.
    ...(options.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION } } : {}),
    webPreferences: {
      preload: options.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  };
}
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
  geometry?: Pick<SettingsWindowState, "size" | "save"> & Partial<Pick<SettingsWindowState, "flush" | "zoom" | "saveZoom">>;
  /** Renames a listed recording (recordings-library.ts `rename`): its new id, or why it was not renamed. */
  rename?: (id: string, name: string) => Promise<{ id: string } | { problem: RenameProblem }>;
  /** The window is about to be shown: on macOS the app becomes a Dock app with its menus while it is open (app-menu.ts). */
  opened?: () => void;
  /** The window was shown or regained focus: what it lists from disk may have changed meanwhile. */
  activated?: () => void;
  /** The window closed or its page died: nothing needs to follow the disk for it any more. */
  closed?: () => void;
  /** Starts dragging a listed recording out of the page; false when it is no longer listed. */
  drag?: (contents: WebContents, id: string) => Promise<boolean>;
  /** Plays a listed recording full screen in a window of its own (video-fullscreen.ts). */
  fullScreen?: Pick<VideoFullScreen, "play" | "close">;
  /**
   * A quit has begun. `context().quitting` says so only 300 ms later, for the tray's sake; what this window opens
   * itself, rather than through `act`, which refuses at once, asks this.
   */
  quitRequested?: () => boolean;
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
  /** The recording the last Recordings entry brings into view; sent with that entry's token only. */
  private libraryFocus: string | undefined;
  /** Holds both global shortcuts suspended; never held by a pending save. */
  private lease: CaptureLease | undefined;
  private captureTimedOut = false;
  private window: BrowserWindow | undefined;
  /** Until when Escape is dropped: a second after a video's fullscreen ended. */
  private escapeQuietUntil = 0;
  /** Hidden by Hide RecordStuff until it is opened again: a first paint still pending must not show it (review pass 2, F2). */
  private hiddenByUser = false;
  /** The current window was shown with its content; before that, its own reveal shows it. */
  private painted = false;
  /** Shows the current window once its page reports its first content, or `ready-to-show` plus a fallback. */
  private reveal: (() => void) | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSize: WindowSize | undefined;
  private currentZoom: number | undefined;
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
    ipcMain.handle(SETTINGS_CHANNELS.zoom, (event, request: unknown) => {
      authorize(event);
      if (request !== "in" && request !== "out" && request !== "reset") throw new Error("Invalid zoom request");
      this.zoom(request);
    });
    ipcMain.handle(SETTINGS_CHANNELS.capture, (event, armed: unknown) => {
      const window = authorize(event);
      if (armed === false) this.release(this.leaseOf(window));
      else if (armed === true && !this.lease && window.isFocused() && preferencesUnlocked(this.options.state()) && !this.quitStarted()) {
        this.captureTimedOut = false;
        const lease: CaptureLease = { window, timer: setTimeout(() => {
          if (this.lease !== lease) return;
          this.captureTimedOut = !lease.submitted;
          this.release(lease);
          this.refresh();
        }, SHORTCUT_CAPTURE_TIMEOUT_MS) };
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
      // Full screen answers when the viewer leaves it, with where the video is then.
      if (typeof group === "string" && group.startsWith("recordingFile:") && isFullScreenChoice(choice)) return this.playFullScreen(group, choice, window);
      if (typeof group === "string" && group.startsWith("recordingFile:") && isRenameChoice(choice)) return this.applyRename(group, choice, window);
      // A recording's actions touch files, not preferences, and a drag must start while the pointer is still down.
      if (typeof group === "string" && group.startsWith("recordingFile:")) return this.applyFile(group, choice, window);
      // The Recordings tab's layout and Undo: no recording lock, no shortcut capture, nothing to wait behind.
      if (group === "library") return this.applyLibrary(choice, window);
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

  /** A saved recording's entry, from its notification: Recordings, with that recording in view when listed. */
  showLibrary(fileId?: string): void {
    this.libraryFocus = fileId;
    this.showEntry("library");
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

  /**
   * Hide RecordStuff (⌘H, app-menu.ts): the window goes out of sight as it is, and comes back as it was the next
   * time it is opened. A shortcut being recorded is let go, and a video playing full screen for it ends. A window in
   * full screen leaves it first, as macOS leaves an empty Space behind a hidden one; it comes back windowed.
   * Resolves once the window is out of sight, or false when it was opened again first.
   */
  hide(): Promise<boolean> {
    this.options.fullScreen?.close();
    const window = this.window;
    if (!window || window.isDestroyed()) return Promise.resolve(true);
    this.hiddenByUser = true;
    this.release(this.leaseOf(window));
    // The player stops first: hidden, RecordStuff has no Dock icon, and a sound from nowhere would be hard to trace.
    window.webContents.send(SETTINGS_CHANNELS.hidden);
    if (!window.isFullScreen()) {
      window.hide();
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      const done = (): void => {
        window.removeListener("leave-full-screen", done);
        window.removeListener("closed", done);
        if (window.isDestroyed()) return resolve(true);
        if (this.window !== window || !this.hiddenByUser) return resolve(false);
        window.hide();
        resolve(true);
      };
      window.once("leave-full-screen", done);
      window.once("closed", done);
      window.setFullScreen(false);
    });
  }

  show(resultEntry = false): void {
    this.hiddenByUser = false;
    this.resultEntry = resultEntry;
    // A menu-bar app has no Dock icon, so showing a window does not bring the
    // app forward on its own; without this the panel can open behind the
    // frontmost app, the same reason index.ts focuses before a file dialog.
    this.options.opened?.();
    if (process.platform === "darwin") app.focus({ steal: true });
    this.options.activated?.();
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
    const options = settingsWindowOptions({ platform: process.platform, preloadPath: path.join(__dirname, "../preload/settings.js"),
      title: view.title, size: this.options.geometry?.size ?? DEFAULT_SETTINGS_SIZE, workArea: display.workArea });
    const size = { width: options.width, height: options.height };
    const window = new BrowserWindow(options);
    this.window = window;
    this.painted = false;
    this.delivered = undefined;
    let lastSize = size;
    window.on("resize", () => {
      if (window.isMinimized()) return;
      // A zoomed or full-screen window is not the size to reopen at; its animation's sizes are dropped with it.
      if (window.isMaximized() || window.isFullScreen()) {
        clearTimeout(this.resizeTimer);
        this.pendingSize = undefined;
        return;
      }
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
      // Painted while hidden: it stays hidden, and the next open shows it as it is.
      if (this.hiddenByUser) return;
      window.show();
      window.focus();
    };
    this.reveal = reveal;
    window.once("ready-to-show", () => {
      if (this.window === window && !this.painted) revealTimer = setTimeout(reveal, REVEAL_FALLBACK_MS);
    });
    window.on("blur", () => { this.release(this.leaseOf(window)); this.refresh(); });
    // Escapes pressed again as a video's fullscreen ends, and a held Escape's repeats, never reach the page:
    // Chromium turned one into a close request that shut the player without a keydown the page could refuse, and
    // the next one closed the window (2026-10-04, traced on the built app). Main drops them before the page, the
    // dialog and the menu see them.
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape" && (input.isAutoRepeat || Date.now() < this.escapeQuietUntil)) event.preventDefault();
      // ⌘+, ⌘- and ⌘0 zoom this window's page on every platform; the View menu shows the same keys without binding them.
      // While the shortcut editor records they are candidates like any other chord, so the page must receive them.
      const zoom = this.leaseOf(window) ? undefined : zoomRequest(input, process.platform);
      if (zoom) { event.preventDefault(); this.zoom(zoom); }
    });
    // Zoom is this window's alone: by default Chromium shares it with every page of the same origin, the full-screen
    // video and the countdown overlay included.
    window.webContents.setZoomMode("isolated");
    window.webContents.setZoomFactor(this.zoomFactor());
    window.webContents.on("did-finish-load", () => { if (!window.isDestroyed()) window.webContents.setZoomFactor(this.zoomFactor()); });
    window.on("focus", () => { if (this.window === window) this.options.activated?.(); });
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
    ipcMain.removeHandler(SETTINGS_CHANNELS.zoom);
    this.window?.destroy();
    this.window = undefined;
  }

  async flush(): Promise<void> { this.flushSize(); await this.options.geometry?.flush?.(); }

  /** The saved zoom, or 100%. */
  private zoomFactor(): number { return this.currentZoom ?? this.options.geometry?.zoom ?? 1; }

  /** Zooms the open window's page one step in or out, or back to 100% (⌘+, ⌘-, ⌘0 and the View menu), and remembers it. */
  zoom(request: ZoomRequest): void {
    const window = this.window;
    const factor = nextZoom(this.zoomFactor(), request);
    this.currentZoom = factor;
    this.options.geometry?.saveZoom?.(factor);
    if (window && !window.isDestroyed()) {
      window.webContents.setZoomFactor(factor);
      window.webContents.send(SETTINGS_CHANNELS.zoomChanged, {
        factor, canZoomIn: factor < ZOOM_STEPS.at(-1)!, canZoomOut: factor > ZOOM_STEPS[0],
      });
    }
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
    const view = settingsView(this.options.state(), { ...this.options.context(), historyLimit: this.historyLimit });
    view.revision = ++this.revision;
    view.resultFocus = this.resultEntry ? this.resultFocus : 0;
    if (this.resultEntry && this.entryTab !== "failures") view.entryTab = this.entryTab;
    if (this.resultEntry && this.entryTab === "library" && this.libraryFocus) view.libraryFocus = this.libraryFocus;
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
    if (this.window !== window) return;
    // A video playing full screen for it has nothing left to return to.
    this.options.fullScreen?.close();
    this.window = undefined; this.reveal = undefined; this.captureTimedOut = false;
    this.options.closed?.();
  }

  /** A quit has begun, including the 300 ms before `context().quitting` says so: nothing this window starts itself begins then. */
  private quitStarted(): boolean {
    return this.options.quitRequested?.() === true || this.options.context().quitting === true;
  }

  private async applyFile(group: string, choice: unknown, recipient: BrowserWindow): Promise<SettingsChoiceResult> {
    const action = settingsAction(this.options.state(), this.options.context(), group, choice);
    if (!action || typeof action !== "object" || !("recordingFile" in action)) this.log(`settings window: refused ${JSON.stringify({ group, choice })}`);
    const file = action && typeof action === "object" && "recordingFile" in action ? action.recordingFile : undefined;
    const applied = !file ? false : file.action === "drag"
      ? !recipient.isDestroyed() && !this.quitStarted() && (await this.options.drag?.(recipient.webContents, file.id) ?? false)
      : await this.options.act(action!) === true;
    const view = this.view();
    return this.deliver({ view, applied, ...(applied ? {} : { failure: translate("Could not complete this action. Try again.", view.language) }) }, recipient);
  }

  /**
   * Renames a listed recording to the name typed in its card. The id must be listed now; the name is checked by the
   * library (file-name.ts), never trusted. The reply carries the new id, so the page keeps the renamed card's focus.
   */
  private async applyRename(group: string, choice: RenameChoice, recipient: BrowserWindow): Promise<SettingsChoiceResult> {
    const id = group.slice("recordingFile:".length);
    const listed = this.options.context().library?.files.some(file => file.id === id) === true;
    if (!listed || !this.options.rename || recipient.isDestroyed() || this.quitStarted()) {
      this.log(`settings window: refused ${JSON.stringify({ group, choice: "rename" })}`);
      const view = this.view();
      return this.deliver({ view, applied: false, failure: fileNameProblemText("missing", view.language) }, recipient);
    }
    const outcome = await this.options.rename(id, choice.name);
    const view = this.view();
    return this.deliver("id" in outcome
      ? { view, applied: true, renamed: outcome.id }
      : { view, applied: false, failure: fileNameProblemText(outcome.problem, view.language) }, recipient);
  }

  /** The Recordings tab's layout and Undo, resolved like any other offered choice. */
  private async applyLibrary(choice: unknown, recipient: BrowserWindow): Promise<SettingsChoiceResult> {
    const action = settingsAction(this.options.state(), this.options.context(), "library", choice);
    if (!action) this.log(`settings window: refused ${JSON.stringify({ group: "library", choice })}`);
    const outcome = action ? await this.options.act(action) : false;
    const applied = typeof outcome === "boolean" ? outcome : settingsChecked(this.options.state(), this.options.context(), "library", choice);
    const view = this.view();
    return this.deliver({ view, applied, ...(applied ? {} : { failure: translate("Could not complete this action. Try again.", view.language) }) }, recipient);
  }

  /**
   * Plays a listed recording full screen over the screen this window is on (video-fullscreen.ts); this window keeps
   * its size. The source is the listing's own URL for the id, never one the page sent. Answers once the viewer has
   * left, with where the video was, and gives this window its focus back.
   */
  private async playFullScreen(group: string, choice: FullScreenChoice, recipient: BrowserWindow): Promise<SettingsChoiceResult> {
    const id = group.slice("recordingFile:".length);
    const item = this.view().library?.items.find(entry => entry.id === id);
    const fullScreen = this.options.fullScreen;
    // While a quit runs nothing new opens, as every other action is refused then (`settingsAction`).
    if (!item || !fullScreen || recipient.isDestroyed() || this.quitStarted()) {
      this.log(`settings window: refused ${JSON.stringify({ group, choice: "fullscreen" })}`);
      const view = this.view();
      return this.deliver({ view, applied: false }, recipient);
    }
    const playback = await fullScreen.play({
      src: item.video,
      state: choice.state,
      display: screen.getDisplayMatching(recipient.getBounds()).bounds,
      language: this.options.context().language,
      title: item.title,
      closed: () => { if (!recipient.isDestroyed() && this.window === recipient) recipient.focus(); },
    });
    this.escapeQuietUntil = Date.now() + FULLSCREEN_ESCAPE_QUIET_MS;
    const view = this.view();
    return this.deliver({ view, applied: playback !== undefined, ...(playback ? { playback } : {}) }, recipient);
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
      // A pattern that cannot name a file says why, as the field's own error; the same text fails the same way again.
      const templateProblem = group === "fileName" && typeof choice === "string" ? fileNameTemplateProblem(choice.trim()) : undefined;
      if (templateProblem) return this.deliver({ view, applied: false, failure: fileNameProblemText(templateProblem, view.language), refused: true }, recipient);
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
    const actionFailure = action === "revealLog" ? translate("Could not complete this action. Try again.", language)
      : group === "about" || action === "openUpdate" ? translate("Could not open the link. Try again.", language)
      : action === "openNotificationSettings" ? translate("Could not open System Settings. Allow RecordStuff in System Settings → Notifications.", language)
      : action === "retryShortcuts" ? translate("The shortcut is still unavailable; another app may be using it.", language)
      : action === "openOutputDir" ? translate("Could not open the output folder", language)
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
