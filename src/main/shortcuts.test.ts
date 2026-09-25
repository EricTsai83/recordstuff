import { expect, it, vi } from "vitest";
import { DEFAULT_HOTKEY, SETTINGS_SHORTCUT, type HotkeySettings } from "../shared/hotkey";
import { AppShortcuts } from "./shortcuts";

function setup(refuse: string[] = []) {
  const registered = new Set<string>();
  const globalShortcut = {
    register: vi.fn((accelerator: string) => !refuse.includes(accelerator) && Boolean(registered.add(accelerator))),
    unregister: vi.fn((accelerator: string) => { registered.delete(accelerator); }),
  };
  let saved: HotkeySettings = { ...DEFAULT_HOTKEY };
  let settled = true;
  const store = { get hotkey() { return saved; }, setHotkey: vi.fn(async (setting: HotkeySettings) => { saved = setting; }) };
  const notifyRegistrationFailed = vi.fn();
  const shortcuts = new AppShortcuts({ globalShortcut, platform: "darwin", toggle: vi.fn(), openSettings: vi.fn(), store,
    settled: () => settled, notifyRegistrationFailed, notifyWriteFailed: vi.fn(), refresh: vi.fn(), log: vi.fn() });
  return { shortcuts, store, registered, notifyRegistrationFailed, unsettle: () => { settled = false; } };
}

it("reports a refused key once, not again on cancel, and again after an explicit save", async () => {
  const s = setup([DEFAULT_HOTKEY.accelerator]);
  s.shortcuts.start();
  expect([...s.registered]).toEqual([SETTINGS_SHORTCUT]);
  expect(s.shortcuts.registered).toBe(false);
  expect(s.notifyRegistrationFailed).toHaveBeenCalledTimes(1);
  s.shortcuts.capture(true);
  expect(s.registered.size).toBe(0);
  s.shortcuts.capture(false);
  expect([...s.registered]).toEqual([SETTINGS_SHORTCUT]);
  expect(s.notifyRegistrationFailed).toHaveBeenCalledTimes(1);
  await s.shortcuts.set(DEFAULT_HOTKEY);
  expect(s.notifyRegistrationFailed).toHaveBeenCalledTimes(2);
  s.shortcuts.dispose();
  expect(s.registered.size).toBe(0);
});

it("never writes the Settings combination or a change while a session is active", async () => {
  const s = setup();
  s.shortcuts.start();
  await s.shortcuts.set({ enabled: true, accelerator: "Alt+CommandOrControl+," });
  s.unsettle();
  await s.shortcuts.set({ enabled: true, accelerator: "Control+K" });
  expect(s.store.setHotkey).not.toHaveBeenCalled();
  expect([...s.registered].sort()).toEqual([DEFAULT_HOTKEY.accelerator, SETTINGS_SHORTCUT].sort());
});
