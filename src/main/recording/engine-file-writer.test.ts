import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineFileWriter } from "./engine-file-writer";
import { FileWriteError, NO_MEDIA_DETAIL, nodeFs } from "./file-writer";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-engine-writer-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const paths = (name = "2026-10-14 10-00-00") => [path.join(dir, `${name}.recording.mp4`), path.join(dir, `${name}.mp4`)] as const;

describe("EngineFileWriter", () => {
  it("reserves the temporary name empty and refuses one that exists", async () => {
    const [recording, final] = paths();
    await EngineFileWriter.open(recording, final);
    expect((await fs.stat(recording)).size).toBe(0);
    await expect(EngineFileWriter.open(recording, final)).rejects.toMatchObject({ code: "output_open_failed", cause: expect.objectContaining({ code: "EEXIST" }) });
  });

  it("publishes what the engine wrote under the final name and reports the engine's finalize", async () => {
    const [recording, final] = paths();
    const writer = await EngineFileWriter.open(recording, final, { report: (file) => file === recording ? { bytes: 5, finalizeMs: 12 } : undefined });
    await fs.writeFile(recording, "media");
    await expect(writer.finish()).resolves.toBe(final);
    expect(await fs.readFile(final, "utf8")).toBe("media");
    await expect(fs.stat(recording)).rejects.toMatchObject({ code: "ENOENT" });
    expect(writer.bytesWritten).toBe(5);
    expect(writer.finishTimings).toMatchObject({ finalizeMs: 12, method: "link" });
    expect(writer.finishTimings?.fragmented).toBeUndefined();
  });

  it("takes the next free name when the final one is taken", async () => {
    const [recording, final] = paths();
    await fs.writeFile(final, "older");
    const writer = await EngineFileWriter.open(recording, final);
    await fs.writeFile(recording, "media");
    await expect(writer.finish()).resolves.toBe(final.replace(/\.mp4$/, "-2.mp4"));
    expect(await fs.readFile(final, "utf8")).toBe("older");
  });

  it("never publishes an empty file: it is removed and the finish says no media existed", async () => {
    const [recording, final] = paths();
    const writer = await EngineFileWriter.open(recording, final);
    const failure = await writer.finish().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(FileWriteError);
    expect(failure).toMatchObject({ code: "capture_start_failed", cause: NO_MEDIA_DETAIL });
    await expect(fs.stat(recording)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(final)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a partial file on abandon, and removes an empty one", async () => {
    const [recording, final] = paths("a");
    const kept = await EngineFileWriter.open(recording, final);
    await fs.writeFile(recording, "partial");
    await expect(kept.abandon()).resolves.toBe(recording);
    await expect(kept.abandon()).resolves.toBe(recording);
    expect(await fs.readFile(recording, "utf8")).toBe("partial");

    const [empty, emptyFinal] = paths("b");
    const removed = await EngineFileWriter.open(empty, emptyFinal);
    await expect(removed.abandon()).resolves.toBeUndefined();
    await expect(fs.stat(empty)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks preservation uncertain when the file cannot be checked", async () => {
    const [recording, final] = paths();
    const writer = await EngineFileWriter.open(recording, final, { io: nodeFs, size: async () => { throw Object.assign(new Error("I/O"), { code: "EIO" }); } });
    await expect(writer.abandon()).resolves.toBeUndefined();
    expect(writer.preservationUncertain).toBe(true);
  });

  it("refuses appends: media never passes through main", async () => {
    const [recording, final] = paths();
    const writer = await EngineFileWriter.open(recording, final);
    await expect(writer.append()).rejects.toThrow("main appends nothing");
  });
});
