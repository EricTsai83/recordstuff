/**
 * Where edits live (plan 085, D3): one small JSON record per edited recording in userData, never beside the
 * recording, whose folder's subfolders are the Recordings tab's categories (plan 071). The recording is referenced,
 * never copied: by its path (the record's file name is a hash of it) and an identity (size, modification time and a
 * SHA-256 of its first and last MiB) that says whether the record still describes the same file.
 *
 * Main is the one writer (the single-instance lock makes it unique per user); writes are atomic (a temporary file,
 * fsync, rename, folder fsync), so a failed or interrupted write leaves the last whole revision. Reading is bounded,
 * and a record that cannot be read, or one from a newer version, is reported and kept as it is, never replaced by an
 * empty edit: only Discard, the user's explicit choice, removes it. Nothing here touches the recording itself, which
 * is only ever opened to read its identity.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../lib/atomic-file";
import { MAX_EDIT_RANGES, normalizeRanges, type EditRange } from "../../shared/editing";
import { isEditScene, type EditScene } from "../../shared/editable";

/**
 * The newest record this version writes. Version 1 (plan 085) holds the cuts; version 2 (plan 087) adds an editable
 * recording's scene, and is written only for one with a scene, so every other edit stays readable by a version that
 * knows only 1. Version 3 (2026-10-26) lets the scene's camera be hidden over stretches of the recording and an input
 * be at a volume of its own over stretches, and is written only for a scene with such a stretch: a version that knows only 2 finds such an edit unreadable and keeps it, rather
 * than reading it as a camera shown throughout and saving over the stretches. All three are read; a newer one is
 * unreadable, as before.
 */
export const EDIT_RECORD_VERSION = 3;
/** The largest record read: 256 ranges take about 10 KB. */
export const EDIT_RECORD_LIMIT = 64 * 1024;
/** How much of each end of a recording its identity hashes. */
export const IDENTITY_SPAN = 1024 * 1024;

/** What says a record still describes the same recording. */
export interface SourceIdentity {
  path: string;
  size: number;
  mtimeMs: number;
  /** SHA-256 of the first and last `IDENTITY_SPAN` bytes, hex. */
  hash: string;
}

export interface EditRecord {
  version: 1 | 2 | 3;
  source: SourceIdentity;
  /** The video's timescale the ranges count in. */
  timescale: number;
  removed: EditRange[];
  revision: number;
  /** An editable recording's camera and volumes (plan 087): versions 2 and 3 only. */
  scene?: EditScene;
}

/** A record of the cuts and, when given, the scene: version 3 with a camera or volume stretch, 2 with a scene, 1 without. */
export function editRecord(fields: { source: SourceIdentity; timescale: number; removed: EditRange[]; revision: number; scene?: EditScene | undefined }): EditRecord {
  const { scene, ...rest } = fields;
  if (!scene) return { version: 1, ...rest };
  return { version: scene.camera?.hidden?.length || scene.volumeStretches ? 3 : 2, ...rest, scene };
}

export type LoadedEdit =
  /** No edit yet for this recording. */
  | { kind: "none" }
  | { kind: "ok"; record: EditRecord }
  /** The record names this path, but the file there is another (changed, replaced or re-recorded). */
  | { kind: "stale"; record: EditRecord }
  /** The record cannot be read, is too large, malformed or from a newer version: kept read-only. */
  | { kind: "unreadable"; reason: string };

