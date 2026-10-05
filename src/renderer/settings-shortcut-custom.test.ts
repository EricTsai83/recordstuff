// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../shared/hotkey";

/** Custom shortcut… waits while the editor listens, and its disabled flag is written once, not again on every draw. */
it("keeps Custom shortcut… disabled while listening without rewriting it on each redraw", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<h1 id="title"></h1><div id="status"><p id="status-title"></p><p id="status-detail"></p><p id="hint"></p></div><p id="feedback"></p><form id="settings"></form>';
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
  const select = document.getElementById("setting-hotkey") as HTMLSelectElement;
  const custom = select.querySelector<HTMLOptionElement>('option[value="custom"]')!;
  expect(custom.disabled).toBe(false);
  select.value = "custom"; select.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(document.getElementById("shortcut-capture")?.textContent).toBe("Press a combination"));
  expect(custom.disabled).toBe(true);

  const flips: Array<string | null> = [];
  const observer = new MutationObserver(records => { for (const record of records) flips.push(record.attributeName); });
  observer.observe(custom, { attributes: true, attributeFilter: ["disabled"] });
  push(structuredClone(current));
  push(structuredClone(current));
  await Promise.resolve();
  observer.disconnect();
  expect([flips, custom.disabled]).toEqual([[], true]);
});
