// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../../shared/settings-panel";

/** Appearance is three icons, one click each (2026-10-05): a radio group named by its labels, drawn as marks. */
it("draws Appearance as three icon segments named by their labels, and a click chooses one", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const choices = (checked: string) => (["system", "light", "dark"] as const).map(id => ({ id, label: { system: "System default", light: "Light", dark: "Dark" }[id], enabled: true, checked: id === checked }));
  const view = (checked: string): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", tabs: [{ id: "general", label: "General" }],
    groups: [{ id: "appearance", label: "Appearance", tab: "general", control: "segmented", iconChoices: true, section: "display", enabled: true, choices: choices(checked) }] });
  let push!: (next: SettingsView) => void;
  const choose = vi.fn(async (_group: string, choice: unknown) => ({ view: view(String(choice)), applied: true }));
  window.settings = { read: async () => view("system"), capture: async () => view("system"), choose, ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("setting-appearance-dark")).toBeTruthy());
  const radios = [...document.querySelectorAll<HTMLInputElement>("#setting-appearance button")];
  // Each segment shows its mark and no words; its label names the radio and is its tooltip.
  expect(radios.map(radio => [radio.id, radio.getAttribute("aria-label"), radio.getAttribute("title"), Boolean(radio.querySelector("svg.segment-glyph")), radio.textContent, radio.getAttribute("aria-pressed") === "true"]))
    .toEqual([
      ["setting-appearance-system", "System default", "System default", true, "", true],
      ["setting-appearance-light", "Light", "Light", true, "", false],
      ["setting-appearance-dark", "Dark", "Dark", true, "", false],
    ]);
  expect(document.getElementById("setting-appearance")!.getAttribute("role")).toBe("group");
  const dark = document.getElementById("setting-appearance-dark") as HTMLInputElement;
  dark.click();
  expect(choose).toHaveBeenCalledWith("appearance", "dark");
  await vi.waitFor(() => expect(dark.getAttribute("aria-pressed")).toBe("true"));
  // A label that changes (another language) renames the segment without drawing words.
  push({ ...view("dark"), revision: 2, language: "zh-TW", groups: [{ ...view("dark").groups[0]!, choices: choices("dark").map(c => ({ ...c, label: { system: "跟隨系統", light: "淺色", dark: "深色" }[c.id]! })) }] });
  expect([dark.getAttribute("aria-label"), dark.getAttribute("title"), dark.textContent]).toEqual(["深色", "深色", ""]);
});
