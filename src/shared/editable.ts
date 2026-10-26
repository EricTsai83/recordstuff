/**
 * An editable recording (plan 087): the screen, each sound input and the camera on tracks of their own, which the edit
 * view lets the user place and mix after recording, and the export renders into an ordinary MP4. The engine writes a
 * description into the file (native/capture/src/editable.rs) that says it is one, which input each sound track holds
 * and where the camera's bubble was when the recording started; main reads it from the engine's plan and checks it
 * here, never trusting its shape.
 *
 * The edit's scene is what the user chooses: the bubble's place and size over the picture, when it is shown, and each
 * input's volume. Since 2026-10-26 (the maintainer's request) the camera can be hidden over any stretches of the
 * recording, not only throughout: `hidden` lists them in the video's timescale, as the cuts count, on the recording's
 * own clock (a stretch stays where it is when a cut before it is removed or kept again). Its shape (rounding, mirror) stays the recording's. Volumes are the Studio's percent
 * (audio-volume.ts) applied to what was recorded, which already holds the volumes set while recording, so 100% leaves
 * a track as it was recorded.
 */
import { CAMERA_MAX_SIZE, CAMERA_MIN_SIZE, isCameraPosition } from "./camera-layout";
import { DEFAULT_AUDIO_VOLUME, isGainDb, isVolume, volumeDb, type AudioVolume } from "./audio-volume";

/** What a sound track holds. */
export type EditableSound = "system" | "microphone" | "silent";
const SOUNDS: readonly EditableSound[] = ["system", "microphone", "silent"];

/** The camera's bubble as the recording set it: sizes as fractions of the shorter side, the position of the free space. */
export interface EditableCamera {
  width: number;
  height: number;
  rounding: number;
  x: number;
  y: number;
  mirror: boolean;
}

export interface EditableDescription {
  /** The file's sound tracks, in order: the first plays with the picture in any player, the second only in the edit. */
  sounds: EditableSound[];
  /** Where the bubble was when the recording started; null without a camera track. */
  camera: EditableCamera | null;
}

/** The largest description read, as the engine's `MAX_BYTES`. */
export const EDITABLE_DESCRIPTION_LIMIT = 4096;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function isSize(value: unknown): value is number {
  return finite(value) && value >= CAMERA_MIN_SIZE && value <= CAMERA_MAX_SIZE;
}

/** A description the engine wrote (version 1), or undefined for anything else: absent, too large or malformed. */
export function parseEditableDescription(text: string | undefined | null): EditableDescription | undefined {
  if (typeof text !== "string" || text.length > EDITABLE_DESCRIPTION_LIMIT) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(value) || value["version"] !== 1) return undefined;
  const sounds = value["sounds"];
  if (!Array.isArray(sounds) || sounds.length < 1 || sounds.length > 2 || !sounds.every((s) => (SOUNDS as readonly unknown[]).includes(s))) return undefined;
  const camera = value["camera"];
  if (camera === null || camera === undefined) return { sounds: sounds as EditableSound[], camera: null };
  if (!isRecord(camera)) return undefined;
  const { width, height, rounding, x, y, mirror } = camera;
  if (!isSize(width) || !isSize(height) || !finite(rounding) || rounding < 0 || rounding > 1 || !isCameraPosition({ x, y }) || typeof mirror !== "boolean") return undefined;
  return { sounds: sounds as EditableSound[], camera: { width, height, rounding, x: x as number, y: y as number, mirror } };
}

/** A stretch of the recording, `[from, to)` in the video's timescale (shared/editing.ts `EditRange`). */
export type TimeRange = [number, number];

/** The most stretches the camera may be hidden over, as many as the cuts (shared/editing.ts `MAX_EDIT_RANGES`). */
export const MAX_CAMERA_HIDDEN = 256;

/**
 * The camera as the edit places it: the bubble's place and size, and when it is in the export. `shown: false` leaves it
 * out throughout (the options' Hide the camera throughout, 2026-10-26: a switch over the stretches, which it keeps, so
 * switched back the timeline's stretches return); shown, it is left out over `hidden`'s stretches only (absent or empty:
 * shown throughout). The stretches are kept sorted, merged and within the recording (`withCameraHidden`).
 */
export interface SceneCamera {
  x: number;
  y: number;
  width: number;
  height: number;
  shown: boolean;
  hidden?: TimeRange[];
}

/** What an edit chooses for an editable recording besides its cuts. */
export interface EditScene {
  /** Absent for a recording without a camera. */
  camera?: SceneCamera;
  volumes: AudioVolume;
}

const isTick = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isHidden(value: unknown): value is TimeRange[] {
  return Array.isArray(value) && value.length <= MAX_CAMERA_HIDDEN
    && value.every((range) => Array.isArray(range) && range.length === 2 && isTick(range[0]) && isTick(range[1]) && range[0] < range[1]);
}

export function isSceneCamera(value: unknown): value is SceneCamera {
  if (!isRecord(value)) return false;
  const { x, y, width, height, shown, hidden } = value;
  return isCameraPosition({ x, y }) && isSize(width) && isSize(height) && typeof shown === "boolean" && (hidden === undefined || isHidden(hidden));
}

