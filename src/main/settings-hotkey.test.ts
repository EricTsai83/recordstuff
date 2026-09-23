import { describe, expect, it, vi } from "vitest";
import { SettingsHotkey } from "./settings-hotkey";
import { RecordingHotkey } from "./hotkey";
import { DEFAULT_HOTKEY, SETTINGS_SHORTCUT, isSettingsShortcut } from "../shared/hotkey";

function setup(register = vi.fn(() => true)) {
  const api = { register, unregister: vi.fn() };
  const open = vi.fn();
  const log = vi.fn();
  const key = new SettingsHotkey({ globalShortcut: api, platform: "darwin", open, log });
  return { api, key, open, log };
}
describe("Settings shortcut ownership", () => {
  it("opens through its callback, keeps recording independent and releases only its own key", () => {
    const s = setup();
    const toggle = vi.fn();
    const recording = new RecordingHotkey({ globalShortcut: s.api, onToggle: toggle });
    recording.apply(DEFAULT_HOTKEY);
    s.key.reconcile(DEFAULT_HOTKEY);
    const callback = (s.api.register.mock.calls as unknown as [string, () => void][])[1]![1];
    callback(); callback();
    expect(s.open).toHaveBeenCalledTimes(2);
    expect(toggle).not.toHaveBeenCalled();
    recording.apply({ ...DEFAULT_HOTKEY, enabled: false });
    s.key.reconcile({ ...DEFAULT_HOTKEY, enabled: false });
    expect(s.key.status.kind).toBe("registered");
    s.key.dispose(); callback();
    expect(s.open).toHaveBeenCalledTimes(2);
    expect(s.api.unregister).toHaveBeenLastCalledWith(SETTINGS_SHORTCUT);
  });
  it.each([false, "throw"])("surfaces refusal %s without retrying on refresh", result => {
    const s = setup(vi.fn(() => { if (result === "throw") throw Error("OS refusal"); return false; }));
    s.key.reconcile(DEFAULT_HOTKEY); s.key.reconcile(DEFAULT_HOTKEY);
    expect(s.key.status.kind).toBe("failed");
    expect(s.api.register).toHaveBeenCalledTimes(1);
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining("registration failed"));
    s.key.dispose(); expect(s.api.unregister).not.toHaveBeenCalled();
  });
  it("preserves a stored equivalent recording key and recovers after changing it", () => {
    const s = setup();
    s.key.reconcile({ enabled: true, accelerator: "Alt+CommandOrControl+," });
    expect(s.key.status.kind).toBe("conflict");
    expect(s.api.register).not.toHaveBeenCalled();
    s.key.suspend(); s.key.reconcile(DEFAULT_HOTKEY);
    expect(s.api.register).not.toHaveBeenCalled();
    s.key.resume(); expect(s.key.status.kind).toBe("registered");
    s.key.suspend(); s.key.resume();
    expect(s.api.register).toHaveBeenCalledTimes(2);
  });
  it("resolves platform equivalents without conflating Control and Command on Mac", () => {
    expect(isSettingsShortcut("Control+Alt+,", "win32")).toBe(true);
    expect(isSettingsShortcut("Control+Alt+,", "darwin")).toBe(false);
    expect(isSettingsShortcut("Alt+CommandOrControl+,", "darwin")).toBe(true);
    expect(isSettingsShortcut("CommandOrControl+Alt+<", "darwin")).toBe(false);
  });
});
