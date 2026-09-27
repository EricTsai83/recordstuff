import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlledFaults } from "./controlled-faults";
import { Recorder } from "../../src/main/recorder";
import { RecordingResults } from "../../src/main/recording-result";
import { RecordingResultStore } from "../../src/main/recording-result-store";
import { DEFAULT_QUALITY } from "../../src/shared/quality";
import type { HostMessage } from "../../src/shared/protocol";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "controlled-faults-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !test(); i++) await pause(5);
  expect(test()).toBe(true);
}

describe("controlled acceptance faults", () => {
  it("fails one write, only once the file holds data, so the production writer keeps a partial", async () => {
    const events: string[] = [];
    const faults = new ControlledFaults(event => events.push(event));
    faults.set("write", "enospc");
    const partial = path.join(dir, "a.recording.mp4");
    const writer = await faults.openWriter(partial, path.join(dir, "a.mp4"));
    await writer.append(new Uint8Array([1, 2, 3]));
    await expect(writer.append(new Uint8Array([4]))).rejects.toMatchObject({ code: "disk_full" });
    expect(await writer.abandon()).toBe(partial);
    expect([...await fs.readFile(partial)]).toEqual([1, 2, 3]);
    expect(faults.faults.write).toBe("off");
    expect(events).toContain("write failed");

    // Disarmed after one use; EIO is a write failure rather than a full disk.
    const next = await faults.openWriter(path.join(dir, "b.recording.mp4"), path.join(dir, "b.mp4"));
    await next.append(new Uint8Array([5]));
    await next.append(new Uint8Array([6]));
    faults.set("write", "eio");
    await expect(next.append(new Uint8Array([7]))).rejects.toMatchObject({ code: "output_write_failed" });
    await next.abandon();
  });

  it("fails one close after the file really closed, so preservation is uncertain and nothing is published", async () => {
    const faults = new ControlledFaults();
    faults.set("close", "fail");
    const partial = path.join(dir, "c.recording.mp4"), final = path.join(dir, "c.mp4");
    const writer = await faults.openWriter(partial, final);
    await writer.append(new Uint8Array([8, 9]));
    await expect(writer.finish()).rejects.toMatchObject({ code: "EIO" });
    expect(await writer.abandon()).toBe(partial);
    expect(writer.preservationUncertain).toBe(true);
    expect(faults.faults.close).toBe("off");
    await expect(fs.access(final)).rejects.toThrow();
    expect([...await fs.readFile(partial)]).toEqual([8, 9]);
  });

  it("keeps a real Recorder failure pending in the history until the held cleanup is released", async () => {
    const faults = new ControlledFaults();
    const results = new RecordingResults();
    let deliver!: (message: HostMessage) => void;
    let started = 0;
    const recorder = new Recorder({
      host: { start: async () => { started++; }, record: sessionId => deliver({ type: "started", sessionId }), stop: () => undefined,
        onMessage: fn => { deliver = fn; }, onFailure: () => undefined },
      outputDir: () => dir, quality: () => DEFAULT_QUALITY, ensureWritableDir: async () => undefined,
      openWriter: faults.openWriter, newSessionId: () => "A",
      publishFailure: async result => {
        await faults.beforePublish(result);
        await results.receive(result, { stat: file => fs.stat(file), refresh: () => undefined, notify: () => undefined });
      },
    });
    faults.set("cleanup", "hold");
    recorder.toggle();
    await until(() => started === 1);
    deliver({ type: "prepared", sessionId: "A", mimeType: "video/mp4", capture: { videoBitsPerSecond: 1, audioBitsPerSecond: 1, warnings: [] } });
    deliver({ type: "chunk", sessionId: "A", seq: 0, bytes: new Uint8Array([1, 2, 3]).buffer });
    await pause(20);
    faults.set("write", "eio");
    deliver({ type: "chunk", sessionId: "A", seq: 1, bytes: new Uint8Array([4]).buffer });
    await until(() => faults.heldCounts.cleanup === 1);
    await pause(50);
    expect(recorder.state.type).toBe("idle");
    expect(results.all[0]).toMatchObject({ code: "output_write_failed", outcome: "pending", acknowledged: false });

    expect(faults.release("cleanup")).toBe(1);
    await until(() => results.all[0]?.outcome === "partial");
    const partial = results.all[0]!.partialPath!;
    expect([...await fs.readFile(partial)]).toEqual([1, 2, 3]);
    expect(faults.heldCounts.cleanup).toBe(0);
  });

  it("holds the first history load, forwards migration, and holds or rejects saves until changed", async () => {
    const legacy = path.join(dir, "recording-result.json"), history = path.join(dir, "recording-history.json");
    await fs.writeFile(legacy, JSON.stringify({ version: 1, result: { id: "old", occurredAt: "2026-09-20T00:00:00.000Z",
      code: "capture_failed", detail: "", outcome: "empty", acknowledged: false } }));
    const faults = new ControlledFaults(undefined, true);
    const storage = faults.storage(new RecordingResultStore(history, () => undefined, legacy));
    const results = new RecordingResults(storage, () => undefined, () => undefined, [60_000]);
    await pause(20);
    expect(results.loading).toBe(true);
    expect(faults.heldCounts["history-load"]).toBe(1);
    faults.release("history-load");
    await results.ready;
    expect(storage.requiresMigration).toBe(true);
    await until(() => !results.busy);
    expect(JSON.parse(await fs.readFile(history, "utf8")).results).toHaveLength(1);

    faults.set("history-save", "hold");
    const first = results.acknowledge("old");
    await until(() => faults.heldCounts["history-save"] === 1);
    expect(results.all[0]).toMatchObject({ saving: "acknowledge", acknowledged: false });
    faults.set("history-save", "fail");
    faults.release("history-save");
    expect(await first).toBe(false);
    expect(JSON.parse(await fs.readFile(history, "utf8")).results[0].acknowledged).toBe(false);

    faults.set("history-save", "off");
    expect(await results.acknowledge("old")).toBe(true);
    expect(await new RecordingResultStore(history).load()).toMatchObject([{ id: "old", acknowledged: true }]);
    // A later launch loads at once: only the first load was held.
    await expect(faults.storage(new RecordingResultStore(history)).load()).resolves.toHaveLength(1);
  });

  it("refuses unknown modes", () => {
    const faults = new ControlledFaults();
    expect(() => faults.set("close", "hold")).toThrow("close has no mode");
    expect(faults.faults.close).toBe("off");
  });
});
