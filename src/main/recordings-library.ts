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
 * changed or a file moved to the Trash), never a watcher or a timer.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { mp4Duration } from "./mp4-duration";

export const MEDIA_SCHEME = "recordstuff-media";
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
}

const VIDEO = /\.(mp4|m4v|mov)$/i;
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

  constructor(private readonly deps: LibraryDeps) {
    this.current = { dir: deps.dir(), loading: true, failed: false, files: [] };
  }

  get state(): LibraryState { return this.current; }

  find(id: string): RecordingFile | undefined {
    return this.current.files.find(file => file.id === id);
  }

  /**
   * Lists the folder and resolves once the listing is published, so an entry can open on it at once.
   * Lengths not yet known are read afterwards in the background, one file at a time, and published
   * together (`lengths` settles when they are); a newer refresh abandons them.
   */
  lengths: Promise<void> = Promise.resolve();
  async refresh(): Promise<void> {
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
      this.deps.log(`library: could not list ${dir}: ${String(cause)}`);
      this.current = { dir, loading: false, failed: true, files: [] };
      this.deps.changed();
      return;
    }
    if (generation !== this.generation) return;
    this.current = { dir, loading: false, failed: false, files };
    this.deps.changed();
    this.lengths = this.readLengths(generation, files);
  }

  private async readLengths(generation: number, files: RecordingFile[]): Promise<void> {
    const missing = files.filter(file => this.durations.get(file.path)?.version !== file.version);
    if (!missing.length) return;
    for (const file of missing) {
      const seconds = await mp4Duration(file.path);
      if (generation !== this.generation) return;
      this.durations.set(file.path, { version: file.version, seconds });
    }
    this.current = { ...this.current, files: this.current.files.map(file => {
      const seconds = this.durations.get(file.path);
      return seconds?.version === file.version && seconds.seconds !== undefined ? { ...file, duration: seconds.seconds } : file;
    }) };
    this.deps.changed();
  }

  /** Runs an offered action on a listed file; false when it is gone or the action failed. Drag is the window's. */
  async act(id: string, action: Exclude<RecordingFileAction, "drag">): Promise<boolean> {
    const file = this.find(id);
    if (!file) return false;
    try {
      if (action === "reveal") { await fs.access(file.path); this.deps.reveal(file.path); return true; }
      if (action === "open") {
        const error = await this.deps.open(file.path);
        if (error) this.deps.log(`library: open ${file.path} failed: ${error}`);
        return !error;
      }
      await this.deps.trash(file.path);
      this.deps.log(`library: moved ${file.path} to the Trash`);
      await this.refresh();
      return true;
    } catch (cause) {
      this.deps.log(`library: ${action} ${file.path} failed: ${String(cause)}`);
      void this.refresh();
      return false;
    }
  }

  /** A listed file's thumbnail, made once per version of the file. */
  thumbnail(file: RecordingFile): Promise<Buffer | undefined> {
    const cached = this.thumbnails.get(file.path);
    if (cached?.version === file.version) return cached.png;
    const png = this.deps.thumbnail(file.path).catch((cause: unknown) => {
      this.deps.log(`library: no thumbnail for ${file.path}: ${String(cause)}`);
      return undefined;
    });
    this.thumbnails.set(file.path, { version: file.version, png });
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
