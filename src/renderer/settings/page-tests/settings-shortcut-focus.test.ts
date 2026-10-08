// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { pick } from "../../testing/test-interactions";
import type { SettingsView } from "../../../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../../../shared/hotkey";

/**
 * Chromium clears the focused element before `focusout`, and a user-driven
 * focus move runs microtasks before the next element is focused, so the
 * editor must read where focus goes from `relatedTarget`.
 */
it("keeps a candidate when Tab or VoiceOver moves focus to Confirm, and ends capture when focus leaves the editor", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<div id="root"></div>';
  let current: SettingsView = {
    language: "en", title: "Settings", hint: "", failure: "Save failed",
    tabs: [{ id: "recording", label: "Recording" }, { id: "general", label: "General" }],
    groups: [{ id: "hotkey", label: "Shortcut", tab: "general", kind: "shortcut", platform: "darwin", enabled: true,
      choices: [{ id: DEFAULT_HOTKEY.accelerator, label: "Default", checked: true, enabled: true }] }],
  };
  const capture = vi.fn(async (armed: boolean) => {
    current = structuredClone(current);
    current.groups[0]!.capturing = armed;
    return current;
  });
  window.settings = { read: async () => current, capture, choose: vi.fn(), ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  const field = () => document.getElementById("shortcut-capture") as HTMLButtonElement;
  const confirm = () => document.getElementById("shortcut-confirm") as HTMLButtonElement;
  await pick("setting-hotkey", "custom");
  await vi.waitFor(() => expect(field().textContent).toBe("Press a combination"));
  field().focus();
  field().dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  expect(confirm().disabled).toBe(false);

  /** The focus-out of a real move: the body holds focus while the microtask runs. */
  const moveFocus = async (to: Element): Promise<void> => {
    const active = vi.spyOn(document, "activeElement", "get").mockReturnValue(document.body);
    field().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: to }));
    await Promise.resolve();
    active.mockRestore();
  };
  await moveFocus(confirm());
  expect(capture).not.toHaveBeenCalledWith(false);
  expect(confirm().disabled).toBe(false);

  await moveFocus(document.getElementById("tab-recording")!);
  await vi.waitFor(() => expect(capture).toHaveBeenLastCalledWith(false));
});
