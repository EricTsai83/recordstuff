/**
 * The Recording Studio's level meters (plan 075, D19): each input's level as it arrives, before muting, from about
 * 60 dB below full scale to full scale, and its mute. The page asks main for levels only while a meter is shown and
 * the window is in sight; one subscription serves every meter. The Recording tab's Test microphone (plan 079, D1) draws
 * the same way the chosen input's levels between recordings, which main gives only to a focused window.
 */
import { useEffect, useState } from "react";
import type { MicrophoneLevel, SettingsGroup, StudioLevels } from "../../../shared/settings-panel";
import * as model from "../settings-controller";
import { onFrame } from "./frame-clock";
import { onLevels } from "./studio-feed";

/** The meter's floor: quieter is shown as nothing. */
const FLOOR_DB = -60;
/** How fast a shown level falls back: 20 dB a second, a step each frame of the Studio's clock, however far apart. */
const FALL_DB_PER_SECOND = 20;

const listeners = new Set<(levels: StudioLevels) => void>();
let unsubscribe: (() => void) | undefined;
let watching = false;

/** Watches while any meter is shown and the window is in sight. */
function rewatch(): void {
  const wanted = listeners.size > 0 && document.visibilityState === "visible";
  if (wanted === watching) return;
  watching = wanted;
  void window.settings.watchLevels?.(wanted).catch(() => undefined);
}

function subscribe(listener: (levels: StudioLevels) => void): () => void {
  listeners.add(listener);
  if (!unsubscribe) {
    // On the Studio's port, which the preview's frames share (plan 081): main does not pass them on.
    unsubscribe = onLevels((levels) => { for (const each of listeners) each(levels); });
    document.addEventListener("visibilitychange", rewatch);
  }
  rewatch();
  return () => {
    listeners.delete(listener);
    rewatch();
    if (listeners.size === 0) {
      unsubscribe?.();
      unsubscribe = undefined;
      document.removeEventListener("visibilitychange", rewatch);
    }
  };
}

const inputListeners = new Set<(level: MicrophoneLevel) => void>();
let inputUnsubscribe: (() => void) | undefined;
let inputWatching = false;

/** Watches the chosen input while Test microphone's meter is shown and the window is in sight (plan 079, D1). */
function rewatchInput(): void {
  const wanted = inputListeners.size > 0 && document.visibilityState === "visible";
  if (wanted === inputWatching) return;
  inputWatching = wanted;
  void window.settings.watchMicrophoneLevel?.(wanted).catch(() => undefined);
}

function subscribeInput(listener: (level: MicrophoneLevel) => void): () => void {
  inputListeners.add(listener);
  if (!inputUnsubscribe) {
    inputUnsubscribe = window.settings.onMicrophoneLevel?.((level) => { for (const each of inputListeners) each(level); });
    document.addEventListener("visibilitychange", rewatchInput);
  }
  rewatchInput();
  return () => {
    inputListeners.delete(listener);
    rewatchInput();
    if (inputListeners.size === 0) {
      inputUnsubscribe?.();
      inputUnsubscribe = undefined;
      document.removeEventListener("visibilitychange", rewatchInput);
    }
  };
}

/** A linear peak in dB below full scale, from the floor for silence to 0 for full scale and past it (a loud sum). */
function decibels(peak: number): number {
  return peak > 0 ? Math.min(0, Math.max(FLOOR_DB, 20 * Math.log10(peak))) : FLOOR_DB;
}

/**
 * Test microphone's level in words (2026-10-28, the maintainer's request: a level in dB means nothing to most users),
 * by the bands the meter's colours draw: green up to −12 dB, amber to −3 dB, red above it.
 */
type Loudness = "silent" | "quiet" | "good" | "loud";
const LOUDNESS_WORDS = { silent: "No sound", quiet: "Too quiet", good: "Good level", loud: "Too loud" } as const;
function loudness(db: number): Loudness {
  return db <= -50 ? "silent" : db < -30 ? "quiet" : db <= -3 ? "good" : "loud";
}
/** The words hold a level through the pauses of speech, then fall back faster than the bar, so silence is said soon. */
const HELD_MS = 1000;
const HELD_FALL_DB_PER_SECOND = 30;

/** How often the level is said to assistive technology, at most: 4 times a second, not each level. */
const SPOKEN_MS = 250;

/**
 * Draws `source`'s level into the meter's elements as it comes, up at once and falling back slowly with time, as
 * meters do, also when no level comes (an input that delivers nothing in silence); at the floor while `off`, so a next
 * recording starts from silence. The elements are written directly, a transform for the bar and the `readout`'s words,
 * and React renders nothing per level: at 15 levels and 15 steps a second, a render each cost the page more than the
 * preview it shows.
 */
