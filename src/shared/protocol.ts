/**
 * Messages exchanged over the MessagePort between main and the hidden capture
 * host (docs/system-design/recording.md). Hand-written type guards; there are only a few shapes.
 * This module must not import Electron.
 */
import { isCaptureReport, isQualitySettings, type CaptureReport, type QualitySettings } from "./quality";
import type { ErrorCode } from "./state";

/** MP4 (H.264 + AAC) is the only output (docs/system-design/decisions.md, "H.264/AAC MP4"). */
export const OUTPUT_MIME_TYPE = "video/mp4;codecs=avc1,mp4a.40.2";

/** Nominal MediaRecorder slice/keyframe interval; actual delivery can be delayed. */
export const CHUNK_INTERVAL_MS = 1000;

/**
 * Encoded bytes the capture page holds as Blobs not yet read and posted; past this
 * the page fails the session with `capture_failed`. A chunk counts until it is
 * posted, not until main has read it: posted messages wait in the port, outside
 * this bound. Main's writer bound, `RECORDING_HEALTH.writerBacklogBytes` (which the
 * page cannot import), counts them once main's handler has appended them.
 */
export const HANDOFF_BACKLOG_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Main hands the capture page its MessagePort on this channel, and the preload
 * forwards it to the page as this message; the preload keeps its own copy
 * because a sandboxed preload imports nothing at runtime (src/preload/channels.test.ts).
 */
export const CAPTURE_HOST_PORT_CHANNEL = "capture-host-port";

/**
 * The failures a live capture host can observe. Folder, disk, deadline, host
 * supervision and launch-time codes are main's own findings, so a host that
 * sends one is malformed rather than believed.
 */
export const HOST_ERROR_CODES = [
  "permission_denied",
  "no_display",
  "no_audio_track",
  "mp4_unsupported",
  "capture_start_failed",
  "capture_failed",
] as const satisfies readonly ErrorCode[];
export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

function isHostErrorCode(value: unknown): value is HostErrorCode {
  return typeof value === "string" && (HOST_ERROR_CODES as readonly string[]).includes(value);
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
}

export type MainMessage =
  /**
   * Prepare capture: stream, checks, quality and an inactive MediaRecorder.
   * `quality` is main's snapshot for this session; the host never reads settings itself.
   * `native` is present only for the native engine's host (plan 076, D7).
   */
  | { type: "start"; sessionId: string; quality: QualitySettings; native?: NativeStart }
  /** Begin encoding the prepared session (plan 040); refused for any other session. */
  | { type: "record"; sessionId: string }
  | { type: "stop"; sessionId: string }
  | { type: "ping" };

/** Write failures the native engine, which writes the file itself (plan 076, D3), reports; the same codes as FileWriter's. */
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
  /** MediaRecorder started; the capture report was already sent in `prepared`. */
  | { type: "started"; sessionId: string }
  /** `bytes` is structured-cloned, never transferred: see `enqueueChunk` in src/renderer/capture/capture-host.ts. */
  | { type: "chunk"; sessionId: string; seq: number; bytes: ArrayBuffer }
  | { type: "stopped"; sessionId: string; tracksStoppedAt?: number }
  /**
   * Native engine only, after `stopped`: the file is finished. The engine finishes it after capture stopped, so a slow
   * volume's save is no part of the stop; a `writeError` instead says why it could not be.
   */
  | { type: "finished"; sessionId: string; file: EngineFileReport }
  | { type: "error"; sessionId: string; code: HostErrorCode; detail: string; displayFailure?: "track_ended" }
  /** Native engine only: media is still being written, `bytes` so far; what the stall guard watches instead of chunks. */
  | { type: "progress"; sessionId: string; bytes: number }
  /** Native engine only: writing the file failed; what was written is kept. */
  | { type: "writeError"; sessionId: string; code: EngineWriteErrorCode; detail: string }
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

function isNativeStart(value: unknown): value is NativeStart {
  return isRecord(value) && typeof value["displayId"] === "number" && Number.isInteger(value["displayId"]) &&
    (value["displayPoint"] === undefined || isPoint(value["displayPoint"])) &&
    isNonEmptyString(value["recordingPath"]) &&
    Array.isArray(value["ownPids"]) && value["ownPids"].every((pid) => typeof pid === "number" && Number.isInteger(pid)) &&
    typeof value["hideSystemUi"] === "boolean";
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
    case "chunk":
      return (
        isNonEmptyString(value["sessionId"]) &&
        typeof value["seq"] === "number" &&
        Number.isInteger(value["seq"]) &&
        value["seq"] >= 0 &&
        value["bytes"] instanceof ArrayBuffer
      );
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
