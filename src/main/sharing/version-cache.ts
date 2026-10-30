/**
 * Where versions are made into files (plan 100): a cache the app owns, in the system's place for files that can be made
 * again (`~/Library/Caches/RecordStuff/Versions`, `%LOCALAPPDATA%\RecordStuff\Cache\Versions`), which Time Machine leaves
 * out and which holds no only copy of anything. The person never manages it: an entry is made when a version is needed,
 * reused while the recording and its edit are unchanged, and cleaned by the app.
 *
 * **Entries.** One folder per version of a recording at one edit, named by its key (`versionKey`): the file
 * (`content.mp4`, `content.m4a`), or for Sources one file per track in `sources/`, and `entry.json`, which says whose it
 * is and when it was made and last handed out. An entry is made in a hidden `.part-…` folder and renamed into place
 * whole, so a crash leaves only a `.part-…` folder, removed at the next launch.
 *
 * **Handing out.** What leaves is a hard link to the entry's file under its outgoing name, in the entry's own `out/`
 * folder, so a name costs no copy and two versions never meet in one folder.
 *
 * **Cleaning (D5).** At most 10 GB or 10% of the free space, whichever is smaller, oldest first. A file handed out in the
 * last 24 hours, or held for another reason (`held`), is kept even past the limit: a web page may still be reading it
 * after the drop. A recording deleted or moved out of the folder takes its entries with it at once, held or not; one
 * edited again leaves its older entries to go once they are not held.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { COPIED_FOLDER } from "./give";
import { writeFileAtomic } from "../lib/atomic-file";
import { isVersionKind, type VersionKind } from "../../shared/versions";

/** D5: the cache's largest size, and its share of the free space. */
export const CACHE_LIMIT_BYTES = 10 * 1024 ** 3;
export const CACHE_FREE_SHARE = 0.1;
/** How long a file handed out is kept whatever the limit. */
export const HOLD_MS = 24 * 60 * 60 * 1000;

/** What `entry.json` holds. */
export interface CacheEntry {
  version: 1;
  key: string;
  /** The recording's path when the entry was made or last followed (`moved`). */
  source: string;
  kind: VersionKind;
  /** The entry's file in its folder: `content.mp4`, `content.m4a`, or `sources` (a folder). */
  content: string;
  bytes: number;
  made: number;
  /** When it was last handed out. */
  handedOut?: number;
}

/** What says two versions are the same file: the recording's bytes, its edit, and which version. */
export function versionKey(fields: { size: number; mtimeMs: number; hash: string; edit: string; kind: VersionKind }): string {
  return createHash("sha256").update(JSON.stringify(["v1", fields.kind, fields.size, fields.mtimeMs, fields.hash, fields.edit])).digest("hex").slice(0, 32);
}

const KEY = /^[0-9a-f]{32}$/;
const PART = /^\.part-[0-9a-f]{12}$/;

function isEntry(value: unknown): value is CacheEntry {
  const v = value as Record<string, unknown>;
  return typeof value === "object" && value !== null && v["version"] === 1 && typeof v["key"] === "string" && KEY.test(v["key"])
    && typeof v["source"] === "string" && isVersionKind(v["kind"]) && typeof v["content"] === "string" && /^(content\.(mp4|m4a)|sources)$/.test(v["content"])
    && Number.isSafeInteger(v["bytes"]) && Number.isFinite(v["made"]) && (v["handedOut"] === undefined || Number.isFinite(v["handedOut"]));
}

export interface VersionCacheDeps {
  root: string;
  log(message: string): void;
  /** Milliseconds since the epoch. */
  now?(): number;
  /** Free bytes on the cache's volume. */
  freeSpace?(dir: string): Promise<number>;
  /** An entry held for another reason than its 24 hours, such as being on the clipboard. */
  held?(key: string): boolean;
}

/** An entry being made: its folder, renamed into place by `commit`. */
export interface PendingEntry { dir: string; key: string }

