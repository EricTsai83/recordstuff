import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileWriteError, FileWriter, classifyWriteError, ensureWritableDir, nodeFs, type FileWriterFs, type WritableHandle } from "./file-writer";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-fw-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const bytes = (...values: number[]) => new Uint8Array(values);

describe("FileWriter", () => {
  it("appends in order, then finish renames to the final path", async () => {
    const recording = path.join(dir, "a.recording.mp4");
    const final = path.join(dir, "a.mp4");
    const writer = await FileWriter.open(recording, final);
    const appends = [writer.append(bytes(1, 2)), writer.append(bytes(3)), writer.append(bytes(4, 5, 6))];
    await Promise.all(appends);
    expect(writer.bytesWritten).toBe(6);
    expect(await writer.finish()).toBe(final);
    expect(await fs.readFile(final)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
    await expect(fs.stat(recording)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite an existing recording file", async () => {
    const recording = path.join(dir, "dup.recording.mp4");
    await fs.writeFile(recording, "x");
    await expect(FileWriter.open(recording, path.join(dir, "dup.mp4"))).rejects.toMatchObject({
      name: "FileWriteError",
      code: "output_open_failed",
    });
  });

  it("abandon keeps a non-empty partial file and removes an empty one", async () => {
    const kept = await FileWriter.open(path.join(dir, "k.recording.mp4"), path.join(dir, "k.mp4"));
    await kept.append(bytes(9));
    expect(await kept.abandon()).toBe(path.join(dir, "k.recording.mp4"));
    expect(await fs.readFile(path.join(dir, "k.recording.mp4"))).toEqual(Buffer.from([9]));

    const empty = await FileWriter.open(path.join(dir, "e.recording.mp4"), path.join(dir, "e.mp4"));
    expect(await empty.abandon()).toBeUndefined();
    await expect(fs.stat(path.join(dir, "e.recording.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("append after finish rejects", async () => {
    const writer = await FileWriter.open(path.join(dir, "c.recording.mp4"), path.join(dir, "c.mp4"));
    await writer.finish();
    await expect(writer.append(bytes(1))).rejects.toThrow(/closed/);
  });

  it("fsyncs on the interval and once more on finish", async () => {
    vi.useFakeTimers();
    try {
      let syncs = 0;
      // Fully in-memory handle so the fake clock, not real I/O, drives the test.
      const io: FileWriterFs = {
        ...nodeFs,
        open: async () => ({
          write: async () => undefined,
          sync: async () => {
            syncs += 1;
          },
          close: async () => undefined,
        }),
        rename: async () => undefined,
      };
      const writer = await FileWriter.open("/mem/s.recording.mp4", "/mem/s.mp4", { io, fsyncIntervalMs: 5000 });
      await writer.append(bytes(1));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(syncs).toBe(2);
      await writer.finish();
      expect(syncs).toBe(3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(syncs).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a disk-full write rejects with disk_full and keeps the partial file", async () => {
    let writes = 0;
    const io = wrapFs({
      onOpen: (handle) => ({
        sync: () => handle.sync(),
        close: () => handle.close(),
        write: async (data) => {
          writes += 1;
          if (writes === 2) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
          return handle.write(data);
        },
      }),
    });
    const recording = path.join(dir, "d.recording.mp4");
    const writer = await FileWriter.open(recording, path.join(dir, "d.mp4"), { io });
    await writer.append(bytes(1));
    const failed = writer.append(bytes(2));
    await expect(failed).rejects.toMatchObject({ code: "disk_full" });
    // later appends fail fast with the same error and never hit the disk
    await expect(writer.append(bytes(3))).rejects.toMatchObject({ code: "disk_full" });
    expect(writes).toBe(2);
    await expect(writer.finish()).rejects.toBeInstanceOf(FileWriteError);
    expect(await fs.readFile(recording)).toEqual(Buffer.from([1]));
  });

  it("a failing rename on finish reports output_write_failed", async () => {
    const io: FileWriterFs = {
      ...nodeFs,
      rename: async () => {
        throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      },
    };
    const writer = await FileWriter.open(path.join(dir, "r.recording.mp4"), path.join(dir, "r.mp4"), { io });
    await writer.append(bytes(1));
    await expect(writer.finish()).rejects.toMatchObject({ code: "output_write_failed" });
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
});

function wrapFs(hooks: { onOpen: (handle: WritableHandle) => WritableHandle }): FileWriterFs {
  return {
    ...nodeFs,
    open: async (filePath, flags) => hooks.onOpen(await nodeFs.open(filePath, flags)),
  };
}
