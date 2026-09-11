/**
 * Messages exchanged over the MessagePort between main and the hidden capture
 * host (plans/001-first-version.md §9). Hand-written type guards; there are only a few shapes.
 * This module must not import Electron.
 */
import { isErrorCode, type ErrorCode } from "./state";

/** MP4 (H.264 + AAC) is the only output the first version produces (ADR-3). */
export const OUTPUT_MIME_TYPE = "video/mp4;codecs=avc1,mp4a.40.2";

/** MediaRecorder timeslice: at most one second of media is ever at risk. */
export const CHUNK_INTERVAL_MS = 1000;

export type MainMessage =
  | { type: "start"; sessionId: string }
  | { type: "stop"; sessionId: string }
  | { type: "ping" };

export type HostMessage =
  | { type: "ready" }
  | { type: "started"; sessionId: string; mimeType: string }
  /** `bytes` is structured-cloned (see capture-host.ts for why not transferred). */
  | { type: "chunk"; sessionId: string; seq: number; bytes: ArrayBuffer }
  | { type: "stopped"; sessionId: string }
  | { type: "error"; sessionId?: string; code: ErrorCode; detail: string }
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
      return isNonEmptyString(value["sessionId"]) && typeof value["mimeType"] === "string";
    case "chunk":
      return (
        isNonEmptyString(value["sessionId"]) &&
        typeof value["seq"] === "number" &&
        Number.isInteger(value["seq"]) &&
        value["seq"] >= 0 &&
        value["bytes"] instanceof ArrayBuffer
      );
    case "stopped":
      return isNonEmptyString(value["sessionId"]);
    case "error":
      return (
        (value["sessionId"] === undefined || isNonEmptyString(value["sessionId"])) &&
        isErrorCode(value["code"]) &&
        typeof value["detail"] === "string"
      );
    default:
      return false;
  }
}
