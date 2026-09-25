import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryStorageError, RecordingResultStore, type ResultStorage } from "./recording-result-store";
import { RETRY_DELAYS_MS, RecordingResults } from "./recording-result";
import type { RecordingResult } from "../shared/recording-result";

let dir: string, file: string;
const failure: RecordingResult = { id: "failure-a", occurredAt: "2026-09-25T00:00:00Z", code: "disk_full", detail: "ENOSPC", outcome: "pending", acknowledged: false };
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "result-store-")); file = path.join(dir, "recording-result.json"); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
const stat = (file: string) => fs.promises.stat(file);
const load = (target = file) => new RecordingResultStore(target).load();
const io = { stat, refresh: vi.fn(), settled: () => true, platform: "darwin" as const,
  reveal: vi.fn(), folder: async () => {}, permission: async () => {}, relaunch: async () => {} };
/** A fresh controller over the same file, as after a restart. */
async function open(storage: ResultStorage = new RecordingResultStore(file)): Promise<RecordingResults> {
  const results = new RecordingResults(storage); await results.ready; return results;
}
/** Real file writes that wait for the test to release (or reject) each call. */
function gated(store = new RecordingResultStore(file)) {
  const calls: Array<{ ids: string[]; release(error?: Error): void }> = [];
  let active = 0, peak = 0;
  const storage: ResultStorage = {
    get requiresMigration() { return store.requiresMigration; },
    load: () => store.load(),
    save: results => new Promise((resolve, reject) => {
      active++; peak = Math.max(peak, active);
      calls.push({ ids: results.map(r => `${r.id}${r.acknowledged ? "+" : ""}`), release: error => {
        const done = (fn: () => void) => { active--; fn(); };
        if (error) done(() => reject(error));
        else store.save(results).then(() => done(resolve), cause => done(() => reject(cause)));
      } });
    }),
  };
  return { storage, calls, peak: () => peak };
}

