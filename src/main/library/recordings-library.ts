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
 * request (the window opening or regaining focus, Show last recording, a file
 * moved to the Trash, and while the window is open a recording saved or the
 * folder changed) and, only while RecordStuff's window is open, after the
 * folder's own change events (`watch`); never a timer or a poll.
 *
 * Folders (plan 071, 2026-10-09) are the output folder's own subfolders, one level deep: their direct videos are listed
 * with the folder's name, so Finder and the tab always agree and nothing else is stored. A recording moves between them
 * as a rename does, never replacing another file; new recordings are still saved in the output folder itself.
 *
 * Move to Trash waits `UNDO_TRASH_MS` before the file goes (2026-10-05): the card leaves at once and Undo (or ⌘Z)
 * brings it back meanwhile. A file in the Trash cannot be put back from here (the Trash's new name is not reported,
 * and macOS keeps apps out of `~/.Trash`), so the move itself waits instead; closing or hiding the window and quitting
 * move every waiting file at once.
 */
import { createHash } from "node:crypto";
import { createReadStream, watch as watchFolder, type Dirent, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { mp4Duration } from "./mp4-duration";
import { errnoCode } from "../lib/errors";
import { fileNameProblem, folderNameProblem, type FileNameProblem, type FolderProblem } from "../../shared/file-name";

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
  /** The subfolder it is in, by name; absent for one directly in the output folder. */
  folder?: string;
}
/** A subfolder of the output folder the tab offers (`isFolderName`): one holding videos, or nothing at all. */
export interface LibraryFolder {
  name: string;
  /** Holds no visible file (a recording waiting for the Trash aside), so it may be deleted. */
  empty: boolean;
}
export interface LibraryState {
  dir: string;
  loading: boolean;
  failed: boolean;
  files: RecordingFile[];
  /** By name, as Finder sorts them; absent until the first listing. */
  folders?: LibraryFolder[];
  /** The last file Move to Trash took off the list, which Undo brings back until it is really moved. */
  trashed?: { name: string };
  /** A file whose delayed move to the Trash failed: it is listed again, and the tab says so until the next action. */
  trashFailed?: string;
}
interface Thumbnail { version: string; jpeg: Promise<Buffer | undefined>; made?: boolean }
/** `ino` and `dev`: the file chosen, so a different file at its path by the time it is moved is never the one moved. */
interface PendingTrash { path: string; name: string; ino: number; dev: number; timer: ReturnType<typeof setTimeout>; moving?: Promise<void> }
/** Why a rename did not happen; `fileNameProblem`'s reasons, a name already taken, or the file system refusing. */
export type RenameProblem = FileNameProblem | "exists" | "missing" | "failed";
/** Why a move did not happen: a rename's reasons, or the folder it was to go to is no longer offered. */
export type MoveProblem = RenameProblem | "folderMissing";
export interface LibraryDeps {
  dir: () => string;
  /** The listing changed; the UI re-projects. */
  changed: () => void;
  /** A JPEG of the video's picture, or undefined when none can be made. */
  thumbnail: (filePath: string) => Promise<Buffer | undefined>;
  trash: (filePath: string) => Promise<void>;
  /** Resolves to an error message, empty on success, as `shell.openPath` does. */
  open: (filePath: string) => Promise<string>;
  reveal: (filePath: string) => void;
  log: (message: string) => void;
  /** Milliseconds on a monotonic clock; paces publishing lengths. */
  now?: () => number;
  /** Thumbnails made at once; `THUMBNAILS_AT_ONCE` unless a measurement compares another (`Infinity` for no limit). */
  thumbnailsAtOnce?: number;
}

const VIDEO = /\.(mp4|m4v|mov)$/i;
/**
 * Thumbnails held in memory, a few screens of cards: each is a JPEG of some tens of kilobytes, and a
 * menu bar app stays running for days. The least recently shown goes first and is made again if shown.
 */
export const THUMBNAILS_KEPT = 64;
/**
 * Thumbnails made at once: a fast scroll brings many cards near the view together, and each is a QuickLook read of
 * the video; the rest wait their turn instead of all reading the disk and decoding at the same time. The newest asked
 * goes first (2026-10-08): after a fast scroll those are the cards in view, while the ones asked on the way past wait.
 * Four, measured on an M1 Pro (`pnpm measure:thumbnails`, 2026-10-08): QuickLook made 240 pictures as fast as with no
 * limit, while three left them waiting several times longer.
 */