export class VersionCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** Entries being handed out now: never trimmed or cleared until they are held (Codex pass 2). */
  private readonly pinned = new Map<string, number>();
  private scanned: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: VersionCacheDeps) {
    this.now = deps.now ?? Date.now;
  }

  get root(): string {
    return this.deps.root;
  }

  /** Reads the entries once (at launch), removing unfinished and unreadable ones. */
  scan(): Promise<void> {
    return this.scanned ??= this.read();
  }

  private async read(): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.deps.root);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") this.deps.log(`versions: could not read the cache ${this.deps.root}: ${String(cause)}`);
      return;
    }
    for (const name of names) {
      const dir = path.join(this.deps.root, name);
      if (PART.test(name)) {
        await this.removeDir(dir, "left unfinished");
        continue;
      }
      if (!KEY.test(name)) continue;
      const text = await fs.promises.readFile(path.join(dir, "entry.json"), "utf8").catch(() => undefined);
      let entry: unknown;
      try { entry = text === undefined ? undefined : JSON.parse(text); } catch { entry = undefined; }
      if (!isEntry(entry) || entry.key !== name) {
        await this.removeDir(dir, "unreadable");
        continue;
      }
      // A recording deleted or moved away while RecordStuff was not following the folder (Codex F4).
      if (!(await fs.promises.access(entry.source).then(() => true, () => false))) {
        await this.removeDir(dir, "its recording is gone");
        continue;
      }
      this.entries.set(name, entry);
    }
  }

  private async removeDir(dir: string, why: string): Promise<void> {
    await fs.promises.rm(dir, { recursive: true, force: true }).then(
      () => this.deps.log(`versions: removed ${path.basename(dir)} from the cache (${why})`),
      (cause: unknown) => this.deps.log(`versions: could not remove ${dir}: ${String(cause)}`),
    );
  }

  /** The finished entry `key`, if the cache holds it. */
  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  /** The entry's file or folder. */
  contentPath(entry: CacheEntry): string {
    return path.join(this.deps.root, entry.key, entry.content);
  }

  /** A folder of its own to make the entry `key` in; nothing else writes there. */
  async begin(key: string): Promise<PendingEntry> {
    await fs.promises.mkdir(this.deps.root, { recursive: true });
    const dir = path.join(this.deps.root, `.part-${randomBytes(6).toString("hex")}`);
    await fs.promises.mkdir(dir);
    return { dir, key };
  }

  /** Abandons an entry being made: its folder goes. */
  async abandon(pending: PendingEntry): Promise<void> {
    await fs.promises.rm(pending.dir, { recursive: true, force: true }).catch((cause: unknown) => this.deps.log(`versions: could not remove ${pending.dir}: ${String(cause)}`));
  }

  /**
   * Puts the entry made in `pending` into place, whole, then lets the source's older entries of the same kind go if
   * they are not held, and keeps the cache within its limit.
   */
  async commit(pending: PendingEntry, fields: { source: string; kind: VersionKind; content: string }): Promise<CacheEntry> {
    const bytes = await sizeOf(path.join(pending.dir, fields.content));
    const entry: CacheEntry = { version: 1, key: pending.key, ...fields, bytes, made: this.now() };
    await writeFileAtomic(path.join(pending.dir, "entry.json"), `${JSON.stringify(entry)}\n`);
    const target = path.join(this.deps.root, pending.key);
    // Made again by another path meanwhile (it cannot be: one preparation at a time), or left by a crash: replaced.
    await fs.promises.rm(target, { recursive: true, force: true });
    await fs.promises.rename(pending.dir, target);
    this.entries.set(entry.key, entry);
    for (const other of [...this.entries.values()]) {
      if (other.key !== entry.key && other.source === entry.source && other.kind === entry.kind && !this.isHeld(other)) await this.remove(other.key, "its recording was edited again");
    }
    // Never the entry just made: it was asked for and has not been handed out yet (Codex F6).
    await this.trim(entry.key);
    return entry;
  }

  /**
   * A path to give `entry` out by under `name`: a hard link to its file in the entry's `out/` folder, or for Sources a
   * folder `name` of links named by `files` (track file → outgoing name). The entry is marked handed out now, so it is
   * held for the next 24 hours.
   */
  async handOut(entry: CacheEntry, name: string, files?: ReadonlyArray<{ from: string; name: string }>): Promise<string> {
    this.pinned.set(entry.key, (this.pinned.get(entry.key) ?? 0) + 1);
    try {
      return await this.link(entry, name, files);
    } finally {
      const count = (this.pinned.get(entry.key) ?? 1) - 1;
      if (count > 0) this.pinned.set(entry.key, count);
      else this.pinned.delete(entry.key);
    }
  }

  private async link(entry: CacheEntry, name: string, files?: ReadonlyArray<{ from: string; name: string }>): Promise<string> {
    const outDir = path.join(this.deps.root, entry.key, "out");
    await fs.promises.mkdir(outDir, { recursive: true });
    // Earlier names stay: a page may still be reading a file handed out under one (Codex F5). They go with the entry.
    const target = path.join(outDir, name);
    const link = (from: string, to: string): Promise<void> => fs.promises.link(from, to).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause;
    });
    if (files) {
      await fs.promises.mkdir(target, { recursive: true });
      for (const file of files) await link(path.join(this.contentPath(entry), file.from), path.join(target, file.name));
    } else {
      await link(this.contentPath(entry), target);
    }
    const marked: CacheEntry = { ...(this.entries.get(entry.key) ?? entry), handedOut: this.now() };
    await this.rewrite(marked);
    return target;
  }

  private async rewrite(entry: CacheEntry): Promise<void> {
    this.entries.set(entry.key, entry);
    await writeFileAtomic(path.join(this.deps.root, entry.key, "entry.json"), `${JSON.stringify(entry)}\n`)
      .catch((cause: unknown) => this.deps.log(`versions: could not update ${entry.key}: ${String(cause)}`));
  }

  /** Whether `entry` is kept whatever the limit: handed out in the last 24 hours, or held for another reason. */
  isHeld(entry: CacheEntry): boolean {
    return (entry.handedOut !== undefined && this.now() - entry.handedOut < HOLD_MS) || this.pinned.has(entry.key) || this.deps.held?.(entry.key) === true;
  }

  async remove(key: string, why: string): Promise<void> {
    if (!this.entries.delete(key)) return;
    await this.removeDir(path.join(this.deps.root, key), why);
  }

  /** A recording deleted or moved out of the folder: its entries go at once, held or not. */
  async removeSource(source: string, why: string, keepHeld = false): Promise<void> {
    for (const entry of [...this.entries.values()]) if (entry.source === source && !(keepHeld && this.isHeld(entry))) await this.remove(entry.key, why);
  }

  /** The recordings whose versions the cache holds. */
  sources(): Set<string> {
    return new Set([...this.entries.values()].map((entry) => entry.source));
  }

  /** A recording renamed or moved in the Recordings tab: its entries follow it (their content is the same). */
  async moved(from: string, to: string): Promise<void> {
    for (const entry of [...this.entries.values()]) if (entry.source === from) await this.rewrite({ ...entry, source: to });
  }

  /** The cache's size: every finished entry's file. */
  size(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    return total;
  }

  /** Settings' Clear: every entry not held goes, and the last copy's clones. */
  async clear(): Promise<void> {
    for (const entry of [...this.entries.values()]) if (!this.isHeld(entry)) await this.remove(entry.key, "the cache was cleared");
    // The last copy's clones (give.ts), which would otherwise keep the data of entries just removed.
    await fs.promises.rm(path.join(this.deps.root, COPIED_FOLDER), { recursive: true, force: true });
  }

  /** The cache's limit now (D5): 10 GB or 10% of the free space, whichever is smaller. */
  async limit(): Promise<number> {
    const free = await (this.deps.freeSpace ?? freeSpace)(this.deps.root).catch(() => undefined);
    return free === undefined ? CACHE_LIMIT_BYTES : Math.min(CACHE_LIMIT_BYTES, Math.floor(free * CACHE_FREE_SHARE));
  }

  /** Oldest first, entries not held go until the cache is within its limit. */
  async trim(keep?: string): Promise<void> {
    const limit = await this.limit();
    let total = this.size();
    if (total <= limit) return;
    const oldest = [...this.entries.values()].sort((a, b) => Math.max(a.made, a.handedOut ?? 0) - Math.max(b.made, b.handedOut ?? 0));
    for (const entry of oldest) {
      if (total <= limit) break;
      if (this.isHeld(entry) || entry.key === keep) continue;
      total -= entry.bytes;
      await this.remove(entry.key, "the cache is over its limit");
    }
  }
}

async function sizeOf(file: string): Promise<number> {
  const stat = await fs.promises.stat(file);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of await fs.promises.readdir(file)) total += await sizeOf(path.join(file, name));
  return total;
}

async function freeSpace(dir: string): Promise<number> {
  await fs.promises.mkdir(dir, { recursive: true });
  const stat = await fs.promises.statfs(dir);
  return stat.bavail * stat.bsize;
}
