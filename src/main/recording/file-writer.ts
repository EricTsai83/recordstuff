/**
 * A recording file's lifecycle in main (docs/system-design/recording.md); the native engine writes and finishes the
 * file itself (plan 076, engine-file-writer.ts). Publishing never overwrites: `<stamp>.recording.mp4` → `<stamp>.mp4`
 * is a hard link where the volume supports one, otherwise a full copy. Any failure keeps what was written; zero bytes
 * are never published. Write failures are classified here, and the output folder is checked before a recording.
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { ErrorCode } from "../../shared/state";
import { errnoCode, messageOf } from "../lib/errors";

/** A file opened only to reserve its name: the engine writes it (engine-file-writer.ts). */
export interface ReservedHandle {
  close(): Promise<void>;
}

/** Subset of `node:fs/promises` used here; injectable so tests can fail writes. */
export interface FileWriterFs {
  open(filePath: string, flags: string): Promise<ReservedHandle>;
  /** A second name for the same file; rejects with EEXIST instead of replacing `to`. */
  link(from: string, to: string): Promise<void>;
  copyExclusive(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
  writeFile(filePath: string, data: string): Promise<void>;
}

export const nodeFs: FileWriterFs = {
  open: async (filePath, flags) => {
    const handle = await fs.open(filePath, flags);
    return { close: () => handle.close() };
  },
  link: (from, to) => fs.link(from, to),
  // On macOS libuv never clones (FICLONE_FORCE is ENOSYS), so this is a full
  // copy and needs the file's size in free space. EXCL protects existing destinations.
  copyExclusive: async (from, to) => {
    const [source, volume] = await Promise.all([fs.stat(from), fs.statfs(path.dirname(to))]);
    if (volume.bavail * volume.bsize < source.size + 8 * 1024 * 1024)
      throw Object.assign(new Error("Not enough space to publish a full copy; the original recording is retained"), { code: "ENOSPC" });
    await fs.copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    try {
      const copy = await fs.open(to, "r+");
      try { await copy.sync(); } finally { await copy.close(); }
    } catch (cause) {
      await fs.unlink(to).catch(() => undefined);
      throw cause;
    }
  },
  unlink: (filePath) => fs.unlink(filePath),
  mkdir: (dir, options) => fs.mkdir(dir, options),
  writeFile: (filePath, data) => fs.writeFile(filePath, data),
};

/** How long each step of a successful `finish` took, in milliseconds; diagnostics only. */
export interface FinishTimings {
  /** Kept for the `finalize timing` line's shape; the engine syncs its own file, so 0. */
  flushMs: number;
  /** The engine's making the file plain MP4, or deciding not to. */
  finalizeMs: number;
  /** Why the file was published fragmented, as it was written; absent when it became a plain MP4. */
  fragmented?: string;
  closeMs: number;
  /** Creating the `.mp4`: a hard link, or a full copy and its fsync. */
  publishMs: number;
  /** Removing the temporary name. */
  cleanupMs: number;
  method: "link" | "copy";
  /** Why a copy was needed: the link's error code, such as ENOTSUP on exFAT. */
  linkError?: string;
  /** Why the temporary name was kept beside the saved file; after a copy it is a full duplicate. */
  cleanupError?: string;
}

/** Why finish refused to publish; the only gate between zero bytes and a saved `.mp4`. */
export const NO_MEDIA_DETAIL = "capture ended without media; no bytes were written";
/**
 * Names tried for the saved file: `name.mp4`, then `name-2.mp4` and on. Same-second names collide a few times at
 * most; a volume that answers EEXIST for every name ends the save as a failure that keeps the recording, not a loop.
 */
export const MAX_PUBLISH_ATTEMPTS = 100;

export class FileWriteError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly filePath: string,
    cause: unknown,
  ) {
    super(`${code}: ${filePath}: ${messageOf(cause)}`, { cause });
    this.name = "FileWriteError";
  }
}

export function classifyWriteError(cause: unknown): ErrorCode {
  return errnoCode(cause) === "ENOSPC" ? "disk_full" : "output_write_failed";
}

/** Before any media: a full disk is still `disk_full`, not an unusable folder. */
export function classifyOpenError(cause: unknown): ErrorCode {
  return errnoCode(cause) === "ENOSPC" ? "disk_full" : "output_open_failed";
}

/**
 * Create default folders when requested, then write and remove a probe.
 * Custom folders must exist; never recreate an offline mount path.
 */
export async function ensureWritableDir(dir: string, io: FileWriterFs = nodeFs, create = true): Promise<void> {
  const probe = path.join(dir, `.recordstuff-write-test-${process.pid}-${Date.now()}`);
  try {
    if (create) await io.mkdir(dir, { recursive: true });
    await io.writeFile(probe, "");
  } catch (cause) {
    throw new FileWriteError(classifyOpenError(cause), dir, cause);
  }
  try {
    await io.unlink(probe);
  } catch {
    // The probe was written, so the directory is usable; a leftover empty
    // dot-file is harmless.
  }
}

/** How publication went: the steps `FinishTimings` reports after the file was closed. */
export type PublishTimings = Pick<FinishTimings, "publishMs" | "cleanupMs" | "method" | "linkError" | "cleanupError">;

/**
 * Publishes the closed `recordingPath` under `finalPath`, or `name-2.mp4` and on when taken, then removes the
 * temporary name. A hard link where the volume supports one: constant time, no extra space, and like the copy it
 * never replaces an existing name. Any refusal other than EEXIST (exFAT and some network volumes have no hard links)
 * falls back to the exclusive copy for this and every later candidate name. The native engine's EngineFileWriter
 * publishes every recording through it.
 */
export async function publishRecording(io: FileWriterFs, recordingPath: string, finalPath: string): Promise<{ target: string; timings: PublishTimings }> {
  const began = performance.now();
  const ext = path.extname(finalPath);
  const stem = finalPath.slice(0, finalPath.length - ext.length);
  let linkError: string | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const target = attempt === 1 ? finalPath : `${stem}-${attempt}${ext}`;
    try {
      if (linkError === undefined) {
        try {
          await io.link(recordingPath, target);
        } catch (cause) {
          if (errnoCode(cause) === "EEXIST") throw cause;
          linkError = errnoCode(cause) ?? messageOf(cause);
        }
      }
      if (linkError !== undefined) await io.copyExclusive(recordingPath, target);
    } catch (cause) {
      if (errnoCode(cause) === "EEXIST") {
        if (attempt < MAX_PUBLISH_ATTEMPTS) continue;
        throw new FileWriteError("output_write_failed", recordingPath, new Error(`every name up to ${path.basename(target)} was taken`, { cause }));
      }
      // A copy without room for the whole file is disk_full, like any other ENOSPC.
      throw new FileWriteError(classifyWriteError(cause), recordingPath, cause);
    }
    const published = performance.now();
    let cleanupError: string | undefined;
    try {
      await io.unlink(recordingPath);
    } catch (cause) {
      // The completed file is safe; a leftover temporary name (a second link
      // to it, or a full copy) must not turn a successful save into a failure.
      cleanupError = errnoCode(cause) ?? messageOf(cause);
    }
    return { target, timings: { publishMs: published - began, cleanupMs: performance.now() - published,
      ...(linkError === undefined ? { method: "link" } : { method: "copy", linkError }),
      ...(cleanupError === undefined ? {} : { cleanupError }) } };
  }
}
