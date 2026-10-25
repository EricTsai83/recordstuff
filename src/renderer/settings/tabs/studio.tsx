/**
 * The Recording Studio (plan 075, D19), laid out as OBS lays out its main window: the preview across the top, and under
 * it the recording controls as a bar, then panels side by side, the camera's and the audio mixer, instead of a list of rows. Every control is
 * still a group main offers and answers (settings-model.ts), chosen the same way as anywhere in Settings.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { isStudioPreviewRate, isStudioView, type StudioPreviewRate, type StudioView } from "../../../shared/studio-port";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { AudioLines, Camera, CameraOff, Eye, EyeOff, FlipHorizontal2, Lock, Monitor, MonitorPlay, PictureInPicture2, Radio, Square, Video } from "lucide-react";
import type { SettingsGroup } from "../../../shared/settings-panel";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { ControlTooltip } from "../../components/control-tooltip";
import { usePendingValue } from "../../lib/use-pending-value";
import * as model from "../settings-controller";
import { CameraPreview, type PreviewShown } from "./camera-preview";
import { AudioMeter } from "./audio-meter";
import { SliderSetting } from "./row-parts/slider";
import { Elapsed } from "./row-parts/elapsed";
import { paceStudio, type StudioPacer } from "./studio-pace";
import { setPreviewView } from "./studio-feed";

const groupOf = (id: string): SettingsGroup | undefined => model.view?.groups.find((group) => group.id === id && group.tab === "studio");

/** A panel's failed choice, said under it, as a row says its own. */
function Failures({ groups }: { groups: (SettingsGroup | undefined)[] }) {
  const failure = groups.map((group) => group && model.failureOf(group.id)).find(Boolean);
  return failure ? <p className="studio-failure" role="alert">{failure.text}</p> : null;
}

/**
 * An on/off group drawn as a button that is pressed while on, its icon beside its name in words (2026-10-24, at the
 * maintainer's request: an icon alone did not say what it does): Mirror, and showing the camera while recording.
 */
