/**
 * Messages exchanged over the parent port between main and the native engine's capture host, a `utilityProcess`
 * (plan 076; docs/system-design/recording.md). Hand-written type guards; there are only a few shapes.
 * This module must not import Electron.
 */
import { isCaptureReport, isQualitySettings, type CaptureReport, type QualitySettings } from "./quality";
import type { ErrorCode } from "./state";

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
  /** The answer to `listMicrophones`: the inputs, or why they could not be listed. */
  | { type: "microphones"; devices: MicrophoneDevice[] }
  | { type: "microphones"; error: string }
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
    (value["microphone"] === undefined || isMicrophoneChoice(value["microphone"]));
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
    case "listMicrophones":
    case "ping":
      return true;
    default:
      return false;
  }
}

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
      return isNonEmptyString(value["sessionId"]) && typeof value["detail"] === "string";
    case "microphones":
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
