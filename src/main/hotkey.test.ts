import { describe, expect, it, vi } from "vitest";
import { DEFAULT_HOTKEY, HOTKEY_PRESETS, describeAccelerator, isHotkeyAccelerator, isHotkeySettings } from "../shared/hotkey";
import { RecordingHotkey, type GlobalShortcutApi } from "./hotkey";

/**
 * A fake `globalShortcut` that remembers registrations, can refuse a
 * combination (another app owns it) or throw (invalid accelerator).
 */
function fakeShortcut(options: { refuse?: string[]; throwOn?: string[] } = {}) {
  const registered = new Map<string, () => void>();
  const api: GlobalShortcutApi = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (options.throwOn?.includes(accelerator)) throw new Error(`invalid accelerator ${accelerator}`);
      if (options.refuse?.includes(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      registered.delete(accelerator);
    }),
  };
  return { api, registered, press: (accelerator: string) => registered.get(accelerator)?.() };
}

function setup(fake = fakeShortcut()) {
  const logs: string[] = [];
  const onToggle = vi.fn();
  const hotkey = new RecordingHotkey({ globalShortcut: fake.api, onToggle, log: (m) => logs.push(m) });
  return { hotkey, fake, logs, onToggle };
}

const [DEFAULT_ACCELERATOR, SECOND] = HOTKEY_PRESETS;

describe("RecordingHotkey (plan 016)", () => {
  it("registers the default on apply and a press runs the tray's toggle action", () => {
    const { hotkey, fake, onToggle, logs } = setup();
    expect(hotkey.status).toEqual({ kind: "disabled" });
    expect(hotkey.apply(DEFAULT_HOTKEY)).toEqual({ kind: "registered", accelerator: DEFAULT_ACCELERATOR });
    expect([...fake.registered.keys()]).toEqual([DEFAULT_ACCELERATOR]);
    fake.press(DEFAULT_ACCELERATOR);
    fake.press(DEFAULT_ACCELERATOR);
    // The same function the tray click calls; Recorder.toggle() holds the guards.
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(logs).toEqual([
      `hotkey: registered ${DEFAULT_ACCELERATOR}`,
      `hotkey: ${DEFAULT_ACCELERATOR} pressed`,
      `hotkey: ${DEFAULT_ACCELERATOR} pressed`,
    ]);
  });

  it("changing the preset releases the old combination before registering the new one", () => {
    const { hotkey, fake } = setup();
    hotkey.apply(DEFAULT_HOTKEY);
    hotkey.apply({ enabled: true, accelerator: SECOND });
    expect([...fake.registered.keys()]).toEqual([SECOND]);
    expect(fake.api.unregister).toHaveBeenCalledExactlyOnceWith(DEFAULT_ACCELERATOR);
    expect(hotkey.status).toEqual({ kind: "registered", accelerator: SECOND });
  });

  it("disabling unregisters and leaves nothing active; re-enabling registers again", () => {
    const { hotkey, fake, onToggle } = setup();
    hotkey.apply(DEFAULT_HOTKEY);
    const callback = fake.registered.get(DEFAULT_ACCELERATOR);
    expect(hotkey.apply({ enabled: false, accelerator: DEFAULT_ACCELERATOR })).toEqual({ kind: "disabled" });
    expect(fake.registered.size).toBe(0);
    callback?.(); // a stale OS callback after unregister must not reach the recorder through us
    expect(onToggle).not.toHaveBeenCalled();
    hotkey.apply(DEFAULT_HOTKEY);
    expect(fake.registered.size).toBe(1);
  });

  it("reports a refused registration (conflict) instead of pretending it worked", () => {
    const { hotkey, fake, logs } = setup(fakeShortcut({ refuse: [DEFAULT_ACCELERATOR] }));
    const status = hotkey.apply(DEFAULT_HOTKEY);
    expect(status).toMatchObject({ kind: "failed", accelerator: DEFAULT_ACCELERATOR });
    expect(fake.registered.size).toBe(0);
    expect(logs.at(-1)).toMatch(new RegExp(`^hotkey: registration failed for ${DEFAULT_ACCELERATOR.replace(/\+/g, "\\+")}: `));
    // Nothing to unregister on the next apply: a failed accelerator is not held.
    hotkey.apply({ enabled: true, accelerator: SECOND });
    expect(fake.api.unregister).not.toHaveBeenCalled();
    expect(hotkey.status).toEqual({ kind: "registered", accelerator: SECOND });
  });

  it("a throwing register call becomes a failed status with the error text", () => {
    const { hotkey } = setup(fakeShortcut({ throwOn: [DEFAULT_ACCELERATOR] }));
    expect(hotkey.apply(DEFAULT_HOTKEY)).toEqual({
      kind: "failed",
      accelerator: DEFAULT_ACCELERATOR,
      reason: `invalid accelerator ${DEFAULT_ACCELERATOR}`,
    });
  });

  it("a change requested while a session runs is deferred and applied when the recorder settles (review F2)", () => {
    const { hotkey, fake, onToggle, logs } = setup();
    hotkey.apply(DEFAULT_HOTKEY);
    // The user picks another preset; the settings write is pending while the
    // old shortcut starts a recording. By the time the write lands, the
    // recorder is busy: the registration must not change under the session.
    expect(hotkey.request({ enabled: true, accelerator: SECOND }, false)).toEqual({ kind: "deferred" });
    expect([...fake.registered.keys()]).toEqual([DEFAULT_ACCELERATOR]);
    expect(hotkey.status).toEqual({ kind: "registered", accelerator: DEFAULT_ACCELERATOR });
    expect(logs.at(-1)).toContain("deferred until the recorder is settled");
    fake.press(DEFAULT_ACCELERATOR); // the stop press still reaches the recorder
    expect(onToggle).toHaveBeenCalledTimes(1);
    // Still recording / stopping: nothing happens.
    expect(hotkey.flush(false)).toBeUndefined();
    expect([...fake.registered.keys()]).toEqual([DEFAULT_ACCELERATOR]);
    // Back to idle: the saved choice becomes the live registration, once.
    expect(hotkey.flush(true)).toEqual({ kind: "registered", accelerator: SECOND });
    expect([...fake.registered.keys()]).toEqual([SECOND]);
    expect(hotkey.flush(true)).toBeUndefined();
  });

  it("request applies immediately when settled, and a later apply or dispose drops a pending change", () => {
    const { hotkey, fake } = setup();
    expect(hotkey.request(DEFAULT_HOTKEY, true)).toEqual({ kind: "registered", accelerator: DEFAULT_ACCELERATOR });
    hotkey.request({ enabled: false, accelerator: DEFAULT_ACCELERATOR }, false);
    hotkey.apply({ enabled: true, accelerator: SECOND }); // an explicit apply supersedes the pending request
    expect(hotkey.flush(true)).toBeUndefined();
    expect([...fake.registered.keys()]).toEqual([SECOND]);
    hotkey.request({ enabled: true, accelerator: DEFAULT_ACCELERATOR }, false);
    hotkey.dispose();
    expect(hotkey.flush(true)).toBeUndefined();
    expect(fake.registered.size).toBe(0);
  });

  it("dispose on quit unregisters and is idempotent", () => {
    const { hotkey, fake } = setup();
    hotkey.apply(DEFAULT_HOTKEY);
    hotkey.dispose();
    hotkey.dispose();
    expect(fake.registered.size).toBe(0);
    expect(fake.api.unregister).toHaveBeenCalledTimes(1);
    expect(hotkey.status).toEqual({ kind: "disabled" });
  });
});