export const THUMBNAILS_AT_ONCE = 4;
/** How long the folder stays quiet before it is listed again: a save, a copy or a move to the Trash is a burst of events. */
export const WATCH_SETTLE_MS = 250;
/** How often lengths read so far are published while a long folder is still being read. */
export const LENGTHS_PUBLISH_MS = 500;
/**
 * How long a recording moved to the Trash can be brought back before it is really moved: longer than its toast stays
 * (2026-10-06, formerly 10 s), since ⌘Z still works once the toast has gone, and waiting only keeps the file in place.
 */
/** How long a picture that could not be made waits before its one more attempt. */
export const THUMBNAIL_RETRY_MS = 300;
export const UNDO_TRASH_MS = 30_000;
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

/** A name ending in an extension: a package such as `iMovie Library.imovielibrary` or `Foo.app`, or a file. */
const EXTENSION = /\.[a-z][a-z0-9-]*$/i;
/**
 * A subfolder the tab may offer: not hidden and not a package (2026-10-09). An output folder such as `~/Movies` also holds
 * the libraries of other apps, which are folders to the file system; a folder holding files but no video is left out too.
 */
export function isFolderName(name: string): boolean {
  return !name.startsWith(".") && !EXTENSION.test(name);
}

/**
 * Whether a change the recursive watch reports, by its path under the output folder, can change the listing: a listed
 * name in the folder or a direct subfolder, or a possible subfolder of the folder itself. Deeper changes, a recording's
 * growing `.recording.mp4` and other files are not; a change of what an empty folder holds waits for the next focus.
 */
export function listsAgain(name: string): boolean {
  const parts = name.split(/[\\/]/);
  if (parts.length === 1) return isListedName(parts[0]!) || isFolderName(parts[0]!);
  return parts.length === 2 && isFolderName(parts[0]!) && isListedName(parts[1]!);
}

/** Changes whenever the file's bytes do, as far as its size and modification time tell. */
function fileVersion(stat: { size: number; mtimeMs: number }): string {
  return `${stat.size}-${Math.round(stat.mtimeMs)}`;
}

/** Stable for a path, so the page keeps a card, its focus and its thumbnail across refreshes. */
export function fileId(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 20);
}

