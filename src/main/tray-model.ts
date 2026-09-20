/**
 * Pure state-to-presentation projection for the native tray. See
 * docs/system-design/desktop.md.
 *
 * The tray holds the commands that must stay one click away — start/stop, the
 * output folder, log, quit — and an entry that opens the settings
 * window. Preferences themselves live in [settings-model.ts](settings-model.ts);
 * this model never builds a submenu, so what it returns is exactly what the
 * menu shows.
 */
import path from "node:path";
import { translate as t, type Language, type MessageKey } from "../shared/i18n";
import type { FrameRate } from "../shared/quality";
import type { ErrorCode, RecordingState } from "../shared/state";
import { describeAccelerator, type HotkeyAccelerator } from "../shared/hotkey";

import { APP_NAME, abbreviateHome, type AppAction, type AppContext } from "./ui-model";

export type TrayIcon = "idle" | "recording";
export type TrayMenuItem =
  | { kind: "separator" }
  | { kind: "item"; label: string; enabled: boolean; action?: AppAction; toolTip?: string };
export interface TrayModel {
  icon: TrayIcon;
  title: string;
  tooltip: string;
  menu: TrayMenuItem[];
}

function disabled(label: string): TrayMenuItem {
  return { kind: "item", label, enabled: false };
}
function item(label: string, action: AppAction, toolTip?: string): TrayMenuItem {
  return toolTip === undefined
    ? { kind: "item", label, enabled: true, action }
    : { kind: "item", label, enabled: true, action, toolTip };
}
const SEPARATOR: TrayMenuItem = { kind: "separator" };

/** Settings, log and quit close every menu; Settings stays reachable mid-recording. */
function footer(language: Language): TrayMenuItem[] {
  return [
    SEPARATOR,
    item(t("Settings…", language), "openSettings"),
    item(t("Show log", language), "revealLog"),
    item(t("Quit", language), "quit"),
  ];
}
function outputDirItems(ctx: AppContext, enabled: boolean): TrayMenuItem[] {
  const label = t("Output folder: {path}", ctx.language, { path: abbreviateHome(ctx.outputDir, ctx.homeDir) });
  return [
    enabled
      ? item(label, "openOutputDir", ctx.outputDir)
      : { kind: "item", label, enabled: false, toolTip: ctx.outputDir },
    enabled
      ? item(t("Change output folder…", ctx.language), "changeOutputDir")
      : disabled(t("Change output folder…", ctx.language)),
  ];
}
function permissionActions(needsRelaunch: boolean, language: Language): TrayMenuItem[] {
  const hint = t(
    "After allowing access in System Settings, relaunch RecordStuff if this process still cannot capture.",
    language,
  );
  return needsRelaunch
    ? [item(t("Relaunch", language), "relaunch", hint)]
    : [
        item(t("Open System Settings", language), "openPermissionSettings"),
        item(t("Already allowed? Relaunch RecordStuff", language), "relaunch", hint),
      ];
}
/** Tooltip on Stop reminding the user of the registered shortcut, if any. */
function stopHint(ctx: AppContext): string | undefined {
  const hotkey = ctx.hotkey;
  if (!hotkey.enabled || !hotkey.registered) return undefined;
  return t("Start / stop recording with {value}", ctx.language, {
    value: describeAccelerator(hotkey.accelerator, ctx.platform),
  });
}
export function trayModel(state: RecordingState, ctx: AppContext): TrayModel {
  const language = ctx.language;
  const text = (key: MessageKey): string => t(key, language);
  const end = footer(language);
  const model = (icon: TrayIcon, title: string, status: string, menu: TrayMenuItem[]): TrayModel => ({
    icon,
    title,
    tooltip: `${APP_NAME}: ${status}\n${text("Right-click to open the menu")}`,
    menu,
  });
  switch (state.type) {
    case "needsPermission":
      return model("idle", "", text("Screen recording permission required"), [
        disabled(text("Screen recording permission required")),
        ...permissionActions(state.needsRelaunch, language),
        SEPARATOR,
        ...outputDirItems(ctx, true),
        ...end,
      ]);
    case "idle": {
      const status = text(state.outputDirUnavailable ? "Output folder unavailable" : "Ready");
      const menu = [disabled(status)];
      if (state.lastSavedPath) menu.push(item(text("Show last recording"), "revealLastSaved", state.lastSavedPath));
      return model("idle", "", status, [...menu, SEPARATOR, ...outputDirItems(ctx, true), ...end]);
    }
    case "starting":
      return model("idle", "…", text("Starting… Check for system permission prompts"), [
        disabled(text("Starting… Check for system permission prompts")),
        ...end,
      ]);
    case "recording":
      return model("recording", "REC", text("Recording"), [
        disabled(text("Recording")),
        item(text("Stop"), "stop", stopHint(ctx)),
        SEPARATOR,
        ...outputDirItems(ctx, false),
        ...end,
      ]);
    case "stopping":
      return model("idle", "…", text("Saving…"), [disabled(text("Saving…")), ...end]);
  }
}

