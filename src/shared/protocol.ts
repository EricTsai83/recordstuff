/**
 * Messages exchanged over the MessagePort between main and the hidden capture
 * host (docs/system-design/recording.md). Hand-written type guards; there are only a few shapes.
 * This module must not import Electron.
 */
import { isCaptureReport, isQualitySettings, type CaptureReport, type QualitySettings } from "./quality";
import { isErrorCode, type ErrorCode } from "./state";

/** MP4 (H.264 + AAC) is the only output (docs/system-design/decisions.md, "H.264/AAC MP4"). */
export const OUTPUT_MIME_TYPE = "video/mp4;codecs=avc1,mp4a.40.2";

/** Nominal MediaRecorder slice/keyframe interval; actual delivery can be delayed. */
export const CHUNK_INTERVAL_MS = 1000;

/**
 * Main hands the capture page its MessagePort on this channel, and the preload
 * forwards it to the page as this message; the preload keeps its own copy
 * because a sandboxed preload imports nothing at runtime (src/preload/channels.test.ts).
 */
export const CAPTURE_HOST_PORT_CHANNEL = "capture-host-port";

export type MainMessage =
  /**
   * Prepare capture: stream, checks, quality and an inactive MediaRecorder.
   * `quality` is main's snapshot for this session; the host never reads settings itself.
   */
  | { type: "start"; sessionId: string; quality: QualitySettings }
  /** Begin encoding the prepared session (plan 040); refused for any other session. */
  | { type: "record"; sessionId: string }
  | { type: "stop"; sessionId: string }
  | { type: "ping" };

export type HostMessage =
  | { type: "ready" }
  /** Capture is prepared and not recording; `capture` is what the tracks reported and what the encoder was asked for. */
  | { type: "prepared"; sessionId: string; mimeType: string; capture: CaptureReport }
  /** MediaRecorder started; the capture report was already sent in `prepared`. */
  | { type: "started"; sessionId: string }
  /** `bytes` is structured-cloned, never transferred: see `enqueueChunk` in src/renderer/capture-host.ts. */
  | { type: "chunk"; sessionId: string; seq: number; bytes: ArrayBuffer }
  | { type: "stopped"; sessionId: string; tracksStoppedAt?: number }
  | { type: "error"; sessionId?: string; code: ErrorCode; detail: string; displayFailure?: "track_ended" }
  | { type: "pong" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isMainMessage(value: unknown): value is MainMessage {
  if (!isRecord(value)) return false;
  switch (value["type"]) {
    case "start":
      return isNonEmptyString(value["sessionId"]) && isQualitySettings(value["quality"]);
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
    case "error":
      return (
        (value["sessionId"] === undefined || isNonEmptyString(value["sessionId"])) &&
        isErrorCode(value["code"]) &&
        // Only launch-time evidence can report a terminated app, never a live host.
        value["code"] !== "app_terminated" &&
        typeof value["detail"] === "string" &&
        (value["displayFailure"] === undefined || value["displayFailure"] === "track_ended")
      );
    default:
      return false;
  }
}
