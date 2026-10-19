/**
 * Messages exchanged over the parent port between main and the native engine's capture host, a `utilityProcess`
 * (plan 076; docs/system-design/recording.md). Hand-written type guards; there are only a few shapes.
 * This module must not import Electron.
 */
import { isCaptureReport, isQualitySettings, type CaptureReport, type QualitySettings } from "./quality";
import type { ErrorCode } from "./state";
import { isGainDb } from "./audio-gain";

/** MP4 (H.264 + AAC) is the only output (docs/system-design/decisions.md, "H.264/AAC MP4"). */
export const OUTPUT_MIME_TYPE = "video/mp4;codecs=avc1,mp4a.40.2";

/**
 * The failures a live capture host can observe. Folder, disk, deadline, host
 * supervision and launch-time codes are main's own findings, so a host that
 * sends one is malformed rather than believed.
 */
export const HOST_ERROR_CODES = [
  "permission_denied",
  "no_display",
  "no_audio_track",
  "microphone_unavailable",
  "camera_unavailable",
  "media_components_missing",
  "capture_start_failed",
  "capture_failed",
] as const satisfies readonly ErrorCode[];
export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

function isHostErrorCode(value: unknown): value is HostErrorCode {
  return typeof value === "string" && (HOST_ERROR_CODES as readonly string[]).includes(value);
}

/** A capture host that could not start for a reason with its own code, as `media_components_missing` (plan 078). */
export class HostStartError extends Error {
  constructor(readonly code: HostErrorCode, message: string) {
    super(message);
    this.name = "HostStartError";
  }
}

/**
 * The capture host's exit code when the engine could not be loaded because Windows lacks its media components (an N
 * edition without the Media Feature Pack has no mfplat.dll, which the engine links).
 */
export const MEDIA_COMPONENTS_MISSING_EXIT = 4;

/** Whether the microphone is mixed into the track (plan 074), and which one: absent `deviceId` is the system default input. */
export interface MicrophoneChoice {
  enabled: boolean;
  /** AVCaptureDevice's unique ID on macOS, the endpoint ID on Windows, as `microphones` listed it. */
  deviceId?: string;
}

/** An audio input the engine listed (plan 074). */
export interface MicrophoneDevice {
  id: string;
  name: string;
  /** The system's default input now. */
  default: boolean;
}

/** A camera the engine listed (plan 075, D9): AVCaptureDevice's unique ID, its name, and whether it is the default. */
export type CameraDevice = MicrophoneDevice;

/** What the native engine's host needs beyond the quality: the display main resolved, the file it opened and what to leave out. */
export interface NativeStart {
  /** The display to record: its CGDirectDisplayID on macOS, Electron's display id elsewhere. */
  displayId: number;
  /** A point on that display in physical screen pixels: how the engine finds it on Windows (plan 076, step 3). */
  displayPoint?: { x: number; y: number };
  /** The empty temporary file main created; the engine writes it. */
  recordingPath: string;
  /** RecordStuff's processes, main first: their windows and sound are left out of the recording. */
  ownPids: number[];
  /** Leave the menu bar, Dock, desktop icons and widgets out (plan 076, D6). */
  hideSystemUi: boolean;
  /** Mix the microphone in (plan 074); absent is off. */
  microphone?: MicrophoneChoice;
  /** Compose the camera into the frames (plan 075); absent is off. */
  camera?: CameraChoice;
}

/**
 * The camera composed into a recording (plan 075): which one, and its bubble on the recorded display, in the
 * fractions of src/shared/camera-layout.ts (the position the one kept for that display).
 */
export interface CameraChoice {
  /** AVCaptureDevice's unique ID; absent is the system's default camera. */
  deviceId?: string;
  width: number;
  height: number;
  rounding: number;
  x: number;
  y: number;
  mirror: boolean;
}

