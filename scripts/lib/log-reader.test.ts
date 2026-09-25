import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileLogger, rotateLog, rotatedPath } from "../../src/main/log.ts";
import { LogGapError, LogReader, evidenceSince, readRetainedLog } from "./log-reader.mts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-log-reader-"));
  file = path.join(dir, "recordstuff.log");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The production logger; rotation is left to explicit `rotateLog` calls unless `maxBytes` is given. */
const logger = (maxBytes = Number.MAX_SAFE_INTEGER) =>
  createFileLogger({ filePath: file, maxBytes, keep: 3, stdout: () => undefined, stderr: () => undefined, now: () => new Date("2026-09-25T10:00:00.000Z") });
const texts = (reader: LogReader, from: Parameters<LogReader["since"]>[0]) =>
  reader.since(from).lines.map((line) => line.text.replace(/^\[[^\]]*\] /, ""));

describe("rotation-aware log cursor", () => {
  it("finds lines in the new file after a 31-line file rotated (R2-07)", () => {
    const log = logger();
    for (let i = 0; i < 31; i += 1) log(`old ${i}`);
    const reader = new LogReader(file);
    const cursor = reader.end();
    log("after checkpoint, before rotation");
    rotateLog(file, 3);
    log("state → stopping");
    log("state → idle");
    log("saved /m/new.mp4");
    expect(texts(reader, cursor)).toEqual(["after checkpoint, before rotation", "state → stopping", "state → idle", "saved /m/new.mp4"]);
  });

  it("follows the cursor's file through several rotations and reads each line once", () => {
    const log = logger(120);
    log("before");
    const reader = new LogReader(file);
    let cursor = reader.end();
    const seen: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      log(`line ${i} ${"x".repeat(40)}`);
      if (i % 3 === 2) {
        const batch = reader.since(cursor);
        seen.push(...batch.lines.map((line) => line.text.replace(/^\[[^\]]*\] /, "").split(" ").slice(0, 2).join(" ")));
        cursor = batch.next;
      }
    }
    expect(fs.existsSync(rotatedPath(file, 3))).toBe(true);
    expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => `line ${i}`));
    expect(reader.since(cursor).lines).toEqual([]);
  });

  it("reports an evidence gap when retention deleted the cursor's file", () => {
    const log = logger();
    log("checkpointed");
    const reader = new LogReader(file);
    const cursor = reader.end();
    for (let i = 0; i < 4; i += 1) {
      rotateLog(file, 3);
      log(`generation ${i}`);
    }
    expect(() => reader.since(cursor)).toThrow(LogGapError);
    expect(() => reader.since(cursor)).toThrow(/no longer retained/);
    expect(evidenceSince(reader, cursor)).toEqual([expect.stringContaining("log evidence gap")]);
  });

  it("reports an evidence gap when the file was truncated below the cursor", () => {
    const log = logger();
    log("one");
    log("two");
    const reader = new LogReader(file);
    const cursor = reader.end();
    fs.truncateSync(file, 5);
    expect(() => reader.since(cursor)).toThrow(/truncated/);
  });

  it("reports a gap when the file was truncated and grew back past the cursor before the next read (review P1-1)", () => {
    const log = logger();
    for (let i = 0; i < 5; i += 1) log(`before ${i}`);
    const reader = new LogReader(file);
    const checkpoint = reader.end();
    log("after checkpoint");
    const consumed = reader.since(checkpoint).next;
    fs.truncateSync(file, 0);
    for (let i = 0; i < 12; i += 1) log(`regrown ${i} saved /m/new.mp4`);
    expect(fs.statSync(file).size).toBeGreaterThan(consumed.offset);
    expect(() => reader.since(checkpoint)).toThrow(/rewritten below the checkpoint/);
    expect(() => reader.since(consumed)).toThrow(LogGapError);
    // Appends alone never disturb the mark, from the end or from a line's own positions.
    const fresh = reader.end();
    log("appended");
    const [appended] = reader.since(fresh).lines;
    expect(appended?.text).toContain("appended");
    expect(reader.since(appended!.at).lines.map((line) => line.text)).toEqual([appended!.text]);
  });

  it("tolerates the moment between a rotation's rename and the next append", () => {
    const log = logger();
    log("old");
    const reader = new LogReader(file);
    const before = reader.end();
    log("pending");
    rotateLog(file, 3);
    expect(fs.existsSync(file)).toBe(false);
    expect(texts(reader, before)).toEqual(["pending"]);
    const end = reader.end();
    expect(reader.since(end).lines).toEqual([]);
    log("fresh");
    expect(texts(reader, end)).toEqual(["fresh"]);
  });

  it("holds back an unterminated active tail until it is complete, but reads one left in an archive", () => {
    const log = logger();
    log("complete");
    const reader = new LogReader(file);
    const start = { offset: 0 };
    fs.appendFileSync(file, "[t] half");
    expect(texts(reader, start)).toEqual(["complete"]);
    const cursor = reader.since(start).next;
    fs.appendFileSync(file, " written\n");
    expect(reader.since(cursor).lines.map((line) => line.text)).toEqual(["[t] half written"]);
    fs.appendFileSync(file, "[t] cut off by a crash");
    const crashed = reader.since(cursor).next;
    rotateLog(file, 3);
    expect(reader.since(crashed).lines.map((line) => line.text)).toEqual(["[t] cut off by a crash"]);
  });

  it("continues across an app restart appending to the same file", () => {
    logger()("first launch");
    const reader = new LogReader(file);
    const cursor = reader.end();
    logger()("start: RecordStuff 1.0.0; run r2; electron 44");
    logger()("second launch");
    expect(texts(reader, cursor)).toEqual(["start: RecordStuff 1.0.0; run r2; electron 44", "second launch"]);
  });

  it("treats everything as new when no log existed at the checkpoint", () => {
    const reader = new LogReader(file);
    const cursor = reader.end();
    expect(cursor).toEqual({ offset: 0 });
    expect(reader.all()).toEqual([]);
    const log = logger();
    log("a");
    rotateLog(file, 3);
    log("b");
    expect(texts(reader, cursor)).toEqual(["a", "b"]);
  });

  it("keeps every line in multi-byte text at the right byte position", () => {
    const log = logger();
    log("saved /Users/e/影片/片段 1.mp4");
    const reader = new LogReader(file);
    const first = reader.since({ offset: 0 }).lines[0]!;
    log("saved /Users/e/影片/片段 2.mp4");
    expect(reader.since(first.next).lines.map((line) => line.text)).toEqual(["[2026-09-25T10:00:00.000Z] saved /Users/e/影片/片段 2.mp4"]);
    expect(reader.since(first.at).lines).toHaveLength(2);
  });

  it("reads the whole retained history oldest first", () => {
    const log = logger();
    log("oldest");
    rotateLog(file, 3);
    log("middle");
    rotateLog(file, 3);
    log("newest");
    expect(new LogReader(file).all().map((line) => line.replace(/^\[[^\]]*\] /, ""))).toEqual(["oldest", "middle", "newest"]);
    expect(readRetainedLog(file)).toBe(["oldest", "middle", "newest"].map((m) => `[2026-09-25T10:00:00.000Z] ${m}`).join("\n"));
  });
});
