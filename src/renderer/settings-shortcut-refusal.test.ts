// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../shared/hotkey";

/** What the shortcut editor shows for a key it cannot use and for a combination main refuses. */
it("names no internal key for an unusable one, and states a refused combination once without reselect guidance", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<h1 id="title"></h1><p id="hint"></p><p id="feedback"></p><form id="settings"></form>';
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
  // Main releases capture and refuses the reserved Settings combination.
  const choose = vi.fn(async () => {
    current = structuredClone(current);
    current.groups[0]!.capturing = false;
    return { view: current, applied: false, failure: "This combination is reserved for Settings.", refused: true as const };
  });
  window.settings = { read: async () => current, capture, choose, onChanged: () => () => {} };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  const select = document.getElementById("setting-hotkey") as HTMLSelectElement;
  select.value = "custom"; select.dispatchEvent(new Event("change"));
  const field = () => document.getElementById("shortcut-capture") as HTMLButtonElement;
  await vi.waitFor(() => expect(field().textContent).toBe("Press a combination"));

  // A keypad key has no accelerator name: the preview keeps the held modifiers, never "Unsupported".
  field().dispatchEvent(new KeyboardEvent("keydown", { key: "1", code: "Numpad1", metaKey: true, altKey: true, bubbles: true }));
  expect([...field().querySelectorAll("kbd")].map(k => k.textContent)).toEqual(["⌘", "⌥"]);
  expect(field().getAttribute("aria-label") ?? "").not.toContain("Unsupported");
  expect(document.querySelector(".save-error strong")?.textContent).toBe("Shortcut unavailable");

  field().dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: true, altKey: true, bubbles: true }));
  const confirm = document.getElementById("shortcut-confirm") as HTMLButtonElement;
  confirm.click();
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("hotkey", "CommandOrControl+Alt+,"));
  const error = document.querySelector<HTMLElement>(".save-error")!;
  await vi.waitFor(() => expect(error.querySelector("p")?.textContent).toBe("This combination is reserved for Settings."));
  expect(error.hidden).toBe(false);
  expect(error.querySelector("strong")?.textContent).toBe("Shortcut unavailable");
  // Choosing the same combination again would fail the same way.
  expect(document.querySelector<HTMLElement>(".reselect")?.hidden).toBe(true);
  expect(document.querySelector<HTMLElement>(".retry")?.hidden).toBe(true);
});
