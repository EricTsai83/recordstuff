/**
 * Cutting an existing recording (plan 085): what main, the export worker and the Recordings tab's edit view share. The
 * worker speaks `ExportMainMessage` in and `ExportHostMessage` out over its parent port (main/editing/export-host.ts
 * checks every message it receives); the edit view is drawn from `EditorView` and answers with `EditorChoice`s on the
 * group `recordingEdit:<id>`.
 *
 * Times are integers in the recording's video timescale (90 kHz for every recording the engine writes), as the edit
 * record stores them; the view also gives seconds for the page's player.
 */

import { EDITABLE_DESCRIPTION_LIMIT, isEditScene, isExportRender, mergeRanges, type EditableSound, type EditScene, type ExportRender } from "./editable";

/** A removed range, `[from, to)` in the video's timescale. */
export type EditRange = [number, number];

/** Removed ranges an edit may hold, as the engine allows (native/capture/src/edit/plan.rs `MAX_RANGES`). */
export const MAX_EDIT_RANGES = 256;

/** The plan the engine made for an edit: where each kept part starts and how its join is made. */
export interface ExportPlan {
  timescale: number;
  /** The recording's length, and the export's. */
  duration: number;
  outputDuration: number;
  frames: number;
  /** The removed ranges, snapped to frame starts. */
  removed: Array<{ from: number; to: number }>;
  parts: Array<{ requested: number; start: number; stop: number; outStart: number; fellBack: boolean; reencoded: boolean }>;
  /** Kept ranges left out: no key frame to resume at. */
  dropped: Array<{ from: number; to: number }>;
  secondDescription: boolean;
  hasAudio: boolean;
  /** An editable recording's description as the engine read it (plan 087; editable.ts parses it); absent otherwise. */
  editable?: string | null;
}

export interface ExportResult {
  plan: ExportPlan;
  bytes: number;
  reencodedFrames: number;
  reencodedPackets: number;
}

/** What the engine is asked: `output` only for an export, which must not exist yet. */
export interface ExportRequest {
  source: string;
  output?: string;
  removed: Array<{ from: number; to: number }>;
  /** An editable recording's rendered export (plan 087): the camera's place and the volumes. */
  render?: ExportRender;
}

/**
 * An editable recording's track the edit view plays beside it (plan 087): the camera, or the description's second
 * sound; with a mix (plan 098), its first sound too, since the recording itself then plays the mix.
 */
export type PreviewTrack = "camera" | "firstSound" | "secondSound";
export const PREVIEW_TRACKS: readonly PreviewTrack[] = ["camera", "firstSound", "secondSound"];

/** A track the export worker copies for the preview: the camera, or a disabled sound track by its place (plan 098). */
export type ExtractTrack = "camera" | "sound1" | "sound2";
const EXTRACT_TRACKS: readonly ExtractTrack[] = ["camera", "sound1", "sound2"];

/** Why an export or an inspection failed, as the engine and the worker name it. */
export type ExportFailureCode =
  | "unsupported" | "malformed" | "read_failed" | "nothing_kept" | "too_many_ranges" | "invalid_range" | "cancelled"
  | "encode_failed" | "disk_full" | "output_write_failed" | "output_exists"
  | "export_worker_crashed" | "export_worker_unresponsive" | "export_engine_missing";

export const EXPORT_FAILURE_CODES: readonly ExportFailureCode[] = [
  "unsupported", "malformed", "read_failed", "nothing_kept", "too_many_ranges", "invalid_range", "cancelled",
  "encode_failed", "disk_full", "output_write_failed", "output_exists",
  "export_worker_crashed", "export_worker_unresponsive", "export_engine_missing",
];

export function isExportFailureCode(value: unknown): value is ExportFailureCode {
  return typeof value === "string" && (EXPORT_FAILURE_CODES as readonly string[]).includes(value);
}

export type ExportMainMessage =
  | { type: "inspect"; id: number; request: ExportRequest }
  | { type: "export"; id: number; request: ExportRequest }
  | { type: "cancel" }
  | { type: "ping"; id: number }
  /** `pnpm bench:export`'s speed reference, served only under `EXPORT_BENCH_ENV`; main never sends it. */
  | { type: "copy"; id: number; request: { source: string; output: string } }
  /** Copies an editable recording's track into a file of its own for the edit view's preview (plan 087). */
  | { type: "extract"; id: number; request: { source: string; track: ExtractTrack; output: string } };

