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
  const refresh = vi.fn();
  const shortcuts = new AppShortcuts({ globalShortcut, platform: "darwin", toggle: vi.fn(), openSettings: vi.fn(), store,
    settled: () => settled, notifyRegistrationFailed, notifyWriteFailed: vi.fn(), refresh, log: vi.fn() });
  return { shortcuts, store, registered, notifyRegistrationFailed, refresh, unsettle: () => { settled = false; } };
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


it("retries both refused registrations without rewriting preferences", () => {
  const refuse = [DEFAULT_HOTKEY.accelerator, SETTINGS_SHORTCUT];
  const s = setup(refuse);
  s.shortcuts.start();
  expect(s.registered.size).toBe(0);
  // Still refused: the caller must be able to say the retry did not help.
  expect(s.shortcuts.retry()).toBe(false);
  refuse.splice(1);
  expect(s.shortcuts.retry()).toBe(false);
  refuse.splice(0);
  expect(s.shortcuts.retry()).toBe(true);
  expect([...s.registered].sort()).toEqual([DEFAULT_HOTKEY.accelerator, SETTINGS_SHORTCUT].sort());
  expect(s.store.setHotkey).not.toHaveBeenCalled();
  s.shortcuts.dispose();
  s.unsettle();
  s.shortcuts.retry();
  expect(s.registered.size).toBe(0);
});

it("refreshes once per capture end or retry, after both shortcuts changed", () => {
  const s = setup();
  s.shortcuts.start();
  s.shortcuts.capture(true);
  s.refresh.mockClear();
  // Each push reads both shortcuts' final status: none may show the Settings key still suspended.
  s.refresh.mockImplementation(() => expect(s.shortcuts.settingsStatus.kind).not.toBe("suspended"));
  s.shortcuts.capture(false);
  expect(s.refresh).toHaveBeenCalledTimes(1);
  s.refresh.mockClear();
  s.shortcuts.retry();
  expect(s.refresh).toHaveBeenCalledTimes(1);
});
