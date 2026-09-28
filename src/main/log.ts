/**
 * File log for the window-less app (docs/system-design/desktop.md). Every line goes to stdout
 * (visible under `pnpm dev`) and is appended to `<userData>/logs/recordstuff.log`
 * (the only trace under `pnpm start` or a packaged build). Rotation happens
 * before a write once the active file exceeds `maxBytes`: `recordstuff.log`
 * becomes `recordstuff.1.log`, `.1` becomes `.2`, and so on up to `keep`
 * archives. The size is read from disk once per process and counted from
 * then on; this process is the file's only writer. A failed file write is reported to stderr once; after that the
 * logger keeps writing to stdout only so logging can never take the app down.
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
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
 * the active file to `.1`. Missing links are skipped.
 */
export function rotateLog(filePath: string, keep: number): void {
  fs.rmSync(rotatedPath(filePath, keep), { force: true });
  for (let i = keep - 1; i >= 1; i -= 1) {
    const from = rotatedPath(filePath, i);
    if (fs.existsSync(from)) fs.renameSync(from, rotatedPath(filePath, i + 1));
  }
  if (keep >= 1 && fs.existsSync(filePath)) fs.renameSync(filePath, rotatedPath(filePath, 1));
}

export function formatLine(message: string, now: Date): string {
  return `[${now.toISOString()}] ${message}`;
}

export function createFileLogger(options: FileLoggerOptions): Log {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = options.keep ?? DEFAULT_KEEP;
  const stdout = options.stdout ?? ((line) => console.log(line));
  const stderr = options.stderr ?? ((line) => console.error(line));
  const now = options.now ?? (() => new Date());
  let fileEnabled = true;
  /** Bytes in the active file; read once at the first write, then counted, so each line costs one append and no stat. */
  let size: number | undefined;

  const sizeOf = (): number => {
    try {
      return fs.statSync(options.filePath).size;
    } catch {
      return 0;
    }
  };

  const appendToFile = (line: string): void => {
    if (size === undefined) {
      fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
      size = sizeOf();
    }
    if (size > maxBytes) {
      rotateLog(options.filePath, keep);
      size = 0;
    }
    const text = `${line}\n`;
    fs.appendFileSync(options.filePath, text, "utf8");
    size += Buffer.byteLength(text, "utf8");
  };

  return (message) => {
    const line = formatLine(message, now());
    stdout(line);
    if (!fileEnabled) return;
    try {
      appendToFile(line);
    } catch (cause) {
      fileEnabled = false;
      stderr(`log: cannot write ${options.filePath}: ${String(cause)}; file logging disabled`);
    }
  };
}
