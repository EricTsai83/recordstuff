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
import { failureReason, failureGuidance, failureOutcome, isOutputFolderFailure, isPermissionFailure, persistenceWarning } from "./recording-result";
import { displayLabel, displayFailureText, type DisplayInfo } from "../shared/display";
import { displayResolution, primaryDisplayChoosable, uniqueDisplay } from "./display-source";
import { translate as t, type Language, type PlainMessageKey } from "../shared/i18n";
import {
  FRAME_RATES,
  RESOLUTION_CAPS,
  VIDEO_QUALITIES,
  effectiveQuality,
  estimatedBytesPerMinute,
  fitWithinCap,
  formatBytes,
  isFrameRateAvailable,
  type ResolutionCap,
  type VideoQuality,
} from "../shared/quality";
import { DEFAULT_HOTKEY, SETTINGS_SHORTCUT, describeAccelerator, canonicalizeAccelerator, isSettingsShortcut, sameShortcut } from "../shared/hotkey";
import { COUNTDOWN_CHOICES } from "../shared/countdown";
import { formatDuration } from "../shared/video-player";
import type { LibraryView, RecordingResultView, SettingsChoice, SettingsGroup, SettingsStatus, SettingsView, StatusActionId } from "../shared/settings-panel";
import { MEDIA_SCHEME, RECORDING_FILE_ACTIONS, stampedTime, type RecordingFileAction } from "./recordings-library";
import type { RecordingResult, RecordingResultAction } from "../shared/recording-result";
import type { RecordingState } from "../shared/state";

import path from "node:path";
import { APP_NAME, QUITTING_TEXT, abbreviateHome, preferencesUnlocked, type AppAction, type AppContext } from "./ui-model";

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
  const section = SECTIONS[id] ?? id;
  return { id, label, enabled, choices, tab: RECORDING_SECTIONS.has(section) ? "recording" : "general",
    control: SWITCHES.has(id) ? "switch" : SEGMENTED.has(id) ? "segmented" : "menu",
    ...(ICON_SEGMENTS.has(id) ? { iconChoices: true } : {}),
    section, noteKind: "explanation", ...(note === undefined ? {} : { note }) };
}

/** Rows drawn as an on/off switch, and as a row of segments; any other choice row is a menu. */
const SWITCHES = new Set(["notifications", "updateChecks", "countdownSound"]);
const SEGMENTED = new Set(["countdown", "videoQuality", "language", "appearance"]);
/** Segments drawn as icons, each named by its label: Appearance's three, one click each (2026-10-05, formerly a menu). */
const ICON_SEGMENTS = new Set(["appearance"]);
/** The sections on the Recording settings tab; every other row is General's. A row's tab follows its section, so a section is never split. */
const RECORDING_SECTIONS = new Set(["source", "countdown", "video"]);
/** Related rows share an inset list; a section's first row carries its heading. */
const SECTIONS: Record<string, string> = {
  screen: "source", outputFolder: "source",
  countdown: "countdown", countdownSound: "countdown",
  videoQuality: "video", resolutionCap: "video", frameRate: "video",
  trayClick: "controls", hotkey: "controls", notifications: "controls",
  language: "display", appearance: "display",
  updateChecks: "updates", updates: "updates",
  log: "support",
};
const SECTION_HEADINGS: Record<string, PlainMessageKey> = {
  source: "Source and output",
  countdown: "Before recording",
  video: "Video",
  controls: "Controls and notifications",
  display: "Language and appearance",
  updates: "Updates",
  support: "Troubleshooting",
};

/** On, then Off, for a switch whose action carries the chosen value. */
function switchChoices(language: Language, current: boolean, action: (value: boolean) => AppAction): Group["choices"] {
  return [true, false].map((value) => ({
    id: value ? "on" : "off", label: t(value ? "On" : "Off", language), enabled: true, checked: value === current, action: action(value),
  }));
}

/** Only a chosen display can be unavailable: Primary display always resolves. The Screen row and the status card both ask. */
function chosenDisplayUnavailable(ctx: AppContext): boolean {
  return ctx.display.kind === "display" && !displayResolution(ctx.displays, ctx.display).ok;
}

