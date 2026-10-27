import { expect, it } from "vitest";
import { parseWindowDragResults, windowDragFailed } from "./window-drag.mts";
it("does not turn an empty, torn or partial fixture run with exit zero into a pass", () => {
  expect(() => parseWindowDragResults("{}")).toThrow("Malformed");
  expect(() => parseWindowDragResults('{"cases":')).toThrow();
  expect(windowDragFailed({ cases: [], complete: true, blocked: false }, 0)).toBe(true);
  expect(windowDragFailed(undefined, 0)).toBe(true);
});
it("preserves an earlier judged failure when a later case loses desktop focus", () => {
  const blocked = { cases: [], complete: false, blocked: true };
  expect(windowDragFailed(blocked, 0)).toBe(false);
  expect(windowDragFailed({ ...blocked, cases: [{ name: "top-left", ok: false, detail: "did not move" }] }, 0)).toBe(true);
});
it("passes a complete run only with every profile's full and collapsed sidebar cases (2026-10-21) and the modal drag handle's (2026-10-27)", () => {
  const sidebar = ["sidebar-blank", "tab-no-drag", "tab-click", "menu-button-no-drag", "menu-click", "menu-overlay-no-drag"], top = ["top-left", "top-middle", "top-right"];
  const names = [...["wide-100", "wide-150"].flatMap(profile => [...top.map(name => `${profile}-${name}`),
    ...[...sidebar, "brand", "toggle-no-drag"].map(name => `${profile}-full-${name}`), ...[...sidebar, "toggle-no-drag"].map(name => `${profile}-collapsed-${name}`)]),
    ...[...top, ...sidebar].map(name => `narrow-100-${name}`), "modal-handle-hidden-away-from-top", "modal-handle-shown-near-top",
    "modal-handle-drag", "modal-handle-closes-nothing", "modal-backdrop-still-dismisses", "console"];
  const run = (list: string[]) => ({ cases: list.map(name => ({ name, ok: true, detail: {} })), complete: true, blocked: false });
  expect(names).toHaveLength(51);
  expect(windowDragFailed(run(names), 0)).toBe(false);
  expect(windowDragFailed(run(names.filter(name => name !== "wide-150-collapsed-sidebar-blank")), 0)).toBe(true);
  expect(windowDragFailed(run(names.filter(name => name !== "modal-handle-drag")), 0)).toBe(true);
});
