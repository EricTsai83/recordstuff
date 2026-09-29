import { expect, it } from "vitest";
import { drainQueue } from "./drain-queue";

it("waits for links appended while an earlier link was awaited", async () => {
  const done: number[] = [];
  let queue: Promise<void> = Promise.resolve();
  const append = (n: number, then?: () => void): void => {
    queue = queue.then(async () => { await new Promise(resolve => setTimeout(resolve, 1)); done.push(n); then?.(); });
  };
  append(1, () => append(2, () => append(3)));
  await drainQueue(() => queue);
  expect(done).toEqual([1, 2, 3]);
});
