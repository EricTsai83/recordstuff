import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic, writeFileAtomicSync } from "./atomic-file";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-atomic-"));
  file = path.join(dir, "nested", "settings.json");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.each([
  ["writeFileAtomic", (target: string, content: string) => writeFileAtomic(target, content)],
  ["writeFileAtomicSync", async (target: string, content: string) => writeFileAtomicSync(target, content)],
])("%s", (_name, write) => {
  it("creates the parent folder, replaces the content and leaves no temporary file", async () => {
    await write(file, "first");
    await write(file, "second");
    expect(fs.readFileSync(file, "utf8")).toBe("second");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["settings.json"]);
  });

  it("overwrites a temporary file left by an interrupted attempt", async () => {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(`${file}.tmp`, "half");
    await write(file, "complete");
    expect(fs.readFileSync(file, "utf8")).toBe("complete");
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("a failed replacement keeps the previous content and removes the temporary file", async () => {
    await write(file, "kept");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("replacement failed"); });
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("replacement failed"));
    await expect(write(file, "lost")).rejects.toThrow("replacement failed");
    expect(fs.readFileSync(file, "utf8")).toBe("kept");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["settings.json"]);
  });
});

it("flushes the data before the rename that publishes it", async () => {
  const order: string[] = [];
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { order.push("sync"); await sync(); };
    return handle;
  });
  const rename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, "rename").mockImplementation(async (...args: Parameters<typeof fs.promises.rename>) => {
    order.push("rename");
    await rename(...args);
  });
  await writeFileAtomic(file, "durable");
  expect(order).toEqual(["sync", "rename"]);

  const fsync = vi.spyOn(fs, "fsyncSync");
  const renameSync = vi.spyOn(fs, "renameSync");
  writeFileAtomicSync(file, "durable too");
  expect(fsync.mock.invocationCallOrder[0]).toBeLessThan(renameSync.mock.invocationCallOrder[0]!);
});
