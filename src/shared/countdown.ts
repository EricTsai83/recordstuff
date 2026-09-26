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
 * An 88 × 88 pt window 16 pt from the right edge of the work area and 12 pt
 * below its top, drawing only the digit: no background, box, border, ring or
 * blur. Its own outline and shadows carry legibility over light and dark
 * content. The maintainer chose 28% from drafts at 80, 55, 40 and 28%.
 */
export const COUNTDOWN_OVERLAY = {
  sizePt: 88,
  rightInsetPt: 16,
  topInsetPt: 12,
  font: {
    family: 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif',
    weight: 600,
    sizePt: 56,
  },
  digit: "rgba(255, 255, 255, 0.28)",
  outline: { widthPx: 1, color: "rgba(0, 0, 0, 0.10)" },
  shadow: "0 0 1px rgba(0, 0, 0, 0.20), 0 1px 3px rgba(0, 0, 0, 0.14), 0 0 14px rgba(0, 0, 0, 0.08)",
  /** `prefers-reduced-transparency`: an opaque digit with a stronger outline, still without a background. */
  reducedTransparency: {
    digit: "rgba(255, 255, 255, 1)",
    outline: { widthPx: 1.5, color: "rgba(0, 0, 0, 0.45)" },
  },
} as const;

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The overlay window's bounds inside a display's work area, in points. */
export function overlayBounds(workArea: Rectangle): Rectangle {
  const { sizePt, rightInsetPt, topInsetPt } = COUNTDOWN_OVERLAY;
  return {
    x: Math.round(workArea.x + workArea.width - rightInsetPt - sizePt),
    y: Math.round(workArea.y + topInsetPt),
    width: sizePt,
    height: sizePt,
  };
}

/** A digit to draw, or `null` to fade the current one out. */
export type CountdownValue = number | null;

/** What the overlay preload exposes: main sends values; the page only renders them. */
export interface CountdownBridge {
  onValue(callback: (value: CountdownValue) => void): void;
}

export const COUNTDOWN_VALUE_CHANNEL = "countdown:value";
