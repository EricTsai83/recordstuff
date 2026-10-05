import fs from "node:fs/promises";
import { promises as logFs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileLogger, flushBeforeExit, rotateLog, rotatedPath } from "./log";

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
    await log.flush();
    expect(out).toEqual(["[2026-09-12T10:00:00.000Z] hello", "[2026-09-12T10:00:00.000Z] world"]);
    expect(await fs.readFile(filePath, "utf8")).toBe(
      "[2026-09-12T10:00:00.000Z] hello\n[2026-09-12T10:00:00.000Z] world\n",
    );
    expect(err).toEqual([]);
  });

  it("appends to an existing file across logger instances", async () => {
    const first = logger(); first("first run"); await first.flush();
    const second = logger(); second("second run"); await second.flush();
    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first run");
    expect(lines[1]).toContain("second run");
  });

  it("never rotates without a size bound, as the losing second instance appends to the running one's file", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "x".repeat(200));
    const log = logger({ maxBytes: Number.POSITIVE_INFINITY });
    log("second instance");
    await log.flush();
    expect(await exists(rotatedPath(filePath, 1))).toBe(false);
    expect(await fs.readFile(filePath, "utf8")).toMatch(/^x{200}\[.*second instance\n$/);
  });

  it("rotates before a write once the file exceeds maxBytes and keeps the newest N archives", async () => {
    // Each line is ~35 bytes; maxBytes 40 means: line 1 fits, line 2 sees 36 B (no rotate),
    // line 3 sees 72 B > 40 → rotate, and so on. Every rotation moves exactly two lines.
    const log = logger({ maxBytes: 40, keep: 2 });
    for (let i = 1; i <= 8; i += 1) log(`line ${i}`);

    await log.flush();
    const read = async (p: string) => (await fs.readFile(p, "utf8")).match(/line \d/g);
    // 8 lines, 2 per file: active has 7-8, .1 has 5-6, .2 has 3-4; 1-2 were dropped.
    expect(await read(filePath)).toEqual(["line 7", "line 8"]);
    expect(await read(rotatedPath(filePath, 1))).toEqual(["line 5", "line 6"]);
    expect(await read(rotatedPath(filePath, 2))).toEqual(["line 3", "line 4"]);
    expect(await exists(rotatedPath(filePath, 3))).toBe(false);
    expect(err).toEqual([]);
  });

  it("keeps writing to the active file when another process blocks its rotation, says so there, and does not retry every line", async () => {
    const log = logger({ maxBytes: 40, keep: 1 });
    log("line 1"); log("line 2");
    await log.flush();
    // Windows refuses to rename a file a viewer or a scanner holds open.
    const rename = vi.spyOn(logFs, "rename").mockRejectedValue(Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }));
    try {
      for (let i = 3; i <= 6; i += 1) log(`line ${i}`);
      await log.flush();
      expect(rename).toHaveBeenCalledTimes(1);
    } finally { rename.mockRestore(); }
    const text = await fs.readFile(filePath, "utf8");
    expect(text.match(/line \d/g)).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"]);
    expect(text.match(/could not rotate/g)).toHaveLength(1);
    expect(err).toEqual([]);
  });

  it("loses no further archive while the active file's rename keeps failing (review batch 4)", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    for (const index of [1, 2, 3]) await fs.writeFile(rotatedPath(filePath, index), `archive ${index}\n`);
    await fs.writeFile(filePath, "active\n");
    const rename = logFs.rename.bind(logFs);
    const blocked = vi.spyOn(logFs, "rename").mockImplementation(async (from, to) => {
      if (from === filePath) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      return rename(from, to);
    });
    try {
      for (let attempt = 0; attempt < 3; attempt++) await expect(rotateLog(filePath, 3)).rejects.toThrow("EBUSY");
    } finally { blocked.mockRestore(); }
    // The first attempt dropped the oldest archive, as a rotation does; the retries moved nothing.
    const read = (index: number) => fs.readFile(rotatedPath(filePath, index), "utf8").catch(() => undefined);
    expect([await read(1), await read(2), await read(3)]).toEqual([undefined, "archive 1\n", "archive 2\n"]);
    // Once the file is free the gap takes it, still without dropping anything.
    await rotateLog(filePath, 3);
    expect([await read(1), await read(2), await read(3)]).toEqual(["active\n", "archive 1\n", "archive 2\n"]);
  });

  it("does not rotate while the file is at or under maxBytes", async () => {
    const log = logger({ maxBytes: 10_000 });
    for (let i = 0; i < 50; i += 1) log("x");
    await log.flush();
    expect(await exists(rotatedPath(filePath, 1))).toBe(false);
    expect((await fs.readFile(filePath, "utf8")).split("\n")).toHaveLength(51);
  });

  it("never throws when the file cannot be written; reports once on stderr and keeps stdout", async () => {
    // The parent "logs" is a regular file, so mkdir/append must fail.
    await fs.writeFile(path.join(dir, "logs"), "");
    const log = logger();
    expect(() => log("a")).not.toThrow();
    expect(() => log("b")).not.toThrow();
    await log.flush();
    expect(out).toHaveLength(2);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("file logging disabled");
    expect(err[0]).toContain(filePath);
  });

  it("writes again after its folder is removed and says how many lines the file missed", async () => {
    const log = logger();
    log("before");
    await log.flush();
    await fs.rm(path.dirname(filePath), { recursive: true });
    log("lost");
    await log.flush();
    log("after");
    await log.flush();
    const lines = (await fs.readFile(filePath, "utf8")).trimEnd().split("\n");
    expect(lines).toEqual([
      "[2026-09-12T10:00:00.000Z] log: 1 line(s) could not be written to this file (stdout has them)",
      "[2026-09-12T10:00:00.000Z] after",
    ]);
    expect(out).toHaveLength(3);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("skipping file lines until a write succeeds");
  });

  it("writes again once another process stops holding the file (EBUSY on Windows), instead of giving the file up", async () => {
    const log = logger();
    log("before");
    await log.flush();
    const busy = vi.spyOn(logFs, "appendFile").mockRejectedValueOnce(Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }));
    log("held");
    await log.flush();
    busy.mockRestore();
    log("after");
    await log.flush();
    expect((await fs.readFile(filePath, "utf8")).trimEnd().split("\n")).toEqual([
      "[2026-09-12T10:00:00.000Z] before",
      "[2026-09-12T10:00:00.000Z] log: 1 line(s) could not be written to this file (stdout has them)",
      "[2026-09-12T10:00:00.000Z] after",
    ]);
    expect(err).toEqual([expect.stringContaining("skipping file lines until a write succeeds")]);
  });

  it("stops touching the file after a mid-run write failure", async () => {
    const log = logger();
    log("before");
    await log.flush();
    // Replace the log file with a directory: append now fails with EISDIR.
    await fs.rm(filePath);
    await fs.mkdir(filePath);
    log("during");
    log("after");
    await log.flush();
    expect(err).toHaveLength(1);
    expect(out).toHaveLength(3);
    expect((await fs.readdir(filePath)).length).toBe(0);
  });
});

