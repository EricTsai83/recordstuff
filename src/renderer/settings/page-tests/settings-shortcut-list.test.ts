// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsGroup, SettingsView } from "../../../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../../../shared/hotkey";

const list = (category: string, label: string, shortcuts: NonNullable<SettingsGroup["shortcuts"]>): SettingsGroup => ({
  id: `shortcutList:${category}`, label, tab: "shortcuts", kind: "shortcutList", section: `shortcutList:${category}`,
  sectionHeading: label, enabled: true, choices: [], shortcuts,
});
const view = (language: "en" | "zh-TW"): SettingsView => ({
  language, title: "RecordStuff", hint: "", failure: "Save failed",
  tabs: [{ id: "library", label: "Recordings" }, { id: "general", label: "General" },
    { id: "shortcuts", label: language === "en" ? "Keyboard Shortcuts" : "鍵盤快捷鍵" }, { id: "failures", label: "Troubleshooting" }],
  groups: [
    { id: "hotkey", label: "Shortcut", tab: "general", kind: "shortcut", platform: "darwin", enabled: true,
      choices: [{ id: DEFAULT_HOTKEY.accelerator, label: "Recommended: ⇧⌘1", checked: true, enabled: true }] },
    list("global", "Anywhere", [
      { id: "record", label: "Start or stop recording", keys: [["⇧", "⌘", "1"]], spoken: ["⇧⌘1"], change: "Change in General" },
      { id: "open", label: "Open RecordStuff", keys: [["⌥", "⌘", ","]], spoken: ["⌥⌘,"],
        status: { kind: "unavailable", label: "Unavailable", reason: "Another app may be using ⌥⌘,." } },
    ]),
    list("fullScreen", "Full-screen video", [
      { id: "leaveFullScreen", label: "Leave full screen", keys: [["Esc"], ["⌘", "W"]], spoken: ["Esc", "⌘W"], gesture: "Double-click" },
    ]),
  ],
});

it("lists the shortcuts read-only on their own tab, says each one's keys in words, and sends Change… to the Shortcut card", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<div id="root"></div>';
  let push!: (next: SettingsView) => void;
  const choose = vi.fn();
  window.settings = { read: async () => view("en"), capture: vi.fn(), choose, ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("../settings");
  await vi.waitFor(() => expect(document.getElementById("tab-shortcuts")).toBeTruthy());

  // Help → Keyboard Shortcuts names the tab.
  push({ ...view("en"), resultFocus: 1, entryTab: "shortcuts" });
  expect(document.querySelector('[role="tab"][aria-selected="true"]')!.id).toBe("tab-shortcuts");
  expect(document.activeElement?.id).toBe("tab-shortcuts");

  const headings = [...document.querySelectorAll("#settings-panel h2")].filter((h) => !(h as HTMLElement).hidden).map((h) => h.textContent);
  expect(headings).toEqual(["Anywhere", "Full-screen video"]);
  expect(document.getElementById("shortcut-record-label")!.textContent).toBe("Start or stop recording");
  // Symbols are drawn for sight and said once as a phrase; a gesture is one more alternative.
  expect(document.getElementById("shortcut-record-keys")!.textContent).toBe("⇧⌘1");
  expect(document.getElementById("shortcut-leaveFullScreen-keys")!.textContent).toBe("Esc or ⌘W or Double-click");
  for (const kbd of document.querySelectorAll("#shortcut-leaveFullScreen-row [data-slot=kbd-group]"))
    expect(kbd.getAttribute("aria-hidden")).toBe("true");
  // A global shortcut that does not work says so, with the Shortcut card's reason.
  expect(document.getElementById("shortcut-open-status")!.textContent).toBe("Unavailable");
  expect(document.getElementById("shortcut-open-reason")!.textContent).toBe("Another app may be using ⌥⌘,.");
  expect(document.getElementById("shortcut-record-status")).toBeNull();
  // The list edits nothing: no control in it but the arrow to the Shortcut card.
  expect([...document.querySelectorAll("#settings-panel button, #settings-panel input, #settings-panel select")].map((el) => el.id))
    .toEqual(["shortcut-record-change"]);

  document.getElementById("shortcut-record-change")!.click();
  expect(document.querySelector('[role="tab"][aria-selected="true"]')!.id).toBe("tab-general");
  expect(document.activeElement?.id).toBe("setting-hotkey");
  // The row it lands on flashes once, so the eye finds it.
  expect(document.getElementById("setting-hotkey-row")!.classList.contains("arrived")).toBe(true);
  expect(choose).not.toHaveBeenCalled();

  // While a recording locks the Shortcut card, Change… still reaches it: its row takes the focus, the control stays locked.
  const locked = view("en");
  locked.groups[0]!.enabled = false;
  push({ ...locked, resultFocus: 2, entryTab: "shortcuts" });
  document.getElementById("shortcut-record-change")!.click();
  expect(document.querySelector('[role="tab"][aria-selected="true"]')!.id).toBe("tab-general");
  expect(document.activeElement?.id).toBe("setting-hotkey-row");
  expect((document.getElementById("setting-hotkey") as HTMLButtonElement).disabled).toBe(true);

  // In Traditional Chinese the alternatives are joined by 或.
  push({ ...view("zh-TW"), resultFocus: 3, entryTab: "shortcuts" });
  expect(document.getElementById("shortcut-leaveFullScreen-keys")!.textContent).toBe("Esc 或 ⌘W 或 Double-click");
  expect(document.querySelector('[role="tab"][aria-selected="true"]')!.getAttribute("aria-label")).toBe("鍵盤快捷鍵");
});
