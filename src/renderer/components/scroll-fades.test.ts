// @vitest-environment happy-dom
import { createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ScrollFades } from "./scroll-fades";

afterEach(() => { vi.restoreAllMocks(); });

/** A redraw of the page changes the revision on every keystroke: it must not rebuild the observer each time. */
it("keeps one observer across revisions and follows the children a revision adds or removes", () => {
  const observers: Array<{ observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.spyOn(globalThis, "ResizeObserver").mockImplementation(class {
    observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
    constructor() { observers.push(this); }
  } as unknown as typeof ResizeObserver);
  const panel = document.createElement("div");
  const first = panel.appendChild(document.createElement("section"));
  const host = document.body.appendChild(document.createElement("div"));
  const scrollRef = createRef<HTMLElement>() as { current: HTMLElement | null };
  scrollRef.current = panel;
  const root = createRoot(host);
  const render = (revision: number) => flushSync(() => root.render(createElement(ScrollFades, { scrollRef, contentRevision: revision })));
  render(1); render(2); render(3);
  expect(observers).toHaveLength(1);
  expect(observers[0]!.observe.mock.calls.map(([node]) => node)).toEqual([panel, first]);
  const second = panel.appendChild(document.createElement("section"));
  first.remove();
  render(4);
  expect(observers).toHaveLength(1);
  expect(observers[0]!.observe).toHaveBeenLastCalledWith(second);
  expect(observers[0]!.unobserve).toHaveBeenCalledWith(first);
  flushSync(() => root.unmount());
  expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
});
