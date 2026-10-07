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