export type MainMessage =
  /**
   * Prepare capture: the display, the encoders and the file, not yet recording. `quality` is main's snapshot for this
   * session; the host never reads settings itself. `native` carries what the engine needs besides.
   */
  | { type: "start"; sessionId: string; quality: QualitySettings; native?: NativeStart }
  /** Begin encoding the prepared session (plan 040); refused for any other session. */
  | { type: "record"; sessionId: string }
  | { type: "stop"; sessionId: string }
  /** List the audio inputs (plan 074); answered with `microphones`. Only to a host with no session. */
  | { type: "listMicrophones" }
  /** List the cameras (plan 075); answered with `cameras`. Only to a host with no session. */
  | { type: "listCameras" }
  /**
   * The camera's bubble and whether it is shown, for the session's next frames (plan 075, D7 and D13); answered with
   * nothing. `camera.deviceId` is ignored: the camera is not switched while recording.
   */
  | { type: "cameraLayout"; sessionId: string; camera: CameraChoice; hidden: boolean }
  /** Whether the session's preview is watched (plan 075 step 7): Settings shows it, so its frames are made. */
  | { type: "cameraPreview"; sessionId: string; watching: boolean }
  /** Whether the session's levels are watched, and which inputs are muted from their next sound on (plan 075, D19). */
  | { type: "levels"; sessionId: string; watching: boolean }
  | { type: "mute"; sessionId: string; system: boolean; microphone: boolean }
  /** The inputs' volumes in dB from their next sound on (plan 075, D21), within the faders' range. */
  | { type: "gain"; sessionId: string; system: number; microphone: number }
  /**
   * Record another microphone from now on (plan 079, D3): absent `deviceId` is the system default input. Answered with
   * `microphoneSwitched`, or `microphoneSwitchFailed` while the one recorded before goes on.
   */
  | { type: "microphone"; sessionId: string; deviceId?: string }
  /**
   * Settings' monitor process (plan 079): follow the device list, answered with `microphones` whenever it changes (D2),
   * and read the input level meter's device, absent `deviceId` the system default (D1), or stop reading it. Only to a
   * host with no session.
   */
  | { type: "watchDevices"; watching: boolean }
  | { type: "meter"; watching: boolean; deviceId?: string }
  | { type: "ping" };

/** Write failures the native engine, which writes the file itself (plan 076, D3), reports. */
export const ENGINE_WRITE_ERROR_CODES = ["disk_full", "output_write_failed"] as const satisfies readonly ErrorCode[];
export type EngineWriteErrorCode = (typeof ENGINE_WRITE_ERROR_CODES)[number];

/** What the native engine reports once it finished the file: its size, and why it stayed fragmented, if it did. */
export interface EngineFileReport {
  bytes: number;
  finalizeMs: number;
  fragmented?: string;
}