function screenGroup(ctx: AppContext, enabled: boolean): Group {
  const preference = ctx.display;
  // An id two displays share cannot be chosen.
  const unique = (display: DisplayInfo): boolean => uniqueDisplay(ctx.displays, display.id) !== undefined;
  const choices: Group["choices"] = [{ id: "primary", label: t("Primary display", ctx.language), enabled: true,
    checked: preference.kind === "primary", action: { setDisplay: { kind: "primary" } } }];
  for (const display of ctx.displays.filter(unique)) {
    choices.push({ id: display.id, label: displayLabel(display, ctx.language), enabled: true,
      checked: preference.kind === "display" && preference.id === display.id,
      action: { setDisplay: { kind: "display", id: display.id, label: display.label } } });
  }
  // The chosen display, when it is the one that cannot be recorded.
  const missing = preference.kind === "display" && chosenDisplayUnavailable(ctx) ? preference : undefined;
  if (missing) choices.push({ id: missing.id,
    label: t("{label} — Unavailable", ctx.language, { label: displayLabel(missing, ctx.language) }), enabled: false, checked: true, action: { setDisplay: missing } });
  const result = group("screen", t("Screen", ctx.language), enabled, choices);
  result.diagnostics = [];
  if (missing) {
    result.diagnostics.push({ kind: "current", heading: t("Selected display is unavailable", ctx.language),
      reason: t("Recording cannot start on {label}.", ctx.language, { label: displayLabel(missing, ctx.language) }),
      guidance: t("Choose Primary display or another screen.", ctx.language) });
    if (primaryDisplayChoosable(ctx.displays)) result.recovery = { choice: "primary", label: t("Use Primary display", ctx.language) };
  }
  if (ctx.displayFailure) result.diagnostics.push({ kind: "history",
    heading: t(["target_removed", "track_ended"].includes(ctx.displayFailure) ? "Last recording interrupted" : "Last recording failure", ctx.language),
    // The reason already says what to do next.
    reason: displayFailureText(ctx.displayFailure, ctx.language), guidance: "" });
  if (ctx.captureWarning) result.diagnostics.push({ kind: "history", heading: t("Recording resolution", ctx.language), reason: ctx.captureWarning, guidance: "" });
  return result;
}

/**
 * Where recordings go (plan 048): the path, with Change… and Show in Finder through main's own folder
 * actions, which the status card's fix and the menu's Change output folder… share. Change… is locked like the
 * other recording settings, since a session's temporary file is already open in the current folder. Showing the
 * folder touches nothing a session holds, so it stays available, as the Recordings cards' own Show in Finder and the
 * Log row do; a problem the opener finds meanwhile is told in a notification, not a modal warning (index.ts).
 */
function outputFolderGroup(ctx: AppContext, unlocked: boolean): Group {
  const language = ctx.language;
  return { ...group("outputFolder", t("Output folder", language), true, [
    { id: "change", label: t("Change…", language), enabled: unlocked, checked: false, action: "changeOutputDir" },
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
  }))), info: countdownCancelText(ctx, shortcutWorks) };
}

/** How a countdown is cancelled, by the click the user chose: a click that records cancels, a menu offers Cancel recording. */
function countdownCancelText(ctx: AppContext, shortcutWorks: boolean): string {
  const mac = ctx.platform === "darwin";
  if (ctx.trayClick === "menu") return t(mac
    ? shortcutWorks ? "Choose Cancel recording from the menu bar icon, or press the shortcut." : "Choose Cancel recording from the menu bar icon."
    : shortcutWorks ? "Choose Cancel recording from the system tray icon, or press the shortcut." : "Choose Cancel recording from the system tray icon.", ctx.language);
  return t(mac
    ? shortcutWorks ? "Click the menu bar icon or press the shortcut to cancel." : "Click the menu bar icon to cancel."
    : shortcutWorks ? "Click the system tray icon or press the shortcut to cancel." : "Click the system tray icon to cancel.", ctx.language);
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
    }))), info: t("Higher quality keeps more detail but makes larger files.", language) },
    { ...group("resolutionCap", t("Resolution cap", language), enabled, RESOLUTION_CAPS.map((value) => ({
      id: value,
      label: value === "source" ? t("Source", language) : RESOLUTION_CAP_LABELS[value],
      enabled: true,
      checked: value === resolutionCap,
      action: { setQuality: { resolutionCap: value } },
    }))), info: t("Scales larger screens down, keeping the aspect ratio. Smaller ones are not enlarged.", language) },
    // A frame rate that is not verified on this platform stays visible and
    // says why, rather than silently disappearing from the list.
    { ...group("frameRate", t("Frame rate", language), enabled, FRAME_RATES.map((value) => ({
      id: String(value),
      label: isFrameRateAvailable(value, ctx.platform)
        ? `${value} fps`
        : t("{value} fps (unverified on this platform)", language, { value }),
      enabled: isFrameRateAvailable(value, ctx.platform),
      checked: value === frameRate,
      action: { setQuality: { frameRate: value } },
    }))), ...sizeEstimate(ctx) },
  ];
}

