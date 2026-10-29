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
import { SerialQueue } from "../lib/serial-queue";

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

/** Whether the system says nothing is at `file`: any other failure to look is not taken for absence. */
async function confirmedAbsent(file: string): Promise<boolean> {
  return fs.promises.lstat(file).then(() => false, (cause: NodeJS.ErrnoException) => cause.code === "ENOENT" || cause.code === "ENOTDIR");
}

/** Whether two paths name one file (a case-only rename on a case-insensitive volume). */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([fs.promises.stat(a).catch(() => undefined), fs.promises.stat(b).catch(() => undefined)]);
  return Boolean(x && y && x.ino === y.ino && x.dev === y.dev);
}

export class EditStore {
  /** Writes in order, one record at a time: a later save never lands before an earlier one. */
  private readonly queue = new SerialQueue();
  /**
   * The recordings that hold an edit, by path, with the size their record was made for (2026-10-26, the maintainer's
   * request: the Recordings tab marks an edited recording and offers Continue editing…). Read from the folder once by
   * `scan` and kept by every save, discard and move after it, so the tab never reads a record to draw a card.
   */
  private index = new Map<string, number>();
  /** Each held record's recording identity, by path: how a recording renamed or moved in Finder finds its edit again. */
  private identities = new Map<string, SourceIdentity>();
  /** Finding an edit by bytes, one at a time: two readers never both move the same record (Codex review). */
  private readonly adoption = new SerialQueue();
  /** What a move's record replaced at its new path, to put back if the move is not made (Codex review). */
  private readonly replaced = new Map<string, string | null>();

  constructor(private readonly dir: string) {}

  /** Where the records are, for a failure that names it. */
  get folder(): string {
    return this.dir;
  }

  /**
   * Reads which recordings hold an edit, once at launch; a record that cannot be read is left out, as it is kept. In
   * the writes' own queue, so a save or discard made meanwhile lands after it and is never undone by it (review of
   * 2026-10-26).
   */
  scan(): Promise<void> {
    return this.queue.run(() => this.scanNow());
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
    this.identities.set(path.resolve(record.source.path), record.source);
  }

  private forget(source: string): void {
    this.index.delete(path.resolve(source));
    this.identities.delete(path.resolve(source));
  }

  /** Every held record's recording: its path and identity, for clean-up and for Settings' kept edits. */
  records(): ReadonlyMap<string, SourceIdentity> {
    return this.identities;
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
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return this.adoption.run(() => this.adopt(source, identity));
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
    return this.queue.run(async () => {
      await writeFileAtomic(file, text, { syncDirectory: true });
      this.note(record);
    });
  }

  /** Removes the edit for `source` (Discard): only the record, never the recording. */
  discard(source: string): Promise<void> {
    const file = this.fileFor(source);
    return this.queue.run(async () => {
      await fs.promises.rm(file, { force: true });
      this.forget(source);
    });
  }

  /**
   * No record at `source`: one made for the same bytes at a path where no file is any longer (a recording renamed or
   * moved in Finder, plan 100) is the recording's, and moves to `source`. Its bytes, modification time and ends must all
   * match; a copy, whose original is still at its path, does not take its edit.
   */
  private async adopt(source: string, identity: SourceIdentity): Promise<LoadedEdit> {
    // Moved here by a reader just before this one: it is found at its own path now.
    if (await fs.promises.access(this.fileFor(source)).then(() => true, () => false)) return this.load(source, identity);
    for (const [from, known] of this.identities) {
      if (from === path.resolve(source) || known.size !== identity.size || known.mtimeMs !== identity.mtimeMs || known.hash !== identity.hash) continue;
      // Only the system's own "nothing there" says the original is gone; a look that failed otherwise (no permission)
      // decides nothing, so a copy never takes an edit whose recording may still be there (Codex review).
      if (!(await confirmedAbsent(from))) continue;
      const loaded = await this.load(from, { ...identity, path: from });
      if (loaded.kind !== "ok") continue;
      const record: EditRecord = { ...loaded.record, source: identity };
      try {
        await this.save(record);
        await this.discard(from);
      } catch {
        // Not moved now: it is still found by its bytes next time, and this time it is the edit all the same.
      }
      return { kind: "ok", record };
    }
    return { kind: "none" };
  }

