import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecordingResultStore } from "./recording-result-store";
import { RecordingResults } from "./recording-result";
import type { RecordingResult } from "../shared/recording-result";

let dir: string, file: string;
const failure: RecordingResult = { id: "failure-a", occurredAt: "2026-09-25T00:00:00Z", code: "disk_full", detail: "ENOSPC", outcome: "pending", acknowledged: false };
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "result-store-")); file = path.join(dir, "recording-result.json"); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });
const stat = (file: string) => fs.promises.stat(file);
it("retains unread and acknowledged results across new instances without touching media", async () => {
  const media = path.join(dir, "partial.mp4"); fs.writeFileSync(media, "partial bytes");
  const first = new RecordingResults(new RecordingResultStore(file));
  first.update({ ...failure, outcome: "partial", partialPath: media });
  const second = new RecordingResults(new RecordingResultStore(file));
  expect(second.current).toMatchObject({ id: failure.id, acknowledged: false, outcome: "unknown" });
  await second.restore(stat, vi.fn());
  expect(second.current).toMatchObject({ outcome: "partial", partialPath: media });
  expect(second.acknowledge(failure.id)).toBe(true);
  const third = new RecordingResults(new RecordingResultStore(file));
  await third.restore(stat, vi.fn());
  expect(third.current).toMatchObject({ acknowledged: true, outcome: "partial" });
  expect(fs.readFileSync(media, "utf8")).toBe("partial bytes");
  third.update({ ...failure, id: "failure-b" });
  expect(new RecordingResultStore(file).load()[0]).toMatchObject({ id: "failure-b", acknowledged: false });
});
it("rechecks interrupted cleanup but never promotes it to confirmed preservation", async () => {
  const media = path.join(dir, "unfinished.mp4"); fs.writeFileSync(media, "bytes");
  new RecordingResultStore(file).save([{ ...failure, recordingPath: media }]);
  const results = new RecordingResults(new RecordingResultStore(file));
  expect(results.current?.outcome).toBe("unknown");
  const check = vi.fn(stat);
  await results.restore(check, vi.fn());
  expect(check).toHaveBeenCalledWith(media);
  expect(results.current).toMatchObject({ outcome: "unknown", recordingPath: media, acknowledged: false });
  expect(new RecordingResultStore(file).load()[0]?.outcome).toBe("unknown");
});
it.each(["missing", "empty", "directory"])("does not claim a restored %s partial is kept", async kind => {
  const media = path.join(dir, "partial.mp4");
  if (kind === "empty") fs.writeFileSync(media, "");
  if (kind === "directory") fs.mkdirSync(media);
  new RecordingResultStore(file).save([{ ...failure, outcome: "partial", partialPath: media, acknowledged: true }]);
  const results = new RecordingResults(new RecordingResultStore(file));
  await results.restore(stat, vi.fn());
  expect(results.current).toMatchObject({ outcome: "unknown", acknowledged: true });
  expect(results.current?.partialPath).toBeUndefined();
  expect(results.current?.recordingPath).toBe(media);
  const restarted = new RecordingResults(new RecordingResultStore(file));
  const check = vi.fn(stat);
  await restarted.restore(check, vi.fn());
  expect(check).toHaveBeenCalledWith(media);
  expect(restarted.current).toMatchObject({ outcome: "unknown", recordingPath: media, acknowledged: true });
});
it("bounds startup inspection and ignores its late response", async () => {
  vi.useFakeTimers();
  new RecordingResultStore(file).save([{ ...failure, outcome: "partial", partialPath: path.join(dir, "offline.mp4") }]);
  const results = new RecordingResults(new RecordingResultStore(file));
  let resolve!: (s: { isFile(): boolean; size: number }) => void;
  const pending = results.restore(() => new Promise(done => { resolve = done; }), vi.fn());
  await vi.advanceTimersByTimeAsync(2000); await pending;
  expect(results.current?.outcome).toBe("unknown");
  expect(new RecordingResultStore(file).load()[0]).toMatchObject({ outcome: "unknown", previouslyPartial: true, recordingPath: path.join(dir, "offline.mp4") });
  resolve({ isFile: () => true, size: 10 }); await Promise.resolve();
  expect(results.current?.outcome).toBe("unknown");
});
it("late startup inspection cannot overwrite a new failure or acknowledgement", async () => {
  const store = new RecordingResultStore(file);
  store.save([{ ...failure, outcome: "partial", partialPath: path.join(dir, "a.mp4") }]);
  const results = new RecordingResults(store);
  let resolve!: (s: { isFile(): boolean; size: number }) => void;
  const pending = results.restore(() => new Promise(done => { resolve = done; }), vi.fn());
  results.update({ ...failure, id: "new" });
  results.update({ ...failure, id: "new", outcome: "empty" });
  results.acknowledge("new");
  resolve({ isFile: () => true, size: 10 }); await pending;
  expect(results.current).toMatchObject({ id: "new", acknowledged: true, outcome: "empty" });
  expect(store.load()[0]).toMatchObject({ id: "new", acknowledged: true });
});
it("keeps a failed acknowledgement unread, exposes persistence failure and permits retry", () => {
  const store = new RecordingResultStore(file), results = new RecordingResults(store);
  results.update({ ...failure, outcome: "empty" });
  const save = vi.spyOn(store, "save").mockImplementationOnce(() => { throw new Error("disk full"); });
  expect(results.acknowledge(failure.id)).toBe(false);
  expect(results.current).toMatchObject({ acknowledged: false });
  expect(results.current?.persistenceFailed).toBeUndefined();
  expect(store.load()[0]?.acknowledged).toBe(false);
  expect(results.acknowledge(failure.id)).toBe(true);
  expect(results.current?.persistenceFailed).toBeUndefined();
  expect(store.load()[0]?.acknowledged).toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
});
it("retains a new failure in memory when saving fails and leaves no temporary file", () => {
  fs.mkdirSync(file); // A destination that cannot be atomically replaced by a file.
  const log = vi.fn(), results = new RecordingResults(new RecordingResultStore(file, log), log);
  expect(() => results.update(failure)).not.toThrow();
  expect(results.current).toMatchObject({ id: failure.id, persistenceFailed: true, acknowledged: false });
  expect(fs.readdirSync(dir)).toEqual(["recording-result.json"]);
  expect(log).toHaveBeenCalled();
});
it.each([null, { version: 2, result: failure }, { version: 1, result: { ...failure, code: "bad" } },
  { version: 1, result: { ...failure, partialPath: "relative" } }, { version: 1, result: { ...failure, acknowledged: true } },
  { version: 1, result: { ...failure, occurredAt: "bad" } }])("ignores malformed/versioned records without deleting evidence: %j", value => {
  const raw = JSON.stringify(value); fs.writeFileSync(file, raw);
  const log = vi.fn(); expect(new RecordingResultStore(file, log).load()[0]).toBeUndefined();
  expect(log).toHaveBeenCalled(); expect(fs.readFileSync(file, "utf8")).toBe(raw);
});
it("handles missing, corrupt and oversized JSON without breaking startup", () => {
  const log = vi.fn(), store = new RecordingResultStore(file, log);
  expect(store.load()[0]).toBeUndefined(); expect(log).not.toHaveBeenCalled();
  fs.writeFileSync(file, "{"); expect(store.load()[0]).toBeUndefined();
  fs.writeFileSync(file, " ".repeat(1024 * 1024 + 1)); expect(store.load()[0]).toBeUndefined();
});