/**
 * What the Video choices cost (2026-10-04): about how much a minute takes on the selected screen,
 * from the encoder targets, so quality is chosen knowing the file size rather than only told it grows.
 */
function sizeEstimate(ctx: AppContext): { footnote?: string } {
  const resolution = displayResolution(ctx.displays, ctx.display);
  const display = resolution.ok ? ctx.displays.find((d) => d.id === resolution.id) : undefined;
  if (!display) return {};
  const quality = effectiveQuality(ctx.quality, ctx.platform);
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  const size = fitWithinCap({ width: even(display.logicalWidth * display.scaleFactor), height: even(display.logicalHeight * display.scaleFactor) }, quality.resolutionCap);
  return { footnote: t("About {size} per minute at {width} × {height}, {fps} fps.", ctx.language,
    { size: formatBytes(estimatedBytesPerMinute(size, quality)), width: size.width, height: size.height, fps: quality.frameRate }) };
}

/**
 * One recommended shortcut, the current custom value, and Off. A registration the OS refused is
 * never silent: the saved choice stays selected and a diagnostic says it is inert.
 */
function hotkeyGroup(ctx: AppContext, enabled: boolean): Group {
  const hotkey = ctx.hotkey;
  const language = ctx.language;
  const unavailable = hotkey.enabled && !hotkey.registered
    ? t("Another app may be using this shortcut.", language)
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

/** Why a shortcut this card owns does not work: the recording one, and ⌥⌘, for Settings, which the tray also explains. */
function hotkeyDiagnostics(ctx: AppContext, unavailable: string | undefined): NonNullable<Group["diagnostics"]> {
  const language = ctx.language;
  const settings = describeAccelerator(SETTINGS_SHORTCUT, ctx.platform);
  const kind = ctx.settingsShortcut?.kind;
  return [
    ...(unavailable ? [{ kind: "current" as const, heading: t("Shortcut unavailable", language), reason: unavailable,
      guidance: t("Record from the menu, or choose another shortcut.", language) }] : []),
    ...(kind === "failed" ? [{ kind: "current" as const, heading: t("The shortcut for RecordStuff is unavailable", language),
      reason: t("Another app may be using {shortcut}.", language, { shortcut: settings }),
      guidance: t(ctx.platform === "darwin" ? "Open RecordStuff from the menu bar icon, or retry once the other app releases it."
        : "Open RecordStuff from the system tray icon, or retry once the other app releases it.", language) }] : []),
    ...(kind === "conflict" ? [{ kind: "current" as const, heading: t("The shortcut for RecordStuff is unavailable", language),
      reason: t("{shortcut} is the recording shortcut, so it does not open RecordStuff.", language, { shortcut: settings }),
      guidance: t("Choose another recording shortcut to open RecordStuff with {shortcut} again.", language, { shortcut: settings }) }] : []),
  ];
}

function updateChecksGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  return { ...group("updateChecks", t("Check for updates on launch", language), enabled,
    switchChoices(language, ctx.updates.enabled, (value) => ({ setUpdateChecks: value }))) };
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
  // Not "Updates" again: that is already the section's heading.
  return { ...group("updates", t("Manual check", language), enabled, choices, note), kind: "actions", noteKind: "status" };
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
    ctx.notifications ? undefined : t(ctx.platform === "darwin" ? "Failures still appear in the menu bar and the Failures tab."
      : "Failures still appear in the system tray and the Failures tab.", language));
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

/**
 * What the icon's left click does (2026-10-04). Never locked: a session holds nothing that depends on it,
 * and the next click simply follows the new choice. The right click always opens the menu, as the ⓘ says.
 */
function trayClickGroup(ctx: AppContext): Group {
  const language = ctx.language;
  const current = ctx.trayClick ?? "record";
  return { ...group("trayClick", t("Icon click", language), true,
    (["menu", "record"] as const).map((value) => ({
      id: value, label: t(value === "menu" ? "Open the menu" : "Start / stop recording", language),
      enabled: true, checked: value === current, action: { setTrayClick: value },
    }))), info: t("A right click always opens the menu.", language) };
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
  return withSectionHeadings(ungroupedSettings(state, ctx), ctx.language);
}