function useMeter(track: HTMLDivElement | null, cover: HTMLDivElement | null, source: "system" | "microphone" | "input", off: boolean,
  readout?: HTMLElement | null): void {
  useEffect(() => {
    if (!track || !cover) return;
    let shown = FLOOR_DB, drawn = Number.NaN, spoken = Number.NaN, spokenAt = 0;
    // To the track's pixel: a change the eye cannot see composes no frame (plan 081).
    const pixels = Math.max(1, track.clientWidth);
    const paint = (force = false): void => {
      const covered = Math.round((1 - (shown - FLOOR_DB) / -FLOOR_DB) * pixels) / pixels;
      if (covered !== drawn) { cover.style.transform = `scaleX(${covered})`; drawn = covered; }
      const rounded = Math.round(shown), now = performance.now();
      if (rounded !== spoken && (force || now - spokenAt >= SPOKEN_MS)) {
        track.setAttribute("aria-valuenow", String(rounded));
        if (off) track.removeAttribute("aria-valuetext");
        else track.setAttribute("aria-valuetext", `${rounded} dB`);
        spoken = rounded;
        spokenAt = now;
      }
    };
    paint(true);
    if (off) return;
    // Levels only raise what the next frame shows; frames fall back and paint, on the Studio's one clock.
    let heard = FLOOR_DB, frameAt = performance.now(), held = FLOOR_DB, heldAt = 0, said: Loudness | undefined;
    const stop = source === "input"
      ? subscribeInput((level) => { heard = Math.max(heard, decibels(level.peak)); })
      : subscribe((levels) => {
        heard = Math.max(heard, decibels(source === "system" ? levels.system : levels.microphone ?? 0));
      });
    const stopFrames = onFrame(() => {
      const now = performance.now(), seconds = (now - frameAt) / 1000;
      const fallen = Math.max(FLOOR_DB, shown - FALL_DB_PER_SECOND * seconds);
      frameAt = now;
      // A level rising is said at once; only its falling back is held to SPOKEN_MS, which a later frame says.
      const rose = heard > fallen;
      shown = Math.max(heard, fallen);
      // The words follow a level held longer than the bar's, so a breath between words does not read as silence.
      if (shown >= held) { held = shown; heldAt = now; } else if (now - heldAt > HELD_MS) held = Math.max(shown, held - HELD_FALL_DB_PER_SECOND * seconds);
      const verdict = loudness(held);
      if (readout && verdict !== said) {
        readout.textContent = model.text(LOUDNESS_WORDS[verdict]);
        readout.dataset.loudness = verdict;
        said = verdict;
      }
      heard = FLOOR_DB;
      paint(rose);
    });
    return () => { stop(); stopFrames(); };
  }, [track, cover, source, off, readout]);
}

/**
 * An input's level, as it arrives and before muting; greyed while the input is not recorded. Whether it is recorded
 * is the Studio's speaker toggle beside the input's name (studio.tsx), not part of the meter (2026-10-31).
 */
export function AudioMeter({ group, source, muted, disabled, describedBy }: {
  group: SettingsGroup; source: "system" | "microphone"; muted: boolean; disabled: boolean; describedBy: string | undefined;
}) {
  const id = `setting-${group.id}`;
  const [track, setTrack] = useState<HTMLDivElement | null>(null);
  const [cover, setCover] = useState<HTMLDivElement | null>(null);
  useMeter(track, cover, source, disabled);
  return (
    <div className="audio-meter" data-muted={muted || undefined}>
      {/* The value is written by useMeter as levels come, never by a render. */}
      <div
        ref={setTrack}
        className="audio-meter-track"
        role="meter"
        aria-labelledby={`${id}-label`}
        aria-describedby={describedBy}
        aria-valuemin={FLOOR_DB}
        aria-valuemax={0}
        aria-valuenow={FLOOR_DB}
      >
        {/* The colours stay where their levels are; what the level has not reached is covered. */}
        <div className="audio-meter-fill" />
        <div ref={setCover} className="audio-meter-cover" />
      </div>
    </div>
  );
}

/**
 * Test microphone's meter (plan 079, D1): the chosen input's peak between recordings, so the user can check that it
 * hears them without recording. Only a meter not `off` asks main for the levels; an `off` one shows where they will
 * be, hidden from assistive technology. `segmented`, the bar is drawn in steps, with its level in words beside it when
 * `readout`.
 */
export function InputMeter({ segmented, readout, off = false }: { segmented?: boolean; readout?: boolean; off?: boolean }) {
  const [track, setTrack] = useState<HTMLDivElement | null>(null);
  const [cover, setCover] = useState<HTMLDivElement | null>(null);
  const [value, setValue] = useState<HTMLSpanElement | null>(null);
  useMeter(track, cover, "input", off, value);
  return (
    <div className="audio-meter input-meter" data-segmented={segmented || undefined} data-off={off || undefined} aria-hidden={off || undefined}>
      {/* The value is written by useMeter as levels come, never by a render. */}
      <div
        ref={setTrack}
        className="audio-meter-track"
        role="meter"
        aria-label={model.text("Input level")}
        aria-valuemin={FLOOR_DB}
        aria-valuemax={0}
        aria-valuenow={FLOOR_DB}
      >
        <div className="audio-meter-fill" />
        <div ref={setCover} className="audio-meter-cover" />
      </div>
      {readout && <span ref={setValue} className="input-meter-value" aria-hidden="true" />}
    </div>
  );
}
