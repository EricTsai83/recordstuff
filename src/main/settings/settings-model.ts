/**
 * The settings panel's model (docs/system-design/desktop.md): one declaration
 * of every preference the user can change, projected for the panel and used
 * again to authorize what the panel asks for.
 *
 * Group and choice ids are stable identifiers — never labels, never encoded
 * actions. The panel echoes an id back and `settingsAction` resolves it
 * against a freshly built model, so a request can only ever perform work the
 * app is offering at that moment. Recording preferences are locked
 * while a capture is running; language, appearance and the icon click remain editable.
 * index.ts re-checks recording locks before saving.
 */
import path from "node:path";
import { translate as t } from "../../shared/i18n";
import { canonicalizeAccelerator, isSettingsShortcut, sameShortcut } from "../../shared/hotkey";
import { isVolume } from "../../shared/audio-volume";
import { DEFAULT_FILE_NAME_TEMPLATE, canonicalFileNameTemplate } from "../../shared/file-name";
import { isLibraryLayout } from "../../shared/appearance";
import type { SettingsView } from "../../shared/settings-panel";
import { formatBytes } from "../../shared/quality";
import { RECORDING_FILE_ACTIONS, type RecordingFileAction } from "../library/recordings-library";
import type { RecordingState } from "../../shared/state";
import { abbreviateHome, type AppAction, type AppContext } from "../app/ui-model";
import { APP_NAME } from "../lib/app-name";
import { preferencesUnlocked } from "../recording/recording-lock";
import { AUDIO_VOLUME_GROUPS, isAudioVolumeGroup, microphoneDeviceGroup, microphoneGroup, microphoneLevelGroup, systemAudioGroup } from "./model/audio";
import { CAMERA_FIELDS, cameraField, cameraGroup, cameraGroups, cameraShapeEnabled, isCameraField, previewDisplay, previewPosition, recordedShorterSide } from "./model/camera";
import { hotkeyGroup, languageGroup, notificationsGroup, proposesHotkey, shortcutListGroups, trayClickGroup, updateActions, updateChecksGroup } from "./model/general";
import { type Group, group, withSectionHeadings } from "./model/group";
import { dateFormats, failuresTab, projectResult, resultActions } from "./model/history";
import { libraryView } from "./model/library";
import { countdownGroup, countdownSoundGroup, editableRecordingGroup, studioOnStartGroup, fileNameGroup, systemUiGroups, outputFolderGroup, qualityGroups, screenGroup } from "./model/recording";
import { STATUS_ACTIONS, settingsStatus } from "./model/status";
import { studioGroups } from "./model/studio";
import { inputProblems } from "./model/inputs";
import { onboardingAction, onboardingChecked, onboardingGuideGroup, onboardingView } from "./model/onboarding";

// The model is split by tab under model/; these are its public API, as they were before the split.
export { dayHeading, shortTime } from "./model/history";
export { proposesHotkey } from "./model/general";
export { settingsStatus } from "./model/status";

function settingsGroups(state: RecordingState, ctx: AppContext): Group[] {
  return withSectionHeadings(withDeviceProblems(state, ctx, ungroupedSettings(state, ctx)), ctx.language);
}

/** The Recording tab's device rows say an input's problem in the Studio picker's words (plan 097, D2). */
const DEVICE_ROWS = { screen: "screen", cameraDevice: "camera", microphoneDevice: "microphone" } as const;
function withDeviceProblems(state: RecordingState, ctx: AppContext, groups: Group[]): Group[] {
  const problems = inputProblems(state, ctx);
  return groups.map((group) => {
    const input = Object.hasOwn(DEVICE_ROWS, group.id) ? DEVICE_ROWS[group.id as keyof typeof DEVICE_ROWS] : undefined;
    const problem = input ? problems[input] : undefined;
    return problem && !problem.waiting ? { ...group, problem: problem.text } : group;
  });
}

