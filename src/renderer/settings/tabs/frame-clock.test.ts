import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());

it("ticks without preview frames at the clock's rate, and on each preview frame (plan 075 step 8, plan 081)", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const clock = await import("./frame-clock");
  const ticks: number[] = [];
  const stop = clock.onFrame(() => ticks.push(performance.now()));
  await vi.advanceTimersByTimeAsync(1000);
  ticks.length = 0;
  await vi.advanceTimersByTimeAsync(1000);
  expect(ticks).toHaveLength(10);
  clock.setFrameRate(5);
  ticks.length = 0;
  await vi.advanceTimersByTimeAsync(1000);
  expect(ticks).toHaveLength(5);
  // Preview frames drive it: the timer stays quiet while they come.
  ticks.length = 0;
  for (let i = 0; i < 5; i += 1) {
    clock.frameDrawn();
    await vi.advanceTimersByTimeAsync(200);
  }
  expect(ticks).toHaveLength(5);
  clock.setFrameRate(10);
  stop();
  ticks.length = 0;
  await vi.advanceTimersByTimeAsync(500);
  expect(ticks).toEqual([]);
});
