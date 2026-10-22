import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PUBLISH_ATTEMPTS, classifyWriteError, ensureWritableDir, nodeFs, publishRecording, type FileWriterFs } from "./file-writer";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-fw-"));
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A recording the engine finished under its temporary name. */
async function recorded(name: string, ...values: number[]): Promise<string> {
  const recording = path.join(dir, `${name}.recording.mp4`);
  await fs.writeFile(recording, new Uint8Array(values));
  return recording;
}

describe("publishRecording", () => {
  it("links the recording under its final name and removes the temporary one", async () => {
    const recording = await recorded("a", 1, 2, 3);
    const { target, timings } = await publishRecording(nodeFs, recording, path.join(dir, "a.mp4"));
    expect(target).toBe(path.join(dir, "a.mp4"));
    expect(await fs.readFile(target)).toEqual(Buffer.from([1, 2, 3]));
    await expect(fs.stat(recording)).rejects.toMatchObject({ code: "ENOENT" });
    expect(timings).toMatchObject({ method: "link" });
  });

  it("copies exclusively when the volume refuses hard links, for every candidate name", async () => {
    const recording = await recorded("fat", 8, 9);
    const final = path.join(dir, "fat.mp4");
    await fs.writeFile(final, "old");
    const link = vi.fn(async () => { throw Object.assign(new Error("not supported"), { code: "ENOTSUP" }); });
    const { target, timings } = await publishRecording({ ...nodeFs, link }, recording, final);
    expect(target).toBe(path.join(dir, "fat-2.mp4"));
    expect(link).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(final, "utf8")).toBe("old");
    expect(await fs.readFile(target)).toEqual(Buffer.from([8, 9]));
    await expect(fs.stat(recording)).rejects.toMatchObject({ code: "ENOENT" });
    expect(timings).toMatchObject({ method: "copy", linkError: "ENOTSUP" });
  });

  it("never copies over a name the link found taken, and keeps every older file", async () => {
    const copyExclusive = vi.fn(nodeFs.copyExclusive);
    const recording = await recorded("t", 1);
    await fs.writeFile(path.join(dir, "t.mp4"), "old");
    await fs.writeFile(path.join(dir, "t-2.mp4"), "another old");
    const { target } = await publishRecording({ ...nodeFs, copyExclusive }, recording, path.join(dir, "t.mp4"));
    expect(target).toBe(path.join(dir, "t-3.mp4"));
    expect(copyExclusive).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(dir, "t.mp4"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(dir, "t-2.mp4"), "utf8")).toBe("another old");
  });

  it("gives up after the last candidate name and keeps the recording, on a volume that answers EEXIST for every name", async () => {
    const recording = await recorded("busy", 7);
    const link = vi.fn(async () => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); });
    await expect(publishRecording({ ...nodeFs, link }, recording, path.join(dir, "busy.mp4")))
      .rejects.toMatchObject({ name: "FileWriteError", code: "output_write_failed" });
    expect(link).toHaveBeenCalledTimes(MAX_PUBLISH_ATTEMPTS);
    expect(link).toHaveBeenLastCalledWith(recording, path.join(dir, `busy-${MAX_PUBLISH_ATTEMPTS}.mp4`));
    expect(await fs.readFile(recording)).toEqual(Buffer.from([7]));
  });

  it("still reports the saved file if removing the temporary name fails", async () => {
    const recording = await recorded("cleanup", 7);
    const final = path.join(dir, "cleanup.mp4");
    const { target, timings } = await publishRecording({ ...nodeFs, unlink: async () => { throw new Error("cleanup failed"); } }, recording, final);
    expect(target).toBe(final);
    expect(await fs.readFile(final)).toEqual(Buffer.from([7]));
    // The leftover temporary name is a second link to the saved file.
    expect((await fs.stat(final)).nlink).toBe(2);
    expect(timings).toMatchObject({ method: "link", cleanupError: "cleanup failed" });
  });

  it("reports a failing exclusive copy after a refused link as output_write_failed, and one out of space as disk_full", async () => {
    const refused = async () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
    const failing: FileWriterFs = { ...nodeFs, link: refused, copyExclusive: async () => { throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); } };
    const recording = await recorded("r", 1);
    await expect(publishRecording(failing, recording, path.join(dir, "r.mp4"))).rejects.toMatchObject({ code: "output_write_failed" });
    const full: FileWriterFs = { ...nodeFs, link: refused, copyExclusive: async () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); } };
    await expect(publishRecording(full, recording, path.join(dir, "r.mp4"))).rejects.toMatchObject({ code: "disk_full" });
    expect(await fs.readFile(recording)).toEqual(Buffer.from([1]));
    await expect(fs.stat(path.join(dir, "r.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("classifyWriteError", () => {
  it("maps ENOSPC to disk_full and everything else to output_write_failed", () => {
    expect(classifyWriteError(Object.assign(new Error(), { code: "ENOSPC" }))).toBe("disk_full");
    expect(classifyWriteError(Object.assign(new Error(), { code: "EIO" }))).toBe("output_write_failed");
    expect(classifyWriteError("boom")).toBe("output_write_failed");
  });
});

describe("ensureWritableDir", () => {
  it("creates missing directories and leaves no probe file", async () => {
    const target = path.join(dir, "nested", "deeper");
    await ensureWritableDir(target);
    expect((await fs.readdir(target)).length).toBe(0);
  });

  it("fails with output_open_failed when the path is a file", async () => {
    const file = path.join(dir, "not-a-dir");
    await fs.writeFile(file, "");
    await expect(ensureWritableDir(file)).rejects.toMatchObject({ code: "output_open_failed" });
  });

  it("fails when the probe cannot be written", async () => {
    const io: FileWriterFs = {
      ...nodeFs,
      writeFile: async () => {
        throw Object.assign(new Error("read only"), { code: "EROFS" });
      },
    };
    await expect(ensureWritableDir(dir, io)).rejects.toMatchObject({ code: "output_open_failed" });
  });

  it("reports a probe refused for lack of space as disk_full", async () => {
    const io: FileWriterFs = {
      ...nodeFs,
      writeFile: async () => {
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      },
    };
    await expect(ensureWritableDir(dir, io)).rejects.toMatchObject({ code: "disk_full" });
  });
});

it("does not recreate a missing custom folder", async () => {
  const missing = path.join(dir, "offline");
  await expect(ensureWritableDir(missing, nodeFs, false)).rejects.toMatchObject({ code: "output_open_failed" });
  await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
});

it("removes the copy if syncing it fails, never claiming the name, and retains the recording", async () => {
  const source = path.join(dir, "sync.recording.mp4"), target = path.join(dir, "sync.mp4");
  await fs.writeFile(source, "retained");
  const original = fs.open;
  const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith(".copying")) vi.spyOn(handle, "sync").mockRejectedValue(new Error("sync failed"));
    return handle;
  });
  try { await expect(nodeFs.copyExclusive(source, target)).rejects.toThrow("sync failed"); }
  finally { spy.mockRestore(); }
  await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(source, "utf8")).toBe("retained");
  expect((await fs.readdir(dir)).filter((name) => name.endsWith(".copying"))).toEqual([]);
});

