import { failureReason } from "./recording-result";
import { displayLabel, displayFailureText } from "../shared/display";
import { displayResolution } from "./display-source";
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
import { translate as t, type Language, type PlainMessageKey } from "../shared/i18n";
import type { FrameRate } from "../shared/quality";
import type { RecordingState } from "../shared/state";
import { describeAccelerator, SETTINGS_SHORTCUT, type HotkeyAccelerator } from "../shared/hotkey";

import { APP_NAME, abbreviateHome, type AppAction, type AppContext } from "./ui-model";

export type TrayIcon = "idle" | "recording" | "warning";
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
function footer(ctx: AppContext): TrayMenuItem[] {
  const { language, settingsShortcut } = ctx;
  const label = t("Settings", language) + (settingsShortcut?.kind === "registered"
    ? ` (${describeAccelerator(SETTINGS_SHORTCUT, ctx.platform)})` : "");
  const explanation = settingsShortcut?.kind === "conflict"
    ? t("Settings shortcut unavailable: change the recording shortcut through the tray Settings entry.", language)
    : settingsShortcut?.kind === "failed" ? t("Settings shortcut unavailable: another app may use it. Open Settings from the tray.", language) : undefined;
  return [
    SEPARATOR,
    item(label, "openSettings"),
    ...(explanation ? [disabled(explanation)] : []),
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
      ? item(t("Change output folder", ctx.language), "changeOutputDir")
      : disabled(t("Change output folder", ctx.language)),
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
  const text = (key: PlainMessageKey): string => t(key, language);
  const unread = (ctx.recordingResults ?? []).filter(r => !r.acknowledged);
  const result = unread[0] ?? ctx.recordingResults?.[0];
  const resultText = unread.length ? t("Unreviewed recording failures: {value}", language, { value: String(unread.length) })
    : result ? t("Recent failure: {reason}", language, { reason: failureReason(result.code, language) }) : "";
  const resultMenu: TrayMenuItem[] = result ? [
    disabled(resultText), item(text("View recording failures…"), "openRecordingResult"), SEPARATOR,
  ] : [];
  const end = footer(ctx);
  const model = (icon: TrayIcon, title: string, status: string, menu: TrayMenuItem[]): TrayModel => ({
    icon: icon === "idle" && unread.length > 0 ? "warning" : icon,
    title,
    tooltip: `${APP_NAME}: ${status}${unread.length > 0 ? `\n${resultText}` : ""}\n${text("Right-click to open the menu")}`,
    menu: [...resultMenu, ...menu],
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
      const resolution = displayResolution(ctx.displays, ctx.display);
      const status = state.outputDirUnavailable ? text("Output folder unavailable")
        : !resolution.ok ? displayFailureText(resolution.detail, language)
        : ctx.display.kind === "display" ? t("Ready — {label}", language, { label: displayLabel(resolution, language) }) : text("Ready");
      const menu = [disabled(status)];
      if (ctx.displayFailure) menu.push(disabled(t("Last display failure: {reason}", language, { reason: displayFailureText(ctx.displayFailure, language) })));
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
/** Sent when the user turns the switch on, so the confirmation is also the test. */
export function notificationsEnabledNotification(language?: Language): NotificationText {
  return notice(t("Notifications are on. This is what a RecordStuff notification looks like.", language));
}
/**
 * First launch only. On macOS this is also the moment the app spends its one
 * chance at the notification authorization prompt: `Notification.show()` is
 * what raises it, and `UNUserNotificationCenter` only ever offers it while the
 * status is notDetermined. Launch is when the user is already granting this
 * app screen recording, so the ask is in context instead of arriving at the
 * end of their first recording (docs/system-design/desktop.md).
 */
export function trayHintNotification(platform: NodeJS.Platform, language?: Language): NotificationText {
  return notice(platform === "darwin"
    ? t("RecordStuff is ready in the menu bar. Click to start recording; click again to stop.", language)
    : t("RecordStuff is ready in the system tray. Click to start recording; click again to stop.", language));
}
