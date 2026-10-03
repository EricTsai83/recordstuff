// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../shared/hotkey";

it("shows and announces timeout, restores focus, translates and clears it on a new edit", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<h1 id="title"></h1><div id="status"><p id="status-title"></p><p id="status-detail"></p><p id="hint"></p></div><p id="feedback" class="visually-hidden"></p><form id="settings"></form>';
  let current: SettingsView = {
    language: "en", title: "Settings", hint: "", failure: "Save failed",
    tabs: [{ id: "general", label: "General" }],
    groups: [{ id: "hotkey", label: "Shortcut", tab: "general", kind: "shortcut", platform: "darwin", enabled: true,
      choices: [{ id: DEFAULT_HOTKEY.accelerator, label: "Default", checked: true, enabled: true }] }],
  };
  let push!: (next: SettingsView) => void;
  window.settings = { read: async () => current, choose: vi.fn(),
    capture: async armed => {
      current = structuredClone(current);
      current.groups[0]!.capturing = armed;
      delete current.groups[0]!.captureTimedOut;
      return current;
    }, ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  await vi.waitFor(() => expect(document.getElementById("setting-hotkey")).toBeTruthy());
  const select = document.getElementById("setting-hotkey") as HTMLSelectElement;
  const open = async () => {
    select.value = "custom"; select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(current.groups[0]!.capturing).toBe(true));
    await vi.waitFor(() => expect(document.activeElement?.id).toBe("shortcut-capture"));
  };
  await open();
  const help = document.querySelector<HTMLElement>(".capture-help")!;
  expect(help.textContent).toContain("15 seconds");
  // The time limit reaches a screen reader through the field's description, and leaves it with the editor.
  expect(document.getElementById("shortcut-capture")!.getAttribute("aria-describedby")).toContain(help.id);
  current = structuredClone(current);
  current.groups[0]!.capturing = false;
  current.groups[0]!.captureTimedOut = true;
  push(current);
  const timeout = document.querySelector<HTMLElement>(".capture-timeout")!;
  expect(timeout.hidden).toBe(false);
  expect(timeout.textContent).toContain("Timed out after 15 seconds");
  expect(document.getElementById("feedback")?.textContent).toBe(timeout.textContent);
  expect(document.activeElement).toBe(select);
  expect(select.getAttribute("aria-describedby")).toContain(timeout.id);
  expect(select.getAttribute("aria-describedby")).not.toContain(help.id);
  current = { ...current, language: "zh-TW" }; push(current);
  expect(timeout.textContent).toContain("已超過 15 秒");
  await open();
  expect(timeout.hidden).toBe(true);
  expect(timeout.textContent).toBe("");
});
