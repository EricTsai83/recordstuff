/**
 * Tray icon, right-click menu and notifications (docs/system-design/recording.md). This is a
 * projection of `RecordingState`; every decision lives in `recorder.ts`.
 * Left click opens the menu or toggles, as the user chose (`trayClick`, 2026-10-04); right click
 * always pops the menu. The menu is rebuilt from the current state each time — never
 * `setContextMenu`, which would make macOS pop it on every left click regardless of the choice. The menu is a flat list of commands:
 * preferences live in the settings window (docs/system-design/desktop.md).
 */
import { Menu, Notification, Tray, nativeImage, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import type { ErrorCode, RecordingState } from "../shared/state";
import type { FrameRate } from "../shared/quality";
import type { HotkeyAccelerator } from "../shared/hotkey";
import { translate, type Language } from "../shared/i18n";
import type { TrayClick } from "../shared/appearance";
import {
  displayWriteFailedNotification,
  folderRefusedNotification,
  languageWriteFailedNotification,
  frameRateDowngradeNotification,
  hotkeyRegistrationFailedNotification,
  menuLogText,
  hotkeyWriteFailedNotification,
  notificationsEnabledNotification,
  updateAvailableNotification,
  permissionNotification,
  qualityWriteFailedNotification,
  recordingFailureNotification,
  savedNotification,
  settingsWriteFailedNotification,
  trayHintNotification,
  trayModel,
  type TrayIcon,
  type TrayMenuItem,
} from "./tray-model";
import { APP_NAME, type AppAction, type AppContext } from "./ui-model";
import type { EarlyStop } from "../shared/session-record";

/** After waking, how often to check whether the user is back before showing held notifications (plan 050). */
export const WAKE_CHECK_MS = 1000;
/**
 * Input this recent means the user is back. A maintenance (dark) wake has
 * none and may also report `resume`, and timers keep counting while the Mac
 * sleeps, so neither a resume nor a timeout alone proves anyone can see a banner.
 */
export const RETURN_IDLE_SECONDS = 2;

export interface TrayOptions {
  resourcesDir: string;
  context: () => AppContext;
  onToggle: () => void;
  /** Show a saved recording from its notification: the Recordings tab with it in view. */
  showSaved: (file: string) => void;
  /** The permission notification's click, resolved against the permission state at click time. */
  permissionAction: () => void;
  onAction: (action: AppAction) => void;
  /** Diagnostics for notifications the OS refuses to show. */
  log?: (message: string) => void;
  /** The user's switch. Absent means always allowed, which is the test default. */
  canNotify?: () => boolean;
  /** Seconds since the last user input. Absent means the user counts as back at once, which is the test default. */
  idleSeconds?: () => number;
  /** Every notification click, before its own action: the activation that follows is not a reopen (plan 053). */
  onNotificationClick?: () => void;
  /** The notification language; absent reads it from `context`, which also projects displays and the whole failure history. */
  language?: () => Language;
  /** What a left click does, read at each click; absent reads it from `context`, as `language` does. */
  trayClick?: () => TrayClick;
  /** Its menu closed (`menuOpen` is false again): a Dock icon hide held back while it was open can run now. */
  menuClosed?: () => void;
  /** Monotonic milliseconds, to tell input since waking from input before the sleep. Tests pin it. */
  now?: () => number;
}

export class AppTray {
  private readonly tray: Tray;
  private readonly icons: Record<TrayIcon, Electron.NativeImage>;
  private currentIcon: TrayIcon | undefined;
  /** What the native item shows; a refresh that changes nothing makes no native call. */
  private currentTitle: string | undefined;
  private currentTooltip: string | undefined;
  // Electron notifications are GC-owned. Keep callbacks alive until the user
  // handles/dismisses the notification, delivery fails, or the tray shuts down.
  private readonly notifications = new Set<Notification>();

  constructor(private readonly options: TrayOptions) {
    this.icons = loadIcons(options.resourcesDir, (message) => this.log(message));
    this.tray = new Tray(this.icons.idle);
    this.tray.setIgnoreDoubleClickEvents(true);
    this.tray.on("click", () => {
      const choice = options.trayClick ? options.trayClick() : options.context().trayClick;
      if ((choice ?? "record") === "menu") this.popUpMenu();
      else options.onToggle();
    });
    this.tray.on("right-click", () => this.popUpMenu());
  }

  private lastState: RecordingState = { type: "idle" };
  // Electron throws on a destroyed tray; a late refresh during quit must not surface as an error dialog.
  private destroyed = false;
  // A banner shown while the Mac sleeps is gone before the user is back, so notifications wait for waking.
  private asleep = false;
  private resumed = false;
  /** When the last wake arrived, by `now()`. */
  private resumedAt = 0;
  private held: Array<() => void> = [];
  private heldTimer: ReturnType<typeof setTimeout> | undefined;

  render(state: RecordingState): void {
    if (this.destroyed) return;
    this.lastState = state;
    const model = trayModel(state, this.options.context());
    if (model.icon !== this.currentIcon) {
      this.tray.setImage(this.icons[model.icon]);
      this.currentIcon = model.icon;
    }
    if (process.platform === "darwin" && model.title !== this.currentTitle) {
      this.tray.setTitle(model.title);
      this.currentTitle = model.title;
    }
    if (model.tooltip !== this.currentTooltip) {
      this.tray.setToolTip(model.tooltip);
      this.currentTooltip = model.tooltip;
    }
  }

  /** The context changed while the state did not (language, output folder): redraw the icon, title and tooltip. */
  refresh(): void {
    this.render(this.lastState);
  }

  /** The Mac is going to sleep: hold notifications until the user is back. */
  systemWillSleep(): void {
    this.asleep = true;
    this.resumed = false;
    clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
  }

  /** Awake again: show the held notifications, in order, once there is user input. */
  systemDidWake(): void {
    this.resumed = true;
    this.resumedAt = this.now();
    if (this.asleep && this.held.length) this.checkReturn();
  }

  /** Unlocking the screen means the user is back. */
  userDidUnlock(): void {
    if (this.asleep) this.showHeld();
  }

  private checkReturn(): void {
    clearTimeout(this.heldTimer);
    this.heldTimer = setTimeout(() => {
      this.heldTimer = undefined;
      if (this.userReturned()) this.showHeld();
      else this.checkReturn();
    }, WAKE_CHECK_MS);
  }

  /**
   * Recent input, or any input since waking, means someone is at the Mac: a user who
   * came back and then stopped typing must not wait for their next keystroke. Without
   * input the idle time is at least the time since the wake, so a shorter one proves
   * input after it; one second absorbs the idle time's whole-second rounding. An
   * unknown idle time does not hold notifications back.
   */
  private userReturned(): boolean {
    let idle: number | undefined;
    try { idle = this.options.idleSeconds?.(); }
    catch (error) { this.log(`notification: idle time unavailable (${String(error)})`); }
    if (idle === undefined || idle <= RETURN_IDLE_SECONDS) return true;
    return this.resumed && idle + 1 < (this.now() - this.resumedAt) / 1000;
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }

  private showHeld(): void {
    clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
    this.asleep = false;
    const held = this.held;
    this.held = [];
    for (const show of held) show();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.heldTimer);
    this.held = [];
    for (const notification of this.notifications) {
      try { notification.close(); }
      catch (error) { this.log(`notification: close failed (${String(error)})`); }
    }
    this.notifications.clear();
    this.tray.destroy();
  }

  /** The language notifications are written in. */
  private get language(): Language {
    return this.options.language?.() ?? this.options.context().language;
  }

  notifySaved(savedPath: string, stoppedEarly?: EarlyStop): void {
    this.show(savedNotification(savedPath, this.options.context().platform, this.language, stoppedEarly), () => {
      // The app's own window, so the activation macOS gives the clicked app is what brings it forward.
      this.log(`notification: show saved ${savedPath}`);
      this.options.showSaved(savedPath);
    });
  }

  notifyRecordingFailure(code: ErrorCode): void {
    this.show(recordingFailureNotification(code, this.language), () => this.options.onAction("openRecordingResult"));
  }

  /** `answer`: a reply to the user's own click or shortcut, shown even with notifications off, like a deferred quit. */
  notifyPermission(needsRelaunch: boolean, answer = false): void {
    this.show(permissionNotification(needsRelaunch, this.language), () => this.options.permissionAction(), answer);
  }

  notifySettingsWriteFailed(chosenDir: string): void {
    this.show(settingsWriteFailedNotification(chosenDir, this.options.context().homeDir, this.language));
  }

  notifyFolderRefused(chosenDir: string): void {
    this.show(folderRefusedNotification(chosenDir, this.options.context().homeDir, this.language));
  }

  notifyLanguageWriteFailed(): void {
    this.show(languageWriteFailedNotification(this.language));
  }

  notifyDisplayWriteFailed(): void {
    this.show(displayWriteFailedNotification(this.language));
  }

  notifyQualityWriteFailed(): void {
    this.show(qualityWriteFailedNotification(this.language));
  }

  /** The banner points to Settings, so clicking it opens the tab with the shortcut card, its retry and the editor. */
  notifyHotkeyRegistrationFailed(accelerator: HotkeyAccelerator): void {
    this.show(hotkeyRegistrationFailedNotification(accelerator, this.options.context().platform, this.language), () => this.options.onAction("openShortcutSettings"));
  }

  notifyHotkeyWriteFailed(): void {
    this.show(hotkeyWriteFailedNotification(this.language));
  }

  notifyFrameRateDowngrade(requested: FrameRate, actual: number): void {
    this.show(frameRateDowngradeNotification(requested, actual, this.language));
  }

  /** The click selects the Recording tab even in an open window, where the warning is shown. */
  notifyCaptureWarning(body: string): void {
    this.show({ title: APP_NAME, body }, () => this.options.onAction("openRecordingSettings"));
  }

  notifyTrayHint(): void {
    const context = this.options.context();
    this.show(trayHintNotification(context.platform, this.language, context.trayClick));
  }

  /** `openDownload` answers the click; main owns the download page and the recording lock it must respect. */
  notifyUpdateAvailable(version: string, openDownload: () => void): void {
    this.show(updateAvailableNotification(version, this.language), openDownload);
  }

  notifyNotificationsEnabled(): void {
    this.show(notificationsEnabledNotification(this.language));
  }

  /**
   * Answers the user's own click, so the switch for saved and failure notices does not apply: a deferred quit,
   * like the dialog it replaced (plan 055), or System Settings failing to open while recording work is pending (plan 056).
   */
  notifyAnswer(body: string): void {
    this.show({ title: APP_NAME, body }, undefined, true);
  }

  /** The output-folder warning while recording work is pending (plan 056); like the quit notice it answers the user's own click. */
  notifyOutputFolderProblem(body: string): void {
    this.show({ title: translate("Could not open the output folder", this.language), body }, undefined, true);
  }

  /**
   * A notification is a best-effort hint, never part of recording: nothing
   * here may throw into the caller. Local verification found a save whose notification
   * never appeared, with nothing in the log to say whether the app or the OS
   * dropped it — on macOS `UNUserNotificationCenter` can refuse an unsigned
   * or ad-hoc-signed build outright. Electron's `failed` event is the only
   * trace, so it goes to the log; signed-build evidence is in docs/verification/README.md.
   */
  private show(text: { title: string; body: string }, onClick?: () => void, always = false): void {
    if (this.destroyed) return;
    // A wake with nothing held starts no check, so the first notice after it
    // asks whether the user already came back instead of waiting for a return.
    if (this.asleep && this.resumed && this.userReturned()) this.showHeld();
    if (this.asleep) {
      // The switch and support checks apply when it is finally shown.
      this.held.push(() => this.show(text, onClick, always));
      if (this.resumed && !this.heldTimer) this.checkReturn();
      this.log(`notification: held during sleep: ${text.body}`);
      return;
    }
    try {
      if (!always && this.options.canNotify && !this.options.canNotify()) {
        this.log(`notification: turned off in settings, dropped: ${text.body}`);
        return;
      }
      if (!Notification.isSupported()) {
        this.log(`notification: not supported on this system, dropped: ${text.body}`);
        return;
      }
      const notification = new Notification({ title: text.title, body: text.body, silent: true });
      this.notifications.add(notification);
      notification.on("show", () => this.log(`notification: shown: ${text.body}`));
      notification.on("close", () => {
        this.notifications.delete(notification);
        this.log(`notification: closed: ${text.body}`);
      });
      notification.on("click", () => {
        this.notifications.delete(notification);
        this.log(`notification: clicked: ${text.body}`);
        this.options.onNotificationClick?.();
        onClick?.();
      });
      // `(event, error)` per Electron's Notification docs; darwin and win32 only.
      notification.on("failed", (_event, error) => {
        this.notifications.delete(notification);
        this.log(`notification: failed (${error}): ${text.body}`);
      });
      this.log(`notification: show requested: ${text.body}`);
      try { notification.show(); }
      catch (error) {
        this.notifications.delete(notification);
        this.log(`notification: failed (${String(error)}): ${text.body}`);
      }
    } catch (error) { this.log(`notification: construction failed (${String(error)}): ${text.body}`); }
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** Whether its menu is open: hiding the Dock icon now would close it under the pointer (app-menu.ts). */
  get menuOpen(): boolean {
    return this.menuShown;
  }
  private menuShown = false;

  private popUpMenu(): void {
    if (this.destroyed) return;
    const model = trayModel(this.lastState, this.options.context());
    this.log(`tray: menu opened in ${this.lastState.type}: ${menuLogText(model.menu)}`);
    const menu = Menu.buildFromTemplate(model.menu.map((entry) => this.toTemplate(entry)));
    menu.once("menu-will-close", () => { this.menuShown = false; this.options.menuClosed?.(); });
    this.menuShown = true;
    try { this.tray.popUpContextMenu(menu); }
    catch (error) { this.menuShown = false; throw error; }
  }

  private toTemplate(entry: TrayMenuItem): MenuItemConstructorOptions {
    if (entry.kind === "separator") return { type: "separator" };
    const template: MenuItemConstructorOptions = { label: entry.label, enabled: entry.enabled };
    if (entry.toolTip !== undefined) template.toolTip = entry.toolTip;
    // Shown right-aligned only: the shortcut is already global, so the menu must not register it again.
    if (entry.accelerator !== undefined) { template.accelerator = entry.accelerator; template.registerAccelerator = false; }
    const action = entry.action;
    if (action) template.click = () => this.options.onAction(action);
    return template;
  }
}

/** Every state has its own file: `tray-<state>.ico` on Windows, `tray<State>Template.png` elsewhere. */
export const TRAY_ICON_FILES: Record<TrayIcon, { win32: string; template: string }> = {
  idle: { win32: "tray-idle.ico", template: "trayIdleTemplate.png" },
  busy: { win32: "tray-busy.ico", template: "trayBusyTemplate.png" },
  countdown: { win32: "tray-countdown.ico", template: "trayCountdownTemplate.png" },
  recording: { win32: "tray-recording.ico", template: "trayRecordingTemplate.png" },
  warning: { win32: "tray-warning.ico", template: "trayWarningTemplate.png" },
};

/**
 * `createFromPath` never throws: a missing or unreadable file yields an empty
 * image, and an empty tray icon is invisible. Log it, so a broken bundle or
 * resources path is found in the log rather than by a menu bar with no item.
 */
function loadIcons(resourcesDir: string, log: (message: string) => void): Record<TrayIcon, Electron.NativeImage> {
  const icons = {} as Record<TrayIcon, Electron.NativeImage>;
  for (const [icon, files] of Object.entries(TRAY_ICON_FILES) as Array<[TrayIcon, (typeof TRAY_ICON_FILES)[TrayIcon]]>) {
    const file = path.join(resourcesDir, process.platform === "win32" ? files.win32 : files.template);
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) log(`tray: icon ${icon} could not be loaded from ${file}; the tray item may be invisible`);
    // `*Template.png` (+ `@2x`) is picked up by Electron as a macOS template
    // image, which follows the menu bar's light/dark appearance automatically.
    if (process.platform !== "win32") image.setTemplateImage(true);
    icons[icon] = image;
  }
  return icons;
}
