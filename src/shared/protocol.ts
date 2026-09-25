/**
 * Messages exchanged over the MessagePort between main and the hidden capture
 * host (docs/system-design/recording.md). Hand-written type guards; there are only a few shapes.
 * This module must not import Electron.
 */
import { isCaptureReport, isQualitySettings, type CaptureReport, type QualitySettings } from "./quality";
import { isErrorCode, type ErrorCode } from "./state";

/** MP4 (H.264 + AAC) is the only output the first version produces (ADR-3). */
export const OUTPUT_MIME_TYPE = "video/mp4;codecs=avc1,mp4a.40.2";

/** Nominal MediaRecorder slice/keyframe interval; actual delivery can be delayed. */
export const CHUNK_INTERVAL_MS = 1000;

export type MainMessage =
  /** `quality` is main's snapshot for this session; the host never reads settings itself. */
  | { type: "start"; sessionId: string; quality: QualitySettings }
  | { type: "stop"; sessionId: string }
  | { type: "ping" };

export type HostMessage =
  | { type: "ready" }
  /** `capture` is what the tracks reported and what the encoder was asked for. */
  | { type: "started"; sessionId: string; mimeType: string; capture: CaptureReport }
  /** `bytes` is structured-cloned (see capture-host.ts for why not transferred). */
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
    case "started":
      return (
        isNonEmptyString(value["sessionId"]) &&
        typeof value["mimeType"] === "string" &&
        isCaptureReport(value["capture"])
      );
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
