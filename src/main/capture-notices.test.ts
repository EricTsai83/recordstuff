import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureNotices } from "./capture-notices";
import { SAVED_NOTIFICATION_DELAY_MS } from "./saved-notification";

const recording = { type: "recording", startedAt: "2026-09-29T00:00:00.000Z" } as const;
const idle = { type: "idle" } as const;

function setup(platform = "darwin") {
  const logs: string[] = [];
  const notices = new CaptureNotices({ platform, log: (m) => logs.push(m) });
  return { notices, logs };
}

describe("CaptureNotices", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("holds capture-start notices until the session settles and shows each once", () => {
    const { notices, logs } = setup();
    const cap = vi.fn(), rate = vi.fn();
    notices.stateChanged({ type: "starting" });
    notices.stateChanged(recording);
    notices.hold("resolution cap unconfirmed", cap);
    notices.hold("frame rate downgrade", rate);
    notices.stateChanged({ type: "stopping" });
    vi.advanceTimersByTime(60_000);
    expect(cap).not.toHaveBeenCalled();
    notices.stateChanged(idle);
    vi.advanceTimersByTime(SAVED_NOTIFICATION_DELAY_MS - 1);
    expect(cap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cap).toHaveBeenCalledTimes(1);
    expect(rate).toHaveBeenCalledTimes(1);
    notices.stateChanged(idle);
    vi.advanceTimersByTime(SAVED_NOTIFICATION_DELAY_MS);
    expect(cap).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(["notification: held until capture ends: resolution cap unconfirmed", "notification: held until capture ends: frame rate downgrade"]);
  });

  it("delivers after a failed session too, since needsPermission is settled", () => {
    const { notices } = setup();
    const cap = vi.fn();
    notices.stateChanged(recording);
    notices.hold("resolution cap unconfirmed", cap);
    notices.stateChanged({ type: "needsPermission", needsRelaunch: false });
    vi.advanceTimersByTime(SAVED_NOTIFICATION_DELAY_MS);
    expect(cap).toHaveBeenCalledTimes(1);
  });

  it("shows without the macOS delay elsewhere, still only after the session", () => {
    const { notices } = setup("win32");
    const cap = vi.fn();
    notices.stateChanged(recording);
    notices.hold("resolution cap unconfirmed", cap);
    expect(cap).not.toHaveBeenCalled();
    notices.stateChanged(idle);
    expect(cap).toHaveBeenCalledTimes(1);
  });

  it("drops what a new session or a quit overtakes", () => {
    const { notices, logs } = setup();
    const first = vi.fn(), second = vi.fn();
    notices.stateChanged(recording);
    notices.hold("frame rate downgrade", first);
    notices.stateChanged(idle);
    notices.stateChanged({ type: "starting" });
    vi.advanceTimersByTime(SAVED_NOTIFICATION_DELAY_MS);
    expect(first).not.toHaveBeenCalled();
    expect(logs).toContain("notification: frame rate downgrade dropped (recording state changed)");
    notices.stateChanged(recording);
    notices.hold("frame rate downgrade", second);
    notices.setQuitting(true);
    notices.stateChanged(idle);
    notices.hold("late", second);
    vi.advanceTimersByTime(SAVED_NOTIFICATION_DELAY_MS);
    expect(second).not.toHaveBeenCalled();
    expect(logs).toContain("notification: frame rate downgrade dropped (shutdown)");
  });

  it("keeps a throwing notice from stopping the next", () => {
    const { notices, logs } = setup();
    const next = vi.fn();
    notices.stateChanged(recording);
    notices.hold("resolution cap unconfirmed", () => { throw new Error("tray gone"); });
    notices.hold("frame rate downgrade", next);
    notices.stateChanged(idle);
    vi.advanceTimersByTime(SAVED_NOTIFICATION_DELAY_MS);
    expect(next).toHaveBeenCalledTimes(1);
    expect(logs).toContain("notification: resolution cap unconfirmed request failed (Error: tray gone)");
  });

  it("leaves no timer behind after dispose", () => {
    const { notices } = setup();
    const cap = vi.fn();
    notices.stateChanged(recording);
    notices.hold("resolution cap unconfirmed", cap);
    notices.stateChanged(idle);
    notices.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SAVED_NOTIFICATION_DELAY_MS);
    expect(cap).not.toHaveBeenCalled();
  });
});