function ungroupedSettings(state: RecordingState, ctx: AppContext): Group[] {
  const unlocked = preferencesUnlocked(state);
  return [
    screenGroup(ctx, unlocked),
    ...systemUiGroups(ctx, unlocked),
    outputFolderGroup(ctx, unlocked),
    fileNameGroup(ctx, unlocked),
    editableRecordingGroup(ctx, unlocked),
    countdownGroup(ctx, unlocked),
    countdownSoundGroup(ctx, unlocked),
    studioOnStartGroup(ctx, unlocked),
    systemAudioGroup(ctx, unlocked),
    microphoneGroup(ctx, unlocked),
    microphoneDeviceGroup(ctx, unlocked),
    ...(() => { const level = microphoneLevelGroup(ctx, unlocked); return level ? [level] : []; })(),
    ...studioGroups(state, ctx, unlocked),
    ...(() => { const camera = cameraGroup(ctx, unlocked); return camera ? [camera] : []; })(),
    ...cameraGroups(ctx, unlocked),
    ...qualityGroups(ctx, unlocked),
    // General contains everyday preferences and its About footer; maintenance lives in Troubleshooting.
    trayClickGroup(ctx),
    hotkeyGroup(ctx, unlocked),
    notificationsGroup(ctx, unlocked),
    languageGroup(ctx.language),
    group("appearance", t("Appearance", ctx.language), true, (["system", "light", "dark"] as const).map(value => ({
      id: value, label: t(value === "system" ? "System default" : value === "light" ? "Light" : "Dark", ctx.language),
      enabled: true, checked: value === (ctx.appearance ?? "system"), action: { setAppearance: value },
    }))),
    // The versions prepared for sharing (plan 100): their size, and Clear, which keeps what was handed out in the last
    // day. Locked while recording, as every preference.
    { ...group("versionCache", t("Prepared videos", ctx.language), unlocked, [
      { id: "clear", label: t("Clear", ctx.language), enabled: unlocked && (ctx.versionCacheBytes ?? 0) > 0, checked: false, action: "clearVersionCache" },
    ], (ctx.versionCacheBytes ?? 0) > 0
      ? t("{size} of videos prepared for sharing. They are made again when needed.", ctx.language, { size: formatBytes(ctx.versionCacheBytes ?? 0) })
      : t("No videos are prepared for sharing.", ctx.language)), kind: "actions" },
    ...keptEditsGroup(ctx, unlocked),
    updateChecksGroup(ctx, unlocked),
    updateActions(ctx, unlocked),
    ...onboardingGuideGroup(ctx),
    ...shortcutListGroups(ctx),
    // Troubleshooting: diagnostics stay visible, with destructive cleanup in a separate section.
    // Never locked: showing a file touches nothing a recording holds.
    { ...group("log", t("Log file", ctx.language), true, [
      { id: "show", label: t("Show log", ctx.language), enabled: true, checked: false, action: "revealLog" },
    ]), kind: "actions" },
    { ...group("localData", t("Local app data", ctx.language), unlocked, [
      { id: "clear", label: t("Clear and quit…", ctx.language), enabled: unlocked, checked: false, action: "clearAppData" },
    ], t("Clears settings, failure history, cache, logs and old backups. Recordings are kept.", ctx.language)), kind: "actions" },
    { ...group("about", t("Built by Eric Tsai", ctx.language), true, [
      { id: "website", label: t("Official website", ctx.language), enabled: true, checked: false, action: "openWebsite" },
      { id: "source", label: t("GitHub source", ctx.language), enabled: true, checked: false, action: "openSource" },
      // Closing the window leaves RecordStuff in the menu bar: this ends it, as the tray's Quit does (2026-10-05).
      { id: "quit", label: t("Quit RecordStuff", ctx.language), enabled: true, checked: false, action: "quit" },
      { id: "hide", label: t("Hide RecordStuff", ctx.language), enabled: true, checked: false, action: "hideSettings" },
    ], ctx.version ? t("Version {version}", ctx.language, { version: ctx.version }) : undefined), kind: "actions" },
  ];
}

/**
 * Edits kept for recordings not in the Recordings tab (plan 100): on a disk that is away, or in a folder left behind.
 * Shown only while there are any, with where they are and a way to remove them; nothing is kept unseen.
 */
function keptEditsGroup(ctx: AppContext, unlocked: boolean): Group[] {
  const kept = ctx.keptEdits ?? [];
  if (!kept.length) return [];
  const language = ctx.language;
  const places = new Map<string, number>();
  for (const edit of kept) {
    const folder = abbreviateHome(path.dirname(edit.source), ctx.homeDir);
    places.set(folder, (places.get(folder) ?? 0) + 1);
  }
  const where = [...places].map(([folder, count]) => t("{folder} ({count})", ctx.language, { folder, count })).join(language === "zh-TW" ? "、" : ", ");
  const bytes = kept.reduce((sum, edit) => sum + edit.bytes, 0);
  return [{ ...group("keptEdits", t("Kept edits", language), unlocked, [
    { id: "remove", label: t("Remove", language), enabled: unlocked, checked: false, action: "removeKeptEdits" },
  ], t(kept.length === 1
    ? "1 recording that is not in the Recordings tab keeps its edit ({size}): {where}. It applies again when the recording returns."
    : "{count} recordings that are not in the Recordings tab keep their edits ({size}): {where}. They apply again when the recordings return.", language,
  { count: kept.length, size: formatBytes(bytes), where })), kind: "actions" }];
}

