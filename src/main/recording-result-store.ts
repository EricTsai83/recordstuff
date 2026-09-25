import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isErrorCode } from "../shared/state";
import { writeFileAtomic } from "./atomic-file";
import type { PersistenceIssue, RecordingResult } from "../shared/recording-result";

/** Every file operation is asynchronous (libuv threadpool); only small per-record JSON work runs on main. */
export interface ResultStorage {
  readonly requiresMigration?: boolean;
  load(): Promise<RecordingResult[]>;
  save(results: readonly RecordingResult[]): Promise<void>;
}

/** A save that retrying cannot fix; any other rejection is treated as a recoverable I/O failure. */
export class HistoryStorageError extends Error {
  constructor(message: string, readonly issue: Exclude<PersistenceIssue, "io">) { super(message); }
}
const LIMIT = 32 * 1024 * 1024;
let spent = 0, lastWork = 0;
/**
 * Runs one record's JSON work, first yielding to the event loop once such work
 * has held main for about half a frame. Every history loop shares the budget,
 * so back-to-back loops cannot add up; a small history never yields.
 */
export async function sliced<T>(work: () => T): Promise<T> {
  const now = performance.now();
  // A gap means main was free meanwhile.
  if (now - lastWork > 4) spent = 0;
  else if (spent > 8) { await nextTurn(); spent = 0; }
  const start = performance.now();
  const value = work();
  lastWork = performance.now();
  spent += lastWork - start;
  return value;
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
  /** Records are replaced, never mutated, so an unchanged record is encoded once. */
  private readonly encoded = new WeakMap<RecordingResult, { json: string; bytes: number }>();
  constructor(private readonly file: string, private readonly log: (message: string) => void = () => {},
    private readonly legacyFile?: string) {}
  private static async read(file: string, limit: number, tooLarge: string): Promise<unknown> {
    const handle = await fs.promises.open(file, "r");
    try {
      if ((await handle.stat()).size > limit) throw new Error(tooLarge);
      return JSON.parse(await handle.readFile("utf8"));
    } finally { await handle.close(); }
  }
  async load(): Promise<RecordingResult[]> {
    try {
      const value = await RecordingResultStore.read(this.file, LIMIT, "recording history too large") as { version?: unknown; results?: unknown };
      if (value?.version !== 2 || !Array.isArray(value.results)) throw new Error("invalid recording history");
      const results: RecordingResult[] = [];
      for (const result of value.results as unknown[]) results.push(await sliced(() => decode({ version: 1, result })));
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
        const result = decode(await RecordingResultStore.read(this.legacyFile, 1024 * 1024, "legacy result too large"));
        this.requiresMigration = true;
        return [result];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log(`recording history: legacy load failed: ${String(error)}`);
      }
    }
    return [];
  }
  async save(results: readonly RecordingResult[]): Promise<void> {
    if (this.blocked) throw new HistoryStorageError("Existing recording history is unreadable; refusing to overwrite it", "blocked");
    const chunks = ['{"version":2,"results":['];
    let bytes = chunks[0]!.length + 2;
    for (const [index, result] of results.entries()) {
      let entry = this.encoded.get(result);
      if (!entry) {
        entry = await sliced(() => {
          const json = JSON.stringify(decode({ version: 1, result: { ...result, detail: result.detail.slice(0, 65536) } }));
          return { json, bytes: Buffer.byteLength(json) };
        });
        this.encoded.set(result, entry);
      }
      chunks.push(index ? `,${entry.json}` : entry.json);
      bytes += entry.bytes + (index ? 1 : 0);
    }
    chunks.push("]}");
    if (bytes > LIMIT) throw new HistoryStorageError("recording history too large", "tooLarge");
    await writeFileAtomic(this.file, chunks, { mode: 0o600 });
  }
}
