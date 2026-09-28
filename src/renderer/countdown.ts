/**
 * The countdown overlay page (plan 040): renders the digit main sends and
 * nothing else. It cannot reply; main times the fades and destroys the window.
 * When the page is loaded with the sound flag (plan 046) it also plays a tick
 * with each new digit, so main keeps every timing decision; destroying the
 * window silences it.
 */
import {
  COUNTDOWN_OVERLAY,
  COUNTDOWN_SOUND_QUERY,
  COUNTDOWN_TICK,
  COUNTDOWN_TIMING,
  tickFrequencyHz,
  type CountdownBridge,
  type CountdownValue,
} from "../shared/countdown";

declare global {
  interface Window {
    countdown?: CountdownBridge;
  }
}

/** A length drawn at the reference digit size, relative to the digit's font size. */
function em(px: number): string {
  return px === 0 ? "0" : `${px / COUNTDOWN_OVERLAY.referenceFontPt}em`;
}

/**
 * Custom properties for countdown.css; CSSOM writes are allowed under the
 * page's CSP. Main sizes the window for the recorded display (plan 045), so
 * the digit follows the window through `vmin` and its outline and shadows
 * follow the digit through `em`.
 */
export function overlayStyle(): Record<string, string> {
  const { font, digit, outline, shadows, reducedTransparency, windowPerFont } = COUNTDOWN_OVERLAY;
  return {
    "--font-family": font.family,
    "--font-weight": String(font.weight),
    "--font-size": `${100 / windowPerFont}vmin`,
    "--digit": digit,
    "--outline-width": em(outline.widthPx),
    "--outline": outline.color,
    "--shadow": shadows.map((s) => `${em(s.xPx)} ${em(s.yPx)} ${em(s.blurPx)} ${s.color}`).join(", "),
    "--digit-opaque": reducedTransparency.digit,
    "--outline-width-strong": em(reducedTransparency.outline.widthPx),
    "--outline-strong": reducedTransparency.outline.color,
    "--fade-in": `${COUNTDOWN_TIMING.fadeInMs}ms`,
    "--fade-out": `${COUNTDOWN_TIMING.fadeOutMs}ms`,
    "--crossfade": `${COUNTDOWN_TIMING.crossfadeMs}ms`,
  };
}

/** The part of Web Audio a tick uses, so tests can pass a fake context. */
export type TickContext = Pick<BaseAudioContext, "currentTime" | "destination" | "createOscillator" | "createGain">;

/**
 * One tick for a digit, synthesized from the shared values: a sine with a
 * quiet partial, a short attack and an exponential release, stopped when it
 * has faded. No audio file, so the page's CSP is unchanged.
 */
export function playTick(context: TickContext, digit: number): void {
  const { waveform, attackMs, durationMs, peak, partial } = COUNTDOWN_TICK;
  const at = context.currentTime;
  const end = at + durationMs / 1000;
  const frequency = tickFrequencyHz(digit);
  const out = context.createGain();
  out.connect(context.destination);
  out.gain.setValueAtTime(0, at);
  out.gain.linearRampToValueAtTime(peak, at + attackMs / 1000);
  out.gain.exponentialRampToValueAtTime(0.0001, end);
  const tone = context.createOscillator();
  tone.type = waveform;
  tone.frequency.setValueAtTime(frequency, at);
  tone.connect(out);
  const overtone = context.createOscillator();
  const overtoneGain = context.createGain();
  overtone.type = waveform;
  overtone.frequency.setValueAtTime(frequency * partial.ratio, at);
  overtoneGain.gain.setValueAtTime(partial.level, at);
  overtoneGain.gain.exponentialRampToValueAtTime(0.001, at + (durationMs / 1000) * partial.durationFraction);
  overtone.connect(overtoneGain);
  overtoneGain.connect(out);
  for (const oscillator of [tone, overtone]) {
    oscillator.start(at);
    oscillator.stop(end);
  }
}

/** Whether main loaded this page with the tick on. */
export function soundRequested(search: string): boolean {
  return new URLSearchParams(search).get(COUNTDOWN_SOUND_QUERY) === "1";
}

/**
 * Two stacked faces crossfade between digits; `null` fades the whole stage
 * out. `onDigit` runs once for each new digit, never for a repeated value or
 * `null`.
 */
export function createCountdownView(stage: HTMLElement, onDigit?: (digit: number) => void): (value: CountdownValue) => void {
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
    onDigit?.(value);
  };
}

if (typeof window !== "undefined" && window.countdown) {
  for (const [name, value] of Object.entries(overlayStyle())) document.documentElement.style.setProperty(name, value);
  const stage = document.getElementById("stage");
  // One context at load, so the output is warm before the first digit. The
  // window's autoplay policy lets it run without a user gesture.
  let context: AudioContext | undefined;
  try {
    if (soundRequested(location.search)) context = new AudioContext();
  } catch {
    // Without audio the countdown continues silently.
  }
  const tick = context ? (digit: number): void => {
    try {
      if (context.state === "suspended") void context.resume();
      playTick(context, digit);
    } catch {
      // A failed tick never stops the digit.
    }
  } : undefined;
  if (stage) window.countdown.onValue(createCountdownView(stage, tick));
}