it("retains unread and acknowledged results across new instances without touching media", async () => {
  const media = path.join(dir, "partial.mp4"); fs.writeFileSync(media, "partial bytes");
  const first = await open();
  first.update({ ...failure, outcome: "partial", partialPath: media });
  expect(await first.persist()).toBe(true);
  const second = await open();
  expect(second.current).toMatchObject({ id: failure.id, acknowledged: false, outcome: "unknown" });
  await second.restore(stat, vi.fn());
  expect(second.current).toMatchObject({ outcome: "partial", partialPath: media });
  expect(await second.acknowledge(failure.id)).toBe(true);
  const third = await open();
  await third.restore(stat, vi.fn());
  expect(third.current).toMatchObject({ acknowledged: true, outcome: "partial" });
  expect(fs.readFileSync(media, "utf8")).toBe("partial bytes");
  third.update({ ...failure, id: "failure-b" });
  await third.persist();
  expect((await load())[0]).toMatchObject({ id: "failure-b", acknowledged: false });
});
it("rechecks interrupted cleanup but never promotes it to confirmed preservation", async () => {
  const media = path.join(dir, "unfinished.mp4"); fs.writeFileSync(media, "bytes");
  await new RecordingResultStore(file).save([{ ...failure, recordingPath: media }]);
  const results = await open();
  expect(results.current?.outcome).toBe("unknown");
  const check = vi.fn(stat);
  await results.restore(check, vi.fn());
  expect(check).toHaveBeenCalledWith(media);
  expect(results.current).toMatchObject({ outcome: "unknown", recordingPath: media, acknowledged: false });
  expect((await load())[0]?.outcome).toBe("unknown");
});
it.each(["missing", "empty", "directory"])("does not claim a restored %s partial is kept", async kind => {
  const media = path.join(dir, "partial.mp4");
  if (kind === "empty") fs.writeFileSync(media, "");
  if (kind === "directory") fs.mkdirSync(media);
  await new RecordingResultStore(file).save([{ ...failure, outcome: "partial", partialPath: media, acknowledged: true }]);
  const results = await open();
  await results.restore(stat, vi.fn());
  expect(results.current).toMatchObject({ outcome: "unknown", acknowledged: true });
  expect(results.current?.partialPath).toBeUndefined();
  expect(results.current?.recordingPath).toBe(media);
  const restarted = await open();
  const check = vi.fn(stat);
  await restarted.restore(check, vi.fn());
  expect(check).toHaveBeenCalledWith(media);
  expect(restarted.current).toMatchObject({ outcome: "unknown", recordingPath: media, acknowledged: true });
});
it("bounds startup inspection and ignores its late response", async () => {
  await new RecordingResultStore(file).save([{ ...failure, outcome: "partial", partialPath: path.join(dir, "offline.mp4") }]);
  const results = await open();
  vi.useFakeTimers();
  let resolve!: (s: { isFile(): boolean; size: number }) => void;
  const pending = results.restore(() => new Promise(done => { resolve = done; }), vi.fn());
  await vi.advanceTimersByTimeAsync(2000);
  vi.useRealTimers(); await pending;
  expect(results.current?.outcome).toBe("unknown");
  expect((await load())[0]).toMatchObject({ outcome: "unknown", previouslyPartial: true, recordingPath: path.join(dir, "offline.mp4") });
  resolve({ isFile: () => true, size: 10 }); await Promise.resolve();
  expect(results.current?.outcome).toBe("unknown");
});
it("late startup inspection cannot overwrite a new failure or acknowledgement", async () => {
  await new RecordingResultStore(file).save([{ ...failure, outcome: "partial", partialPath: path.join(dir, "a.mp4") }]);
  const results = await open();
  let resolve!: (s: { isFile(): boolean; size: number }) => void;
  const pending = results.restore(() => new Promise(done => { resolve = done; }), vi.fn());
  results.update({ ...failure, id: "new" });
  results.update({ ...failure, id: "new", outcome: "empty" });
  expect(await results.acknowledge("new")).toBe(true);
  resolve({ isFile: () => true, size: 10 }); await pending;
  expect(results.current).toMatchObject({ id: "new", acknowledged: true, outcome: "empty" });
  expect((await load())[0]).toMatchObject({ id: "new", acknowledged: true });
});
it("keeps a failed acknowledgement unread, exposes no false warning and permits retry", async () => {
  const store = new RecordingResultStore(file), results = await open(store);
  results.update({ ...failure, outcome: "empty" });
  await results.persist();
  const save = vi.spyOn(store, "save").mockRejectedValueOnce(new Error("disk full"));
  expect(await results.acknowledge(failure.id)).toBe(false);
  expect(results.current).toMatchObject({ acknowledged: false });
  expect(results.current?.persistenceFailed).toBeUndefined();
  expect((await load())[0]?.acknowledged).toBe(false);
  expect(await results.acknowledge(failure.id)).toBe(true);
  expect(results.current?.persistenceFailed).toBeUndefined();
  expect((await load())[0]?.acknowledged).toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
});
it("retains a new failure in memory when saving fails and leaves no temporary file", async () => {
  const log = vi.fn(), results = new RecordingResults(new RecordingResultStore(file, log), log);
  await results.ready;
  fs.mkdirSync(file); // After loading: a destination that cannot be atomically replaced by a file.
  expect(() => results.update(failure)).not.toThrow();
  expect(results.current).toMatchObject({ id: failure.id, acknowledged: false });
  expect(await results.persist()).toBe(false);
  expect(results.current).toMatchObject({ id: failure.id, persistenceFailed: "io", acknowledged: false });
  expect(fs.readdirSync(dir)).toEqual(["recording-result.json"]);
  expect(log).toHaveBeenCalled();
  results.close();
});
it.each([null, { version: 2, result: failure }, { version: 1, result: { ...failure, code: "bad" } },
  { version: 1, result: { ...failure, partialPath: "relative" } }, { version: 1, result: { ...failure, acknowledged: true } },
  { version: 1, result: { ...failure, occurredAt: "bad" } }])("ignores malformed/versioned records without deleting evidence: %j", async value => {
  const raw = JSON.stringify(value); fs.writeFileSync(file, raw);
  const log = vi.fn(); expect((await new RecordingResultStore(file, log).load())[0]).toBeUndefined();
  expect(log).toHaveBeenCalled(); expect(fs.readFileSync(file, "utf8")).toBe(raw);
});
it("handles missing, corrupt and oversized JSON without breaking startup", async () => {
  const log = vi.fn(), store = new RecordingResultStore(file, log);
  expect((await store.load())[0]).toBeUndefined(); expect(log).not.toHaveBeenCalled();
  fs.writeFileSync(file, "{"); expect((await store.load())[0]).toBeUndefined();
  fs.writeFileSync(file, " ".repeat(1024 * 1024 + 1)); expect((await store.load())[0]).toBeUndefined();
});