/** About's Quit RecordStuff, the one choice a quit in progress leaves, as the tray leaves its Quit. */
const isQuitChoice = (groupId: unknown, choiceId: unknown): boolean => groupId === "about" && choiceId === "quit";

/** Everything the panel renders. Actions stay in main; the panel only sees ids. */
export function settingsView(state: RecordingState, ctx: AppContext): SettingsView {
  const language = ctx.language;
  const unlocked = preferencesUnlocked(state);
  const now = ctx.now ?? new Date();
  const format = dateFormats(language);
  // A quit in progress refuses every action but quit, as the tray shows; the panel offers no other either. Quit stays,
  // so a Relaunch still waiting on a save can be turned into a plain quit from here too (quit-coordinator.ts).
  const quitting = ctx.quitting === true;
  const results = (ctx.recordingResults ?? []).slice(0, ctx.historyLimit).map(result => projectResult(result, state, ctx, now, format));
  return {
    language,
    // The way out (plan 078): the message no longer sends anyone to the log, and Reset is offered beside it.
    ...(ctx.historyFailed ? { recordingHistoryStatus: t("Could not read the failure history, so new failures cannot be saved. Resetting keeps the file as a backup.", language),
      recordingHistoryReset: { label: t("Reset failure history…", language), enabled: !quitting } } : {}),
    ...(ctx.historyLoading ? { recordingHistoryStatus: t("Loading failure history…", language) } : {}),
    recordingResults: quitting ? results.map(result => ({ ...result, actions: result.actions.map(action => ({ ...action, enabled: false })) })) : results,
    recordingResultsRemaining: Math.max(0, (ctx.recordingResults?.length ?? 0) - (ctx.historyLimit ?? Infinity)),
    // The app's own window, holding the recordings as well as the settings (2026-10-04): named after the app in every language.
    title: APP_NAME,
    status: settingsStatus(state, ctx),
    ...(ctx.library ? { library: libraryView(ctx, now, format)! } : {}),
    ...(ctx.editor ? { editor: ctx.editor } : {}),
    ...(() => { const onboarding = quitting ? undefined : onboardingView(state, ctx); return onboarding ? { onboarding } : {}; })(),
    // One line above the tabs: the lock covers General too, so it is not the Recording tab's own note. A quit
    // needs none: the status card's own title already says it, and the hint sits right under that title.
    hint: quitting || unlocked ? "" : t("Recording in progress; only language, appearance and icon click can change.", language),
    failure: t("Could not apply this setting. Your current settings are shown.", language),
    tabs: [{ id: "library", label: t("Recordings", language) }, { id: "studio", label: t("Recording Studio", language) },
      { id: "recording", label: t("Recording settings", language) }, { id: "general", label: t("General", language) },
      { id: "shortcuts", label: t("Keyboard Shortcuts", language) }, failuresTab(ctx)],
    groups: settingsGroups(state, ctx).map(({ choices, actions, ...rest }) => ({
      ...rest,
      ...(quitting && rest.id !== "about" ? { enabled: false } : {}),
      choices: choices.map(({ action: _action, ...choice }) => quitting && !isQuitChoice(rest.id, choice.id) ? { ...choice, enabled: false } : choice),
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
  // Nothing but Quit is offered while a quit runs (see `settingsView`).
  if (ctx.quitting && !isQuitChoice(groupId, choiceId)) return undefined;
  if (typeof groupId === "string" && groupId.startsWith("recordingResult:")) {
    const result = ctx.recordingResults?.find(r => groupId === `recordingResult:${r.id}`);
    if (!result) return undefined;
    return resultActions(state, ctx, result).find(choice => choice.id === choiceId && choice.enabled)?.action;
  }
  if (typeof groupId === "string" && groupId.startsWith("recordingFile:")) {
    const file = ctx.library?.files.find(candidate => groupId === `recordingFile:${candidate.id}`);
    // One of its saved copies shown in Finder (plan 100, D4), by its place in the list the menu showed.
    const copy = typeof choiceId === "string" ? /^revealCopy:(\d{1,3})$/.exec(choiceId) : null;
    if (file && copy) return Number(copy[1]) < (file.copies?.length ?? 0) ? { recordingFile: { id: file.id, action: "reveal", copy: Number(copy[1]) } } : undefined;
    return file && RECORDING_FILE_ACTIONS.includes(choiceId as RecordingFileAction)
      ? { recordingFile: { id: file.id, action: choiceId as RecordingFileAction } } : undefined;
  }
  if (groupId === "recordingHistory") return choiceId === "reset" && ctx.historyFailed ? "resetFailureHistory" : undefined;
  if (groupId === "onboarding") return onboardingAction(state, ctx, choiceId);
  // The Recordings tab's own choices: its layout, its previews' sound, and Undo while a recording waits to go to the Trash.
  if (groupId === "library") {
    if (choiceId === "undoTrash") return ctx.library?.trashed ? "undoTrash" : undefined;
    if (choiceId === "previewSound:on" || choiceId === "previewSound:off") return { setLibraryPreviewSound: choiceId === "previewSound:on" };
    return isLibraryLayout(choiceId) ? { setLibraryLayout: choiceId } : undefined;
  }
  // The file name pattern is typed, so any valid one is offered while recording settings are unlocked.
  if (groupId === "fileName") {
    const template = canonicalFileNameTemplate(choiceId);
    return template !== undefined && preferencesUnlocked(state) ? { setFileNameTemplate: template } : undefined;
  }
  // The camera's fields send the whole pixels or percent entered; any in range is offered while the shape may change (D7).
  if (isCameraField(groupId)) {
    const { key } = CAMERA_FIELDS[groupId];
    const { min, max, unit } = cameraField(ctx, groupId);
    const value = typeof choiceId === "string" && /^\d{1,5}$/.test(choiceId) ? Number(choiceId) : Number.NaN;
    if (!(value >= min && value <= max && cameraShapeEnabled(ctx, preferencesUnlocked(state)) && ctx.camera?.available)) return undefined;
    // Pixels become the share of the shorter side they are, which gives the same pixels back (cameraField).
    return { setCameraShape: { [key]: unit === "px" ? value / recordedShorterSide(ctx) : value / 100 } };
  }
  // A fader sends the whole percent let go of (D21); the microphone's only while its fader is offered.
  if (isAudioVolumeGroup(groupId)) {
    const volume = typeof choiceId === "string" && /^\d{1,3}$/.test(choiceId) ? Number(choiceId) : Number.NaN;
    const offered = groupId === "systemGain" || (ctx.audioSession ? ctx.audioSession.microphone : ctx.microphone?.enabled);
    return isVolume(volume) && offered ? { setAudioVolume: { source: AUDIO_VOLUME_GROUPS[groupId], volume } } : undefined;
  }
  // The preview sends where the bubble was let go of, on the display it shows, at any time (D7: also while recording).
  if (groupId === "cameraPreview") {
    const position = previewPosition(choiceId);
    const display = previewDisplay(ctx);
    return position && display && ctx.camera?.available
      ? { setCameraPosition: { display: display.id, ...position } } : undefined;
  }
  if (groupId === "status") {
    const { action: offered, secondaryAction: secondary } = settingsStatus(state, ctx);
    const chosen = [offered, secondary].find(action => action?.id === choiceId);
    return chosen ? STATUS_ACTIONS[chosen.id] : undefined;
  }
  if (proposesHotkey(groupId, choiceId) && preferencesUnlocked(state)) {
    const accelerator = canonicalizeAccelerator(choiceId, ctx.platform);
    return accelerator && !isSettingsShortcut(accelerator, ctx.platform) ? { setHotkey: { enabled: true, accelerator } } : undefined;
  }
  const choice = find(state, ctx, groupId, choiceId);
  // A privacy pane changes nothing of the recording, so a lock on its group's choices (a picker during a recording that
  // left the refused input out) does not hold it back (review, 2026-11-01).
  const opensPane = choice?.action === "openMicrophoneSettings" || choice?.action === "openCameraSettings";
  return (choice?.group.enabled || opensPane) && choice?.enabled && !choice.busy ? choice.action : undefined;
}

/** Whether a choice is the committed one; how main reports that a save took effect. */
export function settingsChecked(
  state: RecordingState,
  ctx: AppContext,
  groupId: unknown,
  choiceId: unknown,
): boolean {
  // The card's actions, like the tray's, are requests whose result the card itself then shows.
  if (groupId === "status") return true;
  if (groupId === "onboarding") return onboardingChecked(ctx, choiceId);
  if (groupId === "library") {
    if (choiceId === "previewSound:on" || choiceId === "previewSound:off") return (ctx.libraryPreviewSound ?? false) === (choiceId === "previewSound:on");
    return choiceId === "undoTrash" || (ctx.libraryLayout ?? "grid") === choiceId;
  }
  if (groupId === "fileName") return canonicalFileNameTemplate(choiceId) === (ctx.fileNameTemplate ?? DEFAULT_FILE_NAME_TEMPLATE);
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
