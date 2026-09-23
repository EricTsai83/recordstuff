// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../shared/hotkey";
import { shortcutCandidate } from "./shortcut-capture";

it("arms only after main acknowledges, captures a combination, cancels and obeys recording lock", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<h1 id="title"></h1><p id="hint"></p><p id="feedback"></p><form id="settings"></form>';
  let current: SettingsView = {
    language: "en", title: "Settings", hint: "", failure: "Save failed",
    tabs: [{ id: "recording", label: "Recording" }, { id: "general", label: "General" }],
    groups: [{ id: "hotkey", label: "Shortcut", tab: "general", kind: "shortcut", platform: "darwin", enabled: true,
      choices: [{ id: DEFAULT_HOTKEY.accelerator, label: "Default", checked: true, enabled: true }] }],
  };
  let push!: (view: typeof current) => void;
  const capture = vi.fn(async (armed: boolean) => {
    current = structuredClone(current);
    current.groups.find(g => g.id === "hotkey")!.capturing = armed;
    return current;
  });
  let finishSave!: () => void;
  const choose = vi.fn(async (_group: string, _choice: string) => {
    await new Promise<void>(resolve => { finishSave = resolve; });
    current = structuredClone(current);
    current.groups[0]!.capturing = false;
    current.groups[0]!.choices.forEach(c => { c.checked = false; });
    current.groups[0]!.choices.push({ id: "Control+Alt+R", label: "⌃⌥R", enabled: true, checked: true });
    return { view: current, applied: true };
  });
  window.settings = { read: async () => current, capture, choose, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  const edit = () => {
    const select = document.getElementById("setting-hotkey") as HTMLSelectElement;
    select.value = "custom"; select.dispatchEvent(new Event("change"));
  };
  const button = () => document.getElementById("shortcut-capture") as HTMLButtonElement;
  edit();
  await vi.waitFor(() => expect(button().textContent).toBe("Press a combination"));
  edit();
  expect(capture).toHaveBeenCalledTimes(1);
  expect((document.getElementById("setting-hotkey") as HTMLSelectElement).value).toBe(DEFAULT_HOTKEY.accelerator);
  button().dispatchEvent(new KeyboardEvent("keydown", { key: "R", code: "KeyR", bubbles: true }));
  expect(choose).not.toHaveBeenCalled();
  expect(document.getElementById("feedback")!.textContent).toContain("Command or Control");
  button().dispatchEvent(new KeyboardEvent("keydown", { key: "r", code: "KeyR", ctrlKey: true, altKey: true, bubbles: true }));
  expect(choose).not.toHaveBeenCalled();
  expect((document.getElementById("setting-hotkey") as HTMLSelectElement).value).toBe(DEFAULT_HOTKEY.accelerator);
  button().dispatchEvent(new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft", bubbles: true }));
  expect(button().textContent).toContain("R");
  const confirm = document.getElementById("shortcut-confirm") as HTMLButtonElement;
  const press = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
  confirm.dispatchEvent(press);
  expect(press.defaultPrevented).toBe(true);
  confirm.focus(); confirm.click(); confirm.click();
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("hotkey", "Control+Alt+R"));
  expect(button().disabled).toBe(false);
  expect(document.activeElement).toBe(confirm);
  expect(capture).not.toHaveBeenCalledWith(false);
  const panelBeforeCustom = document.getElementById("settings-panel");
  const menuBeforeCustom = document.getElementById("setting-hotkey");
  finishSave();
  await vi.waitFor(() => expect(current.groups[0]!.capturing).toBe(false));
  expect(document.getElementById("settings-panel")).toBe(panelBeforeCustom);
  expect(document.getElementById("setting-hotkey")).toBe(menuBeforeCustom);
  expect((menuBeforeCustom as HTMLSelectElement).value).toBe("Control+Alt+R");
  expect(document.activeElement?.id).toBe("setting-hotkey");
  edit();
  await vi.waitFor(() => expect(button().textContent).toBe("Press a combination"));
  button().dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
  expect(choose).toHaveBeenCalledTimes(1);
  button().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  await vi.waitFor(() => expect(current.groups[0]!.capturing).toBe(false));
  expect(choose).toHaveBeenCalledTimes(1);
  edit();
  await vi.waitFor(() => expect(button().textContent).toBe("Press a combination"));
  const tab = new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true });
  button().dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false);
  document.getElementById("tab-general")!.focus();
  await vi.waitFor(() => expect(current.groups[0]!.capturing).toBe(false));
  current = structuredClone(current);
  current.groups[0]!.enabled = false;
  push(current);
  expect(button().disabled).toBe(true);

  // Recovery shares the original choice path, keeps committed values, and
  // never overwrites a newer selection after a failed save.
  current.groups.push({ id: "screen", label: "Screen", tab: "recording", enabled: true,
    choices: [{ id: "primary", label: "Primary", enabled: true, checked: false },
      { id: "2", label: "Missing", enabled: false, checked: true }],
    diagnostics: [{ kind: "current", heading: "Unavailable", reason: "Cannot record", guidance: "Choose Primary" }],
    recovery: { choice: "primary", label: "Use Primary display" } });
  push(current);
  document.getElementById("tab-recording")!.click();
  choose.mockImplementation(async () => {
    await new Promise<void>(resolve => { finishSave = resolve; });
    return { view: structuredClone(current), applied: false };
  });
  const recovery = document.getElementById("setting-screen-recovery") as HTMLButtonElement;
  recovery.focus(); recovery.click(); recovery.click();
  expect(choose).toHaveBeenCalledTimes(2);
  expect((document.getElementById("setting-screen") as HTMLSelectElement).value).toBe("2");
  finishSave();
  await vi.waitFor(() => expect(document.querySelector("#setting-screen-row .save-error")?.hasAttribute("hidden")).toBe(false));
  expect(document.querySelectorAll("#setting-screen-row .diagnostic")).toHaveLength(2);
  const retry = document.getElementById("setting-screen-retry") as HTMLButtonElement;
  expect(retry.hidden).toBe(false);
  current = structuredClone(current);
  current.groups[1]!.enabled = false;
  push(current);
  expect(retry.hidden).toBe(true);
  current.groups[1]!.enabled = true;
  current.groups[1]!.choices.forEach(c => { c.checked = c.id === "primary"; });
  push(current);
  expect(retry.hidden).toBe(true);
  // A successful recovery removes its own button and restores only its focus.
  current.groups[1]!.choices.forEach(c => { c.checked = c.id === "2"; });
  push(current);
  choose.mockImplementation(async () => {
    current = structuredClone(current);
    const screen = current.groups[1]!;
    screen.choices.forEach(c => { c.checked = c.id === "primary"; });
    delete screen.recovery; screen.diagnostics = [];
    return { view: current, applied: true };
  });
  recovery.focus(); recovery.click();
  await vi.waitFor(() => expect((document.getElementById("setting-screen") as HTMLSelectElement).value).toBe("primary"));
  expect(document.activeElement?.id).toBe("setting-screen");
  expect(document.getElementById("feedback")!.textContent).toBe("Switched to Primary display");

  current.groups[1]!.actions = [{ id: "openSettings", label: "Open settings", enabled: true, checked: false }];
  const stablePanel = document.getElementById("settings-panel");
  const stableSelect = document.getElementById("setting-screen");
  push(current);
  expect(document.getElementById("settings-panel")).toBe(stablePanel);
  expect(document.getElementById("setting-screen")).toBe(stableSelect);
  choose.mockImplementation(async () => {
    await new Promise<void>(resolve => { finishSave = resolve; });
    return { view: structuredClone(current), applied: false };
  });
  document.getElementById("setting-screen-openSettings")!.click();
  expect(document.querySelector("#setting-screen-row .applying")!.textContent).toBe("");
  expect(document.getElementById("setting-screen-row")!.getAttribute("aria-busy")).toBe("true");
  finishSave();
  await vi.waitFor(() => expect(document.querySelector("#setting-screen-row .save-error strong")!.textContent).toBe("Action failed"));
  expect(document.querySelector("#setting-screen-row .save-error")!.hasAttribute("hidden")).toBe(false);

});

