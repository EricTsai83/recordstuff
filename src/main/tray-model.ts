/**
 * Pure state-to-presentation projection for the native tray. See
 * docs/system-design/desktop.md.
 *
 * The tray holds only what is to be done now: the state with its primary action
 * (start, stop or cancel, and the fix when permission or the output folder blocks
 * recording), unread failures, Open RecordStuff and Quit. The recordings, reviewed
 * failures, the output folder, the log and every preference live in the app's
 * window ([settings-model.ts](settings-model.ts)); this model never builds a
 * submenu, so what it returns is exactly what the menu shows.
 */
import { failureReason } from "./recording-result";
import { displayLabel, displayFailureText } from "../shared/display";
import { displayResolution } from "./display-source";
import type { EarlyStop } from "../shared/session-record";
import type { TrayClick } from "../shared/appearance";
import type { QuitDeferral } from "./quit-feedback";
import path from "node:path";
import { DEFAULT_LANGUAGE, sentences, translate as t, type Language, type PlainMessageKey } from "../shared/i18n";
import type { FrameRate } from "../shared/quality";
import type { ErrorCode, RecordingState } from "../shared/state";
import { describeAccelerator, SETTINGS_SHORTCUT, type HotkeyAccelerator } from "../shared/hotkey";

import { APP_NAME, abbreviateHome, preferencesUnlocked, type AppAction, type AppContext } from "./ui-model";

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
/**
 * The app's window, reachable in every state, under the shortcut that opens it (2026-10-04: it holds the
 * recordings, so the menu opens RecordStuff rather than its settings). Reviewed failures, the output folder
 * and the log live there; the menu keeps only what is to be done now.
 */
