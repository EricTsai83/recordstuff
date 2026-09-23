import { describe, expect, it } from "vitest";
import {
  acceleratorToKeystroke,
  currentState,
  findAfter,
  keystrokeScript,
  lastStartIndex,
  lineTime,
  nextLogIndex,
  materialOpenArgs,
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
    // A digit must go out as a key code: `keystroke "1"` with shift held types
    // `!`, which never matches a shortcut Electron registered by key code.
    expect(keystrokeScript(acceleratorToKeystroke("CommandOrControl+Shift+1")!)).toBe(
      'tell application "System Events" to key code 18 using {command down, shift down}',
    );
    expect(keystrokeScript(acceleratorToKeystroke("CommandOrControl+Shift+R")!)).toBe(
      'tell application "System Events" to keystroke "r" using {command down, shift down}',
    );
    expect(acceleratorToKeystroke("F24")).toBeUndefined();
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

describe("shared capture setup", () => {
  it("does not skip the next event in a newline-terminated log", () => {
    for (const text of ["", "saved old.mp4\n", "saved old.mp4"]) {
      const lines = text.split(/\r?\n/);
      const from = nextLogIndex(lines);
      const updated = (text + (text && !text.endsWith("\n") ? "\n" : "") + "saved new.mp4\n").split(/\r?\n/);
      expect(findAfter(updated, from, /saved new/)?.index).toBe(from);
    }
  });

  it("opens the intended local material even with URL metacharacters in its path", () => {
    const args = materialOpenArgs("/tmp/test #1?/素材.html", "/tmp/profile with spaces");
    const url = new URL(args.find(a => a.startsWith("--app="))!.slice(6));
    expect(decodeURIComponent(url.pathname)).toBe("/tmp/test #1?/素材.html");
    expect(url.searchParams.get("auto")).toBe("1");
    expect(url.hash).toBe("");
    expect(args).toContain("--user-data-dir=/tmp/profile with spaces");
  });
});

it("types supported custom named keys and refuses keys without a macOS code", () => {
  for (const [key, code] of [["Space", 49], ["Left", 123], ["F12", 111], [";", 41]] as const) {
    expect(keystrokeScript(acceleratorToKeystroke(`Control+${key}`)!)).toBe(`tell application "System Events" to key code ${code} using {control down}`);
  }
  expect(acceleratorToKeystroke("Control+F24")).toBeUndefined();
});

it("uses only the most recent registration state after launch", () => {
  expect(registeredAccelerator([...LOG, "[t] hotkey: registered Control+Shift+K"])).toBe("Control+Shift+K");
  for (const state of ["disabled", "registration failed for Control+K", "suspended"]) {
    expect(registeredAccelerator([...LOG, `[t] hotkey: ${state}`])).toBeUndefined();
    expect(registeredAccelerator([...LOG, `[t] hotkey: ${state}`, "[t] hotkey: registered Control+K"])).toBe("Control+K");
  }
});