/** Sorted, merged stretches, each within `[0, duration]` when a duration is given, without empty ones. */
export function mergeRanges(ranges: readonly TimeRange[], duration = Number.POSITIVE_INFINITY): TimeRange[] {
  const sorted = ranges
    .map(([from, to]): TimeRange => [Math.max(0, from), Math.min(duration, to)])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: TimeRange[] = [];
  for (const [from, to] of sorted) {
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** `ranges` without `cut`. */
export function subtractRange(ranges: readonly TimeRange[], [cutFrom, cutTo]: TimeRange): TimeRange[] {
  const out: TimeRange[] = [];
  for (const [from, to] of ranges) {
    if (to <= cutFrom || from >= cutTo) out.push([from, to]);
    else {
      if (from < cutFrom) out.push([from, cutFrom]);
      if (to > cutTo) out.push([cutTo, to]);
    }
  }
  return out;
}

/** Where `camera` is left out of a recording `duration` long (the video's timescale): every stretch, sorted and apart. */
export function cameraHidden(camera: SceneCamera, duration: number): TimeRange[] {
  if (!camera.shown) return duration > 0 ? [[0, duration]] : [];
  return cameraStretches(camera, duration);
}

/** The stretches the timeline hides `camera` over, whether or not it is hidden throughout meanwhile. */
export function cameraStretches(camera: SceneCamera, duration: number): TimeRange[] {
  return mergeRanges(camera.hidden ?? [], duration);
}

/** Whether `camera` is in the picture at `time` (the video's timescale). */
export function cameraShownAt(camera: SceneCamera, time: number): boolean {
  if (!camera.shown) return false;
  return !(camera.hidden ?? []).some(([from, to]) => time >= from && time < to);
}

/**
 * `camera` with the timeline's stretches `ranges` of a recording `duration` long: sorted, merged and within it, at most
 * `MAX_CAMERA_HIDDEN` of them, and no `hidden` at all for none. Whether it is hidden throughout (`shown`) is kept.
 */
export function withCameraHidden(camera: SceneCamera, ranges: readonly TimeRange[], duration: number): SceneCamera {
  const hidden = mergeRanges(ranges, duration).slice(0, MAX_CAMERA_HIDDEN);
  const { hidden: _left, ...place } = camera;
  return hidden.length === 0 ? place : { ...place, hidden };
}

export function isEditScene(value: unknown): value is EditScene {
  if (!isRecord(value)) return false;
  const volumes = value["volumes"];
  return (value["camera"] === undefined || isSceneCamera(value["camera"]))
    && isRecord(volumes) && isVolume(volumes["system"]) && isVolume(volumes["microphone"]);
}

/** The scene an edit starts from: the camera where the recording put it, shown, and each track as recorded. */
export function defaultScene(description: EditableDescription): EditScene {
  const camera = description.camera;
  return {
    ...(camera ? { camera: { x: camera.x, y: camera.y, width: camera.width, height: camera.height, shown: true } } : {}),
    volumes: { ...DEFAULT_AUDIO_VOLUME },
  };
}

/**
 * `scene` fitted to `description`: a camera only when the recording has one. Given the recording's `duration`, the
 * camera's hidden stretches are also kept within it, sorted and merged (`withCameraHidden`).
 */
export function fitScene(scene: EditScene, description: EditableDescription, duration?: number): EditScene {
  const fallback = defaultScene(description);
  let camera = description.camera ? scene.camera ?? fallback.camera! : undefined;
  if (camera && duration !== undefined && duration > 0) camera = withCameraHidden(camera, camera.hidden ?? [], duration);
  return { ...(camera ? { camera } : {}), volumes: { ...scene.volumes } };
}

/** What the engine's rendered export takes (export_api.rs `ExportRender`). */
export interface ExportRender {
  /** The bubble to compose, in the camera layout's fractions; absent leaves the camera out. */
  camera?: EditableCamera;
  /** Where the bubble is left out though composed elsewhere, in the video's timescale on the recording's clock. */
  cameraHidden?: Array<{ from: number; to: number }>;
  /** Each sound track's volume in dB, in the file's order. */
  volumesDb: number[];
}

/** The engine's request for `scene` on a recording `description` describes. */
export function exportRender(description: EditableDescription, scene: EditScene): ExportRender {
  const camera = description.camera && scene.camera?.shown
    ? { width: scene.camera.width, height: scene.camera.height, rounding: description.camera.rounding, x: scene.camera.x, y: scene.camera.y, mirror: description.camera.mirror }
    : undefined;
  const hidden = camera && scene.camera ? mergeRanges(scene.camera.hidden ?? []).map(([from, to]) => ({ from, to })) : [];
  const percent = (sound: EditableSound): number => (sound === "microphone" ? scene.volumes.microphone : sound === "system" ? scene.volumes.system : 100);
  return {
    ...(camera ? { camera } : {}),
    ...(hidden.length > 0 ? { cameraHidden: hidden } : {}),
    volumesDb: description.sounds.map((sound) => volumeDb(percent(sound))),
  };
}

export function isExportRender(value: unknown): value is ExportRender {
  if (!isRecord(value)) return false;
  const camera = value["camera"];
  const volumes = value["volumesDb"];
  const hidden = value["cameraHidden"];
  const hiddenOk = hidden === undefined || (Array.isArray(hidden) && hidden.length <= MAX_CAMERA_HIDDEN
    && hidden.every((range) => isRecord(range) && isTick(range["from"]) && isTick(range["to"]) && range["from"] < range["to"]));
  const cameraOk = camera === undefined || (isRecord(camera) && isSize(camera["width"]) && isSize(camera["height"]) && finite(camera["rounding"])
    && (camera["rounding"] as number) >= 0 && (camera["rounding"] as number) <= 1 && isCameraPosition({ x: camera["x"], y: camera["y"] })
    && typeof camera["mirror"] === "boolean");
  return cameraOk && hiddenOk && Array.isArray(volumes) && volumes.length <= 2 && volumes.every(isGainDb);
}