/** Reads `file`'s identity; the file is opened only to read. */
export async function sourceIdentity(file: string): Promise<SourceIdentity> {
  const handle = await fs.promises.open(file, "r");
  try {
    const stat = await handle.stat();
    const hash = createHash("sha256");
    const head = Math.min(IDENTITY_SPAN, stat.size);
    const buffer = Buffer.alloc(head);
    await handle.read(buffer, 0, head, 0);
    hash.update(buffer);
    if (stat.size > IDENTITY_SPAN) {
      const tail = Math.min(IDENTITY_SPAN, stat.size - IDENTITY_SPAN);
      const end = Buffer.alloc(tail);
      await handle.read(end, 0, tail, stat.size - tail);
      hash.update(end);
    }
    return { path: file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs), hash: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export function sameSource(a: SourceIdentity, b: SourceIdentity): boolean {
  return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs && a.hash === b.hash;
}

function isIdentity(value: unknown): value is SourceIdentity {
  const v = value as Record<string, unknown>;
  return typeof value === "object" && value !== null && typeof v["path"] === "string" && Number.isSafeInteger(v["size"])
    && typeof v["mtimeMs"] === "number" && Number.isFinite(v["mtimeMs"]) && typeof v["hash"] === "string" && /^[0-9a-f]{64}$/.test(v["hash"]);
}

/** A version-1, 2 or 3 record, checked field by field: anything else is unreadable, never guessed at. */
export function parseRecord(text: string): EditRecord | { reason: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { reason: "the edit is not valid JSON" }; }
  if (typeof value !== "object" || value === null) return { reason: "the edit is not an object" };
  const v = value as Record<string, unknown>;
  if (v["version"] !== 1 && v["version"] !== 2 && v["version"] !== 3) {
    return { reason: typeof v["version"] === "number" && v["version"] > EDIT_RECORD_VERSION ? `the edit was saved by a newer version (${v["version"]})` : "the edit has no known version" };
  }
  const version = v["version"];
  const removed = v["removed"];
  const ranges = Array.isArray(removed) && removed.length <= MAX_EDIT_RANGES
    && removed.every((r) => Array.isArray(r) && r.length === 2 && Number.isSafeInteger(r[0]) && Number.isSafeInteger(r[1]) && r[0] >= 0 && r[0] < r[1]);
  if (!isIdentity(v["source"]) || !Number.isSafeInteger(v["timescale"]) || (v["timescale"] as number) <= 0 || !ranges
    || !Number.isSafeInteger(v["revision"]) || (v["revision"] as number) < 0) {
    return { reason: `the edit's fields are not what version ${version} writes` };
  }
  if (version !== 1 && !isEditScene(v["scene"])) return { reason: `the edit's scene is not what version ${version} writes` };
  // Only version 3 hides the camera over stretches: one in an older version's record was not written by it.
  if (version === 2 && ((v["scene"] as EditScene).camera?.hidden !== undefined || (v["scene"] as EditScene).volumeStretches !== undefined)) {
    return { reason: "the edit's scene is not what version 2 writes" };
  }
  const sorted = normalizeRanges(removed as EditRange[]);
  if (JSON.stringify(sorted) !== JSON.stringify(removed)) return { reason: "the edit's ranges overlap or are out of order" };
  const fields = { source: v["source"], timescale: v["timescale"] as number, removed: sorted, revision: v["revision"] as number };
  return version === 1 ? { version, ...fields } : { version, ...fields, scene: v["scene"] as EditScene };
}

export class EditStore {
  /** Writes in order, one record at a time: a later save never lands before an earlier one. */
  private queue: Promise<void> = Promise.resolve();
  /**
   * The recordings that hold an edit, by path, with the size their record was made for (2026-10-26, the maintainer's
   * request: the Recordings tab marks an edited recording and offers Continue editing…). Read from the folder once by
   * `scan` and kept by every save, discard and move after it, so the tab never reads a record to draw a card.
   */
  private index = new Map<string, number>();

  constructor(private readonly dir: string) {}

  /**
   * Reads which recordings hold an edit, once at launch; a record that cannot be read is left out, as it is kept. In
   * the writes' own queue, so a save or discard made meanwhile lands after it and is never undone by it (review of
   * 2026-10-26).
   */
  scan(): Promise<void> {
    const run = this.queue.then(() => this.scanNow());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async scanNow(): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
      try {
        const file = path.join(this.dir, name);
        if ((await fs.promises.stat(file)).size > EDIT_RECORD_LIMIT) continue;
        const parsed = parseRecord(await fs.promises.readFile(file, "utf8"));
        if (!("reason" in parsed) && this.fileFor(parsed.source.path) === file) this.note(parsed);
      } catch {
        // Gone or unreadable meanwhile: not marked.
      }
    }
  }

  /** The recordings that hold an edit, by path, with the size their record was made for. */
  edited(): ReadonlyMap<string, number> {
    return this.index;
  }

  private note(record: EditRecord): void {
    this.index.set(path.resolve(record.source.path), record.source.size);
  }

  /** The record's file for a recording at `source`. */
  fileFor(source: string): string {
    return path.join(this.dir, `${createHash("sha256").update(path.resolve(source)).digest("hex").slice(0, 32)}.json`);
  }

  /** The edit for the recording at `source`, judged against its `identity` now. */
  async load(source: string, identity: SourceIdentity): Promise<LoadedEdit> {
    const file = this.fileFor(source);
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(file, "r");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
      return { kind: "unreadable", reason: `the edit could not be opened: ${(cause as Error).message}` };
    }
    let text: string;
    try {
      const { size } = await handle.stat();
      if (size > EDIT_RECORD_LIMIT) return { kind: "unreadable", reason: `the edit is ${size} bytes, more than ${EDIT_RECORD_LIMIT}` };
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      text = buffer.toString("utf8");
    } catch (cause) {
      return { kind: "unreadable", reason: `the edit could not be read: ${(cause as Error).message}` };
    } finally {
      await handle.close().catch(() => undefined);
    }
    const parsed = parseRecord(text);
    if ("reason" in parsed) return { kind: "unreadable", reason: parsed.reason };
    return sameSource(parsed.source, identity) ? { kind: "ok", record: parsed } : { kind: "stale", record: parsed };
  }

  /** Saves `record` atomically. A failure leaves the last revision on disk and rejects. */
  save(record: EditRecord): Promise<void> {
    const file = this.fileFor(record.source.path);
    const text = `${JSON.stringify(record, null, 2)}\n`;
    const write = this.queue.then(() => writeFileAtomic(file, text, { syncDirectory: true })).then(() => this.note(record));
    this.queue = write.catch(() => undefined);
    return write;
  }

  /** Removes the edit for `source` (Discard): only the record, never the recording. */
  discard(source: string): Promise<void> {
    const file = this.fileFor(source);
    const remove = this.queue.then(() => fs.promises.rm(file, { force: true })).then(() => { this.index.delete(path.resolve(source)); });
    this.queue = remove.catch(() => undefined);
    return remove;
  }

  /**
   * The recording moved (renamed, or moved to a category): its edit follows when it still describes the same file at
   * the new path. Best effort: an edit that cannot move stays where it was, as a stale one would.
   */
  async moved(from: string, to: string): Promise<void> {
    const identity = await sourceIdentity(to).catch(() => undefined);
    if (!identity) return;
    const loaded = await this.load(from, { ...identity, path: from });
    if (loaded.kind !== "ok") return;
    await this.save({ ...loaded.record, source: identity });
    await this.discard(from);
  }

  /**
   * A category folder was renamed: the edit of every recording directly in it follows it to the new folder, as
   * `moved` carries one recording's. Taken from the edits held, so a recording the listing has not reached still keeps
   * its edit.
   */
  async folderMoved(from: string, to: string): Promise<void> {
    const folder = path.resolve(from);
    const inside = [...this.index.keys()].filter(source => path.dirname(source) === folder);
    for (const source of inside) await this.moved(source, path.join(to, path.basename(source)));
  }
}
