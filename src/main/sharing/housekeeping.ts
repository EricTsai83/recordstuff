/**
 * What RecordStuff keeps for a recording, kept only while the recording is (plan 100): its versions prepared for
 * sharing and its edit. Nothing grows unseen: what goes by itself goes as soon as it is known to be unneeded, and what
 * is kept for a recording out of sight is listed in Settings with a way to remove it.
 *
 * - **Versions** (can be made again) leave with their recording from the Recordings tab, whatever the reason
 *   (`Sharing.sweep`).
 * - **An edit** (cannot be made again) goes when its recording is known to be deleted: its path is empty on a disk that
 *   is there, and no file in the output folder has its bytes (a recording renamed or moved in Finder takes its edit
 *   along instead). One whose recording is on a disk that is away, or outside the output folder, is kept and listed
 *   (`kept`): the edit returns with its recording, or the person removes it.
 *
 * A check runs at launch, as the window lists the folder and after every change the folder watch reports; one at a time.
 */
import fs from "node:fs";
import path from "node:path";
import { sourceIdentity, type LoadedEdit, type SourceIdentity } from "../editing/edit-store";
import { SerialQueue } from "../lib/serial-queue";
import { inOutputFolder } from "./sharing";

/** An edit kept for a recording not in the Recordings tab: why, and its record's size. */
export interface KeptEdit {
  source: string;
  /** The recording's disk is away (`disk`), or the recording is outside the output folder (`elsewhere`). */
  reason: "disk" | "elsewhere";
  bytes: number;
}

export interface HousekeepingDeps {
  store: {
    records(): ReadonlyMap<string, SourceIdentity>;
    load(source: string, identity: SourceIdentity): Promise<LoadedEdit>;
    discard(source: string): Promise<void>;
    fileFor(source: string): string;
  };
  /** The versions' own sweep (sharing.ts). */
  sweepVersions(dir: string): Promise<void>;
  outputDir(): string;
  /** What was kept changed: Settings draws again. */
  changed(): void;
  log(message: string): void;
  platform?: NodeJS.Platform;
}

/**
 * The disk a path is on when it can go away, its mount point: `/Volumes/<name>` on macOS, a drive's root on Windows.
 * Undefined for the startup disk, which is always there.
 */
export function removableRoot(file: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "win32") return path.win32.parse(file).root || undefined;
  const parts = path.resolve(file).split(path.sep);
  return parts[1] === "Volumes" && parts[2] ? path.join(path.sep, "Volumes", parts[2]) : undefined;
}

/**
 * Whether `file` is there, by the system's own answer: `absent` only when it says nothing is at that path, `unknown`
 * when the look failed otherwise (no permission, a disk error), which never counts as a deletion (Codex review).
 */
async function presence(file: string): Promise<"present" | "absent" | "unknown"> {
  try {
    await fs.promises.stat(file);
    return "present";
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
  }
}

export class Housekeeping {
  private readonly queue = new SerialQueue();
  private keptEdits: KeptEdit[] = [];

  constructor(private readonly deps: HousekeepingDeps) {}

  /** The edits kept for recordings not in the Recordings tab, as the last check found them. */
  get kept(): readonly KeptEdit[] {
    return this.keptEdits;
  }

  /** Checks what is kept against the output folder now; one check at a time. */
  run(): Promise<void> {
    return this.queue.run(async () => {
      const dir = this.deps.outputDir();
      await this.deps.sweepVersions(dir).catch((cause: unknown) => this.deps.log(`housekeeping: versions not checked: ${String(cause)}`));
      await this.sweepEdits(dir).catch((cause: unknown) => this.deps.log(`housekeeping: edits not checked: ${String(cause)}`));
    });
  }

  /** Settings' Remove: every kept edit goes. */
  removeKept(): Promise<void> {
    return this.queue.run(async () => {
      for (const kept of this.keptEdits) await this.discard(kept.source, "removed in Settings");
      this.keptEdits = [];
      this.deps.changed();
    });
  }

