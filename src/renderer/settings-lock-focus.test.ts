// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/settings-panel";

/** A recording that starts locks the control the keyboard is on; the tab keeps the place, as for a hidden one. */
function view(enabled: boolean): SettingsView {
  return {
    language: "en", title: "RecordStuff", hint: enabled ? "" : "Recording in progress; only language, appearance and icon click can change.", failure: "",
    tabs: [{ id: "recording", label: "Recording settings" }, { id: "general", label: "General" }],
    groups: [{ id: "videoQuality", label: "Video quality", tab: "recording", enabled,
      choices: [{ id: "standard", label: "Standard", enabled: true, checked: true }, { id: "high", label: "High", enabled: true, checked: false }] }],
  };
}

it("moves focus to the open tab when a push locks the focused control, so it never falls to the page", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<h1 id="title"></h1><div id="status"><p id="status-title"></p><p id="status-detail"></p><p id="hint"></p><button id="status-action" hidden></button></div><p id="feedback"></p><form id="settings"></form>';
  let push!: (next: SettingsView) => void;
  window.settings = { read: async () => view(true), capture: async () => view(true), choose: async () => ({ view: view(true), applied: true }), ready: async () => {},
    onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  const select = await vi.waitFor(() => { const el = document.getElementById("setting-videoQuality") as HTMLSelectElement | null; if (!el) throw new Error("not drawn"); return el; });
  select.focus();
  expect(document.activeElement).toBe(select);
  // Starting: the group is locked. Chromium would then drop focus to the page; happy-dom leaves it on the disabled select.
  push({ ...view(false), revision: 2 });
  expect(select.disabled).toBe(true);
  expect(document.activeElement?.id).toBe("tab-recording");
});
