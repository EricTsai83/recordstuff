// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../../shared/hotkey";

/** A retry that works removes its own button; focus must return to the shortcut card, not the page. */
it("moves focus to the shortcut select when a successful registration retry removes its button", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<div id="root"></div>';
  const failed: SettingsView = {
    language: "en", title: "Settings", hint: "", failure: "Could not apply this setting.",
    tabs: [{ id: "recording", label: "Recording" }, { id: "general", label: "General" }],
    groups: [{ id: "hotkey", label: "Shortcut", tab: "general", kind: "shortcut", platform: "darwin", enabled: true,
      choices: [{ id: DEFAULT_HOTKEY.accelerator, label: "Default", checked: true, enabled: true }],
      actions: [{ id: "retryRegistration", label: "Retry shortcut registration", checked: false, enabled: true }] }],
  };
  const registered = structuredClone(failed);
  delete registered.groups[0]!.actions;
  const choose = vi.fn(async () => ({ view: registered, applied: true }));
  window.settings = { read: async () => failed, capture: async () => failed, choose, ready: async () => {}, onChanged: () => () => {} };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();

  const retry = document.getElementById("setting-hotkey-retryRegistration") as HTMLButtonElement;
  retry.focus(); retry.click();
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("hotkey", "retryRegistration"));
  await vi.waitFor(() => expect(document.getElementById("setting-hotkey-retryRegistration")).toBeNull());
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("setting-hotkey"));
});
