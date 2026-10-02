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
import { failureReason } from "./recording-result";
import { displayLabel, displayFailureText } from "../shared/display";
import { displayResolution } from "./display-source";
import type { EarlyStop } from "../shared/session-record";
import type { QuitDeferral } from "./quit-feedback";
import path from "node:path";
import { DEFAULT_LANGUAGE, sentences, translate as t, type Language, type PlainMessageKey } from "../shared/i18n";
import type { FrameRate } from "../shared/quality";
import type { ErrorCode, RecordingState } from "../shared/state";
import { describeAccelerator, SETTINGS_SHORTCUT, type HotkeyAccelerator } from "../shared/hotkey";

import { APP_NAME, abbreviateHome, compactPath, preferencesUnlocked, type AppAction, type AppContext } from "./ui-model";

/**
 * One same-size template per state (plan 040): only `REC` changes the item
 * width. `busy` is starting or saving; `countdown` shows no title because the
 * corner of the recorded screen carries the digits.
 */
export type TrayIcon = "idle" | "busy" | "countdown" | "recording" | "warning";
export type TrayMenuItem =
  | { kind: "separator" }
  | {
      kind: "item"; label: string; enabled: boolean; action?: AppAction; toolTip?: string;
      /** A registered shortcut shown right-aligned in the native menu (plan 048); the menu never registers it. */
      accelerator?: string;
    };
export interface TrayModel {
  icon: TrayIcon;
  title: string;
  tooltip: string;
  menu: TrayMenuItem[];
}

function disabled(label: string): TrayMenuItem {
  return { kind: "item", label, enabled: false };
}
function item(label: string, action: AppAction, toolTip?: string, accelerator?: string): TrayMenuItem {
  return {
    kind: "item", label, enabled: true, action,
    ...(toolTip === undefined ? {} : { toolTip }),
    ...(accelerator === undefined ? {} : { accelerator }),
  };
}
const SEPARATOR: TrayMenuItem = { kind: "separator" };

/**
 * One group order for every state (plan 048): state and its primary action,
 * unread failures, files, windows, then the app. An empty group is omitted,
 * so no separator leads, trails or doubles and an item never changes places.
 */