it("failed atomic replacement preserves the previous complete record", async () => {
  const store = new RecordingResultStore(file);
  await store.save([{ ...failure, outcome: "empty" }]);
  const before = fs.readFileSync(file, "utf8");
  vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("replacement failed"));
  await expect(store.save([{ ...failure, id: "b", outcome: "empty" }])).rejects.toThrow("replacement failed");
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(fs.readdirSync(dir)).toEqual(["recording-result.json"]);
});

it("writes the same JSON as one serialization, re-encoding only changed records", async () => {
  const store = new RecordingResultStore(file);
  const rows: RecordingResult[] = [{ ...failure, outcome: "empty", detail: "引號 \" and\nline" }, { ...failure, id: "b", outcome: "empty", acknowledged: true, acknowledgedAt: "2026-09-25T01:00:00Z" }];
  const stringify = vi.spyOn(JSON, "stringify");
  await store.save(rows);
  expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify({ version: 2, results: rows }));
  stringify.mockClear();
  await store.save([{ ...rows[0]!, acknowledged: true, acknowledgedAt: "2026-09-25T02:00:00Z" }, rows[1]!]);
  expect(stringify).toHaveBeenCalledTimes(1);
  expect((await store.load()).map(r => r.acknowledged)).toEqual([true, true]);
});

it("preserves candidate provenance when acknowledged during startup inspection and rechecks next launch", async () => {
  const media = path.join(dir, "partial.mp4"); fs.writeFileSync(media, "bytes");
  const store = new RecordingResultStore(file);
  await store.save([{ ...failure, outcome: "partial", partialPath: media }]);
  const results = await open(store);
  let resolve!: (s: { isFile(): boolean; size: number }) => void;
  const pending = results.restore(() => new Promise(done => { resolve = done; }), vi.fn());
  expect(await results.acknowledge(failure.id)).toBe(true);
  expect((await load())[0]).toMatchObject({ acknowledged: true, outcome: "unknown", recordingPath: media, previouslyPartial: true });
  resolve({ isFile: () => true, size: 10 }); await pending;
  expect(results.current?.acknowledged).toBe(true);
  const restarted = await open(); await restarted.restore(stat, vi.fn());
  expect(restarted.current).toMatchObject({ acknowledged: true, outcome: "partial", partialPath: media });
});
it("recovers previously confirmed partial classification after a temporary missing drive", async () => {
  const media = path.join(dir, "partial.mp4"), store = new RecordingResultStore(file);
  await store.save([{ ...failure, outcome: "partial", partialPath: media }]);
  const offline = await open(store); await offline.restore(stat, vi.fn());
  expect((await load())[0]).toMatchObject({ outcome: "unknown", recordingPath: media, previouslyPartial: true });
  fs.writeFileSync(media, "bytes");
  const online = await open(); await online.restore(stat, vi.fn());
  expect(online.current).toMatchObject({ outcome: "partial", partialPath: media, acknowledged: false });
});
it("does not rewrite unchanged acknowledged records on startup", async () => {
  const store = new RecordingResultStore(file); await store.save([{ ...failure, outcome: "empty", acknowledged: true }]);
  const save = vi.spyOn(store, "save").mockRejectedValue(new Error("read-only"));
  const results = await open(store); await results.restore(stat, vi.fn());
  expect(save).not.toHaveBeenCalled();
  expect(results.current).toMatchObject({ acknowledged: true, restored: true });
  expect(results.current?.persistenceFailed).toBeUndefined();
});
it("can retry saving an acknowledged result whose startup reconciliation failed", async () => {
  const store = new RecordingResultStore(file); await store.save([{ ...failure, outcome: "partial", partialPath: path.join(dir, "missing.mp4"), acknowledged: true }]);
  const save = vi.spyOn(store, "save").mockRejectedValueOnce(new Error("full"));
  const results = await open(store); await results.restore(stat, vi.fn());
  expect(results.current).toMatchObject({ acknowledged: true, persistenceFailed: "io" });
  expect(await results.act(failure.id, "retry", io)).toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
  expect(results.current?.persistenceFailed).toBeUndefined();
  expect((await load())[0]).toMatchObject({ acknowledged: true, outcome: "unknown" });
});

