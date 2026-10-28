/**
 * The Recording tab's rows: the screen, the output folder and file name, the countdown and its sound, hiding the
 * menu bar, and the video quality with its size estimate.
 */
import { displayLabel, displayFailureText, type DisplayInfo } from "../../../shared/display";
import { displayResolution, primaryDisplayChoosable, uniqueDisplay } from "../../display/display-source";
import { translate as t, type Language, type PlainMessageKey } from "../../../shared/i18n";
import { FRAME_RATES, RESOLUTION_CAPS, VIDEO_QUALITIES, effectiveQuality, estimatedBytesPerMinute, formatBytes, isFrameRateAvailable, type ResolutionCap, type VideoQuality } from "../../../shared/quality";
import { COUNTDOWN_CHOICES } from "../../../shared/countdown";
import { DEFAULT_FILE_NAME_TEMPLATE, FILE_NAME_TOKEN_LIST, formatFileName } from "../../../shared/file-name";
import type { SettingsChoice } from "../../../shared/settings-panel";
import { abbreviateHome, type AppContext } from "../../app/ui-model";
import { recordedSize } from "./camera";
import { type Group, group, switchChoices } from "./group";

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

/** Only a chosen display can be unavailable: Primary display always resolves. The Screen row and the status card both ask. */
export function chosenDisplayUnavailable(ctx: AppContext): boolean {
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

export function screenGroup(ctx: AppContext, enabled: boolean): Group {
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
export function outputFolderGroup(ctx: AppContext, unlocked: boolean): Group {
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
export function fileNameGroup(ctx: AppContext, enabled: boolean): Group {
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
export function countdownGroup(ctx: AppContext, enabled: boolean): Group {
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
export function hideSystemUiGroup(ctx: AppContext, enabled: boolean): Group {
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
 * Plan 087: editable recordings keep the screen, each sound and the camera on tracks of their own, so Edit… chooses
 * the camera's place and the volumes after recording. Off by default; macOS only, shown unavailable elsewhere.
 */
export function editableRecordingGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  if (ctx.platform !== "darwin") {
    return { ...group("editableRecording", t("Editable recordings", language), false, switchChoices(language, false, (value) => ({ setEditableRecording: value }))),
      note: t("Editable recordings are available on macOS only.", language) };
  }
  return { ...group("editableRecording", t("Editable recordings", language), enabled,
    switchChoices(language, ctx.editableRecording ?? false, (value) => ({ setEditableRecording: value }))),
  info: t("Keeps the screen, the camera and each sound apart, so Edit… can place the camera and set the volumes after recording. Files are about twice as large, and other apps show the screen with system audio until you export it from Edit….", language) };
}

/**
 * The countdown's tick (plan 046): disabled while the countdown is Off, which
 * keeps the stored value, and locked with the other recording settings.
 */
export function countdownSoundGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  return { ...group("countdownSound", t("Countdown sound", language), enabled && ctx.countdown !== 0,
    switchChoices(language, ctx.countdownSound, (value) => ({ setCountdownSound: value }))) };
}

export function qualityGroups(ctx: AppContext, enabled: boolean): Group[] {
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
