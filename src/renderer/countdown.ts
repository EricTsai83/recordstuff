/**
 * The countdown overlay page (plan 040): renders the digit main sends and
 * nothing else. It cannot reply; main times the fades and destroys the window.
 */
import { COUNTDOWN_OVERLAY, COUNTDOWN_TIMING, type CountdownBridge, type CountdownValue } from "../shared/countdown";

declare global {
  interface Window {
    countdown?: CountdownBridge;
  }
}

/** Custom properties for countdown.css; CSSOM writes are allowed under the page's CSP. */
export function overlayStyle(): Record<string, string> {
  const { font, digit, outline, shadow, reducedTransparency } = COUNTDOWN_OVERLAY;
  return {
    "--font-family": font.family,
    "--font-weight": String(font.weight),
    "--font-size": `${font.sizePt}px`,
    "--digit": digit,
    "--outline-width": `${outline.widthPx}px`,
    "--outline": outline.color,
    "--shadow": shadow,
    "--digit-opaque": reducedTransparency.digit,
    "--outline-width-strong": `${reducedTransparency.outline.widthPx}px`,
    "--outline-strong": reducedTransparency.outline.color,
    "--fade-in": `${COUNTDOWN_TIMING.fadeInMs}ms`,
    "--fade-out": `${COUNTDOWN_TIMING.fadeOutMs}ms`,
    "--crossfade": `${COUNTDOWN_TIMING.crossfadeMs}ms`,
  };
}

/** Two stacked faces crossfade between digits; `null` fades the whole stage out. */
export function createCountdownView(stage: HTMLElement): (value: CountdownValue) => void {
  const faces = Array.from(stage.querySelectorAll<HTMLElement>(".face"));
  let front = 0;
  let shown: number | undefined;
  return (value) => {
    if (value === null) {
      stage.classList.remove("visible");
      return;
    }
    if (value === shown) return;
    const next = shown === undefined ? front : 1 - front;
    const face = faces[next];
    if (!face) return;
    face.textContent = String(value);
    face.classList.add("front");
    if (next !== front) faces[front]?.classList.remove("front");
    front = next;
    shown = value;
    stage.classList.add("visible");
  };
}

if (typeof window !== "undefined" && window.countdown) {
  for (const [name, value] of Object.entries(overlayStyle())) document.documentElement.style.setProperty(name, value);
  const stage = document.getElementById("stage");
  if (stage) window.countdown.onValue(createCountdownView(stage));
}
