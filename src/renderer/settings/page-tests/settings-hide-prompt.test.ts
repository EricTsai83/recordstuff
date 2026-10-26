// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click } from "../../testing/test-interactions";
import type { SettingsView } from "../../../shared/settings-panel";

/**
 * Escape asks before it hides the window (2026-10-26, the maintainer's request): the first opens a prompt and hides
 * nothing; a second, or Hide window, hides it; Cancel and the window losing the focus leave the prompt and keep the
 * window; ⌘W still hides it at once.
 */
it("asks on the first Escape and hides on the second, while Cancel, a blur and ⌘W do what they say", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  document.body.innerHTML = '<div id="root"></div>';
  let revision = 1;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "general", label: "General" }], groups: [] });
  window.settings = { read: async () => view(), capture: async () => view(), choose: async () => ({ view: view(), applied: true }), ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.getElementById("tab-general")).not.toBeNull());
  const escape = (): void => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); };
  const prompt = (): HTMLElement | null => document.getElementById("hide-prompt");

  // The first Escape asks and hides nothing.
  escape();
  await vi.waitFor(() => expect(prompt()).not.toBeNull());
  expect(document.getElementById("hide-prompt-title")!.textContent).toBe("Press Esc again to hide the window");
  expect(close).not.toHaveBeenCalled();
  // A second hides the window, once, and the prompt goes.
  escape();
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(prompt()).toBeNull());

  // Cancel keeps the window.
  escape();
  await vi.waitFor(() => expect(prompt()).not.toBeNull());
  click(document.getElementById("hide-prompt-cancel")!);
  await vi.waitFor(() => expect(prompt()).toBeNull());
  expect(close).toHaveBeenCalledTimes(1);

  // So does the window losing the focus: the next Escape asks again rather than hiding.
  escape();
  await vi.waitFor(() => expect(prompt()).not.toBeNull());
  window.dispatchEvent(new Event("blur"));
  await vi.waitFor(() => expect(prompt()).toBeNull());
  escape();
  await vi.waitFor(() => expect(prompt()).not.toBeNull());
  expect(close).toHaveBeenCalledTimes(1);
  // Hide window hides it.
  click(document.getElementById("hide-prompt-hide")!);
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));

  // ⌘W hides at once, with no prompt.
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", metaKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(prompt()).toBeNull());
});
