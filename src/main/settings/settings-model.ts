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
import { CAMERA_MAX_SIZE, CAMERA_MIN_SIZE, DEFAULT_CAMERA_LAYOUT, recordedPosition } from "../../shared/camera-layout";
import { failureReason, failureGuidance, failureOutcome, isOutputFolderFailure, isPermissionFailure, persistenceWarning } from "../recording/recording-result";
import { displayLabel, displayFailureText, type DisplayInfo } from "../../shared/display";
import { displayResolution, primaryDisplayChoosable, uniqueDisplay } from "../display/display-source";
import { translate as t, type Language, type PlainMessageKey } from "../../shared/i18n";
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
} from "../../shared/quality";
import { DEFAULT_HOTKEY, settingsShortcut, describeAccelerator, canonicalizeAccelerator, isSettingsShortcut, sameShortcut } from "../../shared/hotkey";
import { COUNTDOWN_CHOICES } from "../../shared/countdown";
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP, DEFAULT_AUDIO_VOLUME, isVolume } from "../../shared/audio-volume";
import { DEFAULT_FILE_NAME_TEMPLATE, FILE_NAME_TOKEN_LIST, canonicalFileNameTemplate, formatFileName } from "../../shared/file-name";
import { isLibraryLayout } from "../../shared/appearance";
import { formatDuration } from "../../shared/video-player";
import type { LibraryView, RecordingResultView, SettingsChoice, SettingsGroup, SettingsStatus, SettingsView, ShortcutRowView, StatusActionId } from "../../shared/settings-panel";
import { SHORTCUT_CATEGORIES, SHORTCUT_CATEGORY_LABELS, shortcutCatalog, shortcutKeys, shortcutText, type CatalogShortcut } from "../../shared/shortcut-catalog";
import { MEDIA_SCHEME, RECORDING_FILE_ACTIONS, type RecordingFileAction } from "../library/recordings-library";
import type { RecordingResult, RecordingResultAction } from "../../shared/recording-result";
import type { RecordingState } from "../../shared/state";

import path from "node:path";
import { QUITTING_TEXT, abbreviateHome, type AppAction, type AppContext } from "../app/ui-model";
import { APP_NAME } from "../lib/app-name";
import { preferencesUnlocked } from "../recording/recording-lock";

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
  return { id, label, enabled, choices, tab: STUDIO_SECTIONS.has(section) ? "studio" : RECORDING_SECTIONS.has(section) ? "recording"
    : TROUBLESHOOTING_SECTIONS.has(section) ? "failures" : "general",
    control: SWITCHES.has(id) ? "switch" : SEGMENTED.has(id) ? "segmented" : "menu",
    ...(ICON_SEGMENTS.has(id) ? { iconChoices: true } : {}),
    section, noteKind: "explanation", ...(note === undefined ? {} : { note }) };
}

