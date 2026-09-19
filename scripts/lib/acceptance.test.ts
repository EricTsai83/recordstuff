import { describe, expect, it } from "vitest";
import {
  acceleratorToKeystroke,
  currentState,
  findAfter,
  keystrokeScript,
  lastStartIndex,
  lineTime,
  registeredAccelerator,
} from "./acceptance.mts";

const LOG = [
  "[2026-09-19T13:00:00.000Z] start: RecordStuff 0.1.2; …",
  "[2026-09-19T13:00:00.050Z] hotkey: registered CommandOrControl+Shift+R",
  "[2026-09-19T13:00:05.000Z] state → recording",
  "[2026-09-19T13:00:09.000Z] state → idle",
  "[2026-09-19T15:31:00.880Z] start: RecordStuff 0.1.2; …",
  "[2026-09-19T15:31:00.916Z] hotkey: registered CommandOrControl+Alt+Shift+R",
  "[2026-09-19T15:31:00.995Z] permission: granted and capture sees 2 screen(s)",
];

describe("acceptance helpers", () => {
  it("maps Electron accelerators to System Events keystrokes", () => {
    expect(acceleratorToKeystroke("CommandOrControl+Alt+Shift+R")).toEqual({
      key: "r",
      modifiers: ["command down", "option down", "shift down"],
    });
    expect(keystrokeScript(acceleratorToKeystroke("CommandOrControl+Shift+R")!)).toBe(
      'tell application "System Events" to keystroke "r" using {command down, shift down}',
    );
    expect(acceleratorToKeystroke("F13")).toBeUndefined();
    expect(acceleratorToKeystroke("Hyper+R")).toBeUndefined();
  });

  it("reads the registered accelerator and state of the current process only", () => {
    expect(lastStartIndex(LOG)).toBe(4);
    expect(registeredAccelerator(LOG)).toBe("CommandOrControl+Alt+Shift+R");
    expect(currentState(LOG)).toBeUndefined(); // idle since the last start
    expect(currentState(LOG.slice(0, 4))).toBe("idle");
    expect(registeredAccelerator([...LOG, "[t] start: x", "[t] hotkey: disabled"])).toBeUndefined();
    expect(registeredAccelerator([])).toBeUndefined();
  });

  it("finds events after an offset and parses line times", () => {
    const hit = findAfter(LOG, 4, /state → (\w+)/);
    expect(hit).toBeUndefined();
    const earlier = findAfter(LOG, 0, /state → (\w+)/);
    expect(earlier?.index).toBe(2);
    expect(earlier?.match[1]).toBe("recording");
    expect(lineTime(LOG[5]!)?.toISOString()).toBe("2026-09-19T15:31:00.916Z");
    expect(lineTime("no timestamp")).toBeUndefined();
  });
});
