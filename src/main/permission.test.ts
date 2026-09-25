import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  shell: { openExternal: vi.fn() },
  systemPreferences: { getMediaAccessStatus: vi.fn() },
  desktopCapturer: { getSources: vi.fn() },
}));

import { PermissionWatcher, type PermissionStatus } from "./permission";

function setup(initial: { granted: boolean; screens: number | Error | "hang" }, options: { retryMaxMs?: number } = {}) {
  const state = { ...initial };
  const changes: PermissionStatus[] = [];
  const logs: string[] = [];
  const granted = vi.fn(() => state.granted);
  /** Underlying calls still unresolved; "hang" leaves them here for a late settlement. */
  const pending: Array<{ resolve: (count: number) => void; reject: (cause: Error) => void }> = [];
  const countScreens = vi.fn(
    () =>
      new Promise<number>((resolve, reject) => {
        if (state.screens === "hang") {
          const entry = {
            resolve: (count: number) => { pending.splice(pending.indexOf(entry), 1); resolve(count); },
            reject: (cause: Error) => { pending.splice(pending.indexOf(entry), 1); reject(cause); },
          };
          pending.push(entry);
          return;
        }
        if (state.screens instanceof Error) reject(state.screens);
        else resolve(state.screens);
      }),
  );
  let activate: (() => void) | undefined;
  const watcher = new PermissionWatcher((s) => changes.push(s), {
    intervalMs: 5000,
    validateTimeoutMs: 4000,
    ...options,
    isGranted: granted,
    countScreens,
    onActivate: (l) => {
      activate = l;
      return () => { if (activate === l) activate = undefined; };
    },
    log: (message) => logs.push(message),
  });
  return {
    watcher, state, changes, logs, countScreens, granted, pending,
    activate: () => activate?.(),
    hasActivateListener: () => activate !== undefined,
  };
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

  it("granted but capture sees nothing → needsRelaunch, retried with backoff, heals when capture works", async () => {
    const ctx = setup({ granted: true, screens: 0 });
    ctx.watcher.start();
    await flush();
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: true }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.countScreens).toHaveBeenCalledTimes(2);
    expect(ctx.changes).toHaveLength(1); // unchanged status is not re-emitted
    ctx.state.screens = 2;
    await vi.advanceTimersByTimeAsync(9999); // the second failure doubled the wait
    expect(ctx.countScreens).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
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

  // Bug 6: a deadline is not a cancellation. With default timers the old
  // watcher left seven unresolved getSources calls within 30 seconds.
  it("many polls and activations leave one underlying unresolved request", async () => {
    const ctx = setup({ granted: true, screens: "hang" });
    ctx.watcher.start();
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(5000);
      ctx.activate();
    }
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
    expect(ctx.pending).toHaveLength(1);
    expect(ctx.granted.mock.calls.length).toBeGreaterThan(12); // stage 1 keeps polling
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: true }]);
  });

  it("the prompt and the validation share one slot; a grant waits for the prompt to settle", async () => {
    const ctx = setup({ granted: false, screens: "hang" });
    ctx.watcher.start();
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
    ctx.state.granted = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
    // The overdue validation still guides the user while the prompt is pending.
    expect(ctx.changes.at(-1)).toEqual({ granted: false, needsRelaunch: true });
    ctx.pending[0]?.resolve(1);
    await flush();
    expect(ctx.countScreens).toHaveBeenCalledTimes(2); // a prompt result never validates
    ctx.pending[0]?.resolve(1);
    await flush();
    expect(ctx.changes.at(-1)).toEqual({ granted: true, needsRelaunch: false });
    expect(ctx.pending).toHaveLength(0);
  });

  it("a late success after the deadline heals without a second request", async () => {
    const ctx = setup({ granted: true, screens: "hang" });
    ctx.watcher.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: true }]);
    ctx.pending[0]?.resolve(1);
    await flush();
    expect(ctx.changes.at(-1)).toEqual({ granted: true, needsRelaunch: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
  });

  it("a late rejection starts a bounded backoff counted from its completion", async () => {
    const ctx = setup({ granted: true, screens: "hang" }, { retryMaxMs: 20_000 });
    ctx.watcher.start();
    await vi.advanceTimersByTimeAsync(27_500);
    ctx.state.screens = new Error("Failed to get sources.");
    ctx.pending[0]?.reject(new Error("late"));
    await flush();
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
    const calls = (): number => ctx.countScreens.mock.calls.length;
    for (const [wait, count] of [[5000, 2], [10_000, 3], [20_000, 4], [20_000, 5]] as const) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(calls()).toBe(count - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls()).toBe(count);
    }
    ctx.state.screens = 1;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctx.changes.at(-1)).toEqual({ granted: true, needsRelaunch: false });
  });

  it("revoke and regrant while a validation is pending: its late success is stale", async () => {
    const ctx = setup({ granted: true, screens: "hang" });
    ctx.watcher.start();
    ctx.state.granted = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: false }]);
    expect(ctx.countScreens).toHaveBeenCalledTimes(1); // the prompt waits for the slot
    ctx.state.granted = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
    ctx.pending[0]?.resolve(1);
    await flush();
    expect(ctx.changes.at(-1)).toEqual({ granted: false, needsRelaunch: false });
    expect(ctx.logs.at(-1)).toContain("superseded");
    expect(ctx.countScreens).toHaveBeenCalledTimes(2); // a fresh validation
    ctx.pending[0]?.resolve(1);
    await flush();
    expect(ctx.changes.at(-1)).toEqual({ granted: true, needsRelaunch: false });
  });

  it("a late rejection after revocation is ignored and frees the slot for the prompt", async () => {
    const ctx = setup({ granted: true, screens: "hang" });
    ctx.watcher.start();
    ctx.state.granted = false;
    await vi.advanceTimersByTimeAsync(5000);
    ctx.pending[0]?.reject(new Error("late"));
    await flush();
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: false }]);
    expect(ctx.countScreens).toHaveBeenCalledTimes(2);
    expect(ctx.pending).toHaveLength(1); // now the registration prompt
  });

  it("a refused capture supersedes an older validation still in flight", async () => {
    const ctx = setup({ granted: true, screens: "hang" });
    ctx.watcher.start();
    ctx.watcher.markRelaunchRequired();
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: true }]);
    expect(ctx.countScreens).toHaveBeenCalledTimes(1);
    ctx.pending[0]?.resolve(1);
    await flush();
    expect(ctx.changes).toEqual([{ granted: false, needsRelaunch: true }]);
    expect(ctx.countScreens).toHaveBeenCalledTimes(2);
    ctx.pending[0]?.resolve(1);
    await flush();
    expect(ctx.changes.at(-1)).toEqual({ granted: true, needsRelaunch: false });
  });

  it("stop() removes the listener and timers; a late result neither applies nor frees another's slot", async () => {
    const ctx = setup({ granted: true, screens: "hang" });
    ctx.watcher.start();
    ctx.watcher.stop();
    expect(ctx.hasActivateListener()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    ctx.watcher.start();
    expect(ctx.countScreens).toHaveBeenCalledTimes(1); // the old request still owns the slot
    ctx.pending[0]?.resolve(1);
    await flush();
    expect(ctx.changes).toEqual([]);
    expect(ctx.countScreens).toHaveBeenCalledTimes(2);
    ctx.watcher.stop();
    ctx.pending[0]?.resolve(1);
    await flush();
    expect(ctx.changes).toEqual([]);
    expect(ctx.countScreens).toHaveBeenCalledTimes(2);
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
