import { failureReason, failureGuidance, failureOutcome, isOutputFolderFailure, isPermissionFailure } from "./recording-result";
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
 * app is offering at that moment. Recording preferences are locked
 * while a capture is running; language and appearance remain editable.
 * index.ts re-checks recording locks before saving.
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
import { DEFAULT_HOTKEY, describeAccelerator, canonicalizeAccelerator, isSettingsShortcut } from "../shared/hotkey";
import type { SettingsChoice, SettingsGroup, SettingsView } from "../shared/settings-panel";
import type { RecordingState } from "../shared/state";

import { preferencesUnlocked, type AppAction, type AppContext, type RecordingResultAction } from "./ui-model";

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
  return { id, label, enabled, choices, tab,
    control: ["notifications", "updateChecks"].includes(id) ? "switch" : ["videoQuality", "language"].includes(id) ? "segmented" : "menu",
    section: tab === "recording" ? "recording" : id === "updateChecks" ? "updates" : id,
    noteKind: "explanation", ...(note === undefined ? {} : { note }) };
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
    label: t("{label} — Unavailable", ctx.language, { label: displayLabel(preference, ctx.language) }), enabled: false, checked: true, action: { setDisplay: preference } });
  const result = group("screen", t("Screen", ctx.language), enabled, choices,
    t("Captures one whole screen. System audio is unaffected.", ctx.language));
  result.diagnostics = [];
  if (!resolution.ok) {
    result.diagnostics.push({ kind: "current", heading: t("Selected display is unavailable", ctx.language),
      reason: t("{label} is unavailable, so recording cannot start.", ctx.language, { label: preference.kind === "display" ? displayLabel(preference, ctx.language) : t("Primary display", ctx.language) }),
      guidance: t("Choose Primary display or another available screen.", ctx.language) });
    if (preference.kind === "display" && ctx.displays.some(d => d.primary && ctx.displays.filter(other => other.id === d.id).length === 1))
      result.recovery = { choice: "primary", label: t("Use Primary display", ctx.language) };
  }
  if (ctx.displayFailure) result.diagnostics.push({ kind: "history",
    heading: t(["target_removed", "track_ended"].includes(ctx.displayFailure) ? "Last recording interrupted" : "Last recording failure", ctx.language),
    reason: displayFailureText(ctx.displayFailure, ctx.language),
    guidance: t("Try recording again using the shortcut or menu, or choose another screen.", ctx.language) });
  return result;
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
 * One recommended shortcut, the current custom value, and Off. A registration the OS refused is
 * never silent: the saved choice stays selected and the note says it is inert.
 */
