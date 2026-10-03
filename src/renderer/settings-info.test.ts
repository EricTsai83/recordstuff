// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsGroup, SettingsView } from "../shared/settings-panel";

/** A group's secondary explanation sits behind an ⓘ beside its label, driven through the real page module. */
function view(language: "en" | "zh-TW", info: string | undefined): SettingsView {
  const groups: SettingsGroup[] = [
    { id: "countdownSound", label: language === "en" ? "Countdown sound" : "倒數音效", tab: "recording", control: "switch", enabled: true,
      ...(info ? { info } : {}),
      choices: [{ id: "on", label: "On", enabled: true, checked: true }, { id: "off", label: "Off", enabled: true, checked: false }] },
    { id: "frameRate", label: "Frame rate", tab: "recording", enabled: true,
      choices: [{ id: "30", label: "30 fps", enabled: true, checked: true }] },
  ];
  return {
    language, title: "RecordStuff - Settings", hint: "", failure: "Could not apply this setting.",
    tabs: [{ id: "recording", label: "Recording" }, { id: "general", label: "General" }, { id: "failures", label: "Failures" }],
    groups, recordingResults: [],
  };
}

it("shows the explanation on hover and focus, pins it on click, closes it with Escape before the window, and keeps it describing the control", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  document.body.innerHTML = '<h1 id="title"></h1><p id="hint"></p><p id="feedback"></p><form id="settings"></form>';
  let current = view("en", "The tick is not recorded.");
  let push!: (next: SettingsView) => void;
  window.settings = { read: async () => current, capture: async () => current, choose: async () => ({ view: current, applied: true }),
    ready: async () => {}, onChanged: (cb) => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("setting-countdownSound")).toBeTruthy());

  const info = document.getElementById("setting-countdownSound-info-button") as HTMLButtonElement;
  const popover = document.getElementById("setting-countdownSound-info")!;
  expect(info.hidden).toBe(false);
  expect(info.getAttribute("aria-label")).toBe("More about Countdown sound");
  expect(info.getAttribute("aria-describedby")).toBe(popover.id);
  expect(popover.textContent).toBe("The tick is not recorded.");
  expect(popover.getAttribute("popover")).toBe("manual");
  expect(document.getElementById("setting-countdownSound")!.getAttribute("aria-describedby")).toBe(popover.id);
  // A group without one has no ⓘ and no description pointing at it.
  expect((document.getElementById("setting-frameRate-info-button") as HTMLButtonElement).hidden).toBe(true);
  expect(document.getElementById("setting-frameRate")!.hasAttribute("aria-describedby")).toBe(false);

  const expanded = () => info.getAttribute("aria-expanded");
  const past = () => new Promise(resolve => setTimeout(resolve, 200));
  info.dispatchEvent(new MouseEvent("mouseenter"));
  expect(expanded()).toBe("true");
  // The pointer may cross onto the explanation, which keeps it open; leaving both closes it.
  info.dispatchEvent(new MouseEvent("mouseleave")); popover.dispatchEvent(new MouseEvent("mouseenter")); await past();
  expect(expanded()).toBe("true");
  popover.dispatchEvent(new MouseEvent("mouseleave")); await past();
  expect(expanded()).toBe("false");
  // Crossing from the bridge onto the explanation, Chromium reports a leave with the pointer still on it:
  // the explanation stays while it is hovered, and the real leave that follows closes it.
  info.dispatchEvent(new MouseEvent("mouseenter"));
  info.dispatchEvent(new MouseEvent("mouseleave")); popover.dispatchEvent(new MouseEvent("mouseenter"));
  const hovered = vi.spyOn(popover, "matches").mockImplementation(function (this: Element, selector: string) {
    return selector === ":hover" || Element.prototype.matches.call(this, selector);
  });
  popover.dispatchEvent(new MouseEvent("mouseleave")); await past();
  expect(expanded()).toBe("true");
  hovered.mockRestore();
  popover.dispatchEvent(new MouseEvent("mouseleave")); await past();
  expect(expanded()).toBe("false");
  // A click pins it through the pointer leaving; a second click closes it.
  info.dispatchEvent(new MouseEvent("mouseenter")); info.click(); info.dispatchEvent(new MouseEvent("mouseleave")); await past();
  expect(expanded()).toBe("true");
  info.click();
  expect(expanded()).toBe("false");
  // Keyboard focus shows it; Escape closes it and leaves the window open, a second Escape closes the window.
  info.focus();
  expect(expanded()).toBe("true");
  // The pointer leaving does not close what keyboard focus opened.
  info.dispatchEvent(new MouseEvent("mouseenter")); info.dispatchEvent(new MouseEvent("mouseleave")); await past();
  expect(expanded()).toBe("true");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(expanded()).toBe("false");
  expect(close).not.toHaveBeenCalled();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(close).toHaveBeenCalledOnce();
  info.blur();

  // A language change relabels it; an explanation that goes away closes and hides it.
  current = view("zh-TW", "提示音不會被錄進影片。"); push(current);
  expect(info.getAttribute("aria-label")).toBe("倒數音效的說明");
  expect(popover.textContent).toBe("提示音不會被錄進影片。");
  info.dispatchEvent(new MouseEvent("mouseenter")); info.click();
  expect(expanded()).toBe("true");
  current = view("zh-TW", undefined); push(current);
  expect(expanded()).toBe("false");
  expect(info.hidden).toBe(true);
  expect(document.getElementById("setting-countdownSound")!.hasAttribute("aria-describedby")).toBe(false);

  // A rebuild (here another tab) drops an open explanation with its nodes, so the next Escape closes the window.
  current = view("en", "The tick is not recorded."); push(current);
  const reopened = document.getElementById("setting-countdownSound-info-button")!;
  reopened.dispatchEvent(new MouseEvent("mouseenter"));
  expect(reopened.getAttribute("aria-expanded")).toBe("true");
  document.getElementById("tab-general")!.click();
  expect(document.getElementById("setting-countdownSound-info-button")).toBeNull();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(close).toHaveBeenCalledTimes(2);
});
