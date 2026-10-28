/**
 * The camera's rows (plan 075): its switch and device, the bubble's size, rounding and mirror in pixels or percent,
 * and the preview where it is placed.
 */
import { CAMERA_MAX_SIZE, CAMERA_MIN_SIZE, DEFAULT_CAMERA_LAYOUT, recordedPosition } from "../../../shared/camera-layout";
import type { DisplayInfo } from "../../../shared/display";
import { displayResolution } from "../../display/display-source";
import { translate as t } from "../../../shared/i18n";
import { effectiveQuality, fitWithinCap } from "../../../shared/quality";
import type { AppAction, AppContext } from "../../app/ui-model";
import { type Group, group, relaunchChoice, switchChoices } from "./group";

/**
 * The camera (plan 075): off by default and locked while recording, as the microphone. Turning it on asks for access
 * then and there (actions.ts); a denial is shown here with the pane that changes it. Windows has no status to read, so
 * it names its privacy page while the camera is on. Shown only while `available` (ui-model.ts CameraContext).
 */
export function cameraGroup(ctx: AppContext, enabled: boolean): Group | undefined {
  const camera = ctx.camera;
  if (!camera?.available) return undefined;
  const language = ctx.language;
  const result: Group = { ...group("camera", t("Camera", language), enabled,
    switchChoices(language, camera.enabled, (value) => ({ setCamera: value }))) };
  // Off because macOS refused it, as the microphone's (native round, 2026-10-26).
  if (!camera.enabled && ctx.platform === "darwin" && (camera.access === "denied" || camera.access === "restricted")) {
    result.note = t("macOS does not allow the camera. Allow RecordStuff in System Settings to turn it on.", language);
    result.noteKind = "status";
    result.actions = [{ id: "openSettings", label: t("Open camera settings…", language), enabled: true, checked: false,
      action: "openCameraSettings" satisfies AppAction }];
  }
  if (!camera.enabled) return result;
  if (ctx.platform === "win32") {
    result.note = t("Windows records the camera only while desktop apps may use it in Settings → Privacy & security → Camera.", language);
    result.actions = [{ id: "openSettings", label: t("Open camera settings…", language), enabled: true, checked: false,
      action: "openCameraSettings" satisfies AppAction }];
  } else if (ctx.platform === "darwin" && (camera.access === "denied" || camera.access === "restricted")) {
    result.diagnostics = [{ kind: "current", heading: t("Camera access is off", language),
      reason: t("Recordings leave the camera out until it is allowed.", language),
      guidance: t("Allow RecordStuff in System Settings → Privacy & Security → Camera, or turn Camera off.", language) }];
    result.actions = [{ id: "openSettings", label: t("Open camera settings…", language), enabled: true, checked: false,
      action: "openCameraSettings" satisfies AppAction }, relaunchChoice(language)];
  } else if (ctx.platform === "darwin" && camera.access === "not-determined") {
    // The engine opens only an allowed camera and asks nothing (review pass 2), so this row asks, at the user's press.
    result.note = t("macOS has not been asked about the camera yet; recordings leave it out until it is allowed.", language);
    result.noteKind = "status";
    result.actions = [{ id: "allow", label: t("Allow camera…", language), enabled, checked: false, action: "askCamera" satisfies AppAction }];
  }
  return result;
}

/** The choice id of the system default camera; device ids come from the engine. */
const DEFAULT_CAMERA = "systemDefault";
/**
 * The bubble's number fields and what each sets (D1, D3; 2026-10-21, at the maintainer's request, in place of sliders
 * and the shape's segments): the width and height in the recording's pixels, the rounding in whole percent.
 */
export const CAMERA_FIELDS = {
  cameraWidth: { key: "width", short: "W" },
  cameraHeight: { key: "height", short: "H" },
  cameraRounding: { key: "rounding", short: "Round" },
} as const;
type CameraField = keyof typeof CAMERA_FIELDS;
// Own keys only: a group id from the page such as "constructor" or "toString" is no field (`in` would read the prototype).
export const isCameraField = (id: unknown): id is CameraField => typeof id === "string" && Object.hasOwn(CAMERA_FIELDS, id);
/** The shorter side a bubble's pixels are counted on when the display a recording would capture is not known. */
const FALLBACK_SHORTER_SIDE = 1080;

/**
 * A field's range and value: the size in pixels of the recording's shorter side, which the layout keeps as a share of
 * it (D3), so the bubble keeps its share of the picture on any display or quality; the rounding in whole percent.
 */
export function cameraField(ctx: AppContext, id: CameraField): { min: number; max: number; value: number; unit: "px" | "percent" } {
  const layout = ctx.camera?.layout ?? DEFAULT_CAMERA_LAYOUT;
  const { key } = CAMERA_FIELDS[id];
  if (key === "rounding") return { min: 0, max: 100, value: Math.round(layout.rounding * 100), unit: "percent" };
  const shorter = recordedShorterSide(ctx);
  const share = Math.min(CAMERA_MAX_SIZE, Math.max(CAMERA_MIN_SIZE, layout[key]));
  // As the preview and the engine size it (bubbleRect, Layout::bubble): the share of the shorter side, rounded.
  return { min: Math.ceil(CAMERA_MIN_SIZE * shorter), max: Math.floor(CAMERA_MAX_SIZE * shorter), value: Math.round(share * shorter), unit: "px" };
}

