// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsGroup, SettingsView } from "../shared/settings-panel";

/** A running action keeps the focus it was activated with (plan 053), driven through the real page module. */
function view(checking: boolean): SettingsView {
  const groups: SettingsGroup[] = [
    { id: "notifications", label: "Notifications", tab: "general", control: "switch", enabled: true,
      choices: [{ id: "on", label: "On", enabled: true, checked: true }, { id: "off", label: "Off", enabled: true, checked: false }],
      actions: [{ id: "openSettings", label: "Open notification settings…", enabled: true, checked: false }] },
    { id: "updates", label: "Updates", tab: "general", kind: "actions", enabled: true, choices: [
      { id: "check", label: checking ? "Checking for updates…" : "Check for updates…", enabled: true, checked: false, ...(checking ? { busy: true } : {}) },
      { id: "unavailable", label: "Unavailable", enabled: false, checked: false }] },
  ];
  return {
    language: "en", title: "RecordStuff - Settings", hint: "", failure: "Could not apply this setting.",
    tabs: [{ id: "recording", label: "Recording" }, { id: "general", label: "General" }, { id: "failures", label: "Failures" }],
    groups, recordingResults: [],
  };
}

it("keeps a running action focusable, ignores its second activation and leaves focus on it", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<h1 id="title"></h1><div id="status"><p id="status-title"></p><p id="status-detail"></p><p id="hint"></p></div><p id="feedback"></p><form id="settings"></form>';
  let current = view(false);
  let push!: (next: SettingsView) => void;
  let finish: (() => void) | undefined;
  const choose = vi.fn(async (group: string) => {
    // Like main: a check answers at once and pushes its progress; the pane opens while the request waits.
    if (group === "updates") { current = view(true); push(current); return { view: current, applied: true }; }
    await new Promise<void>((resolve) => { finish = resolve; });
    return { view: current, applied: true };
  });
  window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: (cb) => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();

  const check = document.getElementById("setting-updates-check") as HTMLButtonElement;
  check.focus(); check.click();
  await vi.waitFor(() => expect(check.textContent).toBe("Checking for updates…"));
  expect(check.disabled).toBe(false);
  expect(check.getAttribute("aria-disabled")).toBe("true");
  expect(check.classList.contains("saving-disabled")).toBe(true);
  expect(document.activeElement).toBe(check);
  check.click();
  expect(choose).toHaveBeenCalledTimes(1);
  // A choice main does not offer is still natively disabled.
  expect((document.getElementById("setting-updates-unavailable") as HTMLButtonElement).disabled).toBe(true);
  current = view(false); push(current);
  expect(check.getAttribute("aria-disabled")).toBe("false");
  expect(check.classList.contains("saving-disabled")).toBe(false);
  expect(document.activeElement).toBe(check);

  // A button beside a switch waits for its request the same way; every other action is busy with it.
  const pane = document.getElementById("setting-notifications-openSettings") as HTMLButtonElement;
  pane.focus(); pane.click();
  await vi.waitFor(() => expect(pane.getAttribute("aria-disabled")).toBe("true"));
  expect(pane.disabled).toBe(false);
  expect(check.disabled).toBe(false);
  expect(check.getAttribute("aria-disabled")).toBe("true");
  pane.click(); check.click();
  expect(choose).toHaveBeenCalledTimes(2);
  finish!();
  await vi.waitFor(() => expect(pane.getAttribute("aria-disabled")).toBe("false"));
  expect(document.activeElement).toBe(pane);
});
