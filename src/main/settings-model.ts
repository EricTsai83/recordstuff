/**
 * The settings panel's model (docs/system-design/desktop.md): one declaration
 * of every preference the user can change, projected for the panel and used
 * again to authorize what the panel asks for.
 *
 * Group and choice ids are stable identifiers — never labels, never encoded
 * actions. The panel echoes an id back and `settingsAction` resolves it
 * against a freshly built model, so a request can only ever perform work the
 * app is offering at that moment. Everything except the language is locked
 * while a capture is running; index.ts re-checks the same rule before saving.
 */
import { translate as t, type Language, type MessageKey } from "../shared/i18n";
import {
  FRAME_RATES,
  RESOLUTION_CAPS,
  VIDEO_QUALITIES,
  isFrameRateAvailable,
  type ResolutionCap,
  type VideoQuality,
} from "../shared/quality";
import { HOTKEY_PRESETS, describeAccelerator } from "../shared/hotkey";
import type { SettingsGroup, SettingsView } from "../shared/settings-panel";
import type { RecordingState } from "../shared/state";

import { preferencesUnlocked, type AppAction, type AppContext } from "./ui-model";

/** A group as main knows it: exactly the wire shape plus the action per choice. */
interface Group extends SettingsGroup {
  choices: Array<SettingsGroup["choices"][number] & { action: AppAction }>;
}

const VIDEO_QUALITY_LABELS: Record<VideoQuality, MessageKey> = {
  economy: "Economy",
  standard: "Standard",
  high: "High",
};
const RESOLUTION_CAP_LABELS: Record<Exclude<ResolutionCap, "source">, string> = {
  "1080p": "1080p",
  "1440p": "1440p",
  "4k": "4K",
};

function group(
  id: string,
  label: string,
  enabled: boolean,
  choices: Group["choices"],
  note?: string,
): Group {
  return note === undefined ? { id, label, enabled, choices } : { id, label, note, enabled, choices };
}

function qualityGroups(ctx: AppContext, enabled: boolean): Group[] {
  const { videoQuality, resolutionCap, frameRate } = ctx.quality;
  const language = ctx.language;
  return [
    group("videoQuality", t("Video quality", language), enabled, VIDEO_QUALITIES.map((value) => ({
      id: value,
      label: t(VIDEO_QUALITY_LABELS[value], language),
      enabled: true,
      checked: value === videoQuality,
      action: { setQuality: { videoQuality: value } },
    }))),
    group("resolutionCap", t("Resolution cap", language), enabled, RESOLUTION_CAPS.map((value) => ({
      id: value,
      label: value === "source" ? t("Source", language) : RESOLUTION_CAP_LABELS[value],
      enabled: true,
      checked: value === resolutionCap,
      action: { setQuality: { resolutionCap: value } },
    }))),
    // A frame rate that is not verified on this platform stays visible and
    // says why, rather than silently disappearing from the list.
    group("frameRate", t("Frame rate", language), enabled, FRAME_RATES.map((value) => ({
      id: String(value),
      label: isFrameRateAvailable(value, ctx.platform)
        ? `${value} fps`
        : t("{value} fps (unverified on this platform)", language, { value }),
      enabled: isFrameRateAvailable(value, ctx.platform),
      checked: value === frameRate,
      action: { setQuality: { frameRate: value } },
    }))),
  ];
}

/**
 * One preset per choice plus Off (plan 016). A registration the OS refused is
 * never silent: the saved choice stays selected and the note says it is inert.
 */
function hotkeyGroup(ctx: AppContext, enabled: boolean): Group[] {
  const hotkey = ctx.hotkey;
  const language = ctx.language;
  const note = hotkey.enabled && !hotkey.registered
    ? t("Unavailable: another app is using this shortcut.", language)
    : undefined;
  return [group("hotkey", t("Shortcut", language), enabled, [
    ...HOTKEY_PRESETS.map((accelerator) => ({
      id: accelerator,
      label: describeAccelerator(accelerator, ctx.platform),
      enabled: true,
      checked: hotkey.enabled && accelerator === hotkey.accelerator,
      action: { setHotkey: { enabled: true, accelerator } } satisfies AppAction,
    })),
    {
      id: "off",
      label: t("Off", language),
      enabled: true,
      checked: !hotkey.enabled,
      // Keep the remembered accelerator so re-enabling restores the choice.
      action: { setHotkey: { enabled: false, accelerator: hotkey.accelerator } },
    },
  ], note)];
}

function updateChecksGroup(ctx: AppContext, enabled: boolean): Group[] {
  const updates = ctx.updates;
  const language = ctx.language;
  return [group("updateChecks", t("Check for updates on launch", language), enabled, [true, false].map((value) => ({
    id: value ? "on" : "off",
    label: t(value ? "On" : "Off", language),
    enabled: true,
    checked: value === updates.enabled,
    action: { setUpdateChecks: value },
  })))];
}

/** Language is presentation only: it never touches a running capture, so it is never locked. */
function languageGroup(language: Language): Group[] {
  return [group("language", t("Language", language), true, (["en", "zh-TW"] as const).map((value) => ({
    id: value,
    label: value === "en" ? "English" : "繁體中文",
    enabled: true,
    checked: value === language,
    action: { setLanguage: value },
  })))];
}

function settingsGroups(state: RecordingState, ctx: AppContext): Group[] {
  const unlocked = preferencesUnlocked(state);
  return [
    ...qualityGroups(ctx, unlocked),
    ...hotkeyGroup(ctx, unlocked),
    ...updateChecksGroup(ctx, unlocked),
    ...languageGroup(ctx.language),
  ];
}

/** Everything the panel renders. Actions stay in main; the panel only sees ids. */
export function settingsView(state: RecordingState, ctx: AppContext): SettingsView {
  const language = ctx.language;
  const unlocked = preferencesUnlocked(state);
  return {
    language,
    title: t("Settings", language),
    hint: t(
      unlocked ? "Changes are saved automatically." : "Recording in progress. Recording settings are locked.",
      language,
    ),
    failure: t("Could not apply this setting. Your current settings are shown.", language),
    groups: settingsGroups(state, ctx).map(({ choices, ...rest }) => ({
      ...rest,
      choices: choices.map(({ action: _action, ...choice }) => choice),
    })),
  };
}

/** The action for a choice that is offered and enabled right now, or nothing. */
export function settingsAction(
  state: RecordingState,
  ctx: AppContext,
  groupId: unknown,
  choiceId: unknown,
): AppAction | undefined {
  const choice = find(state, ctx, groupId, choiceId);
  return choice?.group.enabled && choice.enabled ? choice.action : undefined;
}

/** Whether a choice is the committed one; how main reports that a save took effect. */
export function settingsChecked(
  state: RecordingState,
  ctx: AppContext,
  groupId: unknown,
  choiceId: unknown,
): boolean {
  return find(state, ctx, groupId, choiceId)?.checked ?? false;
}

function find(
  state: RecordingState,
  ctx: AppContext,
  groupId: unknown,
  choiceId: unknown,
): (Group["choices"][number] & { group: Group }) | undefined {
  if (typeof groupId !== "string" || typeof choiceId !== "string") return undefined;
  const group = settingsGroups(state, ctx).find((candidate) => candidate.id === groupId);
  const choice = group?.choices.find((candidate) => candidate.id === choiceId);
  return group && choice ? { ...choice, group } : undefined;
}
