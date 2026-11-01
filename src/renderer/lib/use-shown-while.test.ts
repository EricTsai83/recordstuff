// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SHOW_AFTER_MS, SHOW_AT_LEAST_MS, useShownWhile } from "./use-shown-while";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function Probe(props: { active: boolean; since?: number; cut?: boolean }) {
  return createElement("i", { "data-shown": String(useShownWhile(props.active, { since: props.since, cut: props.cut })) });
}
const draw = (props: { active: boolean; since?: number; cut?: boolean }) => act(() => root.render(createElement(Probe, props)));
const shown = () => host.querySelector("i")!.getAttribute("data-shown") === "true";
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

/** Work done within the delay shows nothing at all. */
it("never shows work done within the delay", () => {
  draw({ active: true });
  wait(SHOW_AFTER_MS - 100);
  expect(shown()).toBe(false);
  draw({ active: false });
  wait(2000);
  expect(shown()).toBe(false);
});

/** Work done just past the delay stays shown for the minimum, not for a frame. */
it("keeps work done just past the delay shown for the minimum", () => {
  draw({ active: true });
  wait(SHOW_AFTER_MS);
  expect(shown()).toBe(true);
  wait(50);
  draw({ active: false });
  wait(SHOW_AT_LEAST_MS - 100);
  expect(shown(), "still within the minimum").toBe(true);
  wait(100);
  expect(shown()).toBe(false);
});

/** Long work, once done, goes at once: it has been shown longer than the minimum. */
it("hides long work as soon as it is done", () => {
  draw({ active: true });
  wait(SHOW_AFTER_MS + 3000);
  draw({ active: false });
  wait(0);
  expect(shown()).toBe(false);
});

/** Work starting again while lingering keeps showing, without going away in between. */
it("keeps showing work that starts again while it lingers", () => {
  draw({ active: true });
  wait(SHOW_AFTER_MS);
  draw({ active: false });
  wait(100);
  draw({ active: true });
  wait(SHOW_AT_LEAST_MS + 500);
  expect(shown()).toBe(true);
});

/** A failure hides it at once, whatever is left of the minimum, for the failure to show. */
it("hides at once when the work fails", () => {
  draw({ active: true });
  wait(SHOW_AFTER_MS);
  draw({ active: false, cut: true });
  expect(shown()).toBe(false);
});

/** Work asked for long enough ago shows from the first frame; work asked for recently waits out the rest. */
it("counts the delay from when the work was asked for", () => {
  draw({ active: true, since: Date.now() - SHOW_AFTER_MS - 1000 });
  expect(shown(), "already waiting: from the first frame").toBe(true);
  act(() => root.render(createElement("b")));
  draw({ active: true, since: Date.now() - 300 });
  expect(shown()).toBe(false);
  wait(SHOW_AFTER_MS - 300);
  expect(shown()).toBe(true);
});
