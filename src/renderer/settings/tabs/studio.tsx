/**
 * The Recording Studio (plan 075, D19), laid out as OBS lays out its main window: the preview across the top, and under
 * it panels side by side, the camera's, the audio mixer and the controls, instead of a list of rows. Every control is
 * still a group main offers and answers (settings-model.ts), chosen the same way as anywhere in Settings.
 */
import { useEffect } from "react";
import { Camera, Eye, EyeOff, FlipHorizontal2 } from "lucide-react";
import type { SettingsGroup } from "../../../shared/settings-panel";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { ControlTooltip } from "../../components/control-tooltip";
import * as model from "../settings-controller";
import { CameraPreview } from "./camera-preview";
import { AudioMeter } from "./audio-meter";
import { SliderSetting, Action, Elapsed, Explanation } from "./preferences";

const groupOf = (id: string): SettingsGroup | undefined => model.view?.groups.find((group) => group.id === id && group.tab === "studio");
/** A group's control holds still while another setting saves, as Preferences' rows do. */
const held = (group: SettingsGroup): boolean => Boolean(model.saving && model.saving.group !== group.id);

/** A panel's failed choice, said under it, as a row says its own. */
function Failures({ groups }: { groups: (SettingsGroup | undefined)[] }) {
  const failed = groups.find((group) => group && model.failure?.group === group.id);
  return failed && model.failure ? <p className="studio-failure" role="alert">{model.failure.text}</p> : null;
}

/** An on/off group drawn as an icon button that is pressed while on: Mirror, and showing the camera while recording. */
function Toggle({ group, icon: Icon, offIcon: OffIcon }: { group: SettingsGroup; icon: typeof Eye; offIcon?: typeof Eye }) {
  const on = model.committed(group) === "on";
  const Shown = !on && OffIcon ? OffIcon : Icon;
  return (
    <ControlTooltip label={group.label}>
      <Button id={`setting-${group.id}`} variant="outline" size="sm" className="studio-toggle" aria-pressed={on}
        disabled={!group.enabled || held(group)} aria-label={group.label}
        aria-describedby={group.info ? `setting-${group.id}-info` : undefined}
        onClick={() => void model.choose(group.id, on ? "off" : "on", `setting-${group.id}`)}>
        <Shown aria-hidden="true" />
      </Button>
    </ControlTooltip>
  );
}

