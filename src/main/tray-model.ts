/** Pure state-to-presentation projection. See docs/system-design/desktop.md. */
import path from "node:path";
import { DEFAULT_LANGUAGE, translate as t, type Language, type MessageKey } from "../shared/i18n";
import {
  FRAME_RATES,
  RESOLUTION_CAPS,
  VIDEO_QUALITIES,
  isFrameRateAvailable,
  type FrameRate,
  type QualitySettings,
  type ResolutionCap,
  type VideoQuality,
} from "../shared/quality";
import type { ErrorCode, RecordingState } from "../shared/state";
import { HOTKEY_PRESETS, describeAccelerator, type HotkeyAccelerator, type HotkeySettings } from "../shared/hotkey";

import type { UpdateState } from "./updates";

export type TrayIcon = "idle" | "recording";
export type TrayAction =
  | "openPermissionSettings"
  | "relaunch"
  | "stop"
  | "revealLastSaved"
  | "openOutputDir"
  | "changeOutputDir"
  | "revealLog"
  | "quit"
  | "checkUpdates"
  | "openUpdate"
  | { setUpdateChecks: boolean }
  | { setQuality: Partial<QualitySettings> }
  | { setLanguage: Language }
  | { setHotkey: HotkeySettings };
export type TrayMenuItem =
  | { kind: "separator" }
  | { kind: "item"; label: string; enabled: boolean; action?: TrayAction; toolTip?: string }
  | { kind: "radio"; label: string; enabled: boolean; checked: boolean; action: TrayAction }
  | { kind: "submenu"; label: string; enabled: boolean; items: TrayMenuItem[] };
export interface TrayModel {
  icon: TrayIcon;
  title: string;
  tooltip: string;
  menu: TrayMenuItem[];
}
export interface TrayContext {
  platform: NodeJS.Platform;
  outputDir: string;
  homeDir: string;
  quality: QualitySettings;
  /** Omitted by older callers: English is always the default. */
  language?: Language;
  /** Omitted by older callers: the menu then shows no shortcut entry. */
  hotkey?: TrayHotkey;
  updates?: { state: UpdateState; enabled: boolean };
}
/** The persisted choice plus whether the OS actually accepted the registration. */
export interface TrayHotkey extends HotkeySettings {
  registered: boolean;
}
export const VIDEO_QUALITY_LABELS: Record<VideoQuality, MessageKey> = {
  economy: "Economy",
  standard: "Standard",
  high: "High",
};
export const RESOLUTION_CAP_LABELS: Record<ResolutionCap, string> = {
  "1080p": "1080p",
  "1440p": "1440p",
  "4k": "4K",
  source: "Source",
};
export const APP_NAME = "RecordStuff";

