// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

const rates = vi.hoisted(() => ({ frame: [] as number[], preview: [] as number[] }));
vi.mock("./frame-clock", () => ({ setFrameRate: (fps: number) => rates.frame.push(fps) }));
vi.mock("./studio-feed", () => ({ setPreviewRate: (fps: number) => rates.preview.push(fps) }));

afterEach(() => { vi.useRealTimers(); rates.frame.length = 0; rates.preview.length = 0; });

it("under Power saving shows the Studio at the full rate while the pointer is over it or for 3 s after an input, and at half otherwise (plan 081, D1)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 0;
  const { paceStudio, ACTIVE_MS } = await import("./studio-pace");
  const root = document.documentElement;
  const { stop } = paceStudio("power", () => now);
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

it("holds Standard at 10 and Smooth at 15 whatever is done in the Studio, paces Off's meters as Power saving, and keeps the pointer across choices (plan 092, D1)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { paceStudio } = await import("./studio-pace");
  const root = document.documentElement;
  for (const [rate, fps] of [["standard", 10], ["smooth", 15]] as const) {
    rates.preview.length = 0;
    const { stop } = paceStudio(rate);
    root.dispatchEvent(new PointerEvent("pointerenter"));
    root.dispatchEvent(new PointerEvent("pointerleave"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(rates.preview, rate).toEqual([fps]);
    stop();
    expect(rates.preview.at(-1), `${rate} stopped`).toBe(10);
  }
  rates.preview.length = 0;
  const pacer = paceStudio("power");
  root.dispatchEvent(new PointerEvent("pointerenter"));
  expect(rates.preview, "Power saving follows the pointer").toEqual([5, 10]);
  // The pointer rests on the Studio while a rate is chosen: Power saving starts at the working rate, as it would
  // have, and Smooth and back keep it.
  pacer.rate("smooth");
  pacer.rate("power");
  expect(rates.preview).toEqual([5, 10, 15, 10]);
  root.dispatchEvent(new PointerEvent("pointerleave"));
  expect(rates.preview.at(-1)).toBe(5);
  pacer.stop();
  expect(rates.frame.at(-1)).toBe(10);
});
