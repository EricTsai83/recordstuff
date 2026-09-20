import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  shell: { openExternal: vi.fn() },
  systemPreferences: { getMediaAccessStatus: vi.fn() },
  desktopCapturer: { getSources: vi.fn() },
}));

import { PermissionWatcher, type PermissionStatus } from "./permission";

function setup(initial: { granted: boolean; screens: number | Error | "hang" }) {
  const state = { ...initial };
  const changes: PermissionStatus[] = [];
  const granted = vi.fn(() => state.granted);
  const countScreens = vi.fn(
    () =>
      new Promise<number>((resolve, reject) => {
        if (state.screens === "hang") return;
        if (state.screens instanceof Error) reject(state.screens);
        else resolve(state.screens);
      }),
  );
  let activate: (() => void) | undefined;
  const watcher = new PermissionWatcher((s) => changes.push(s), {
    intervalMs: 5000,
    validateTimeoutMs: 4000,
    isGranted: granted,
    countScreens,
    onActivate: (l) => (activate = l),
  });
  return { watcher, state, changes, countScreens, granted, activate: () => activate?.() };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PermissionWatcher", () => {
  it("not granted → needsPermission, and makes exactly one registration/prompt call", async () => {
    const ctx = setup({ granted: false, screens: new Error("Failed to get sources.") });
    ctx.watcher.start();
    await flush();
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: false }]);
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
    expect(ctx.changes).toHaveLength(1);
  });

  it("granted and capture sees a screen → idle, validation cached", async () => {
    const ctx = setup({ granted: true, screens: 1 });
    ctx.watcher.start();
    await flush();
    expect(ctx.changes).toEqual([{ granted: true, needsRelaunch: false }]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
    expect(ctx.changes).toHaveLength(1);
  });

  // Cap's poller re-ran the expensive macOS display-list call for the whole
  // process lifetime and leaked ~15 MB/min (CapSoftware/Cap issue #2023).
  // Stage 1 may be polled forever; stage 2 must stop after one success.
  it("never repeats the expensive validation once capture is proven", async () => {
    const ctx = setup({ granted: true, screens: 1 });
    ctx.watcher.start();
    await flush();
    const cheap = ctx.granted.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
    expect(ctx.granted.mock.calls.length).toBeGreaterThan(cheap);
    ctx.activate();
    await flush();
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
  });

  it("an activation re-checks immediately without waiting for the next poll", async () => {
    const ctx = setup({ granted: true, screens: 1 });
    ctx.watcher.start();
    await flush();
    ctx.state.granted = false;
    ctx.activate();
    await flush();
    expect(ctx.changes.at(-1)).toEqual({ granted: false, needsRelaunch: false });
  });

  it("granted but capture sees nothing → needsRelaunch, retried each poll, heals when capture works", async () => {
    const ctx = setup({ granted: true, screens: 0 });
    ctx.watcher.start();
    await flush();
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: true }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.countScreens).toHaveBeenCalledTimes(2);
    expect(ctx.changes).toHaveLength(1); // unchanged status is not re-emitted
    ctx.state.screens = 2;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.changes.at(-1)).toEqual({ granted: true, needsRelaunch: false });
  });

  it("granted but getSources throws → needsRelaunch", async () => {
    const ctx = setup({ granted: true, screens: new Error("Failed to get sources.") });
    ctx.watcher.start();
    await flush();
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: true }]);
  });

  it("a validation that hangs is bounded by the timeout and counts as failed", async () => {
    const ctx = setup({ granted: true, screens: "hang" });
    ctx.watcher.start();
    await vi.advanceTimersByTimeAsync(3999);
    expect(ctx.changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: true }]);
  });

  it("de-duplicates in-flight validations across polls", async () => {
    const ctx = setup({ granted: true, screens: "hang" });
    ctx.watcher.start();
    ctx.watcher.check();
    ctx.activate();
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
  });

  it("the user grants while running: prompt → grant → validation → idle", async () => {
    const ctx = setup({ granted: false, screens: new Error("denied") });
    ctx.watcher.start();
    await flush();
    ctx.state.granted = true;
    ctx.state.screens = 1;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.changes).toEqual([
      { granted: false, needsRelaunch: false },
      { granted: true, needsRelaunch: false },
    ]);
  });

  it("the stale-TCC flow: grant → capture sees nothing → 重新啟動", async () => {
    const ctx = setup({ granted: false, screens: new Error("denied") });
    ctx.watcher.start();
    await flush();
    ctx.state.granted = true;
    ctx.state.screens = new Error("Failed to get sources.");
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.changes.at(-1)).toEqual({ granted: false, needsRelaunch: true });
  });

  it("markRelaunchRequired drops the cache and re-validates", async () => {
    const ctx = setup({ granted: true, screens: 1 });
    ctx.watcher.start();
    await flush();
    ctx.state.screens = 0;
    ctx.watcher.markRelaunchRequired();
    await flush();
    expect(ctx.changes.at(-1)).toEqual({ granted: false, needsRelaunch: true });
    expect(ctx.countScreens).toHaveBeenCalledTimes(2);
  });

  it("markRelaunchRequired is ignored when the OS itself says not granted", () => {
    const ctx = setup({ granted: false, screens: 0 });
    ctx.watcher.start();
    ctx.watcher.markRelaunchRequired();
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: false }]);
  });

  it("losing the grant resets relaunch state", async () => {
    const ctx = setup({ granted: true, screens: 0 });
    ctx.watcher.start();
    await flush();
    ctx.state.granted = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.changes.at(-1)).toEqual({ granted: false, needsRelaunch: false });
  });

  it("stop() ends polling", async () => {
    const ctx = setup({ granted: false, screens: 0 });
    ctx.watcher.start();
    ctx.watcher.stop();
    ctx.state.granted = true;
    ctx.state.screens = 1;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: false }]);
  });
});