export type HostMessage =
  | { type: "ready" }
  /** Capture is prepared and not recording; `capture` is what the tracks reported and what the encoder was asked for. */
  | { type: "prepared"; sessionId: string; mimeType: string; capture: CaptureReport }
  /** Recording began; the capture report was already sent in `prepared`. */
  | { type: "started"; sessionId: string }
  | { type: "stopped"; sessionId: string; tracksStoppedAt?: number }
  /**
   * After `stopped`: the file is finished. The engine finishes it after capture stopped, so a slow
   * volume's save is no part of the stop; a `writeError` instead says why it could not be.
   */
  | { type: "finished"; sessionId: string; file: EngineFileReport }
  | { type: "error"; sessionId: string; code: HostErrorCode; detail: string; displayFailure?: "track_ended" }
  /** Media is still being written, `bytes` so far; what the stall guard watches. */
  | { type: "progress"; sessionId: string; bytes: number }
  /** Writing the file failed; what was written is kept. */
  | { type: "writeError"; sessionId: string; code: EngineWriteErrorCode; detail: string }
  /** The microphone stopped while recording (plan 074): the recording goes on with system audio only. */
  | { type: "microphoneLost"; sessionId: string; detail: string }
  /** The microphone told lost delivers sound again, which the track takes from then on (plan 074). */
  | { type: "microphoneResumed"; sessionId: string; detail: string }
  /** The camera stopped delivering while recording, and the recording goes on without it (plan 075, D12). */
  | { type: "cameraLost"; sessionId: string; detail: string }
  /** The camera told lost delivers again and is composed again. */
  | { type: "cameraResumed"; sessionId: string; detail: string }
  /** The inputs' loudest samples since the last (plan 075, D19), linear, about 15 times a second while watched. */
  | { type: "levels"; sessionId: string; system: number; microphone?: number }
  /** The microphone switched to while recording (plan 079, D3), by the names of the device before and the one now. */
  | { type: "microphoneSwitched"; sessionId: string; from: string; to: string }
  /** A switch the device refused; the microphone recorded before goes on. */
  | { type: "microphoneSwitchFailed"; sessionId: string; detail: string }
  /** The input level meter's device (plan 079, D1), once it reads it; its peak and RMS 20 times a second, linear. */
  | { type: "meterStarted"; device: string }
  | { type: "meterLevel"; peak: number; rms: number }
  /** The meter could not read its device, or stopped reading it (it left, or the system moved it). */
  | { type: "meterStopped"; error: string }
  /** The answer to `listMicrophones`: the inputs, or why they could not be listed. */
  | { type: "microphones"; devices: MicrophoneDevice[] }
  | { type: "microphones"; error: string }
  | { type: "cameras"; devices: CameraDevice[] }
  | { type: "cameras"; error: string }
  | { type: "pong" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPoint(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && Number.isInteger(value["x"]) && Number.isInteger(value["y"]);
}

function isCameraChoice(value: unknown): value is CameraChoice {
  if (!isRecord(value) || typeof value["mirror"] !== "boolean" || (value["deviceId"] !== undefined && !isNonEmptyString(value["deviceId"]))) return false;
  const inRange = (key: string, min: number, max: number): boolean =>
    typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) >= min && (value[key] as number) <= max;
  return inRange("width", 0, 1) && inRange("height", 0, 1) && inRange("rounding", 0, 1) && inRange("x", 0, 1) && inRange("y", 0, 1);
}

function isMicrophoneChoice(value: unknown): value is MicrophoneChoice {
  return isRecord(value) && typeof value["enabled"] === "boolean" && (value["deviceId"] === undefined || isNonEmptyString(value["deviceId"]));
}

function isMicrophoneDevice(value: unknown): value is MicrophoneDevice {
  return isRecord(value) && isNonEmptyString(value["id"]) && typeof value["name"] === "string" && typeof value["default"] === "boolean";
}

function isNativeStart(value: unknown): value is NativeStart {
  return isRecord(value) && typeof value["displayId"] === "number" && Number.isInteger(value["displayId"]) &&
    (value["displayPoint"] === undefined || isPoint(value["displayPoint"])) &&
    isNonEmptyString(value["recordingPath"]) &&
    Array.isArray(value["ownPids"]) && value["ownPids"].every((pid) => typeof pid === "number" && Number.isInteger(pid)) &&
    typeof value["hideSystemUi"] === "boolean" &&
    (value["microphone"] === undefined || isMicrophoneChoice(value["microphone"])) &&
    (value["camera"] === undefined || isCameraChoice(value["camera"]));
}

function isEngineFileReport(value: unknown): value is EngineFileReport {
  return isRecord(value) && typeof value["bytes"] === "number" && Number.isFinite(value["bytes"]) &&
    typeof value["finalizeMs"] === "number" && Number.isFinite(value["finalizeMs"]) &&
    (value["fragmented"] === undefined || typeof value["fragmented"] === "string");
}

