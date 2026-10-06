// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { pick } from "../testing/test-interactions";
import type { SettingsView } from "../../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../../shared/hotkey";

/** What the shortcut editor shows for a key it cannot use and for a combination main refuses. */
it("names no internal key for an unusable one, and states a refused combination once without reselect guidance", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<div id="root"></div>';
  let current: SettingsView = {
    language: "en", title: "Settings", hint: "", failure: "Could not apply this setting.",
    tabs: [{ id: "recording", label: "Recording" }, { id: "general", label: "General" }],
    groups: [{ id: "hotkey", label: "Shortcut", tab: "general", kind: "shortcut", platform: "darwin", enabled: true,
      choices: [{ id: DEFAULT_HOTKEY.accelerator, label: "Default", checked: true, enabled: true }] }],
  };
  const capture = vi.fn(async (armed: boolean) => {
    current = structuredClone(current);
    current.groups[0]!.capturing = armed;
    return current;
  });
  // Main releases capture and refuses the combination (its backstop for the reserved Settings one).
  const choose = vi.fn(async () => {
    current = structuredClone(current);
    current.groups[0]!.capturing = false;
    return { view: current, applied: false, failure: "This combination is reserved for opening RecordStuff.", refused: true as const };
  });
  let push!: (next: SettingsView) => void;
  window.settings = { read: async () => current, capture, choose, ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  const select = document.getElementById("setting-hotkey") as HTMLButtonElement;
  await pick("setting-hotkey", "custom");
  const field = () => document.getElementById("shortcut-capture") as HTMLButtonElement;
  await vi.waitFor(() => expect(field().textContent).toBe("Press a combination"));

  // A keypad key has no accelerator name: the preview keeps the held modifiers, never "Unsupported".
  field().dispatchEvent(new KeyboardEvent("keydown", { key: "1", code: "Numpad1", metaKey: true, altKey: true, bubbles: true }));
  expect([...field().querySelectorAll("kbd")].map(k => k.textContent)).toEqual(["⌥", "⌘"]);
  expect(field().getAttribute("aria-label") ?? "").not.toContain("Unsupported");
  expect(document.querySelector(".save-error strong")?.textContent).toBe("Shortcut unavailable");

  // The Settings shortcut is refused in the editor, like the other reserved combinations: it stays open to try another.
  field().dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: true, altKey: true, bubbles: true }));
  expect(document.querySelector(".save-error p")?.textContent).toBe("This combination is reserved for opening RecordStuff.");
  expect((document.getElementById("shortcut-confirm") as HTMLButtonElement).disabled).toBe(true);
  expect(current.groups[0]!.capturing).toBe(true);
  expect(choose).not.toHaveBeenCalled();

  field().dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: true, shiftKey: true, bubbles: true }));
  const confirm = document.getElementById("shortcut-confirm") as HTMLButtonElement;
  confirm.click();
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("hotkey", "CommandOrControl+Shift+K"));
  const error = document.querySelector<HTMLElement>(".save-error")!;
  await vi.waitFor(() => expect(error.querySelector("p")?.textContent).toBe("This combination is reserved for opening RecordStuff."));
  expect(error.hidden).toBe(false);
  expect(error.querySelector("strong")?.textContent).toBe("Shortcut unavailable");
  // Choosing the same combination again would fail the same way.
  expect(document.querySelector<HTMLElement>(".reselect")?.hidden).toBe(true);
  expect(document.querySelector<HTMLElement>(".retry")?.hidden).toBe(true);

  // A key the editor refused belongs to that editor: cancelling leaves no "Change was not saved" behind.
  await pick("setting-hotkey", "custom");
  await vi.waitFor(() => expect(field().textContent).toBe("Press a combination"));
  field().dispatchEvent(new KeyboardEvent("keydown", { key: "1", code: "Numpad1", metaKey: true, bubbles: true }));
  expect(error.hidden).toBe(false);
  expect(error.querySelector("strong")?.textContent).toBe("Shortcut unavailable");
  field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  await vi.waitFor(() => expect(current.groups[0]!.capturing).toBe(false));
  await vi.waitFor(() => expect(error.hidden).toBe(true));

  // A main-side expiry closes the editor without saving, clears its error and tells the focused user.
  for (const [language, message] of [
    ["en", "Editing ended; the shortcut is unchanged."],
    ["zh-TW", "已結束編輯，快捷鍵未變更。"],
  ] as const) {
    current = { ...structuredClone(current), language }; push(current);
    await pick("setting-hotkey", "custom");
    await vi.waitFor(() => expect(current.groups[0]!.capturing).toBe(true));
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "1", code: "Numpad1", metaKey: true, bubbles: true }));
    current = structuredClone(current); current.groups[0]!.capturing = false; push(current);
    expect(error.hidden).toBe(true);
    expect(document.getElementById("feedback")!.textContent).toBe(message);
    expect(document.activeElement).toBe(select);
    expect(choose).toHaveBeenCalledTimes(1);
  }
});
