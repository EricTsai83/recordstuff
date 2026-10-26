import { expect, it } from "vitest";
import { SerialQueue } from "./serial-queue";

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 1));

it("runs tasks one at a time in order, a failure rejecting only its own caller", async () => {
  const queue = new SerialQueue();
  const order: string[] = [];
  let running = 0, most = 0;
  const task = (name: string, fail = false) => async (): Promise<string> => {
    most = Math.max(most, ++running);
    await tick();
    order.push(name);
    running--;
    if (fail) throw new Error(name);
    return name;
  };
  const results = await Promise.allSettled([queue.run(task("a")), queue.run(task("b", true)), queue.run(task("c"))]);
  expect(order).toEqual(["a", "b", "c"]);
  expect(most).toBe(1);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
});

it("drains tasks given while it waits", async () => {
  const queue = new SerialQueue();
  const done: number[] = [];
  void queue.run(async () => { await tick(); done.push(1); void queue.run(async () => { await tick(); done.push(2); }); });
  await queue.drain();
  expect(done).toEqual([1, 2]);
});
