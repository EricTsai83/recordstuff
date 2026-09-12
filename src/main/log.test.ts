import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileLogger, rotateLog, rotatedPath } from "./log";

let dir: string;
let filePath: string;
const out: string[] = [];
const err: string[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-log-"));
  filePath = path.join(dir, "logs", "recordstuff.log");
  out.length = 0;
  err.length = 0;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const logger = (overrides: { maxBytes?: number; keep?: number; filePath?: string } = {}) =>
  createFileLogger({
    filePath,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    now: () => new Date("2026-09-12T10:00:00.000Z"),
    ...overrides,
  });

const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

describe("rotatedPath", () => {
  it("inserts the index before the extension", () => {
    expect(rotatedPath("/x/logs/recordstuff.log", 2)).toBe("/x/logs/recordstuff.2.log");
    expect(rotatedPath("/x/logs/noext", 1)).toBe("/x/logs/noext.1");
  });
});

describe("createFileLogger", () => {
  it("writes the same line to stdout and the file, creating the logs directory", async () => {
    const log = logger();
    log("hello");
    log("world");
    expect(out).toEqual(["[2026-09-12T10:00:00.000Z] hello", "[2026-09-12T10:00:00.000Z] world"]);
    expect(await fs.readFile(filePath, "utf8")).toBe(
      "[2026-09-12T10:00:00.000Z] hello\n[2026-09-12T10:00:00.000Z] world\n",
    );
    expect(err).toEqual([]);
  });

  it("appends to an existing file across logger instances", async () => {
    logger()("first run");
    logger()("second run");
    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first run");
    expect(lines[1]).toContain("second run");
  });

  it("rotates before a write once the file exceeds maxBytes and keeps the newest N archives", async () => {
    // Each line is ~35 bytes; maxBytes 40 means: line 1 fits, line 2 sees 36 B (no rotate),
    // line 3 sees 72 B > 40 → rotate, and so on. Every rotation moves exactly two lines.
    const log = logger({ maxBytes: 40, keep: 2 });
    for (let i = 1; i <= 8; i += 1) log(`line ${i}`);

    const read = async (p: string) => (await fs.readFile(p, "utf8")).match(/line \d/g);
    // 8 lines, 2 per file: active has 7-8, .1 has 5-6, .2 has 3-4; 1-2 were dropped.
    expect(await read(filePath)).toEqual(["line 7", "line 8"]);
    expect(await read(rotatedPath(filePath, 1))).toEqual(["line 5", "line 6"]);
    expect(await read(rotatedPath(filePath, 2))).toEqual(["line 3", "line 4"]);
    expect(await exists(rotatedPath(filePath, 3))).toBe(false);
    expect(err).toEqual([]);
  });

  it("does not rotate while the file is at or under maxBytes", async () => {
    const log = logger({ maxBytes: 10_000 });
    for (let i = 0; i < 50; i += 1) log("x");
    expect(await exists(rotatedPath(filePath, 1))).toBe(false);
    expect((await fs.readFile(filePath, "utf8")).split("\n")).toHaveLength(51);
  });

  it("never throws when the file cannot be written; reports once on stderr and keeps stdout", async () => {
    // The parent "logs" is a regular file, so mkdir/append must fail.
    await fs.writeFile(path.join(dir, "logs"), "");
    const log = logger();
    expect(() => log("a")).not.toThrow();
    expect(() => log("b")).not.toThrow();
    expect(out).toHaveLength(2);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("file logging disabled");
    expect(err[0]).toContain(filePath);
  });

  it("stops touching the file after a mid-run write failure", async () => {
    const log = logger();
    log("before");
    // Replace the log file with a directory: append now fails with EISDIR.
    await fs.rm(filePath);
    await fs.mkdir(filePath);
    log("during");
    log("after");
    expect(err).toHaveLength(1);
    expect(out).toHaveLength(3);
    expect((await fs.readdir(filePath)).length).toBe(0);
  });
});

describe("rotateLog", () => {
  it("shifts the whole chain and drops the oldest archive", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "active");
    await fs.writeFile(rotatedPath(filePath, 1), "one");
    await fs.writeFile(rotatedPath(filePath, 2), "two");
    await fs.writeFile(rotatedPath(filePath, 3), "three");
    rotateLog(filePath, 3);
    expect(await exists(filePath)).toBe(false);
    expect(await fs.readFile(rotatedPath(filePath, 1), "utf8")).toBe("active");
    expect(await fs.readFile(rotatedPath(filePath, 2), "utf8")).toBe("one");
    expect(await fs.readFile(rotatedPath(filePath, 3), "utf8")).toBe("two");
    expect(await exists(rotatedPath(filePath, 4))).toBe(false);
  });

  it("skips missing links in the chain", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "active");
    await fs.writeFile(rotatedPath(filePath, 2), "two");
    rotateLog(filePath, 3);
    expect(await fs.readFile(rotatedPath(filePath, 1), "utf8")).toBe("active");
    expect(await exists(rotatedPath(filePath, 2))).toBe(false);
    expect(await fs.readFile(rotatedPath(filePath, 3), "utf8")).toBe("two");
  });

  it("is a no-op on an empty directory", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    expect(() => rotateLog(filePath, 3)).not.toThrow();
    expect(await fs.readdir(path.dirname(filePath))).toEqual([]);
  });
});
