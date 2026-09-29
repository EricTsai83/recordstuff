// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../shared/hotkey";

/** The failures entry switches tabs like a click: an open shortcut editor must end, or main keeps both shortcuts suspended. */
it("ends shortcut capture when a failures entry selects the failures tab", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<h1 id="title"></h1><p id="hint"></p><p id="feedback"></p><form id="settings"></form>';
  let current: SettingsView = {
    language: "en", title: "Settings", hint: "", failure: "Save failed",
    tabs: [{ id: "recording", label: "Recording" }, { id: "general", label: "General" }, { id: "failures", label: "Failures" }],
    groups: [{ id: "hotkey", label: "Shortcut", tab: "general", kind: "shortcut", platform: "darwin", enabled: true,
      choices: [{ id: DEFAULT_HOTKEY.accelerator, label: "Default", checked: true, enabled: true }] }],
  };
  let push!: (view: SettingsView) => void;
  const capture = vi.fn(async (armed: boolean) => {
    current = structuredClone(current);
    current.groups[0]!.capturing = armed;
    return current;
  });
  window.settings = { read: async () => current, capture, choose: vi.fn(), onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  const select = document.getElementById("setting-hotkey") as HTMLSelectElement;
  select.value = "custom"; select.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(document.getElementById("shortcut-capture")?.textContent).toBe("Press a combination"));

  push({ ...structuredClone(current), resultFocus: 1 });
  expect(document.querySelector('[role="tab"][aria-selected="true"]')!.id).toBe("tab-failures");
  expect(capture).toHaveBeenLastCalledWith(false);
});