it.each([false, true])("does not rewrite an unchanged confirmed partial on restart (acknowledged=%s)", async acknowledged => {
  const media = path.join(dir, "partial.mp4"); fs.writeFileSync(media, "bytes");
  const store = new RecordingResultStore(file);
  await store.save([{ ...failure, outcome: "partial", partialPath: media, acknowledged }]);
  const save = vi.spyOn(store, "save").mockRejectedValue(new Error("read only"));
  const results = await open(store); await results.restore(stat, vi.fn());
  expect(save).not.toHaveBeenCalled();
  expect(results.current).toMatchObject({ outcome: "partial", partialPath: media, acknowledged });
  expect(results.current?.persistenceFailed).toBeUndefined();
});

it("persists both failures and retries unread storage without acknowledging either", async () => {
  const store = new RecordingResultStore(file), results = await open(store);
  results.update({ ...failure, outcome: "empty" });
  await results.persist();
  const save = vi.spyOn(store, "save").mockRejectedValue(new Error("full"));
  results.update({ ...failure, id: "b" }); results.update({ ...failure, id: "b", outcome: "empty" });
  expect(await results.persist()).toBe(false);
  expect((await load()).map(r => r.id)).toEqual([failure.id]);
  save.mockRestore();
  expect(await results.act("missing", "retry", io)).toBe(false);
  expect(await results.act("b", "retry", io)).toBe(true);
  const restarted = await open();
  expect(restarted.all.map(r => [r.id, r.acknowledged])).toEqual([["b", false], [failure.id, false]]);
  expect(restarted.all.every(r => !r.persistenceFailed)).toBe(true);
});
it("migrates v1 to a separate file once and does not resurrect legacy data after removing all history", async () => {
  const legacy = path.join(dir, "legacy.json"), media = path.join(dir, "media.mp4");
  fs.writeFileSync(media, "kept");
  const raw = JSON.stringify({ version: 1, result: { ...failure, outcome: "partial", partialPath: media, acknowledged: true } });
  fs.writeFileSync(legacy, raw);
  const store = new RecordingResultStore(file, vi.fn(), legacy), results = await open(store);
  await results.restore(stat, vi.fn());
  expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe(2);
  expect((await load())[0]).toMatchObject({ id: failure.id, acknowledged: true, outcome: "partial" });
  expect(await results.act(failure.id, "remove", io)).toBe(true);
  expect(await new RecordingResultStore(file, vi.fn(), legacy).load()).toEqual([]);
  expect(fs.readFileSync(legacy, "utf8")).toBe(raw);
  expect(fs.readFileSync(media, "utf8")).toBe("kept");
});
it("failed removal preserves visible history and the saved file", async () => {
  const store = new RecordingResultStore(file), results = await open(store);
  results.update({ ...failure, outcome: "empty" }); await results.acknowledge(failure.id);
  const save = vi.spyOn(store, "save").mockRejectedValueOnce(new Error("full"));
  expect(await results.act(failure.id, "remove", io)).toBe(false);
  expect(results.all).toHaveLength(1); expect(await load()).toHaveLength(1);
  expect(results.current?.persistenceFailed).toBeUndefined(); save.mockRestore();
});
it("refuses to overwrite an unreadable or future history format and never retries it", async () => {
  const raw = JSON.stringify({ version: 3, results: [] }); fs.writeFileSync(file, raw);
  const store = new RecordingResultStore(file);
  expect(await store.load()).toEqual([]);
  await expect(store.save([{ ...failure, outcome: "empty" }])).rejects.toBeInstanceOf(HistoryStorageError);
  vi.useFakeTimers();
  const results = new RecordingResults(new RecordingResultStore(file)); await results.ready;
  const save = vi.spyOn(RecordingResultStore.prototype, "save");
  results.update({ ...failure, outcome: "empty" });
  await vi.advanceTimersByTimeAsync(0);
  expect(results.current?.persistenceFailed).toBe("blocked");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(save).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(file, "utf8")).toBe(raw);
});

