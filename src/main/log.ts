/**
 * File log for the window-less app (docs/system-design/desktop.md). Every line goes to stdout
 * (visible under `pnpm dev`) and is appended to the file the caller names, `recordstuff.log`
 * under Electron's logs folder (the only trace under `pnpm start` or a packaged build). Rotation happens
 * before a write once the active file exceeds `maxBytes`: `recordstuff.log`
 * becomes `recordstuff.1.log`, `.1` becomes `.2`, and so on up to `keep`
 * archives. The size is read from disk once per process and counted from
 * then on; this process is the file's only writer. A failed file write is reported to stderr once; after that the
 * logger keeps writing to stdout only so logging can never take the app down.
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
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
 * the active file to `.1`. Missing links are skipped; with `keep` 0 the active
 * file is removed. The logger's own rotation, exported for the log readers' tests.
 */
export async function rotateLog(filePath: string, keep: number): Promise<void> {
  if (keep === 0) { await fs.promises.rm(filePath, { force: true }); return; }
  await fs.promises.rm(rotatedPath(filePath, keep), { force: true });
  for (let index = keep - 1; index >= 0; index--) {
    try { await fs.promises.rename(index ? rotatedPath(filePath, index) : filePath, rotatedPath(filePath, index + 1)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function formatLine(message: string, now: Date): string {
  return `[${now.toISOString()}] ${message}`;
}

export type FileLog = Log & { flush(): Promise<void> };

/**
 * Wait up to `timeoutMs` for queued lines to reach the file, for exits that
 * would otherwise drop them (a failed start, a second instance). False on timeout.
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
  let queuedBytes = 0;
  let overflowReported = false;
  let queue = Promise.resolve();
  const log: FileLog = Object.assign((message: string): void => {
    const line = formatLine(message, now());
    stdout(line);
    if (!fileEnabled) return;
    const text = `${line}\n`;
    const bytes = Buffer.byteLength(text);
    if (queuedBytes + bytes > 1024 * 1024) {
      if (!overflowReported) stderr("log: file queue exceeded 1 MiB; dropping file lines until it drains (stdout retained)");
      overflowReported = true;
      return;
    }
    queuedBytes += bytes;
    queue = queue.then(async () => {
      if (!fileEnabled) return;
      if (size === undefined) {
        await fs.promises.mkdir(path.dirname(options.filePath), { recursive: true });
        try { size = (await fs.promises.stat(options.filePath)).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; size = 0; }
      }
      if (size > maxBytes) { await rotateLog(options.filePath, keep); size = 0; }
      await fs.promises.appendFile(options.filePath, text, "utf8");
      size += bytes;
    }).catch(cause => {
      fileEnabled = false;
      stderr(`log: cannot write ${options.filePath}: ${String(cause)}; file logging disabled`);
    }).finally(() => { queuedBytes -= bytes; if (!queuedBytes) overflowReported = false; });
  }, { async flush(): Promise<void> {
    let pending: Promise<void>;
    do { pending = queue; await pending; } while (pending !== queue);
  } });
  return log;
}
