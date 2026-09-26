import { expect, it, vi } from "vitest";
import { RecordingResults, failureGuidance, failureOutcome, failureReason, isPermissionFailure } from "./recording-result";
import type { RecordingFailure } from "../shared/recording-result";

const a: RecordingFailure = { id: "a", code: "disk_full", detail: "ENOSPC", occurredAt: "2026-09-24T12:00:00Z", outcome: "pending" };
const partial = { ...a, outcome: "partial" as const, partialPath: "/a.mp4" };
function effects() {
  return { stat: vi.fn(async () => ({ isFile: (): boolean => true, size: 1 })), refresh: vi.fn(), notify: vi.fn(),
    settled: () => true, platform: "darwin" as NodeJS.Platform, reveal: vi.fn(), folder: vi.fn(async () => {}),
    permission: vi.fn(async () => {}), relaunch: vi.fn(async () => {}) };
}
it("notifies immediately only on pending and discards a stale asynchronous confirmation", async () => {
  const store = new RecordingResults(), io = effects();
  const pending = store.receive(a, io);
  expect(io.notify).toHaveBeenCalledExactlyOnceWith("disk_full");
  expect(store.current?.outcome).toBe("pending");
  await pending;
  let resolve!: (value: { isFile(): boolean; size: number }) => void;
  io.stat.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const old = store.receive(partial, io);
  await store.receive({ ...a, id: "b" }, io);
  resolve({ isFile: () => true, size: 1 });
  await old;
  expect(store.current?.id).toBe("b");
  expect(io.notify).toHaveBeenCalledTimes(2);
});
it.each(["missing", "empty", "directory"])("downgrades unconfirmed %s partial files and never repeats notification", async kind => {
  const store = new RecordingResults(), io = effects();
  await store.receive(a, io);
  io.stat.mockImplementation(async () => {
    if (kind === "missing") throw new Error("missing");
    return { isFile: () => kind !== "directory", size: 0 };
  });
  await store.receive(partial, io);
  expect(store.current).toMatchObject({ outcome: "unknown", acknowledged: false });
  expect(store.current?.partialPath).toBeUndefined();
  expect(io.notify).toHaveBeenCalledTimes(1);
});
it("rechecks reveal, downgrades a missing file and preserves acknowledgement", async () => {
  const store = new RecordingResults(), io = effects();
  store.update(partial); await store.acknowledge("a");
  expect(await store.act("a", "reveal", io)).toBe(true);
  expect(io.reveal).toHaveBeenCalledWith("/a.mp4");
  io.stat.mockRejectedValueOnce(new Error("unmounted"));
  expect(await store.act("a", "reveal", io)).toBe(false);
  expect(store.current).toMatchObject({ outcome: "unknown", acknowledged: true });
  expect(store.current?.partialPath).toBeUndefined();
});
it("refuses stale identities, pending destructive actions and recording recovery actions", async () => {
  const store = new RecordingResults(), io = effects();
  store.update(a);
  for (const action of ["acknowledge", "folder", "relaunch"] as const)
    expect(await store.act("a", action, io)).toBe(false);
  store.update(partial);
  expect(await store.act("old", "folder", io)).toBe(false);
  expect(await store.act("a", "folder", { ...io, settled: () => false })).toBe(false);
  expect(await store.act("a", "folder", io)).toBe(true);
  expect(io.folder).toHaveBeenCalledTimes(1);
  store.update({ ...a, code: "permission_denied" });
  expect(await store.act("a", "relaunch", io)).toBe(false);
  store.update({ ...a, code: "permission_denied", outcome: "empty" });
  expect(await store.act("a", "permission", { ...io, platform: "win32" })).toBe(false);
  expect(await store.act("a", "relaunch", io)).toBe(true);
});
it("keeps unread failure through cleanup and only acknowledges the exact settled result", async () => {
  const store = new RecordingResults();
  store.update(a);
  expect(await store.acknowledge("a")).toBe(false);
  store.update({ ...a, outcome: "partial", partialPath: "/a.recording.mp4" });
  expect(await store.acknowledge("other")).toBe(false);
  expect(store.current?.acknowledged).toBe(false);
  expect(await store.acknowledge("a")).toBe(true);
  expect(store.current?.partialPath).toBe("/a.recording.mp4");
  store.update({ ...a, outcome: "partial", partialPath: "/a.recording.mp4" });
  expect(store.current?.acknowledged).toBe(true);
  store.update({ ...a, id: "b" });
  expect(store.current?.acknowledged).toBe(false);
  expect(store.update({ ...a, outcome: "empty" })).toBe(true);
  expect(await store.acknowledge("a")).toBe(true);
  expect(store.current?.id).toBe("b");
});
it("distinguishes unknown from empty and does not promise recoverability", () => {
  expect(failureOutcome({ ...a, outcome: "unknown" }, "en")).toContain("Could not confirm");
  expect(failureOutcome({ ...a, outcome: "partial" }, "zh-TW")).toContain("可能無法播放");
  expect(failureGuidance("disk_full", "zh-TW")).toContain("釋放磁碟");
});