it("issues only one filesystem request when the first startup check never returns", async () => {
  const store = new RecordingResultStore(file);
  await store.save(Array.from({ length: 8 }, (_, i) => ({ ...failure, id: String(i), outcome: "partial", partialPath: `/offline/${i}.mp4` })));
  const results = await open(store), check = vi.fn(() => new Promise<{ isFile(): boolean; size: number }>(() => {}));
  vi.useFakeTimers();
  const restoring = results.restore(check, vi.fn());
  await vi.advanceTimersByTimeAsync(2000);
  vi.useRealTimers(); await restoring;
  expect(check).toHaveBeenCalledTimes(1);
  expect(results.all).toHaveLength(8);
  expect(results.all.every(r => r.outcome === "unknown" && r.previouslyPartial)).toBe(true);
});
it("only marks records that actually differ from disk after a failed save", async () => {
  const store = new RecordingResultStore(file), results = await open(store);
  results.update({ ...failure, outcome: "empty" });
  await results.persist();
  vi.spyOn(store, "save").mockRejectedValue(new Error("full"));
  results.update({ ...failure, id: "b" });
  expect(await results.persist()).toBe(false);
  expect(results.all[0]?.persistenceFailed).toBe("io");
  expect(results.all[1]?.persistenceFailed).toBeUndefined();
  expect(await results.acknowledge(failure.id)).toBe(false);
  expect(results.all[1]).toMatchObject({ acknowledged: false });
  expect(results.all[1]?.persistenceFailed).toBeUndefined();
  results.close();
});

it("never writes before the saved history is loaded and merges failures that arrive meanwhile", async () => {
  const store = new RecordingResultStore(file);
  await store.save([{ ...failure, id: "old", outcome: "empty", acknowledged: true, acknowledgedAt: "2026-09-25T01:00:00Z" }]);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const save = vi.spyOn(store, "save");
  const results = new RecordingResults({ load: async () => { await gate; return store.load(); }, save: rows => store.save(rows) });
  expect(results.loading).toBe(true);
  results.update(failure);
  results.update({ ...failure, outcome: "empty" });
  const acknowledged = results.acknowledge(failure.id);
  expect(results.current).toMatchObject({ id: failure.id, acknowledged: false, saving: "acknowledge" });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(save).not.toHaveBeenCalled();
  expect((await load()).map(r => r.id)).toEqual(["old"]);
  finish();
  expect(await acknowledged).toBe(true);
  expect(results.loading).toBe(false);
  expect(save).toHaveBeenCalledTimes(1);
  expect((await load()).map(r => [r.id, r.acknowledged])).toEqual([[failure.id, true], ["old", true]]);
});

it("keeps one write in flight and coalesces A then B then C into one follow-up snapshot", async () => {
  const gate = gated(), results = await open(gate.storage);
  results.update({ ...failure, id: "A", outcome: "empty" });
  await vi.waitFor(() => expect(gate.calls).toHaveLength(1));
  results.update({ ...failure, id: "B" });
  results.update({ ...failure, id: "C" });
  const saved = results.persist();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(gate.calls).toHaveLength(1);
  gate.calls[0]!.release();
  await vi.waitFor(() => expect(gate.calls).toHaveLength(2));
  expect(gate.calls[1]!.ids).toEqual(["C", "B", "A"]);
  gate.calls[1]!.release();
  expect(await saved).toBe(true);
  expect(gate.peak()).toBe(1);
  expect((await load()).map(r => r.id)).toEqual(["C", "B", "A"]);
});

it("an older completion never clears the warning of a newer unsaved change", async () => {
  const gate = gated(), results = await open(gate.storage);
  results.update({ ...failure, id: "A", outcome: "empty" });
  await vi.waitFor(() => expect(gate.calls).toHaveLength(1));
  gate.calls[0]!.release(new Error("EIO"));
  await vi.waitFor(() => expect(results.current?.persistenceFailed).toBe("io"));
  const retried = results.persist();
  await vi.waitFor(() => expect(gate.calls).toHaveLength(2));
  results.update({ ...failure, id: "A", outcome: "empty", detail: "late detail" });
  gate.calls[1]!.release();
  expect(await retried).toBe(true);
  // Snapshot 2 held the old detail: the warning stays until the newer row is saved.
  expect(results.current).toMatchObject({ detail: "late detail", persistenceFailed: "io" });
  await vi.waitFor(() => expect(gate.calls).toHaveLength(3));
  gate.calls[2]!.release();
  await vi.waitFor(() => expect(results.current?.persistenceFailed).toBeUndefined());
  expect((await load())[0]?.detail).toBe("late detail");
});

