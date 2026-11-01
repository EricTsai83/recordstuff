// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { morphDuration } from "./library";

const viewport = { width: 960, height: 640 };
const card = (left: number, top: number) => ({ left, top, width: 316, height: 178 });

/** Share…'s morph takes as long as its picture travels: a card near the middle is quicker than one in a corner, within bounds. */
it("gives Share…'s morph a length by how far the card's picture travels", () => {
  const near = morphDuration(card(322, 231), viewport);
  const far = morphDuration(card(0, 0), viewport);
  expect(near).toBeLessThan(far);
  expect(near).toBeGreaterThanOrEqual(240);
  expect(morphDuration(card(-3000, -3000), viewport)).toBe(400);
});
