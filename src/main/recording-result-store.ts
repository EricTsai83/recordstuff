import fs from "node:fs";
import path from "node:path";
import { isErrorCode } from "../shared/state";
import { writeFileAtomicSync } from "./atomic-file";
import type { RecordingResult } from "../shared/recording-result";

export interface ResultStorage {
  readonly requiresMigration?: boolean;
  load(): RecordingResult[];
  save(results: readonly RecordingResult[]): void;
}

function decode(value: unknown): RecordingResult {
  const envelope = value as { version?: unknown; result?: unknown } | null;
  const result = envelope?.result as RecordingResult | undefined;
  const validPath = (value: unknown) => value === undefined ||
    (typeof value === "string" && value.length < 32768 && !value.includes("\0") && path.isAbsolute(value));
  if (envelope?.version !== 1 || !result || typeof result !== "object" ||
      typeof result.id !== "string" || !result.id || result.id.length > 200 ||
      typeof result.occurredAt !== "string" || !Number.isFinite(Date.parse(result.occurredAt)) ||
      !isErrorCode(result.code) || typeof result.detail !== "string" || result.detail.length > 65536 ||
      !["pending", "partial", "empty", "unknown"].includes(result.outcome) ||
      (result.previouslyPartial !== undefined && typeof result.previouslyPartial !== "boolean") ||
      (result.outcome === "pending" && result.previouslyPartial === true) ||
      (result.acknowledgedAt !== undefined && (typeof result.acknowledgedAt !== "string" || !Number.isFinite(Date.parse(result.acknowledgedAt)))) ||
      typeof result.acknowledged !== "boolean" || !validPath(result.partialPath) || !validPath(result.recordingPath) ||
      (result.outcome === "partial" && !result.partialPath) ||
      (result.outcome === "pending" && result.acknowledged)) throw new Error("invalid recording result");
  return { id: result.id, occurredAt: result.occurredAt, code: result.code, detail: result.detail,
    outcome: result.outcome, acknowledged: result.acknowledged,
    ...(result.acknowledgedAt ? { acknowledgedAt: result.acknowledgedAt } : {}),
    ...(result.partialPath ? { partialPath: result.partialPath } : {}),
    ...(result.recordingPath ? { recordingPath: result.recordingPath } : {}),
    ...(result.previouslyPartial ? { previouslyPartial: true } : {}) };
}

/** Separate filename from v1 so an older app cannot overwrite history on downgrade. */
export class RecordingResultStore implements ResultStorage {
  private blocked = false;
  requiresMigration = false;
  constructor(private readonly file: string, private readonly log: (message: string) => void = () => {},
    private readonly legacyFile?: string) {}
  load(): RecordingResult[] {
    try {
      if (fs.statSync(this.file).size > 32 * 1024 * 1024) throw new Error("recording history too large");
      const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as { version?: unknown; results?: unknown };
      if (value?.version !== 2 || !Array.isArray(value.results)) throw new Error("invalid recording history");
      const results = value.results.map(result => decode({ version: 1, result }));
      if (new Set(results.map(r => r.id)).size !== results.length) throw new Error("duplicate recording identities");
      return results;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.blocked = true;
        this.log(`recording history: load failed: ${String(error)}`);
        return [];
      }
    }
    if (this.legacyFile) {
      try {
        if (fs.statSync(this.legacyFile).size > 1024 * 1024) throw new Error("legacy result too large");
        const result = decode(JSON.parse(fs.readFileSync(this.legacyFile, "utf8")));
        this.requiresMigration = true;
        return [result];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log(`recording history: legacy load failed: ${String(error)}`);
      }
    }
    return [];
  }
  save(results: readonly RecordingResult[]): void {
    if (this.blocked) throw new Error("Existing recording history is unreadable; refusing to overwrite it");
    const saved = results.map(result => decode({ version: 1, result: { ...result, detail: result.detail.slice(0, 65536) } }));
    const content = JSON.stringify({ version: 2, results: saved });
    if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error("recording history too large");
    writeFileAtomicSync(this.file, content, { mode: 0o600 });
  }
}