  /**
   * Before the recording at `from` moves to `to` in the tab (plan 100): its edit is written for `to` first, so the file
   * is never at a path its edit does not follow. Rejects with the write's error, the move then not made; nothing to
   * write resolves at once.
   */
  async prepareMove(from: string, to: string): Promise<void> {
    // The record's file, whether or not it could be read: one that cannot (a newer version's, a damaged one) or that
    // was made for another file at this path would not follow the recording, so the move is refused (Codex review).
    if (!(await fs.promises.access(this.fileFor(from)).then(() => true, () => false))) return;
    const identity = await sourceIdentity(from);
    const loaded = await this.load(from, identity);
    if (loaded.kind === "none") return;
    if (loaded.kind !== "ok") throw Object.assign(new Error(`the edit of ${from} is ${loaded.kind} and cannot follow it`), { code: loaded.kind === "stale" ? "ESTALE" : "EBADMSG" });
    // A recording already at the new path keeps its edit untouched: the move is refused for the name, and nothing of
    // its record is ever overwritten, even for a moment (Codex review).
    // The same file under another case on a case-insensitive volume is a rename like any other.
    if (!(await confirmedAbsent(to)) && !(await sameFile(from, to))) return;
    // Whatever record the new path holds (an edit left by a recording gone from it) is kept aside, to be put back if
    // the move is not made.
    const previous = await fs.promises.readFile(this.fileFor(to), "utf8").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    });
    this.replaced.set(path.resolve(to), previous);
    try {
      await this.save({ ...loaded.record, source: { ...identity, path: to } });
    } catch (cause) {
      this.replaced.delete(path.resolve(to));
      throw cause;
    }
  }

  /**
   * After the move: the edit at the path left goes. When the file did not move, the record written for `to` goes and
   * whatever it replaced there is put back, so another recording's edit is never lost to a refused move.
   */
  async finishMove(from: string, to: string, moved: boolean): Promise<void> {
    const key = path.resolve(to);
    if (!this.replaced.has(key)) return;
    const previous = this.replaced.get(key);
    this.replaced.delete(key);
    if (moved) {
      await this.discard(from);
      return;
    }
    if (previous === null || previous === undefined) {
      await this.discard(to);
      return;
    }
    const file = this.fileFor(to);
    await this.queue.run(async () => {
      await writeFileAtomic(file, previous, { syncDirectory: true });
      const parsed = parseRecord(previous);
      this.forget(to);
      if (!("reason" in parsed)) this.note(parsed);
    });
  }

  /** The moves a category rename was prepared with, by its folder, for `finishFolderMove`. */
  private readonly folderMoves = new Map<string, Array<[string, string]>>();

  /**
   * The recordings directly in the folder `from` that hold a record, readable or not, and where they go when it is
   * renamed to `to`: by the folder's files, so a record that cannot be read is found too (Codex review).
   */
  private async inFolder(from: string, to: string): Promise<Array<[string, string]>> {
    // A folder that cannot be listed may hold edits that would not follow it: the rename is refused (Codex review).
    const names = await fs.promises.readdir(from).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [] as string[];
      throw cause;
    });
    const held: Array<[string, string]> = [];
    for (const name of names) {
      const source = path.join(path.resolve(from), name);
      if (await fs.promises.access(this.fileFor(source)).then(() => true, () => false)) held.push([source, path.join(to, name)]);
    }
    return held;
  }

  /** `prepareMove` for every recording of a category renamed from `from` to `to`; a failure takes back what it wrote. */
  async prepareFolderMove(from: string, to: string): Promise<void> {
    const moves = await this.inFolder(from, to);
    const written: Array<[string, string]> = [];
    try {
      for (const move of moves) {
        await this.prepareMove(...move);
        written.push(move);
      }
    } catch (cause) {
      for (const [source, target] of written) await this.finishMove(source, target, false).catch(() => undefined);
      throw cause;
    }
    this.folderMoves.set(path.resolve(from), moves);
  }

  /** `finishMove` for every recording of a category renamed from `from` to `to`. */
  async finishFolderMove(from: string, _to: string, moved: boolean): Promise<void> {
    const moves = this.folderMoves.get(path.resolve(from)) ?? [];
    this.folderMoves.delete(path.resolve(from));
    for (const [source, target] of moves) await this.finishMove(source, target, moved);
  }
}