it("commits acknowledgement and removal only when durable, preserving late cleanup and new arrivals", async () => {
  const gate = gated(), results = await open(gate.storage);
  results.update({ ...failure, outcome: "empty" });
  results.update({ ...failure, id: "reviewed" }); results.update({ ...failure, id: "reviewed", outcome: "empty" });
  await vi.waitFor(() => expect(gate.calls).toHaveLength(1)); gate.calls[0]!.release();
  await results.persist();
  expect(await (async () => { const done = results.acknowledge("reviewed"); await vi.waitFor(() => expect(gate.calls).toHaveLength(2)); gate.calls[1]!.release(); return done; })()).toBe(true);
  const refresh = vi.fn();
  const acknowledged = results.act(failure.id, "acknowledge", { ...io, refresh });
  const removed = results.act("reviewed", "remove", { ...io, refresh });
  await vi.waitFor(() => expect(gate.calls).toHaveLength(3));
  expect(gate.calls[2]!.ids).toEqual([`${failure.id}+`]);
  // Visible state is unchanged while waiting; new information still arrives.
  expect(results.all.map(r => [r.id, r.acknowledged, r.saving])).toEqual([["reviewed", true, "remove"], [failure.id, false, "acknowledge"]]);
  results.update({ ...failure, id: "new" });
  results.update({ ...failure, outcome: "empty", detail: "late cleanup" });
  gate.calls[2]!.release();
  expect(await acknowledged).toBe(true); expect(await removed).toBe(true);
  expect(results.all.map(r => [r.id, r.acknowledged, r.detail])).toEqual([["new", false, "ENOSPC"], [failure.id, true, "late cleanup"]]);
  await vi.waitFor(() => expect(gate.calls).toHaveLength(4)); gate.calls[3]!.release();
  await results.persist();
  const restarted = await open();
  expect(restarted.all.map(r => [r.id, r.acknowledged, r.detail])).toEqual([["new", false, "ENOSPC"], [failure.id, true, "late cleanup"]]);
  expect(refresh).toHaveBeenCalled();
});

it("a failed acknowledgement keeps the row unread while a concurrent arrival is still saved", async () => {
  const gate = gated(), results = await open(gate.storage);
  results.update({ ...failure, outcome: "empty" });
  await vi.waitFor(() => expect(gate.calls).toHaveLength(1)); gate.calls[0]!.release();
  await results.persist();
  const acknowledged = results.acknowledge(failure.id);
  await vi.waitFor(() => expect(gate.calls).toHaveLength(2));
  results.update({ ...failure, id: "B" });
  gate.calls[1]!.release(new Error("EIO"));
  expect(await acknowledged).toBe(false);
  expect(results.all.map(r => [r.id, r.acknowledged, r.persistenceFailed])).toEqual([["B", false, "io"], [failure.id, false, undefined]]);
  await vi.waitFor(() => expect(gate.calls).toHaveLength(3));
  expect(gate.calls[2]!.ids).toEqual(["B", failure.id]);
  gate.calls[2]!.release();
  await vi.waitFor(() => expect(results.current?.persistenceFailed).toBeUndefined());
});

