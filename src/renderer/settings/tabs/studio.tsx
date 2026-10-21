/**
 * The Recording Studio (plan 075, D19), laid out as OBS lays out its main window: the preview across the top, and under
 * it the recording controls as a bar, then panels side by side, the camera's and the audio mixer, instead of a list of rows. Every control is
 * still a group main offers and answers (settings-model.ts), chosen the same way as anywhere in Settings.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AudioLines, Camera, Eye, EyeOff, FlipHorizontal2, Radio, Square } from "lucide-react";
import type { SettingsGroup } from "../../../shared/settings-panel";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { ControlTooltip } from "../../components/control-tooltip";
import * as model from "../settings-controller";
import { CameraPreview } from "./camera-preview";
import { AudioMeter } from "./audio-meter";
import { SliderSetting, Elapsed } from "./preferences";
import { paceStudio } from "./studio-pace";

const groupOf = (id: string): SettingsGroup | undefined => model.view?.groups.find((group) => group.id === id && group.tab === "studio");

/** A panel's failed choice, said under it, as a row says its own. */
function Failures({ groups }: { groups: (SettingsGroup | undefined)[] }) {
  const failure = groups.map((group) => group && model.failureOf(group.id)).find(Boolean);
  return failure ? <p className="studio-failure" role="alert">{failure.text}</p> : null;
}

/** An on/off group drawn as an icon button that is pressed while on: Mirror, and showing the camera while recording. */
function Toggle({ group, icon: Icon, offIcon: OffIcon }: { group: SettingsGroup; icon: typeof Eye; offIcon?: typeof Eye }) {
  const on = model.committed(group) === "on";
  const Shown = !on && OffIcon ? OffIcon : Icon;
  return (
    <ControlTooltip label={group.label}>
      <Button id={`setting-${group.id}`} variant="outline" size="sm" className="studio-toggle" aria-pressed={on}
        disabled={!group.enabled} aria-label={group.label}
        aria-describedby={group.info ? `setting-${group.id}-info` : undefined}
        onClick={() => void model.choose(group.id, on ? "off" : "on", `setting-${group.id}`)}>
        <Shown aria-hidden="true" />
      </Button>
    </ControlTooltip>
  );
}

/** Pixels moved sideways on a field's name for each step of its value. */
const DRAG_PIXELS_PER_STEP = 1;

/**
 * A number field (2026-10-21, in place of the camera's sliders): its short name inside it, dragged sideways to change
 * the value as a slider is, the value typed or stepped with the arrow keys (Shift for ten). The value entered, stepped
 * to or let go of is the choice sent to main, so one drag is one save, and it stays shown while it saves.
 */
function NumberSetting({ group, field, disabled, describedBy }: {
  group: SettingsGroup; field: NonNullable<SettingsGroup["number"]>; disabled: boolean; describedBy?: string | undefined;
}) {
  const id = `setting-${group.id}`;
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [moving, setMoving] = useState<number | undefined>(undefined);
  const drag = useRef<{ pointer: number; x: number; from: number } | undefined>(undefined);
  const shown = moving ?? field.value;
  const unit = field.unit === "px" ? "px" : "%";
  const within = (value: number): number => Math.min(field.max, Math.max(field.min, Math.round(value)));
  const commit = (value: number): void => {
    setDraft(undefined);
    const next = within(value);
    if (next === field.value) return setMoving(undefined);
    setMoving(next);
    void model.choose(group.id, String(next), id).finally(() => setMoving((now) => (now === next ? undefined : now)));
  };
  const typed = (): void => {
    if (draft === undefined) return;
    if (draft === "") return setDraft(undefined);
    commit(Number(draft));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      return typed();
    }
    // Escape gives up what was typed first; with nothing typed it closes the window as anywhere else.
    if (event.key === "Escape" && draft !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      return setDraft(undefined);
    }
    const direction = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    commit((draft ? Number(draft) : shown) + direction * field.step * (event.shiftKey ? 10 : 1));
  };
  const onPointerDown = (event: PointerEvent<HTMLSpanElement>): void => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, from: shown };
  };
  const onPointerMove = (event: PointerEvent<HTMLSpanElement>): void => {
    const grip = drag.current;
    if (grip?.pointer !== event.pointerId) return;
    setDraft(undefined);
    setMoving(within(grip.from + Math.round((event.clientX - grip.x) / DRAG_PIXELS_PER_STEP) * field.step));
  };
  const onPointerUp = (event: PointerEvent<HTMLSpanElement>): void => {
    const grip = drag.current;
    if (grip?.pointer !== event.pointerId) return;
    drag.current = undefined;
    commit(moving ?? grip.from);
  };
  return (
    <label className="number-setting" data-disabled={disabled || undefined}>
      <ControlTooltip label={group.info ?? group.label}>
        <span className="number-setting-name" aria-hidden="true" onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = undefined; setMoving(undefined); }}>{field.short}</span>
      </ControlTooltip>
      <input id={id} type="text" inputMode="numeric" role="spinbutton" autoComplete="off" spellCheck={false} disabled={disabled}
        aria-label={group.label} aria-valuenow={shown} aria-valuemin={field.min} aria-valuemax={field.max}
        aria-valuetext={field.unit === "px" ? `${shown} px` : `${shown}%`}
        aria-describedby={[group.info ? `${id}-info` : undefined, describedBy].filter(Boolean).join(" ") || undefined}
        value={draft ?? String(shown)}
        onChange={(event) => setDraft(event.target.value.replace(/\D/g, "").slice(0, 5))}
        onBlur={typed} onKeyDown={onKeyDown} />
      <span className="number-setting-unit" aria-hidden="true">{unit}</span>
      {group.info && <span id={`${id}-info`} className="sr-only">{group.info}</span>}
    </label>
  );
}

