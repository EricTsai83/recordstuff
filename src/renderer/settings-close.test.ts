// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../shared/hotkey";
import { isCloseChord, type ShortcutKey } from "./shortcut-capture";

const press = (key: string, code: string, modifiers: Partial<ShortcutKey> = {}): ShortcutKey =>
  ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });

it("recognizes only the platform's exact close chord", () => {
  expect(isCloseChord(press("w", "KeyW", { metaKey: true }), "darwin")).toBe(true);
  expect(isCloseChord(press("W", "KeyW", { metaKey: true }), "darwin")).toBe(true); // Caps Lock
  expect(isCloseChord(press("w", "KeyW", { ctrlKey: true }), "darwin")).toBe(false);
  expect(isCloseChord(press("W", "KeyW", { metaKey: true, shiftKey: true }), "darwin")).toBe(false);
  expect(isCloseChord(press("w", "KeyW", { metaKey: true, ctrlKey: true }), "darwin")).toBe(false);
  // Option changes the typed character on macOS; the modifier flag alone excludes it.
  expect(isCloseChord(press("∑", "KeyW", { metaKey: true, altKey: true }), "darwin")).toBe(false);
  for (const platform of ["win32", "linux"]) {
    expect(isCloseChord(press("w", "KeyW", { ctrlKey: true }), platform)).toBe(true);
    expect(isCloseChord(press("W", "KeyW", { ctrlKey: true }), platform)).toBe(true);
    expect(isCloseChord(press("w", "KeyW", { metaKey: true }), platform)).toBe(false);
    expect(isCloseChord(press("W", "KeyW", { ctrlKey: true, shiftKey: true }), platform)).toBe(false);
    expect(isCloseChord(press("w", "KeyW", { ctrlKey: true, altKey: true }), platform)).toBe(false);
  }
  // The typed letter decides, as native menus do; the physical key only where the layout types no Latin letter.
  expect(isCloseChord(press("w", "KeyZ", { metaKey: true }), "darwin")).toBe(true); // AZERTY W
  expect(isCloseChord(press("z", "KeyW", { metaKey: true }), "darwin")).toBe(false); // AZERTY Z
  expect(isCloseChord(press("ц", "KeyW", { metaKey: true }), "darwin")).toBe(true); // Russian
  expect(isCloseChord(press("Escape", "Escape", { metaKey: true }), "darwin")).toBe(false);
});

it("captures macOS Control+W as a shortcut while exact Command+W still closes", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
  document.body.innerHTML = '<h1 id="title"></h1><p id="hint"></p><p id="feedback"></p><form id="settings"></form>';
  let current: SettingsView = {
    language: "en", title: "Settings", hint: "", failure: "Save failed",
    tabs: [{ id: "recording", label: "Recording" }, { id: "general", label: "General" }],
    groups: [{ id: "hotkey", label: "Shortcut", tab: "general", kind: "shortcut", platform: "darwin", enabled: true,
      choices: [{ id: DEFAULT_HOTKEY.accelerator, label: "Default", checked: true, enabled: true }] }],
  };
  let push!: (view: SettingsView) => void;
  const capture = vi.fn(async (armed: boolean) => {
    current = structuredClone(current);
    current.groups[0]!.capturing = armed;
    return current;
  });
  const choose = vi.fn(async (_group: string, choice: string) => {
    current = structuredClone(current);
    current.groups[0]!.capturing = false;
    current.groups[0]!.choices = [{ id: DEFAULT_HOTKEY.accelerator, label: "Default", checked: false, enabled: true },
      { id: choice, label: `${choice} (custom)`, checked: true, enabled: true }];
    return { view: current, applied: true };
  });
  window.settings = { read: async () => current, capture, choose, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  const field = () => document.getElementById("shortcut-capture") as HTMLButtonElement;
  const arm = async () => {
    const select = document.getElementById("setting-hotkey") as HTMLSelectElement;
    select.value = "custom"; select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(field().textContent).toBe("Press a combination"));
  };
  const key = (target: EventTarget, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

  await arm();
  key(field(), { key: "w", code: "KeyW", ctrlKey: true });
  expect(close).not.toHaveBeenCalled();
  expect(field().textContent).toContain("⌃W");
  expect((document.getElementById("shortcut-confirm") as HTMLButtonElement).disabled).toBe(false);
  document.getElementById("shortcut-confirm")!.click();
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("hotkey", "Control+W"));
  await vi.waitFor(() => expect((document.getElementById("setting-hotkey") as HTMLSelectElement).value).toBe("Control+W"));

  // An extra modifier makes it an ordinary candidate, not a close.
  await arm();
  key(field(), { key: "W", code: "KeyW", metaKey: true, shiftKey: true });
  expect(close).not.toHaveBeenCalled();
  expect(field().textContent).toContain("⌘⇧W");
  key(field(), { key: "w", code: "KeyW", metaKey: true });
  expect(close).toHaveBeenCalledTimes(1);
  expect(choose).toHaveBeenCalledTimes(1);

  // Outside capture the page handles the platform close itself; macOS Control+W is not it.
  close.mockClear();
  key(document.getElementById("setting-hotkey")!, { key: "w", code: "KeyW", ctrlKey: true });
  expect(close).not.toHaveBeenCalled();
  key(document.getElementById("setting-hotkey")!, { key: "w", code: "KeyW", metaKey: true });
  expect(close).toHaveBeenCalledTimes(1);
  current = structuredClone(current);
  current.groups[0]!.platform = "win32";
  push(current);
  close.mockClear();
  key(document.getElementById("setting-hotkey")!, { key: "w", code: "KeyW", metaKey: true });
  expect(close).not.toHaveBeenCalled();
  key(document.getElementById("setting-hotkey")!, { key: "w", code: "KeyW", ctrlKey: true });
  expect(close).toHaveBeenCalledTimes(1);
});
