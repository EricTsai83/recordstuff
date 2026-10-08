// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { pick } from "../../testing/test-interactions";
import type { SettingsView } from "../../../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../../../shared/hotkey";

/** The Windows editor reports Ctrl as Control; the reserved combinations and their wording follow the platform (plan 064). */
it("refuses Ctrl+Q and a chord without Ctrl in Windows words, and offers the macOS screenshot chord", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<div id="root"></div>';
  const current: SettingsView = {
    language: "en", title: "Settings", hint: "", failure: "Could not apply this setting.",
    tabs: [{ id: "recording", label: "Recording" }, { id: "general", label: "General" }],
    groups: [{ id: "hotkey", label: "Shortcut", tab: "general", kind: "shortcut", platform: "win32", enabled: true,
      choices: [{ id: DEFAULT_HOTKEY.accelerator, label: "Default", checked: true, enabled: true }] }],
  };
  const capture = vi.fn(async (armed: boolean) => {
    current.groups[0]!.capturing = armed;
    return structuredClone(current);
  });
  const choose = vi.fn(async () => ({ view: structuredClone(current), applied: true }));
  window.settings = { read: async () => structuredClone(current), capture, choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  await pick("setting-hotkey", "custom");
  const field = () => document.getElementById("shortcut-capture") as HTMLButtonElement;
  await vi.waitFor(() => expect(field().textContent).toBe("Press a combination"));
  const error = () => document.querySelector(".save-error p")?.textContent;
  const confirm = () => document.getElementById("shortcut-confirm") as HTMLButtonElement;

  field().dispatchEvent(new KeyboardEvent("keydown", { key: "q", code: "KeyQ", ctrlKey: true, bubbles: true }));
  expect(error()).toBe("Other apps use this combination.");
  expect(confirm().disabled).toBe(true);
  field().dispatchEvent(new KeyboardEvent("keydown", { key: "r", code: "KeyR", altKey: true, shiftKey: true, bubbles: true }));
  expect(error()).toBe("A shortcut needs Ctrl.");
  // The Windows key is unusable; with Ctrl held the editor must not claim Ctrl is missing.
  field().dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: true, ctrlKey: true, bubbles: true }));
  expect(error()).toBe("This key cannot be used.");
  expect(field().textContent).toBe("Ctrl");

  // macOS keeps Command+Shift+3 for screenshots; Windows has no such chord, so Ctrl+Shift+3 is a choice.
  field().dispatchEvent(new KeyboardEvent("keydown", { key: "#", code: "Digit3", ctrlKey: true, shiftKey: true, bubbles: true }));
  expect(confirm().disabled).toBe(false);
  confirm().click();
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("hotkey", "Control+Shift+3"));
  expect(choose).toHaveBeenCalledTimes(1);
});
