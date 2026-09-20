import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { command, finishRecording, waitForLog } from "./acceptance-runtime.mts";


describe("acceptance subprocess bounds", () => {
  it("cancels a running child even if it ignores SIGTERM", async () => {
    const controller = new AbortController();
    const pending = command(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], controller.signal);
    const assertion = expect(pending).rejects.toThrow();
    await delay(50);
    controller.abort();
    await assertion;
  });

  it("times out a stuck child and rejects command errors", async () => {
    await expect(command(process.execPath, ["-e", "setInterval(() => {}, 1000)"], new AbortController().signal, 100)).rejects.toThrow();
    await expect(command(process.execPath, ["-e", "process.exit(2)"], new AbortController().signal)).rejects.toThrow();
    await expect(command(process.execPath, ["-e", "process.exit(1)"], new AbortController().signal, 1000, [0, 1])).resolves.toBe("");
  });
});

describe("interrupted recording cleanup", () => {
  it("waits for the second recording to start, ignoring the first recording's idle and saved lines", async () => {
    const lines = ["[t] state → recording", "[t] saved old.mp4", "[t] state → idle", "[t] state → starting"];
    const stop = vi.fn(async () => { lines.push("[t] state → stopping"); });
    const pending = finishRecording({ read: () => lines, from: 3, stop, stopSent: false, signal: new AbortController().signal });
    await delay(200);
    expect(stop).not.toHaveBeenCalled();
    lines.push("[t] state → recording");
    await delay(200);
    expect(stop).toHaveBeenCalledTimes(1);
    lines.push("[t] saved new.mp4", "[t] state → idle");
    await delay(100);
    await expect(pending).resolves.toBe("new.mp4");
  });

  it("does not toggle again when stop was sent but its state transition has not arrived", async () => {
    const lines = ["[t] state → recording"];
    const stop = vi.fn();
    const pending = finishRecording({ read: () => lines, from: 0, stop, stopSent: true, signal: new AbortController().signal });
    await delay(200);
    expect(stop).not.toHaveBeenCalled();
    lines.push("[t] saved done.mp4", "[t] state → idle");
    await delay(100);
    await expect(pending).resolves.toBe("done.mp4");
  });

  it("waits for the saved line even when idle was logged first", async () => {
    const lines = ["[t] state → idle"];
    const stop = vi.fn();
    const pending = finishRecording({ read: () => lines, from: 0, stop, stopSent: true, signal: new AbortController().signal });
    await delay(150);
    lines.push("[t] saved final.mp4");
    await expect(pending).resolves.toBe("final.mp4");
    expect(stop).not.toHaveBeenCalled();
  });

  it("uses an independent cleanup signal and stops waiting when that budget expires", async () => {
    const controller = new AbortController();
    const pending = finishRecording({ read: () => ["[t] state → starting"], from: 0, stop: vi.fn(), stopSent: false, signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow();
    await delay(50);
    controller.abort();
    await assertion;
  });
});

describe("session log waits", () => {
  it("ignores a previous save and observes a newly appended event", async () => {
    const lines = ["[t] saved old.mp4", "[t] state → recording"];
    const pending = waitForLog(() => lines, 1, /saved /, "save", new AbortController().signal, 1000);
    lines.push("[t] saved new.mp4");
    await expect(pending).resolves.toEqual({ index: 2, line: "[t] saved new.mp4" });
  });

  it("bounds waiting with this session's diagnostic tail", async () => {
    await expect(waitForLog(() => ["old error", "new event"], 1, /saved /, "save", new AbortController().signal, 10))
      .rejects.toThrow("Log:\n  new event");
  });

  it("honours cancellation even when a matching event already exists", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(waitForLog(() => ["saved file.mp4"], 0, /saved /, "save", controller.signal)).rejects.toThrow("cancelled");
  });
});
