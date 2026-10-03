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
import { failureReason, failureGuidance, failureOutcome, isOutputFolderFailure, isPermissionFailure, persistenceWarning } from "./recording-result";
import { displayLabel, displayFailureText } from "../shared/display";
import { displayResolution } from "./display-source";
import { translate as t, type Language, type PlainMessageKey } from "../shared/i18n";
import {
  FRAME_RATES,
  RESOLUTION_CAPS,
  VIDEO_QUALITIES,
  isFrameRateAvailable,
  type ResolutionCap,
  type VideoQuality,
} from "../shared/quality";
import { DEFAULT_HOTKEY, SETTINGS_SHORTCUT, describeAccelerator, canonicalizeAccelerator, isSettingsShortcut, sameShortcut } from "../shared/hotkey";
import { COUNTDOWN_CHOICES } from "../shared/countdown";
import type { RecordingResultView, SettingsChoice, SettingsGroup, SettingsView } from "../shared/settings-panel";
import type { RecordingResult, RecordingResultAction } from "../shared/recording-result";
import type { RecordingState } from "../shared/state";

import path from "node:path";
import { abbreviateHome, preferencesUnlocked, type AppAction, type AppContext } from "./ui-model";

/** A group as main knows it: exactly the wire shape plus the action per choice. */
interface Group extends SettingsGroup {
  choices: Array<SettingsGroup["choices"][number] & { action: AppAction }>;
  actions?: Array<SettingsChoice & { action: AppAction }>;
}

const VIDEO_QUALITY_LABELS: Record<VideoQuality, PlainMessageKey> = {
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
  const tab = ["screen", "outputFolder", "countdown", "countdownSound", "videoQuality", "resolutionCap", "frameRate"].includes(id) ? "recording" : "general";
  return { id, label, enabled, choices, tab,
    control: ["notifications", "updateChecks", "countdownSound"].includes(id) ? "switch" : ["countdown", "videoQuality", "language"].includes(id) ? "segmented" : "menu",
    section: tab === "recording" ? "recording" : id === "updateChecks" ? "updates" : id,
    noteKind: "explanation", ...(note === undefined ? {} : { note }) };
}

/** On, then Off, for a switch whose action carries the chosen value. */
function switchChoices(language: Language, current: boolean, action: (value: boolean) => AppAction): Group["choices"] {
  return [true, false].map((value) => ({
    id: value ? "on" : "off", label: t(value ? "On" : "Off", language), enabled: true, checked: value === current, action: action(value),
  }));
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
  const result = group("screen", t("Screen", ctx.language), enabled, choices);
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
  if (ctx.captureWarning) result.diagnostics.push({ kind: "history", heading: t("Recording resolution", ctx.language), reason: ctx.captureWarning, guidance: "" });
  return result;
}

/**
 * Where recordings go (plan 048): the path, with Change… and Show in Finder
 * through the tray's own handlers. Locked like the other recording settings,
 * since a session's temporary file is already open in the current folder.
 */
function outputFolderGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  return { ...group("outputFolder", t("Output folder", language), enabled, [
    { id: "change", label: t("Change…", language), enabled: true, checked: false, action: "changeOutputDir" },
    { id: "reveal", label: t(ctx.platform === "darwin" ? "Show in Finder" : "Open folder", language), enabled: true, checked: false, action: "openOutputDir" },
  ], abbreviateHome(ctx.outputDir, ctx.homeDir)), kind: "actions" };
}

/**
 * Seconds before capture begins (plan 040); locked with the other recording settings.
 * Its ⓘ says how to cancel, naming the shortcut only while it is on and registered.
 */
function countdownGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  const shortcutWorks = ctx.hotkey.enabled && ctx.hotkey.registered;
  return { ...group("countdown", t("Countdown", language), enabled, COUNTDOWN_CHOICES.map((value) => ({
    id: String(value),
    label: value === 0 ? t("Off", language) : t("{value} s", language, { value }),
    enabled: true,
    checked: value === ctx.countdown,
    action: { setCountdown: value },
  }))), info: shortcutWorks
    ? t("Click the menu bar icon or press the shortcut to cancel.", language)
    : t("Click the menu bar icon to cancel.", language) };
}

/**
 * The countdown's tick (plan 046): disabled while the countdown is Off, which
 * keeps the stored value, and locked with the other recording settings.
 */
function countdownSoundGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  return { ...group("countdownSound", t("Countdown sound", language), enabled && ctx.countdown !== 0,
    switchChoices(language, ctx.countdownSound, (value) => ({ setCountdownSound: value }))), info: t("The tick is not recorded.", language) };
}

function qualityGroups(ctx: AppContext, enabled: boolean): Group[] {
  const { videoQuality, resolutionCap, frameRate } = ctx.quality;
  const language = ctx.language;
  return [
    { ...group("videoQuality", t("Video quality", language), enabled, VIDEO_QUALITIES.map((value) => ({
      id: value,
      label: t(VIDEO_QUALITY_LABELS[value], language),
      enabled: true,
      checked: value === videoQuality,
      action: { setQuality: { videoQuality: value } },
    }))), info: t("Higher quality preserves more detail and uses more space at the same resolution.", language) },
    { ...group("resolutionCap", t("Resolution cap", language), enabled, RESOLUTION_CAPS.map((value) => ({
      id: value,
      label: value === "source" ? t("Source", language) : RESOLUTION_CAP_LABELS[value],
      enabled: true,
      checked: value === resolutionCap,
      action: { setQuality: { resolutionCap: value } },
    }))), info: t("Limits pixel dimensions while keeping the aspect ratio. Smaller sources are not enlarged.", language) },
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
 * never silent: the saved choice stays selected and a diagnostic says it is inert.
 */
function hotkeyGroup(ctx: AppContext, enabled: boolean): Group {
  const hotkey = ctx.hotkey;
  const language = ctx.language;
  const unavailable = hotkey.enabled && !hotkey.registered
    ? t("Unavailable: another app may be using this shortcut.", language)
    : undefined;
  const diagnostics = hotkeyDiagnostics(ctx, unavailable);
  const recommended = DEFAULT_HOTKEY.accelerator;
  const current = (accelerator: string): boolean => sameShortcut(accelerator, hotkey.accelerator, ctx.platform);
  const accelerators = current(recommended) ? [recommended] : [recommended, hotkey.accelerator];
  return { ...group("hotkey", t("Shortcut", language), enabled, [
    ...accelerators.map((accelerator) => ({
      id: accelerator,
      label: accelerator === recommended
        ? t("Recommended: {shortcut}", language, { shortcut: describeAccelerator(accelerator, ctx.platform) })
        : t("{shortcut} (custom)", language, { shortcut: describeAccelerator(accelerator, ctx.platform) }),
      // A remembered combination that is now the Settings shortcut is refused if chosen again; only the current one stays selectable.
      enabled: !isSettingsShortcut(accelerator, ctx.platform) || (hotkey.enabled && current(accelerator)),
      checked: hotkey.enabled && current(accelerator),
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
  ], undefined), kind: "shortcut", platform: ctx.platform,
    ...((unavailable || ctx.settingsShortcut?.kind === "failed") ? { actions: [{ id: HOTKEY_RETRY_ID, label: t("Retry shortcut registration", language), enabled: true, checked: false, action: "retryShortcuts" as const }] } : {}),
    ...(diagnostics.length ? { diagnostics } : {}) };
}

/** Why a shortcut this card owns does not work: the recording one, and ⌘⌥, for Settings, which the tray also explains. */
function hotkeyDiagnostics(ctx: AppContext, unavailable: string | undefined): NonNullable<Group["diagnostics"]> {
  const language = ctx.language;
  const settings = describeAccelerator(SETTINGS_SHORTCUT, ctx.platform);
  const kind = ctx.settingsShortcut?.kind;
  return [
    ...(unavailable ? [{ kind: "current" as const, heading: t("Shortcut unavailable", language), reason: unavailable,
      guidance: t("Recording is still available from the menu. Choose another shortcut.", language) }] : []),
    ...(kind === "failed" ? [{ kind: "current" as const, heading: t("Settings shortcut unavailable", language),
      reason: t("{shortcut} could not be registered to open Settings; another app may use it.", language, { shortcut: settings }),
      guidance: t("Settings stays available from the menu bar icon. Retry after the other app releases it.", language) }] : []),
    ...(kind === "conflict" ? [{ kind: "current" as const, heading: t("Settings shortcut unavailable", language),
      reason: t("{shortcut} is the recording shortcut, so it does not open Settings.", language, { shortcut: settings }),
      guidance: t("Choose another recording shortcut to open Settings with {shortcut} again.", language, { shortcut: settings }) }] : []),
  ];
}

function updateChecksGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  return { ...group("updateChecks", t("Check for updates on launch", language), enabled,
    switchChoices(language, ctx.updates.enabled, (value) => ({ setUpdateChecks: value }))), sectionHeading: t("Updates", language) };
}

function updateActions(ctx: AppContext, enabled: boolean): Group {
  const { state } = ctx.updates;
  const result = state.kind === "checking" ? state.previous : state;
  const language = ctx.language;
  // A check in progress is busy, not unavailable: the button just pressed keeps keyboard focus.
  const busy = state.kind === "checking" ? { busy: true } : {};
  const choices: Group["choices"] = [{
    id: "check", label: t(state.kind === "checking" ? "Checking for updates…" : "Check for updates…", language),
    enabled: true, ...busy, checked: false, action: "checkUpdates",
  }];
  if (result?.kind === "available" || result?.kind === "failed") choices.push({
    id: "open", label: result.kind === "available"
      ? t("Download {version}…", language, { version: result.version })
      : t("Open releases page…", language),
    enabled: true, ...busy, checked: false, action: "openUpdate",
  });
  // Every result is a status note, which the page reads out; the button only offers what to do about it.
  const note = result?.kind === "current"
    ? t("Up to date (checked {time})", language, { time: new Date(result.checkedAt).toLocaleString(language) })
    : result?.kind === "available" ? t("Version {version} is available.", language, { version: result.version })
    : result?.kind === "failed" ? t("Could not check for updates.", language)
    : undefined;
  return { ...group("updates", t("Updates", language), enabled, choices, note), kind: "actions", noteKind: "status" };
}

/**
 * One switch for every notification the app sends, after Cap's design
 * (CapSoftware/Cap, apps/desktop/src-tauri/src/notifications.rs): the send
 * path checks one boolean and nothing else. Cap can also gate its switch on
 * the OS permission because Tauri exposes `isPermissionGranted`; Electron has
 * no equivalent — `getMediaAccessStatus` accepts microphone, camera and
 * screen only — so the app never claims to know the OS state. The ⓘ
 * carries the recovery path instead of a status line that could be wrong.
 */
function notificationsGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  // The switch controls OS notifications; in-app failure status stays available.
  const switchGroup = group("notifications", t("Notifications", language), enabled,
    switchChoices(language, ctx.notifications, (value) => ({ setNotifications: value })),
    ctx.notifications ? undefined : t("Notifications are off. Recording failures remain visible in the menu bar and in Settings → Failures.", language));
  switchGroup.noteKind = ctx.notifications ? "explanation" : "status";
  if (ctx.notifications && ctx.platform === "darwin") switchGroup.info = t("macOS must also allow RecordStuff in System Settings → Notifications.", language);
  // Only macOS hides notifications behind a pane worth linking to. It sits in
  // this card so the switch and the permission that can override it read as
  // one decision rather than two unrelated settings.
  if (ctx.platform !== "darwin") return switchGroup;
  return { ...switchGroup, actions: [{
    id: "openSettings",
    label: t("Open notification settings…", language),
    enabled: true,
    checked: false,
    action: "openNotificationSettings" satisfies AppAction,
  }] };
}

/** Language is presentation only: it never touches a running capture, so it is never locked. */
function languageGroup(language: Language): Group {
  return group("language", t("Language", language), true, (["en", "zh-TW"] as const).map((value) => ({
    id: value,
    label: value === "en" ? "English" : "繁體中文",
    enabled: true,
    checked: value === language,
    action: { setLanguage: value },
  })));
}

function settingsGroups(state: RecordingState, ctx: AppContext): Group[] {
  const unlocked = preferencesUnlocked(state);
  return [
    screenGroup(ctx, unlocked),
    outputFolderGroup(ctx, unlocked),
    countdownGroup(ctx, unlocked),
    countdownSoundGroup(ctx, unlocked),
    ...qualityGroups(ctx, unlocked),
    // General: everyday preferences first, then maintenance beside the About footer (plan 048).
    hotkeyGroup(ctx, unlocked),
    notificationsGroup(ctx, unlocked),
    languageGroup(ctx.language),
    group("appearance", t("Appearance", ctx.language), true, (["system", "light", "dark"] as const).map(value => ({
      id: value, label: t(value === "system" ? "System default" : value === "light" ? "Light" : "Dark", ctx.language),
      enabled: true, checked: value === (ctx.appearance ?? "system"), action: { setAppearance: value },
    }))),
    updateChecksGroup(ctx, unlocked),
    updateActions(ctx, unlocked),
    { ...group("about", t("Built by Eric Tsai", ctx.language), true, [
      { id: "website", label: t("Official website", ctx.language), enabled: true, checked: false, action: "openWebsite" },
      { id: "source", label: t("GitHub source", ctx.language), enabled: true, checked: false, action: "openSource" },
    ]), kind: "actions" },
  ];
}

/** A calendar day in local time, for grouping and naming failure rows. */
function localDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * The day heading a failure row is grouped under (plan 047): Today, Yesterday,
 * then the date, with the year only when it is not the current year.
 */
export function failureDay(occurredAt: Date, now: Date, language: Language): string {
  const days = Math.round((localDay(now) - localDay(occurredAt)) / 86_400_000);
  if (days === 0) return t("Today", language);
  if (days === 1) return t("Yesterday", language);
  return occurredAt.toLocaleDateString(language, {
    month: "long", day: "numeric", ...(occurredAt.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** The short local time a failure row shows beside its reason. */
export function failureTime(occurredAt: Date, language: Language): string {
  return occurredAt.toLocaleTimeString(language, { hour: "numeric", minute: "2-digit" });
}

/**
 * The third tab (plan 047): always present, its label counting unread
 * failures. "Failures" keeps three labels on one line at the 380 pt minimum;
 * the accessible name keeps the full name and the count.
 */
function failuresTab(ctx: AppContext): SettingsView["tabs"][number] {
  const language = ctx.language;
  const unread = (ctx.recordingResults ?? []).filter(result => !result.acknowledged).length;
  if (!unread) return { id: "failures", label: t("Failures", language), accessibleLabel: t("Recording failures", language) };
  return {
    id: "failures",
    label: t("Failures ({count})", language, { count: String(unread) }),
    accessibleLabel: t("Recording failures, {count} unread", language, { count: String(unread) }),
  };
}

const resultViews = new WeakMap<RecordingResult, { key: string; view: RecordingResultView }>();
function projectResult(result: RecordingResult, state: RecordingState, ctx: AppContext, now: Date): RecordingResultView {
  const language = ctx.language;
  const key = `${language}:${ctx.platform}:${localDay(now)}:${state.type}:${state.type === "needsPermission" && state.needsRelaunch}`;
  const previous = resultViews.get(result);
  if (previous?.key === key) return previous.view;
  const view = {
      id: result.id,
      reason: failureReason(result.code, language),
      day: failureDay(new Date(result.occurredAt), now, language),
      time: failureTime(new Date(result.occurredAt), language),
      outcome: failureOutcome(result, language), guidance: ctx.platform === "darwin" && result.restored && isPermissionFailure(result.code)
        ? t("This is a previous recording failure. Check current recording permissions before trying again.", language)
        : failureGuidance(result.code, language, ctx.platform),
      persistenceWarning: result.persistenceFailed ? persistenceWarning(result.persistenceFailed, language) : "",
      ...(result.saving ? { saving: t("Saving this change…", language) } : {}),
      detail: result.detail,
      ...((result.partialPath ?? result.recordingPath) ? { file: result.partialPath ?? result.recordingPath, fileName: path.basename(result.partialPath ?? result.recordingPath!) } : {}),
      acknowledged: result.acknowledged,
      actions: resultActions(state, ctx, result).map(({ action: _action, ...choice }) => choice),
  };
  resultViews.set(result, { key, view });
  return view;
}

/** Everything the panel renders. Actions stay in main; the panel only sees ids. */
export function settingsView(state: RecordingState, ctx: AppContext): SettingsView {
  const language = ctx.language;
  const unlocked = preferencesUnlocked(state);
  const now = ctx.now ?? new Date();
  // A quit in progress refuses every action but quit, as the tray shows; the panel must not offer one either.
  const quitting = ctx.quitting === true;
  const results = (ctx.recordingResults ?? []).slice(0, ctx.historyLimit).map(result => projectResult(result, state, ctx, now));
  return {
    language,
    ...(ctx.historyFailed ? { recordingHistoryStatus: t("Failure history could not be read. The existing file has been preserved; check the log for details.", language) } : {}),
    ...(ctx.historyLoading ? { recordingHistoryStatus: t("Loading failure history…", language) } : {}),
    recordingResults: quitting ? results.map(result => ({ ...result, actions: result.actions.map(action => ({ ...action, enabled: false })) })) : results,
    recordingResultsRemaining: Math.max(0, (ctx.recordingResults?.length ?? 0) - (ctx.historyLimit ?? Infinity)),
    title: t("RecordStuff - Settings", language),
    // One line above the tabs: the lock covers General too, so it is not the Recording tab's own note.
    hint: quitting ? t("Quitting… RecordStuff quits once the recording is saved or cleaned up.", language)
      : unlocked ? "" : t("Recording in progress. Only language and appearance can change until it ends.", language),
    failure: t("Could not apply this setting. Your current settings are shown.", language),
    tabs: [{ id: "recording", label: t("Recording settings", language) }, { id: "general", label: t("General", language) }, failuresTab(ctx)],
    groups: settingsGroups(state, ctx).map(({ choices, actions, ...rest }) => ({
      ...rest,
      ...(quitting ? { enabled: false } : {}),
      choices: choices.map(({ action: _action, ...choice }) => choice),
      ...(actions === undefined ? {} : { actions: actions.map(({ action: _action, ...choice }) => choice) }),
    })),
  };
}

function resultActions(state: RecordingState, ctx: AppContext, result: RecordingResult): Array<SettingsChoice & { action: AppAction }> {
  const actions: Array<SettingsChoice & { action: AppAction }> = [];
  const add = (id: RecordingResultAction, label: PlainMessageKey, enabled: boolean): void => {
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
  // Retrying cannot overwrite unreadable or newer history, so it is not offered there.
  if (result.persistenceFailed && result.persistenceFailed !== "blocked") add("retry", "Retry saving the record", true);
  if (!result.acknowledged) add("acknowledge", "Got it", result.outcome !== "pending");
  else add("remove", "Remove from history", true);
  return actions;
}

/** The shortcut card's retry action; the card's only choice id besides Off that is not a combination. */
const HOTKEY_RETRY_ID = "retryRegistration";

/**
 * Whether a shortcut-card choice proposes a combination: the editor sends any
 * accelerator as the choice id, so every id but Off and the card's own action is one.
 */
export function proposesHotkey(groupId: unknown, choiceId: unknown): boolean {
  return groupId === "hotkey" && choiceId !== "off" && choiceId !== HOTKEY_RETRY_ID;
}

/** The action for a choice that is offered and enabled right now, or nothing. */
export function settingsAction(
  state: RecordingState,
  ctx: AppContext,
  groupId: unknown,
  choiceId: unknown,
): AppAction | undefined {
  // Nothing is offered while a quit runs (see `settingsView`).
  if (ctx.quitting) return undefined;
  if (typeof groupId === "string" && groupId.startsWith("recordingResult:")) {
    const result = ctx.recordingResults?.find(r => groupId === `recordingResult:${r.id}`);
    if (!result) return undefined;
    return resultActions(state, ctx, result).find(choice => choice.id === choiceId && choice.enabled)?.action;
  }
  if (proposesHotkey(groupId, choiceId) && preferencesUnlocked(state)) {
    const accelerator = canonicalizeAccelerator(choiceId);
    return accelerator && !isSettingsShortcut(accelerator, ctx.platform) ? { setHotkey: { enabled: true, accelerator } } : undefined;
  }
  const choice = find(state, ctx, groupId, choiceId);
  return choice?.group.enabled && choice.enabled && !choice.busy ? choice.action : undefined;
}

/** Whether a choice is the committed one; how main reports that a save took effect. */
export function settingsChecked(
  state: RecordingState,
  ctx: AppContext,
  groupId: unknown,
  choiceId: unknown,
): boolean {
  if (proposesHotkey(groupId, choiceId)) return ctx.hotkey.enabled && sameShortcut(choiceId, ctx.hotkey.accelerator, ctx.platform);
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
