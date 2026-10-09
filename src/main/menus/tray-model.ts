/**
 * Pure state-to-presentation projection for the native tray. See
 * docs/system-design/desktop.md.
 *
 * The tray holds only what is to be done now: the state's primary action (start, stop or cancel,
 * and the fix when permission, the output folder or an unavailable display blocks recording),
 * Open RecordStuff with Show last recording (the window on Recordings, the newest take focused),
 * the status lines with unread failures, and Quit. The recordings, reviewed failures, the output
 * folder, the log and every preference live in the app's window ([settings-model.ts](../settings/settings-model.ts)); this model never builds a
 * submenu, so what it returns is exactly what the menu shows.
 */
import { failureReason } from "../recording/recording-result";
import { displayLabel, displayFailureText } from "../../shared/display";
import { displayResolution, primaryDisplayChoosable } from "../display/display-source";
import type { EarlyStop } from "../../shared/session-record";
import type { TrayClick } from "../../shared/appearance";
import type { QuitDeferral } from "../app/quit-feedback";
import path from "node:path";
import { DEFAULT_LANGUAGE, sentences, translate as t, type Language, type PlainMessageKey } from "../../shared/i18n";
import type { FrameRate } from "../../shared/quality";
import type { ErrorCode, RecordingState } from "../../shared/state";
import { describeAccelerator, settingsShortcut as openShortcut, type HotkeyAccelerator } from "../../shared/hotkey";

import { QUITTING_TEXT, abbreviateHome, type AppAction, type AppContext } from "../app/ui-model";
import { APP_NAME } from "../lib/app-name";
import { preferencesUnlocked } from "../recording/recording-lock";

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
 * One group order for every state (plan 048): the state's actions, the window, the status
 * lines with unread failures, then the app. Actions lead so Start recording is the first item
 * and the status never pushes it or the window down (2026-10-09). An empty group is omitted,
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
    item(t("Open RecordStuff", language), "openSettings", undefined, settingsShortcut?.kind === "registered" ? openShortcut(ctx.platform) : undefined),
    // The window itself, on Recordings with the newest take focused: never the folder.
    item(t("Show last recording", language), "showLastRecording"),
    ...(explanation ? [disabled(explanation)] : []),
  ];
}
const QUIT_DEFERRED = {
  media: "Quit or relaunch postponed: recording work is pending. Try again when it finishes.",
  metadata: "Quit or relaunch postponed: settings or the log are being written. Try again in a moment.",
} as const satisfies Record<QuitDeferral, PlainMessageKey>;
/** Windows keeps only the first 127 UTF-16 units of a notification-area tooltip (`NOTIFYICONDATA.szTip`) and drops the rest unmarked. */
const WINDOWS_TOOLTIP_MAX = 127;
/** Over that limit the cut is marked: the menu repeats every line in full. */
function fitTooltip(platform: NodeJS.Platform, text: string): string {
  if (platform !== "win32" || text.length <= WINDOWS_TOOLTIP_MAX) return text;
  return `${text.slice(0, WINDOWS_TOOLTIP_MAX - 1).trimEnd()}…`;
}
/**
 * Quit alone ends the menu: Show log moved to RecordStuff → General (2026-10-04). While a quit waits only for saves in
 * the background, the way out without them stands beside it (2026-10-09).
 */
