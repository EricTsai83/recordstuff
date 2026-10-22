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
    const writer = await EngineFileWriter.open(recording, final, { outcome: async (file) => file === recording ? { bytes: 5, finalizeMs: 12 } : undefined });
    await fs.writeFile(recording, "media");
    await expect(writer.finish()).resolves.toBe(final);
    expect(await fs.readFile(final, "utf8")).toBe("media");
    await expect(fs.stat(recording)).rejects.toMatchObject({ code: "ENOENT" });
    expect(writer.bytesWritten).toBe(5);
    expect(writer.finishTimings).toMatchObject({ finalizeMs: 12, method: "link" });
    expect(writer.finishTimings?.fragmented).toBeUndefined();
  });

  it("waits for the engine to finish the file before publishing it", async () => {
    const [recording, final] = paths();
    let finished: (report: { bytes: number; finalizeMs: number }) => void = () => undefined;
    const writer = await EngineFileWriter.open(recording, final, { outcome: () => new Promise((resolve) => { finished = resolve; }) });
    await fs.writeFile(recording, "media");
    let published: string | undefined;
    const finishing = writer.finish().then((target) => { published = target; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(published).toBeUndefined();
    await expect(fs.stat(final)).rejects.toMatchObject({ code: "ENOENT" });
    finished({ bytes: 5, finalizeMs: 900 });
    await finishing;
    expect(published).toBe(final);
    expect(writer.finishTimings).toMatchObject({ finalizeMs: 900 });
  });

  it("publishes nothing when the engine could not finish the file, and keeps what it wrote", async () => {
    const [recording, final] = paths();
    const writer = await EngineFileWriter.open(recording, final, {
      outcome: async () => { throw new FileWriteError("disk_full", recording, "No space left"); },
    });
    await fs.writeFile(recording, "partial");
    await expect(writer.finish()).rejects.toMatchObject({ code: "disk_full" });
    await expect(writer.abandon()).resolves.toBe(recording);
    await expect(fs.stat(final)).rejects.toMatchObject({ code: "ENOENT" });

    const [crashed, crashedFinal] = paths("b");
    const other = await EngineFileWriter.open(crashed, crashedFinal, { outcome: async () => { throw new Error("capture process exited with 11"); } });
    await fs.writeFile(crashed, "partial");
    await expect(other.finish()).rejects.toMatchObject({ name: "FileWriteError", code: "output_write_failed" });
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

  it("marks preservation uncertain when the file vanished without this writer removing it", async () => {
    // A drive unplugged mid-recording: its folder is gone, but the partial may still be on it.
    const [recording, final] = paths();
    const writer = await EngineFileWriter.open(recording, final);
    await fs.writeFile(recording, "partial");
    await fs.rm(recording);
    await expect(writer.abandon()).resolves.toBeUndefined();
    expect(writer.preservationUncertain).toBe(true);
  });

  it("says nothing was kept after a finish removed the empty file", async () => {
    const [recording, final] = paths();
    const writer = await EngineFileWriter.open(recording, final);
    await expect(writer.finish()).rejects.toMatchObject({ code: "capture_start_failed" });
    await expect(writer.abandon()).resolves.toBeUndefined();
    expect(writer.preservationUncertain).toBe(false);
  });

  it("reports a reservation refused for lack of space as disk_full", async () => {
    const [recording, final] = paths();
    const open = async () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); };
    await expect(EngineFileWriter.open(recording, final, { io: { ...nodeFs, open } })).rejects.toMatchObject({ name: "FileWriteError", code: "disk_full" });
  });
});
