/**
 * The Recordings tab's library (docs/system-design/desktop.md#recordings): the
 * videos in the output folder, newest first, with their length and size, and
 * the one way the sandboxed Settings page reaches their bytes.
 *
 * The page only ever holds ids. Each listing maps an id to a file it found
 * directly in the folder; `handle` serves the video (with byte ranges, so the
 * player can seek) or a thumbnail for a listed id and nothing else, and the
 * actions resolve the same way. A recording still being written keeps its
 * `.recording.mp4` name and is not listed. Listing is a read of the folder on
 * request (Settings opening or regaining focus, a recording saved, the folder
 * changed or a file moved to the Trash) and, only while RecordStuff's window is
 * open, after the folder's own change events (`watch`); never a timer or a poll.
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync, watch as watchFolder, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { mp4Duration } from "./mp4-duration";

export const MEDIA_SCHEME = "recordstuff-media";
/**
 * What the scheme is registered with before ready, by the app and by the Settings fixture alike: standard and
 * streaming, so <video> can fetch byte ranges, and allowed by the page's CSP as a secure origin.
 */
export const MEDIA_SCHEME_PRIVILEGES = { standard: true, secure: true, stream: true, supportFetchAPI: true } as const;
export type RecordingFileAction = "reveal" | "open" | "trash" | "drag";
export const RECORDING_FILE_ACTIONS: readonly RecordingFileAction[] = ["reveal", "open", "trash", "drag"];

export interface RecordingFile {
  id: string;
  path: string;
  name: string;
  size: number;
  /** When it was recorded: the name's own timestamp for the app's files, otherwise the file's birth time. */
  recordedAt: number;
  /** Seconds, once read; a file whose boxes do not say has none. */
  duration?: number;
  /** Changes whenever the file does, so a cached thumbnail is never shown for new content. */
  version: string;
}
export interface LibraryState {
  dir: string;
  loading: boolean;
  failed: boolean;
  files: RecordingFile[];
}
export interface LibraryDeps {
  dir: () => string;
  /** The listing changed; the UI re-projects. */
  changed: () => void;
  thumbnail: (filePath: string) => Promise<Buffer | undefined>;
  trash: (filePath: string) => Promise<void>;
  /** Resolves to an error message, empty on success, as `shell.openPath` does. */
  open: (filePath: string) => Promise<string>;
  reveal: (filePath: string) => void;
  log: (message: string) => void;
  /** Milliseconds on a monotonic clock; paces publishing lengths. */
  now?: () => number;
}

const VIDEO = /\.(mp4|m4v|mov)$/i;
/**
 * Thumbnails held in memory, a few screens of cards: each is a PNG of up to a few hundred kilobytes, and a
 * menu bar app stays running for days. The least recently shown goes first and is made again if shown.
 */
export const THUMBNAILS_KEPT = 64;
/** How long the folder stays quiet before it is listed again: a save, a copy or a move to the Trash is a burst of events. */
export const WATCH_SETTLE_MS = 250;
/** How often lengths read so far are published while a long folder is still being read. */
export const LENGTHS_PUBLISH_MS = 500;
/** `2026-10-04 14-02-11.mp4`, or `-2` and on when a name was taken (recorder.ts formatTimestamp). */
const STAMPED = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})(?:-\d+)?\.mp4$/;

/** The local time an app-named file was started at, or undefined for any other name. */
export function stampedTime(name: string): number | undefined {
  const match = STAMPED.exec(name);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match.map(Number) as number[];
  const time = new Date(y!, mo! - 1, d!, h!, mi!, s!).getTime();
  return Number.isFinite(time) ? time : undefined;
}

/** A video in the folder the library lists: not hidden, not still recording. */
export function isListedName(name: string): boolean {
  return !name.startsWith(".") && VIDEO.test(name) && !name.endsWith(".recording.mp4");
}

/** Stable for a path, so the page keeps a card, its focus and its thumbnail across refreshes. */
export function fileId(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 20);
}

