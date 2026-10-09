/**
 * The background hosts' OS boundary (plan 066). Every BrowserWindow is created hidden, offscreen, muted and unthrottled;
 * the calls that would show, focus, minimize, restore or cover the screen with it are recorded and answered from a
 * virtual window state instead of reaching the desktop. The tray, notifications, global shortcuts, dialogs, external
 * opens, the Dock and display capture are adapters that record what was requested. Nothing else is replaced: IPC,
 * storage, the media protocol and every page and preload are the production ones.
 *
 * What this proves is containment of the fixture, not that macOS would have shown, focused or delivered anything:
 * an adapter call says only that production code asked for it. A guard reports every way the boundary could be
 * bypassed (a visible native window, a window that is not offscreen, an unmuted page, a call that reached the real
 * global shortcut, notification or capture API), and the Playwright fixture fails the test on any of them.
 *
 * Test-only; compiled by tests/ui/global-setup.ts. Nothing here ships with the app.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type * as ElectronModule from "electron";
import type { BrowserWindow as BrowserWindowType, BrowserWindowConstructorOptions, Menu, NotificationConstructorOptions } from "electron";

type Electron = typeof ElectronModule;

/** One request production code made of an OS boundary. */
export interface AdapterCall { at: number; kind: string; detail?: unknown }
/** One way the boundary was bypassed; any of these fails the test. */
export interface Violation { at: number; kind: string; detail: string }

export interface ScriptedDialogs {
  /** `showMessageBox` answers, in order; when none is left it answers `cancelId` (or 0). */
  messageBox: number[];
  /** `showOpenDialog` answers, in order; when none is left it is cancelled. */
  openDialog: Array<string | undefined>;
}

export interface Boundary {
  /** The module production code receives for `require("electron")`. */
  electron: Electron;
  calls: AdapterCall[];
  violations: Violation[];
  shortcuts: ShortcutAdapter;
  tray: () => TestTray | undefined;
  notifications: NotificationConstructorOptions[];
  dialogs: ScriptedDialogs;
  /** Folder that receives files production code moves to the Trash, so the file operation itself stays observable. */
  trashDir: string;
  /** The virtual state of a window: what production asked for, never what the OS did. */
  windowState: (window: BrowserWindowType) => VirtualState | undefined;
  /** Every window this process made, hidden or destroyed, in order. */
  windows: () => BrowserWindowType[];
  /** Checks every live window and page now; returns the violations found so far. */
  audit: () => Violation[];
}

export interface VirtualState { visible: boolean; focused: boolean; minimized: boolean; fullScreen: boolean; simpleFullScreen: boolean }

/**
 * Global shortcut registration without the OS: `fail` decides whether a registration succeeds, and `owned` is what
 * production holds. A registration never reaches `globalShortcut`, so no key is taken from the desktop.
 */
export class ShortcutAdapter {
  readonly owned = new Map<string, () => void>();
  readonly attempts: Array<{ accelerator: string; registered: boolean; forced: boolean }> = [];
  /** Accelerators whose registration fails; `"*"` fails every one. */
  failing = new Set<string>();
  suspended = false;
  register(accelerator: string, callback: () => void): boolean {
    const forced = this.failing.has("*") || this.failing.has(accelerator);
    const registered = !forced && !this.suspended && !this.owned.has(accelerator);
    if (registered) this.owned.set(accelerator, callback);
    this.attempts.push({ accelerator, registered, forced });
    return registered;
  }
  registerAll(accelerators: string[], callback: () => void): void { for (const accelerator of accelerators) this.register(accelerator, callback); }
  isRegistered(accelerator: string): boolean { return this.owned.has(accelerator); }
  unregister(accelerator: string): void { this.owned.delete(accelerator); }
  unregisterAll(): void { this.owned.clear(); }
  setSuspended(suspended: boolean): void { this.suspended = suspended; }
  isSuspended(): boolean { return this.suspended; }
  /** Calls the callback production registered, as the OS would on the key; throws when none is registered. */
  press(accelerator: string): void {
    const callback = this.owned.get(accelerator);
    if (!callback) throw new Error(`${accelerator} is not registered (owned: ${[...this.owned.keys()].join(", ") || "none"})`);
    callback();
  }
}

