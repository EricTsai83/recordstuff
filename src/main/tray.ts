/**
 * Tray icon, right-click menu and notifications (plans/001-first-version.md §8). This is a
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
    this.show(savedNotification(savedPath), () => shell.showItemInFolder(savedPath));
  }

  notifyError(code: ErrorCode, detail: string, partialPath: string | undefined): void {
    const ctx = this.options.context();
    this.show(errorNotification(code, detail, partialPath, ctx), () => {
      if (partialPath) shell.showItemInFolder(partialPath);
      else if (code === "output_open_failed") this.options.onAction("changeOutputDir");
      else if (code === "permission_denied") this.options.onAction("openPermissionSettings");
      else if (code === "permission_needs_relaunch") this.options.onAction("relaunch");
    });
  }

  notifyPermission(needsRelaunch: boolean): void {
    this.show(permissionNotification(needsRelaunch), () =>
      this.options.onAction(needsRelaunch ? "relaunch" : "openPermissionSettings"),
    );
  }

  notifySettingsWriteFailed(chosenDir: string): void {
    this.show(settingsWriteFailedNotification(chosenDir, this.options.context().homeDir));
  }

  notifyQualityWriteFailed(): void {
    this.show(qualityWriteFailedNotification());
  }

  notifyFrameRateDowngrade(requested: FrameRate, actual: number): void {
    this.show(frameRateDowngradeNotification(requested, actual));
  }

  notifyTrayHint(): void {
    this.show(trayHintNotification());
  }

  private show(text: { title: string; body: string }, onClick?: () => void): void {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: text.title, body: text.body, silent: true });
    if (onClick) notification.on("click", onClick);
    notification.show();
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
