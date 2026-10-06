// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../../shared/hotkey";
import { menuValue, pick } from "../testing/test-interactions";

/** Custom shortcut… in the menu opens the editor, and redraws while it listens leave it listening. */
it("opens the editor from Custom shortcut… and keeps listening through redraws", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<div id="root"></div>';
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
  window.settings = { read: async () => current, capture, choose: vi.fn(), ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  // The menu offers Custom shortcut…, and choosing it opens the editor without changing the shortcut it shows.
  await pick("setting-hotkey", "custom");
  await vi.waitFor(() => expect(document.getElementById("shortcut-capture")?.textContent).toBe("Press a combination"));
  expect(capture).toHaveBeenCalledWith(true);
  expect(menuValue("setting-hotkey")).toBe(DEFAULT_HOTKEY.accelerator);
  // Redraws while it listens leave the editor listening and the menu as it was.
  push(structuredClone(current));
  push(structuredClone(current));
  await Promise.resolve();
  expect([document.getElementById("shortcut-capture")?.textContent, menuValue("setting-hotkey")]).toEqual(["Press a combination", DEFAULT_HOTKEY.accelerator]);
});
