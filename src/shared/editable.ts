/**
 * An editable recording (plan 087): the screen, each sound input and the camera on tracks of their own, which the edit
 * view lets the user place and mix after recording, and the export renders into an ordinary MP4. The engine writes a
 * description into the file (native/capture/src/editable.rs) that says it is one, which input each sound track holds
 * and where the camera's bubble was when the recording started; main reads it from the engine's plan and checks it
 * here, never trusting its shape.
 *
 * The edit's scene is what the user chooses: the bubble's place and size over the picture, whether it is shown, and
 * each input's volume. Its shape (rounding, mirror) stays the recording's. Volumes are the Studio's percent
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

/** The camera as the edit places it: the bubble's place and size, and whether it is in the export. */
export interface SceneCamera {
  x: number;
  y: number;
  width: number;
  height: number;
  shown: boolean;
}

/** What an edit chooses for an editable recording besides its cuts. */
export interface EditScene {
  /** Absent for a recording without a camera. */
  camera?: SceneCamera;
  volumes: AudioVolume;
}

export function isSceneCamera(value: unknown): value is SceneCamera {
  if (!isRecord(value)) return false;
  const { x, y, width, height, shown } = value;
  return isCameraPosition({ x, y }) && isSize(width) && isSize(height) && typeof shown === "boolean";
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

/** `scene` fitted to `description`: a camera only when the recording has one. */
export function fitScene(scene: EditScene, description: EditableDescription): EditScene {
  const fallback = defaultScene(description);
  return { ...(description.camera ? { camera: scene.camera ?? fallback.camera! } : {}), volumes: { ...scene.volumes } };
}

/** What the engine's rendered export takes (export_api.rs `ExportRender`). */
export interface ExportRender {
  /** The bubble to compose, in the camera layout's fractions; absent leaves the camera out. */
  camera?: EditableCamera;
  /** Each sound track's volume in dB, in the file's order. */
  volumesDb: number[];
}

/** The engine's request for `scene` on a recording `description` describes. */
export function exportRender(description: EditableDescription, scene: EditScene): ExportRender {
  const camera = description.camera && scene.camera?.shown
    ? { width: scene.camera.width, height: scene.camera.height, rounding: description.camera.rounding, x: scene.camera.x, y: scene.camera.y, mirror: description.camera.mirror }
    : undefined;
  const percent = (sound: EditableSound): number => (sound === "microphone" ? scene.volumes.microphone : sound === "system" ? scene.volumes.system : 100);
  return { ...(camera ? { camera } : {}), volumesDb: description.sounds.map((sound) => volumeDb(percent(sound))) };
}

export function isExportRender(value: unknown): value is ExportRender {
  if (!isRecord(value)) return false;
  const camera = value["camera"];
  const volumes = value["volumesDb"];
  const cameraOk = camera === undefined || (isRecord(camera) && isSize(camera["width"]) && isSize(camera["height"]) && finite(camera["rounding"])
    && (camera["rounding"] as number) >= 0 && (camera["rounding"] as number) <= 1 && isCameraPosition({ x: camera["x"], y: camera["y"] })
    && typeof camera["mirror"] === "boolean");
  return cameraOk && Array.isArray(volumes) && volumes.length <= 2 && volumes.every(isGainDb);
}
