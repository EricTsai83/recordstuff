// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../shared/hotkey";
import { shortcutCandidate } from "./shortcut-capture";

it("arms only after main acknowledges, captures a combination, cancels and obeys recording lock", async () => {
  document.body.innerHTML = '<h1 id="title"></h1><p id="hint"></p><p id="feedback"></p><form id="settings"></form>';
  let current: SettingsView = {
    language: "en", title: "Settings", hint: "", failure: "Save failed",
    tabs: [{ id: "recording", label: "Recording" }, { id: "general", label: "General" }],
    groups: [{ id: "hotkey", label: "Shortcut", tab: "general", kind: "shortcut", platform: "darwin", enabled: true,
      choices: [{ id: DEFAULT_HOTKEY.accelerator, label: "Default", checked: true, enabled: true }] }],
  };
  let push!: (view: typeof current) => void;
  const capture = vi.fn(async (armed: boolean) => {
    current = structuredClone(current);
    current.groups.find(g => g.id === "hotkey")!.capturing = armed;
    return current;
  });
  let finishSave!: () => void;
  const choose = vi.fn(async () => {
    await new Promise<void>(resolve => { finishSave = resolve; });
    current = structuredClone(current);
    current.groups[0]!.capturing = false;
    current.groups[0]!.choices.push({ id: "Control+Alt+R", label: "⌃⌥R", enabled: true, checked: true });
    return { view: current, applied: true };
  });
  window.settings = { read: async () => current, capture, choose, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  const button = () => document.getElementById("shortcut-capture") as HTMLButtonElement;
  button().click();
  await vi.waitFor(() => expect(button().textContent).toBe("Press a combination"));
  button().dispatchEvent(new KeyboardEvent("keydown", { key: "R", code: "KeyR", bubbles: true }));
  expect(choose).not.toHaveBeenCalled();
  expect(document.getElementById("feedback")!.textContent).toContain("Command or Control");
  button().dispatchEvent(new KeyboardEvent("keydown", { key: "r", code: "KeyR", ctrlKey: true, altKey: true, bubbles: true }));
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("hotkey", "Control+Alt+R"));
  expect(button().disabled).toBe(false);
  expect(document.activeElement).toBe(button());
  expect(capture).not.toHaveBeenCalledWith(false);
  finishSave();
  await vi.waitFor(() => expect(button().textContent).toBe("Custom…"));
  expect(document.activeElement).toBe(button());
  button().click();
  await vi.waitFor(() => expect(button().textContent).toBe("Press a combination"));
  button().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  await vi.waitFor(() => expect(button().textContent).toBe("Custom…"));
  expect(choose).toHaveBeenCalledTimes(1);
  button().click();
  await vi.waitFor(() => expect(button().textContent).toBe("Press a combination"));
  const tab = new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true });
  button().dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false);
  document.getElementById("tab-general")!.focus();
  await vi.waitFor(() => expect(button().textContent).toBe("Custom…"));
  current = structuredClone(current);
  current.groups[0]!.enabled = false;
  push(current);
  expect(button().disabled).toBe(true);
});

it("uses physical letters/digits and named keys, with modifiers held separately", () => {
  const key = { key: "!", code: "Digit1", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };
  expect(shortcutCandidate(key)).toBe("CommandOrControl+Shift+1");
  expect(shortcutCandidate({ ...key, code: "KeyQ", key: "a" })).toBe("CommandOrControl+Shift+Q");
  expect(shortcutCandidate({ ...key, code: "ArrowLeft", key: "ArrowLeft" })).toBe("CommandOrControl+Shift+Left");
  expect(shortcutCandidate({ ...key, code: "MetaLeft", key: "Meta" })).toBeUndefined();
});

it("maps physical punctuation despite Option/Shift glyphs and rejects numpad aliases", () => {
  const key = { key: "…", code: "Semicolon", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false };
  expect(shortcutCandidate(key)).toBe("CommandOrControl+Alt+;");
  expect(shortcutCandidate({ ...key, code: "Backquote", key: "Dead" })).toBe("CommandOrControl+Alt+`");
  expect(shortcutCandidate({ ...key, code: "Slash", key: "?", shiftKey: true })).toBe("CommandOrControl+Alt+Shift+/");
  expect(shortcutCandidate({ ...key, code: "Numpad1", key: "1" })).toBe("CommandOrControl+Alt+Unsupported");
});

it("never turns a Windows/Linux Meta press into an unrelated Control shortcut", () => {
  const key = { key: "k", code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
  expect(shortcutCandidate(key, "darwin")).toBe("CommandOrControl+K");
  for (const platform of ["win32", "linux"]) {
    expect(shortcutCandidate(key, platform)).toBe("Unsupported");
    expect(shortcutCandidate({ ...key, metaKey: false, ctrlKey: true }, platform)).toBe("Control+K");
  }
});