describe("hotkey definitions", () => {
  it("validates supported accelerators with a boolean enabled flag", () => {
    expect(isHotkeySettings(DEFAULT_HOTKEY)).toBe(true);
    expect(isHotkeySettings({ enabled: false, accelerator: SECOND })).toBe(true);
    expect(isHotkeySettings({ enabled: "yes", accelerator: SECOND })).toBe(false);
    expect(isHotkeySettings({ enabled: true, accelerator: "Command+Q" })).toBe(false);
    expect(isHotkeySettings(null)).toBe(false);
  });

  /**
   * `isHotkeyAccelerator` rejects anything outside the preset list, and
   * `parseSettings` then falls back to the default. Dropping an accelerator
   * therefore silently resets everyone who had chosen it, so every value the
   * app has ever offered has to stay valid.
   */
  it("keeps every accelerator the app has ever offered valid", () => {
    for (const shipped of [
      "CommandOrControl+Alt+Shift+R",
      "CommandOrControl+Shift+R",
      "CommandOrControl+Alt+R",
      "CommandOrControl+Shift+1",
    ]) expect(isHotkeyAccelerator(shipped)).toBe(true);
    expect(DEFAULT_HOTKEY).toEqual({ enabled: true, accelerator: "CommandOrControl+Shift+1" });
  });

  it("describes accelerators with macOS symbols and Windows-style names elsewhere", () => {
    expect(describeAccelerator(DEFAULT_ACCELERATOR, "darwin")).toBe("⌘⇧1");
    expect(describeAccelerator(SECOND, "darwin")).toBe("⌘⌥⇧R");
    expect(describeAccelerator(DEFAULT_ACCELERATOR, "win32")).toBe("Ctrl+Shift+1");
    expect(describeAccelerator("Control+Alt+R", "linux")).toBe("Ctrl+Alt+R");
  });
});

it("suspends OS ownership, ignores stale callbacks and preserves deferred changes", () => {
  const { hotkey, fake, onToggle } = setup();
  hotkey.apply(DEFAULT_HOTKEY);
  const stale = fake.registered.get(DEFAULT_ACCELERATOR)!;
  hotkey.request({ enabled: true, accelerator: "Control+F12" }, false);
  hotkey.suspend();
  hotkey.suspend();
  expect(fake.registered.size).toBe(0);
  stale();
  expect(onToggle).not.toHaveBeenCalled();
  hotkey.resume();
  expect(fake.registered.has(DEFAULT_ACCELERATOR)).toBe(true);
  hotkey.flush(true);
  expect([...fake.registered.keys()]).toEqual(["Control+F12"]);
  hotkey.suspend();
  hotkey.apply({ enabled: true, accelerator: "Control+Left" });
  expect(fake.registered.size).toBe(0);
  hotkey.resume();
  expect([...fake.registered.keys()]).toEqual(["Control+Left"]);
  hotkey.suspend();
  hotkey.dispose();
  hotkey.resume();
  expect(fake.registered.size).toBe(0);
});

it("reports a new refusal, but not the same failed registration after cancelling capture", async () => {
  const { shouldNotifyHotkeyFailure } = await import("./hotkey");
  const { hotkey } = setup(fakeShortcut({ refuse: [DEFAULT_ACCELERATOR] }));
  const first = hotkey.apply(DEFAULT_HOTKEY);
  expect(shouldNotifyHotkeyFailure(undefined, first)).toBe(true);
  hotkey.suspend();
  expect(shouldNotifyHotkeyFailure(first, hotkey.resume())).toBe(false);
  expect(shouldNotifyHotkeyFailure(first, { kind: "failed", accelerator: "Control+K", reason: "in use" })).toBe(true);
  expect(shouldNotifyHotkeyFailure({ kind: "registered", accelerator: DEFAULT_ACCELERATOR }, first)).toBe(true);
});
