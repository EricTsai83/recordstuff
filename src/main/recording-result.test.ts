import { describe, expect, it, vi } from "vitest";
import { RecordingResults, failureGuidance, failureOutcome, failureReason, isPermissionFailure } from "./recording-result";
import type { RecordingFailure } from "../shared/recording-result";
import { ERROR_CODES } from "../shared/state";

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
it("does not tell a Primary display failure to choose Primary display", () => {
  expect(failureGuidance("display_unavailable", "en")).toBe("Choose Primary display or another screen.");
  expect([failureGuidance("no_display", "en"), failureGuidance("no_display", "zh-TW")]).toEqual([
    "Check that a display is connected and awake, then try again or choose another screen.",
    "請確認螢幕已連接且未進入睡眠後再試，或選擇其他螢幕。",
  ]);
});
it("tells a Mac too old to record to update, not to change settings or that content was lost", () => {
  expect([failureGuidance("unsupported_os_version", "en", "darwin"), failureGuidance("unsupported_os_version", "zh-TW", "darwin")])
    .toEqual(["Update macOS, then record again.", "請更新 macOS 後再錄影。"]);
});

it("names both causes of missing system audio on macOS, a very busy Mac first, and keeps the permission actions", () => {
  expect(failureReason("no_audio_track", "en")).toBe("System audio was unavailable at start, so nothing was recorded.");
  expect(failureReason("no_audio_track", "zh-TW")).toBe("開始時無法取得系統音訊，未錄到任何內容");
  const en = failureGuidance("no_audio_track", "en", "darwin");
  expect(en.indexOf("Heavy load")).toBeLessThan(en.indexOf("System Settings"));
  expect(en).toContain("then relaunch");
  expect(failureGuidance("no_audio_track", "zh-TW", "darwin")).toContain("負載過重");
  // A missing permission grant keeps its own guidance; other platforms keep the device hint.
  expect(failureGuidance("permission_denied", "en", "darwin")).toBe("Check recording permissions in System Settings. Relaunch if access was recently granted.");
  // Windows loopback records the default playback device (plan 064); other platforms keep the device hint.
  expect(failureGuidance("no_audio_track", "en", "win32")).toContain("default playback device");
  expect(failureGuidance("no_audio_track", "zh-TW", "win32")).toBe("系統音訊取自預設的播放裝置。請確認已連接播放裝置，並在 Windows 音效設定中啟用後再試。");
  expect(failureGuidance("no_audio_track", "en", "linux")).toContain("audio devices");
  expect(failureGuidance("permission_denied", "en", "win32")).toContain("audio devices");
  expect(isPermissionFailure("no_audio_track")).toBe(true);
});

it("does not relaunch again for a restored permission error unless current permission needs it", async () => {
  const io = effects();
  const store = new RecordingResults({ load: async () => [{ ...a, code: "permission_denied", outcome: "empty", acknowledged: false }], save: async () => {} });
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

it("Traditional Chinese failure reasons end without 。, since they also head a row (plan 035 D1)", () => {
  for (const code of ERROR_CODES) {
    expect(failureReason(code, "zh-TW"), code).not.toMatch(/[。．.]$/);
    expect(failureReason(code, "en"), code).not.toMatch(/\s$/);
  }
});

describe("action log (plan 047)", () => {
  const empty = { ...a, outcome: "empty" as const };
  /** Storage whose saves can fail or wait at a gate until it opens. */
  function logged(options: { fail?: () => Error | undefined } = {}) {
    const logs: string[] = [];
    let gate: { promise: Promise<void>; open: () => void } | undefined;
    const store = new RecordingResults({ load: async () => [], save: async () => {
      if (gate) await gate.promise;
      const error = options.fail?.();
      if (error) throw error;
    } }, message => logs.push(message));
    return {
      store,
      lines: () => logs.filter(line => line.startsWith("recording result:")),
      hold: () => { let open!: () => void; gate = { promise: new Promise<void>(resolve => { open = resolve; }), open }; },
      release: () => { gate?.open(); gate = undefined; },
    };
  }

  it("logs a saved acknowledgement, removal and retry with the record ID and no path or detail", async () => {
    const h = logged(), io = effects();
    await h.store.ready;
    h.store.update({ ...partial, detail: "ENOSPC: secret detail" });
    await h.store.persist();
    expect(await h.store.act("a", "acknowledge", io)).toBe(true);
    expect(await h.store.act("a", "retry", io)).toBe(true);
    expect(await h.store.act("a", "remove", io)).toBe(true);
    expect(h.lines()).toEqual(["recording result: acknowledge a saved", "recording result: retry a saved", "recording result: remove a saved"]);
    expect(h.lines().join("\n")).not.toMatch(/\/a\.mp4|secret|ENOSPC/);
  });

  it("logs a failed save with its storage error class", async () => {
    let failing: Error | undefined = new Error("EIO");
    const h = logged({ fail: () => failing }), io = effects();
    await h.store.ready;
    h.store.update(empty);
    expect(await h.store.act("a", "acknowledge", io)).toBe(false);
    expect(h.lines()).toEqual(["recording result: acknowledge a failed (io)"]);
    failing = undefined;
    expect(await h.store.act("a", "retry", io)).toBe(true);
    expect(h.lines().at(-1)).toBe("recording result: retry a saved");
  });

  it("logs refusals: a pending row, a row not reviewed, another action in flight and an unknown ID", async () => {
    const h = logged(), io = effects();
    await h.store.ready;
    h.store.update(a);
    expect(await h.store.act("a", "acknowledge", io)).toBe(false);
    expect(await h.store.act("a", "remove", io)).toBe(false);
    h.store.update(empty);
    expect(await h.store.act("a", "remove", io)).toBe(false);
    expect(await h.store.act("missing", "acknowledge", io)).toBe(false);
    expect(await h.store.act("a", "acknowledge", io)).toBe(true);
    h.hold();
    const removing = h.store.act("a", "remove", io);
    expect(await h.store.act("a", "acknowledge", io)).toBe(false);
    h.release();
    expect(await removing).toBe(true);
    expect(h.lines()).toEqual([
      "recording result: acknowledge a refused (pending record)",
      "recording result: remove a refused (pending record)",
      "recording result: remove a refused (not reviewed)",
      "recording result: acknowledge missing refused (unknown record)",
      "recording result: acknowledge a saved",
      "recording result: acknowledge a refused (remove in flight)",
      "recording result: remove a saved",
    ]);
  });

  it("logs an action that waits for a durable save when it settles, not when it is chosen", async () => {
    const h = logged(), io = effects();
    await h.store.ready;
    h.store.update(empty);
    await h.store.persist();
    h.hold();
    const acknowledging = h.store.act("a", "acknowledge", io);
    await vi.waitFor(() => expect(io.refresh).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.lines()).toEqual([]);
    h.release();
    expect(await acknowledging).toBe(true);
    expect(h.lines()).toEqual(["recording result: acknowledge a saved"]);
  });
});