it("failed atomic replacement preserves the previous complete record", () => {
  const store = new RecordingResultStore(file);
  store.save([{ ...failure, outcome: "empty" }]);
  const before = fs.readFileSync(file, "utf8");
  const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("replacement failed"); });
  try { expect(() => store.save([{ ...failure, id: "b", outcome: "empty" }])).toThrow("replacement failed"); }
  finally { rename.mockRestore(); }
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(fs.readdirSync(dir)).toEqual(["recording-result.json"]);
});

it("preserves candidate provenance when acknowledged during startup inspection and rechecks next launch", async () => {
  const media = path.join(dir, "partial.mp4"); fs.writeFileSync(media, "bytes");
  const store = new RecordingResultStore(file);
  store.save([{ ...failure, outcome: "partial", partialPath: media }]);
  const results = new RecordingResults(store);
  let resolve!: (s: { isFile(): boolean; size: number }) => void;
  const pending = results.restore(() => new Promise(done => { resolve = done; }), vi.fn());
  expect(results.acknowledge(failure.id)).toBe(true);
  expect(store.load()[0]).toMatchObject({ acknowledged: true, outcome: "unknown", recordingPath: media, previouslyPartial: true });
  resolve({ isFile: () => true, size: 10 }); await pending;
  expect(results.current?.acknowledged).toBe(true);
  const restarted = new RecordingResults(store); await restarted.restore(stat, vi.fn());
  expect(restarted.current).toMatchObject({ acknowledged: true, outcome: "partial", partialPath: media });
});
it("recovers previously confirmed partial classification after a temporary missing drive", async () => {
  const media = path.join(dir, "partial.mp4"), store = new RecordingResultStore(file);
  store.save([{ ...failure, outcome: "partial", partialPath: media }]);
  const offline = new RecordingResults(store); await offline.restore(stat, vi.fn());
  expect(store.load()[0]).toMatchObject({ outcome: "unknown", recordingPath: media, previouslyPartial: true });
  fs.writeFileSync(media, "bytes");
  const online = new RecordingResults(store); await online.restore(stat, vi.fn());
  expect(online.current).toMatchObject({ outcome: "partial", partialPath: media, acknowledged: false });
});
it("does not rewrite unchanged acknowledged records on startup", async () => {
  const store = new RecordingResultStore(file); store.save([{ ...failure, outcome: "empty", acknowledged: true }]);
  const save = vi.spyOn(store, "save").mockImplementation(() => { throw new Error("read-only"); });
  const results = new RecordingResults(store); await results.restore(stat, vi.fn());
  expect(save).not.toHaveBeenCalled();
  expect(results.current).toMatchObject({ acknowledged: true, restored: true });
  expect(results.current?.persistenceFailed).toBeUndefined();
});
it("can retry saving an acknowledged result whose startup reconciliation failed", async () => {
  const store = new RecordingResultStore(file); store.save([{ ...failure, outcome: "partial", partialPath: path.join(dir, "missing.mp4"), acknowledged: true }]);
  const save = vi.spyOn(store, "save").mockImplementationOnce(() => { throw new Error("full"); });
  const results = new RecordingResults(store); await results.restore(stat, vi.fn());
  expect(results.current).toMatchObject({ acknowledged: true, persistenceFailed: true });
  expect(results.acknowledge(failure.id)).toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
  expect(results.current?.persistenceFailed).toBeUndefined();
  expect(store.load()[0]).toMatchObject({ acknowledged: true, outcome: "unknown" });
});

