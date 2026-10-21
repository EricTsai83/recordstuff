/**
 * A slider row: it moves with the pointer or the arrow keys, shows its value beside it, and saves the value let go
 * of.
 */
import type { SettingsGroup } from "../../../../shared/settings-panel";
import { usePendingValue } from "../../../lib/use-pending-value";
import { Slider } from "../../../components/ui/slider";
import * as model from "../../settings-controller";

/**
 * A slider row (plan 075's camera size and rounding): it moves with the pointer or the arrow keys and shows the value
 * beside it, and the value let go of is the choice sent to main, so one drag is one save.
 */
export function SliderSetting({ id, group, slider, disabled, describedBy }: {
  id: string; group: SettingsGroup; slider: NonNullable<SettingsGroup["slider"]>; disabled: boolean; describedBy?: string | undefined;
}) {
  const { shown, move, commit } = usePendingValue(slider.value);
  const text = `${shown}%`;
  return (
    <div className="slider-setting">
      <Slider
        id={id}
        className="slider-setting-track"
        value={[shown]}
        min={slider.min}
        max={slider.max}
        step={slider.step}
        disabled={disabled}
        thumbProps={{ "aria-label": group.label, "aria-valuetext": text, ...(describedBy ? { "aria-describedby": describedBy } : {}) }}
        onValueChange={(value) => move(Array.isArray(value) ? value[0] : value)}
        onValueCommitted={(value) => {
          const next = Array.isArray(value) ? value[0] : value;
          if (next === undefined) return move(undefined);
          // The value let go of stays shown while it saves, so a key held down goes on from it.
          commit(next, (value) => model.choose(group.id, String(value), id));
        }}
      />
      <span className="slider-setting-value" aria-hidden="true">{text}</span>
    </div>
  );
}
