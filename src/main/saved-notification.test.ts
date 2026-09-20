import { afterEach, describe, expect, it, vi } from "vitest";
import { SavedNotification, SAVED_NOTIFICATION_DELAY_MS } from "./saved-notification";

function setup(platform = "darwin") {
  vi.useFakeTimers();
  const show = vi.fn();
  const log = vi.fn();
  return { notification: new SavedNotification({ platform, show, log }), show, log };
}

afterEach(() => vi.useRealTimers());

describe("saved notification lifecycle", () => {
  it("returns immediately and requests exactly once after the macOS delay, without revealing a file", () => {
    const { notification, show } = setup();
    notification.schedule("/saved.mp4");
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVED_NOTIFICATION_DELAY_MS - 1);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledExactlyOnceWith("/saved.mp4");
    vi.runAllTimers();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("cancels an old save before a new capture and does not resurrect it when idle", () => {
    const { notification, show, log } = setup();
    notification.schedule("/old.mp4");
    vi.advanceTimersByTime(SAVED_NOTIFICATION_DELAY_MS - 1);
    notification.stateChanged({ type: "starting" });
    vi.runAllTimers();
    notification.stateChanged({ type: "idle" });
    vi.runAllTimers();
    expect(show).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("saved cancelled"));
    notification.schedule("/new.mp4");
    vi.runAllTimers();
    expect(show).toHaveBeenCalledExactlyOnceWith("/new.mp4");
  });

  it("prioritizes permission recovery over an old pending save", () => {
    const { notification, show } = setup();
    notification.schedule("/saved.mp4");
    notification.stateChanged({ type: "needsPermission", needsRelaunch: false });
    notification.stateChanged({ type: "idle" });
    vi.runAllTimers();
    expect(show).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a save received during capture", () => {
    const { notification, show } = setup();
    notification.stateChanged({ type: "starting" });
    notification.schedule("/old.mp4");
    vi.runAllTimers();
    expect(show).not.toHaveBeenCalled();
  });

  it("cancels pending work on exit and drops saves finalized during shutdown", () => {
    const { notification, show } = setup();
    notification.schedule("/old.mp4");
    notification.dispose();
    notification.dispose();
    notification.stateChanged({ type: "idle" });
    notification.schedule("/shutdown.mp4");
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(show).not.toHaveBeenCalled();
  });

  it("bounds pending work to one timer", () => {
    const { notification, show } = setup();
    notification.schedule("/old.mp4");
    notification.schedule("/new.mp4");
    expect(vi.getTimerCount()).toBe(1);
    vi.runAllTimers();
    expect(show).toHaveBeenCalledExactlyOnceWith("/new.mp4");
  });

  it.each(["darwin", "win32", "linux"])("contains notification errors on %s without retries", (platform) => {
    const { notification, show, log } = setup(platform);
    show.mockImplementation(() => { throw new Error("OS rejected notification"); });
    expect(() => { notification.schedule("/saved.mp4"); vi.runAllTimers(); }).not.toThrow();
    expect(show).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("saved request failed"));
  });

  it.each(["win32", "linux"])("preserves immediate delivery on %s", (platform) => {
    const { notification, show } = setup(platform);
    notification.schedule("/saved.mp4");
    expect(show).toHaveBeenCalledExactlyOnceWith("/saved.mp4");
    expect(vi.getTimerCount()).toBe(0);
  });
});
