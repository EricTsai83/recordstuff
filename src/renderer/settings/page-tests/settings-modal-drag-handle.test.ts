// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { SettingsView } from "../../../shared/settings-panel";
import { HIDE_DELAY_MS, KEEP_PX, REVEAL_PX } from "../modal-drag-handle";

/**
 * The window's drag handle while a modal is open (2026-10-27): the page says only whether the pointer is near the
 * top; whether it shows at all (macOS, a modal open, no menu) and that it is a drag region are the stylesheet's, which
 * the native window-drag round checks. Driven through the real page module.
 */
const view: SettingsView = { language: "en", title: "RecordStuff", hint: "", failure: "", revision: 1,
  tabs: [{ id: "general", label: "General" }], groups: [] };
const move = (y: number): void => { document.dispatchEvent(new PointerEvent("pointermove", { clientY: y, bubbles: true })); };
const near = (): boolean => document.getElementById("modal-drag-handle")!.hasAttribute("data-near");
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

it("shows near the top, keeps between the bounds, and goes after a delay below them, on blur or on a leave from lower down", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  window.settings = { read: async () => view, capture: async () => view, choose: async () => ({ view, applied: true }),
    ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  const handle = await new Promise<HTMLElement>((resolve, reject) => {
    const started = Date.now();
    const look = (): void => {
      const found = document.getElementById("modal-drag-handle");
      if (found) resolve(found); else if (Date.now() - started > 2000) reject(new Error("No handle")); else setTimeout(look, 10);
    };
    look();
  });
  expect(handle.getAttribute("aria-hidden")).toBe("true");
  // Outside the page root, which the player and the edit view blur.
  expect(document.getElementById("root")!.contains(handle)).toBe(false);
  expect(handle.textContent).toBe("Drag to move the window");
  expect(near()).toBe(false);

  move(REVEAL_PX);
  expect(near()).toBe(true);
  // Between the two bounds nothing changes, so a pointer at the edge does not flicker it.
  move(KEEP_PX);
  await wait(HIDE_DELAY_MS + 50);
  expect(near()).toBe(true);

  // Below them it stays a moment, and a return within it keeps it.
  move(KEEP_PX + 1);
  expect(near()).toBe(true);
  move(10);
  await wait(HIDE_DELAY_MS + 50);
  expect(near()).toBe(true);
  // A return between the bounds before it goes keeps it too; a hidden one does not come back there.
  move(KEEP_PX + 1);
  move(KEEP_PX);
  await wait(HIDE_DELAY_MS + 50);
  expect(near()).toBe(true);
  move(KEEP_PX + 100);
  await wait(HIDE_DELAY_MS + 50);
  expect(near()).toBe(false);
  move(KEEP_PX);
  expect(near()).toBe(false);

  // A leave near the top keeps it (over the handle, a drag region, the page may be told the pointer left).
  move(10);
  document.documentElement.dispatchEvent(new PointerEvent("pointerleave"));
  await wait(HIDE_DELAY_MS + 50);
  expect(near()).toBe(true);
  // A leave from lower down takes it away after the delay.
  move(REVEAL_PX + 10);
  document.documentElement.dispatchEvent(new PointerEvent("pointerleave"));
  await wait(HIDE_DELAY_MS + 50);
  expect(near()).toBe(false);

  // The window losing focus takes it away at once.
  move(10);
  window.dispatchEvent(new Event("blur"));
  expect(near()).toBe(false);
});