function Toggle({ group, icon: Icon, offIcon: OffIcon }: { group: SettingsGroup; icon: typeof Eye; offIcon?: typeof Eye }) {
  const on = model.committed(group) === "on";
  const Shown = !on && OffIcon ? OffIcon : Icon;
  return (
    <Button id={`setting-${group.id}`} variant="outline" size="sm" className="studio-toggle" aria-pressed={on}
      disabled={!group.enabled} aria-describedby={group.info ? `setting-${group.id}-info` : undefined}
      onClick={() => void model.choose(group.id, on ? "off" : "on", `setting-${group.id}`)}>
      <Shown aria-hidden="true" />{group.label}
    </Button>
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
  const { shown, moving, move: setMoving, commit: save } = usePendingValue(field.value);
  const drag = useRef<{ pointer: number; x: number; from: number } | undefined>(undefined);
  const unit = field.unit === "px" ? "px" : "%";
  const within = (value: number): number => Math.min(field.max, Math.max(field.min, Math.round(value)));
  const commit = (value: number): void => {
    setDraft(undefined);
    save(within(value), (next) => model.choose(group.id, String(next), id));
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
  const mirror = groupOf("cameraMirror");
  const shown = groupOf("cameraShown");
  const fields = ["cameraWidth", "cameraHeight", "cameraRounding"].map(groupOf);
  // What the pixels are counted on: the recording's size on the display it would capture now.
  const pixels = fields[0]?.note;
  return (
    <section className="studio-panel" aria-labelledby="studio-camera-heading">
      <div className="studio-panel-head">
        <h2 id="studio-camera-heading"><Camera aria-hidden="true" />{camera.label}</h2>
        {/* Locked while a recording runs: said in the head's own line, so the panel keeps its height (2026-10-24). */}
        {camera.note && <span className="studio-lock" aria-hidden="true"><Lock />{model.text("Locked")}</span>}
        <Switch id={`setting-${camera.id}`} aria-labelledby="studio-camera-heading" checked={model.committed(camera) === "on"}
          disabled={!camera.enabled} aria-describedby={camera.note ? "setting-studioCamera-note" : undefined}
          onCheckedChange={(checked) => void model.choose(camera.id, checked ? "on" : "off", `setting-${camera.id}`)} />
      </div>
      {camera.note && <span id="setting-studioCamera-note" className="sr-only">{camera.note}</span>}
      <div className="studio-shape">
        <div className="studio-fields">
          {fields.map((group) => group?.number && (
            <NumberSetting key={group.id} group={group} field={group.number} disabled={!group.enabled}
              describedBy={pixels && group.number.unit === "px" ? "studio-camera-pixels" : undefined} />
          ))}
        </div>
        {pixels && <p id="studio-camera-pixels" className="studio-note">{pixels}</p>}
        {/* Showing the camera is the recording's own choice (D13), always in its place: pressed while a session composes
            the camera, and before one held, so nothing moves as a recording starts (2026-10-24). */}
        <div className="studio-toggles">
          {shown ? <Toggle group={shown} icon={Eye} offIcon={EyeOff} />
            : <Button variant="outline" size="sm" className="studio-toggle" disabled aria-pressed={false}><Eye aria-hidden="true" />{model.text("Show camera in recording")}</Button>}
          {mirror && <Toggle group={mirror} icon={FlipHorizontal2} />}
        </div>
      </div>
      <Failures groups={[camera, shown, mirror, ...fields]} />
    </section>
  );
}

/** The inputs the Studio meters: the system's sound and the microphone, each with its level, mute and fader. */
const audioRows = (): SettingsGroup[] => ["systemAudio", "microphoneAudio"].map(groupOf).filter((group): group is SettingsGroup => Boolean(group?.meter));

function AudioPanel() {
  const rows = audioRows();
  if (rows.length === 0) return null;
  const note = rows.find((group) => group.note)?.note;
  return (
    <section className="studio-panel" aria-labelledby="studio-audio-heading">
      <div className="studio-panel-head"><h2 id="studio-audio-heading"><AudioLines aria-hidden="true" />{rows[0]!.sectionHeading ?? model.text("Audio")}</h2></div>
      <div className="studio-mixer">
        {rows.map((group) => {
          // Each input under its name (2026-10-24, from the line of controls, where its icon alone said nothing): the
          // volume it is recorded at, then its level now with its mute, with no rule between them, as nowhere else has
          // one (2026-10-25, the maintainer's request). Both always there, the level at silence and the mute unavailable
          // while no session runs, so nothing moves as a recording starts.
          const fader = groupOf(`${group.meter!.source}Gain`);
          return (
            <div key={group.id} className="studio-channel">
              <div className="studio-channel-head">
                <span id={`setting-${group.id}-label`}>{group.label}</span>
              </div>
              {fader?.slider && (
                <div className="studio-channel-row">
                  <span className="studio-channel-caption" aria-hidden="true">{model.text("Recorded")}</span>
                  <SliderSetting id={`setting-${fader.id}`} group={fader} slider={fader.slider} disabled={!fader.enabled} />
                </div>
              )}
              <div className="studio-channel-row">
                <span className="studio-channel-caption" aria-hidden="true">{model.text("Level")}</span>
                <AudioMeter group={group} source={group.meter!.source} muted={model.committed(group) === "mute"}
                  disabled={!group.enabled} describedBy={note ? "studio-audio-note" : undefined} />
              </div>
            </div>
          );
        })}
      </div>
      {note && <p id="studio-audio-note" className="studio-note">{note}</p>}
      <Failures groups={[groupOf("systemGain"), groupOf("microphoneGain")]} />
    </section>
  );
}

const VIEW_ICONS: Record<StudioView, typeof Monitor> = { composed: PictureInPicture2, screen: Monitor, camera: Video };

/**
 * What the stage shows (plan 092, D3), a menu in the line of controls (2026-10-24, in place of three segments, at the
 * maintainer's request): its trigger names the picture shown, so no label is needed beside Live preview, and every
 * choice says in one line what it shows while the menu is open, as the rate's do.
 */
function ViewMenu({ view }: { view: SettingsGroup }) {
  const chosen = model.committed(view);
  if (!chosen) return null;
  const id = `setting-${view.id}`;
  const description = view.choices.find((choice) => choice.id === chosen)?.description;
  const icon = (choice: string) => { const Icon = isStudioView(choice) ? VIEW_ICONS[choice] : Monitor; return <Icon aria-hidden="true" />; };
  return (<>
    <Select id={id} value={chosen} items={view.choices.map((choice) => ({ value: choice.id, label: choice.label }))} disabled={!view.enabled}
      onValueChange={(next) => { if (typeof next === "string" && next !== chosen) void model.choose(view.id, next, id); }}>
      <SelectTrigger id={id} data-value={chosen} aria-label={view.label} aria-describedby={description ? `${id}-description` : undefined}
        className="studio-view">
        {icon(chosen)}<SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="end">
        {view.choices.map((choice) => (
          <SelectItem key={choice.id} value={choice.id} data-value={choice.id} disabled={!choice.enabled}>
            <span className="studio-view-option">
              {icon(choice.id)}
              <span className="studio-preview-option">
                <span>{choice.label}</span>
                {choice.description && <span className="studio-preview-option-note">{choice.description}</span>}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
    {description && <span id={`${id}-description`} className="sr-only">{description}</span>}
  </>);
}

/**
 * Live preview, a switch in the Studio's one line of controls beside Start and Stop (2026-10-23): always in sight, and
 * nothing laid over the picture it shows. On, its signal is green, not the recording's red.
 */
function LiveSwitch({ live }: { live: SettingsGroup }) {
  const on = model.committed(live) === "on";
  return (
    <Button id={`setting-${live.id}`} variant="outline" role="switch" aria-checked={on} className="studio-live h-8 gap-1.5 rounded-full px-3.5 text-xs"
      disabled={!live.enabled} aria-describedby={live.note ? `setting-${live.id}-note` : undefined}
      onClick={() => void model.choose(live.id, on ? "off" : "on", `setting-${live.id}`)}>
      <Radio aria-hidden="true" />{live.label}
    </Button>
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
 * One line over the preview (2026-10-21): the recording's phase and action, and at its end the view and Live preview
 * (2026-10-23). Nothing joins it as a recording starts (2026-10-24: each input's level and mute and the camera's showing
 * went back to their panels, where they are named), nor while the camera gives no picture (said over the stage since
 * 2026-10-25: in a narrow window it wrapped the line and moved the stage), and its buttons keep their widths, so the
 * stage under it never moves. No bar or card of its own.
 */
function Toolbar({ controls, live }: { controls: SettingsGroup | undefined; live: SettingsGroup | undefined }) {
  if (!controls) return null;
  const view = groupOf("studioPreviewView");
  return (
    <section className="studio-controls" data-phase={controls.phase} aria-labelledby="studio-controls-heading">
      <h2 id="studio-controls-heading" className="sr-only">{controls.sectionHeading ?? controls.label}</h2>
      <RecordControl controls={controls} />
      <div className="studio-quick">
        {view && <ViewMenu view={view} />}
        {live && <LiveSwitch live={live} />}
      </div>
      {controls.note && <p className="studio-note" role="status">{controls.note}</p>}
      <Failures groups={[controls, view, ...audioRows()]} />
    </section>
  );
}

/**
 * The preview's own panel beside the camera's and the mixer (plan 092, D1; placed there at the maintainer's request on
 * 2026-10-23): its rate, a menu whose every choice says in one line what it does while it is open, set now and then;
 * its view, switched while watching, is in the line of controls (plan 095, D2). Chosen at any time, a Live preview's or
 * a recording's alike.
 */
function PreviewPanel({ rate }: { rate: SettingsGroup }) {
  const chosen = model.committed(rate);
  const description = rate.choices.find((choice) => choice.id === chosen)?.description;
  const id = `setting-${rate.id}`;
  return (
    <section className="studio-panel" aria-labelledby="studio-preview-heading">
      <div className="studio-panel-head"><h2 id="studio-preview-heading"><MonitorPlay aria-hidden="true" />{model.text("Preview")}</h2></div>
      <div className="studio-preview-choices">
        <span id={`${id}-label`} className="studio-preview-label">{rate.label}</span>
        <Select id={id} value={chosen} items={rate.choices.map((choice) => ({ value: choice.id, label: choice.label }))} disabled={!rate.enabled}
          onValueChange={(next) => { if (typeof next === "string" && next !== chosen) void model.choose(rate.id, next, id); }}>
          <SelectTrigger id={id} data-value={chosen} aria-labelledby={`${id}-label ${id}`}
            aria-describedby={description ? `${id}-description` : undefined} className="studio-preview-rate">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} align="start">
            {rate.choices.map((choice) => (
              <SelectItem key={choice.id} value={choice.id} data-value={choice.id} disabled={!choice.enabled}>
                <span className="studio-preview-option">
                  <span>{choice.label}</span>
                  {choice.description && <span className="studio-preview-option-note">{choice.description}</span>}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* What the chosen rate does, said to assistive technology; on screen the open menu says it (2026-10-23). */}
        {description && <span id={`${id}-description`} className="sr-only">{description}</span>}
      </div>
      <Failures groups={[rate]} />
    </section>
  );
}

/**
 * Over the stage while Live preview is off (2026-10-25, at the maintainer's request): a glass button that shows while
 * the pointer is on the stage or it has focus, and turns Live preview on as the switch in the line of controls does.
 */
function StageStart({ live }: { live: SettingsGroup }) {
  const id = `setting-${live.id}-stage`;
  return (
    <div className="studio-stage-start">
      {/* Kept inside a narrow portrait picture, which clips: its words wrap rather than run past it. */}
      <Button id={id} variant="outline" className="h-auto min-h-9 max-w-[calc(100%-12px)] gap-1.5 rounded-full px-4 py-1.5 text-center text-sm whitespace-normal"
        onClick={() => void model.choose(live.id, "on", id)}>
        <Radio aria-hidden="true" />{model.text("Turn on preview")}
      </Button>
    </div>
  );
}

/**
 * Paces the Studio at the chosen rate (studio-pace.ts) and tells the capture process the chosen view; returns what
 * the stage shows of them. Power saving's rate in use is not shown: the rate's own line says what it does (the
 * maintainer, 2026-10-23, in place of D1's corner label). The picture is off until a session's picture is shown (2026-10-25:
 * Live preview is its one switch, the rate no longer offers Off), so the Studio opens no camera of its own; main's word
 * on the switch decides, not a choice still saving, so a picture is not let go and asked for again while it saves.
 */
function usePreviewChoice(rate: SettingsGroup | undefined, view: SettingsGroup | undefined, live: SettingsGroup | undefined,
  session: boolean): PreviewShown {
  const chosen: StudioPreviewRate = rate && isStudioPreviewRate(model.committed(rate)) ? model.committed(rate) as StudioPreviewRate : "power";
  const viewChosen = view && isStudioView(model.committed(view)) ? model.committed(view) as StudioView : "composed";
  // One pacer from the Studio's opening, told each rate chosen, so what the pointer did before a choice still counts.
  const pacer = useRef<StudioPacer | undefined>(undefined);
  useEffect(() => {
    const pacing = paceStudio(chosen);
    pacer.current = pacing;
    return () => { pacing.stop(); pacer.current = undefined; };
    // Made once with the rate it starts at; later choices reach it below.
  }, []);
  useEffect(() => pacer.current?.rate(chosen), [chosen]);
  useEffect(() => setPreviewView(viewChosen), [viewChosen]);
  return {
    off: live !== undefined && !(session && live.choices.some((choice) => choice.id === "on" && choice.checked)),
    view: viewChosen,
  };
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
  const controls = groupOf("studioControls");
  const live = groupOf("studioLive");
  const rate = groupOf("studioPreviewRate");
  const view = groupOf("studioPreviewView");
  // Its preview and meters at the chosen rate (plan 092, D1), and the chosen view (D3).
  const shown = usePreviewChoice(rate, view, live, preview?.cameraPreview?.mode === "recording");
  // What the camera is doing while a session gives no picture of it (plan 090): over the stage, or, in the Camera view,
  // which shows it in its own picture, to assistive technology only, still announced as it changes.
  const cameraStatus = preview?.cameraPreview?.mode === "recording" ? preview.cameraPreview.status : undefined;
  const cameraSaid = shown.view !== "camera" ? cameraStatus : undefined;
  return (
    <div className="studio">
      <Toolbar controls={controls} live={live} />
      {preview?.cameraPreview && (
        <section className="studio-stage" aria-label={preview.label}
          style={{ ["--preview-ratio" as string]: preview.cameraPreview.display.width / preview.cameraPreview.display.height }}>
          <CameraPreview group={preview} preview={preview.cameraPreview} disabled={!preview.enabled} statusOutside shown={live ? shown : undefined}
            overlay={live && shown.off && live.enabled && model.committed(live) !== "on" ? <StageStart live={live} /> : undefined}
            describedBy={preview.info ? "setting-cameraPreview-info" : undefined} />
          {/* Over the stage, not under it, so the picture keeps its size while a Live preview starts (2026-10-24), and so
              what the camera is doing while it gives no picture (plan 090; the Camera view says it in its own picture). */}
          {live?.note ? <p id="setting-studioLive-note" className="studio-stage-note" role="status">{live.note}</p>
            : cameraSaid && <p className="studio-stage-note" role="status"><CameraOff aria-hidden="true" />{cameraSaid}</p>}
          {shown.view === "camera" && cameraStatus && <p className="sr-only" role="status">{cameraStatus}</p>}
          {/* How to move the bubble, for assistive technology only: on screen the bubble shows it can be dragged. */}
          {preview.info && <p id="setting-cameraPreview-info" className="sr-only">{preview.info}</p>}
          <Failures groups={[preview, live]} />
        </section>
      )}
      <div className="studio-panels">
        {preview?.cameraPreview && rate && <PreviewPanel rate={rate} />}
        <CameraPanel />
        <AudioPanel />
      </div>
    </div>
  );
}