export function abbreviateHome(filePath: string, homeDir: string): string {
  const home = homeDir.replace(/[\\/]+$/, "");
  if (home.length === 0) return filePath;
  if (filePath === home) return "~";
  const sep = filePath.startsWith(home + "/") ? "/" : filePath.startsWith(home + "\\") ? "\\" : "";
  return sep ? `~${sep}${filePath.slice(home.length + 1)}` : filePath;
}
function disabled(label: string): TrayMenuItem {
  return { kind: "item", label, enabled: false };
}
function item(label: string, action: TrayAction, toolTip?: string): TrayMenuItem {
  return toolTip === undefined
    ? { kind: "item", label, enabled: true, action }
    : { kind: "item", label, enabled: true, action, toolTip };
}
const SEPARATOR: TrayMenuItem = { kind: "separator" };
function footer(language: Language): TrayMenuItem[] {
  return [
    SEPARATOR,
    {
      kind: "submenu",
      label: t("Language", language),
      enabled: true,
      items: (["en", "zh-TW"] as const).map((value) => ({
        kind: "radio",
        label: value === "en" ? "English" : "繁體中文",
        enabled: true,
        checked: value === language,
        action: { setLanguage: value },
      })),
    },
    item(t("Show log", language), "revealLog"),
    item(t("Quit", language), "quit"),
  ];
}
function outputDirItems(ctx: TrayContext, enabled: boolean): TrayMenuItem[] {
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
function radioGroup<K extends keyof QualitySettings>(
  key: K,
  current: QualitySettings[K],
  choices: readonly QualitySettings[K][],
  label: (choice: QualitySettings[K]) => string,
  available: (choice: QualitySettings[K]) => boolean = () => true,
): TrayMenuItem[] {
  return choices.map((choice) => ({
    kind: "radio",
    label: label(choice),
    enabled: available(choice),
    checked: choice === current,
    action: { setQuality: { [key]: choice } as Partial<QualitySettings> },
  }));
}
function qualityMenu(ctx: TrayContext): TrayMenuItem {
  const q = ctx.quality;
  const language = ctx.language;
  return {
    kind: "submenu",
    label: t("Recording quality", language),
    enabled: true,
    items: [
      {
        kind: "submenu",
        label: t("Video quality: {value}", language, { value: t(VIDEO_QUALITY_LABELS[q.videoQuality], language) }),
        enabled: true,
        items: radioGroup("videoQuality", q.videoQuality, VIDEO_QUALITIES, (v) =>
          t(VIDEO_QUALITY_LABELS[v], language),
        ),
      },
      {
        kind: "submenu",
        label: t("Resolution cap: {value}", language, {
          value: q.resolutionCap === "source" ? t("Source", language) : RESOLUTION_CAP_LABELS[q.resolutionCap],
        }),
        enabled: true,
        items: radioGroup("resolutionCap", q.resolutionCap, RESOLUTION_CAPS, (v) =>
          v === "source" ? t("Source", language) : RESOLUTION_CAP_LABELS[v],
        ),
      },
      {
        kind: "submenu",
        label: t("Frame rate: {value} fps", language, { value: q.frameRate }),
        enabled: true,
        items: radioGroup(
          "frameRate",
          q.frameRate,
          FRAME_RATES,
          (fps) =>
            isFrameRateAvailable(fps, ctx.platform)
              ? `${fps} fps`
              : t("{value} fps (unverified on this platform)", language, { value: fps }),
          (fps) => isFrameRateAvailable(fps, ctx.platform),
        ),
      },
    ],
  };
}
/**
 * "Shortcut: ⌘⌥⇧R" with a radio per preset and Off. A registration the OS
 * refused is spelled out in the label so a conflict is never silent
 * (plan 016). `enabled` follows the quality menu: idle/needsPermission only.
 * Off shares the presets' radio group without a separator: Electron splits
 * radio groups at separators and forces one checked item per group, so a
 * separated Off would show checked next to an active preset (review F1).
 */
function hotkeyMenu(ctx: TrayContext, enabled: boolean): TrayMenuItem[] {
  const hotkey = ctx.hotkey;
  if (!hotkey) return [];
  const language = ctx.language;
  const shown = describeAccelerator(hotkey.accelerator, ctx.platform);
  const label = !hotkey.enabled
    ? t("Shortcut: off", language)
    : hotkey.registered
      ? t("Shortcut: {value}", language, { value: shown })
      : t("Shortcut unavailable (in use by another app): {value}", language, { value: shown });
  const preset = (accelerator: HotkeyAccelerator): TrayMenuItem => ({
    kind: "radio",
    label: describeAccelerator(accelerator, ctx.platform),
    enabled: true,
    checked: hotkey.enabled && accelerator === hotkey.accelerator,
    action: { setHotkey: { enabled: true, accelerator } },
  });
  return [
    {
      kind: "submenu",
      label,
      enabled,
      items: [
        ...HOTKEY_PRESETS.map(preset),
        {
          kind: "radio",
          label: t("Off", language),
          enabled: true,
          checked: !hotkey.enabled,
          action: { setHotkey: { enabled: false, accelerator: hotkey.accelerator } },
        },
      ],
    },
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
function stopHint(ctx: TrayContext): string | undefined {
  const hotkey = ctx.hotkey;
  if (!hotkey || !hotkey.enabled || !hotkey.registered) return undefined;
  return t("Start / stop recording with {value}", ctx.language, {
    value: describeAccelerator(hotkey.accelerator, ctx.platform),
  });
}
export function trayModel(state: RecordingState, ctx: TrayContext): TrayModel {
  const language = ctx.language ?? DEFAULT_LANGUAGE;
  const text = (key: MessageKey): string => t(key, language);
  const safe = state.type === "idle" || state.type === "needsPermission";
  const u = ctx.updates;
  const updateItems: TrayMenuItem[] = [];
  if (u) {
    const status = u.state;
    const label = !safe ? text("Check for updates…") : status.kind === "checking" ? text("Checking for updates…")
      : status.kind === "available" ? t("Update available: {version}", language, { version: status.version })
      : status.kind === "current" ? t("Up to date (checked {time})", language, { time: new Date(status.checkedAt).toLocaleString(language) })
      : status.kind === "failed" ? text("Update check failed — open releases") : text("Check for updates…");
    updateItems.push({ kind: "item", label, enabled: safe && status.kind !== "checking", action: status.kind === "available" || status.kind === "failed" ? "openUpdate" : "checkUpdates" });
    if (status.kind === "available" || status.kind === "failed") updateItems.push({ kind: "item", label: text("Check for updates…"), enabled: safe, action: "checkUpdates" });
    updateItems.push({ kind: "submenu", label: text("Check for updates on launch"), enabled: safe, items: [true, false].map((enabled) => ({ kind: "radio", label: text(enabled ? "On" : "Off"), enabled: true, checked: enabled === u.enabled, action: { setUpdateChecks: enabled } })) });
  }
  const end = [...updateItems, ...footer(language)];
  const locked = disabled(text("Recording quality"));
  const model = (icon: TrayIcon, title: string, status: string, menu: TrayMenuItem[]): TrayModel => ({
    icon,
    title,
    tooltip: `${APP_NAME}: ${status}`,
    menu,
  });
  switch (state.type) {
    case "needsPermission":
      return model("idle", "", text("Screen recording permission required"), [
        disabled(text("Screen recording permission required")),
        ...permissionActions(state.needsRelaunch, language),
        SEPARATOR,
        ...outputDirItems(ctx, true),
        qualityMenu(ctx),
        ...hotkeyMenu(ctx, true),
        ...end,
      ]);
    case "idle": {
      const status = text(state.outputDirUnavailable ? "Output folder unavailable" : "Ready");
      const menu = [disabled(status)];
      if (state.lastSavedPath) menu.push(item(text("Show last recording"), "revealLastSaved", state.lastSavedPath));
      return model("idle", "", status, [
        ...menu,
        SEPARATOR,
        ...outputDirItems(ctx, true),
        qualityMenu(ctx),
        ...hotkeyMenu(ctx, true),
        ...end,
      ]);
    }
    case "starting":
      return model("idle", "…", text("Starting… Check for system permission prompts"), [
        disabled(text("Starting… Check for system permission prompts")),
        SEPARATOR,
        locked,
        ...hotkeyMenu(ctx, false),
        ...end,
      ]);
    case "recording":
      return model("recording", "REC", text("Recording"), [
        disabled(text("Recording")),
        item(text("Stop"), "stop", stopHint(ctx)),
        SEPARATOR,
        ...outputDirItems(ctx, false),
        locked,
        ...hotkeyMenu(ctx, false),
        ...end,
      ]);
    case "stopping":
      return model("idle", "…", text("Saving…"), [
        disabled(text("Saving…")),
        SEPARATOR,
        locked,
        ...hotkeyMenu(ctx, false),
        ...end,
      ]);
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
      "Could not register the shortcut {value}. Another app may be using it. Choose another shortcut from the tray menu.",
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
  ctx: Pick<TrayContext, "homeDir" | "outputDir" | "language">,
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