function windowsGroup(ctx: AppContext): TrayMenuItem[] {
  const { language, settingsShortcut } = ctx;
  const explanation = settingsShortcut?.kind === "conflict"
    ? t("The shortcut for RecordStuff is the recording shortcut: open RecordStuff above to change it.", language)
    : settingsShortcut?.kind === "failed" ? t("The shortcut for RecordStuff is unavailable: another app may use it. Open RecordStuff above.", language) : undefined;
  return [
    item(t("Open RecordStuff", language), "openSettings", undefined, settingsShortcut?.kind === "registered" ? SETTINGS_SHORTCUT : undefined),
    ...(explanation ? [disabled(explanation)] : []),
  ];
}
const QUIT_DEFERRED = {
  media: "Quit or relaunch postponed: recording work is pending. Try again when it finishes.",
  metadata: "Quit or relaunch postponed: settings or the log are being written. Try again in a moment.",
} as const satisfies Record<QuitDeferral, PlainMessageKey>;
/** Windows keeps only the first 127 UTF-16 units of a notification-area tooltip (`NOTIFYICONDATA.szTip`) and drops the rest unmarked. */
const WINDOWS_TOOLTIP_MAX = 127;
/** Over that limit the cut is marked and the hint stays: the menu it points to repeats every line in full. */
function fitTooltip(platform: NodeJS.Platform, body: string, hint: string): string {
  const full = `${body}\n${hint}`;
  if (platform !== "win32" || full.length <= WINDOWS_TOOLTIP_MAX) return full;
  return `${body.slice(0, WINDOWS_TOOLTIP_MAX - hint.length - 2).trimEnd()}…\n${hint}`;
}
/** Quit alone ends the menu: Show log moved to RecordStuff → General (2026-10-04). */
function appGroup(language: Language): TrayMenuItem[] {
  return [item(t("Quit RecordStuff", language), "quit")];
}
function permissionActions(needsRelaunch: boolean, language: Language): TrayMenuItem[] {
  const hint = t(
    "If capture still fails after you allow access, relaunch RecordStuff.",
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
  const windows = windowsGroup(ctx);
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
  const menuOnClick = ctx.trayClick === "menu";
  const model = (icon: TrayIcon, title: string, status: string, stateGroup: TrayMenuItem[]): TrayModel => {
    const menu = grouped(withNotes(stateGroup), unreadGroup, windows, app);
    return {
      icon: icon === "idle" && unread.length > 0 ? "warning" : icon,
      title,
      tooltip: fitTooltip(ctx.platform, [`${APP_NAME}: ${status}`, ...notes, ...(unread.length > 0 ? [unreadText] : [])].join("\n"),
        text(menuOnClick ? "Click to open the menu" : "Right-click to open the menu")),
      // A quit in progress ignores every other action (the quit stops capture itself), so none looks available.
      menu: ctx.quitting ? menu.map(entry => entry.kind === "item" && entry.action !== "quit" ? { ...entry, enabled: false } : entry) : menu,
    };
  };
  // A settled recorder shows no work of its own, so a quit waiting on cleanup would look like nothing happened.
  if (ctx.quitting && preferencesUnlocked(state)) {
    const quitting = text("Quitting once the recording is saved or cleaned up…");
    return model("busy", "", quitting, [disabled(quitting)]);
  }
  switch (state.type) {
    case "needsPermission":
      return model("idle", "", text("Screen recording permission required"), [
        disabled(text("Screen recording permission required")),
        ...permissionActions(state.needsRelaunch, language),
      ]);
    case "idle": {
      const resolution = displayResolution(ctx.displays, ctx.display);
      const status = state.outputDirUnavailable ? text("Output folder unavailable")
        : !resolution.ok ? displayFailureText(resolution.detail, language)
        : ctx.display.kind === "display" ? t("Ready — {label}", language, { label: displayLabel(resolution, language) }) : text("Ready");
      const stateGroup = [disabled(status)];
      if (ctx.displayFailure) stateGroup.push(disabled(t("Last display failure: {reason}", language, { reason: displayFailureText(ctx.displayFailure, language) })));
      // Whenever a left click would start: the same toggle, countdown included (plan 048).
      stateGroup.push(item(text("Start recording"), "start", shortcutHint(ctx, "Start / stop recording with {value}"), shortcut));
      // The one folder item left: the fix, while the folder is what stops the next recording.
      if (state.outputDirUnavailable) stateGroup.push(item(text("Change output folder…"), "changeOutputDir", ctx.outputDir));
      return model("idle", "", status, stateGroup);
    }
    case "starting":
      // The shortcut cancels too once the start has lasted a second (plan 065), so it is named as in the countdown.
      return model("busy", "", text("Starting… Check for system permission prompts"), [
        disabled(text("Starting… Check for system permission prompts")),
        item(text("Cancel recording"), "cancelCountdown", shortcutHint(ctx, "Cancel recording with {value}"), shortcut),
      ]);
    case "countdown": {
      const seconds = { seconds: state.remaining };
      // A click that opens the menu cancels only through Cancel recording, which the menu shows.
      return model("countdown", "", t(menuOnClick ? "Recording starts in {seconds} s" : "Recording starts in {seconds} s. Click to cancel.", language, seconds), [
        disabled(t("Recording starts in {seconds} s", language, seconds)),
        item(text("Cancel recording"), "cancelCountdown", shortcutHint(ctx, "Cancel recording with {value}"), shortcut),
      ]);
    }
    case "recording":
      return model("recording", "REC", text("Recording"), [
        disabled(text("Recording")),
        item(text("Stop"), "stop", shortcutHint(ctx, "Start / stop recording with {value}"), shortcut),
      ]);
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
export function savedNotification(
  savedPath: string,
  platform: NodeJS.Platform,
  language?: Language,
  stoppedEarly?: EarlyStop,
): NotificationText {
  const file = path.basename(savedPath);
  if (stoppedEarly === "lowDisk") return notice(t("Saved {file}. Stopped early: the disk is almost full.", language, { file }));
  if (stoppedEarly === "sleep") {
    return notice(t(platform === "darwin" ? "Saved {file}. Stopped because the Mac went to sleep."
      : "Saved {file}. Stopped because the computer went to sleep.", language, { file }));
  }
  return notice(t("Saved {file}", language, { file }));
}
/** The reason, then how to reach the result section, joined per language (plan 035 D1). */
export function recordingFailureNotification(code: ErrorCode, language: Language = DEFAULT_LANGUAGE): NotificationText {
  return { title: t("Recording failed", language),
    body: sentences([failureReason(code, language), t("Click for details.", language)], language) };
}
export function permissionNotification(needsRelaunch: boolean, language?: Language): NotificationText {
  return notice(
    t(
      needsRelaunch
        ? "RecordStuff cannot capture the screen. Allow screen recording in System Settings, then click to relaunch."
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
    t("Could not change the output folder. Try choosing {path} again.", language, {
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
      "Could not register {value}; another app may be using it. Choose another shortcut in Settings.",
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
    t("The system cannot provide {requested} fps, so this recording uses {actual} fps.", language, {
      actual,
      requested,
    }),
  );
}
/** A launch check found a newer version; the click opens the download page (docs/system-design/desktop.md#update-checks). */
export function updateAvailableNotification(version: string, language?: Language): NotificationText {
  return notice(t("RecordStuff {version} is available. Click to open the download page.", language, { version }));
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
export function trayHintNotification(platform: NodeJS.Platform, language?: Language, trayClick: TrayClick = "record"): NotificationText {
  if (trayClick === "menu") return notice(platform === "darwin"
    ? t("RecordStuff is ready in the menu bar. Click its icon and choose Start recording.", language)
    : t("RecordStuff is ready in the system tray. Click its icon and choose Start recording.", language));
  return notice(platform === "darwin"
    ? t("RecordStuff is ready in the menu bar. Click to start recording; click again to stop.", language)
    : t("RecordStuff is ready in the system tray. Click to start recording; click again to stop.", language));
}