/** `bytes=start-end`, `bytes=start-` or `bytes=-suffix` within `size`; null for a range that cannot be served. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // An empty file has no byte to serve, whichever form the range takes.
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
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
  /** `made` once the picture exists: only then does it belong to the bytes rather than to a path still to be read. */
  private thumbnails = new Map<string, Thumbnail>();
  /** Thumbnails being made, at most `THUMBNAILS_AT_ONCE`, and the ones waiting their turn, newest last. */
  private thumbnailsMaking = 0;
  private thumbnailsWaiting: Array<() => void> = [];
  private generation = 0;
  /**
   * Paths a rename moved cached lengths and thumbnails to, with the last listing begun by then: that listing, read
   * before the rename, does not list the new name, and must not take its caches away (`forget`).
   */
  private carried = new Map<string, number>();
  /** Bumped as the window closes: lengths still to be read wait for the next listing instead of reading on unseen. */
  private lengthsRun = 0;
  /** The listing being read, and the one requested meanwhile, which every later caller shares. */
  private listing: Promise<void> | undefined;
  private relisting: Promise<void> | undefined;
  /** The folder watched while the window is open, and the listing its last burst of events is waiting for. */
  private watcher: { dir: string; ino: number; handle: FSWatcher; settle?: ReturnType<typeof setTimeout> | undefined } | undefined;
  /** A folder that could not be watched is said once, not on every focus. */
  private unwatchable: string | undefined;
  /** The window wants the folder followed, whether or not a watcher could be attached yet (review pass 1, F2). */
  private watching = false;
  /** The folder `watch` is looking at before it attaches, so a second focus meanwhile does not look again. */
  private attaching: string | undefined;
  /** Settles once the last listing's unknown lengths are read and published, or a newer listing abandoned them. */
  lengths: Promise<void> = Promise.resolve();
  /**
   * Files Move to Trash took off the list, oldest first, each waiting for its timer (or a flush) to be moved. Once its
   * move has begun (`moving`) it can no longer be undone and every later flush waits on that same move.
   */
  private pendingTrash: PendingTrash[] = [];
  /** The last delayed move that failed, until the next action on a file. */
  private trashFailed: string | undefined;

  constructor(private readonly deps: LibraryDeps) {
    this.current = { dir: deps.dir(), loading: true, failed: false, files: [], folders: [] };
  }

  get state(): LibraryState {
    // Only a file whose move has not begun can still be brought back.
    const trashed = this.pendingTrash.findLast(entry => !entry.moving);
    return trashed || this.trashFailed
      ? { ...this.current, ...(trashed ? { trashed: { name: trashed.name } } : {}), ...(this.trashFailed ? { trashFailed: this.trashFailed } : {}) }
      : this.current;
  }

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

  /**
   * A listing for an open window only. A save or a changed folder asks for one; with the window closed nothing would
   * show it, and the window lists the folder itself when it opens (and Show last recording before it does), so the
   * folder and every new file's boxes are not read for nobody, right as the next recording may start.
   */
  refreshIfWatched(): Promise<void> {
    return this.watching ? this.refresh() : Promise.resolve();
  }

  private async list(): Promise<void> {
    const generation = ++this.generation;
    const run = this.lengthsRun;
    const dir = this.deps.dir();
    if (dir !== this.current.dir) this.current = { dir, loading: true, failed: false, files: [], folders: [] };
    let files: RecordingFile[];
    const folders: LibraryFolder[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      // A file waiting to go to the Trash is already gone as far as the tab is concerned.
      const waiting = new Set(this.pendingTrash.map(item => item.path));
      const videos = (inside: string, found: Dirent[], folder?: string): Array<{ name: string; filePath: string; folder?: string }> =>
        found.filter(entry => entry.isFile() && isListedName(entry.name) && !waiting.has(path.join(inside, entry.name)))
          .map(entry => ({ name: entry.name, filePath: path.join(inside, entry.name), ...(folder === undefined ? {} : { folder }) }));
      const candidates = videos(dir, entries);
      // One level only, and never through a link: a subfolder's own folders are not looked into.
      await Promise.all(entries.filter(entry => entry.isDirectory() && isFolderName(entry.name)).map(async entry => {
        const folderPath = path.join(dir, entry.name);
        let inner: Dirent[];
        try {
          inner = await fs.readdir(folderPath, { withFileTypes: true });
        } catch (cause) {
          this.deps.log(`library: could not list ${folderPath}: ${String(cause)}`);
          return;
        }
        const visible = inner.filter(found => !found.name.startsWith(".") && !waiting.has(path.join(folderPath, found.name)));
        const listed = videos(folderPath, inner, entry.name);
        // A recording waiting for the Trash still counts as the folder's video, so Undo finds its folder there.
        const holdsWaiting = inner.some(found => waiting.has(path.join(folderPath, found.name)));
        if (visible.length && !listed.length && !holdsWaiting) return;
        folders.push({ name: entry.name, empty: !visible.length });
        candidates.push(...listed);
      }));
      folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const stats = await Promise.all(candidates.map(async candidate => {
        try {
          const stat = await fs.stat(candidate.filePath);
          return stat.isFile() ? { ...candidate, stat } : undefined;
        } catch { return undefined; }
      }));
      files = stats.filter(item => item !== undefined).map(({ name, filePath, folder, stat }) => {
        const version = fileVersion(stat);
        const known = this.durations.get(filePath);
        return {
          id: fileId(filePath), path: filePath, name, size: stat.size, version,
          recordedAt: stampedTime(name) ?? (stat.birthtimeMs || stat.mtimeMs),
          ...(known?.version === version && known.seconds !== undefined ? { duration: known.seconds } : {}),
          ...(folder === undefined ? {} : { folder }),
        };
      }).sort((a, b) => b.recordedAt - a.recordedAt || a.name.localeCompare(b.name) || (a.folder ?? "").localeCompare(b.folder ?? ""));
    } catch (cause) {
      if (generation !== this.generation) return;
      // A watcher on a folder that went away would stay on it even once one is made again at the same path.
      this.detach();
      this.deps.log(`library: could not list ${dir}: ${String(cause)}`);
      this.current = { dir, loading: false, failed: true, files: [], folders: [] };
      this.deps.changed();
      return;
    }
    if (generation !== this.generation) return;
    this.current = { dir, loading: false, failed: false, files, folders };
    this.forget(files, generation);
    this.deps.changed();
    this.lengths = this.readLengths(generation, run, files);
    // The output folder changed while the window watches, one that could not be watched now lists, or the folder at
    // this path was replaced (review pass 2, P2-2): follow it. After publishing, so the listing never waits for it.
    if (this.watching) {
      const ino = await fs.stat(dir).then(stat => stat.ino, () => undefined);
      if (generation === this.generation && this.watching && ino !== undefined && (this.watcher?.dir !== dir || ino !== this.watcher.ino)) {
        this.attach(dir, ino);
      }
    }
  }

  /**
   * While RecordStuff's window is open (2026-10-04): a video that appears in the folder, changes or
   * leaves it (deleted or moved in Finder) is listed again a moment later, so the tab follows the folder
   * without waiting for the window to regain focus. Event-driven (FSEvents on macOS), never polled; a
   * recording's growing `.recording.mp4` and other files are ignored. Idempotent; `unwatch` when the
   * window closes or is hidden, so the menu bar app watches nothing while idle. The folder is looked at
   * asynchronously first: it is asked for on every focus, and on a network folder whose server has gone
   * a synchronous look would hold the main process (the tray, the shortcut, a recording's chunks) for its timeout.
   */
  watch(): void {
    this.watching = true;
    const dir = this.deps.dir();
    if (this.watcher?.dir === dir || this.attaching === dir) return;
    this.attaching = dir;
    void fs.stat(dir).then(stat => stat.ino, (cause: unknown) => ({ cause })).then(found => {
      if (this.attaching === dir) this.attaching = undefined;
      if (!this.watching || this.deps.dir() !== dir || this.watcher?.dir === dir) return;
      if (typeof found === "number") this.attach(dir, found);
      else this.cannotWatch(dir, found.cause);
    });
  }

  /** Follows `dir`, whose inode was just read, in place of any folder watched before. */
  private attach(dir: string, ino: number): void {
    this.detach();
    let handle: FSWatcher;
    try {
      // Recursive, for the subfolders' videos (2026-10-09): FSEvents and Windows watch a tree natively, and `listsAgain`
      // drops everything deeper than the tab looks.
      const own = path.basename(dir);
      handle = watchFolder(dir, { persistent: false, recursive: true }, (event, name) => {
        const watcher = this.watcher;
        // FSEvents also reports the watched folder itself, as a change under its own name, as it settles after being made;
        // a subfolder of the same name appears, goes or is renamed as a rename (review pass 1, F5).
        if (watcher?.handle !== handle || (name && (!listsAgain(String(name)) || (event === "change" && String(name) === own)))) return;
        clearTimeout(watcher.settle);
        watcher.settle = setTimeout(() => { watcher.settle = undefined; void this.refresh(); }, WATCH_SETTLE_MS);
      });
    } catch (cause) {
      this.cannotWatch(dir, cause);
      return;
    }
    this.unwatchable = undefined;
    handle.on("error", (cause: unknown) => {
      this.deps.log(`library: stopped watching ${dir}: ${String(cause)}`);
      if (this.watcher?.handle === handle) this.detach();
    });
    this.watcher = { dir, ino, handle };
  }

  private cannotWatch(dir: string, cause: unknown): void {
    if (this.unwatchable !== dir) this.deps.log(`library: cannot watch ${dir}; it is listed when the window opens or regains focus: ${String(cause)}`);
    this.unwatchable = dir;
  }

  /**
   * The window closed: no watcher and no pending listing remain, and no length is read for a card nobody sees, so a
   * large folder is not still being read while the next recording writes. Lengths already read are kept.
   */
  unwatch(): void {
    this.watching = false;
    this.lengthsRun++;
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
  private forget(files: RecordingFile[], generation: number): void {
    // A file waiting for the Trash keeps them, so Undo brings its card back as it was, and a listing begun before a
    // rename keeps what the rename carried to the new name; a later listing sees that name itself.
    for (const [carried, since] of this.carried) if (since < generation) this.carried.delete(carried);
    const listed = new Set([...files.map(file => file.path), ...this.pendingTrash.map(entry => entry.path), ...this.carried.keys()]);
    for (const cache of [this.durations, this.thumbnails]) {
      for (const filePath of cache.keys()) if (!listed.has(filePath)) cache.delete(filePath);
    }
  }

  /**
   * Reads the unknown lengths one file at a time. They are published every `LENGTHS_PUBLISH_MS` while
   * reading and once at the end, so a folder of long recordings fills in as it goes, not only once all are read.
   */
  private async readLengths(generation: number, run: number, files: RecordingFile[]): Promise<void> {
    const missing = files.filter(file => this.durations.get(file.path)?.version !== file.version);
    if (!missing.length) return;
    const now = this.deps.now ?? (() => performance.now());
    let published = now();
    for (const [index, file] of missing.entries()) {
      if (run !== this.lengthsRun) return;
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
    this.trashFailed = undefined;
    try {
      if (action === "reveal") { await fs.access(file.path); this.deps.reveal(file.path); return true; }
      if (action === "open") {
        const error = await this.deps.open(file.path);
        if (!error) return true;
        this.deps.log(`library: open ${file.path} failed: ${error}`);
      } else {
        // Already waiting: a second entry for the same file would still move it after Undo brought the first back.
        const waiting = (): boolean => this.pendingTrash.some(entry => entry.path === file.path);
        if (waiting()) return true;
        // A file already gone fails now, while the page can still say so beside its card.
        const { ino, dev } = await fs.stat(file.path);
        if (waiting()) return true;
        const entry: PendingTrash = { path: file.path, name: file.name, ino, dev, timer: setTimeout(() => void this.commitTrash(entry), UNDO_TRASH_MS) };
        this.pendingTrash.push(entry);
        this.deps.log(`library: ${file.path} goes to the Trash in ${UNDO_TRASH_MS / 1000} s unless undone`);
        await this.refresh();
        return true;
      }
    } catch (cause) {
      this.deps.log(`library: ${action} ${file.path} failed: ${String(cause)}`);
    }
    await this.refresh();
    return false;
  }

  /** Brings back the file Move to Trash took last, while it still waits; false when none does. */
  async undoTrash(): Promise<boolean> {
    const entry = this.pendingTrash.findLast(item => !item.moving);
    if (!entry) return false;
    this.pendingTrash = this.pendingTrash.filter(item => item !== entry);
    clearTimeout(entry.timer);
    this.trashFailed = undefined;
    this.deps.log(`library: kept ${entry.path}; its move to the Trash was undone`);
    await this.refresh();
    return true;
  }

  /** Moves every waiting file to the Trash now: the window closed or hid, or RecordStuff is quitting. Never throws. */
  async flushTrash(): Promise<void> {
    await Promise.all([...this.pendingTrash].map(entry => this.commitTrash(entry)));
  }

  /**
   * Moves one waiting file once: a flush during a move its timer began waits on that move. A failure lists it again and
   * says so. It leaves the waiting list, and so stays off the listing, only once moved or failed.
   */
  private commitTrash(entry: PendingTrash): Promise<void> {
    clearTimeout(entry.timer);
    if (entry.moving) return entry.moving;
    // Undone meanwhile.
    if (!this.pendingTrash.includes(entry)) return Promise.resolve();
    entry.moving = this.moveToTrash(entry);
    // Undo is no longer offered for it.
    this.deps.changed();
    return entry.moving;
  }

  private async moveToTrash(entry: PendingTrash): Promise<void> {
    // A folder being renamed rewrites its waiting recordings' paths once it has its new name.
    await this.folderRenaming;
    // Renamed or moved away in Finder meanwhile, with another file now at its path: that file stays, and is listed again
    // (review pass 2, F1). A file already gone is left to the move, which fails and says so.
    const now = await fs.stat(entry.path).catch(() => undefined);
    if (now && (now.ino !== entry.ino || now.dev !== entry.dev)) {
      this.deps.log(`library: ${entry.path} is another file now; it was not moved to the Trash`);
      this.pendingTrash = this.pendingTrash.filter(item => item !== entry);
      await this.refresh();
      return;
    }
    try {
      await this.deps.trash(entry.path);
      this.deps.log(`library: moved ${entry.path} to the Trash`);
      this.pendingTrash = this.pendingTrash.filter(item => item !== entry);
      // The listing already left it out; only the Undo it offered changes.
      this.deps.changed();
    } catch (cause) {
      this.deps.log(`library: moving ${entry.path} to the Trash failed: ${String(cause)}`);
      this.pendingTrash = this.pendingTrash.filter(item => item !== entry);
      this.trashFailed = entry.name;
      await this.refresh();
    }
  }

  /**
   * Renames a listed file within its folder, keeping its extension: the page's new name, checked as a new recording's
   * name is (file-name.ts). Never replaces another file (`relocate`). Resolves to the file's new id, or why it did not.
   */
  async rename(id: string, requested: string): Promise<{ id: string } | { problem: RenameProblem }> {
    const file = this.find(id);
    if (!file) return { problem: "missing" };
    this.trashFailed = undefined;
    const name = requested.trim();
    const problem = fileNameProblem(name);
    if (problem) return { problem };
    const target = path.join(path.dirname(file.path), `${name}${path.extname(file.name)}`);
    if (target === file.path) return { id };
    return this.relocate(file, target);
  }

  /**
   * Moves a listed file, under its own name, into a listed folder, or with `null` back into the output folder itself
   * (plan 071). Never replaces another file: a name already taken there is refused, as a rename's is.
   */
  move(id: string, folder: string | null): Promise<{ id: string } | { problem: MoveProblem }> {
    // In the folder queue (review pass 2, F1): a recording moved into a folder while it is being deleted would go to the
    // Trash with it.
    return this.queued(() => this.moveListed(id, folder));
  }

  private async moveListed(id: string, folder: string | null): Promise<{ id: string } | { problem: MoveProblem }> {
    const file = this.find(id);
    if (!file) return { problem: "missing" };
    this.trashFailed = undefined;
    if (folder !== null && !this.current.folders?.some(entry => entry.name === folder)) return { problem: "folderMissing" };
    const target = path.join(folder === null ? this.current.dir : path.join(this.current.dir, folder), file.name);
    if (target === file.path) return { id };
    return this.relocate(file, target);
  }

  /**
   * Gives a listed file the path `target`, never replacing another file: a hard link takes the new path only when it is
   * free, then the old one goes; a volume without hard links takes the new path with an exclusive create, then moves the
   * file onto it. Its length and thumbnail carry over.
   */
  private async relocate(file: RecordingFile, target: string): Promise<{ id: string } | { problem: RenameProblem }> {
    let linked = false, reserved = false;
    // A subfolder replaced by a link since it was listed would take the file out of the output folder, or bring another
    // in (review pass 1, F2): both ends must still be the output folder or a real folder directly in it.
    const real = async (folder: string): Promise<boolean> => folder === this.current.dir ||
      (path.dirname(folder) === this.current.dir && await fs.lstat(folder).then(stat => stat.isDirectory(), () => false));
    if (!await real(path.dirname(file.path)) || !await real(path.dirname(target))) {
      this.deps.log(`library: ${file.path} or ${target} is no longer in a folder of the output folder; not moved`);
      await this.refresh();
      return { problem: "missing" };
    }
    try {
      try {
        await fs.link(file.path, target);
        linked = true;
      } catch (cause) {
        const code = errnoCode(cause);
        if (code === "ENOENT") throw cause;
        // Taken by another file, or the same file under another case on a case-insensitive volume, which may change case.
        const taken = await fs.lstat(target).then(stat => stat, () => undefined);
        const own = await fs.stat(file.path);
        if (taken && (taken.ino !== own.ino || taken.dev !== own.dev)) return { problem: "exists" };
        if (!taken) {
          // No hard links on this volume: the name is taken first with an exclusive create, which fails if anything
          // holds it, and the file then moves onto that empty placeholder, so no other file is ever replaced.
          this.deps.log(`library: no hard link for ${file.path} (${code ?? String(cause)}); reserving the new name first`);
          try {
            await (await fs.open(target, "wx")).close();
          } catch (reserve) {
            if (errnoCode(reserve) === "EEXIST") return { problem: "exists" };
            throw reserve;
          }
          reserved = true;
        }
        await fs.rename(file.path, target);
        reserved = false;
      }
      if (linked) await fs.unlink(file.path);
    } catch (cause) {
      // The new name was linked but the old one stayed: the new one goes again, so the file is listed once. A
      // placeholder the file did not move onto goes too.
      if (linked || reserved) await fs.unlink(target).catch(() => undefined);
      this.deps.log(`library: renaming ${file.path} to ${target} failed: ${String(cause)}`);
      await this.refresh();
      return { problem: errnoCode(cause) === "ENOENT" ? "missing" : "failed" };
    }
    this.deps.log(`library: renamed ${file.path} to ${target}`);
    this.carry(file.path, target);
    await this.refresh();
    return { id: fileId(target) };
  }

  /**
   * The same bytes at a new path: its length and thumbnail carry over instead of being read again. A thumbnail not made
   * yet, waiting its turn or being read, would read the old path, so it is made again from the new one instead.
   */
  private carry(from: string, to: string): void {
    const seconds = this.durations.get(from);
    if (seconds !== undefined) { this.durations.delete(from); this.durations.set(to, seconds); }
    const thumbnail = this.thumbnails.get(from);
    this.thumbnails.delete(from);
    if (thumbnail?.made) this.thumbnails.set(to, thumbnail);
    this.carried.set(to, this.generation);
  }

  /**
   * Folder actions run one at a time (review pass 1, F3): two renames to one name cannot both find it free, so the second
   * cannot replace the folder the first just made. Another app making that name in the instant between the look and the
   * rename can still lose an empty folder, which Node offers no exclusive rename to prevent.
   */
  private folderQueue: Promise<unknown> = Promise.resolve();
  /** Settles once a folder rename and its waiting recordings' new paths are done. */
  private folderRenaming: Promise<void> | undefined;
  private queued<T>(run: () => Promise<T>): Promise<T> {
    const next = this.folderQueue.then(run, run);
    this.folderQueue = next.catch(() => undefined);
    return next;
  }

  /** Makes a new, empty subfolder of the output folder (plan 071); never one that is already there. */
  createFolder(requested: string): Promise<{ folder: string } | { problem: FolderProblem }> {
    return this.queued(() => this.makeFolder(requested));
  }

  renameFolder(folder: string, requested: string): Promise<{ folder: string } | { problem: FolderProblem }> {
    return this.queued(() => this.renameListedFolder(folder, requested));
  }

  removeFolder(folder: string): Promise<true | { problem: FolderProblem }> {
    return this.queued(() => this.trashFolder(folder));
  }

  private async makeFolder(requested: string): Promise<{ folder: string } | { problem: FolderProblem }> {
    const name = requested.trim();
    const problem = folderNameProblem(name);
    if (problem) return { problem };
    this.trashFailed = undefined;
    const folderPath = path.join(this.current.dir, name);
    try {
      await fs.mkdir(folderPath);
    } catch (cause) {
      this.deps.log(`library: could not make ${folderPath}: ${String(cause)}`);
      return { problem: errnoCode(cause) === "EEXIST" ? "exists" : "failed" };
    }
    this.deps.log(`library: made ${folderPath}`);
    await this.refresh();
    return { folder: name };
  }

  /**
   * Renames a listed folder, never onto another file or folder (a case-only change is allowed). Recordings in it keep
   * their lengths and thumbnails, and one waiting for the Trash keeps its Undo, at the new path.
   */
  private async renameListedFolder(folder: string, requested: string): Promise<{ folder: string } | { problem: FolderProblem }> {
    if (!this.current.folders?.some(entry => entry.name === folder)) return { problem: "missing" };
    const name = requested.trim();
    const problem = folderNameProblem(name);
    if (problem) return { problem };
    this.trashFailed = undefined;
    if (name === folder) return { folder };
    const from = path.join(this.current.dir, folder), to = path.join(this.current.dir, name);
    // A recording of the folder already being moved to the Trash finishes at its old path first, and one whose time comes
    // meanwhile waits until its path names the folder's new name (review pass 2, F2).
    await Promise.all(this.pendingTrash.filter(entry => path.dirname(entry.path) === from && entry.moving).map(entry => entry.moving));
    let renamed!: () => void;
    this.folderRenaming = new Promise<void>(resolve => { renamed = resolve; });
    try {
      return await this.renameFolderNow(name, from, to);
    } finally {
      this.folderRenaming = undefined;
      renamed();
    }
  }

  private async renameFolderNow(name: string, from: string, to: string): Promise<{ folder: string } | { problem: FolderProblem }> {
    try {
      const own = await fs.stat(from);
      const taken = await fs.lstat(to).then(stat => stat, () => undefined);
      if (taken && (taken.ino !== own.ino || taken.dev !== own.dev)) return { problem: "exists" };
      // A folder made at the new name in the instant between that look and the rename, if empty, is the only thing
      // `rename` could replace; anything holding a file fails with ENOTEMPTY, and a file with ENOTDIR.
      await fs.rename(from, to);
    } catch (cause) {
      const code = errnoCode(cause);
      this.deps.log(`library: renaming ${from} to ${to} failed: ${String(cause)}`);
      await this.refresh();
      return { problem: code === "ENOENT" ? "missing" : code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR" ? "exists" : "failed" };
    }
    this.deps.log(`library: renamed ${from} to ${to}`);
    const inside = (filePath: string): boolean => path.dirname(filePath) === from;
    for (const entry of this.pendingTrash) if (inside(entry.path)) entry.path = path.join(to, path.basename(entry.path));
    for (const file of this.current.files) if (inside(file.path)) this.carry(file.path, path.join(to, file.name));
    await this.refresh();
    return { folder: name };
  }

  /**
   * Moves a listed folder that holds no visible file to the Trash (plan 071). Recordings in it still waiting for the
   * Trash go first, since the folder would take them anyway; their Undo ends. A folder holding anything else is refused
   * before any of them goes (review pass 1, F4).
   */
  private async trashFolder(folder: string): Promise<true | { problem: FolderProblem }> {
    if (!this.current.folders?.some(entry => entry.name === folder)) return { problem: "missing" };
    this.trashFailed = undefined;
    const folderPath = path.join(this.current.dir, folder);
    const waiting = (): PendingTrash[] => this.pendingTrash.filter(entry => path.dirname(entry.path) === folderPath);
    const visible = async (): Promise<boolean> => {
      const left = new Set(waiting().map(entry => path.basename(entry.path)));
      return (await fs.readdir(folderPath)).some(name => !name.startsWith(".") && !left.has(name));
    };
    try {
      if (await visible()) {
        await this.refresh();
        return { problem: "notEmpty" };
      }
      await Promise.all(waiting().map(entry => this.commitTrash(entry)));
      if (await visible() || waiting().length) {
        await this.refresh();
        return { problem: "notEmpty" };
      }
      await this.deps.trash(folderPath);
    } catch (cause) {
      this.deps.log(`library: moving ${folderPath} to the Trash failed: ${String(cause)}`);
      await this.refresh();
      return { problem: errnoCode(cause) === "ENOENT" ? "missing" : "failed" };
    }
    this.deps.log(`library: moved ${folderPath} to the Trash`);
    await this.refresh();
    return true;
  }

  /** A listed file's thumbnail, made once per version of the file while it is among the `THUMBNAILS_KEPT` last shown. */
  thumbnail(file: RecordingFile): Promise<Buffer | undefined> {
    const cached = this.thumbnails.get(file.path);
    // Map order is use order: deleting and setting again makes this one the newest.
    this.thumbnails.delete(file.path);
    // A picture that could not be made is asked for again: the OS's thumbnailer can fail for a moment (Windows).
    if (cached?.version === file.version && cached.made !== false) {
      this.thumbnails.set(file.path, cached);
      return cached.jpeg;
    }
    // The OS's thumbnailer can fail for a moment (Windows Shell, 2026-10-09 on CI): once more after a pause, queued
    // like any other request, so a failure still gives up its turn at once.
    const jpeg = this.makeThumbnail(file.path).then(async made => {
      if (made) return made;
      await new Promise(resolve => setTimeout(resolve, THUMBNAIL_RETRY_MS));
      return this.makeThumbnail(file.path);
    });
    const entry: Thumbnail = { version: file.version, jpeg };
    void jpeg.then(made => { entry.made = made !== undefined; });
    this.thumbnails.set(file.path, entry);
    for (const oldest of this.thumbnails.keys()) {
      if (this.thumbnails.size <= THUMBNAILS_KEPT) break;
      this.thumbnails.delete(oldest);
    }
    return jpeg;
  }

  private async makeThumbnail(filePath: string): Promise<Buffer | undefined> {
    if (this.thumbnailsMaking >= (this.deps.thumbnailsAtOnce ?? THUMBNAILS_AT_ONCE)) await new Promise<void>(resolve => this.thumbnailsWaiting.push(resolve));
    else this.thumbnailsMaking++;
    try {
      return await this.deps.thumbnail(filePath);
    } catch (cause) {
      this.deps.log(`library: no thumbnail for ${filePath}: ${String(cause)}`);
      return undefined;
    } finally {
      // The turn passes straight to the newest waiting, so the count stays as it is; with none waiting it drops.
      const next = this.thumbnailsWaiting.pop();
      if (next) next();
      else this.thumbnailsMaking--;
    }
  }

  /** `recordstuff-media://video/<id>` and `recordstuff-media://thumb/<id>`, for listed ids only. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const file = this.find(url.pathname.replace(/^\//, ""));
    if (!file || request.method !== "GET") return new Response(null, { status: 404 });
    if (url.host === "thumb") {
      const jpeg = await this.thumbnail(file);
      if (!jpeg) return new Response(null, { status: 404 });
      // The address carries the file's version, so the picture for it never changes and the page may keep it. An
      // address from an older listing, or a file changed since it was listed (perhaps while its picture waited its
      // turn), is answered with whatever was read, which must not be kept under that address.
      const current = url.searchParams.get("v") === file.version &&
        await fs.stat(file.path).then(stat => fileVersion(stat) === file.version, () => false);
      return new Response(new Uint8Array(jpeg), {
        headers: { "content-type": "image/jpeg", "cache-control": current ? "max-age=31536000, immutable" : "no-cache" },
      });
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
