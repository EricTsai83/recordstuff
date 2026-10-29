/**
 * Follows the output folder for as long as RecordStuff runs, recording or not (plan 100): a recording deleted, moved
 * or renamed in Finder is noticed at once, so what was made from it (its versions prepared for sharing) goes and its edit
 * follows it, instead of waiting until the window opens. It reads nothing: an event only asks for a check, after the
 * folder has been quiet for a moment, and the check looks at the few paths RecordStuff keeps something for.
 *
 * The Recordings tab's own watcher (recordings-library.ts `watch`) is separate and lists the folder, which only the open
 * window needs. macOS reports changes through FSEvents, Windows through ReadDirectoryChangesW; a network volume may
 * report none, which the checks at launch and as the window opens cover.
 */
import { watch as watchFolder, type FSWatcher } from "node:fs";

/** How long the folder stays quiet before a check: a save, a copy or a move to the Trash is a burst of events. */
export const FOLDER_SETTLE_MS = 500;
/**
 * The longest a check waits while events keep coming (a recording being written, a large copy): one runs at least this
 * often, so a deletion beside them is not put off indefinitely (Codex review).
 */
export const FOLDER_MAX_WAIT_MS = 5000;

export interface FolderWatchDeps {
  dir: () => string;
  /** Something in the folder changed: check what RecordStuff keeps for it. */
  changed: () => void;
  log: (message: string) => void;
  /** Starts watching `dir`; tests pass a fake. */
  watch?: (dir: string, listener: () => void) => Pick<FSWatcher, "close" | "on">;
  settleMs?: number;
  maxWaitMs?: number;
}

export class FolderWatch {
  private watcher: { dir: string; handle: Pick<FSWatcher, "close" | "on"> } | undefined;
  private settle: ReturnType<typeof setTimeout> | undefined;
  /** When the first event not yet checked came. */
  private pendingSince: number | undefined;
  /** A folder that could not be watched is said once. */
  private unwatchable: string | undefined;

  constructor(private readonly deps: FolderWatchDeps) {}

  /** Watches the output folder now, or again when it changed; idempotent. */
  start(): void {
    const dir = this.deps.dir();
    if (this.watcher?.dir === dir) return;
    this.stop();
    try {
      const watch = this.deps.watch ?? ((folder, listener) => watchFolder(folder, { persistent: false, recursive: true }, listener));
      const handle = watch(dir, () => this.event());
      handle.on("error", (cause: unknown) => {
        this.deps.log(`folder watch: stopped watching ${dir}: ${String(cause)}`);
        if (this.watcher?.handle !== handle) return;
        this.stop();
        // What changed meanwhile is checked now; watching starts again at the next check or as the window opens.
        this.deps.changed();
      });
      this.watcher = { dir, handle };
      this.unwatchable = undefined;
    } catch (cause) {
      if (this.unwatchable !== dir) this.deps.log(`folder watch: cannot watch ${dir}; it is checked at launch and as the window opens: ${String(cause)}`);
      this.unwatchable = dir;
    }
  }

  stop(): void {
    clearTimeout(this.settle);
    this.settle = undefined;
    this.pendingSince = undefined;
    this.watcher?.handle.close();
    this.watcher = undefined;
  }

  private event(): void {
    const now = Date.now();
    this.pendingSince ??= now;
    const settle = this.deps.settleMs ?? FOLDER_SETTLE_MS;
    const left = (this.deps.maxWaitMs ?? FOLDER_MAX_WAIT_MS) - (now - this.pendingSince);
    clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = undefined;
      this.pendingSince = undefined;
      this.deps.changed();
    }, Math.max(0, Math.min(settle, left)));
  }
}
