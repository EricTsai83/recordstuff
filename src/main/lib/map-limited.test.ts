import { expect, it } from "vitest";
import { mapLimited } from "./map-limited";

it("keeps the items' order with at most `limit` runs in flight", async () => {
  let running = 0, most = 0;
  const results = await mapLimited([5, 1, 4, 2, 3, 0, 6], 3, async (delay, index) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise(resolve => setTimeout(resolve, delay));
    running -= 1;
    return `${index}:${delay}`;
  });
  expect(results).toEqual(["0:5", "1:1", "2:4", "3:2", "4:3", "5:0", "6:6"]);
  expect(most).toBe(3);
});

it("takes no items, and rejects as Promise.all does", async () => {
  expect(await mapLimited([], 4, async () => 1)).toEqual([]);
  await expect(mapLimited([1, 2], 4, async (item) => { if (item === 2) throw new Error("two"); return item; })).rejects.toThrow("two");
});
