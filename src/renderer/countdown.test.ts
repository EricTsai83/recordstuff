// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { COUNTDOWN_OVERLAY, COUNTDOWN_TIMING } from "../shared/countdown";
import { createCountdownView, overlayStyle } from "./countdown";

function stage(): HTMLElement {
  document.body.innerHTML = '<div id="stage" role="timer"><span class="face"></span><span class="face"></span></div>';
  return document.getElementById("stage")!;
}
const faces = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>(".face")).map((face) => [face.textContent, face.classList.contains("front")]);

describe("countdown overlay page", () => {
  it("fades the first digit in, crossfades between digits and fades out on null", () => {
    const el = stage();
    const render = createCountdownView(el);
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
  });

  it("takes every appearance and timing value from the shared module", () => {
    const style = overlayStyle();
    expect(style).toMatchObject({
      "--font-size": `${COUNTDOWN_OVERLAY.font.sizePt}px`,
      "--digit": "rgba(255, 255, 255, 0.28)",
      "--outline": "rgba(0, 0, 0, 0.10)",
      "--outline-width": "1px",
      "--digit-opaque": "rgba(255, 255, 255, 1)",
      "--fade-in": `${COUNTDOWN_TIMING.fadeInMs}ms`,
      "--crossfade": `${COUNTDOWN_TIMING.crossfadeMs}ms`,
      "--fade-out": `${COUNTDOWN_TIMING.fadeOutMs}ms`,
    });
    // The fade finishes inside the lead, so the digit is gone before capture begins.
    expect(COUNTDOWN_TIMING.fadeOutMs + COUNTDOWN_TIMING.settleMs).toBeLessThan(COUNTDOWN_TIMING.overlayLeadMs);
  });
});
