import { displayLabel, displayFailureText } from "../shared/display";
import { displayResolution } from "./display-source";
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
import { HOTKEY_PRESETS, describeAccelerator, canonicalizeAccelerator, isSettingsShortcut } from "../shared/hotkey";
import type { SettingsChoice, SettingsGroup, SettingsView } from "../shared/settings-panel";
import type { RecordingState } from "../shared/state";

import { preferencesUnlocked, type AppAction, type AppContext } from "./ui-model";

/** A group as main knows it: exactly the wire shape plus the action per choice. */
interface Group extends SettingsGroup {
  choices: Array<SettingsGroup["choices"][number] & { action: AppAction }>;
  actions?: Array<SettingsChoice & { action: AppAction }>;
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
  const tab = ["screen", "videoQuality", "resolutionCap", "frameRate"].includes(id) ? "recording" : "general";
  return { id, label, enabled, choices, tab, ...(note === undefined ? {} : { note }) };
}

function screenGroup(ctx: AppContext, enabled: boolean): Group {
  const preference = ctx.display;
  const resolution = displayResolution(ctx.displays, preference);
  const choices: Group["choices"] = [{ id: "primary", label: t("Primary display", ctx.language), enabled: true,
    checked: preference.kind === "primary", action: { setDisplay: { kind: "primary" } } }];
  for (const display of ctx.displays) {
    if (ctx.displays.filter((d) => d.id === display.id).length !== 1) continue;
    choices.push({ id: display.id, label: displayLabel(display, ctx.language), enabled: true,
      checked: preference.kind === "display" && preference.id === display.id,
      action: { setDisplay: { kind: "display", id: display.id, label: display.label } } });
  }
  if (preference.kind === "display" && !resolution.ok) choices.push({ id: preference.id,
    label: displayLabel(preference, ctx.language), enabled: false, checked: true, action: { setDisplay: preference } });
  const notes = [t("Captures one whole screen. System audio is unaffected.", ctx.language)];
  if (!resolution.ok) notes.push(displayFailureText(resolution.detail, ctx.language));
  if (ctx.displayFailure) notes.push(t("Last display failure: {reason}", ctx.language, { reason: displayFailureText(ctx.displayFailure, ctx.language) }));
  return group("screen", t("Screen", ctx.language), enabled, choices, notes.join(" "));
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
    })), t("Higher quality preserves more detail and uses more space at the same resolution.", language)),
    group("resolutionCap", t("Resolution cap", language), enabled, RESOLUTION_CAPS.map((value) => ({
      id: value,
      label: value === "source" ? t("Source", language) : RESOLUTION_CAP_LABELS[value],
      enabled: true,
      checked: value === resolutionCap,
      action: { setQuality: { resolutionCap: value } },
    })), t("Limits pixel dimensions while keeping the aspect ratio. Smaller sources are not enlarged.", language)),
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
  const accelerators: readonly string[] = HOTKEY_PRESETS.includes(hotkey.accelerator as typeof HOTKEY_PRESETS[number])
    ? HOTKEY_PRESETS : [...HOTKEY_PRESETS, hotkey.accelerator];
  return [{ ...group("hotkey", t("Shortcut", language), enabled, [
    ...accelerators.map((accelerator) => ({
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
  ], note), kind: "shortcut", platform: ctx.platform }];
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

function updateActions(ctx: AppContext, enabled: boolean): Group {
  const { state } = ctx.updates;
  const result = state.kind === "checking" ? state.previous : state;
  const language = ctx.language;
  const choices: Group["choices"] = [{
    id: "check", label: t(state.kind === "checking" ? "Checking for updates…" : "Check for updates…", language),
    enabled: state.kind !== "checking", checked: false, action: "checkUpdates",
  }];
  if (result?.kind === "available" || result?.kind === "failed") choices.push({
    id: "open", label: result.kind === "available"
      ? t("Update available: {version}", language, { version: result.version })
      : t("Update check failed — open releases", language),
    enabled: state.kind !== "checking", checked: false, action: "openUpdate",
  });
  const note = result?.kind === "current"
    ? t("Up to date (checked {time})", language, { time: new Date(result.checkedAt).toLocaleString(language) })
    : undefined;
  return { ...group("updates", t("Updates", language), enabled, choices, note), kind: "actions" };
}

/**
 * One switch for every notification the app sends, after Cap's design
 * (CapSoftware/Cap, apps/desktop/src-tauri/src/notifications.rs): the send
 * path checks one boolean and nothing else. Cap can also gate its switch on
 * the OS permission because Tauri exposes `isPermissionGranted`; Electron has
 * no equivalent — `getMediaAccessStatus` accepts microphone, camera and
 * screen only — so the app never claims to know the OS state. The note
 * carries the recovery path instead of a status line that could be wrong.
 */
function notificationsGroup(ctx: AppContext, enabled: boolean): Group[] {
  const language = ctx.language;
  const what = t("Shows a notification when a recording is saved or an error occurs.", language);
  // Off is obeyed, not compensated for. Six error codes reach the user only as
  // a notification (the rest leave a tray state or never start the capture), so
  // the cost and the place to look instead are stated where the choice is made.
  const note = !ctx.notifications
    ? t("Notifications are off. An interrupted or unsaved recording will not tell you; check the output folder to confirm a recording was saved.", language)
    : ctx.platform === "darwin"
      ? `${what} ${t("macOS must also allow RecordStuff in System Settings → Notifications.", language)}`
      : what;
  const switchGroup = group("notifications", t("Notifications", language), enabled, [true, false].map((value) => ({
    id: value ? "on" : "off",
    label: t(value ? "On" : "Off", language),
    enabled: true,
    checked: value === ctx.notifications,
    action: { setNotifications: value },
  })), note);
  // Only macOS hides notifications behind a pane worth linking to. It sits in
  // this card so the switch and the permission that can override it read as
  // one decision rather than two unrelated settings.
  if (ctx.platform !== "darwin") return [switchGroup];
  return [{ ...switchGroup, actions: [{
    id: "openSettings",
    label: t("Open notification settings…", language),
    enabled: true,
    checked: false,
    action: "openNotificationSettings" satisfies AppAction,
  }] }];
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
    screenGroup(ctx, unlocked),
    ...qualityGroups(ctx, unlocked),
    ...hotkeyGroup(ctx, unlocked),
    ...updateChecksGroup(ctx, unlocked),
    updateActions(ctx, unlocked),
    ...notificationsGroup(ctx, unlocked),
    ...languageGroup(ctx.language),
    group("appearance", t("Appearance", ctx.language), true, (["system", "light", "dark"] as const).map(value => ({
      id: value, label: t(value === "system" ? "System default" : value === "light" ? "Light" : "Dark", ctx.language),
      enabled: true, checked: value === (ctx.appearance ?? "system"), action: { setAppearance: value },
    }))),
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
    tabs: [{ id: "recording", label: t("Recording settings", language) }, { id: "general", label: t("General", language) }],
    groups: settingsGroups(state, ctx).map(({ choices, actions, ...rest }) => ({
      ...rest,
      choices: choices.map(({ action: _action, ...choice }) => choice),
      ...(actions === undefined ? {} : { actions: actions.map(({ action: _action, ...choice }) => choice) }),
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
  if (groupId === "hotkey" && choiceId !== "off" && preferencesUnlocked(state)) {
    const accelerator = canonicalizeAccelerator(choiceId);
    return accelerator && !isSettingsShortcut(accelerator, ctx.platform) ? { setHotkey: { enabled: true, accelerator } } : undefined;
  }
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
  if (groupId === "hotkey" && choiceId !== "off") return ctx.hotkey.enabled && canonicalizeAccelerator(choiceId) === ctx.hotkey.accelerator;
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
  const choice = [...(group?.choices ?? []), ...(group?.actions ?? [])].find((candidate) => candidate.id === choiceId);
  return group && choice ? { ...choice, group } : undefined;
}