it("names both causes of missing system audio on macOS, a very busy Mac first, and keeps the permission actions", () => {
  expect(failureReason("no_audio_track", "en")).toBe("System audio was unavailable when recording started, so nothing was recorded.");
  expect(failureReason("no_audio_track", "zh-TW")).toBe("開始錄製時拿不到系統音訊，沒有開始錄製");
  const en = failureGuidance("no_audio_track", "en", "darwin");
  expect(en.indexOf("very heavy load")).toBeLessThan(en.indexOf("System Settings"));
  expect(en).toContain("then relaunch");
  expect(failureGuidance("no_audio_track", "zh-TW", "darwin")).toContain("負載非常重");
  // A missing permission grant keeps its own guidance; other platforms keep the device hint.
  expect(failureGuidance("permission_denied", "en", "darwin")).toBe("Check recording permissions in System Settings. Relaunch if access was recently granted.");
  expect(failureGuidance("no_audio_track", "en", "win32")).toContain("audio devices");
  expect(isPermissionFailure("no_audio_track")).toBe(true);
});

it("does not relaunch again for a restored permission error unless current permission needs it", async () => {
  const io = effects();
  const store = new RecordingResults({ load: async () => [{ ...a, code: "permission_needs_relaunch", outcome: "empty", acknowledged: false }], save: async () => {} });
  await store.ready;
  expect(await store.act("a", "relaunch", io)).toBe(false);
  expect(io.relaunch).not.toHaveBeenCalled();
  expect(await store.act("a", "relaunch", { ...io, needsRelaunch: () => true })).toBe(true);
});

it("retains two failures independently, including late cleanup and exact-ID reveal", async () => {
  const results = new RecordingResults(), io = effects();
  await results.receive(a, io);
  let finish!: (value: { isFile(): boolean; size: number }) => void;
  io.stat.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const cleanup = results.receive(partial, io);
  await results.receive({ ...a, id: "b" }, io);
  await results.receive({ ...a, id: "b", outcome: "empty" }, io);
  finish({ isFile: () => true, size: 10 }); await cleanup;
  expect(results.all.map(r => [r.id, r.outcome])).toEqual([["b", "empty"], ["a", "partial"]]);
  expect(await results.acknowledge("b")).toBe(true);
  expect(results.all[1]?.acknowledged).toBe(false);
  expect(await results.act("a", "reveal", io)).toBe(true);
  expect(io.reveal).toHaveBeenCalledWith("/a.mp4");
});
it("keeps every unread failure but only the latest twenty acknowledged records", async () => {
  const results = new RecordingResults();
  results.update(a); results.update({ ...a, outcome: "empty" });
  for (let i = 0; i < 25; i++) {
    results.update({ ...a, id: String(i) }); results.update({ ...a, id: String(i), outcome: "empty" });
    expect(await results.acknowledge(String(i))).toBe(true);
  }
  expect(results.all).toHaveLength(21);
  expect(results.all.at(-1)).toMatchObject({ id: "a", acknowledged: false });
  expect(results.all[0]?.id).toBe("24");
  expect(results.all[19]?.id).toBe("5");
  expect(await results.acknowledge("a")).toBe(true);
  expect(results.all).toHaveLength(20);
  expect(results.all.at(-1)).toMatchObject({ id: "a", acknowledged: true, acknowledgedAt: expect.any(String) });
  expect(results.all.some(r => r.id === "5")).toBe(false);
});
it("removes only acknowledged metadata and rejects late cleanup or reveal after removal", async () => {
  const results = new RecordingResults(), io = effects();
  results.update(partial);
  expect(await results.act("a", "remove", io)).toBe(false);
  await results.acknowledge("a");
  let finish!: (value: { isFile(): boolean; size: number }) => void;
  io.stat.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const reveal = results.act("a", "reveal", io);
  expect(await results.act("a", "remove", io)).toBe(true);
  finish({ isFile: () => true, size: 10 });
  expect(await reveal).toBe(false);
  expect(io.reveal).not.toHaveBeenCalled();
  expect(results.update(partial)).toBe(false);
  expect(results.all).toEqual([]);
});

it("joins a duplicate submission and refuses a conflicting action on the same row while it waits", async () => {
  let release!: () => void;
  const save = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const results = new RecordingResults({ load: async () => [], save }), io = effects();
  await results.ready;
  results.update({ ...a, outcome: "empty" });
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1)); release();
  await results.persist();
  const first = results.act("a", "acknowledge", io), second = results.act("a", "acknowledge", io);
  expect(await results.act("a", "remove", io)).toBe(false);
  expect(results.current).toMatchObject({ acknowledged: false, saving: "acknowledge" });
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2)); release();
  expect(await first).toBe(true); expect(await second).toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
  expect(results.current).toMatchObject({ acknowledged: true });
  expect(results.current?.saving).toBeUndefined();
});