function withSectionHeadings(groups: Group[], language: Language): Group[] {
  return groups.map((group, index) => {
    const heading = group.section === undefined ? undefined : SECTION_HEADINGS[group.section];
    return heading && groups[index - 1]?.section !== group.section ? { ...group, sectionHeading: t(heading, language) } : group;
  });
}

function ungroupedSettings(state: RecordingState, ctx: AppContext): Group[] {
  const unlocked = preferencesUnlocked(state);
  return [
    screenGroup(ctx, unlocked),
    outputFolderGroup(ctx, unlocked),
    countdownGroup(ctx, unlocked),
    countdownSoundGroup(ctx, unlocked),
    ...qualityGroups(ctx, unlocked),
    // General: everyday preferences first, then maintenance beside the About footer (plan 048).
    trayClickGroup(ctx),
    hotkeyGroup(ctx, unlocked),
    notificationsGroup(ctx, unlocked),
    languageGroup(ctx.language),
    group("appearance", t("Appearance", ctx.language), true, (["system", "light", "dark"] as const).map(value => ({
      id: value, label: t(value === "system" ? "System default" : value === "light" ? "Light" : "Dark", ctx.language),
      enabled: true, checked: value === (ctx.appearance ?? "system"), action: { setAppearance: value },
    }))),
    updateChecksGroup(ctx, unlocked),
    updateActions(ctx, unlocked),
    // Moved from the tray (2026-10-04): a row like any other, so what it does is read, not guessed from an icon.
    // Never locked: showing a file touches nothing a recording holds.
    { ...group("log", t("Log file", ctx.language), true, [
      { id: "show", label: t("Show log", ctx.language), enabled: true, checked: false, action: "revealLog" },
    ]), kind: "actions" },
    { ...group("about", t("Built by Eric Tsai", ctx.language), true, [
      { id: "website", label: t("Official website", ctx.language), enabled: true, checked: false, action: "openWebsite" },
      { id: "source", label: t("GitHub source", ctx.language), enabled: true, checked: false, action: "openSource" },
      // Closing the window leaves RecordStuff in the menu bar: this ends it, as the tray's Quit does (2026-10-05).
      { id: "quit", label: t("Quit RecordStuff", ctx.language), enabled: true, checked: false, action: "quit" },
    ], ctx.version ? t("Version {version}", ctx.language, { version: ctx.version }) : undefined), kind: "actions" },
  ];
}

