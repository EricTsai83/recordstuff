// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { COUNTDOWN_TICK, COUNTDOWN_TIMING } from "../../shared/countdown";
import { createCountdownState, overlayStyle, playTick, soundRequested, type TickContext } from "./countdown-state";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CountdownFaces } from "./countdown-app";

const roots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>();
function stage(): HTMLElement {
 document.body.innerHTML = '<div id="root"></div>';
 const root = createRoot(document.getElementById("root")!);
 const frame = createCountdownState()(null);
 flushSync(() => root.render(createElement(CountdownFaces, { frame })));
 const element = document.getElementById("stage")!;
 roots.set(element, root); return element;
}
function renderCountdown(element: HTMLElement, onDigit?: (digit: number) => void): (value: number | null) => void {
 const root = roots.get(element)!;
 const update = createCountdownState(onDigit);
 return value => flushSync(() => root.render(createElement(CountdownFaces, { frame: update(value) })));
}
const faces = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>(".face")).map((face) => [face.textContent, face.classList.contains("front")]);

describe("countdown overlay page", () => {
  it("fades the first digit in, crossfades between digits and fades out on null", () => {
    const el = stage();
    const render = renderCountdown(el);
    expect(el.classList.contains("visible")).toBe(false);
    render(3);
    expect(el.classList.contains("visible")).toBe(true);
    expect(faces(el)).toEqual([["3", true], ["", false]]);
    render(2);
    expect(faces(el)).toEqual([["3", false], ["2", true]]);
    render(2);
    expect(faces(el)).toEqual([["3", false], ["2", true]]);
    render(10);
    expect(faces(el)).toEqual([["10", true], ["2", false]]);
    render(null);
    expect(el.classList.contains("visible")).toBe(false);
    // The last digit stays in place while it fades.
    expect(faces(el)).toEqual([["10", true], ["2", false]]);
    // A digit after the fade, even the one that faded, shows the stage again.
    render(10);
    expect([el.classList.contains("visible"), faces(el)]).toEqual([true, [["10", true], ["2", false]]]);
  });

  it("takes every appearance and timing value from the shared module", () => {
    const style = overlayStyle();
    expect(style).toMatchObject({
      "--digit": "rgba(255, 255, 255, 0.28)",
      "--outline": "rgba(0, 0, 0, 0.10)",
      "--digit-opaque": "rgba(255, 255, 255, 1)",
      "--fade-in": `${COUNTDOWN_TIMING.fadeInMs}ms`,
      "--crossfade": `${COUNTDOWN_TIMING.crossfadeMs}ms`,
      "--fade-out": `${COUNTDOWN_TIMING.fadeOutMs}ms`,
    });
    // The fade finishes inside the lead, so the digit is gone before capture begins.
    expect(COUNTDOWN_TIMING.fadeOutMs + COUNTDOWN_TIMING.settleMs).toBeLessThan(COUNTDOWN_TIMING.overlayLeadMs);
  });

  it("sizes the digit from the window and its outline and shadows from the digit (plan 045)", () => {
    const style = overlayStyle();
    expect(style["--font-size"]).toMatch(/^[\d.]+vmin$/);
    for (const name of ["--outline-width", "--outline-width-strong"]) expect(style[name]).toMatch(/^[\d.]+em$/);
    expect(style["--shadow"]).not.toMatch(/px/);

    // In 040's 88 pt window the page draws exactly 040's digit: 56 px, 1 px and 1.5 px outlines, the same shadows.
    const fontPx = (parseFloat(style["--font-size"]!) / 100) * 88;
    expect(fontPx).toBeCloseTo(56, 9);
    const px = (value: string): string => value.replace(/([\d.]+)em/g, (_, n: string) => `${Math.round(Number(n) * fontPx * 1e6) / 1e6}px`);
    expect(px(style["--outline-width"]!)).toBe("1px");
    expect(px(style["--outline-width-strong"]!)).toBe("1.5px");
    expect(px(style["--shadow"]!)).toBe("0 0 1px rgba(0, 0, 0, 0.20), 0 1px 3px rgba(0, 0, 0, 0.14), 0 0 14px rgba(0, 0, 0, 0.08)");

    // In the 238 pt window of a 1080 pt display the digit is 151 pt, with proportionally wider outlines.
    const scaled = (parseFloat(style["--font-size"]!) / 100) * 238;
    expect(scaled).toBeCloseTo(151.45, 2);
    expect(parseFloat(style["--outline-width"]!) * scaled).toBeCloseTo(151.45 / 56, 2);
  });
});

