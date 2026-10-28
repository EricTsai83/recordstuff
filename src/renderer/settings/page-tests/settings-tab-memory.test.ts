// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../../../shared/settings-panel";

/**
 * A new window opens on the tab last shown (2026-10-26, the maintainer's request, as macOS's settings windows come
 * back to their last pane): the page keeps it in its storage, and a name it does not know opens on Recordings.
 */
it("opens on the tab last shown, and remembers each tab chosen", async () => {
  localStorage.setItem("recordstuff.settingsTab", "general");
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  document.body.innerHTML = '<div id="root"></div>';
  let revision = 1;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }, { id: "general", label: "General" }, { id: "shortcuts", label: "Keyboard Shortcuts" }], groups: [],
    library: { folder: "~/Movies", summary: "", items: [] } });
  window.settings = { read: async () => view(), capture: async () => view(), choose: async () => ({ view: view(), applied: true }), ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")?.getAttribute("aria-selected")).toBe("true"));
  document.getElementById("tab-shortcuts")!.click();
  await vi.waitFor(() => expect(document.getElementById("tab-shortcuts")?.getAttribute("aria-selected")).toBe("true"));
  expect(localStorage.getItem("recordstuff.settingsTab")).toBe("shortcuts");
});

it("never keeps the Recording Studio: the window opened on its own comes back to the page shown before it (2026-10-28)", async () => {
  vi.resetModules();
  localStorage.setItem("recordstuff.settingsTab", "general");
  const controller = await import("../settings-controller");
  controller.activateTab("studio");
  expect(controller.selectedTab).toBe("studio");
  expect(localStorage.getItem("recordstuff.settingsTab")).toBe("general");
});

it("opens on Recordings when the stored tab is not one", async () => {
  vi.resetModules();
  localStorage.setItem("recordstuff.settingsTab", "elsewhere");
  const { selectedTab } = await import("../settings-controller");
  expect(selectedTab).toBe("library");
});