function grouped(...groups: TrayMenuItem[][]): TrayMenuItem[] {
  return groups.filter((group) => group.length > 0).flatMap((group, index) => (index ? [SEPARATOR, ...group] : group));
}
/** The registered recording shortcut: the native menu's right-aligned column and the tooltips name only this one. */
function registeredShortcut(ctx: AppContext): HotkeyAccelerator | undefined {
  return ctx.hotkey.enabled && ctx.hotkey.registered ? ctx.hotkey.accelerator : undefined;
}
/** Settings stays reachable mid-recording; reviewed failures sit beside it, not at the top. */
function windowsGroup(ctx: AppContext, reviewedOnly: boolean): TrayMenuItem[] {
  const { language, settingsShortcut } = ctx;
  const explanation = settingsShortcut?.kind === "conflict"
    ? t("Settings shortcut unavailable: open Settings above to change the recording shortcut.", language)
    : settingsShortcut?.kind === "failed" ? t("Settings shortcut unavailable: another app may use it. Open Settings above.", language) : undefined;
  return [
    ...(reviewedOnly ? [item(t("View recording failures…", language), "openRecordingResult")] : []),
    item(t("Settings…", language), "openSettings", undefined, settingsShortcut?.kind === "registered" ? SETTINGS_SHORTCUT : undefined),
    ...(explanation ? [disabled(explanation)] : []),
  ];
}
const QUIT_DEFERRED = {
  media: "Quit or relaunch postponed: recording work is still pending. Retry the same action once it finishes.",
  metadata: "Quit or relaunch postponed: settings or the log are still being written. Retry the same action in a moment.",
} as const satisfies Record<QuitDeferral, PlainMessageKey>;
function appGroup(language: Language): TrayMenuItem[] {
  return [item(t("Show log", language), "revealLog"), item(t("Quit RecordStuff", language), "quit")];
}
function outputDirItems(ctx: AppContext, enabled: boolean): TrayMenuItem[] {
  const label = t("Output folder: {path}", ctx.language, { path: compactPath(abbreviateHome(ctx.outputDir, ctx.homeDir)) });
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
/** Tooltip naming the registered shortcut, if any: Start recording and Stop share one text, Cancel recording has its own. */
function shortcutHint(ctx: AppContext, key: "Start / stop recording with {value}" | "Cancel recording with {value}"): string | undefined {
  const accelerator = registeredShortcut(ctx);
  return accelerator ? t(key, ctx.language, { value: describeAccelerator(accelerator, ctx.platform) }) : undefined;
}
export function trayModel(state: RecordingState, ctx: AppContext): TrayModel {
  const language = ctx.language;
  const text = (key: PlainMessageKey): string => t(key, language);
  const results = ctx.recordingResults ?? [];
  const unread = results.filter(r => !r.acknowledged);
  const unreadText = t("Unreviewed recording failures: {value}", language, { value: String(unread.length) });
  // Unread failures get their own group after the state; reviewed ones only a way back, beside Settings.
  const unreadGroup: TrayMenuItem[] = unread.length ? [disabled(unreadText), item(text("View recording failures…"), "openRecordingResult")] : [];
  const windows = windowsGroup(ctx, unread.length === 0 && results.length > 0);
  const app = appGroup(language);
  const shortcut = registeredShortcut(ctx);
  // What a notification alone may not have told (plan 056): they sit with the state, in every state.
  const notes = [
    ...(ctx.errorBoxHeld ? [text("An unexpected error occurred. See the log for details.")] : []),
    ...(ctx.quitDeferred ? [text(QUIT_DEFERRED[ctx.quitDeferred])] : []),
  ];
  /** After the state's own lines and before its actions, so Stop and Start keep their places. */
  const withNotes = (group: TrayMenuItem[]): TrayMenuItem[] => {
    const lines = group.findIndex(entry => entry.kind === "item" && entry.enabled);
    const at = lines < 0 ? group.length : lines;
    return [...group.slice(0, at), ...notes.map(disabled), ...group.slice(at)];
  };
  const model = (icon: TrayIcon, title: string, status: string, stateGroup: TrayMenuItem[], files: TrayMenuItem[] = []): TrayModel => {
    const menu = grouped(withNotes(stateGroup), unreadGroup, files, windows, app);
    return {
      icon: icon === "idle" && unread.length > 0 ? "warning" : icon,
      title,
      tooltip: `${APP_NAME}: ${status}${notes.map(note => `\n${note}`).join("")}${unread.length > 0 ? `\n${unreadText}` : ""}\n${text("Right-click to open the menu")}`,
      // A quit in progress ignores every other action (the quit stops capture itself), so none looks available.
      menu: ctx.quitting ? menu.map(entry => entry.kind === "item" && entry.action !== "quit" ? { ...entry, enabled: false } : entry) : menu,
    };
  };
  // A settled recorder shows no work of its own, so a quit waiting on cleanup would look like nothing happened.
  if (ctx.quitting && preferencesUnlocked(state)) {
    const quitting = text("Quitting… RecordStuff quits once the recording is saved or cleaned up.");
    return model("busy", "", quitting, [disabled(quitting)]);
  }
  const lastSaved = (path: string | undefined): TrayMenuItem[] => (path ? [item(text("Show last recording"), "revealLastSaved", path)] : []);
  switch (state.type) {
    case "needsPermission":
      return model("idle", "", text("Screen recording permission required"), [
        disabled(text("Screen recording permission required")),
        ...permissionActions(state.needsRelaunch, language),
      ], [...lastSaved(state.lastSavedPath), ...outputDirItems(ctx, true)]);
    case "idle": {
      const resolution = displayResolution(ctx.displays, ctx.display);
      const status = state.outputDirUnavailable ? text("Output folder unavailable")
        : !resolution.ok ? displayFailureText(resolution.detail, language)
        : ctx.display.kind === "display" ? t("Ready — {label}", language, { label: displayLabel(resolution, language) }) : text("Ready");
      const stateGroup = [disabled(status)];
      if (ctx.displayFailure) stateGroup.push(disabled(t("Last display failure: {reason}", language, { reason: displayFailureText(ctx.displayFailure, language) })));
      // Whenever a left click would start: the same toggle, countdown included (plan 048).
      stateGroup.push(item(text("Start recording"), "start", shortcutHint(ctx, "Start / stop recording with {value}"), shortcut));
      return model("idle", "", status, stateGroup, [...lastSaved(state.lastSavedPath), ...outputDirItems(ctx, true)]);
    }
    case "starting":
      return model("busy", "", text("Starting… Check for system permission prompts"), [
        disabled(text("Starting… Check for system permission prompts")),
        item(text("Cancel recording"), "cancelCountdown"),
      ]);
    case "countdown": {
      const seconds = { seconds: state.remaining };
      return model("countdown", "", t("Recording starts in {seconds} s. Click to cancel.", language, seconds), [
        disabled(t("Recording starts in {seconds} s", language, seconds)),
        item(text("Cancel recording"), "cancelCountdown", shortcutHint(ctx, "Cancel recording with {value}"), shortcut),
      ]);
    }
    case "recording":
      return model("recording", "REC", text("Recording"), [
        disabled(text("Recording")),
        item(text("Stop"), "stop", shortcutHint(ctx, "Start / stop recording with {value}"), shortcut),
      ], outputDirItems(ctx, false));
    case "stopping":
      return model("busy", "", text("Saving…"), [disabled(text("Saving…"))]);
  }
}

/**
 * The menu as `tray: menu opened` logs it each time it pops up (plan 063):
 * what Electron is given, so a native acceptance runner can compare the NSMenu
 * it reads through Accessibility with the production model for the same state.
 */
export function menuLogText(menu: readonly TrayMenuItem[]): string {
  return JSON.stringify(menu.map(entry => entry.kind === "separator" ? { separator: true }
    : { label: entry.label, enabled: entry.enabled, ...(entry.accelerator === undefined ? {} : { accelerator: entry.accelerator }) }));
}

export interface NotificationText {
  title: string;
  body: string;
}
const notice = (body: string): NotificationText => ({ title: APP_NAME, body });
export function savedNotification(savedPath: string, language?: Language, stoppedEarly?: EarlyStop): NotificationText {
  const file = path.basename(savedPath);
  if (stoppedEarly === "lowDisk") return notice(t("Saved {file}. Recording stopped early because the disk is almost full.", language, { file }));
  if (stoppedEarly === "sleep") return notice(t("Saved {file}. Recording stopped because the Mac went to sleep.", language, { file }));
  return notice(t("Saved {file}", language, { file }));
}
/** The reason, then how to reach the result section, joined per language (plan 035 D1). */
export function recordingFailureNotification(code: ErrorCode, language: Language = DEFAULT_LANGUAGE): NotificationText {
  return { title: t("Recording failed", language),
    body: sentences([failureReason(code, language), t("Click to view the recording result.", language)], language) };
}
export function permissionNotification(needsRelaunch: boolean, language?: Language): NotificationText {
  return notice(
    t(
      needsRelaunch
        ? "RecordStuff cannot capture the screen. Check that screen recording is allowed in System Settings, then relaunch RecordStuff. Click to relaunch."
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
export function folderRefusedNotification(chosenDir: string, homeDir: string, language?: Language): NotificationText {
  return notice(t("A recording started, so the output folder is unchanged. Choose {path} again after it ends.", language, {
    path: abbreviateHome(chosenDir, homeDir),
  }));
}
export function displayWriteFailedNotification(language?: Language): NotificationText {
  return notice(t("Could not save the screen setting.", language));
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