/** Records every oscillator and gain a tick builds, with its scheduled values. */
function fakeAudio(currentTime = 5) {
  const oscillators: Array<{ type?: string; frequency: Array<[number, number]>; start?: number; stop?: number; connected: unknown[] }> = [];
  const gains: Array<{ events: Array<[string, number, number]>; connected: unknown[] }> = [];
  const destination = { name: "destination" };
  const param = (events: Array<[string, number, number]>) => ({
    setValueAtTime: (v: number, t: number) => { events.push(["set", v, t]); },
    linearRampToValueAtTime: (v: number, t: number) => { events.push(["linear", v, t]); },
    exponentialRampToValueAtTime: (v: number, t: number) => { events.push(["exp", v, t]); },
  });
  const context = {
    currentTime,
    destination,
    createOscillator: () => {
      const o = { frequency: [] as Array<[number, number]>, connected: [] as unknown[] } as (typeof oscillators)[number];
      oscillators.push(o);
      return {
        set type(value: string) { o.type = value; },
        frequency: { setValueAtTime: (v: number, t: number) => { o.frequency.push([v, t]); } },
        connect: (node: unknown) => { o.connected.push(node); return node; },
        start: (t: number) => { o.start = t; },
        stop: (t: number) => { o.stop = t; },
      };
    },
    createGain: () => {
      const g = { events: [] as Array<[string, number, number]>, connected: [] as unknown[] };
      gains.push(g);
      return { gain: param(g.events), connect: (node: unknown) => { g.connected.push(node); return node; } };
    },
  } as unknown as TickContext;
  return { context, oscillators, gains, destination };
}

describe("countdown tick (plan 046)", () => {
  it("plays one tick for each new digit and none for a repeated value or null", () => {
    const ticks: number[] = [];
    const render = renderCountdown(stage(), (digit) => ticks.push(digit));
    render(3); render(3); render(2); render(1); render(null); render(null);
    expect(ticks).toEqual([3, 2, 1]);
  });

  it("stays silent without a tick, as when the page was loaded without the sound flag", () => {
    const el = stage();
    const render = renderCountdown(el);
    render(3);
    expect(el.classList.contains("visible")).toBe(true);
    expect(soundRequested("")).toBe(false);
    expect(soundRequested("?sound=0")).toBe(false);
    expect(soundRequested("?sound=1")).toBe(true);
  });

  it("synthesizes the shared note: 523 Hz with its quiet partial, a 4 ms attack to −20 dBFS and silence by 140 ms", () => {
    const { context, oscillators, gains, destination } = fakeAudio(5);
    playTick(context, 3);
    const end = 5 + COUNTDOWN_TICK.durationMs / 1000;
    expect(oscillators.map((o) => [o.type, o.frequency, o.start, o.stop])).toEqual([
      ["sine", [[523, 5]], 5, end],
      ["sine", [[2092, 5]], 5, end],
    ]);
    const [out, partial] = gains;
    expect(out!.connected).toEqual([destination]);
    expect(out!.events).toEqual([["set", 0, 5], ["linear", 0.1, 5.004], ["exp", 0.0001, end]]);
    expect(partial!.events).toEqual([["set", 0.18, 5], ["exp", 0.001, 5 + 0.14 * 0.4]]);
  });

  it("plays the last digit a fifth higher", () => {
    const { context, oscillators } = fakeAudio(0);
    playTick(context, 1);
    expect(oscillators.map((o) => o.frequency[0]![0])).toEqual([784.5, 3138]);
    const other = fakeAudio(0);
    playTick(other.context, 10);
    expect(other.oscillators[0]!.frequency[0]![0]).toBe(523);
  });

  it("ends before the overlay leaves and capture begins, and stays clear of the test material's 660 Hz tone", () => {
    expect(COUNTDOWN_TICK.durationMs).toBeLessThan(COUNTDOWN_TIMING.tickMs - COUNTDOWN_TIMING.overlayLeadMs);
    expect(COUNTDOWN_TICK.durationMs).toBeLessThanOrEqual(150);
    const pitches = [COUNTDOWN_TICK.frequencyHz, COUNTDOWN_TICK.frequencyHz * COUNTDOWN_TICK.lastDigitRatio];
    for (const pitch of pitches.flatMap((f) => [f, f * COUNTDOWN_TICK.partial.ratio])) {
      for (const marker of [660, 1320, 1980, 2640, 3300]) expect(Math.abs(pitch - marker), `${pitch} Hz`).toBeGreaterThan(100);
    }
  });
});