function CameraPanel() {
  const camera = groupOf("studioCamera");
  if (!camera) return null;
  const shown = groupOf("cameraShown");
  const ratio = groupOf("cameraRatio");
  const mirror = groupOf("cameraMirror");
  const sliders = ["cameraWidth", "cameraHeight", "cameraRounding"].map(groupOf);
  const ratioValue = ratio ? model.committed(ratio) : "";
  return (
    <section className="studio-panel" aria-labelledby="studio-camera-heading">
      <div className="studio-panel-head">
        <h2 id="studio-camera-heading"><Camera aria-hidden="true" />{camera.label}</h2>
        <Switch id={`setting-${camera.id}`} aria-labelledby="studio-camera-heading" checked={model.committed(camera) === "on"}
          disabled={!camera.enabled || held(camera)} aria-describedby={camera.note ? "setting-studioCamera-note" : undefined}
          onCheckedChange={(checked) => void model.choose(camera.id, checked ? "on" : "off", `setting-${camera.id}`)} />
      </div>
      {camera.note && <p id="setting-studioCamera-note" className="studio-note">{camera.note}</p>}
      <div className="studio-shape">
        {sliders.map((group) => group?.slider && (
          <div key={group.id} className="studio-shape-row">
            <span className="studio-label"><span id={`setting-${group.id}-label`}>{group.label}</span><Explanation group={group} /></span>
            <SliderSetting id={`setting-${group.id}`} group={group} slider={group.slider} disabled={!group.enabled || held(group)}
              describedBy={group.info ? `setting-${group.id}-info` : undefined} />
          </div>
        ))}
        {ratio && (
          <div className="studio-shape-row studio-ratio">
            <span id="setting-cameraRatio-label">{ratio.label}</span>
            <ToggleGroup id="setting-cameraRatio" className="segments w-full min-w-0" variant="segmented" size="segment" spacing={0.5}
              value={[ratioValue]} aria-labelledby="setting-cameraRatio-label"
              onValueChange={(values) => { if (values[0] && values[0] !== ratioValue) void model.choose(ratio.id, String(values[0]), `setting-cameraRatio-${values[0]}`); }}>
              {ratio.choices.map((choice) => (
                <ToggleGroupItem key={choice.id} id={`setting-cameraRatio-${choice.id}`} value={choice.id} aria-label={choice.label}
                  className="min-w-0 flex-1 px-1 text-xs"
                  // Back to the committed shape while another saves: the newer intent, which the group's change
                  // does not tell, as Preferences' segments have it.
                  onClick={() => {
                    if (model.saving?.group === ratio.id && model.saving.choice !== ratioValue && choice.id === ratioValue)
                      void model.choose(ratio.id, choice.id, `setting-cameraRatio-${choice.id}`);
                  }}
                  disabled={!ratio.enabled || !choice.enabled || held(ratio)}>{choice.label}</ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )}
        <div className="studio-toggles">
          {mirror?.info && <Explanation group={mirror} />}
          {mirror && <Toggle group={mirror} icon={FlipHorizontal2} />}
          {shown && <Toggle group={shown} icon={Eye} offIcon={EyeOff} />}
        </div>
      </div>
      <Failures groups={[camera, shown, ratio, mirror, ...sliders]} />
    </section>
  );
}

function AudioPanel() {
  const rows = ["systemAudio", "microphoneAudio"].map(groupOf).filter((group): group is SettingsGroup => Boolean(group?.meter));
  if (rows.length === 0) return null;
  const note = rows.find((group) => group.note)?.note;
  return (
    <section className="studio-panel" aria-labelledby="studio-audio-heading">
      <div className="studio-panel-head"><h2 id="studio-audio-heading">{rows[0]!.sectionHeading ?? model.text("Audio")}</h2></div>
      <div className="studio-mixer">
        {rows.map((group) => {
          // Its fader under its meter, as a mixer's channel has it (D21): the meter shows the level after it.
          const fader = groupOf(`${group.meter!.source}Gain`);
          return (
            <div key={group.id} className="studio-channel">
              <span id={`setting-${group.id}-label`}>{group.label}</span>
              <AudioMeter group={group} source={group.meter!.source} muted={model.committed(group) === "mute"}
                disabled={!group.enabled || held(group)} describedBy={note ? "studio-audio-note" : undefined} />
              {fader?.slider && <SliderSetting id={`setting-${fader.id}`} group={fader} slider={fader.slider} disabled={!fader.enabled || held(fader)} />}
            </div>
          );
        })}
      </div>
      {note && <p id="studio-audio-note" className="studio-note">{note}</p>}
      <Failures groups={[...rows, groupOf("systemGain"), groupOf("microphoneGain")]} />
    </section>
  );
}

function ControlsPanel() {
  const controls = groupOf("studioControls");
  if (!controls) return null;
  return (
    <section className="studio-panel studio-controls" aria-labelledby="studio-controls-heading">
      <div className="studio-panel-head"><h2 id="studio-controls-heading">{controls.sectionHeading ?? controls.label}</h2></div>
      <p className="studio-state" id="setting-studioControls-label">{controls.label}</p>
      {controls.note && <p className="studio-note" role="status">{controls.note}</p>}
      <div className="studio-buttons">
        {controls.elapsedSince && <Elapsed since={controls.elapsedSince} />}
        {controls.choices.map((choice) => <Action key={choice.id} group={controls} choice={choice} className={choice.id === "start" ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground dark:border-primary dark:bg-primary dark:hover:bg-primary/90" : undefined} />)}
      </div>
      <Failures groups={[controls]} />
    </section>
  );
}

/** Tells main the Studio is open while it is shown in a window in sight (D20: a Live preview lasts only so long). */
function useStudioOpen(): void {
  useEffect(() => {
    const tell = (): void => { void window.settings.watchStudio?.(document.visibilityState === "visible").catch(() => undefined); };
    tell();
    document.addEventListener("visibilitychange", tell);
    return () => {
      document.removeEventListener("visibilitychange", tell);
      void window.settings.watchStudio?.(false).catch(() => undefined);
    };
  }, []);
}

export function Studio() {
  useStudioOpen();
  const preview = groupOf("cameraPreview");
  return (
    <div className="studio">
      {preview?.cameraPreview && (
        <section className="studio-stage" aria-label={preview.label}>
          <CameraPreview group={preview} preview={preview.cameraPreview} disabled={!preview.enabled || held(preview)}
            describedBy={preview.info ? "setting-cameraPreview-info" : undefined} />
          {preview.info && <p id="setting-cameraPreview-info" className="studio-note">{preview.info}</p>}
          <Failures groups={[preview]} />
        </section>
      )}
      <div className="studio-panels">
        <CameraPanel />
        <AudioPanel />
        <ControlsPanel />
      </div>
    </div>
  );
}