it.each([false, true])("does not rewrite an unchanged confirmed partial on restart (acknowledged=%s)", async acknowledged => {
  const media = path.join(dir, "partial.mp4"); fs.writeFileSync(media, "bytes");
  const store = new RecordingResultStore(file);
  store.save([{ ...failure, outcome: "partial", partialPath: media, acknowledged }]);
  const save = vi.spyOn(store, "save").mockImplementation(() => { throw new Error("read only"); });
  const results = new RecordingResults(store); await results.restore(stat, vi.fn());
  expect(save).not.toHaveBeenCalled();
  expect(results.current).toMatchObject({ outcome: "partial", partialPath: media, acknowledged });
  expect(results.current?.persistenceFailed).toBeUndefined();
});

it("persists both failures and retries unread storage without acknowledging either", async () => {
  const store = new RecordingResultStore(file), results = new RecordingResults(store);
  results.update({ ...failure, outcome: "empty" });
  const save = vi.spyOn(store, "save").mockImplementation(() => { throw new Error("full"); });
  results.update({ ...failure, id: "b" }); results.update({ ...failure, id: "b", outcome: "empty" });
  expect(store.load().map(r => r.id)).toEqual([failure.id]);
  save.mockRestore();
  const io = { stat, refresh: vi.fn(), settled: () => true, platform: "darwin" as const,
    reveal: vi.fn(), folder: async () => {}, permission: async () => {}, relaunch: async () => {} };
  expect(await results.act("missing", "retry", io)).toBe(false);
  expect(await results.act("b", "retry", io)).toBe(true);
  const restarted = new RecordingResults(store);
  expect(restarted.all.map(r => [r.id, r.acknowledged])).toEqual([["b", false], [failure.id, false]]);
  expect(restarted.all.every(r => !r.persistenceFailed)).toBe(true);
});
it("migrates v1 to a separate file once and does not resurrect legacy data after removing all history", async () => {
  const legacy = path.join(dir, "legacy.json"), media = path.join(dir, "media.mp4");
  fs.writeFileSync(media, "kept");
  const raw = JSON.stringify({ version: 1, result: { ...failure, outcome: "partial", partialPath: media, acknowledged: true } });
  fs.writeFileSync(legacy, raw);
  const store = new RecordingResultStore(file, vi.fn(), legacy), results = new RecordingResults(store);
  await results.restore(stat, vi.fn());
  expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe(2);
  expect(store.load()[0]).toMatchObject({ id: failure.id, acknowledged: true, outcome: "partial" });
  const io = { stat, refresh: vi.fn(), settled: () => true, platform: "darwin" as const,
    reveal: vi.fn(), folder: async () => {}, permission: async () => {}, relaunch: async () => {} };
  expect(await results.act(failure.id, "remove", io)).toBe(true);
  expect(new RecordingResultStore(file, vi.fn(), legacy).load()).toEqual([]);
  expect(fs.readFileSync(legacy, "utf8")).toBe(raw);
  expect(fs.readFileSync(media, "utf8")).toBe("kept");
});
it("failed removal preserves visible history and the saved file", async () => {
  const store = new RecordingResultStore(file), results = new RecordingResults(store);
  results.update({ ...failure, outcome: "empty" }); results.acknowledge(failure.id);
  const save = vi.spyOn(store, "save").mockImplementationOnce(() => { throw new Error("full"); });
  expect(await results.act(failure.id, "remove", { stat, refresh: vi.fn(), settled: () => true, platform: "darwin",
    reveal: vi.fn(), folder: async () => {}, permission: async () => {}, relaunch: async () => {} })).toBe(false);
  expect(results.all).toHaveLength(1); expect(store.load()).toHaveLength(1);
  expect(results.current?.persistenceFailed).toBeUndefined(); save.mockRestore();
});
it("refuses to overwrite an unreadable or future history format", () => {
  const raw = JSON.stringify({ version: 3, results: [] }); fs.writeFileSync(file, raw);
  const store = new RecordingResultStore(file);
  expect(store.load()).toEqual([]);
  expect(() => store.save([{ ...failure, outcome: "empty" }])).toThrow("refusing to overwrite");
  expect(fs.readFileSync(file, "utf8")).toBe(raw);
});

