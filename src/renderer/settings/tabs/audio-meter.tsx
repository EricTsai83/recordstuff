/**
 * The Recording Studio's level meters (plan 075, D19): each input's level as it arrives, before muting, from about
 * 60 dB below full scale to full scale, and its mute. The page asks main for levels only while a meter is shown and
 * the window is in sight; one subscription serves every meter.
 */
import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type { SettingsGroup, StudioLevels } from "../../../shared/settings-panel";
import { translate } from "../../../shared/i18n";
import { Button } from "../../components/ui/button";
import * as model from "../settings-controller";

/** The meter's floor: quieter is shown as nothing. */
const FLOOR_DB = -60;
/** How fast a shown level falls back: about 20 dB a second, a step each fifteenth of a second. */
const FALL_DB = 1.3;
const FALL_MS = 1000 / 15;

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
    unsubscribe = window.settings.onLevels?.((levels) => { for (const each of listeners) each(levels); });
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

/** A linear peak in dB below full scale, from the floor for silence to 0 for full scale and past it (a loud sum). */
export function decibels(peak: number): number {
  return peak > 0 ? Math.min(0, Math.max(FLOOR_DB, 20 * Math.log10(peak))) : FLOOR_DB;
}

/**
 * `source`'s level in dB as shown: up at once, falling back slowly with time, as meters do, also when no level comes
 * (an input that delivers nothing in silence); back at the floor while `off`, so a next recording starts from silence.
 */
function useLevel(source: "system" | "microphone", off: boolean): number {
  const [shown, setShown] = useState(FLOOR_DB);
  useEffect(() => {
    if (off) {
      setShown(FLOOR_DB);
      return;
    }
    const stop = subscribe((levels) => {
      const peak = decibels(source === "system" ? levels.system : levels.microphone ?? 0);
      setShown((last) => Math.max(peak, last));
    });
    const fall = setInterval(() => setShown((last) => Math.max(FLOOR_DB, last - FALL_DB)), FALL_MS);
    return () => { stop(); clearInterval(fall); };
  }, [source, off]);
  return shown;
}

export function AudioMeter({ group, source, muted, disabled, describedBy }: {
  group: SettingsGroup; source: "system" | "microphone"; muted: boolean; disabled: boolean; describedBy: string | undefined;
}) {
  const id = `setting-${group.id}`;
  const level = useLevel(source, disabled);
  const fill = (level - FLOOR_DB) / -FLOOR_DB;
  const language = model.view?.language;
  const Icon = muted ? VolumeX : Volume2;
  return (
    <div className="audio-meter" data-muted={muted || undefined}>
      <div
        className="audio-meter-track"
        role="meter"
        aria-labelledby={`${id}-label`}
        aria-valuemin={FLOOR_DB}
        aria-valuemax={0}
        aria-valuenow={Math.round(disabled ? FLOOR_DB : level)}
        aria-valuetext={disabled ? undefined : `${Math.round(level)} dB`}
      >
        {/* The colours stay where their levels are; what the level has not reached is covered. */}
        <div className="audio-meter-fill" />
        <div className="audio-meter-cover" style={{ width: `${(1 - fill) * 100}%` }} />
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
