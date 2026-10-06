/**
 * File log for the window-less app (docs/system-design/desktop.md). Every line goes to stdout
 * (visible under `pnpm dev`) and is appended to the file the caller names, `recordstuff.log`
 * under Electron's logs folder (the only trace under `pnpm start` or a packaged build). Rotation happens
 * before a write once the active file exceeds `maxBytes`: `recordstuff.log`
 * becomes `recordstuff.1.log`, `.1` becomes `.2`, and so on up to `keep`
 * archives. The size is read from disk once per process and counted from
 * then on; the running app is the file's only rotating writer (a second
 * instance that loses the single-instance lock appends its one line unbounded). A full disk or a removed logs folder only
 * skips lines: the next line looks again and, once written, says how many the file missed. A rotation
 * another process blocks keeps appending to the active file and retries later. Any
 * other failed write is reported to stderr once; after that the logger keeps writing to stdout
 * only so logging can never take the app down.
 */
import fs from "node:fs";
import path from "node:path";
// Development scripts load this file directly under Node, which resolves no extensionless
// local import: it imports only built-ins, so it keeps its own queue drain and errno checks.

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Write failures the file can recover from: space freed later, a folder created again, a file another process holds
 * open without sharing it for writing (EBUSY on Windows, as a rotation it blocks is retried too).
 */
const TRANSIENT_WRITE_ERRORS = new Set(["ENOSPC", "ENOENT", "EBUSY"]);
/** Lines waiting for the file beyond this are dropped from it; stdout still gets every line. */
const MAX_QUEUED_BYTES = 1024 * 1024;
/** After a failed rotation the file keeps growing; rotation is tried again once it has grown this much more. */
const ROTATION_RETRY_BYTES = 512 * 1024;
export const DEFAULT_KEEP = 3;

export interface FileLoggerOptions {
  filePath: string;
  /** Rotate when the active file is larger than this before a write. */
  maxBytes?: number;
  /** How many rotated files (`.1` … `.N`) to keep. */
  keep?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  now?: () => Date;
}

export type Log = (message: string) => void;

/** `recordstuff.log` → `recordstuff.3.log` for index 3. */
export function rotatedPath(filePath: string, index: number): string {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  return `${base}.${index}${ext}`;
}

/**
 * Shift the archive chain by one: drop `.keep`, move `.N` to `.N+1`, then move
 * the active file to `.1`. The shift stops at the first free slot, so nothing
 * past a gap moves or is dropped: a rotation whose last rename failed (another
 * process holds the active file) loses no further archive when it is tried
 * again (review batch 4). With `keep` 0 the active file is removed. The
 * logger's own rotation, exported for the log readers' tests.
 */
export async function rotateLog(filePath: string, keep: number): Promise<void> {
  if (keep === 0) { await fs.promises.rm(filePath, { force: true }); return; }
  let free = keep;
  for (let index = 1; index < keep; index++) {
    if (!await fs.promises.access(rotatedPath(filePath, index)).then(() => true, () => false)) { free = index; break; }
  }
  if (free === keep) await fs.promises.rm(rotatedPath(filePath, keep), { force: true });
  for (let index = free - 1; index >= 0; index--) {
    try { await fs.promises.rename(index ? rotatedPath(filePath, index) : filePath, rotatedPath(filePath, index + 1)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function formatLine(message: string, now: Date): string {
  return `[${now.toISOString()}] ${message}`;
}

export type FileLog = Log & { flush(): Promise<void> };

/**
 * Wait up to `timeoutMs` for queued writes to reach disk, for exits that would
 * otherwise drop them: a failed start, a second instance, and a quit's log,
 * settings and window-size writes. False on timeout; a failed flush rejects.
 */
export async function flushBeforeExit(log: Pick<FileLog, "flush">, timeoutMs = 2000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      log.flush().then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** A bounded queue keeps storage latency outside the recording event loop. */
export function createFileLogger(options: FileLoggerOptions): FileLog {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = options.keep ?? DEFAULT_KEEP;
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date());
  let fileEnabled = true;
  let size: number | undefined;
  /** The size above which the next write rotates first; past `maxBytes` only after a rotation failed. */
  let rotateAbove = maxBytes;
  let queuedBytes = 0;
  let overflowReported = false;
  /** Lines the full queue refused; the next accepted line says how many, so the file shows the gap. */
  let dropped = 0;
  /** Lines a transient write failure kept from the file; the next written line says how many. */
  let unwritten = 0;
  let queue = Promise.resolve();
  const log: FileLog = Object.assign((message: string): void => {
    const time = now();
    const line = formatLine(message, time);
    stdout(line);
    if (!fileEnabled) return;
    const gap = dropped ? `${formatLine(`log: dropped ${dropped} line(s) from this file while its write queue was full (stdout has them)`, time)}\n` : "";
    const text = `${gap}${line}\n`;
    const bytes = Buffer.byteLength(text);
    if (queuedBytes + bytes > MAX_QUEUED_BYTES) {
      if (!overflowReported) stderr("log: file queue exceeded 1 MiB; dropping file lines until it drains (stdout retained)");
      overflowReported = true;
      dropped += 1;
      return;
    }
    // The gap line travels with this one: if its write fails, both are counted as unwritten.
    const carried = dropped;
    dropped = 0;
    queuedBytes += bytes;
    queue = queue.then(async () => {
      if (!fileEnabled) return;
      if (size === undefined) {
        await fs.promises.mkdir(path.dirname(options.filePath), { recursive: true });
        try { size = (await fs.promises.stat(options.filePath)).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; size = 0; }
      }
      // A rotation another process blocks (Windows refuses to rename a file a viewer or a scanner holds open) is
      // no reason to stop writing: the active file grows meanwhile, says why once, and rotation is tried again later.
      let blocked = "";
      if (size > rotateAbove) {
        try { await rotateLog(options.filePath, keep); size = 0; rotateAbove = maxBytes; }
        catch (cause) {
          rotateAbove = size + ROTATION_RETRY_BYTES;
          blocked = `${formatLine(`log: could not rotate ${options.filePath} (${String(cause)}); appending to it and retrying after ${ROTATION_RETRY_BYTES} more bytes`, time)}\n`;
        }
      }
      const missed = unwritten ? `${formatLine(`log: ${unwritten} line(s) could not be written to this file (stdout has them)`, time)}\n` : "";
      await fs.promises.appendFile(options.filePath, `${blocked}${missed}${text}`, "utf8");
      size += bytes + Buffer.byteLength(missed) + Buffer.byteLength(blocked);
      unwritten = 0;
    }).catch(cause => {
      if (TRANSIENT_WRITE_ERRORS.has((cause as NodeJS.ErrnoException).code ?? "")) {
        // Measure the file and create its folder again before the next line.
        size = undefined;
        if (!unwritten) stderr(`log: cannot write ${options.filePath}: ${String(cause)}; skipping file lines until a write succeeds`);
        unwritten += 1 + carried;
        return;
      }
      fileEnabled = false;
      stderr(`log: cannot write ${options.filePath}: ${String(cause)}; file logging disabled`);
    }).finally(() => { queuedBytes -= bytes; if (!queuedBytes) overflowReported = false; });
  }, { async flush(): Promise<void> {
    let pending: Promise<void>;
    do { pending = queue; await pending; } while (pending !== queue);
  } });
  return log;
}
