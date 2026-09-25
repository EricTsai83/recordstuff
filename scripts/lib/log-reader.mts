/**
 * Rotation-aware reading of the app log for development runners (plan 029).
 * src/main/log.ts rotates `recordstuff.log` → `.1` → … → `.keep` before an
 * append once the file passes its size limit, so a line count taken from the
 * active file is no position at all after a rotation. A cursor instead names
 * a file by identity (device, inode, birth time) plus a byte offset: reading
 * since it follows that file into whichever archive now holds it, then reads
 * every newer file. A position that retention deleted or a truncation erased
 * is an explicit evidence gap, never "nothing new yet"; the bytes just before
 * the offset are kept too, so a file truncated and regrown past the offset
 * between two reads is caught as well. The production rotation policy stays
 * unchanged; this only reads it.
 */
import fs from "node:fs";
import { DEFAULT_KEEP, rotatedPath } from "../../src/main/log.ts";

export interface FileIdentity {
  dev: number;
  ino: number;
  /** 0 where the file system reports none; guards against inode reuse after retention deletes a file. */
  birthtimeMs: number;
}

export interface LogCursor {
  /** Absent: no log existed at the checkpoint, so everything retained is new. */
  file?: FileIdentity;
  /** Bytes of `file` already consumed; always at a line boundary. */
  offset: number;
  /**
   * Base64 of up to `MARK_BYTES` bytes before `offset`. The app only appends,
   * so these never change unless the file was rewritten below the cursor.
   */
  mark?: string;
}

const MARK_BYTES = 64;

export interface LogLine {
  text: string;
  /** Where the line starts, and just past it; waits resume from either. */
  at: LogCursor;
  next: LogCursor;
}

/** The history since a cursor is gone; waiting longer cannot recover it. */
export class LogGapError extends Error {}

interface Segment {
  path: string;
  id: FileIdentity;
  size: number;
  /** The file the app appends to; only its unterminated tail may still be growing. */
  active: boolean;
}