  /** The output folder changed and its old one's edits are not wanted (plan 100): those of recordings in `dir` go. */
  removeIn(dir: string): Promise<void> {
    return this.queue.run(async () => {
      for (const source of [...this.deps.store.records().keys()]) if (inOutputFolder(dir, source)) await this.discard(source, `the output folder ${dir} was left`);
      this.keptEdits = this.keptEdits.filter((kept) => !inOutputFolder(dir, kept.source));
      this.deps.changed();
    });
  }

  private async discard(source: string, why: string): Promise<void> {
    await this.deps.store.discard(source).then(
      () => this.deps.log(`housekeeping: removed the edit of ${source} (${why})`),
      (cause: unknown) => this.deps.log(`housekeeping: the edit of ${source} was not removed: ${String(cause)}`),
    );
  }

  private async sweepEdits(dir: string): Promise<void> {
    const kept: KeptEdit[] = [];
    let candidates: Promise<{ files: string[]; complete: boolean }> | undefined;
    for (const [source, identity] of [...this.deps.store.records()]) {
      const here = await presence(source);
      // Looked at and not answered: nothing is decided about it now.
      if (here === "unknown") continue;
      if (here === "present") {
        if (!inOutputFolder(dir, source)) kept.push({ source, reason: "elsewhere", bytes: await this.recordSize(source) });
        continue;
      }
      const root = removableRoot(source, this.deps.platform);
      const disk = root ? await presence(root) : "present";
      if (disk === "unknown") continue;
      if (disk === "absent") {
        kept.push({ source, reason: "disk", bytes: await this.recordSize(source) });
        continue;
      }
      // Gone from a disk that is there: renamed or moved in Finder if the output folder holds its bytes, else deleted.
      const search = await (candidates ??= this.recordings(dir));
      const { found, complete } = await this.findByBytes(identity, search.files);
      if (found) {
        const loaded = await this.deps.store.load(found, await sourceIdentity(found));
        if (loaded.kind === "ok") { this.deps.log(`housekeeping: the edit of ${source} followed it to ${found}`); continue; }
      }
      // A folder or a file that could not be read may be it: only a search that saw everything says it was deleted.
      if (!search.complete || !complete) continue;
      await this.discard(source, "its recording was deleted");
    }
    const changed = JSON.stringify(kept) !== JSON.stringify(this.keptEdits);
    this.keptEdits = kept;
    if (changed) this.deps.changed();
  }

  private recordSize(source: string): Promise<number> {
    return fs.promises.stat(this.deps.store.fileFor(source)).then((stat) => stat.size, () => 0);
  }

  /** The videos the Recordings tab would list: in the output folder and its folders, one level deep. */
  private async recordings(dir: string): Promise<{ files: string[]; complete: boolean }> {
    const out: string[] = [];
    let complete = true;
    const read = (folder: string) => fs.promises.readdir(folder, { withFileTypes: true }).catch(() => { complete = false; return []; });
    for (const entry of await read(dir)) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && /\.(mp4|m4v|mov)$/i.test(entry.name)) out.push(full);
      else if (entry.isDirectory()) for (const inner of await read(full)) if (inner.isFile() && !inner.name.startsWith(".") && /\.(mp4|m4v|mov)$/i.test(inner.name)) out.push(path.join(full, inner.name));
    }
    return { files: out, complete };
  }

  /** A file with exactly `identity`'s bytes: its size first, then its modification time and ends. */
  private async findByBytes(identity: SourceIdentity, files: string[]): Promise<{ found?: string; complete: boolean }> {
    let complete = true;
    for (const file of files) {
      const stat = await fs.promises.stat(file).catch((cause: NodeJS.ErrnoException) => {
        // Gone since the folder was read is no candidate; anything else could have been it (Codex review).
        if (cause.code !== "ENOENT") complete = false;
        return undefined;
      });
      if (!stat || stat.size !== identity.size || Math.round(stat.mtimeMs) !== identity.mtimeMs) continue;
      const now = await sourceIdentity(file).catch(() => { complete = false; return undefined; });
      if (now?.hash === identity.hash) return { found: file, complete };
    }
    return { complete };
  }
}