function CameraPanel() {
  const camera = groupOf("studioCamera");
  if (!camera) return null;
  const shown = groupOf("cameraShown");
  const mirror = groupOf("cameraMirror");
  const fields = ["cameraWidth", "cameraHeight", "cameraRounding"].map(groupOf);
  // What the pixels are counted on: the recording's size on the display it would capture now.
  const pixels = fields[0]?.note;
  return (
    <section className="studio-panel" aria-labelledby="studio-camera-heading">
      <div className="studio-panel-head">
        <h2 id="studio-camera-heading"><Camera aria-hidden="true" />{camera.label}</h2>
        <Switch id={`setting-${camera.id}`} aria-labelledby="studio-camera-heading" checked={model.committed(camera) === "on"}
          disabled={!camera.enabled} aria-describedby={camera.note ? "setting-studioCamera-note" : undefined}
          onCheckedChange={(checked) => void model.choose(camera.id, checked ? "on" : "off", `setting-${camera.id}`)} />
      </div>
      {camera.note && <p id="setting-studioCamera-note" className="studio-note">{camera.note}</p>}
      <div className="studio-shape">
        <div className="studio-fields">
          {fields.map((group) => group?.number && (
            <NumberSetting key={group.id} group={group} field={group.number} disabled={!group.enabled}
              describedBy={pixels && group.number.unit === "px" ? "studio-camera-pixels" : undefined} />
          ))}
        </div>
        {pixels && <p id="studio-camera-pixels" className="studio-note">{pixels}</p>}
        <div className="studio-toggles">
          {mirror && <Toggle group={mirror} icon={FlipHorizontal2} />}
          {shown && <Toggle group={shown} icon={Eye} offIcon={EyeOff} />}
        </div>
      </div>
      <Failures groups={[camera, shown, mirror, ...fields]} />
    </section>
  );
}

function AudioPanel() {
  const rows = ["systemAudio", "microphoneAudio"].map(groupOf).filter((group): group is SettingsGroup => Boolean(group?.meter));
  if (rows.length === 0) return null;
  const note = rows.find((group) => group.note)?.note;
  return (
    <section className="studio-panel" aria-labelledby="studio-audio-heading">
      <div className="studio-panel-head"><h2 id="studio-audio-heading"><AudioLines aria-hidden="true" />{rows[0]!.sectionHeading ?? model.text("Audio")}</h2></div>
      <div className="studio-mixer">
        {rows.map((group) => {
          // The input's name with its level and mute beside it while a recording runs (2026-10-22): a short meter that
          // reads as the sound, apart from the fader under it, the one bar across the panel, which sets the volume.
          const fader = groupOf(`${group.meter!.source}Gain`);
          return (
            <div key={group.id} className="studio-channel">
              <div className="studio-channel-head">
                <span id={`setting-${group.id}-label`}>{group.label}</span>
                {group.enabled && <AudioMeter group={group} source={group.meter!.source} muted={model.committed(group) === "mute"}
                  disabled={!group.enabled} describedBy={note ? "studio-audio-note" : undefined} />}
              </div>
              {fader?.slider && <SliderSetting id={`setting-${fader.id}`} group={fader} slider={fader.slider} disabled={!fader.enabled} />}
            </div>
          );
        })}
      </div>
      {note && <p id="studio-audio-note" className="studio-note">{note}</p>}
      <Failures groups={[...rows, groupOf("systemGain"), groupOf("microphoneGain")]} />
    </section>
  );
}

