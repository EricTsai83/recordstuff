import { expect, it, vi } from "vitest";
import vm from "node:vm";
import { AX_SCRIPT } from "./native-ax.mts";
import { dragEvents, judgeDrag, nativeDrag } from "./native-drag.mts";

const from = { x: -900, y: 100 }, to = { x: -840, y: 140 };
it("posts real held-button drag events, including a down/up and a slow path on a secondary display", () => {
  const events = dragEvents(from, to);
  const posted: Array<{ type: number; point: unknown; flags?: number; clicks?: number }> = [];
  const $ = Object.assign(() => null, {
    CGPointMake: (x: number, y: number) => ({ x, y }),
    CGEventCreateMouseEvent: (_: unknown, type: number, point: unknown) => ({ type, point }),
    CGEventSetFlags: (event: { flags: number }, flags: number) => { event.flags = flags; },
    CGEventSetIntegerValueField: (event: { clicks: number }, _field: number, clicks: number) => { event.clicks = clicks; },
    CGEventPost: (_: number, event: typeof posted[number]) => { posted.push(event); },
  });
  const context = vm.createContext({ $, ObjC: { import: () => {}, bindFunction: () => {} }, delay: () => {} });
  vm.runInContext(AX_SCRIPT, context);
  vm.runInContext(`run(['drag-events', ${JSON.stringify(JSON.stringify(events))}])`, context);
  expect(posted.map(event => event.type)).toEqual([5, 1, ...Array(16).fill(6), 2, 2]);
  expect(posted.every(event => event.flags === 0 && event.clicks === 1)).toBe(true);
  expect(posted.at(-1)?.point).toEqual(to);
  posted.length = 0;
  $.CGEventPost = (_: number, event: typeof posted[number]) => {
    posted.push(event);
    if (event.type === 6) throw new Error("delivery failed while held");
  };
  expect(() => vm.runInContext(`run(['drag-events', ${JSON.stringify(JSON.stringify(events))}])`, context)).toThrow("while held");
  expect(posted.at(-1)?.type).toBe(2);
});

it("rejects bad coordinates before input; cancellation after input still releases through a fresh signal", async () => {
  const post = vi.fn().mockRejectedValueOnce(new Error("cancelled")).mockResolvedValue(undefined);
  const controller = new AbortController();
  await expect(nativeDrag(from, { x: NaN, y: 0 }, controller.signal, post)).rejects.toThrow("finite");
  expect(post).not.toHaveBeenCalled();
  await expect(nativeDrag(from, to, controller.signal, post)).rejects.toThrow("cancelled");
  expect(post.mock.calls[1]?.[0]).toBe("release-mouse");
  expect(post.mock.calls[1]?.[2]).not.toBe(controller.signal);
  controller.abort();
  await expect(nativeDrag(from, to, controller.signal, post)).rejects.toThrow();
  expect(post).toHaveBeenCalledTimes(2);
});

it("judges actual displacement rather than a CSS declaration or any window movement", () => {
  const before = { ...from, width: 900, height: 650 };
  const after = { ...to, width: 900, height: 650 };
  expect(judgeDrag(before, after, { x: 60, y: 40 })).toEqual([]);
  expect(judgeDrag(before, before, { x: 60, y: 40 })).not.toEqual([]);
  expect(judgeDrag(before, after, { x: 0, y: 0 })).not.toEqual([]);
  expect(judgeDrag(before, { ...after, width: 960 }, { x: 60, y: 40 })).toContain("window size changed");
  expect(judgeDrag(before, { ...before, x: NaN }, { x: 0, y: 0 })).toEqual(["invalid window geometry"]);
});