export function isMainMessage(value: unknown): value is MainMessage {
  if (!isRecord(value)) return false;
  switch (value["type"]) {
    case "start":
      return isNonEmptyString(value["sessionId"]) && isQualitySettings(value["quality"]) &&
        (value["native"] === undefined || isNativeStart(value["native"]));
    case "record":
    case "stop":
      return isNonEmptyString(value["sessionId"]);
    case "cameraLayout":
      return isNonEmptyString(value["sessionId"]) && isCameraChoice(value["camera"]) && typeof value["hidden"] === "boolean";
    case "cameraPreview":
    case "levels":
      return isNonEmptyString(value["sessionId"]) && typeof value["watching"] === "boolean";
    case "mute":
      return isNonEmptyString(value["sessionId"]) && typeof value["system"] === "boolean" && typeof value["microphone"] === "boolean";
    case "gain":
      return isNonEmptyString(value["sessionId"]) && isGainDb(value["system"]) && isGainDb(value["microphone"]);
    case "microphone":
      return isNonEmptyString(value["sessionId"]) && (value["deviceId"] === undefined || isNonEmptyString(value["deviceId"]));
    case "watchDevices":
      return typeof value["watching"] === "boolean";
    case "meter":
      return typeof value["watching"] === "boolean" && (value["deviceId"] === undefined || isNonEmptyString(value["deviceId"]));
    case "listMicrophones":
    case "listCameras":
    case "ping":
      return true;
    default:
      return false;
  }
}

/** A peak level: finite, from silence to well past full scale (a sum before the limiter). */
const isLevel = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 16;

export function isHostMessage(value: unknown): value is HostMessage {
  if (!isRecord(value)) return false;
  switch (value["type"]) {
    case "ready":
    case "pong":
      return true;
    case "prepared":
      return (
        isNonEmptyString(value["sessionId"]) &&
        typeof value["mimeType"] === "string" &&
        isCaptureReport(value["capture"])
      );
    case "started":
      return isNonEmptyString(value["sessionId"]);
    case "stopped":
      return isNonEmptyString(value["sessionId"]) &&
        (value["tracksStoppedAt"] === undefined ||
          (typeof value["tracksStoppedAt"] === "number" && Number.isFinite(value["tracksStoppedAt"])));
    case "finished":
      return isNonEmptyString(value["sessionId"]) && isEngineFileReport(value["file"]);
    case "progress":
      return isNonEmptyString(value["sessionId"]) && typeof value["bytes"] === "number" && Number.isFinite(value["bytes"]) && value["bytes"] >= 0;
    case "writeError":
      return isNonEmptyString(value["sessionId"]) &&
        (ENGINE_WRITE_ERROR_CODES as readonly unknown[]).includes(value["code"]) &&
        typeof value["detail"] === "string";
    case "microphoneLost":
    case "microphoneResumed":
    case "cameraLost":
    case "cameraResumed":
      return isNonEmptyString(value["sessionId"]) && typeof value["detail"] === "string";
    case "levels":
      return isNonEmptyString(value["sessionId"]) && isLevel(value["system"]) && (value["microphone"] === undefined || isLevel(value["microphone"]));
    case "microphoneSwitched":
      return isNonEmptyString(value["sessionId"]) && typeof value["from"] === "string" && typeof value["to"] === "string";
    case "microphoneSwitchFailed":
      return isNonEmptyString(value["sessionId"]) && typeof value["detail"] === "string";
    case "meterStarted":
      return typeof value["device"] === "string";
    case "meterLevel":
      return isLevel(value["peak"]) && isLevel(value["rms"]);
    case "meterStopped":
      return typeof value["error"] === "string";
    case "microphones":
    case "cameras":
      return Array.isArray(value["devices"]) ? value["devices"].every(isMicrophoneDevice) && value["error"] === undefined
        : typeof value["error"] === "string";
    case "error":
      return (
        isNonEmptyString(value["sessionId"]) &&
        isHostErrorCode(value["code"]) &&
        typeof value["detail"] === "string" &&
        (value["displayFailure"] === undefined || value["displayFailure"] === "track_ended")
      );
    default:
      return false;
  }
}