/** The tray: menus it would pop up are kept, and each click is an event the test emits. */
export class TestTray extends EventEmitter {
  destroyed = false;
  menu: Menu | undefined;
  contextMenu: Menu | null = null;
  image: unknown;
  title = "";
  tooltip = "";
  constructor(image: unknown, onCreate: (tray: TestTray) => void) { super(); this.image = image; onCreate(this); }
  setIgnoreDoubleClickEvents(): void {}
  setImage(image: unknown): void { this.image = image; }
  setTitle(title: string): void { this.title = title; }
  setToolTip(tooltip: string): void { this.tooltip = tooltip; }
  setContextMenu(menu: Menu | null): void { this.contextMenu = menu; }
  popUpContextMenu(menu?: Menu): void { this.menu = menu ?? this.contextMenu ?? undefined; }
  closeContextMenu(): void {}
  getBounds(): { x: number; y: number; width: number; height: number } { return { x: 0, y: 0, width: 22, height: 22 }; }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; this.removeAllListeners(); }
}

/**
 * `violationsFile`: each violation is also appended there as it happens, so the Playwright fixture reads it even when
 * the app quit itself or hung before teardown could ask (fixtures.ts `tearDown`).
 */
export function createBoundary(electron: Electron, options: { trashDir: string; violationsFile?: string; platform?: NodeJS.Platform }): Boundary {
  const calls: AdapterCall[] = [];
  const violations: Violation[] = [];
  const record = (kind: string, detail?: unknown): void => { calls.push({ at: Date.now(), kind, ...(detail === undefined ? {} : { detail }) }); };
  const violate = (kind: string, detail: string): void => {
    const violation = { at: Date.now(), kind, detail };
    violations.push(violation);
    if (options.violationsFile) fs.appendFileSync(options.violationsFile, `${JSON.stringify(violation)}\n`);
  };
  const states = new WeakMap<BrowserWindowType, VirtualState>();
  const made: BrowserWindowType[] = [];
  const NativeWindow = electron.BrowserWindow;
  let focusedWindow: BrowserWindowType | undefined;
  const label = (window: BrowserWindowType): string => {
    try { return `${window.id}:${window.webContents.getURL().split("?")[0]!.split("/").pop() || "blank"}`; } catch { return `${window.id}`; }
  };
  /** Moves the virtual focus as the OS would: the window that had it blurs, the new one focuses. */
  const moveFocus = (to: BrowserWindowType | undefined): void => {
    const from = focusedWindow;
    if (from === to) return;
    focusedWindow = to;
    if (from && !from.isDestroyed()) { states.get(from)!.focused = false; from.emit("blur"); }
    if (to && !to.isDestroyed()) { states.get(to)!.focused = true; to.emit("focus"); }
  };

  class ContainedWindow extends NativeWindow {
    constructor(requested: BrowserWindowConstructorOptions = {}) {
      const { show, fullscreen, simpleFullscreen, kiosk, ...rest } = requested;
      super({
        ...rest,
        show: false,
        webPreferences: { ...requested.webPreferences, offscreen: true, backgroundThrottling: false },
      });
      const state: VirtualState = { visible: false, focused: false, minimized: false, fullScreen: false, simpleFullScreen: false };
      states.set(this, state);
      made.push(this);
      record("window:create", { id: this.id, show: show ?? true, fullscreen: fullscreen ?? false, simpleFullscreen: simpleFullscreen ?? false, kiosk: kiosk ?? false,
        bounds: { x: rest.x, y: rest.y, width: rest.width, height: rest.height } });
      this.webContents.setAudioMuted(true);
      // A window Electron would show at construction (the default) is shown virtually, as is one asked to be full screen.
      if (fullscreen) state.fullScreen = true;
      if (show !== false) this.show();
      this.on("closed", () => { if (focusedWindow === this) focusedWindow = undefined; });
    }
    override show(): void {
      record("window:show", label(this));
      const state = states.get(this)!;
      const was = state.visible;
      state.visible = true;
      state.minimized = false;
      if (!was) this.emit("show");
      moveFocus(this);
    }
    override showInactive(): void {
      record("window:showInactive", label(this));
      const state = states.get(this)!;
      if (!state.visible) { state.visible = true; this.emit("show"); }
    }
    override hide(): void {
      record("window:hide", label(this));
      const state = states.get(this)!;
      if (state.visible) { state.visible = false; this.emit("hide"); }
      if (focusedWindow === this) moveFocus(undefined);
    }
    override focus(): void {
      record("window:focus", label(this));
      if (states.get(this)!.visible) moveFocus(this);
    }
    override blur(): void {
      record("window:blur", label(this));
      if (focusedWindow === this) moveFocus(undefined);
    }
    override minimize(): void {
      record("window:minimize", label(this));
      const state = states.get(this)!;
      state.minimized = true;
      if (focusedWindow === this) moveFocus(undefined);
      this.emit("minimize");
    }
    override restore(): void {
      record("window:restore", label(this));
      const state = states.get(this)!;
      if (state.minimized) { state.minimized = false; this.emit("restore"); }
    }
    override maximize(): void { record("window:maximize", label(this)); }
    override moveTop(): void { record("window:moveTop", label(this)); }
    override setFullScreen(flag: boolean): void { record("window:setFullScreen", { window: label(this), flag }); states.get(this)!.fullScreen = flag; }
    // Recorded, then applied: a window made earlier (the full-screen page waiting on macOS) is placed by this, not by its creation.
    override setBounds(bounds: Partial<ElectronModule.Rectangle>, animate?: boolean): void { record("window:setBounds", { id: this.id, bounds }); super.setBounds(bounds, animate); }
    override setSimpleFullScreen(flag: boolean): void { record("window:setSimpleFullScreen", { window: label(this), flag }); states.get(this)!.simpleFullScreen = flag; }
    override setKiosk(flag: boolean): void { record("window:setKiosk", { window: label(this), flag }); }
    override setVisibleOnAllWorkspaces(visible: boolean): void { record("window:setVisibleOnAllWorkspaces", { window: label(this), visible }); }
    override isVisible(): boolean { return states.get(this)?.visible ?? false; }
    override isFocused(): boolean { return focusedWindow === this && !this.isDestroyed(); }
    override isMinimized(): boolean { return states.get(this)?.minimized ?? false; }
    override isFullScreen(): boolean { return states.get(this)?.fullScreen ?? false; }
    override isSimpleFullScreen(): boolean { return states.get(this)?.simpleFullScreen ?? false; }
    static override getFocusedWindow(): BrowserWindowType | null { return focusedWindow && !focusedWindow.isDestroyed() ? focusedWindow : null; }
  }
  // Electron recognises its windows by constructor name (`BrowserWindow.getAllWindows`, `fromWebContents`).
  Object.defineProperty(ContainedWindow, "name", { value: "BrowserWindow" });

  // Every page this process makes is muted, the full-screen video's and the countdown's too.
  // A request to unmute is a violation at once, and the page stays muted: sound must never reach the desk.
  electron.app.on("web-contents-created", (_event, contents) => {
    const setAudioMuted = contents.setAudioMuted.bind(contents);
    setAudioMuted(true);
    contents.setAudioMuted = (muted: boolean): void => {
      if (!muted) violate("audio:unmute", `web contents ${contents.id} asked to unmute`);
      setAudioMuted(true);
    };
  });
  electron.app.on("browser-window-created", (_event, window) => {
    if (!(window instanceof ContainedWindow)) violate("window:uncontained", `window ${window.id} was not made through the boundary`);
    setImmediate(() => {
      if (!window.isDestroyed() && !window.webContents.isOffscreen()) violate("window:not-offscreen", `window ${window.id} renders onscreen`);
    });
  });

  // The real OS APIs this boundary replaces: a call that reaches one is a bypass.
  const guard = <T extends object>(name: string, target: T, methods: Array<keyof T>): void => {
    for (const method of methods) {
      const original = target[method];
      if (typeof original !== "function") continue;
      (target as Record<keyof T, unknown>)[method] = (...args: unknown[]) => {
        violate(`${name}.${String(method)}`, `reached the real ${name}.${String(method)}(${args.map(arg => typeof arg === "string" ? arg : typeof arg).join(", ")})`);
        return undefined;
      };
    }
  };
  guard("globalShortcut", electron.globalShortcut, ["register", "registerAll"]);
  guard("shell", electron.shell, ["openExternal", "openPath", "showItemInFolder", "trashItem", "beep"]);
  guard("desktopCapturer", electron.desktopCapturer, ["getSources"]);
  guard("dialog", electron.dialog, ["showMessageBox", "showMessageBoxSync", "showOpenDialog", "showOpenDialogSync", "showSaveDialog", "showSaveDialogSync",
    "showErrorBox", "showCertificateTrustDialog"]);
  guard("Notification.prototype", electron.Notification.prototype, ["show"]);
  guard("app", electron.app, ["focus", "show", "setLoginItemSettings"]);
  if (electron.app.dock) guard("app.dock", electron.app.dock, ["show", "bounce", "setMenu", "setBadge", "setIcon"]);
  // Electron's `Tray` export is a non-configurable getter, so the real constructor cannot be replaced: a real tray made
  // anyway is reported by its first use of these methods (production always sets an image, a tooltip and a menu).
  guard("Tray.prototype", electron.Tray.prototype, ["setImage", "setTitle", "setToolTip", "setContextMenu", "popUpContextMenu"]);

  const shortcuts = new ShortcutAdapter();
  let tray: TestTray | undefined;
  const notifications: NotificationConstructorOptions[] = [];
  const dialogs: ScriptedDialogs = { messageBox: [], openDialog: [] };
  fs.mkdirSync(options.trashDir, { recursive: true });

  class ObservedNotification extends EventEmitter {
    static isSupported(): boolean { return true; }
    constructor(readonly options: NotificationConstructorOptions) { super(); }
    show(): void { notifications.push(this.options); record("notification:show", { title: this.options.title, body: this.options.body }); }
    close(): void { this.emit("close"); }
  }

  const realApp = electron.app;
  const dock = realApp.dock && {
    // Hiding keeps the fixture out of the Dock, as production asks; showing is recorded and never done.
    hide: () => { record("dock:hide"); realApp.dock!.hide(); },
    show: async () => { record("dock:show"); },
    isVisible: () => realApp.dock!.isVisible(),
    setMenu: (menu: Menu) => { record("dock:setMenu", menu.items.map(item => item.label)); },
    setIcon: () => { record("dock:setIcon"); },
    bounce: () => { record("dock:bounce"); return 0; },
    cancelBounce: () => {},
    setBadge: (text: string) => { record("dock:setBadge", text); },
    getBadge: () => "",
    downloadFinished: () => {},
    getMenu: () => null,
  };
  const app = new Proxy(realApp, {
    get(target, property, receiver) {
      if (property === "dock") return dock;
      if (property === "focus") return (focusOptions?: unknown) => { record("app:focus", focusOptions); };
      if (property === "show") return () => { record("app:show"); };
      if (property === "setLoginItemSettings") return (settings: unknown) => { record("app:setLoginItemSettings", settings); };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });

  const contained = {
    ...electron,
    app,
    BrowserWindow: ContainedWindow,
    Tray: class extends TestTray { constructor(image: unknown) { super(image, created => { tray = created; record("tray:create"); }); } },
    Notification: ObservedNotification,
    globalShortcut: shortcuts,
    // One screen, so the permission check (permission.ts) finds capture allowed; nothing is captured from it.
    desktopCapturer: { getSources: async () => { record("desktopCapturer:getSources"); return [{ id: "screen:0:0", name: "Test display", display_id: "0" }]; } },
    systemPreferences: {
      ...electron.systemPreferences,
      getMediaAccessStatus: (media: string) => { record("systemPreferences:getMediaAccessStatus", media); return "granted"; },
      askForMediaAccess: async () => true,
    },
    powerSaveBlocker: {
      start: (type: string) => { record("powerSaveBlocker:start", type); return 1; },
      stop: () => { record("powerSaveBlocker:stop"); },
      isStarted: () => false,
    },
    shell: {
      openExternal: async (url: string) => { record("shell:openExternal", url); },
      openPath: async (target: string) => { record("shell:openPath", target); return ""; },
      showItemInFolder: (target: string) => { record("shell:showItemInFolder", target); },
      beep: () => { record("shell:beep"); },
      // The file really moves, into the test's own Trash folder, so a test sees the file operation and the request apart.
      trashItem: async (target: string) => {
        record("shell:trashItem", target);
        await fs.promises.rename(target, path.join(options.trashDir, `${Date.now()}-${path.basename(target)}`));
      },
    },
    dialog: {
      showMessageBox: async (...args: unknown[]) => {
        const box = (args.find(arg => arg && typeof arg === "object" && "message" in arg) ?? {}) as { message?: string; buttons?: string[]; cancelId?: number };
        const response = dialogs.messageBox.shift() ?? box.cancelId ?? 0;
        record("dialog:showMessageBox", { message: box.message, buttons: box.buttons, response });
        return { response, checkboxChecked: false };
      },
      showMessageBoxSync: (...args: unknown[]) => {
        const box = (args.find(arg => arg && typeof arg === "object" && "message" in arg) ?? {}) as { message?: string; cancelId?: number };
        const response = dialogs.messageBox.shift() ?? box.cancelId ?? 0;
        record("dialog:showMessageBoxSync", { message: box.message, response });
        return response;
      },
      showOpenDialog: async (...args: unknown[]) => {
        const answer = dialogs.openDialog.shift();
        record("dialog:showOpenDialog", { answer, options: args.at(-1) });
        return answer === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [answer] };
      },
      showSaveDialog: async () => { record("dialog:showSaveDialog"); return { canceled: true }; },
      // An error box would hold main on a modal the background cannot answer: it is recorded and fails the test.
      showErrorBox: (title: string, content: string) => { record("dialog:showErrorBox", { title, content }); violate("dialog.showErrorBox", `${title}: ${content}`); },
    },
  } as unknown as Electron;

  /**
   * An offscreen window's own `isVisible()` follows its page's visibility, not the screen, so it cannot say whether
   * anything appeared; the Playwright fixture asks the window server instead (desktop-probe.ts). This checks what
   * Electron can tell: every window came through the boundary, renders offscreen and is muted.
   */
  const audit = (): Violation[] => {
    for (const window of electron.BaseWindow.getAllWindows()) {
      if (!(window instanceof ContainedWindow)) { violate("window:uncontained", `window ${window.id}`); continue; }
      if (window.isDestroyed()) continue;
      if (!window.webContents.isOffscreen()) violate("window:not-offscreen", `window ${label(window)}`);
      if (!window.webContents.isAudioMuted()) violate("audio:unmuted", `window ${label(window)}`);
    }
    for (const contents of electron.webContents.getAllWebContents()) {
      if (!contents.isDestroyed() && !contents.isAudioMuted() && contents.getType() !== "remote") violate("audio:unmuted", `web contents ${contents.id} (${contents.getType()})`);
    }
    return violations;
  };

  return {
    electron: contained, calls, violations, shortcuts, tray: () => tray, notifications, dialogs, trashDir: options.trashDir,
    windowState: window => states.get(window), windows: () => made, audit,
  };
}