/** Rows drawn as an on/off switch, and as a row of segments; any other choice row is a menu. */
const SWITCHES = new Set(["notifications", "updateChecks", "countdownSound", "hideSystemUi", "microphone", "camera", "studioCamera", "cameraShown", "cameraMirror"]);
const SEGMENTED = new Set(["countdown", "videoQuality", "language", "appearance"]);
/** Segments drawn as icons, each named by its label: Appearance's three, one click each (2026-10-05, formerly a menu). */
const ICON_SEGMENTS = new Set(["appearance"]);
/** A row's tab follows its section, so a section is never split. */
const RECORDING_SECTIONS = new Set(["source", "countdown", "audio", "camera", "video"]);
const TROUBLESHOOTING_SECTIONS = new Set(["diagnostics", "cleanup"]);
/** The Recording Studio's (plan 075, D19): what is watched and changed around a recording. */
const STUDIO_SECTIONS = new Set(["studioPreview", "studioCamera", "studioAudio", "studioControls"]);
/** Related rows share an inset list; a section's first row carries its heading. */
const SECTIONS: Record<string, string> = {
  screen: "source", hideSystemUi: "source", outputFolder: "source", fileName: "source",
  countdown: "countdown", countdownSound: "countdown",
  microphone: "audio", microphoneDevice: "audio", microphoneLevel: "audio",
  camera: "camera", cameraDevice: "camera", cameraStudio: "camera",
  studioControls: "studioControls", cameraPreview: "studioPreview", studioLive: "studioPreview", systemAudio: "studioAudio", microphoneAudio: "studioAudio",
  systemGain: "studioAudio", microphoneGain: "studioAudio",
  studioCamera: "studioCamera", cameraShown: "studioCamera", cameraWidth: "studioCamera", cameraHeight: "studioCamera",
  cameraRounding: "studioCamera", cameraMirror: "studioCamera",
  videoQuality: "video", resolutionCap: "video", frameRate: "video",
  trayClick: "controls", hotkey: "controls", notifications: "controls",
  language: "display", appearance: "display",
  updateChecks: "updates", updates: "updates",
  log: "diagnostics", localData: "cleanup",
};
const SECTION_HEADINGS: Record<string, PlainMessageKey> = {
  source: "Source and output",
  countdown: "Before recording",
  audio: "Audio",
  camera: "Camera",
  studioCamera: "Camera",
  studioAudio: "Audio",
  studioControls: "Recording controls",
  video: "Video",
  controls: "Controls and notifications",
  display: "Language and appearance",
  updates: "Updates",
  diagnostics: "Diagnostic tools",
  cleanup: "Reset and cleanup",
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

/** A screen choice's name with its size in pixels, as the display reports it: `Built-in Display · 3024×1964`. */
function withResolution(label: string, display: DisplayInfo | undefined): string {
  return display ? `${label} · ${pixels(display)}` : label;
}
function pixels(display: DisplayInfo): string {
  return `${Math.round(display.logicalWidth * display.scaleFactor)}×${Math.round(display.logicalHeight * display.scaleFactor)}`;
}
/** Where a display stands on the desktop, when the OS said: the Screen row then draws the arrangement. */
function displayFrame(display: DisplayInfo, language: Language): SettingsChoice["display"] {
  if (display.x === undefined || display.y === undefined) return undefined;
  return { x: display.x, y: display.y, width: display.logicalWidth, height: display.logicalHeight, primary: display.primary,
    name: displayLabel({ id: display.id, label: display.label }, language), pixels: pixels(display) };
}

function screenGroup(ctx: AppContext, enabled: boolean): Group {
  const preference = ctx.display;
  // An id two displays share cannot be chosen.
  const unique = (display: DisplayInfo): boolean => uniqueDisplay(ctx.displays, display.id) !== undefined;
  const choices: Group["choices"] = [{ id: "primary", label: withResolution(t("Primary display", ctx.language), ctx.displays.find((display) => display.primary)), enabled: true,
    checked: preference.kind === "primary", action: { setDisplay: { kind: "primary" } } }];
  for (const display of ctx.displays.filter(unique)) {
    const frame = displayFrame(display, ctx.language);
    choices.push({ id: display.id, label: withResolution(displayLabel(display, ctx.language), display), enabled: true,
      checked: preference.kind === "display" && preference.id === display.id, ...(frame ? { display: frame } : {}),
      action: { setDisplay: { kind: "display", id: display.id, label: display.label } } });
  }
  // The chosen display, when it is the one that cannot be recorded.
  const missing = preference.kind === "display" && chosenDisplayUnavailable(ctx) ? preference : undefined;
  if (missing) choices.push({ id: missing.id,
    label: t("{label} — Unavailable", ctx.language, { label: displayLabel(missing, ctx.language) }), enabled: false, checked: true, action: { setDisplay: missing } });
  const result = group("screen", t("Screen", ctx.language), enabled, choices);
  // Drawn as the desktop's arrangement once every screen that can be chosen knows its place; otherwise a menu.
  const placed = choices.filter((choice) => choice.id !== "primary" && choice.enabled);
  if (placed.length > 0 && placed.every((choice) => choice.display)) result.control = "arrangement";
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
 * How new recordings are named (2026-10-05): a pattern the user types, its tokens replaced by the local time a
 * recording starts at (file-name.ts). The one checked choice is the committed pattern; the page sends what was typed,
 * which `settingsAction` validates. Locked with the other recording settings, though a session already named its file.
 */
function fileNameGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  const template = ctx.fileNameTemplate ?? DEFAULT_FILE_NAME_TEMPLATE;
  return { ...group("fileName", t("File name format", language), enabled,
    [{ id: template, label: template, enabled: true, checked: true, action: { setFileNameTemplate: template } }],
    t("Example: {name}", language, { name: `${formatFileName(template, ctx.now ?? new Date())}.mp4` })),
    control: "text", info: t("Placeholders: {tokens}. Include the time or seconds so each recording gets its own name.", language, { tokens: FILE_NAME_TOKEN_LIST }) };
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
 * D6 (plan 076): ScreenCaptureKit leaves the menu bar, the Dock, desktop icons and widgets out of the recording while
 * the user still sees them, so a menu one opens still records: it is that app's window. Windows.Graphics.Capture cannot
 * leave the taskbar out, so there the switch is shown unavailable with why, rather than missing.
 */
function hideSystemUiGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  if (ctx.platform !== "darwin") {
    return { ...group("hideSystemUi", t("Hide taskbar", language), false, switchChoices(language, false, (value) => ({ setHideSystemUi: value }))),
      note: t("Windows cannot leave the taskbar out of a recording.", language) };
  }
  return { ...group("hideSystemUi", t("Hide menu bar and Dock", language), enabled,
    switchChoices(language, ctx.hideSystemUi ?? false, (value) => ({ setHideSystemUi: value }))),
  info: t("Recordings leave out the menu bar, the Dock, desktop icons and widgets; you still see them. A menu you open is still recorded, as part of its app.", language) };
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

/**
 * The microphone (plan 074): off by default and locked while recording. Turning it on asks macOS for access then and
 * there (actions.ts), so the prompt follows the user's own click; a denial keeps the setting and is shown here with
 * the pane that changes it, since a recording would be refused before its countdown.
 */
function microphoneGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  const microphone = ctx.microphone ?? { enabled: false };
  const result: Group = { ...group("microphone", t("Microphone", language), enabled,
    switchChoices(language, microphone.enabled, (value) => ({ setMicrophone: value }))),
  info: t("Mixed with system audio into one track. Use headphones so the microphone does not record your speakers a second time.", language) };
  if (ctx.platform !== "darwin" || !microphone.enabled) return result;
  if (microphone.access === "denied" || microphone.access === "restricted") {
    result.diagnostics = [{ kind: "current", heading: t("Microphone access is off", language),
      reason: t("Recording will not start while Microphone is on.", language),
      guidance: t("Allow RecordStuff in System Settings → Privacy & Security → Microphone, or turn Microphone off.", language) }];
    result.actions = [{ id: "openSettings", label: t("Open microphone settings…", language), enabled: true, checked: false,
      action: "openMicrophoneSettings" satisfies AppAction }, relaunchChoice(language)];
  } else if (microphone.access === "not-determined") {
    result.note = t("macOS asks for microphone access when you next record.", language);
    result.noteKind = "status";
  }
  return result;
}

/**
 * Beside a denial: macOS answers a running app's access question as it first did until the app restarts, so access
 * allowed in System Settings shows only after a relaunch (075's permission round, 2026-10-18), as for screen recording.
 */
function relaunchChoice(language: AppContext["language"]): SettingsChoice & { action: AppAction } {
  return { id: "relaunch", label: t("Already allowed? Relaunch RecordStuff", language), enabled: true, checked: false, action: "relaunch" satisfies AppAction };
}

/**
 * The camera (plan 075): off by default and locked while recording, as the microphone. Turning it on asks for access
 * then and there (actions.ts); a denial is shown here with the pane that changes it. Windows has no status to read, so
 * it names its privacy page while the camera is on. Shown only while `available` (ui-model.ts CameraContext).
 */
function cameraGroup(ctx: AppContext, enabled: boolean): Group | undefined {
  const camera = ctx.camera;
  if (!camera?.available) return undefined;
  const language = ctx.language;
  const result: Group = { ...group("camera", t("Camera", language), enabled,
    switchChoices(language, camera.enabled, (value) => ({ setCamera: value }))),
  info: t("Shows your camera in the recording as a bubble.", language) };
  if (!camera.enabled) return result;
  if (ctx.platform === "win32") {
    result.note = t("Windows records the camera only while desktop apps may use it in Settings → Privacy & security → Camera.", language);
    result.actions = [{ id: "openSettings", label: t("Open camera settings…", language), enabled: true, checked: false,
      action: "openCameraSettings" satisfies AppAction }];
  } else if (ctx.platform === "darwin" && (camera.access === "denied" || camera.access === "restricted")) {
    result.diagnostics = [{ kind: "current", heading: t("Camera access is off", language),
      reason: t("Recording will not start while Camera is on.", language),
      guidance: t("Allow RecordStuff in System Settings → Privacy & Security → Camera, or turn Camera off.", language) }];
    result.actions = [{ id: "openSettings", label: t("Open camera settings…", language), enabled: true, checked: false,
      action: "openCameraSettings" satisfies AppAction }, relaunchChoice(language)];
  } else if (ctx.platform === "darwin" && camera.access === "not-determined") {
    result.note = t("macOS asks for camera access when you next record.", language);
    result.noteKind = "status";
  }
  return result;
}

/** The choice id of the system default camera; device ids come from the engine. */
const DEFAULT_CAMERA = "systemDefault";
/**
 * The bubble's number fields and what each sets (D1, D3; 2026-10-21, at the maintainer's request, in place of sliders
 * and the shape's segments): the width and height in the recording's pixels, the rounding in whole percent.
 */
const CAMERA_FIELDS = {
  cameraWidth: { key: "width", short: "W" },
  cameraHeight: { key: "height", short: "H" },
  cameraRounding: { key: "rounding", short: "Round" },
} as const;
type CameraField = keyof typeof CAMERA_FIELDS;
// Own keys only: a group id from the page such as "constructor" or "toString" is no field (`in` would read the prototype).
const isCameraField = (id: unknown): id is CameraField => typeof id === "string" && Object.hasOwn(CAMERA_FIELDS, id);
/** The shorter side a bubble's pixels are counted on when the display a recording would capture is not known. */
const FALLBACK_SHORTER_SIDE = 1080;

/**
 * A field's range and value: the size in pixels of the recording's shorter side, which the layout keeps as a share of
 * it (D3), so the bubble keeps its share of the picture on any display or quality; the rounding in whole percent.
 */
function cameraField(ctx: AppContext, id: CameraField): { min: number; max: number; value: number; unit: "px" | "percent" } {
  const layout = ctx.camera?.layout ?? DEFAULT_CAMERA_LAYOUT;
  const { key } = CAMERA_FIELDS[id];
  if (key === "rounding") return { min: 0, max: 100, value: Math.round(layout.rounding * 100), unit: "percent" };
  const shorter = recordedShorterSide(ctx);
  const share = Math.min(CAMERA_MAX_SIZE, Math.max(CAMERA_MIN_SIZE, layout[key]));
  // As the preview and the engine size it (bubbleRect, Layout::bubble): the share of the shorter side, rounded.
  return { min: Math.ceil(CAMERA_MIN_SIZE * shorter), max: Math.floor(CAMERA_MAX_SIZE * shorter), value: Math.round(share * shorter), unit: "px" };
}

/** The recording's size on the display it would capture now, at the chosen quality; none when it cannot be found. */
function recordedSize(ctx: AppContext): { width: number; height: number } | undefined {
  const display = previewDisplay(ctx);
  if (!display) return undefined;
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  const quality = effectiveQuality(ctx.quality, ctx.platform);
  return fitWithinCap({ width: even(display.logicalWidth * display.scaleFactor), height: even(display.logicalHeight * display.scaleFactor) }, quality.resolutionCap);
}

function recordedShorterSide(ctx: AppContext): number {
  const size = recordedSize(ctx);
  return size ? Math.min(size.width, size.height) : FALLBACK_SHORTER_SIDE;
}

/**
 * Whether the bubble's size, rounding and mirror may change: at any time, the camera off included (2026-10-22, at the
 * maintainer's request, as the bubble's place), except while a recording that is to compose the camera cannot take a
 * change yet, during its start.
 */
function cameraShapeEnabled(ctx: AppContext, unlocked: boolean): boolean {
  if (!ctx.camera) return false;
  return unlocked || ctx.camera.session !== undefined || !ctx.camera.enabled;
}

/**
 * The camera's row under its switch in Recording settings (plan 075, step 7): the device (D9), locked while recording
 * as the microphone's, with the way to the Recording Studio, where the bubble is placed and shaped (D19).
 */
function cameraGroups(ctx: AppContext, unlocked: boolean): Group[] {
  const camera = ctx.camera;
  if (!camera?.available) return [];
  const language = ctx.language;
  const devices = (camera.devices ?? []).filter((device) => device.id !== DEFAULT_CAMERA);
  const current = devices.find((device) => device.default);
  const stored = camera.device;
  const choices: Group["choices"] = [{
    id: DEFAULT_CAMERA, label: current ? t("System default ({name})", language, { name: current.name }) : t("System default", language),
    enabled: true, checked: stored === undefined, action: { setCameraDevice: null },
  }, ...devices.map((device) => ({
    id: device.id, label: device.name, enabled: true, checked: stored?.id === device.id,
    action: { setCameraDevice: { id: device.id, label: device.name } } satisfies AppAction,
  }))];
  const missing = stored !== undefined && !devices.some((device) => device.id === stored.id);
  if (missing) choices.push({ id: stored.id,
    label: camera.devices ? t("{label} — Not connected", language, { label: stored.label }) : stored.label,
    enabled: !camera.devices, checked: true, action: { setCameraDevice: stored } });
  const device = group("cameraDevice", t("Camera device", language), unlocked && camera.enabled, choices);
  if (missing && camera.devices) {
    device.note = t("Recordings use the system default camera until {label} is connected.", language, { label: stored.label });
    device.noteKind = "status";
  }
  // Its place and shape are the Recording Studio's (D19), one step away, whether the device may change now or not.
  const studio: Group = { ...group("cameraStudio", t("Bubble position and shape", language), true,
    [{ id: "openStudio", label: t("Arrange in Recording Studio…", language), enabled: true, checked: false, action: "openStudio" }]), kind: "actions" };
  return [device, studio];
}

/**
 * The Recording Studio (plan 075, D19): the preview, the camera's switch, its showing in the recording in progress
 * (D13), its shape, and Start, Cancel or Stop with the elapsed time, each a row of its own sections.
 */
function studioGroups(state: RecordingState, ctx: AppContext, unlocked: boolean): Group[] {
  const camera = ctx.camera;
  const language = ctx.language;
  const camerasRows: Group[] = [];
  if (camera?.available) {
    const preview = cameraPreviewGroup(ctx, unlocked);
    if (preview) camerasRows.push(preview);
    camerasRows.push({ ...group("studioCamera", t("Camera", language), unlocked,
      switchChoices(language, camera.enabled, (value) => ({ setCamera: value }))),
    ...(unlocked ? {} : { note: t("Turned on or off between recordings.", language) }) });
    if (camera.session) {
      camerasRows.push(group("cameraShown", t("Show camera in recording", language), true,
        switchChoices(language, !camera.session.hidden, (value) => ({ setCameraHidden: !value }))));
    }
    camerasRows.push(...cameraShapeGroups(ctx, unlocked));
  }
  const live = studioLiveGroup(state, ctx);
  return [...camerasRows, ...(live ? [live] : []), ...studioAudioGroups(ctx), studioControlsGroup(state, ctx)];
}

/**
 * The recording's inputs (D19): each one's level and mute, for the recording in progress only; the microphone's
 * while the recording takes it, or before one while its switch is on.
 */
function studioAudioGroups(ctx: AppContext): Group[] {
  const language = ctx.language;
  const session = ctx.audioSession;
  const row = (id: string, label: PlainMessageKey, source: "system" | "microphone", muted: boolean): Group => ({
    ...group(id, t(label, language), session !== undefined, [
      { id: "mute", label: t("Mute", language), enabled: true, checked: muted, action: { setAudioMuted: { source, muted: true } } },
      { id: "unmute", label: t("Unmute", language), enabled: true, checked: !muted, action: { setAudioMuted: { source, muted: false } } },
    ]),
    control: "meter", meter: { source },
  });
  // Each input's fader (D21): a setting, so offered before, during and between recordings alike.
  const fader = (id: AudioVolumeGroup, label: PlainMessageKey): Group => {
    const source = AUDIO_VOLUME_GROUPS[id];
    const value = (ctx.audioVolume ?? DEFAULT_AUDIO_VOLUME)[source];
    return { ...group(id, t("{label} volume", language, { label: t(label, language) }), true, [{ id: String(value), label: `${value}%`,
      enabled: true, checked: true, action: { setAudioVolume: { source, volume: value } } }]),
      control: "slider", slider: { min: 0, max: AUDIO_VOLUME_MAX, step: AUDIO_VOLUME_STEP, value, unit: "percent" } };
  };
  const rows = [row("systemAudio", "System audio", "system", session?.systemMuted ?? false), fader("systemGain", "System audio")];
  if (session ? session.microphone : ctx.microphone?.enabled) {
    rows.push(row("microphoneAudio", "Microphone", "microphone", session?.microphone?.muted ?? false), fader("microphoneGain", "Microphone"));
  }
  return rows;
}

/** The faders' groups and the input each sets (D21). */
const AUDIO_VOLUME_GROUPS = { systemGain: "system", microphoneGain: "microphone" } as const;
type AudioVolumeGroup = keyof typeof AUDIO_VOLUME_GROUPS;
const isAudioVolumeGroup = (id: unknown): id is AudioVolumeGroup => typeof id === "string" && Object.hasOwn(AUDIO_VOLUME_GROUPS, id);


/**
 * Live preview (D20) as a switch of the preview's own, apart from the recording's controls (2026-10-21): between
 * recordings it holds the recording's session to show the picture it will hold, and during one it shows or hides
 * the recording's picture, which costs nothing to the file. None where the engine makes no preview.
 */
function studioLiveGroup(state: RecordingState, ctx: AppContext): Group | undefined {
  if (!ctx.camera?.available) return undefined;
  const language = ctx.language;
  const preview = ctx.studio?.preview;
  const between = state.type === "idle" || state.type === "needsPermission";
  // During a recording the switch follows its picture; Saving… ends the session, so there is nothing left to show.
  const on = between ? preview !== undefined : ctx.studio?.pictureHidden !== true;
  const enabled = between ? state.type === "idle" && !ctx.mediaComponentsMissing : state.type !== "stopping";
  const choices = [true, false].map((value) => ({ id: value ? "on" : "off", label: t(value ? "On" : "Off", language), enabled: true,
    checked: value === on, action: (between ? (value ? "startPreview" : "stopPreview") : (value ? "showStudioPicture" : "hideStudioPicture")) as AppAction }));
  const failure = ctx.studio?.previewFailure;
  return { ...group("studioLive", t("Live preview", language), enabled, choices), control: "switch",
    ...(between && preview && !preview.live ? { note: t("Starting preview…", language), noteKind: "status" as const }
      : failure && state.type === "idle" && !preview
        ? { note: t("Live preview could not start: {reason}", language, { reason: failureReason(failure, language) }), noteKind: "status" as const } : {}) };
}

/** Start, Cancel or Stop, as the tray offers it now, with the recording's phase and elapsed time (D19). */
function studioControlsGroup(state: RecordingState, ctx: AppContext): Group {
  const language = ctx.language;
  const choice = (id: string, label: PlainMessageKey, action: AppAction, enabled = true): Group["choices"][number] =>
    ({ id, label: t(label, language), enabled, checked: false, action });
  // Start as the tray offers it: without screen recording's permission it waits, the status card above every tab
  // offering the fix (opening the pane, or relaunching once it is allowed), which is not repeated here.
  const choices = state.type === "idle" || state.type === "needsPermission"
    ? [choice("start", "Start recording", "start", state.type === "idle" && !ctx.mediaComponentsMissing)]
    : state.type === "starting" || state.type === "countdown" ? [choice("cancel", "Cancel recording", "cancelCountdown")]
    : state.type === "recording" ? [choice("stop", "Stop recording", "stop")]
    : [choice("saving", "Saving…", "stop", false)];
  // The row says where the recording is; its section heading names the controls.
  const label = state.type === "recording" ? t("Recording", language)
    : state.type === "countdown" ? t("Recording starts in {seconds} s", language, { seconds: state.remaining })
    : state.type === "starting" ? t("Starting…", language) : state.type === "stopping" ? t("Saving…", language)
    : state.type === "needsPermission" ? t("Screen recording permission required", language)
    : t("Ready", language);
  const phase = state.type === "needsPermission" ? "blocked" : state.type === "stopping" ? "saving" : state.type;
  return { ...group("studioControls", label, true, choices), kind: "actions", phase,
    ...(state.type === "recording" ? { elapsedSince: state.startedAt } : {}) };
}

/** The bubble's size, shape, rounding and mirror (D1–D3, D8), changed in the Recording Studio, also while recording (D7). */
function cameraShapeGroups(ctx: AppContext, unlocked: boolean): Group[] {
  const camera = ctx.camera!;
  const language = ctx.language;
  const layout = camera.layout ?? DEFAULT_CAMERA_LAYOUT;
  const shapeEnabled = cameraShapeEnabled(ctx, unlocked);
  const field = (id: CameraField, label: string): Group => {
    const { key, short } = CAMERA_FIELDS[id];
    const { min, max, value, unit } = cameraField(ctx, id);
    return { ...group(id, label, shapeEnabled, [{ id: String(value), label: unit === "px" ? `${value} px` : `${value}%`, enabled: true, checked: true,
      action: { setCameraShape: { [key]: layout[key] } } }]),
      control: "number", number: { min, max, step: 1, value, unit, short: t(short, language) } };
  };
  const size = recordedSize(ctx);
  return [
    { ...field("cameraWidth", t("Width", language)),
      ...(size ? { note: t("Pixels in a {width} × {height} recording.", language, { width: size.width, height: size.height }) } : {}) },
    field("cameraHeight", t("Height", language)),
    { ...field("cameraRounding", t("Rounding", language)), info: t("100% is a circle, or round ends on a wide or tall bubble.", language) },
    { ...group("cameraMirror", t("Mirror in recording", language), shapeEnabled,
      switchChoices(language, layout.mirror, (value) => ({ setCameraShape: { mirror: value } }))) },
  ];
}

/**
 * The preview (plan 075 step 7): the display the recording will capture, to scale, with the bubble where it will be
 * composed, which can be dragged there. Before recording the page shows the camera itself in the bubble; while a
 * recording composes the camera, the engine's preview of the picture. None without a display to show.
 */
function cameraPreviewGroup(ctx: AppContext, unlocked: boolean): Group | undefined {
  const camera = ctx.camera;
  const display = previewDisplay(ctx);
  if (!camera || !display) return undefined;
  const language = ctx.language;
  const layout = camera.layout ?? DEFAULT_CAMERA_LAYOUT;
  const { x, y } = recordedPosition(layout, display.id);
  const granted = camera.access === undefined || camera.access === "granted";
  // The engine's picture whenever a session makes one: a Live preview or a recording, with the camera or not (D20).
  // Not while Live preview is switched off during the recording: the bubble's place then, as before it (2026-10-21).
  const hidden = ctx.studio?.pictureHidden === true;
  const showing = !hidden && (camera.session !== undefined || ctx.studio?.showing === true);
  const mode = showing ? "recording" : !camera.enabled ? "off" : unlocked && granted ? "live" : "off";
  const status = showing ? undefined : hidden ? t("Live preview is off.", language) : !camera.enabled ? t("Turn on Camera to see it here.", language)
    : mode === "off" ? (unlocked ? t("Allow camera access to see it here.", language) : t("Shown here once the recording starts.", language))
    : undefined;
  const id = `${x},${y}`;
  // The name the camera has now, which the page matches to its own list; the stored label may be an older one.
  const chosen = camera.device && camera.devices?.find((device) => device.id === camera.device?.id);
  const named = chosen ? chosen.name : camera.devices?.find((device) => device.default)?.name;
  return {
    // The bubble is placed at any time, the camera off, a countdown or a recording in progress: a setting, as its shape (D7).
    ...group("cameraPreview", t("Preview", language), true,
      [{ id, label: id, enabled: true, checked: true, action: { setCameraPosition: { display: display.id, x, y } } }]),
    control: "cameraPreview",
    info: t("Drag the bubble, or move it with the arrow keys (Shift for larger steps).", language),
    cameraPreview: {
      mode,
      display: { width: display.logicalWidth, height: display.logicalHeight },
      bubble: { width: layout.width, height: layout.height, rounding: layout.rounding, mirror: layout.mirror },
      // The picture holds a camera to place only while its session composes one.
      composed: !showing || camera.session !== undefined,
      x, y,
      ...(named ? { camera: named } : {}),
      ...(status ? { status } : {}),
    },
  };
}

/** The display a recording would capture now, which the preview shows; none when it cannot be found. */
function previewDisplay(ctx: AppContext): DisplayInfo | undefined {
  const resolution = displayResolution(ctx.displays, ctx.display);
  return resolution.ok ? ctx.displays.find((display) => display.id === resolution.id) : undefined;
}

/** A position the preview sends, `x,y`, each a fraction from 0 to 1; anything else is refused. */
function previewPosition(choice: unknown): { x: number; y: number } | undefined {
  if (typeof choice !== "string" || !/^(0|1|0?\.\d{1,6}|1\.0{1,6}),(0|1|0?\.\d{1,6}|1\.0{1,6})$/.test(choice)) return undefined;
  const [x, y] = choice.split(",").map(Number) as [number, number];
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : undefined;
}

/** The choice id of the system default input; device ids come from the engine. */
const DEFAULT_MICROPHONE = "systemDefault";

/**
 * Which input (plan 074): the system default, named after the device it is now, or one the engine listed. A chosen
 * input that is not connected stays selected and says so: the engine records the default input until it is back.
 * While a recording records the microphone it stays open and switches it (plan 079, D3); Search for devices lists the
 * inputs again at once (D2), between recordings.
 */
function microphoneDeviceGroup(ctx: AppContext, unlocked: boolean): Group {
  const language = ctx.language;
  const microphone = ctx.microphone ?? { enabled: false };
  const switching = !unlocked && ctx.audioSession?.microphone !== undefined;
  const devices = (microphone.devices ?? []).filter((device) => device.id !== DEFAULT_MICROPHONE);
  const current = devices.find((device) => device.default);
  const stored = microphone.device;
  const choices: Group["choices"] = [{
    id: DEFAULT_MICROPHONE, label: current ? t("System default ({name})", language, { name: current.name }) : t("System default", language),
    enabled: true, checked: stored === undefined, action: { setMicrophoneDevice: null },
  }, ...devices.map((device) => ({
    id: device.id, label: device.name, enabled: true, checked: stored?.id === device.id,
    action: { setMicrophoneDevice: { id: device.id, label: device.name } } satisfies AppAction,
  }))];
  // Not listed: missing when the inputs are known, or not yet known at all.
  const missing = stored !== undefined && !devices.some((device) => device.id === stored.id);
  if (missing) choices.push({ id: stored.id,
    label: microphone.devices ? t("{label} — Not connected", language, { label: stored.label }) : stored.label,
    enabled: !microphone.devices, checked: true, action: { setMicrophoneDevice: stored } });
  const result = group("microphoneDevice", t("Input device", language), (unlocked && microphone.enabled) || switching, choices);
  if (missing && microphone.devices) {
    result.note = t("Recordings use the system default input until {label} is connected.", language, { label: stored.label });
    result.noteKind = "status";
  } else if (switching) {
    result.note = t("Switches this recording's microphone at once.", language);
    result.noteKind = "status";
  }
  if (microphone.enabled) {
    result.actions = [{ id: "search", label: t(microphone.searching ? "Searching…" : "Search for devices", language),
      enabled: unlocked && !microphone.searching, checked: false, action: "searchMicrophones" satisfies AppAction }];
  }
  return result;
}

/**
 * The input level (plan 079, D1): the chosen input's level between recordings, read by the engine as a recording would,
 * while the microphone is on and macOS allows it; while recording the Recording Studio shows the recording's own.
 */
function microphoneLevelGroup(ctx: AppContext, unlocked: boolean): Group | undefined {
  const language = ctx.language;
  const microphone = ctx.microphone;
  if (!microphone?.enabled || (microphone.access !== undefined && microphone.access !== "granted")) return undefined;
  const result: Group = { ...group("microphoneLevel", t("Input level", language), unlocked, []), control: "inputMeter",
    info: t("Speak to check that the microphone hears you. Nothing is recorded.", language) };
  if (!unlocked) {
    result.note = t("While recording, the Recording Studio shows the level.", language);
    result.noteKind = "status";
  }
  return result;
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
  const size = recordedSize(ctx);
  if (!size) return {};
  const quality = effectiveQuality(ctx.quality, ctx.platform);
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

/** Why a shortcut this card owns does not work: the recording one, and RecordStuff's own (⌥⌘,), which the tray also explains. */
function hotkeyDiagnostics(ctx: AppContext, unavailable: string | undefined): NonNullable<Group["diagnostics"]> {
  const language = ctx.language;
  const settings = describeAccelerator(settingsShortcut(ctx.platform), ctx.platform);
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

/**
 * The Keyboard Shortcuts tab (plan 073): one read-only section per catalog category. Only main knows whether the two
 * global shortcuts work, so their rows show the current choice and status here, with the Shortcut card's reasons.
 */
function shortcutListGroups(ctx: AppContext): Group[] {
  const { language, platform, hotkey } = ctx;
  const settingsKind = ctx.settingsShortcut?.kind;
  const unavailable = (reason: string): ShortcutRowView["status"] => ({ kind: "unavailable", label: t("Unavailable", language), reason });
  const status = (id: string): ShortcutRowView["status"] => {
    if (id === "record") {
      if (!hotkey.enabled) return { kind: "off", label: t("Off", language) };
      return hotkey.registered ? undefined : unavailable(t("Another app may be using this shortcut.", language));
    }
    if (id !== "open") return undefined;
    const settings = describeAccelerator(settingsShortcut(platform), platform);
    return settingsKind === "failed" ? unavailable(t("Another app may be using {shortcut}.", language, { shortcut: settings }))
      : settingsKind === "conflict" ? unavailable(t("{shortcut} is the recording shortcut, so it does not open RecordStuff.", language, { shortcut: settings }))
        : undefined;
  };
  const row = (shortcut: CatalogShortcut): ShortcutRowView => {
    // The recording row shows the user's own combination; Off still names it, as the Shortcut card remembers it.
    const keys = shortcut.id === "record" ? [hotkey.accelerator] : shortcut.keys;
    const rowStatus = status(shortcut.id);
    return {
      id: shortcut.id,
      label: t(shortcut.label, language),
      keys: keys.map((key) => shortcutKeys(key, platform)),
      spoken: keys.map((key) => shortcutText(key, platform)),
      ...(shortcut.gesture ? { gesture: t(shortcut.gesture, language) } : {}),
      ...(shortcut.where ? { where: t(shortcut.where, language) } : {}),
      ...(rowStatus ? { status: rowStatus } : {}),
      ...(shortcut.id === "record" ? { change: t("Change in General", language) } : {}),
    };
  };
  const catalog = shortcutCatalog(platform);
  return SHORTCUT_CATEGORIES.map((category) => {
    const id = `shortcutList:${category}`, label = t(SHORTCUT_CATEGORY_LABELS[category], language);
    return { id, label, tab: "shortcuts", kind: "shortcutList", section: id, sectionHeading: label, enabled: true, choices: [],
      shortcuts: catalog.filter((shortcut) => shortcut.category === category).map(row) };
  });
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
    switchChoices(language, ctx.notifications, (value) => ({ setNotifications: value })));
  if (!ctx.notifications) switchGroup.info = t(ctx.platform === "darwin" ? "Failures still appear in the menu bar and the Troubleshooting tab."
    : "Failures still appear in the system tray and the Troubleshooting tab.", language);
  else if (ctx.platform === "darwin") switchGroup.info = t("macOS must also allow RecordStuff in System Settings → Notifications.", language);
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
    hideSystemUiGroup(ctx, unlocked),
    outputFolderGroup(ctx, unlocked),
    fileNameGroup(ctx, unlocked),
    countdownGroup(ctx, unlocked),
    countdownSoundGroup(ctx, unlocked),
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
    updateChecksGroup(ctx, unlocked),
    updateActions(ctx, unlocked),
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
type DateFormats = ((date: Date, format: keyof typeof DATE_FORMATS) => string) & { readonly zone: string };
/**
 * One view's date formatters, each made on first use. Every view names each failure row and recording
 * again, and `toLocale…String` builds a new ICU formatter per call (tens of microseconds each), so a folder
 * of hundreds of recordings made every refresh slow. Made per view, never kept across views: a formatter
 * keeps the time zone it was made in, and the system zone can change while the app runs (review batch 1).
 */
function dateFormats(language: Language): DateFormats {
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
 * The last tab: Troubleshooting retains the failure entry id and unread count (plan 047),
 * while its accessible name explains what that count means.
 */
function failuresTab(ctx: AppContext): SettingsView["tabs"][number] {
  const language = ctx.language;
  const unread = (ctx.recordingResults ?? []).filter(result => !result.acknowledged).length;
  if (!unread) return { id: "failures", label: t("Troubleshooting", language) };
  return {
    id: "failures",
    label: t("Troubleshooting ({count})", language, { count: String(unread) }),
    accessibleLabel: unread === 1
      ? t("Troubleshooting, 1 unread recording failure", language)
      : t("Troubleshooting, {count} unread recording failures", language, { count: String(unread) }),
  };
}

const resultViews = new WeakMap<RecordingResult, { key: string; view: RecordingResultView }>();
function projectResult(result: RecordingResult, state: RecordingState, ctx: AppContext, now: Date, format: DateFormats): RecordingResultView {
  const language = ctx.language;
  // The zone too: a row's time and day are local, and the system zone can change while the app runs (review batch 2).
  const key = `${language}:${ctx.platform}:${format.zone}:${localDay(now)}:${state.type}:${state.type === "needsPermission" && state.needsRelaunch}`;
  const previous = resultViews.get(result);
  if (previous?.key === key) return previous.view;
  const view: RecordingResultView = {
      id: result.id,
      code: result.code,
      outcomeState: result.outcome,
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
  const text = statusText(state, ctx);
  const status = { ...text, phase: ctx.quitting ? "quitting" as const : text.phase ?? state.type };
  if (ctx.quitting) return status;
  const id = statusActionId(state, ctx);
  // Keep an optional recovery action for access that may already have been granted.
  const relaunch = state.type === "needsPermission" && !state.needsRelaunch;
  return {
    ...status,
    ...(id ? { action: { id, label: t(STATUS_ACTION_LABELS[id], ctx.language) } } : {}),
    ...(relaunch ? { secondaryAction: { id: "relaunch" as const, label: t("Already allowed? Relaunch", ctx.language) } } : {}),
  };
}

/**
 * The card's button, in the tray's words, and the tray action it runs: only a fix for what blocks the next
 * recording. Start, Stop and Cancel stay with the menu bar icon, its menu and the shortcut, where recording begins.
 */
const STATUS_ACTION_LABELS: Record<StatusActionId, PlainMessageKey> = {
  permission: "Open Settings", relaunch: "Relaunch", folder: "Change output folder…", primary: "Use Primary display",
  mediaComponents: "Open Optional features",
};
const STATUS_ACTIONS: Record<StatusActionId, AppAction> = {
  permission: "openPermissionSettings", relaunch: "relaunch", folder: "changeOutputDir", primary: { setDisplay: { kind: "primary" } },
  mediaComponents: "openOptionalFeatures",
};
function statusActionId(state: RecordingState, ctx: AppContext): StatusActionId | undefined {
  switch (state.type) {
    case "needsPermission": return state.needsRelaunch ? "relaunch" : "permission";
    case "idle":
      if (ctx.mediaComponentsMissing) return "mediaComponents";
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
      return { tone: "attention", title: t("Screen recording access", language),
        detail: t(state.needsRelaunch
          ? "Relaunch RecordStuff after allowing access in System Settings."
          : "Allow screen recording in System Settings.", language) };
    case "starting": return { tone: "busy", title: t("Starting… Check for system permission prompts", language), detail: "" };
    case "countdown": return { tone: "busy", title: t("Recording starts in {seconds} s", language, { seconds: state.remaining }), detail: "" };
    case "recording": return { tone: "recording", title: t("Recording", language), detail: "" };
    case "stopping": return { tone: "busy", title: t("Saving…", language), detail: "" };
    case "idle": break;
  }
  // Before anything else: no other fix lets a recording start (plan 078).
  if (ctx.mediaComponentsMissing) return { tone: "attention", title: t("Windows's media components are missing, so recording cannot start.", language),
    detail: t("Install the Media Feature Pack from Optional features in Windows Settings, then restart Windows and record again.", language) };
  if (state.outputDirUnavailable) return { tone: "attention", title: t("Output folder unavailable", language),
    detail: t("Check the output folder, its permissions and the connected drive before recording again.", language) };
  const resolution = displayResolution(ctx.displays, ctx.display);
  // The Screen row below says why and offers the way back; the card only names the problem.
  if (!resolution.ok) return { tone: "attention", title: t("Selected display is unavailable", language), detail: "" };
  // A save in the background (2026-10-09) locks nothing, so the card names it with no lock hint below.
  const saving = ctx.saving?.[0];
  if (saving) return { tone: "busy", phase: "saving", detail: "",
    title: t(saving.slow ? "Still saving {file}. The drive may not be responding." : "Saving {file}…", language, { file: saving.file }) };
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
  const mac = ctx.platform === "darwin";
  // What a Move to Trash left to say, whatever the listing shows meanwhile.
  const extras = {
    layout: ctx.libraryLayout ?? "grid",
    previewSound: ctx.libraryPreviewSound ?? false,
    ...(library.trashed ? { trashed: {
      name: library.trashed.name,
      message: t(mac ? "Moved {name} to the Trash." : "Moved {name} to the Recycle Bin.", language, { name: library.trashed.name }),
      undo: t("Undo", language),
    } } : {}),
    ...(library.trashFailed ? { notice: t(mac ? "Could not move {name} to the Trash. It is back in the folder." : "Could not move {name} to the Recycle Bin. It is back in the folder.", language, { name: library.trashFailed }) } : {}),
  };
  if (library.failed) return { folder, ...extras, status: t("Could not read the output folder. Check the folder and its drive, or choose another folder.", language), items: [] };
  if (library.loading) return { folder, ...extras, status: t("Loading recordings…", language), items: [] };
  const listed = new Set(library.folders?.map(folder => folder.name));
  const total = library.files.reduce((sum, file) => sum + file.size, 0);
  const count = library.files.length;
  return {
    folder,
    ...extras,
    ...(count ? { summary: t(count === 1 ? "1 recording · {size}" : "{count} recordings · {size}", language, { count, size: formatBytes(total) }) } : {}),
    items: library.files.map(file => {
      // Known by its name, whatever named it (2026-10-06, formerly the time for the app's own names); when it was
      // recorded comes beside it.
      const at = new Date(file.recordedAt);
      return {
        id: file.id, name: file.name, day: dayHeading(at, now, language, format),
        title: file.name.replace(/\.[^.]+$/, ""), time: shortTime(at, language, format),
        ...(file.duration === undefined ? {} : { duration: formatDuration(file.duration) }),
        size: formatBytes(file.size),
        thumbnail: `${MEDIA_SCHEME}://thumb/${file.id}?v=${file.version}`,
        video: `${MEDIA_SCHEME}://video/${file.id}?v=${file.version}`,
        ...(file.folder === undefined ? {} : { folder: file.folder }),
      };
    }),
    ...(library.folders?.length ? { folders: library.folders.map(({ name, empty }) => ({ name, empty })) } : {}),
    // Only categories listed now: one renamed or deleted in Finder is not offered, and the tab shows every recording.
    ...((): Pick<LibraryView, "favorites"> => {
      const favorites = (ctx.libraryFavorites ?? []).filter(name => listed.has(name));
      return favorites.length ? { favorites } : {};
    })(),
    ...(ctx.libraryShown === null || (typeof ctx.libraryShown === "string" && listed.has(ctx.libraryShown))
      ? { shown: { folder: ctx.libraryShown } } : {}),
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
  if (groupId === "recordingHistory") return choiceId === "reset" && ctx.historyFailed ? "resetFailureHistory" : undefined;
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
