import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { NOTIFICATION_ACTIVATION_MS, watchReopen } from "./reopen";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(platform: string, open: () => Promise<boolean | void> = async () => undefined) {
  const events = new EventEmitter();
  const opened = vi.fn(open);
  const logs: string[] = [];
  let clock = 1000;
  const watcher = watchReopen({ events, platform, open: opened, log: (m) => logs.push(m), now: () => clock });
  return { events, opened, logs, watcher, advance: (ms: number) => { clock += ms; } };
}

describe("watchReopen", () => {
  it("opens Settings once per second launch", async () => {
    const { events, opened, logs } = setup("darwin");
    events.emit("second-instance", {}, ["RecordStuff"], "/");
    await flush();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(["reopen: second launch; Settings opened"]);
  });

  it("opens Settings on a macOS reopen, and listens for it only on macOS", async () => {
    const mac = setup("darwin");
    mac.events.emit("activate", {}, false);
    await flush();
    expect(mac.opened).toHaveBeenCalledTimes(1);
    expect(mac.logs).toEqual(["reopen: reopened from Finder or the Dock; Settings opened"]);
    const windows = setup("win32");
    expect(windows.events.listenerCount("activate")).toBe(0);
    windows.events.emit("second-instance");
    await flush();
    expect(windows.opened).toHaveBeenCalledTimes(1);
  });

  it("does not open for activation alone, such as a notification click", async () => {
    const { events, opened } = setup("darwin");
    events.emit("did-become-active");
    await flush();
    expect(opened).not.toHaveBeenCalled();
  });

  it("takes a reopen or second launch right after a notification click as the click's activation", async () => {
    const { events, opened, logs, watcher, advance } = setup("darwin");
    watcher.notificationClicked();
    advance(476);
    events.emit("second-instance");
    events.emit("activate");
    await flush();
    expect(opened).not.toHaveBeenCalled();
    expect(logs).toEqual([
      "reopen: second launch ignored 476 ms after a notification click",
      "reopen: reopened from Finder or the Dock ignored 476 ms after a notification click",
    ]);
    advance(NOTIFICATION_ACTIVATION_MS - 476);
    events.emit("activate");
    await flush();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("says when the quit gate refused, and when opening failed", async () => {
    const quitting = setup("darwin", async () => false);
    quitting.events.emit("second-instance");
    await flush();
    expect(quitting.logs).toEqual(["reopen: second launch ignored while quitting"]);
    const broken = setup("darwin", async () => { throw new Error("window gone"); });
    broken.events.emit("activate");
    await flush();
    expect(broken.logs).toEqual(["reopen: reopened from Finder or the Dock; Settings could not open: Error: window gone"]);
  });

  it("removes both listeners", () => {
    const { events, watcher } = setup("darwin");
    watcher.stop();
    expect(events.listenerCount("second-instance")).toBe(0);
    expect(events.listenerCount("activate")).toBe(0);
  });
});
