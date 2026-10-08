import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUIT_FEEDBACK_DELAY_MS, QuitStatus } from "./quit-status";

let calls: string[];
let status: QuitStatus;
beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  status = new QuitStatus({
    holdNotices: held => calls.push(`hold ${held}`),
    resumeAdmission: () => calls.push("admit"),
    flushHeld: () => calls.push("flush"),
    refresh: () => calls.push("refresh"),
  });
});
afterEach(() => { status.dispose(); vi.useRealTimers(); });

describe("a quit in progress", () => {
  it("holds actions and notices at once, and says so only once it outlasts a quick exit", () => {
    status.begin();
    expect([status.requested, calls, status.context()]).toEqual([true, ["hold true"], {}]);
    vi.advanceTimersByTime(QUIT_FEEDBACK_DELAY_MS);
    expect(status.context()).toEqual({ quitting: true, quitStep: "media" });
    status.metadata();
    expect(status.context()).toEqual({ quitting: true, quitStep: "metadata" });
    expect(calls).toEqual(["hold true", "refresh", "refresh"]);
  });

  it("draws nothing for a quit declined before the delay, and releases exactly what it held, in order", () => {
    status.begin();
    status.end();
    vi.advanceTimersByTime(QUIT_FEEDBACK_DELAY_MS * 2);
    expect([status.requested, status.context()]).toEqual([false, {}]);
    expect(calls).toEqual(["hold true", "admit", "hold false", "flush"]);
  });

  it("keeps a declined quit's line until its work is done, unless a newer quit or state replaced it", async () => {
    let settle!: () => void;
    status.begin();
    status.metadata();
    status.end();
    status.defer(new Promise<void>(resolve => { settle = resolve; }));
    expect(status.context()).toEqual({ quitDeferred: "metadata" });
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(status.context()).toEqual({});

    let first!: () => void;
    status.begin();
    status.end();
    status.defer(new Promise<void>(resolve => { first = resolve; }));
    // A state change clears it without a draw of its own, and the old work settling later clears nothing new.
    status.clearDeferred(false);
    status.begin();
    status.end();
    status.defer(new Promise<void>(() => {}));
    first();
    await vi.advanceTimersByTimeAsync(0);
    expect(status.context()).toEqual({ quitDeferred: "media" });
  });

  it("starts each quit with recording work and clears the last quit's line", () => {
    status.begin(); status.metadata(); status.end(); status.defer(new Promise<void>(() => {}));
    calls.length = 0;
    status.begin();
    expect([status.step, status.context(), calls]).toEqual(["media", {}, ["refresh", "hold true"]]);
  });
});