it("uses physical letters/digits and named keys, with modifiers held separately", () => {
  const key = { key: "!", code: "Digit1", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };
  expect(shortcutCandidate(key)).toBe("CommandOrControl+Shift+1");
  expect(shortcutCandidate({ ...key, code: "KeyQ", key: "a" })).toBe("CommandOrControl+Shift+Q");
  expect(shortcutCandidate({ ...key, code: "ArrowLeft", key: "ArrowLeft" })).toBe("CommandOrControl+Shift+Left");
  expect(shortcutCandidate({ ...key, code: "MetaLeft", key: "Meta" })).toBeUndefined();
});

it("maps physical punctuation despite Option/Shift glyphs and rejects numpad aliases", () => {
  const key = { key: "…", code: "Semicolon", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false };
  expect(shortcutCandidate(key)).toBe("CommandOrControl+Alt+;");
  expect(shortcutCandidate({ ...key, code: "Backquote", key: "Dead" })).toBe("CommandOrControl+Alt+`");
  expect(shortcutCandidate({ ...key, code: "Slash", key: "?", shiftKey: true })).toBe("CommandOrControl+Alt+Shift+/");
  expect(shortcutCandidate({ ...key, code: "Numpad1", key: "1" })).toBe("CommandOrControl+Alt+Unsupported");
});

it("never turns a Windows/Linux Meta press into an unrelated Control shortcut", () => {
  const key = { key: "k", code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
  expect(shortcutCandidate(key, "darwin")).toBe("CommandOrControl+K");
  for (const platform of ["win32", "linux"]) {
    expect(shortcutCandidate(key, platform)).toBe("Unsupported");
    expect(shortcutCandidate({ ...key, metaKey: false, ctrlKey: true }, platform)).toBe("Control+K");
  }
});