it("issues only one filesystem request when the first startup check never returns", async () => {
  vi.useFakeTimers();
  const store = new RecordingResultStore(file);
  store.save(Array.from({ length: 8 }, (_, i) => ({ ...failure, id: String(i), outcome: "partial", partialPath: `/offline/${i}.mp4` })));
  const results = new RecordingResults(store), check = vi.fn(() => new Promise<{ isFile(): boolean; size: number }>(() => {}));
  const restoring = results.restore(check, vi.fn());
  await vi.advanceTimersByTimeAsync(2000); await restoring;
  expect(check).toHaveBeenCalledTimes(1);
  expect(results.all).toHaveLength(8);
  expect(results.all.every(r => r.outcome === "unknown" && r.previouslyPartial)).toBe(true);
});
it("only marks records that actually differ from disk after a failed save", () => {
  const store = new RecordingResultStore(file), results = new RecordingResults(store);
  results.update({ ...failure, outcome: "empty" });
  const save = vi.spyOn(store, "save").mockImplementation(() => { throw new Error("full"); });
  results.update({ ...failure, id: "b" });
  expect(results.all[0]?.persistenceFailed).toBe(true);
  expect(results.all[1]?.persistenceFailed).toBeUndefined();
  expect(results.acknowledge(failure.id)).toBe(false);
  expect(results.all[1]).toMatchObject({ acknowledged: false });
  expect(results.all[1]?.persistenceFailed).toBeUndefined();
  save.mockRestore();
});
