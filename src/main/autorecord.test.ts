import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
import type { RecordingState } from "../shared/state";
import { MAX_AUTORECORD_SECONDS, parseAutoRecord, runAutoRecord, type AutoRecordDeps } from "./autorecord";
import type { RecorderEvent } from "./recorder";

describe("parseAutoRecord", () => {
  it("is ignored when packaged or absent", () => {
    expect(parseAutoRecord('{"seconds":30}', true)).toBeUndefined();
    expect(parseAutoRecord(undefined, false)).toBeUndefined();
    expect(parseAutoRecord("   ", false)).toBeUndefined();
  });

  it("merges a partial quality over the defaults, not over settings.json", () => {
    const result = parseAutoRecord('{"seconds":30,"quality":{"resolutionCap":"1440p","frameRate":60}}', false);
    expect(result).toEqual({
      ok: true,
      config: { seconds: 30, quality: { ...DEFAULT_QUALITY, resolutionCap: "1440p", frameRate: 60 }, countdown: 0 },
    });
    expect(parseAutoRecord('{"seconds":5}', false)).toEqual({ ok: true, config: { seconds: 5, quality: DEFAULT_QUALITY, countdown: 0 } });
  });

  it("uses no countdown unless the configuration names a supported one", () => {
    expect(parseAutoRecord('{"seconds":5,"countdown":10}', false)).toEqual({ ok: true, config: { seconds: 5, quality: DEFAULT_QUALITY, countdown: 10 } });
    expect(parseAutoRecord('{"seconds":5,"countdown":4}', false)).toEqual({ ok: false, error: "countdown: unsupported value 4" });
    expect(parseAutoRecord('{"seconds":5,"countdown":"3"}', false)).toMatchObject({ ok: false });
  });

  it("rejects bad JSON, bad seconds and unsupported quality values with a reason", () => {
    expect(parseAutoRecord("{seconds:30}", false)).toMatchObject({ ok: false, error: expect.stringContaining("not JSON") });
    expect(parseAutoRecord("[30]", false)).toMatchObject({ ok: false });
    expect(parseAutoRecord('{"seconds":0}', false)).toMatchObject({ ok: false, error: expect.stringContaining("seconds") });
    expect(parseAutoRecord(`{"seconds":${MAX_AUTORECORD_SECONDS + 1}}`, false)).toMatchObject({ ok: false });
    expect(parseAutoRecord('{"seconds":"30"}', false)).toMatchObject({ ok: false });
    expect(parseAutoRecord('{"seconds":30,"quality":{"frameRate":24}}', false)).toMatchObject({
      ok: false,
      error: "quality.frameRate: unsupported value 24",
    });
    expect(parseAutoRecord('{"seconds":30,"quality":{"bitrate":1}}', false)).toMatchObject({ ok: false, error: "quality.bitrate: unknown key" });
    expect(parseAutoRecord('{"seconds":30,"quality":"high"}', false)).toMatchObject({ ok: false });
  });
});

interface Harness {
  deps: AutoRecordDeps;
  emit: (event: RecorderEvent) => void;
  timers: { fn: () => void; ms: number }[];
  calls: string[];
  logs: string[];
  state: RecordingState;
}

function harness(initial: RecordingState = { type: "idle" }): Harness {
  const listeners = new Set<(event: RecorderEvent) => void>();
  const h: Harness = {
    timers: [],
    calls: [],
    logs: [],
    state: initial,
    emit: (event) => {
      if (event.type === "state") h.state = event.state;
      for (const listener of listeners) listener(event);
    },
    deps: {
      state: () => h.state,
      toggle: () => h.calls.push("toggle"),
      stop: () => h.calls.push("stop"),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      quit: () => h.calls.push("quit"),
      log: (message) => h.logs.push(message),
      setTimeout: (fn, ms) => h.timers.push({ fn, ms }),
    },
  };
  return h;
}

const config = { seconds: 30, quality: DEFAULT_QUALITY, countdown: 0 as const };