function appGroup(ctx: AppContext): TrayMenuItem[] {
  const language = ctx.language;
  return [
    ...(ctx.quitWithoutWaiting ? [item(t("Quit Without Waiting for the Save", language), "quitWithoutWaiting",
      t("The recording is kept as it is and reported when RecordStuff opens again.", language))] : []),
    item(t("Quit RecordStuff", language), "quit"),
  ];
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
  return trayParts(state, ctx).model;
}
/** The model with the state's actions and first status line, which `recordMenu` takes on their own. */
function trayParts(state: RecordingState, ctx: AppContext): { model: TrayModel; actions: TrayMenuItem[]; line?: TrayMenuItem } {
  const language = ctx.language;
  const text = (key: PlainMessageKey): string => t(key, language);
  const results = ctx.recordingResults ?? [];
  const unread = results.filter(r => !r.acknowledged);
  const unreadText = t("Unreviewed recording failures: {value}", language, { value: String(unread.length) });
  // Unread failures close the status group; reviewed ones live in the window's Failures tab.
  const unreadGroup: TrayMenuItem[] = unread.length ? [disabled(unreadText), item(text("View recording failures…"), "openRecordingResult")] : [];
  const windows = windowsGroup(ctx);
  const app = appGroup(ctx);
  const shortcut = registeredShortcut(ctx);
  // What a notification alone may not have told (plan 056): they sit with the state, in every state.
  const notes = [
    ...(ctx.errorBoxHeld ? [text("An unexpected error occurred. See the log for details.")] : []),
    ...(ctx.quitDeferred ? [text(QUIT_DEFERRED[ctx.quitDeferred])] : []),
    // Saves go on in the background whatever the state, a new recording's included (2026-10-09).
    ...(ctx.saving ?? []).map(({ file, slow }) => t(slow ? "Still saving {file}. The drive may not be responding." : "Saving {file}…", language, { file })),
  ];
  // A quit in progress ignores every other action (the quit stops capture itself), so none looks available.
  const settled = (entries: TrayMenuItem[]): TrayMenuItem[] => ctx.quitting
    ? entries.map(entry => entry.kind === "item" && entry.action !== "quit" && entry.action !== "quitWithoutWaiting" ? { ...entry, enabled: false } : entry)
    : entries;
  /**
   * `lines` are the state's own status lines, shown under the window with the notes after them (2026-10-09).
   * `lead` puts them above the actions instead, which only the permission line needs: its steps mean nothing
   * without it, and nothing can be recorded.
   */
  const model = (icon: TrayIcon, title: string, status: string, actions: TrayMenuItem[], lines: string[] = [], lead = false) => {
    const leading = lead ? lines.map(disabled) : [];
    const statusGroup = [...(lead ? [] : lines), ...notes].map(disabled);
    return {
      model: {
        icon: icon === "idle" && unread.length > 0 ? "warning" : icon,
        title,
        // The state and what it holds back, nothing about clicking: what a click does is the user's choice (2026-10-04).
        tooltip: fitTooltip(ctx.platform, [`${APP_NAME}: ${status}`, ...notes, ...(unread.length > 0 ? [unreadText] : [])].join("\n")),
        menu: settled(grouped([...leading, ...actions], windows, [...statusGroup, ...unreadGroup], app)),
      },
      actions: settled(actions),
      ...(lines[0] === undefined ? {} : { line: disabled(lines[0]) }),
    };
  };
  // A settled recorder shows no work of its own, so a quit waiting on cleanup would look like nothing happened.
  if (ctx.quitting && preferencesUnlocked(state)) {
    const quitting = text(QUITTING_TEXT[ctx.quitStep ?? "media"]);
    return model("busy", "", quitting, [], [quitting]);
  }
  switch (state.type) {
    case "needsPermission":
      return model("idle", "", text("Screen recording permission required"), permissionActions(state.needsRelaunch, language),
        [text("Screen recording permission required")], true);
    case "idle": {
      const resolution = displayResolution(ctx.displays, ctx.display);
      const status = state.outputDirUnavailable ? text("Output folder unavailable")
        : !resolution.ok ? displayFailureText(resolution.detail, language)
        : ctx.display.kind === "display" ? t("Ready — {label}", language, { label: displayLabel(resolution, language) }) : text("Ready");
      // A plain "Ready" says no more than Start recording below, so the line shows only when it says more:
      // the chosen display, or what stops the next recording (2026-10-05). The tooltip keeps the status.
      const plain = !state.outputDirUnavailable && resolution.ok && ctx.display.kind !== "display";
      const lines = plain ? [] : [status];
      if (ctx.displayFailure) lines.push(t("Last display failure: {reason}", language, { reason: displayFailureText(ctx.displayFailure, language) }));
      // Whenever a left click would start: the same toggle, countdown included (plan 048).
      const actions = [item(text("Start recording"), "start", shortcutHint(ctx, "Start / stop recording with {value}"), shortcut)];
      // The one folder item left: the fix, while the folder is what stops the next recording.
      if (state.outputDirUnavailable) actions.push(item(text("Change output folder…"), "changeOutputDir", ctx.outputDir));
      // Likewise the way back from a chosen display that is gone, as Settings offers it.
      else if (!resolution.ok && primaryDisplayChoosable(ctx.displays)) actions.push(item(text("Use Primary display"), { setDisplay: { kind: "primary" } }));
      return model("idle", "", status, actions, lines);
    }
    case "starting":
      // The shortcut cancels too once the start has lasted a second (plan 065), so it is named as in the countdown.
      return model("busy", "", text("Starting… Check for system permission prompts"), [
        item(text("Cancel recording"), "cancelCountdown", shortcutHint(ctx, "Cancel recording with {value}"), shortcut),
      ], [text("Starting… Check for system permission prompts")]);
    case "countdown": {
      const seconds = { seconds: state.remaining };
      // No status line: an open menu keeps its items, so its seconds would go stale, and the
      // stopwatch and Cancel recording already say it (2026-10-05).
      return model("countdown", "", t("Recording starts in {seconds} s", language, seconds), [
        item(text("Cancel recording"), "cancelCountdown", shortcutHint(ctx, "Cancel recording with {value}"), shortcut),
      ]);
    }
    case "recording":
      // `REC` beside the icon and Stop say it; the line is gone (2026-10-05).
      return model("recording", "REC", text("Recording"), [
        item(text("Stop"), "stop", shortcutHint(ctx, "Start / stop recording with {value}"), shortcut),
      ]);
    case "stopping":
      return model("busy", "", text("Saving…"), [], [text("Saving…")]);
  }
}

/**
 * The Record menu in the macOS menu bar, and the Dock icon's menu, while the window is open (2026-10-04, at the
 * maintainer's request): the tray's state actions, Stop named in full since no state line stands above it, then
 * the newest take. The state lines stay in the tray: a countdown rewrites its line every second, which would
 * rebuild a menu the user may have open. A state with no action, saving or a quit in progress, keeps its line.
 */
export function recordMenu(state: RecordingState, ctx: AppContext): TrayMenuItem[] {
  const { model, actions: stateActions, line } = trayParts(state, ctx);
  const actions = stateActions.map(entry => entry.kind === "item" && entry.action === "stop" ? { ...entry, label: t("Stop recording", ctx.language) } : entry);
  const last = model.menu.find(entry => entry.kind === "item" && entry.action === "showLastRecording");
  return [...(actions.length ? actions : line ? [line] : []), ...(last ? [SEPARATOR, last] : [])];
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
      "Could not register {value}; another app may be using it. Open RecordStuff to choose another shortcut.",
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
