import { describe, expect, it, vi } from "vitest";
import type { RecordingState } from "../../shared/state";
import { KeepAwake, type PowerBlocker } from "./keep-awake";

function setup(start: PowerBlocker["start"] = vi.fn(() => 7)) {
  const blocker = { start: vi.fn(start), stop: vi.fn() };
  const logs: string[] = [];
  return { keep: new KeepAwake(blocker, (message) => logs.push(message)), blocker, logs };
}

const busy: RecordingState[] = [
  { type: "starting" }, { type: "countdown", remaining: 3 }, { type: "recording", startedAt: "x" }, { type: "stopping" },
];

describe("KeepAwake (plan 050)", () => {
  it("holds one display blocker from starting through the session and releases it when idle", () => {
    const { keep, blocker, logs } = setup();
    for (const state of busy) keep.update(state, 0);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.start).toHaveBeenCalledWith("prevent-display-sleep");
    keep.update({ type: "idle" }, 0);
    expect(blocker.stop).toHaveBeenCalledWith(7);
    keep.update({ type: "idle" }, 0);
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(["power: keeping the display awake (blocker 7)", "power: display may sleep again (blocker 7)"]);
  });

  it("keeps the system, not the display, awake while a save outlasts its session, with no gap between the blockers", () => {
    let next = 1;
    const { keep, blocker, logs } = setup(() => next++);
    const order: string[] = [];
    blocker.start.mockImplementation((type) => { order.push(`start ${type}`); return next++; });
    blocker.stop.mockImplementation((id) => { order.push(`stop ${id}`); });
    keep.update({ type: "recording", startedAt: "x" }, 0);
    keep.update({ type: "idle" }, 1);
    keep.update({ type: "idle" }, 2);
    expect(order).toEqual(["start prevent-display-sleep", "start prevent-app-suspension", "stop 1"]);
    // The next recording starts while the last one is still saving: the display blocker covers both.
    keep.update({ type: "countdown", remaining: 3 }, 1);
    keep.update({ type: "idle" }, 0);
    expect(order.slice(3)).toEqual(["start prevent-display-sleep", "stop 2", "stop 3"]);
    expect(logs).toContain("power: keeping the system awake for a save (blocker 2)");
    expect(logs).toContain("power: system may sleep again (blocker 2)");
  });

  it("keeps the blocker it holds when its replacement cannot start, and tries the replacement again later", () => {
    const { keep, blocker, logs } = setup();
    keep.update({ type: "recording", startedAt: "x" }, 0);
    blocker.start.mockImplementationOnce(() => { throw new Error("denied"); });
    keep.update({ type: "idle" }, 1);
    expect(blocker.stop).not.toHaveBeenCalled();
    expect(logs.at(-1)).toBe("power: could not start prevent-app-suspension (Error: denied)");
    blocker.start.mockImplementationOnce(() => 8);
    keep.update({ type: "idle" }, 1);
    expect(blocker.start).toHaveBeenLastCalledWith("prevent-app-suspension");
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(7);
    keep.update({ type: "idle" }, 0);
    expect(blocker.stop).toHaveBeenLastCalledWith(8);
  });

  it("releases on needsPermission, a failed or cancelled start and dispose, and holds again for the next session", () => {
    const { keep, blocker } = setup();
    keep.update({ type: "starting" }, 0);
    keep.update({ type: "needsPermission", needsRelaunch: false }, 0);
    keep.update({ type: "countdown", remaining: 3 }, 0);
    keep.update({ type: "idle" }, 0);
    keep.update({ type: "recording", startedAt: "x" }, 0);
    keep.dispose();
    keep.dispose();
    expect(blocker.start).toHaveBeenCalledTimes(3);
    expect(blocker.stop).toHaveBeenCalledTimes(3);
  });

  it("logs a blocker that cannot start or stop and never throws into the caller", () => {
    const { keep, blocker, logs } = setup(() => { throw new Error("denied"); });
    expect(() => keep.update({ type: "starting" }, 0)).not.toThrow();
    expect(() => keep.update({ type: "idle" }, 0)).not.toThrow();
    expect(blocker.stop).not.toHaveBeenCalled();
    expect(logs).toEqual(["power: could not start prevent-display-sleep (Error: denied)"]);

    const failing = setup();
    failing.blocker.stop.mockImplementation(() => { throw new Error("gone"); });
    failing.keep.update({ type: "recording", startedAt: "x" }, 0);
    expect(() => failing.keep.update({ type: "idle" }, 0)).not.toThrow();
    expect(failing.logs.at(-1)).toBe("power: could not release blocker 7 (Error: gone)");
    failing.keep.update({ type: "idle" }, 0);
    expect(failing.blocker.stop).toHaveBeenCalledTimes(1);
  });
});
