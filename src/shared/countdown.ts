/**
 * The pre-recording countdown (plan 040, docs/system-design/recording.md#countdown):
 * its choices, default, timing and overlay appearance in one place. Every
 * value is an initial target; tune one only with written evidence. Shared by
 * main (settings, recorder, overlay window) and the overlay page, so it has
 * no Electron or DOM import.
 */

export const COUNTDOWN_CHOICES = [0, 3, 5, 10] as const;
/** Whole seconds before capture begins; 0 is Off. */
export type CountdownSeconds = (typeof COUNTDOWN_CHOICES)[number];
/** Also what a settings file written before the countdown existed reads as. */
export const DEFAULT_COUNTDOWN: CountdownSeconds = 3;

export function isCountdownSeconds(value: unknown): value is CountdownSeconds {
  return (COUNTDOWN_CHOICES as readonly unknown[]).includes(value);
}

export const COUNTDOWN_TIMING = {
  /** One digit per second, each measured from the same monotonic anchor. */
  tickMs: 1000,
  /**
   * The overlay is asked to leave this long before capture begins, so the
   * tail of its fade cannot land in the first frames (Cap's extension leaves
   * 140 ms with a 220 ms fade; this keeps the fade shorter than the lead).
   */
  overlayLeadMs: 300,
  /** Longest wait for the overlay to confirm it is gone; afterwards it is destroyed and capture proceeds. */
  dismissTimeoutMs: 500,
  fadeInMs: 120,
  crossfadeMs: 150,
  /** Finishes before the window is destroyed; main waits this plus `settleMs` before destroying it. */
  fadeOutMs: 120,
  /** About two frames at 60 Hz for the last faded frame to reach the screen. */
  settleMs: 34,
} as const;

/**
 * A square window 16 pt from the right edge of the work area and 12 pt below
 * its top, drawing only the digit: no background, box, border, ring or blur.
 * Its own outline and shadows carry legibility over light and dark content.
 * The maintainer chose 28% from drafts at 80, 55, 40 and 28%.
 *
 * The digit scales with the recorded display (plan 045): its font size is a
 * fraction of the display's shorter side in points, and the window keeps
 * 040's 88 pt window around a 56 pt digit, so "10" still fits. The window's
 * size is all the page receives; it derives the font from it.
 */
export const COUNTDOWN_OVERLAY = {
  /** The maintainer chose 14% from drafts at 8, 10, 12 and 14% (plan 045); the initial target was 10%. */
  fontFraction: 0.14,
  /** 040's fixed size, so no display gets a smaller digit (initial target). */
  minFontPt: 56,
  /** Bounds unusually large displays; a short side of about 1543 pt reaches it (initial target). */
  maxFontPt: 216,
  /** 040's 88 pt window around its 56 pt digit. */
  windowPerFont: 88 / 56,
  rightInsetPt: 16,
  topInsetPt: 12,
  font: {
    family: 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif',
    weight: 600,
  },
  /** The digit size the outline and shadow values below were drawn at; the page scales them with the font. */
  referenceFontPt: 56,
  digit: "rgba(255, 255, 255, 0.28)",
  outline: { widthPx: 1, color: "rgba(0, 0, 0, 0.10)" },
  shadows: [
    { xPx: 0, yPx: 0, blurPx: 1, color: "rgba(0, 0, 0, 0.20)" },
    { xPx: 0, yPx: 1, blurPx: 3, color: "rgba(0, 0, 0, 0.14)" },
    { xPx: 0, yPx: 0, blurPx: 14, color: "rgba(0, 0, 0, 0.08)" },
  ],
  /** `prefers-reduced-transparency`: an opaque digit with a stronger outline, still without a background. */
  reducedTransparency: {
    digit: "rgba(255, 255, 255, 1)",
    outline: { widthPx: 1.5, color: "rgba(0, 0, 0, 0.45)" },
  },
} as const;

/**
 * The optional tick that plays with each digit (plan 046, docs/system-design/recording.md#countdown).
 * The maintainer chose a soft marimba-like note at −20 dBFS, the last digit a
 * fifth higher, from drafts of a sine tick, a woodblock-like click and this
 * note at two levels. Neither pitch nor its partial is near the test
 * material's 660 Hz tone or its harmonics, so the analyzer can tell them
 * apart. It ends long before the overlay leaves and capture begins, so the
 * recording stays clean by time separation, not by `restrictOwnAudio`.
 */
export const COUNTDOWN_TICK = {
  waveform: "sine",
  frequencyHz: 523,
  /** The digit 1 plays a fifth higher. */
  lastDigitRatio: 1.5,
  /** A quiet partial at four times the pitch gives the marimba-like colour; it fades over the first 40%. */
  partial: { ratio: 4, level: 0.18, durationFraction: 0.4 },
  attackMs: 4,
  /** Attack plus exponential release; nothing sounds after it. */
  durationMs: 140,
  /** −20 dBFS. */
  peak: 0.1,
} as const;

/** What a settings file without the field reads as: the maintainer chose on, also for existing users (plan 046). */
export const DEFAULT_COUNTDOWN_SOUND = true;

/** The tick's pitch for a digit: the last one, 1, is a fifth higher. */
export function tickFrequencyHz(digit: number): number {
  return digit === 1 ? COUNTDOWN_TICK.frequencyHz * COUNTDOWN_TICK.lastDigitRatio : COUNTDOWN_TICK.frequencyHz;
}

/** The overlay page's query parameter that turns the tick on; the page has no other input than main's values. */
export const COUNTDOWN_SOUND_QUERY = "sound";

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The digit's font size for a display, in points, before the window is rounded. */
export function overlayFontPt(displayBounds: Rectangle): number {
  const { fontFraction, minFontPt, maxFontPt } = COUNTDOWN_OVERLAY;
  const shortSide = Math.min(displayBounds.width, displayBounds.height);
  return Math.min(maxFontPt, Math.max(minFontPt, fontFraction * shortSide));
}

/**
 * The overlay window's bounds on a display, in whole points: sized from the
 * whole display (so the Dock cannot change it) and placed inside its work area.
 */
export function overlayBounds(displayBounds: Rectangle, workArea: Rectangle): Rectangle {
  const { windowPerFont, rightInsetPt, topInsetPt } = COUNTDOWN_OVERLAY;
  const side = Math.round(overlayFontPt(displayBounds) * windowPerFont);
  return {
    x: Math.round(workArea.x + workArea.width - rightInsetPt - side),
    y: Math.round(workArea.y + topInsetPt),
    width: side,
    height: side,
  };
}

/** A digit to draw, or `null` to fade the current one out. */
export type CountdownValue = number | null;

/** What the overlay preload exposes: main sends values; the page only renders them. */
export interface CountdownBridge {
  onValue(callback: (value: CountdownValue) => void): () => void;
}

export const COUNTDOWN_VALUE_CHANNEL = "countdown:value";
