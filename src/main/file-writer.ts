/**
 * The only media-file writer in the app (docs/system-design/recording.md). Appends chunks in
 * arrival order, fsyncs every 5 seconds, and publishes without overwriting
 * `<stamp>.recording.mp4` → `<stamp>.mp4` once the last chunk is on disk.
 * Any failure keeps what was written; nothing is ever silently discarded.
 * Zero written bytes is never published: nonempty is necessary, not proof of a playable file.
 * Bytes accepted but not yet written are bounded; exceeding the bound fails the
 * recording instead of buffering slow or offline storage in memory.
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { ErrorCode } from "../shared/state";
import { RECORDING_HEALTH } from "./recording-health";

export interface WritableHandle {
  write(data: Uint8Array): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Subset of `node:fs/promises` used here; injectable so tests can fail writes. */
export interface FileWriterFs {
  open(filePath: string, flags: string): Promise<WritableHandle>;
  copyExclusive(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
  writeFile(filePath: string, data: string): Promise<void>;
}

export const nodeFs: FileWriterFs = {
  open: (filePath, flags) => fs.open(filePath, flags),
  // Clone where supported; otherwise copy. EXCL protects existing destinations.
  copyExclusive: async (from, to) => {
    await fs.copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const copy = await fs.open(to, "r+");
    try { await copy.sync(); } finally { await copy.close(); }
  },
  unlink: (filePath) => fs.unlink(filePath),
  mkdir: (dir, options) => fs.mkdir(dir, options),
  writeFile: (filePath, data) => fs.writeFile(filePath, data),
};

/** Why finish refused to publish; the only gate between zero bytes and a saved `.mp4`. */
export const NO_MEDIA_DETAIL = "capture ended without media; no bytes were written";

export class FileWriteError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly filePath: string,
    cause: unknown,
  ) {
    super(`${code}: ${filePath}: ${describe(cause)}`, { cause });
    this.name = "FileWriteError";
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function errnoCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : undefined;
}

export function classifyWriteError(cause: unknown): ErrorCode {
  return errnoCode(cause) === "ENOSPC" ? "disk_full" : "output_write_failed";
}

/**
 * docs/system-design/recording.md: before starting, `mkdir -p` the directory, then write and
 * delete a probe file. Fails loudly instead of falling back to another folder.
 */
export async function ensureWritableDir(dir: string, io: FileWriterFs = nodeFs): Promise<void> {
  const probe = path.join(dir, `.recordstuff-write-test-${process.pid}-${Date.now()}`);
  try {
    await io.mkdir(dir, { recursive: true });
    await io.writeFile(probe, "");
  } catch (cause) {
    throw new FileWriteError("output_open_failed", dir, cause);
  }
  try {
    await io.unlink(probe);
  } catch {
    // The probe was written, so the directory is usable; a leftover empty
    // dot-file is harmless.
  }
}

export interface FileWriterOptions {
  fsyncIntervalMs?: number;
  /** Accepted-but-unwritten bytes allowed before an append is refused. */
  backlogLimitBytes?: number;
  io?: FileWriterFs;
}

export class FileWriter {
  private queue: Promise<void> = Promise.resolve();
  private failure: FileWriteError | undefined;
  /** Set when an append was refused; accepted bytes are still written, nothing after it is. */
  private refused: FileWriteError | undefined;
  private fsyncTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private _bytesWritten = 0;
  private _backlogBytes = 0;
  private abandoned: Promise<string | undefined> | undefined;
  preservationUncertain = false;

  private constructor(
    readonly recordingPath: string,
    readonly finalPath: string,
    private readonly handle: WritableHandle,
    private readonly io: FileWriterFs,
    fsyncIntervalMs: number,
    private readonly backlogLimitBytes: number,
  ) {
    this.fsyncTimer = setInterval(() => {
      // enqueue retains the first failure; consume this background caller's rejection.
      void this.enqueue(() => this.handle.sync()).catch(() => undefined);
    }, fsyncIntervalMs);
  }

  /** Opens `recordingPath` exclusively; a name collision is a hard failure. */
  static async open(
    recordingPath: string,
    finalPath: string,
    options: FileWriterOptions = {},
  ): Promise<FileWriter> {
    const io = options.io ?? nodeFs;
    let handle: WritableHandle;
    try {
      handle = await io.open(recordingPath, "wx");
    } catch (cause) {
      throw new FileWriteError("output_open_failed", recordingPath, cause);
    }
    return new FileWriter(recordingPath, finalPath, handle, io, options.fsyncIntervalMs ?? 5000,
      options.backlogLimitBytes ?? RECORDING_HEALTH.writerBacklogBytes);
  }

  get bytesWritten(): number {
    return this._bytesWritten;
  }

  /** Bytes accepted by `append` and not yet confirmed written or discarded after a failure. */
  get backlogBytes(): number {
    return this._backlogBytes;
  }