export interface NotificationText {
  title: string;
  body: string;
}
const notice = (body: string): NotificationText => ({ title: APP_NAME, body });
export function savedNotification(savedPath: string, language?: Language): NotificationText {
  return notice(t("Saved {file}", language, { file: path.basename(savedPath) }));
}
export function permissionNotification(needsRelaunch: boolean, language?: Language): NotificationText {
  return notice(
    t(
      needsRelaunch
        ? "Screen recording access was granted, but RecordStuff needs to relaunch. Click to relaunch."
        : "RecordStuff needs screen recording access. Click to open System Settings.",
      language,
    ),
  );
}
export function settingsWriteFailedNotification(
  chosenDir: string,
  homeDir: string,
  language?: Language,
): NotificationText {
  return notice(
    t("Could not save settings. The output folder is unchanged. Try choosing {path} again.", language, {
      path: abbreviateHome(chosenDir, homeDir),
    }),
  );
}
export function qualityWriteFailedNotification(language?: Language): NotificationText {
  return notice(t("Could not save recording quality. Your previous settings are still in use.", language));
}
export function languageWriteFailedNotification(language?: Language): NotificationText {
  return notice(t("Could not save the language. Your previous language is still in use.", language));
}
export function hotkeyRegistrationFailedNotification(
  accelerator: HotkeyAccelerator,
  platform: NodeJS.Platform,
  language?: Language,
): NotificationText {
  return notice(
    t(
      "Could not register the shortcut {value}. Another app may be using it. Choose another shortcut in Settings.",
      language,
      { value: describeAccelerator(accelerator, platform) },
    ),
  );
}
export function hotkeyWriteFailedNotification(language?: Language): NotificationText {
  return notice(t("Could not save the shortcut. Your previous shortcut is still in use.", language));
}
export function frameRateDowngradeNotification(
  requested: FrameRate,
  actual: number,
  language?: Language,
): NotificationText {
  return notice(
    t("The system provides {actual} fps. This recording uses {actual} fps (requested {requested} fps).", language, {
      actual,
      requested,
    }),
  );
}
export function trayHintNotification(language?: Language): NotificationText {
  return notice(t("RecordStuff is ready in the system tray. Click to start recording; click again to stop.", language));
}
export function errorNotification(
  code: ErrorCode,
  partialPath: string | undefined,
  ctx: Pick<AppContext, "homeDir" | "outputDir" | "language">,
): NotificationText {
  // Technical detail remains in English logs; user recovery guidance is fully localized.
  const language = ctx.language;
  const kept = partialPath
    ? t("Partial recording kept: {file}. Click to show the file.", language, { file: path.basename(partialPath) })
    : t("No content was recorded.", language);
  const reasons: Record<ErrorCode, MessageKey> = {
    permission_denied: "Screen recording access is missing. Open System Settings from the tray menu.",
    permission_needs_relaunch:
      "Screen recording access was granted, but RecordStuff needs to relaunch. Use the tray menu.",
    unsupported_os_version:
      "This system version does not support system audio capture. macOS 13 or newer is required on Mac.",
    no_display: "No display is available for recording.",
    no_audio_track:
      "System audio is unavailable. On macOS, allow RecordStuff in System Settings > Privacy & Security > Screen & System Audio Recording.",
    mp4_unsupported: "MP4 recording is not supported on this computer.",
    capture_start_failed: "Could not start recording.",
    capture_failed: "Recording was interrupted.",
    capture_host_crashed: "The recording process crashed.",
    capture_host_unresponsive: "The recording process is not responding.",
    output_open_failed: "Cannot write to {path}. Choose another output folder from the tray menu.",
    output_write_failed: "Could not write the recording.",
    disk_full: "The disk is full.",
    stop_timeout: "Stopping the recording timed out.",
  };
  const body = t(reasons[code], language, { path: abbreviateHome(ctx.outputDir, ctx.homeDir) });
  const preserve =
    partialPath ||
    [
      "capture_start_failed",
      "capture_failed",
      "capture_host_crashed",
      "capture_host_unresponsive",
      "output_write_failed",
      "disk_full",
      "stop_timeout",
    ].includes(code);
  return notice(preserve ? `${body} ${kept}` : body);
}
