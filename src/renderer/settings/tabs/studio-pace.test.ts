// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

const rates = vi.hoisted(() => ({ frame: [] as number[], preview: [] as number[] }));
vi.mock("./frame-clock", () => ({ setFrameRate: (fps: number) => rates.frame.push(fps) }));
vi.mock("./studio-feed", () => ({ setPreviewRate: (fps: number) => rates.preview.push(fps) }));

afterEach(() => { vi.useRealTimers(); rates.frame.length = 0; rates.preview.length = 0; });

it("shows the Studio at the full rate while the pointer is over it or for 3 s after an input, and at half otherwise (plan 081, D1)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 0;
  const { paceStudio, ACTIVE_MS } = await import("./studio-pace");
  const root = document.documentElement;
  const stop = paceStudio(() => now);
  expect(rates.preview).toEqual([5]);
  root.dispatchEvent(new PointerEvent("pointerenter"));
  expect(rates.preview).toEqual([5, 10]);
  // A key while the pointer is over it changes nothing; leaving long after rests at once.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
  now = 5000;
  root.dispatchEvent(new PointerEvent("pointerleave"));
  expect(rates.preview).toEqual([5, 10, 5]);
  // A key with the pointer elsewhere: the full rate for ACTIVE_MS from then.
  now = 10_000;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
  expect(rates.preview).toEqual([5, 10, 5, 10]);
  now += ACTIVE_MS - 1;
  await vi.advanceTimersByTimeAsync(ACTIVE_MS - 1);
  expect(rates.preview.at(-1)).toBe(10);
  now += 1;
  await vi.advanceTimersByTimeAsync(1);
  expect(rates.preview.at(-1)).toBe(5);
  window.dispatchEvent(new WheelEvent("wheel"));
  stop();
  // Stopped, the Studio is no longer paced: the full rate, and inputs no longer count.
  expect(rates.preview.at(-1)).toBe(10);
  expect(rates.frame).toEqual(rates.preview);
  const told = rates.preview.length;
  root.dispatchEvent(new PointerEvent("pointerleave"));
  expect(rates.preview).toHaveLength(told);
});