/** The recording's size on the display it would capture now, at the chosen quality; none when it cannot be found. */
export function recordedSize(ctx: AppContext): { width: number; height: number } | undefined {
  const display = previewDisplay(ctx);
  if (!display) return undefined;
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  const quality = effectiveQuality(ctx.quality, ctx.platform);
  return fitWithinCap({ width: even(display.logicalWidth * display.scaleFactor), height: even(display.logicalHeight * display.scaleFactor) }, quality.resolutionCap);
}

export function recordedShorterSide(ctx: AppContext): number {
  const size = recordedSize(ctx);
  return size ? Math.min(size.width, size.height) : FALLBACK_SHORTER_SIDE;
}

/**
 * Whether the bubble's size, rounding and mirror may change: between recordings, the camera off included (2026-10-22,
 * at the maintainer's request), and locked with the Camera picker while one records (plan 097: chosen before
 * recording). Its place is dragged at any time.
 */
export function cameraShapeEnabled(ctx: AppContext, unlocked: boolean): boolean {
  return ctx.camera !== undefined && unlocked;
}

/**
 * The camera's row under its switch in Recording settings (plan 075, step 7): the device (D9), locked while recording
 * as the microphone's, with the way to the Recording Studio, where the bubble is placed and shaped (D19).
 */
export function cameraGroups(ctx: AppContext, unlocked: boolean): Group[] {
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
  // The camera's live picture (plan 097, D4): opened only by Test camera, until pressed again or the tab is left, so
  // visiting the tab turns on no camera light. Between recordings, the camera on and allowed: a recording holds it.
  const granted = camera.access === undefined || camera.access === "granted";
  const test: Group = { ...group("cameraTest", t("Test camera", language), unlocked && camera.enabled && granted, []), control: "cameraTest",
    cameraTest: { ...(stored && !missing ? { name: stored.label } : {}) },
    ...(unlocked ? {} : { note: t("While recording, the Recording Studio shows the camera.", language), noteKind: "status" as const }) };
  // Its place and shape are the Recording Studio's (D19), one step away, whether the device may change now or not.
  const studio: Group = { ...group("cameraStudio", t("Bubble position and shape", language), true,
    [{ id: "openStudio", label: t("Arrange in Recording Studio…", language), enabled: true, checked: false, action: "openStudio" }]), kind: "actions" };
  return [device, test, studio];
}

/** The bubble's size, shape, rounding and mirror (D1–D3, D8), in the Recording Studio's Camera picker, between recordings (plan 097). */
export function cameraShapeGroups(ctx: AppContext, unlocked: boolean): Group[] {
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
 * composed, which can be dragged there; while a session makes one, the engine's preview of the picture. The bubble can
 * be dragged only where the preview shows the camera (plan 097): its picture, or before it (Live preview off, the camera
 * starting) the glass bubble; with the camera off or hidden from the recording there is nothing to drag. None without a
 * display to show.
 */
export function cameraPreviewGroup(ctx: AppContext): Group | undefined {
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
  // A session runs, its picture shown or not: the bubble is then the session's camera, or nothing.
  const session = showing || hidden;
  const mode = showing ? "recording" : !camera.enabled || !granted || session ? "off" : "live";
  // While the engine's picture is shown, a word only when the camera gives none (plan 090); nothing while it is hidden.
  const missing = camera.session && !camera.session.hidden ? camera.session.state : undefined;
  // The Camera picker says the camera's state (plan 097, D2); the stage says only what its own picture lacks.
  const status = showing ? undefined : hidden ? t("Live preview is off.", language) : undefined;
  // What the Studio's Check camera view (plan 094) says when it has no camera to enlarge: why, in a session's picture
  // too, where it keeps the camera's own state (plan 090) since it shows that camera alone.
  const cameraStatus = !showing ? (status ?? (!camera.enabled ? t("Turn on Camera to see it here.", language)
      : !granted ? t("Allow camera access to see it here.", language) : undefined))
    : !camera.session ? (camera.enabled ? t("The camera joins from the next recording.", language) : t("Turn on Camera to see it here.", language))
    : camera.session.hidden ? t("The camera is hidden from the recording.", language)
    : missing === "waiting" ? t("Waiting for the camera…", language) : missing === "notReady" ? t("The camera is not ready.", language)
    : missing === "lost" ? t("The camera dropped out. Reconnecting…", language) : undefined;
  const id = `${x},${y}`;
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
      // The bubble rule (plan 097): a session's camera unless hidden from the recording; before a session the camera on.
      composed: session ? camera.session !== undefined && !camera.session.hidden : camera.enabled,
      x, y,
      ...(status ? { status } : {}),
      ...(cameraStatus ? { cameraStatus } : {}),
      ...(showing && missing ? { cameraAwaited: true } : {}),
    },
  };
}

/** The display a recording would capture now, which the preview shows; none when it cannot be found. */
export function previewDisplay(ctx: AppContext): DisplayInfo | undefined {
  const resolution = displayResolution(ctx.displays, ctx.display);
  return resolution.ok ? ctx.displays.find((display) => display.id === resolution.id) : undefined;
}

/** A position the preview sends, `x,y`, each a fraction from 0 to 1; anything else is refused. */
export function previewPosition(choice: unknown): { x: number; y: number } | undefined {
  if (typeof choice !== "string" || !/^(0|1|0?\.\d{1,6}|1\.0{1,6}),(0|1|0?\.\d{1,6}|1\.0{1,6})$/.test(choice)) return undefined;
  const [x, y] = choice.split(",").map(Number) as [number, number];
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : undefined;
}
