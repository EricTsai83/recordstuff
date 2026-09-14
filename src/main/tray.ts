/**
 * Tray icon, right-click menu and notifications (docs/system-design/recording.md). This is a
 * projection of `RecordingState`; every decision lives in `recorder.ts`.
 * Left click toggles (`tray.on('click')`); right click pops a menu rebuilt
 * from the current state each time — never `setContextMenu`, which would make
 * macOS pop the menu on left click too.
 */
import { Menu, Notification, Tray, nativeImage, shell, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import type { ErrorCode, RecordingState } from "../shared/state";
import type { FrameRate } from "../shared/quality";
import {
  errorNotification,
  languageWriteFailedNotification,
  frameRateDowngradeNotification,
  permissionNotification,
  qualityWriteFailedNotification,
  savedNotification,
  settingsWriteFailedNotification,
  trayHintNotification,
  trayModel,
  type TrayAction,
  type TrayContext,
  type TrayIcon,
  type TrayMenuItem,
} from "./tray-model";

export interface TrayOptions {
  resourcesDir: string;
  context: () => TrayContext;
  onToggle: () => void;
  onAction: (action: TrayAction) => void;
  /** Diagnostics for notifications the OS refuses to show. */
  log?: (message: string) => void;
}

export class AppTray {
  private readonly tray: Tray;
  private readonly icons: Record<TrayIcon, Electron.NativeImage>;
  private currentIcon: TrayIcon | undefined;

  constructor(private readonly options: TrayOptions) {
    this.icons = loadIcons(options.resourcesDir);
    this.tray = new Tray(this.icons.idle);
    this.tray.setIgnoreDoubleClickEvents(true);
    this.tray.on("click", () => options.onToggle());
    this.tray.on("right-click", () => this.popUpMenu());
  }

  private lastState: RecordingState = { type: "idle" };

  render(state: RecordingState): void {
    this.lastState = state;
    const model = trayModel(state, this.options.context());
    if (model.icon !== this.currentIcon) {
      this.tray.setImage(this.icons[model.icon]);
      this.currentIcon = model.icon;
    }
    if (process.platform === "darwin") this.tray.setTitle(model.title);
    this.tray.setToolTip(model.tooltip);
  }

  /** The output dir changed while the state did not; refresh labels. */
  refresh(): void {
    this.render(this.lastState);
  }

  destroy(): void {
    this.tray.destroy();
  }

  notifySaved(savedPath: string): void {
    this.show(savedNotification(savedPath, this.options.context().language), () => this.revealFromNotification(savedPath));
  }

  notifyError(code: ErrorCode, partialPath: string | undefined): void {
    const ctx = this.options.context();
    this.show(errorNotification(code, partialPath, ctx), () => {
      if (partialPath) this.revealFromNotification(partialPath);
      else if (code === "output_open_failed") this.options.onAction("changeOutputDir");
      else if (code === "permission_denied") this.options.onAction("openPermissionSettings");
      else if (code === "permission_needs_relaunch") this.options.onAction("relaunch");
    });
  }

  private revealFromNotification(filePath: string): void {
    const reveal = (): void => {
      try {
        shell.showItemInFolder(filePath);
        this.log(`notification: reveal requested ${filePath}`);
      } catch (error) {
        this.log(`notification: reveal failed (${String(error)}): ${filePath}`);
      }
    };
    // Let macOS finish the native notification response before asking Finder
    // to take focus. Its completion handler runs after our click callback.
    if (process.platform === "darwin") setImmediate(reveal);
    else reveal();
  }

  notifyPermission(needsRelaunch: boolean): void {
    this.show(permissionNotification(needsRelaunch, this.options.context().language), () =>
      this.options.onAction(needsRelaunch ? "relaunch" : "openPermissionSettings"),
    );
  }

  notifySettingsWriteFailed(chosenDir: string): void {
    this.show(settingsWriteFailedNotification(chosenDir, this.options.context().homeDir, this.options.context().language));
  }

  notifyLanguageWriteFailed(): void {
    this.show(languageWriteFailedNotification(this.options.context().language));
  }

  notifyQualityWriteFailed(): void {
    this.show(qualityWriteFailedNotification(this.options.context().language));
  }

  notifyFrameRateDowngrade(requested: FrameRate, actual: number): void {
    this.show(frameRateDowngradeNotification(requested, actual, this.options.context().language));
  }

  notifyTrayHint(): void {
    this.show(trayHintNotification(this.options.context().language));
  }

  /**
   * A notification is a best-effort hint, never part of recording: nothing
   * here may throw into the caller. Local verification found a save whose notification
   * never appeared, with nothing in the log to say whether the app or the OS
   * dropped it — on macOS `UNUserNotificationCenter` can refuse an unsigned
   * or ad-hoc-signed build outright. Electron's `failed` event is the only
   * trace, so it goes to the log; signed-build evidence is in docs/verification/README.md.
   */
  private show(text: { title: string; body: string }, onClick?: () => void): void {
    if (!Notification.isSupported()) {
      this.log(`notification: not supported on this system, dropped: ${text.body}`);
      return;
    }
    const notification = new Notification({ title: text.title, body: text.body, silent: true });
    if (onClick) notification.on("click", onClick);
    // `(event, error)` per Electron's Notification docs; darwin and win32 only.
    notification.on("failed", (_event, error) => {
      this.log(`notification: failed (${error}): ${text.body}`);
    });
    notification.show();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private popUpMenu(): void {
    const model = trayModel(this.lastState, this.options.context());
    this.tray.popUpContextMenu(Menu.buildFromTemplate(model.menu.map((entry) => this.toTemplate(entry))));
  }

  private toTemplate(entry: TrayMenuItem): MenuItemConstructorOptions {
    switch (entry.kind) {
      case "separator":
        return { type: "separator" };
      case "submenu":
        return { label: entry.label, enabled: entry.enabled, submenu: entry.items.map((e) => this.toTemplate(e)) };
      case "radio":
        return {
          type: "radio",
          label: entry.label,
          enabled: entry.enabled,
          checked: entry.checked,
          click: () => this.options.onAction(entry.action),
        };
      case "item": {
        const template: MenuItemConstructorOptions = { label: entry.label, enabled: entry.enabled };
        if (entry.toolTip !== undefined) template.toolTip = entry.toolTip;
        const action = entry.action;
        if (action) template.click = () => this.options.onAction(action);
        return template;
      }
    }
  }
}

function loadIcons(resourcesDir: string): Record<TrayIcon, Electron.NativeImage> {
  if (process.platform === "win32") {
    return {
      idle: nativeImage.createFromPath(path.join(resourcesDir, "tray-idle.ico")),
      recording: nativeImage.createFromPath(path.join(resourcesDir, "tray-recording.ico")),
    };
  }
  // `*Template.png` (+ `@2x`) is picked up by Electron as a macOS template
  // image, which follows the menu bar's light/dark appearance automatically.
  const idle = nativeImage.createFromPath(path.join(resourcesDir, "trayIdleTemplate.png"));
  const recording = nativeImage.createFromPath(path.join(resourcesDir, "trayRecordingTemplate.png"));
  idle.setTemplateImage(true);
  recording.setTemplateImage(true);
  return { idle, recording };
}