/** The worker serves `copy` only with this set to `1` (`pnpm bench:export`). */
export const EXPORT_BENCH_ENV = "RECORDSTUFF_EXPORT_BENCH";

export type ExportHostMessage =
  | { type: "ready" }
  | { type: "pong"; id: number }
  | { type: "inspected"; id: number; plan: ExportPlan }
  | { type: "progress"; id: number; fraction: number }
  | { type: "exported"; id: number; result: ExportResult }
  | { type: "failed"; id: number; code: ExportFailureCode; detail: string }
  | { type: "copied"; id: number; bytes: number }
  | { type: "extracted"; id: number; bytes: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isSpan = (value: unknown): value is { from: number; to: number } => isRecord(value) && isTime(value["from"]) && isTime(value["to"]);

function isPlan(value: unknown): value is ExportPlan {
  if (!isRecord(value)) return false;
  const v = value;
  return isCount(v["timescale"]) && (v["timescale"] as number) > 0 && isTime(v["duration"]) && isTime(v["outputDuration"]) && isCount(v["frames"])
    && Array.isArray(v["removed"]) && v["removed"].every(isSpan)
    && Array.isArray(v["dropped"]) && v["dropped"].every(isSpan)
    && Array.isArray(v["parts"]) && v["parts"].every((p) => isRecord(p) && isTime(p["requested"]) && isTime(p["start"]) && isTime(p["stop"])
      && isTime(p["outStart"]) && typeof p["fellBack"] === "boolean" && typeof p["reencoded"] === "boolean")
    && typeof v["secondDescription"] === "boolean" && typeof v["hasAudio"] === "boolean"
    && (v["editable"] === undefined || v["editable"] === null || (typeof v["editable"] === "string" && v["editable"].length <= EDITABLE_DESCRIPTION_LIMIT));
}

/** Every message the worker may send; main drops anything else. */
export function isExportHostMessage(value: unknown): value is ExportHostMessage {
  if (!isRecord(value)) return false;
  switch (value["type"]) {
    case "ready": return true;
    case "pong": return isCount(value["id"]);
    case "inspected": return isCount(value["id"]) && isPlan(value["plan"]);
    case "progress": return isCount(value["id"]) && typeof value["fraction"] === "number" && value["fraction"] >= 0 && value["fraction"] <= 1;
    case "exported": {
      const result = value["result"];
      return isCount(value["id"]) && isRecord(result) && isPlan(result["plan"]) && isTime(result["bytes"])
        && isCount(result["reencodedFrames"]) && isCount(result["reencodedPackets"]);
    }
    case "failed": return isCount(value["id"]) && isExportFailureCode(value["code"]) && typeof value["detail"] === "string";
    case "copied": case "extracted": return isCount(value["id"]) && isTime(value["bytes"]);
    default: return false;
  }
}

/** Every message main may send; the worker drops anything else. */
export function isExportMainMessage(value: unknown): value is ExportMainMessage {
  if (!isRecord(value)) return false;
  const request = value["request"];
  const isRequest = isRecord(request) && typeof request["source"] === "string"
    && (request["output"] === undefined || typeof request["output"] === "string")
    && Array.isArray(request["removed"]) && request["removed"].length <= MAX_EDIT_RANGES && request["removed"].every(isSpan)
    && (request["render"] === undefined || isExportRender(request["render"]));
  switch (value["type"]) {
    case "inspect": case "export": return isCount(value["id"]) && isRequest;
    case "cancel": return true;
    case "ping": return isCount(value["id"]);
    case "copy": return isCount(value["id"]) && isRecord(request) && typeof request["source"] === "string" && typeof request["output"] === "string";
    case "extract": return isCount(value["id"]) && isRecord(request) && typeof request["source"] === "string" && typeof request["output"] === "string"
      && (EXTRACT_TRACKS as readonly unknown[]).includes(request["track"]);
    default: return false;
  }
}

/** The edit view (Settings' Recordings tab): one recording at a time. Text is localized by main. */
export interface EditorView {
  /** The recording's library id; its title and media URL are the library item's. */
  id: string;
  /**
   * `loading` while the edit and the recording's index are read; `ready`; `stale` when the edit was made for a file
   * that has changed since (offers Discard); `unreadable` for an edit record that cannot be read or is from a newer
   * version (kept as it is; offers Discard); `unsupported` for a file the engine cannot cut; `missing` when the
   * recording is gone.
   */
  state: "loading" | "ready" | "stale" | "unreadable" | "unsupported" | "missing";
  /** Localized, for every state but `ready` and `loading`. */
  message?: string;
  timescale: number;
  /** The recording's length in its timescale and in seconds, and its average frame rate (for stepping). */
  duration: number;
  seconds: number;
  frameRate: number;
  /** The removed ranges as saved, snapped to frames, sorted and apart: what the timeline shows and Undo restores. */
  removed: EditRange[];
  /**
   * What the export leaves out as the engine planned it: `removed`, and the start of a part that resumes later at a
   * key frame or a whole part dropped. The preview skips these, so it plays what the export will hold.
   */
  skipped: EditRange[];
  /** Increases with every saved change; a save names the revision it changes. */
  revision: number;
  /** Kept parts that resume later than asked (D2's key-frame fallback) or were dropped, localized. */
  notes: Array<{ at: number; text: string }>;
  /** The export's length in seconds. */
  outputSeconds: number;
  /** Whether Export can start now, and why not (localized) when it cannot. */
  exportable: boolean;
  blocked?: string;
  export: EditorExport;
  /** A save that did not take effect, localized. */
  saveFailure?: string;
  /** An editable recording's own part of the view (plan 087); absent for any other recording. */
  editable?: EditorEditable;
}

/** What the edit view needs of an editable recording: what it holds, the scene as saved and the preview's tracks. */
export interface EditorEditable {
  /** The inputs' own sound tracks, in order: the recording itself plays the first, or with `mix` both mixed. */
  sounds: EditableSound[];
  /** The recording plays its inputs mixed (plan 098): the preview plays each input's own track instead. */
  mix?: true;
  /** The bubble's shape as recorded; absent without a camera track. */
  camera?: { rounding: number; mirror: boolean };
  scene: EditScene;
  /** The scene as the recording left it (`defaultScene`), which Reset returns to. */
  recorded: EditScene;
  /**
   * The preview's other tracks, as media URLs the page plays beside the recording (`recordstuff-media://preview/…`),
   * once made: the camera, the second sound, and with a mix the first. Absent while they are made, or when they could
   * not be.
   */
  preview: Partial<Record<PreviewTrack, string>>;
}

export type EditorExport =
  | { phase: "idle" }
  | { phase: "exporting"; progress: number; cancelling: boolean }
  | { phase: "done"; name: string; message: string }
  | { phase: "failed"; message: string };

export type EditorChoice =
  | { action: "open" }
  | { action: "close" }
  /** The cuts, and for an editable recording its scene (plan 087), replacing the saved ones. */
  | { action: "save"; removed: EditRange[]; revision: number; scene?: EditScene }
  | { action: "export" }
  | { action: "cancelExport" }
  | { action: "discard" }
  | { action: "reveal" };

export function isEditorChoice(value: unknown): value is EditorChoice {
  if (!isRecord(value)) return false;
  switch (value["action"]) {
    case "open": case "close": case "export": case "cancelExport": case "discard": case "reveal": return true;
    case "save": {
      const removed = value["removed"];
      return isCount(value["revision"]) && Array.isArray(removed) && removed.length <= MAX_EDIT_RANGES
        && removed.every((range) => Array.isArray(range) && range.length === 2 && isCount(range[0]) && isCount(range[1]) && range[0] < range[1])
        && (value["scene"] === undefined || isEditScene(value["scene"]));
    }
    default: return false;
  }
}

/** Sorted, merged ranges, without empty ones: what a save keeps. */
export function normalizeRanges(ranges: readonly EditRange[]): EditRange[] {
  return mergeRanges(ranges);
}