it("copies under a hidden name and shows the final name only once the copy is complete", async () => {
  const source = path.join(dir, "whole.recording.mp4"), target = path.join(dir, "whole.mp4");
  await fs.writeFile(source, "complete");
  const seen: string[][] = [];
  const original = fs.copyFile;
  const spy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args: Parameters<typeof fs.copyFile>) => {
    await original(...args);
    seen.push(await fs.readdir(dir));
  });
  try { await nodeFs.copyExclusive(source, target); }
  finally { spy.mockRestore(); }
  expect(seen[0]).not.toContain("whole.mp4");
  expect(seen[0]!.some((name) => name.startsWith(".whole.mp4.") && name.endsWith(".copying"))).toBe(true);
  expect(await fs.readFile(target, "utf8")).toBe("complete");
  expect((await fs.readdir(dir)).filter((name) => name.endsWith(".copying"))).toEqual([]);
});

it("refuses a taken name before copying and leaves it as it was", async () => {
  const source = path.join(dir, "taken.recording.mp4"), target = path.join(dir, "taken.mp4");
  await fs.writeFile(source, "new");
  await fs.writeFile(target, "old");
  await expect(nodeFs.copyExclusive(source, target)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await fs.readFile(target, "utf8")).toBe("old");
  expect((await fs.readdir(dir)).filter((name) => name.endsWith(".copying"))).toEqual([]);
});

it("refuses a full-copy publication without enough space for the recording", async () => {
  const source = path.join(dir, "large.recording.mp4"), target = path.join(dir, "large.mp4");
  await fs.writeFile(source, "retained");
  const statfs = vi.spyOn(fs, "statfs").mockResolvedValue({ bavail: 1, bsize: 1 } as Awaited<ReturnType<typeof fs.statfs>>);
  try { await expect(nodeFs.copyExclusive(source, target)).rejects.toMatchObject({ code: "ENOSPC" }); }
  finally { statfs.mockRestore(); }
  expect(await fs.readFile(source, "utf8")).toBe("retained");
  await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
});