  /**
   * Appends in call order. Rejects with `FileWriteError` on the first disk
   * error; all later appends reject with the same error without touching disk.
   * An append that would push the backlog past its bound is refused at once,
   * without queueing, and so is every later one: MediaRecorder cannot be
   * throttled, so the recording ends. Bytes accepted before the refusal are
   * still written, so the kept partial is a gapless prefix.
   */
  append(bytes: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error("FileWriter is closed"));
    if (this.refused) return Promise.reject(this.refused);
    if (this._backlogBytes + bytes.byteLength > this.backlogLimitBytes) {
      // An earlier disk error stays the reported one.
      this.refused = this.failure ?? new FileWriteError("output_write_failed", this.recordingPath,
        `writer backlog limit ${this.backlogLimitBytes} bytes exceeded: ${this._backlogBytes} bytes pending, ${bytes.byteLength} arriving`);
      return Promise.reject(this.refused);
    }
    let pending = bytes.byteLength;
    this._backlogBytes += pending;
    const run = this.enqueue(async () => {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const remaining = bytes.subarray(offset);
        const { bytesWritten } = await this.handle.write(remaining);
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining.byteLength) {
          throw new Error(`Invalid write progress: ${bytesWritten} of ${remaining.byteLength} bytes`);
        }
        offset += bytesWritten;
        this._bytesWritten += bytesWritten;
        this._backlogBytes -= bytesWritten;
        pending -= bytesWritten;
      }
    });
    // A failed or skipped append no longer holds its unwritten bytes.
    const release = (): void => { this._backlogBytes -= pending; pending = 0; };
    run.then(release, release);
    return run;
  }

  /**
   * Settles once every queued write and sync has run; resolves with the
   * retained write/sync error, if any. Lets a start failure report a disk error
   * the writer already holds instead of a generic cause.
   */
  async drain(): Promise<FileWriteError | undefined> {
    await this.queue;
    return this.failure ?? this.refused;
  }

  /**
   * Flush, close, publish exclusively, then remove the temporary file. Draining
   * first lets a retained write/sync error keep its code; with no confirmed
   * bytes it then closes, removes the empty file and rejects with
   * `capture_start_failed` instead of publishing an empty `.mp4`.
   */
  async finish(): Promise<string> {
    await this.enqueue(() => this.handle.sync());
    // A refused chunk means the recording is incomplete; the failure path keeps the partial.
    if (this.refused) throw this.refused;
    if (this._bytesWritten === 0) {
      await this.abandon();
      throw new FileWriteError("capture_start_failed", this.recordingPath, NO_MEDIA_DETAIL);
    }
    await this.release();
    const ext = path.extname(this.finalPath);
    const stem = this.finalPath.slice(0, this.finalPath.length - ext.length);
    for (let attempt = 1; ; attempt += 1) {
      const target = attempt === 1 ? this.finalPath : `${stem}-${attempt}${ext}`;
      try {
        await this.io.copyExclusive(this.recordingPath, target);
      } catch (cause) {
        if (errnoCode(cause) === "EEXIST") continue;
        throw new FileWriteError("output_write_failed", this.recordingPath, cause);
      }
      try {
        await this.io.unlink(this.recordingPath);
      } catch {
        // The completed file is safe; a leftover temporary copy must not turn
        // a successful save into a failure or remove the completed recording.
      }
      return target;
    }
  }

  /**
   * Close without renaming, keeping whatever was written under the
   * `.recording.mp4` name. An empty file is removed. Never throws.
   * Returns the kept partial path, or undefined if nothing was kept.
   * Idempotent: once the empty path is freed, a same-second retry may reuse
   * it, so a later call must not unlink again.
   */
  abandon(): Promise<string | undefined> {
    this.abandoned ??= this.abandonOnce();
    return this.abandoned;
  }

  private async abandonOnce(): Promise<string | undefined> {
    try {
      await this.queue;
    } catch {
      // The failure is already recorded; we still close and keep the file.
    }
    try {
      await this.release();
    } catch {
      this.preservationUncertain = true;
      // The path may exist, but closing could not be confirmed.
    }
    if (this._bytesWritten > 0) return this.recordingPath;
    try {
      await this.io.unlink(this.recordingPath);
    } catch {
      // Leaving a zero-byte file behind is not worth surfacing.
    }
    return undefined;
  }

  private async release(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.fsyncTimer) clearInterval(this.fsyncTimer);
    this.fsyncTimer = undefined;
    try {
      await this.handle.close();
    } catch (error) {
      this.preservationUncertain = true;
      throw error;
    }
  }

  private enqueue(task: () => Promise<unknown>): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      try {
        await task();
      } catch (cause) {
        this.failure =
          cause instanceof FileWriteError
            ? cause
            : new FileWriteError(classifyWriteError(cause), this.recordingPath, cause);
        throw this.failure;
      }
    });
    // Keep the chain alive even when a caller ignores the rejection.
    this.queue = run.catch(() => undefined);
    return run;
  }
}
