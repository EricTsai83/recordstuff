// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { pick } from "../../testing/test-interactions";
import type { SettingsView } from "../../../shared/settings-panel";
import { DEFAULT_HOTKEY } from "../../../shared/hotkey";

it("still hears main's time limit after the editor reopened while its close was unanswered", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.innerHTML = '<div id="root"></div>';
  let current: SettingsView = {
    language: "en", title: "Settings", hint: "", failure: "Save failed",
    tabs: [{ id: "general", label: "General" }],
    groups: [{ id: "hotkey", label: "Shortcut", tab: "general", kind: "shortcut", platform: "darwin", enabled: true,
      choices: [{ id: DEFAULT_HOTKEY.accelerator, label: "Default", checked: true, enabled: true }] }],
  };
  const capturing = (on: boolean, timedOut = false): SettingsView => {
    current = structuredClone(current);
    current.groups[0]!.capturing = on;
    if (timedOut) current.groups[0]!.captureTimedOut = true;
    else delete current.groups[0]!.captureTimedOut;
    return current;
  };
  let push!: (next: SettingsView) => void;
  // A close is answered only when the test says so.
  let answerClose: (() => void) | undefined;
  window.settings = { read: async () => current, choose: vi.fn(),
    capture: armed => armed ? Promise.resolve(capturing(true))
      : new Promise<SettingsView>(resolve => { answerClose = () => resolve(capturing(false)); }),
    ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("../settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).toBeTruthy());
  document.getElementById("tab-general")!.click();
  await vi.waitFor(() => expect(document.getElementById("setting-hotkey")).toBeTruthy());
  const open = async () => {
    await pick("setting-hotkey", "custom");
    await vi.waitFor(() => expect(document.activeElement?.id).toBe("shortcut-capture"));
  };
  await open();
  // Escape asks main to close the editor; main closes it and says so before it answers the request.
  document.getElementById("shortcut-capture")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(answerClose).toBeDefined());
  push(capturing(false));
  await open();
  answerClose!();
  await new Promise(resolve => setTimeout(resolve, 0));
  // Main's time limit then ends the reopened editor: it is said, and the focus returns to the menu.
  push(capturing(false, true));
  const timeout = document.querySelector<HTMLElement>(".capture-timeout")!;
  await vi.waitFor(() => expect(timeout.hidden).toBe(false));
  expect(document.getElementById("feedback")?.textContent).toBe(timeout.textContent);
  expect(document.activeElement?.id).toBe("setting-hotkey");
});