describe("createFileLogger overflow", () => {
  it("marks the lines a full queue dropped from the file, once it accepts lines again", async () => {
    const log = logger();
    const big = "x".repeat(300 * 1024);
    for (let i = 0; i < 5; i++) log(`${i} ${big}`);
    await log.flush();
    log("after");
    log("later");
    await log.flush();
    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n").map(l => l.slice(0, 80));
    expect(lines.map(l => l.split(" ")[1])).toEqual(["0", "1", "2", "log:", "after", "later"]);
    expect(lines[3]).toContain("log: dropped 2 line(s) from this file");
    expect(out).toHaveLength(7);
    expect(err).toHaveLength(1);
  });

  it("counts the dropped lines as unwritten when the line reporting them cannot be written", async () => {
    const log = logger();
    const big = "x".repeat(300 * 1024);
    for (let i = 0; i < 5; i++) log(`${i} ${big}`);
    await log.flush();
    await fs.rm(path.dirname(filePath), { recursive: true });
    log("lost");
    await log.flush();
    log("after");
    await log.flush();
    const lines = (await fs.readFile(filePath, "utf8")).trimEnd().split("\n");
    expect(lines).toEqual([
      "[2026-09-12T10:00:00.000Z] log: 3 line(s) could not be written to this file (stdout has them)",
      "[2026-09-12T10:00:00.000Z] after",
    ]);
  });
});

describe("flushBeforeExit", () => {
  it("resolves true once queued lines are written, false when the write outlasts the bound", async () => {
    const log = createFileLogger({ filePath, stdout: () => {} });
    log("start: failed; exiting");
    expect(await flushBeforeExit(log)).toBe(true);
    expect(await fs.readFile(filePath, "utf8")).toContain("start: failed; exiting");
    expect(await flushBeforeExit({ flush: () => new Promise<void>(() => {}) }, 10)).toBe(false);
  });
});

describe("rotateLog", () => {
  it("shifts the whole chain and drops the oldest archive", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "active");
    await fs.writeFile(rotatedPath(filePath, 1), "one");
    await fs.writeFile(rotatedPath(filePath, 2), "two");
    await fs.writeFile(rotatedPath(filePath, 3), "three");
    await rotateLog(filePath, 3);
    expect(await exists(filePath)).toBe(false);
    expect(await fs.readFile(rotatedPath(filePath, 1), "utf8")).toBe("active");
    expect(await fs.readFile(rotatedPath(filePath, 2), "utf8")).toBe("one");
    expect(await fs.readFile(rotatedPath(filePath, 3), "utf8")).toBe("two");
    expect(await exists(rotatedPath(filePath, 4))).toBe(false);
  });

  it("fills the first gap in the chain and moves nothing past it", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "active");
    await fs.writeFile(rotatedPath(filePath, 2), "two");
    await rotateLog(filePath, 3);
    expect(await fs.readFile(rotatedPath(filePath, 1), "utf8")).toBe("active");
    expect(await fs.readFile(rotatedPath(filePath, 2), "utf8")).toBe("two");
    expect(await exists(rotatedPath(filePath, 3))).toBe(false);
  });

  it("removes the active file when no archives are kept", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "active");
    await rotateLog(filePath, 0);
    expect(await fs.readdir(path.dirname(filePath))).toEqual([]);
  });

  it("is a no-op on an empty directory", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await expect(rotateLog(filePath, 3)).resolves.toBeUndefined();
    expect(await fs.readdir(path.dirname(filePath))).toEqual([]);
  });
});
