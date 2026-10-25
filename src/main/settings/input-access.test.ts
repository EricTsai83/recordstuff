import { describe, expect, it, vi } from "vitest";
import type { MicrophoneAccess } from "../permission/permission";
import { accessRefused, settleInputAccess, type InputAccess } from "./input-access";

const input = (name: string, status: MicrophoneAccess | undefined, { on = true } = {}) => {
  let enabled = on;
  const turnOff = vi.fn(async () => { enabled = false; return true; });
  const access: InputAccess = { name, enabled: () => enabled, status: () => status, turnOff };
  return { access, turnOff, enabled: () => enabled };
};

describe("settleInputAccess", () => {
  it("turns off an input that is on and that macOS refused, and says so in the log", async () => {
    const denied = input("microphone", "denied");
    const restricted = input("camera", "restricted");
    const lines: string[] = [];
    await settleInputAccess([denied.access, restricted.access], (line) => lines.push(line));
    expect([denied.enabled(), restricted.enabled()]).toEqual([false, false]);
    expect(lines).toEqual(["settings: microphone access is not allowed: turned off", "settings: camera access is not allowed: turned off"]);
  });

  it("asks nothing and leaves alone an input that is off, allowed, never asked, or has no answer to read", async () => {
    const inputs = [input("microphone", "denied", { on: false }), input("camera", "granted"), input("microphone", "not-determined"),
      input("camera", "unknown"), input("microphone", undefined)];
    await settleInputAccess(inputs.map((each) => each.access), () => {});
    for (const each of inputs) expect(each.turnOff).not.toHaveBeenCalled();
    expect(inputs.slice(1).every((each) => each.enabled())).toBe(true);
  });

  it("keeps going past an input whose save fails", async () => {
    const failing: InputAccess = { name: "microphone", enabled: () => true, status: () => "denied", turnOff: async () => { throw new Error("disk full"); } };
    const camera = input("camera", "denied");
    const lines: string[] = [];
    await settleInputAccess([failing, camera.access], (line) => lines.push(line));
    expect(camera.enabled()).toBe(false);
    expect(lines[0]).toBe("settings: settling microphone access failed: Error: disk full");
  });

  it("says so when a recording holds the switch, which stays on", async () => {
    const lines: string[] = [];
    await settleInputAccess([{ name: "camera", enabled: () => true, status: () => "denied", turnOff: async () => false }], (line) => lines.push(line));
    expect(lines).toEqual(["settings: camera access is not allowed: left out of the recording in progress"]);
  });
});

describe("accessRefused", () => {
  it("is only macOS's lasting refusals", () => {
    expect((["denied", "restricted", "granted", "not-determined", "unknown", undefined] as const).map(accessRefused))
      .toEqual([true, true, false, false, false, false]);
  });
});
