import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileWriteError, FileWriter, classifyWriteError, ensureWritableDir, nodeFs, type FileWriterFs, type WritableHandle } from "./file-writer";

let dir: string;
const activeWriters: FileWriter[] = [];
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-fw-"));
});
afterEach(async () => {
  for (const writer of activeWriters.splice(0)) await writer.abandon();
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

const bytes = (...values: number[]) => new Uint8Array(values);

describe("FileWriter", () => {
  it("appends in order, then finish publishes to the final path", async () => {
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

  it.each([false, true])("preserves final files colliding before/after open (late=%s)", async (late) => {
    const recording = path.join(dir, "same.recording.mp4");
    const final = path.join(dir, "same.mp4");
    if (!late) await fs.writeFile(final, "old");
    const writer = await FileWriter.open(recording, final);
    if (late) await fs.writeFile(final, "old");
    await fs.writeFile(path.join(dir, "same-2.mp4"), "another old");
    await writer.append(bytes(1, 2, 3));
    const saved = await writer.finish();
    expect(saved).toBe(path.join(dir, "same-3.mp4"));
    expect(await fs.readFile(final, "utf8")).toBe("old");
    expect(await fs.readFile(path.join(dir, "same-2.mp4"), "utf8")).toBe("another old");
    expect(await fs.readFile(saved)).toEqual(Buffer.from([1, 2, 3]));
    await expect(fs.stat(recording)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still reports the saved file if temporary cleanup fails", async () => {
    const recording = path.join(dir, "cleanup.recording.mp4");
    const final = path.join(dir, "cleanup.mp4");
    const writer = await FileWriter.open(recording, final, {
      io: { ...nodeFs, unlink: async () => { throw new Error("cleanup failed"); } },
    });
    await writer.append(bytes(7));
    expect(await writer.finish()).toBe(final);
    expect(await fs.readFile(final)).toEqual(Buffer.from([7]));
    expect(await fs.readFile(recording)).toEqual(Buffer.from([7]));
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
          write: async (data) => ({ bytesWritten: data.byteLength }),
          sync: async () => {
            syncs += 1;
          },
          close: async () => undefined,
        }),
        copyExclusive: async () => undefined,
        unlink: async () => undefined,
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
    activeWriters.push(writer);
    await writer.append(bytes(1));
    const failed = writer.append(bytes(2));
    await expect(failed).rejects.toMatchObject({ code: "disk_full" });
    // later appends fail fast with the same error and never hit the disk
    await expect(writer.append(bytes(3))).rejects.toMatchObject({ code: "disk_full" });
    expect(writes).toBe(2);
    await expect(writer.finish()).rejects.toBeInstanceOf(FileWriteError);
    expect(await fs.readFile(recording)).toEqual(Buffer.from([1]));
  });

  it("a failing exclusive copy on finish reports output_write_failed", async () => {
    const io: FileWriterFs = {
      ...nodeFs,
      copyExclusive: async () => {
        throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      },
    };
    const writer = await FileWriter.open(path.join(dir, "r.recording.mp4"), path.join(dir, "r.mp4"), { io });
    await writer.append(bytes(1));
    await expect(writer.finish()).rejects.toMatchObject({ code: "output_write_failed" });
    const partial = await writer.abandon();
    expect(await fs.readFile(partial!)).toEqual(Buffer.from([1]));
    await expect(fs.stat(path.join(dir, "r.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("complete writes", () => {
  async function open(onOpen: (handle: WritableHandle) => WritableHandle) {
    const writer = await FileWriter.open(path.join(dir, "short.recording.mp4"), path.join(dir, "short.mp4"), {
      io: wrapFs({ onOpen }),
    });
    activeWriters.push(writer);
    return writer;
  }

  it("completes 4096 bytes in seven-byte pieces and drains queued chunks before finish", async () => {
    const calls: number[] = [];
    const writer = await open((handle) => ({
      sync: () => handle.sync(), close: () => handle.close(),
      write: (data) => { calls.push(data.length); return handle.write(data.subarray(0, 7)); },
    }));
    const payload = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);
    const pending = [writer.append(new Uint8Array()), writer.append(payload), writer.append(bytes(9, 8, 7))];
    const finished = writer.finish();
    await Promise.all(pending);
    const final = await finished;
    expect(calls).not.toContain(0);
    expect(calls).toHaveLength(Math.ceil(4096 / 7) + 1);
    expect(writer.bytesWritten).toBe(4099);
    expect(await fs.readFile(final)).toEqual(Buffer.concat([payload, bytes(9, 8, 7)]));
  });

  it("keeps timer sync and later chunks outside an unfinished short-write append", async () => {
    vi.useFakeTimers();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const order: string[] = [];
    const writer = await open((handle) => ({
      close: () => handle.close(),
      sync: async () => { order.push("sync"); await handle.sync(); },
      write: async (data) => {
        order.push(`write:${data[0]}`);
        if (order.length === 1) await gate;
        return handle.write(data.subarray(0, 1));
      },
    }));
    try {
      const first = writer.append(bytes(1, 2));
      await vi.advanceTimersByTimeAsync(5000);
      const second = writer.append(bytes(3));
      expect(order).toEqual(["write:1"]);
      resume();
      await Promise.all([first, second]);
      const final = await writer.finish();
      expect(order).toEqual(["write:1", "write:2", "sync", "write:3", "sync"]);
      expect(await fs.readFile(final)).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      resume();
    }
  });

  it.each(["ENOSPC", "EIO", "zero"])("retains progress within the first chunk on %s and latches failure", async (fault) => {
    vi.useFakeTimers();
    const writes = vi.fn();
    const sync = vi.fn();
    const close = vi.fn();
    const writer = await open((handle) => ({
      sync: async () => { sync(); await handle.sync(); },
      close: async () => { close(); await handle.close(); },
      write: async (data) => {
        writes();
        if (writes.mock.calls.length === 1) return handle.write(data.subarray(0, 2));
        if (fault === "zero") return { bytesWritten: 0 };
        throw Object.assign(new Error(fault), { code: fault });
      },
    }));
    const failed = writer.append(bytes(1, 2, 3, 4));
    const error = await failed.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: fault === "ENOSPC" ? "disk_full" : "output_write_failed" });
    expect(writer.bytesWritten).toBe(2);
    await expect(writer.append(bytes(5))).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(writer.finish()).rejects.toBe(error);
    expect(await writer.abandon()).toBe(writer.recordingPath);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(sync).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(await fs.readFile(writer.recordingPath)).toEqual(Buffer.from([1, 2]));
    await expect(fs.stat(writer.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([0, -1, 0.5, NaN, Infinity, 4])("rejects invalid/no progress %s without counting or publishing", async (count) => {
    const write = vi.fn(async () => ({ bytesWritten: count }));
    const writer = await open((handle) => ({
      write, sync: () => handle.sync(), close: () => handle.close(),
    }));
    await expect(writer.append(bytes(1, 2, 3))).rejects.toMatchObject({ code: "output_write_failed" });
    expect(writer.bytesWritten).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    await expect(writer.finish()).rejects.toBeInstanceOf(FileWriteError);
    expect(await writer.abandon()).toBeUndefined();
    await expect(fs.stat(writer.recordingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(writer.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.each([false, true])("marks preservation uncertain when close fails, including finish first: %s", async finishFirst => {
  const writer = await FileWriter.open(path.join(dir, "uncertain.recording.mp4"), path.join(dir, "uncertain.mp4"), {
    io: wrapFs({ onOpen: handle => ({
      write: data => handle.write(data), sync: () => handle.sync(),
      close: async () => { await handle.close(); throw new Error("close failed"); },
    }) }),
  });
  activeWriters.push(writer);
  await writer.append(bytes(1, 2));
  if (finishFirst) await expect(writer.finish()).rejects.toThrow("close failed");
  await writer.abandon();
  expect(writer.preservationUncertain).toBe(true);
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