function hotkeyGroup(ctx: AppContext, enabled: boolean): Group[] {
  const hotkey = ctx.hotkey;
  const language = ctx.language;
  const note = hotkey.enabled && !hotkey.registered
    ? t("Unavailable: another app is using this shortcut.", language)
    : undefined;
  const recommended = DEFAULT_HOTKEY.accelerator;
  const accelerators = hotkey.accelerator === recommended ? [recommended] : [recommended, hotkey.accelerator];
  return [{ ...group("hotkey", t("Shortcut", language), enabled, [
    ...accelerators.map((accelerator) => ({
      id: accelerator,
      label: accelerator === recommended
        ? t("Recommended: {shortcut}", language, { shortcut: describeAccelerator(accelerator, ctx.platform) })
        : t("{shortcut} (custom)", language, { shortcut: describeAccelerator(accelerator, ctx.platform) }),
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
  ], undefined), kind: "shortcut", platform: ctx.platform, noteKind: "status",
    ...(note ? { diagnostics: [{ kind: "current" as const, heading: t("Shortcut unavailable", language), reason: note,
      guidance: t("Recording is still available from the menu. Choose another shortcut.", language) }] } : {}) }];
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
  return { ...group("updates", t("Updates", language), enabled, choices, note), kind: "actions", noteKind: "status" };
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
  // The switch controls OS notifications; in-app failure status stays available.
  const note = !ctx.notifications
    ? t("Notifications are off. Recording failures remain visible in the menu bar and Recording failures.", language)
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
  switchGroup.noteKind = ctx.notifications ? "explanation" : "status";
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
    ...notificationsGroup(ctx, unlocked),
    ...updateChecksGroup(ctx, unlocked),
    updateActions(ctx, unlocked),
    ...languageGroup(ctx.language),
    group("appearance", t("Appearance", ctx.language), true, (["system", "light", "dark"] as const).map(value => ({
      id: value, label: t(value === "system" ? "System default" : value === "light" ? "Light" : "Dark", ctx.language),
      enabled: true, checked: value === (ctx.appearance ?? "system"), action: { setAppearance: value },
    }))),
    { ...group("about", t("Built by Eric Tsai", ctx.language), true, [
      { id: "website", label: t("Official website", ctx.language), enabled: true, checked: false, action: "openWebsite" },
      { id: "source", label: t("GitHub source", ctx.language), enabled: true, checked: false, action: "openSource" },
    ]), kind: "actions" },
  ].map((entry): Group => ({ ...entry,
    ...(entry.id === "updateChecks" ? { sectionHeading: t("Updates", ctx.language) } : {}),
    ...(!unlocked && entry.id === "frameRate" ? { sectionFootnote: t("Recording in progress. Recording settings are locked.", ctx.language) } : {}),
  } as Group));
}

/** Everything the panel renders. Actions stay in main; the panel only sees ids. */
export function settingsView(state: RecordingState, ctx: AppContext): SettingsView {
  const language = ctx.language;
  const unlocked = preferencesUnlocked(state);
  return {
    language,
    recordingResults: (ctx.recordingResults ?? []).map(result => ({
      id: result.id, heading: t("Recording failure", language),
      reason: failureReason(result.code, language),
      time: new Date(result.occurredAt).toLocaleString(language),
      outcome: failureOutcome(result, language), guidance: ctx.platform === "darwin" && result.restored && isPermissionFailure(result.code)
        ? t("This is a previous recording failure. Check current recording permissions before trying again.", language)
        : failureGuidance(result.code, language, ctx.platform),
      persistenceWarning: result.persistenceFailed ? t("Could not save this reminder. It may change after restarting. Check available disk space.", language) : "",
      detail: result.detail, ...((result.partialPath ?? result.recordingPath) ? { file: result.partialPath ?? result.recordingPath } : {}),
      acknowledged: result.acknowledged, pending: result.outcome === "pending",
      actions: resultActions(state, ctx, result).map(({ action: _action, ...choice }) => choice),
    })),
    title: t("RecordStuff - Settings", language),
    hint: unlocked ? "" : t("Recording in progress. Recording settings are locked.", language),
    failure: t("Could not apply this setting. Your current settings are shown.", language),
    tabs: [{ id: "recording", label: t("Recording settings", language) }, { id: "general", label: t("General", language) }],
    groups: settingsGroups(state, ctx).map(({ choices, actions, ...rest }) => ({
      ...rest,
      choices: choices.map(({ action: _action, ...choice }) => choice),
      ...(actions === undefined ? {} : { actions: actions.map(({ action: _action, ...choice }) => choice) }),
    })),
  };
}

function resultActions(state: RecordingState, ctx: AppContext, result: NonNullable<AppContext["recordingResults"]>[number]): Array<SettingsChoice & { action: AppAction }> {
  const actions: Array<SettingsChoice & { action: AppAction }> = [];
  const add = (id: RecordingResultAction, label: MessageKey, enabled: boolean): void => {
    actions.push({ id, label: t(label, ctx.language), checked: false, enabled,
      action: { recordingResult: { id: result.id, action: id } } });
  };
  if (result.outcome === "partial" && result.partialPath) add("reveal", "Show partial recording", true);
  if (isOutputFolderFailure(result.code))
    add("folder", "Change output folder", preferencesUnlocked(state) && result.outcome !== "pending");
  if (ctx.platform === "darwin" && isPermissionFailure(result.code)) {
    add("permission", "Open System Settings", preferencesUnlocked(state));
    if (!result.restored || (state.type === "needsPermission" && state.needsRelaunch))
      add("relaunch", "Relaunch", preferencesUnlocked(state) && result.outcome !== "pending");
  }
  if (result.persistenceFailed) add("retry", "Retry saving reminder", true);
  if (!result.acknowledged) add("acknowledge", "Got it", result.outcome !== "pending");
  else add("remove", "Remove from history", true);
  return actions;
}

/** The action for a choice that is offered and enabled right now, or nothing. */
export function settingsAction(
  state: RecordingState,
  ctx: AppContext,
  groupId: unknown,
  choiceId: unknown,
): AppAction | undefined {
  if (typeof groupId === "string" && groupId.startsWith("recordingResult:")) {
    const result = ctx.recordingResults?.find(r => groupId === `recordingResult:${r.id}`);
    if (!result) return undefined;
    return resultActions(state, ctx, result).find(choice => choice.id === choiceId && choice.enabled)?.action;
  }
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
