import { expect, it } from "vitest";
import { keepUnchanged, sameData } from "./keep-unchanged";

it("compares plain data throughout", () => {
  expect(sameData({ a: [1, { b: "x" }], c: undefined }, { a: [1, { b: "x" }], c: undefined })).toBe(true);
  expect(sameData({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] })).toBe(false);
  expect(sameData({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  expect(sameData({ a: undefined }, { b: undefined })).toBe(false);
  expect(sameData([1], { 0: 1 })).toBe(false);
  expect(sameData(null, {})).toBe(false);
});

/** A push that changes one row keeps every other row's previous object, so only the changed one draws again. */
it("keeps the previous object of every unchanged row", () => {
  const previous = [{ id: "a", n: 1, tags: ["x"] }, { id: "b", n: 2, tags: [] }];
  const next = [{ id: "b", n: 3, tags: [] }, { id: "a", n: 1, tags: ["x"] }, { id: "c", n: 4, tags: [] }];
  const kept = keepUnchanged(previous, next);
  expect(kept[0]).toBe(next[0]);
  expect(kept[1]).toBe(previous[0]);
  expect(kept[2]).toBe(next[2]);
  expect(kept).toEqual(next);
});