describe("runAutoRecord", () => {
  it("ends the run when its countdown is cancelled, so no later recording inherits its stop timer", () => {
    const h = harness();
    runAutoRecord({ ...config, countdown: 3 }, h.deps);
    h.timers.shift()!.fn();
    h.emit({ type: "state", state: { type: "countdown", remaining: 3 } });
    h.emit({ type: "state", state: { type: "idle" } });
    h.emit({ type: "cancelled", reason: "toggle", session: { id: "s1" } });
    expect(h.calls).toEqual(["toggle", "quit"]);
    expect(h.logs.at(-1)).toBe("autorecord: cancelled (toggle); nothing was recorded");
    // A manual recording afterwards is not stopped by the finished run.
    h.emit({ type: "state", state: { type: "recording", startedAt: "2026-09-26T00:00:00Z" } });
    expect(h.timers).toHaveLength(0);
  });

  it("waits through a named countdown and schedules the stop only once recording", () => {
    const h = harness();
    runAutoRecord({ ...config, countdown: 3 }, h.deps);
    h.timers.shift()!.fn();
    expect(h.calls).toEqual(["toggle"]);
    for (const remaining of [3, 2, 1]) h.emit({ type: "state", state: { type: "countdown", remaining } });
    expect(h.timers).toHaveLength(0);
    h.emit({ type: "state", state: { type: "recording", startedAt: "2026-09-26T00:00:00Z" } });
    expect(h.timers.map((timer) => timer.ms)).toEqual([30_000]);
    expect(h.logs[0]).toContain("countdown 3 s");
  });

  it("starts after the delay, stops after `seconds` of recording and quits once saved", () => {
    const h = harness();
    runAutoRecord(config, h.deps);
    expect(h.calls).toEqual([]);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.ms).toBe(1500);
    h.timers[0]?.fn();
    expect(h.calls).toEqual(["toggle"]);
    h.emit({ type: "state", state: { type: "starting" } });
    h.emit({ type: "state", state: { type: "recording", startedAt: "t" } });
    expect(h.timers).toHaveLength(2);
    expect(h.timers[1]?.ms).toBe(30_000);
    h.timers[1]?.fn();
    expect(h.calls).toEqual(["toggle", "stop"]);
    h.emit({ type: "state", state: { type: "stopping" } });
    h.emit({ type: "state", state: { type: "idle", lastSavedPath: "/x/a.mp4" } });
    h.emit({ type: "saved", path: "/x/a.mp4", session: { id: "s1" } });
    expect(h.calls).toEqual(["toggle", "stop", "quit"]);
    expect(h.logs.at(-1)).toBe("autorecord: saved /x/a.mp4");
  });

  it("quits with a logged reason when the recording fails or permission is missing", () => {
    const failing = harness();
    runAutoRecord(config, failing.deps);
    failing.timers[0]?.fn();
    failing.emit({ type: "state", state: { type: "starting" } });
    failing.emit({ type: "state", state: { type: "idle" } });
    failing.emit({ type: "failed", code: "no_audio_track", detail: "ended", partialPath: "/x/a.recording.mp4", outcome: "partial", session: { id: "s1" } });
    expect(failing.calls).toEqual(["toggle", "quit"]);
    expect(failing.logs.at(-1)).toBe("autorecord: failed: no_audio_track ended (kept /x/a.recording.mp4)");

    const denied = harness({ type: "needsPermission", needsRelaunch: false });
    runAutoRecord(config, denied.deps);
    denied.timers[0]?.fn();
    expect(denied.calls).toEqual(["quit"]);
    expect(denied.logs.at(-1)).toContain("cannot start from state needsPermission");
  });

  it("a session that ends without permission reports its own saved result", () => {
    const h = harness();
    runAutoRecord(config, h.deps);
    h.timers[0]?.fn();
    h.emit({ type: "state", state: { type: "recording", startedAt: "t" } });
    h.timers[1]?.fn();
    h.emit({ type: "state", state: { type: "needsPermission", needsRelaunch: false, lastSavedPath: "/x/a.mp4" } });
    h.emit({ type: "saved", path: "/x/a.mp4", session: { id: "s1" } });
    expect(h.calls).toEqual(["toggle", "stop", "quit"]);
    expect(h.logs.at(-1)).toBe("autorecord: saved /x/a.mp4");
  });

  it("does not press stop or quit twice", () => {
    const h = harness();
    runAutoRecord(config, h.deps);
    h.timers[0]?.fn();
    h.emit({ type: "state", state: { type: "recording", startedAt: "t" } });
    h.emit({ type: "failed", code: "capture_failed", detail: "x", outcome: "empty", session: { id: "s1" } });
    h.timers[1]?.fn(); // the stop timer fires after the failure
    h.emit({ type: "saved", path: "/late.mp4", session: { id: "s2" } });
    expect(h.calls).toEqual(["toggle", "quit"]);
  });
});