/** `bytes=start-end`, `bytes=start-` or `bytes=-suffix` within `size`; null for a range that cannot be served. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

export class RecordingsLibrary {
  private current: LibraryState;
  private durations = new Map<string, { version: string; seconds: number | undefined }>();
  private thumbnails = new Map<string, { version: string; png: Promise<Buffer | undefined> }>();
  private generation = 0;
  /** The listing being read, and the one requested meanwhile, which every later caller shares. */
  private listing: Promise<void> | undefined;
  private relisting: Promise<void> | undefined;
  /** The folder watched while the window is open, and the listing its last burst of events is waiting for. */
  private watcher: { dir: string; ino: number; handle: FSWatcher; settle?: ReturnType<typeof setTimeout> | undefined } | undefined;
  /** A folder that could not be watched is said once, not on every focus. */
  private unwatchable: string | undefined;
  /** The window wants the folder followed, whether or not a watcher could be attached yet (review pass 1, F2). */
  private watching = false;
  /** Settles once the last listing's unknown lengths are read and published, or a newer listing abandoned them. */
  lengths: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LibraryDeps) {
    this.current = { dir: deps.dir(), loading: true, failed: false, files: [] };
  }

  get state(): LibraryState { return this.current; }

  find(id: string): RecordingFile | undefined {
    return this.current.files.find(file => file.id === id);
  }

  /**
   * Lists the folder and resolves once the listing is published, so an entry can open on it at once.
   * Lengths not yet known are read afterwards in the background, one file at a time, and published as
   * they are read, at most every `LENGTHS_PUBLISH_MS` (`lengths` settles once all are); a newer refresh abandons them.
   *
   * One listing reads the folder at a time. Opening Settings asks twice (the show, then the focus it
   * brings), and a saved recording's entry once more: requests made while a listing runs share one
   * more listing after it, so each still sees the folder as it was when it asked.
   */
  refresh(): Promise<void> {
    if (!this.listing) return this.listing = this.list().finally(() => { this.listing = undefined; });
    const next = (): Promise<void> => { this.relisting = undefined; return this.refresh(); };
    return this.relisting ??= this.listing.then(next, next);
  }

  private async list(): Promise<void> {
    const generation = ++this.generation;
    const dir = this.deps.dir();
    if (dir !== this.current.dir) this.current = { dir, loading: true, failed: false, files: [] };
    let files: RecordingFile[];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const stats = await Promise.all(entries.filter(entry => entry.isFile() && isListedName(entry.name)).map(async entry => {
        const filePath = path.join(dir, entry.name);
        try {
          const stat = await fs.stat(filePath);
          return stat.isFile() ? { entry, filePath, stat } : undefined;
        } catch { return undefined; }
      }));
      files = stats.filter(item => item !== undefined).map(({ entry, filePath, stat }) => {
        const version = `${stat.size}-${Math.round(stat.mtimeMs)}`;
        const known = this.durations.get(filePath);
        return {
          id: fileId(filePath), path: filePath, name: entry.name, size: stat.size, version,
          recordedAt: stampedTime(entry.name) ?? (stat.birthtimeMs || stat.mtimeMs),
          ...(known?.version === version && known.seconds !== undefined ? { duration: known.seconds } : {}),
        };
      }).sort((a, b) => b.recordedAt - a.recordedAt || a.name.localeCompare(b.name));
    } catch (cause) {
      if (generation !== this.generation) return;
      // A watcher on a folder that went away would stay on it even once one is made again at the same path.
      this.detach();
      this.deps.log(`library: could not list ${dir}: ${String(cause)}`);
      this.current = { dir, loading: false, failed: true, files: [] };
      this.deps.changed();
      return;
    }
    if (generation !== this.generation) return;
    this.current = { dir, loading: false, failed: false, files };
    this.forget(files);
    this.deps.changed();
    this.lengths = this.readLengths(generation, files);
    // The output folder changed while the window watches, one that could not be watched now lists, or the folder at
    // this path was replaced (review pass 2, P2-2): follow it. After publishing, so the listing never waits for it.
    if (this.watching) {
      const ino = await fs.stat(dir).then(stat => stat.ino, () => undefined);
      if (generation === this.generation && this.watching && (this.watcher?.dir !== dir || (ino !== undefined && ino !== this.watcher.ino))) {
        this.detach(); this.watch();
      }
    }
  }

  /**
   * While RecordStuff's window is open (2026-10-04): a video that appears in the folder, changes or
   * leaves it (deleted or moved in Finder) is listed again a moment later, so the tab follows the folder
   * without waiting for the window to regain focus. Event-driven (FSEvents on macOS), never polled; a
   * recording's growing `.recording.mp4` and other files are ignored. Idempotent; `unwatch` when the
   * window closes, so the menu bar app watches nothing while idle.
   */
  watch(): void {
    this.watching = true;
    const dir = this.deps.dir();
    if (this.watcher?.dir === dir) return;
    this.detach();
    let handle: FSWatcher, ino: number;
    try {
      ino = statSync(dir).ino;
      handle = watchFolder(dir, { persistent: false }, (_event, name) => {
        const watcher = this.watcher;
        if (watcher?.handle !== handle || (name && !isListedName(String(name)))) return;
        clearTimeout(watcher.settle);
        watcher.settle = setTimeout(() => { watcher.settle = undefined; void this.refresh(); }, WATCH_SETTLE_MS);
      });
    } catch (cause) {
      if (this.unwatchable !== dir) this.deps.log(`library: cannot watch ${dir}; it is listed when the window opens or regains focus: ${String(cause)}`);
      this.unwatchable = dir;
      return;
    }
    this.unwatchable = undefined;
    handle.on("error", (cause: unknown) => {
      this.deps.log(`library: stopped watching ${dir}: ${String(cause)}`);
      if (this.watcher?.handle === handle) this.detach();
    });
    this.watcher = { dir, ino, handle };
  }

  /** The window closed: no watcher and no pending listing remain. */
  unwatch(): void {
    this.watching = false;
    this.detach();
  }

  private detach(): void {
    const watcher = this.watcher;
    if (!watcher) return;
    this.watcher = undefined;
    clearTimeout(watcher.settle);
    watcher.handle.close();
  }

  /** Drops the lengths and thumbnails of files no longer listed: trashed, renamed or in a folder left behind. */
  private forget(files: RecordingFile[]): void {
    const listed = new Set(files.map(file => file.path));
    for (const cache of [this.durations, this.thumbnails]) {
      for (const filePath of cache.keys()) if (!listed.has(filePath)) cache.delete(filePath);
    }
  }

  /**
   * Reads the unknown lengths one file at a time. They are published every `LENGTHS_PUBLISH_MS` while
   * reading and once at the end, so a folder of long recordings fills in as it goes, not only once all are read.
   */
  private async readLengths(generation: number, files: RecordingFile[]): Promise<void> {
    const missing = files.filter(file => this.durations.get(file.path)?.version !== file.version);
    if (!missing.length) return;
    const now = this.deps.now ?? (() => performance.now());
    let published = now();
    for (const [index, file] of missing.entries()) {
      const seconds = await mp4Duration(file.path);
      if (generation !== this.generation) return;
      this.durations.set(file.path, { version: file.version, seconds });
      if (index < missing.length - 1 && now() - published >= LENGTHS_PUBLISH_MS) {
        this.publishLengths();
        published = now();
      }
    }
    this.publishLengths();
  }

  private publishLengths(): void {
    this.current = { ...this.current, files: this.current.files.map(file => {
      const seconds = this.durations.get(file.path);
      return seconds?.version === file.version && seconds.seconds !== undefined ? { ...file, duration: seconds.seconds } : file;
    }) };
    this.deps.changed();
  }

  /**
   * Runs an offered action on a listed file; false when it is gone or the action failed. Drag is the window's.
   * A failure lists the folder again before answering, so the reply already shows a file that left it: the
   * page then says so instead of offering a retry that cannot work.
   */
  async act(id: string, action: Exclude<RecordingFileAction, "drag">): Promise<boolean> {
    const file = this.find(id);
    if (!file) return false;
    try {
      if (action === "reveal") { await fs.access(file.path); this.deps.reveal(file.path); return true; }
      if (action === "open") {
        const error = await this.deps.open(file.path);
        if (!error) return true;
        this.deps.log(`library: open ${file.path} failed: ${error}`);
      } else {
        await this.deps.trash(file.path);
        this.deps.log(`library: moved ${file.path} to the Trash`);
        await this.refresh();
        return true;
      }
    } catch (cause) {
      this.deps.log(`library: ${action} ${file.path} failed: ${String(cause)}`);
    }
    await this.refresh();
    return false;
  }

  /** A listed file's thumbnail, made once per version of the file while it is among the `THUMBNAILS_KEPT` last shown. */
  thumbnail(file: RecordingFile): Promise<Buffer | undefined> {
    const cached = this.thumbnails.get(file.path);
    // Map order is use order: deleting and setting again makes this one the newest.
    this.thumbnails.delete(file.path);
    if (cached?.version === file.version) {
      this.thumbnails.set(file.path, cached);
      return cached.png;
    }
    const png = this.deps.thumbnail(file.path).catch((cause: unknown) => {
      this.deps.log(`library: no thumbnail for ${file.path}: ${String(cause)}`);
      return undefined;
    });
    this.thumbnails.set(file.path, { version: file.version, png });
    for (const oldest of this.thumbnails.keys()) {
      if (this.thumbnails.size <= THUMBNAILS_KEPT) break;
      this.thumbnails.delete(oldest);
    }
    return png;
  }

  /** `recordstuff-media://video/<id>` and `recordstuff-media://thumb/<id>`, for listed ids only. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const file = this.find(url.pathname.replace(/^\//, ""));
    if (!file || request.method !== "GET") return new Response(null, { status: 404 });
    if (url.host === "thumb") {
      const png = await this.thumbnail(file);
      return png ? new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "no-cache" } }) : new Response(null, { status: 404 });
    }
    if (url.host !== "video") return new Response(null, { status: 404 });
    let size: number;
    try { size = (await fs.stat(file.path)).size; } catch { return new Response(null, { status: 404 }); }
    const type = /\.mov$/i.test(file.name) ? "video/quicktime" : "video/mp4";
    const range = parseRange(request.headers.get("range"), size);
    if (range === null) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const body = size === 0 ? null : Readable.toWeb(createReadStream(file.path, { start, end })) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "content-type": type, "accept-ranges": "bytes", "content-length": String(size === 0 ? 0 : end - start + 1),
        ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      },
    });
  }
}
