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
  it("holds one display blocker from starting through the save and releases it when idle", () => {
    const { keep, blocker, logs } = setup();
    for (const state of busy) keep.update(state);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.start).toHaveBeenCalledWith("prevent-display-sleep");
    keep.update({ type: "idle" });
    expect(blocker.stop).toHaveBeenCalledWith(7);
    keep.update({ type: "idle" });
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(["power: keeping the display awake (blocker 7)", "power: display may sleep again (blocker 7)"]);
  });

  it("releases on needsPermission, a failed or cancelled start and dispose, and holds again for the next session", () => {
    const { keep, blocker } = setup();
    keep.update({ type: "starting" });
    keep.update({ type: "needsPermission", needsRelaunch: false });
    keep.update({ type: "countdown", remaining: 3 });
    keep.update({ type: "idle" });
    keep.update({ type: "recording", startedAt: "x" });
    keep.dispose();
    keep.dispose();
    expect(blocker.start).toHaveBeenCalledTimes(3);
    expect(blocker.stop).toHaveBeenCalledTimes(3);
  });

  it("logs a blocker that cannot start or stop and never throws into the caller", () => {
    const { keep, blocker, logs } = setup(() => { throw new Error("denied"); });
    expect(() => keep.update({ type: "starting" })).not.toThrow();
    expect(() => keep.update({ type: "idle" })).not.toThrow();
    expect(blocker.stop).not.toHaveBeenCalled();
    expect(logs).toEqual(["power: could not keep the display awake (Error: denied)"]);

    const failing = setup();
    failing.blocker.stop.mockImplementation(() => { throw new Error("gone"); });
    failing.keep.update({ type: "recording", startedAt: "x" });
    expect(() => failing.keep.update({ type: "idle" })).not.toThrow();
    expect(failing.logs.at(-1)).toBe("power: could not release blocker 7 (Error: gone)");
    failing.keep.update({ type: "idle" });
    expect(failing.blocker.stop).toHaveBeenCalledTimes(1);
  });
});
