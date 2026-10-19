/**
 * The Recording Studio's level meters (plan 075, D19): each input's level as it arrives, before muting, from about
 * 60 dB below full scale to full scale, and its mute. The page asks main for levels only while a meter is shown and
 * the window is in sight; one subscription serves every meter. The Recording tab's Input level (plan 079, D1) is drawn
 * the same way from the chosen input's levels between recordings, which main gives only to a focused window.
 */
import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type { MicrophoneLevel, SettingsGroup, StudioLevels } from "../../../shared/settings-panel";
import { translate } from "../../../shared/i18n";
import { Button } from "../../components/ui/button";
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

/** Watches the chosen input while an Input level is shown and the window is in sight (plan 079, D1). */
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
export function decibels(peak: number): number {
  return peak > 0 ? Math.min(0, Math.max(FLOOR_DB, 20 * Math.log10(peak))) : FLOOR_DB;
}

/** How often the level is said to assistive technology, at most: 4 times a second, not each level. */
const SPOKEN_MS = 250;

/**
 * Draws `source`'s level into the meter's elements as it comes, up at once and falling back slowly with time, as
 * meters do, also when no level comes (an input that delivers nothing in silence); at the floor while `off`, so a next
 * recording starts from silence. The elements are written directly, a transform for the bar, and React renders
 * nothing per level: at 15 levels and 15 steps a second, a render each cost the page more than the preview it shows.
 */
function useMeter(track: HTMLDivElement | null, cover: HTMLDivElement | null, source: "system" | "microphone" | "input", off: boolean): void {
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
    let heard = FLOOR_DB, frameAt = performance.now();
    const stop = source === "input"
      ? subscribeInput((level) => { heard = Math.max(heard, decibels(level.peak)); })
      : subscribe((levels) => {
        heard = Math.max(heard, decibels(source === "system" ? levels.system : levels.microphone ?? 0));
      });
    const stopFrames = onFrame(() => {
      const now = performance.now();
      const fallen = Math.max(FLOOR_DB, shown - FALL_DB_PER_SECOND * (now - frameAt) / 1000);
      frameAt = now;
      // A level rising is said at once; only its falling back is held to SPOKEN_MS, which a later frame says.
      const rose = heard > fallen;
      shown = Math.max(heard, fallen);
      heard = FLOOR_DB;
      paint(rose);
    });
    return () => { stop(); stopFrames(); };
  }, [track, cover, source, off]);
}

export function AudioMeter({ group, source, muted, disabled, describedBy }: {
  group: SettingsGroup; source: "system" | "microphone"; muted: boolean; disabled: boolean; describedBy: string | undefined;
}) {
  const id = `setting-${group.id}`;
  const [track, setTrack] = useState<HTMLDivElement | null>(null);
  const [cover, setCover] = useState<HTMLDivElement | null>(null);
  useMeter(track, cover, source, disabled);
  const language = model.view?.language;
  const Icon = muted ? VolumeX : Volume2;
  return (
    <div className="audio-meter" data-muted={muted || undefined}>
      {/* The value is written by useMeter as levels come, never by a render. */}
      <div
        ref={setTrack}
        className="audio-meter-track"
        role="meter"
        aria-labelledby={`${id}-label`}
        aria-valuemin={FLOOR_DB}
        aria-valuemax={0}
        aria-valuenow={FLOOR_DB}
      >
        {/* The colours stay where their levels are; what the level has not reached is covered. */}
        <div className="audio-meter-fill" />
        <div ref={setCover} className="audio-meter-cover" />
      </div>
      <Button
        id={id}
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        aria-pressed={muted}
        aria-label={translate(muted ? "Unmute {label}" : "Mute {label}", language, { label: group.label })}
        aria-describedby={describedBy}
        onClick={() => void model.choose(group.id, muted ? "unmute" : "mute", id)}
      >
        <Icon />
      </Button>
    </div>
  );
}

/**
 * The Recording tab's Input level (plan 079, D1): the chosen input's peak between recordings, so the user can check
 * that it hears them without recording; at the floor while disabled (a recording runs, whose own levels the Recording
 * Studio shows).
 */
export function InputMeter({ group, disabled, describedBy }: { group: SettingsGroup; disabled: boolean; describedBy: string | undefined }) {
  const id = `setting-${group.id}`;
  const [track, setTrack] = useState<HTMLDivElement | null>(null);
  const [cover, setCover] = useState<HTMLDivElement | null>(null);
  useMeter(track, cover, "input", disabled);
  return (
    <div className="audio-meter">
      {/* The value is written by useMeter as levels come, never by a render. */}
      <div
        ref={setTrack}
        id={id}
        className="audio-meter-track"
        role="meter"
        aria-labelledby={`${id}-label`}
        aria-describedby={describedBy}
        aria-valuemin={FLOOR_DB}
        aria-valuemax={0}
        aria-valuenow={FLOOR_DB}
      >
        <div className="audio-meter-fill" />
        <div ref={setCover} className="audio-meter-cover" />
      </div>
    </div>
  );
}