it("retries a recoverable failure on one bounded backoff timer, joins manual retry and suspends when clean", async () => {
  vi.useFakeTimers();
  const log = vi.fn(), refresh = vi.fn();
  let fail = true;
  const save = vi.fn(async () => { if (fail) throw new Error("ENOSPC"); });
  const results = new RecordingResults({ load: async () => [], save }, log, refresh);
  await results.ready;
  results.update({ ...failure, outcome: "empty" });
  await vi.advanceTimersByTimeAsync(0);
  expect(save).toHaveBeenCalledTimes(1);
  const attempts: number[] = [];
  for (const delay of [...RETRY_DELAYS_MS, 30_000]) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    attempts.push(save.mock.calls.length);
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(RETRY_DELAYS_MS).toEqual([2000, 5000, 15_000, 30_000]);
  expect(attempts).toEqual([1, 2, 3, 4, 5]);
  expect(save).toHaveBeenCalledTimes(6);
  expect(log).toHaveBeenCalledTimes(1);
  // A manual retry starts now; the timer never adds a second writer.
  let release!: () => void;
  save.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const manual = results.act(failure.id, "retry", io);
  const again = results.persist();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(save).toHaveBeenCalledTimes(7);
  fail = false; release();
  expect(await manual).toBe(true); expect(await again).toBe(true);
  expect(results.current?.persistenceFailed).toBeUndefined();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining("saved after 6 failed attempt"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(save).toHaveBeenCalledTimes(7);
  // Backoff restarts at the first delay after success.
  fail = true;
  results.update({ ...failure, id: "b" });
  await vi.advanceTimersByTimeAsync(0);
  expect(save).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(2000);
  expect(save).toHaveBeenCalledTimes(9);
  results.close();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(save).toHaveBeenCalledTimes(9);
});

it("quit flush waits boundedly, never starts a parallel writer after a timeout and reports unsaved rows", async () => {
  const gate = gated(), results = await open(gate.storage);
  results.update({ ...failure, outcome: "empty" });
  await vi.waitFor(() => expect(gate.calls).toHaveLength(1));
  expect(await results.flush(20)).toBe("writing");
  expect(await results.flush(20)).toBe("writing");
  const retry = results.act(failure.id, "retry", io);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(gate.calls).toHaveLength(1);
  gate.calls[0]!.release(new Error("EIO"));
  expect(await retry).toBe(false);
  expect(results.busy).toBe(false);
  expect(results.unsaved().map(r => [r.id, r.persistenceFailed])).toEqual([[failure.id, "io"]]);
  const flushed = results.flush(1000);
  await vi.waitFor(() => expect(gate.calls).toHaveLength(2));
  gate.calls[1]!.release(new Error("EIO"));
  expect(await flushed).toBe("unsaved");
  expect(gate.peak()).toBe(1);
  const saved = results.flush(1000);
  await vi.waitFor(() => expect(gate.calls).toHaveLength(3));
  gate.calls[2]!.release();
  expect(await saved).toBe("safe");
  results.close();
  results.update({ ...failure, id: "after-close" });
  expect(await results.persist()).toBe(false);
  expect(gate.calls).toHaveLength(3);
  expect((await load()).map(r => r.id)).toEqual([failure.id]);
});

it("quit suspends automatic retry and staying resumes it", async () => {
  vi.useFakeTimers();
  const save = vi.fn(async () => { throw new Error("EIO"); });
  const results = new RecordingResults({ load: async () => [], save });
  await results.ready;
  results.update({ ...failure, outcome: "empty" });
  expect(await results.flush(1000)).toBe("unsaved");
  expect(save).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(save).toHaveBeenCalledTimes(1);
  results.resume();
  await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
  expect(save).toHaveBeenCalledTimes(2);
  results.close();
});

it("quit flush is safe without waiting when nothing is in memory during a hung load", async () => {
  const results = new RecordingResults({ load: () => new Promise(() => {}), save: async () => {} });
  expect(await results.flush(10_000)).toBe("safe");
  results.update(failure);
  expect(await results.flush(20)).toBe("unsaved");
  expect(results.unsaved().map(r => r.id)).toEqual([failure.id]);
});

it("a persist request made between a write's completion and the writer's release is still answered", async () => {
  // One late request per instance, at each microtask depth, so no later request can rescue it.
  for (let turns = 0; turns < 12; turns++) {
    const results = new RecordingResults();
    const first = results.persist();
    for (let turn = 0; turn < turns; turn++) await Promise.resolve();
    const late = results.persist();
    expect(await first).toBe(true);
    const outcome = await Promise.race([late, new Promise(resolve => setTimeout(() => resolve("pending"), 50))]);
    expect(outcome, `persist after ${turns} microtask turns`).toBe(true);
  }
});

it("recovers warnings for a very large unsaved history in linear time", async () => {
  const rows: RecordingResult[] = Array.from({ length: 60_000 }, (_, i) => ({ ...failure, id: `row-${i}`, outcome: "empty", detail: "" }));
  let fail = true;
  const results = new RecordingResults({ requiresMigration: true, load: async () => rows, save: async () => { if (fail) throw new Error("EIO"); } });
  await results.ready;
  results.update({ ...failure, id: "new" });
  expect(await results.persist()).toBe(false);
  expect(results.unsaved()).toHaveLength(60_001);
  fail = false;
  const start = performance.now();
  expect(await results.persist()).toBe(true);
  expect(performance.now() - start).toBeLessThan(3000);
  expect(results.all.some(r => r.persistenceFailed)).toBe(false);
  results.close();
}, 20_000);