/**
 * Live preview, a switch of the preview's own laid over the picture (2026-10-21): what the picture shows is not what
 * the recording does. It shows while the pointer is over the picture or it has the focus: off, in the picture's middle,
 * where it is easy to reach; on, in its corner, out of the way of what it shows (2026-10-22).
 */
function LiveSwitch({ live }: { live: SettingsGroup }) {
  const on = model.committed(live) === "on";
  return (
    <button type="button" role="switch" id={`setting-${live.id}`} className="studio-live" data-place={on ? "corner" : "centre"} aria-checked={on}
      disabled={!live.enabled} aria-describedby={live.note ? `setting-${live.id}-note` : undefined}
      onClick={() => void model.choose(live.id, on ? "off" : "on", `setting-${live.id}`)}>
      <Radio aria-hidden="true" />{live.label}
    </button>
  );
}

/**
 * The recording's one control (2026-10-21): Start while ready, Cancel under a short countdown line, and Stop with the
 * elapsed time while recording, so the button itself says a recording is under way. Start and Stop are drawn in ink, black
 * or in the dark theme white, the recording's red kept to Stop's square (2026-10-21). The phase is said aloud always,
 * shown only while counting down or starting.
 */
function RecordControl({ controls }: { controls: SettingsGroup }) {
  const choice = controls.choices[0];
  const busy = Boolean(model.savingOf(controls.id)) || choice?.busy === true;
  const id = choice && `setting-${controls.id}-${choice.id}`;
  const shown = controls.phase === "countdown" || controls.phase === "starting";
  const filled = choice?.id === "start" || choice?.id === "stop";
  return (
    <div className="studio-record">
      <span className={shown ? "studio-state" : "sr-only"} id="setting-studioControls-label">{controls.label}</span>
      {choice && id && (
        <Button id={id} data-action={choice.id} variant="outline"
          className={`h-8 gap-1.5 rounded-full px-3.5 text-xs ${filled ? "border-foreground bg-foreground text-background hover:bg-foreground/85 hover:text-background dark:border-foreground dark:bg-foreground dark:text-background dark:hover:bg-foreground/85" : ""}`}
          disabled={!controls.enabled || !choice.enabled} aria-disabled={busy || !controls.enabled || !choice.enabled}
          onClick={() => { if (!busy && controls.enabled && choice.enabled) void model.choose(controls.id, choice.id, id); }}>
          {choice.id === "stop" && <Square className="size-2.5 fill-current text-primary" aria-hidden="true" />}
          {choice.label}
          {controls.elapsedSince && <Elapsed since={controls.elapsedSince} />}
        </Button>
      )}
    </div>
  );
}

/**
 * One line over the preview (2026-10-21): the recording's phase and action. No bar or card of its own.
 */
function Toolbar({ controls }: { controls: SettingsGroup | undefined }) {
  if (!controls) return null;
  return (
    <section className="studio-controls" data-phase={controls.phase} aria-labelledby="studio-controls-heading">
      <h2 id="studio-controls-heading" className="sr-only">{controls.sectionHeading ?? controls.label}</h2>
      <RecordControl controls={controls} />
      {controls.note && <p className="studio-note" role="status">{controls.note}</p>}
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
  // Its preview and meters at the full rate while someone works in it, at half while it is only looked at (plan 081).
  useEffect(() => paceStudio(), []);
  const preview = groupOf("cameraPreview");
  const controls = groupOf("studioControls");
  const live = groupOf("studioLive");
  return (
    <div className="studio">
      <Toolbar controls={controls} />
      {preview?.cameraPreview && (
        <section className="studio-stage" aria-label={preview.label}>
          <CameraPreview group={preview} preview={preview.cameraPreview} disabled={!preview.enabled}
            describedBy={preview.info ? "setting-cameraPreview-info" : undefined} overlay={live && <LiveSwitch live={live} />} />
          {live?.note && <p id="setting-studioLive-note" className="studio-note" role="status">{live.note}</p>}
          {/* How to move the bubble, for assistive technology only: on screen the bubble shows it can be dragged. */}
          {preview.info && <p id="setting-cameraPreview-info" className="sr-only">{preview.info}</p>}
          <Failures groups={[preview, live]} />
        </section>
      )}
      <div className="studio-panels">
        <CameraPanel />
        <AudioPanel />
      </div>
    </div>
  );
}