const sameFile = (a: FileIdentity, b: FileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;

function identity(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function statOrUndefined(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

export class LogReader {
  readonly filePath: string;
  /** Archives the producer keeps (src/main/log.ts); older ones no longer exist. */
  readonly keep: number;

  constructor(filePath: string, keep = DEFAULT_KEEP) {
    this.filePath = filePath;
    this.keep = keep;
  }

  /** Retained files oldest first: `.keep` … `.1`, then the active file. */
  private scan(): Segment[] {
    const segments: Segment[] = [];
    for (let index = this.keep; index >= 0; index -= 1) {
      const filePath = index === 0 ? this.filePath : rotatedPath(this.filePath, index);
      const stat = statOrUndefined(filePath);
      if (stat) segments.push({ path: filePath, id: identity(stat), size: stat.size, active: index === 0 });
    }
    return segments;
  }

  /**
   * Two identical scans in a row: a rotation renames several files one at a
   * time, so a single scan taken mid-rotation can miss a file that moved
   * from a name not yet visited to one already visited.
   */
  private segments(): Segment[] {
    let previous = this.scan();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = this.scan();
      const stable = current.length === previous.length
        && current.every((segment, i) => segment.path === previous[i]?.path && sameFile(segment.id, previous[i]!.id));
      if (stable) return current;
      previous = current;
    }
    return previous;
  }

  /** Reads `[from, end)` of one segment by descriptor, confirming it is still the same file. */
  private read(segment: Segment, from: number): Buffer | undefined {
    let fd: number;
    try {
      fd = fs.openSync(segment.path, "r");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!sameFile(identity(stat), segment.id)) return undefined;
      const buffer = Buffer.alloc(Math.max(0, stat.size - from));
      let read = 0;
      while (read < buffer.length) {
        const n = fs.readSync(fd, buffer, read, buffer.length - read, from + read);
        if (n === 0) break;
        read += n;
      }
      return buffer.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Just past the last complete line written so far; a newly created log starts at its beginning. */
  end(): LogCursor {
    for (let attempt = 0; ; attempt += 1) {
      const segments = this.segments();
      // Between a rotation's rename and the next append no active file exists; the newest archive is the end.
      const newest = segments[segments.length - 1];
      if (!newest) return { offset: 0 };
      const bytes = this.read(newest, 0);
      if (bytes) {
        const offset = newest.active ? bytes.lastIndexOf(0x0a) + 1 : bytes.length;
        return cursorAt(newest.id, offset, bytes, offset);
      }
      if (attempt >= 5) throw new Error(`log ${this.filePath} kept changing while it was read`);
    }
  }

  /**
   * Complete lines written after `cursor`, oldest first, each exactly once:
   * the rest of the cursor's file, then every newer file. An unterminated
   * tail of the active file is left for a later read; one in an archive is a
   * line (its writer moved on). Throws `LogGapError` when the cursor's file
   * is no longer retained, or was truncated below the cursor (also when it
   * grew back past it before this read).
   */
  since(cursor: LogCursor): { lines: LogLine[]; next: LogCursor } {
    for (let attempt = 0; ; attempt += 1) {
      // Undefined: a file was renamed between the scan and the read, so rescan.
      const result = this.trySince(cursor);
      if (result) return result;
      if (attempt >= 5) throw new Error(`log ${this.filePath} kept changing while it was read`);
    }
  }

  private trySince(cursor: LogCursor): { lines: LogLine[]; next: LogCursor } | undefined {
    const segments = this.segments();
    let first = 0;
    if (cursor.file) {
      first = segments.findIndex((segment) => sameFile(segment.id, cursor.file!));
      if (first < 0) {
        throw new LogGapError(
          `log history since the checkpoint is no longer retained: ${this.filePath} and its ${this.keep} archive(s) no longer contain the file being read (rotated past retention or replaced)`,
        );
      }
      if (segments[first]!.size < cursor.offset) {
        throw new LogGapError(`log ${segments[first]!.path} was truncated below the checkpoint (${segments[first]!.size} < ${cursor.offset} bytes)`);
      }
    }
    const lines: LogLine[] = [];
    let next: LogCursor = cursor;
    for (let i = first; i < segments.length; i += 1) {
      const segment = segments[i]!;
      const start = i === first && cursor.file ? cursor.offset : 0;
      // Read the marked bytes before the cursor with the rest, from the same descriptor.
      const back = Math.min(start, MARK_BYTES);
      const whole = this.read(segment, start - back);
      if (!whole) return undefined;
      if (i === first && cursor.mark !== undefined) {
        const expected = Buffer.from(cursor.mark, "base64");
        if (!whole.subarray(back - expected.length, back).equals(expected)) {
          throw new LogGapError(`log ${segment.path} was rewritten below the checkpoint (truncated and regrown past ${cursor.offset} bytes)`);
        }
      }
      // Positions below are relative to `whole`, which begins `back` bytes before `start`.
      let lineStart = back;
      for (let newline = whole.indexOf(0x0a, back); newline >= 0; newline = whole.indexOf(0x0a, lineStart)) {
        lines.push(this.line(segment, whole, start - back, lineStart, newline, newline + 1));
        lineStart = newline + 1;
      }
      if (lineStart < whole.length && !segment.active) {
        lines.push(this.line(segment, whole, start - back, lineStart, whole.length, whole.length));
        lineStart = whole.length;
      }
      next = cursorAt(segment.id, start - back + lineStart, whole, lineStart);
    }
    return { lines, next };
  }

  private line(segment: Segment, whole: Buffer, base: number, from: number, to: number, after: number): LogLine {
    const text = whole.subarray(from, to).toString("utf8").replace(/\r$/, "");
    return { text, at: cursorAt(segment.id, base + from, whole, from), next: cursorAt(segment.id, base + after, whole, after) };
  }

  /** Every retained complete line, archives first: the current process's start may sit in an archive. */
  all(): string[] {
    return this.since({ offset: 0 }).lines.map((line) => line.text);
  }
}

/** A cursor at `offset` of `file`, marked with the bytes of `bytes` that precede index `end` (its position there). */
function cursorAt(file: FileIdentity, offset: number, bytes: Buffer, end: number): LogCursor {
  return { file, offset, mark: bytes.subarray(Math.max(0, end - MARK_BYTES), end).toString("base64") };
}

/** Retained history as one text for parsers, oldest first; empty when no log exists. */
export function readRetainedLog(filePath: string, keep = DEFAULT_KEEP): string {
  return new LogReader(filePath, keep).all().join("\n");
}

/** Evidence lines after a cursor for a report; a lost history becomes a marked line, not an exception. */
export function evidenceSince(log: LogReader, cursor: LogCursor): string[] {
  try {
    return log.since(cursor).lines.map((line) => line.text);
  } catch (cause) {
    if (cause instanceof LogGapError) return [`(log evidence gap: ${cause.message})`];
    throw cause;
  }
}