/** A calendar day in local time, for grouping and naming failure rows and recordings. */
function localDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const DATE_FORMATS = {
  day: { month: "long", day: "numeric" },
  dayOfYear: { year: "numeric", month: "long", day: "numeric" },
  time: { hour: "numeric", minute: "2-digit" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;
/** Formats a date in one of the shapes above; `zone` is the system time zone the view was made in. */
export type DateFormats = ((date: Date, format: keyof typeof DATE_FORMATS) => string) & { readonly zone: string };
/**
 * One view's date formatters, each made on first use. Every view names each failure row and recording
 * again, and `toLocale…String` builds a new ICU formatter per call (tens of microseconds each), so a folder
 * of hundreds of recordings made every refresh slow. Made per view, never kept across views: a formatter
 * keeps the time zone it was made in, and the system zone can change while the app runs (review batch 1).
 */
export function dateFormats(language: Language): DateFormats {
  const made = new Map<keyof typeof DATE_FORMATS, Intl.DateTimeFormat>();
  const format = (date: Date, shape: keyof typeof DATE_FORMATS): string => {
    let formatter = made.get(shape);
    if (!formatter) made.set(shape, formatter = new Intl.DateTimeFormat(language, DATE_FORMATS[shape]));
    return formatter.format(date);
  };
  return Object.assign(format, { zone: new Intl.DateTimeFormat().resolvedOptions().timeZone });
}

/**
 * The day heading failure rows (plan 047) and recordings are grouped under: Today, Yesterday,
 * then the date, with the year only when it is not the current year.
 */
export function dayHeading(occurredAt: Date, now: Date, language: Language, format = dateFormats(language)): string {
  const days = Math.round((localDay(now) - localDay(occurredAt)) / 86_400_000);
  if (days === 0) return t("Today", language);
  if (days === 1) return t("Yesterday", language);
  return format(occurredAt, occurredAt.getFullYear() === now.getFullYear() ? "day" : "dayOfYear");
}

/** The short local time a failure row shows beside its reason, and the title of a recording the app named. */
export function shortTime(occurredAt: Date, language: Language, format = dateFormats(language)): string {
  return format(occurredAt, "time");
}

/**
 * The last tab (plan 047): always present, its label counting unread
 * failures. "Failures" stays short, so the four tabs fit the 380 pt minimum;
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
function projectResult(result: RecordingResult, state: RecordingState, ctx: AppContext, now: Date, format: DateFormats): RecordingResultView {
  const language = ctx.language;
  // The zone too: a row's time and day are local, and the system zone can change while the app runs (review batch 2).
  const key = `${language}:${ctx.platform}:${format.zone}:${localDay(now)}:${state.type}:${state.type === "needsPermission" && state.needsRelaunch}`;
  const previous = resultViews.get(result);
  if (previous?.key === key) return previous.view;
  const view = {
      id: result.id,
      reason: failureReason(result.code, language),
      day: dayHeading(new Date(result.occurredAt), now, language, format),
      time: shortTime(new Date(result.occurredAt), language, format),
      outcome: failureOutcome(result, language), guidance: ctx.platform === "darwin" && result.restored && isPermissionFailure(result.code)
        ? t("This failure is from an earlier session. Check recording permissions before trying again.", language)
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

/**
 * The status card above the tabs: the same states the tray shows, said as
 * what the user can do now. A settled app explains how to start; a busy one
 * leaves the explanation to the lock `hint`.
 */
export function settingsStatus(state: RecordingState, ctx: AppContext): SettingsStatus {
  const status = statusText(state, ctx);
  if (ctx.quitting) return status;
  const id = statusActionId(state, ctx);
  // The detail says to relaunch if access was just granted: the card offers it, as the tray's permission steps do.
  const relaunch = state.type === "needsPermission" && !state.needsRelaunch;
  return {
    ...status,
    ...(id ? { action: { id, label: t(STATUS_ACTION_LABELS[id], ctx.language) } } : {}),
    ...(relaunch ? { secondaryAction: { id: "relaunch" as const, label: t("Already allowed? Relaunch RecordStuff", ctx.language) } } : {}),
  };
}

/**
 * The card's button, in the tray's words, and the tray action it runs: only a fix for what blocks the next
 * recording. Start, Stop and Cancel stay with the menu bar icon, its menu and the shortcut, where recording begins.
 */
const STATUS_ACTION_LABELS: Record<StatusActionId, PlainMessageKey> = {
  permission: "Open System Settings", relaunch: "Relaunch", folder: "Change output folder…", primary: "Use Primary display",
};
const STATUS_ACTIONS: Record<StatusActionId, AppAction> = {
  permission: "openPermissionSettings", relaunch: "relaunch", folder: "changeOutputDir", primary: { setDisplay: { kind: "primary" } },
};
function statusActionId(state: RecordingState, ctx: AppContext): StatusActionId | undefined {
  switch (state.type) {
    case "needsPermission": return state.needsRelaunch ? "relaunch" : "permission";
    case "idle":
      if (state.outputDirUnavailable) return "folder";
      // The Screen row's own way back (its `recovery`), when there is one.
      return chosenDisplayUnavailable(ctx) && primaryDisplayChoosable(ctx.displays) ? "primary" : undefined;
    default: return undefined;
  }
}

function statusText(state: RecordingState, ctx: AppContext): SettingsStatus {
  const language = ctx.language;
  if (ctx.quitting) return { tone: "busy", title: t(QUITTING_TEXT[ctx.quitStep ?? "media"], language), detail: "" };
  switch (state.type) {
    case "needsPermission":
      return { tone: "attention", title: t("Screen recording permission required", language),
        detail: t("Check recording permissions in System Settings. Relaunch if access was recently granted.", language) };
    case "starting": return { tone: "busy", title: t("Starting… Check for system permission prompts", language), detail: "" };
    case "countdown": return { tone: "busy", title: t("Recording starts in {seconds} s", language, { seconds: state.remaining }), detail: "" };
    case "recording": return { tone: "recording", title: t("Recording", language), detail: "" };
    case "stopping": return { tone: "busy", title: t("Saving…", language), detail: "" };
    case "idle": break;
  }
  if (state.outputDirUnavailable) return { tone: "attention", title: t("Output folder unavailable", language),
    detail: t("Check the output folder, its permissions and the connected drive before recording again.", language) };
  const resolution = displayResolution(ctx.displays, ctx.display);
  // The Screen row below says why and offers the way back; the card only names the problem.
  if (!resolution.ok) return { tone: "attention", title: t("Selected display is unavailable", language), detail: "" };
  // Nothing to say while ready: the page shows no card then, and the menu bar icon is where recording starts.
  return { tone: "ready", title: t("Ready to record", language), detail: "" };
}

/**
 * The Recordings tab (2026-10-04): the output folder's videos, newest first, grouped by day like the
 * failures, each with the URLs the page may load it by. Totals count every listed file.
 */
function libraryView(ctx: AppContext, now: Date, format: DateFormats): LibraryView | undefined {
  const library = ctx.library;
  if (!library) return undefined;
  const language = ctx.language;
  const folder = abbreviateHome(library.dir, ctx.homeDir);
  if (library.failed) return { folder, status: t("Could not read the output folder. Check the folder and its drive, or choose another folder.", language), items: [] };
  if (library.loading) return { folder, status: t("Loading recordings…", language), items: [] };
  const total = library.files.reduce((sum, file) => sum + file.size, 0);
  const count = library.files.length;
  return {
    folder,
    ...(count ? { summary: t(count === 1 ? "1 recording · {size}" : "{count} recordings · {size}", language, { count, size: formatBytes(total) }) } : {}),
    items: library.files.map(file => {
      // The app's own name already says when; any other file is known by its name.
      const stamped = stampedTime(file.name) !== undefined;
      const at = new Date(file.recordedAt);
      return {
        id: file.id, name: file.name, day: dayHeading(at, now, language, format),
        title: stamped ? shortTime(at, language, format) : file.name.replace(/\.[^.]+$/, ""),
        ...(file.duration === undefined ? {} : { duration: formatDuration(file.duration) }),
        size: formatBytes(file.size),
        thumbnail: `${MEDIA_SCHEME}://thumb/${file.id}?v=${file.version}`,
        video: `${MEDIA_SCHEME}://video/${file.id}?v=${file.version}`,
      };
    }),
  };
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
    ...(ctx.historyFailed ? { recordingHistoryStatus: t("Could not read the failure history. The file was kept; see the log.", language) } : {}),
    ...(ctx.historyLoading ? { recordingHistoryStatus: t("Loading failure history…", language) } : {}),
    recordingResults: quitting ? results.map(result => ({ ...result, actions: result.actions.map(action => ({ ...action, enabled: false })) })) : results,
    recordingResultsRemaining: Math.max(0, (ctx.recordingResults?.length ?? 0) - (ctx.historyLimit ?? Infinity)),
    // The app's own window, holding the recordings as well as the settings (2026-10-04): named after the app in every language.
    title: APP_NAME,
    status: settingsStatus(state, ctx),
    ...(ctx.library ? { library: libraryView(ctx, now, format)! } : {}),
    // One line above the tabs: the lock covers General too, so it is not the Recording tab's own note. A quit
    // needs none: the status card's own title already says it, and the hint sits right under that title.
    hint: quitting || unlocked ? "" : t("Recording in progress; only language, appearance and icon click can change.", language),
    failure: t("Could not apply this setting. Your current settings are shown.", language),
    tabs: [{ id: "library", label: t("Recordings", language) }, { id: "recording", label: t("Recording settings", language) }, { id: "general", label: t("General", language) }, failuresTab(ctx)],
    groups: settingsGroups(state, ctx).map(({ choices, actions, ...rest }) => ({
      ...rest,
      ...(quitting && rest.id !== "about" ? { enabled: false } : {}),
      choices: choices.map(({ action: _action, ...choice }) => quitting && !isQuitChoice(rest.id, choice.id) ? { ...choice, enabled: false } : choice),
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
  // Nothing but Quit is offered while a quit runs (see `settingsView`).
  if (ctx.quitting && !isQuitChoice(groupId, choiceId)) return undefined;
  if (typeof groupId === "string" && groupId.startsWith("recordingResult:")) {
    const result = ctx.recordingResults?.find(r => groupId === `recordingResult:${r.id}`);
    if (!result) return undefined;
    return resultActions(state, ctx, result).find(choice => choice.id === choiceId && choice.enabled)?.action;
  }
  if (typeof groupId === "string" && groupId.startsWith("recordingFile:")) {
    const file = ctx.library?.files.find(candidate => groupId === `recordingFile:${candidate.id}`);
    return file && RECORDING_FILE_ACTIONS.includes(choiceId as RecordingFileAction)
      ? { recordingFile: { id: file.id, action: choiceId as RecordingFileAction } } : undefined;
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
  return choice?.group.enabled && choice.enabled && !choice.busy ? choice.action : undefined;
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
