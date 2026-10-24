/**
 * A slider row: it moves with the pointer or the arrow keys, shows its value beside it, and saves the value let go
 * of.
 */
import type { SettingsGroup } from "../../../../shared/settings-panel";
import { usePendingValue } from "../../../lib/use-pending-value";
import { Slider } from "../../../components/ui/slider";
import { VOLUME_FADER_MAX, volumeFromFader, volumeToFader } from "../../../../shared/audio-volume";
import * as model from "../../settings-controller";

/**
 * A slider row (plan 075's camera size and rounding): it moves with the pointer or the arrow keys and shows the value
 * beside it, and the value let go of is the choice sent to main, so one drag is one save. A volume's slider puts 100%
 * in the middle (`scale: "volume"`): the track moves by fader positions, the value shown and sent is the volume.
 */
export function SliderSetting({ id, group, slider, disabled, describedBy }: {
  id: string; group: SettingsGroup; slider: NonNullable<SettingsGroup["slider"]>; disabled: boolean; describedBy?: string | undefined;
}) {
  const { shown, move, commit } = usePendingValue(slider.value);
  const text = `${shown}%`;
  const volume = slider.scale === "volume";
  const toTrack = (value: number): number => (volume ? volumeToFader(value) : value);
  const fromTrack = (value: number): number => (volume ? volumeFromFader(value) : value);
  return (
    <div className="slider-setting">
      <Slider
        id={id}
        className="slider-setting-track"
        value={[toTrack(shown)]}
        min={volume ? 0 : slider.min}
        max={volume ? VOLUME_FADER_MAX : slider.max}
        step={volume ? 1 : slider.step}
        disabled={disabled}
        thumbProps={{ "aria-label": group.label, "aria-valuetext": text, ...(describedBy ? { "aria-describedby": describedBy } : {}) }}
        onValueChange={(value) => { const next = Array.isArray(value) ? value[0] : value; move(next === undefined ? undefined : fromTrack(next)); }}
        onValueCommitted={(value) => {
          const position = Array.isArray(value) ? value[0] : value;
          const next = position === undefined ? undefined : fromTrack(position);
          if (next === undefined) return move(undefined);
          // The value let go of stays shown while it saves, so a key held down goes on from it.
          commit(next, (value) => model.choose(group.id, String(value), id));
        }}
      />
      <span className="slider-setting-value" aria-hidden="true">{text}</span>
    </div>
  );
}
