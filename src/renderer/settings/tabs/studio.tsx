/**
 * The Recording Studio (plan 075, D19; laid out again by plan 097, D1, 2026-10-28 and 2026-10-31): one toolbar over the
 * preview, the record control at its start and what only changes what is watched at its end (the view, Live preview and
 * the preview's rate); under the preview the recording's sources on one short line each (the recording type and the
 * screen, camera, system audio and microphone pickers), then what is watched and changed while recording, which
 * follows the recording's type. Quiet when fine: a picker says On, its device's name in its tooltip and menu, and says a
 * problem in the warning look (D2). Every control is still a group main offers and answers (settings-model.ts), chosen as anywhere in Settings.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { isStudioPreviewRate, isStudioView, type StudioPreviewRate, type StudioView } from "../../../shared/studio-port";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Camera, CameraOff, ChevronDown, Ellipsis, Film, Lock, Mic, MicOff, Monitor, MonitorOff, Radio, Square, TriangleAlert, Video, Volume2, VolumeX } from "lucide-react";
import type { SettingsGroup } from "../../../shared/settings-panel";
import { Button, buttonVariants } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";
import { ControlTooltip } from "../../components/control-tooltip";
import { usePendingValue } from "../../lib/use-pending-value";
import { translate } from "../../../shared/i18n";
import * as model from "../settings-controller";
import { CameraPreview, type PreviewShown } from "./camera-preview";
import { AudioMeter } from "./audio-meter";
import { SliderSetting } from "./row-parts/slider";
import { Elapsed } from "./row-parts/elapsed";
import { paceStudio, type StudioPacer } from "./studio-pace";
import { setPreviewView } from "./studio-feed";

const groupOf = (id: string): SettingsGroup | undefined => model.view?.groups.find((group) => group.id === id && group.tab === "studio");

/**
 * The toolbar's one shape (2026-10-28): every control as tall, as rounded and as padded, on the same surface, from the
 * --studio-control-* tokens (ui.css). Given here, over each primitive's own, so a menu and a button never differ. Only
 * colours ease: a control folding to its icon snaps, so its first fold as the Studio opens is never seen.
 */
const CONTROL = "transition-[color,background-color,border-color,box-shadow] h-(--studio-control-height) data-[size=default]:h-(--studio-control-height) gap-1.5 rounded-(--studio-control-radius) px-(--studio-control-px) text-xs border-border bg-input/20 hover:bg-input/50 dark:bg-input/30 dark:hover:bg-input/50 [&_svg:not([class*='size-'])]:size-(--studio-control-icon)";
/**
 * A source under the preview (2026-10-31): the toolbar's surface on one short line, its icon and a word or two, as wide
 * as it says, its words wrapping only where it is wider than the Studio (zoomed in, narrowest); locked while recording,
 * still read at full strength, its lock and quieter words saying it is locked (ui.css).
 */
const SOURCE = "studio-source h-auto data-[size=default]:h-auto min-h-(--studio-source-height) py-1 max-w-full min-w-0 flex-none justify-start px-(--studio-source-px) border-transparent bg-transparent dark:bg-transparent shadow-none disabled:opacity-100";
/** A control folded to its icon: square, its words kept for assistive technology and its tooltip. */
const ICON_ONLY = "w-(--studio-control-height) min-w-0 flex-none justify-center px-0";
/** Zoomed in the narrowest window, a control's words wrap onto a second line rather than run past the toolbar. */
const WRAP = "h-auto min-h-(--studio-control-height) py-1 whitespace-normal data-[size=default]:h-auto";
/** A picker's problem in the warning look (D2), over the surface in either theme and under the pointer. */
const PROBLEM = "data-problem:border-warning-border data-problem:bg-warning-surface data-problem:text-warning dark:data-problem:bg-warning-surface hover:data-problem:bg-warning-surface dark:hover:data-problem:bg-warning-surface";

/** A failed choice among `groups`, said under them, as a row says its own. */
function Failures({ groups }: { groups: (SettingsGroup | undefined)[] }) {
  const failure = groups.map((group) => group && model.failureOf(group.id)).find(Boolean);
  return failure ? <p className="studio-failure" role="alert">{failure.text}</p> : null;
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
    // Escape gives up what was typed first; with nothing typed it closes the menu it is in, as anywhere else.
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
  // Cancelled, or let go outside the window (the press ends with no release here): the drag ends, its value unsaved.
  const onPointerLost = (event: PointerEvent<HTMLSpanElement>): void => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = undefined;
    setMoving(undefined);
  };
  return (
    <label className="number-setting" data-disabled={disabled || undefined}>
      <ControlTooltip label={group.info ?? group.label}>
        <span className="number-setting-name" aria-hidden="true" onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerCancel={onPointerLost} onLostPointerCapture={onPointerLost}>{field.short}</span>
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

/**
 * An on/off group as a line of its own: its name, what it says, and its switch at the end. `steady` keeps the line under
 * it while there is nothing to say, so the live row keeps its height as a recording starts.
 */
function SwitchRow({ group, steady, label = group.label }: { group: SettingsGroup; steady?: boolean; label?: string }) {
  const id = `setting-${group.id}`;
  const on = model.committed(group) === "on";
  const said = group.note ?? group.info;
  return (
    <div className="studio-switch-row" data-disabled={!group.enabled || undefined}>
      <span id={`${id}-label`} className="font-semibold">{label}</span>
      <Switch id={id} aria-labelledby={`${id}-label`} checked={on} disabled={!group.enabled}
        aria-describedby={said ? `${id}-note` : undefined}
        onCheckedChange={(checked) => void model.choose(group.id, checked ? "on" : "off", id)} />
      {said ? <span id={`${id}-note`} className="studio-switch-note">{said}</span>
        : steady && <span className="studio-switch-note" aria-hidden="true">{"\u00a0"}</span>}
    </div>
  );
}

const PICKER_ICONS = {
  screen: [Monitor, MonitorOff],
  camera: [Camera, CameraOff],
  system: [Volume2, VolumeX],
  microphone: [Mic, MicOff],
} as const;

/**
 * One input's picker under the preview (plan 097; moved there and made one short line on 2026-10-31, at the maintainer's
 * request): its name and On, Off, or Problem in the warning look with the icon struck through (D2). The device's name
 * or the problem in full is in its tooltip and its accessible name, the problem again atop its menu. Its state's words
 * keep the room of the longest, so a problem said or gone moves nothing. Its menu holds the input's switch, the
 * devices to choose from and the rows that go with them; while a recording locks it, it shows a lock and does not open.
 */
function Picker({ group }: { group: SettingsGroup }) {
  const picker = group.picker!;
  const id = `setting-${group.id}`;
  const problem = picker.problem !== undefined && !picker.waiting;
  const [OnIcon, OffIcon] = PICKER_ICONS[picker.input];
  const Icon = problem || picker.off ? OffIcon : OnIcon;
  const shown = picker.problem ?? (picker.off ? model.text("Off") : picker.name);
  const parts = (picker.parts ?? []).map(groupOf).filter((part): part is SettingsGroup => part !== undefined);
  const on = parts[0]?.control === "switch" && (parts[0].id === "studioCamera" || parts[0].id === "studioMicrophone") ? parts[0] : undefined;
  const rest = parts.filter((part) => part !== on);
  const fields = rest.filter((part) => part.number);
  const switches = rest.filter((part) => part.control === "switch");
  const pixels = fields[0]?.note;
  const name = `${group.label}: ${shown}`;
  const state = problem ? "Problem" : picker.off ? "Off" : "On";
  const face = (<>
          <Icon aria-hidden="true" />
          <span className="studio-source-label">{group.label}</span>
          <span className="studio-source-state" aria-hidden="true">
            {(["On", "Off", "Problem"] as const).map((each) => <span key={each} data-shown={each === state || undefined}>{model.text(each)}</span>)}
          </span>
          {picker.locked ? <Lock className="studio-picker-lock" aria-hidden="true" />
            : <ChevronDown className="studio-picker-chevron" aria-hidden="true" />}
  </>);
  const button = (
    <Button id={id} variant="outline" className={cn(CONTROL, PROBLEM, SOURCE, "studio-picker")} data-input={picker.input}
      data-problem={problem || undefined} data-waiting={picker.waiting || undefined}
      data-off={(picker.off && !problem) || undefined} data-locked={picker.locked || undefined}
      disabled={picker.locked} aria-label={name}>
      {face}
    </Button>
  );
  return (
    <ControlTooltip label={name}>
      <span role="group" tabIndex={picker.locked ? 0 : undefined} aria-label={picker.locked ? name : undefined}
        data-locked-source={picker.locked ? id : undefined} className="inline-flex min-w-0 max-w-full">
      <Popover>
        <PopoverTrigger render={button} />
      <PopoverContent align="start" className="studio-picker-menu w-80 gap-2">
        {problem && <p className="studio-picker-problem"><TriangleAlert aria-hidden="true" />{picker.problem}</p>}
        {on && <SwitchRow group={on} />}
        <div role="radiogroup" aria-label={group.label} className="grid gap-px" data-disabled={!group.enabled || undefined}>
          {group.choices.map((choice) => {
            const checked = model.committed(group) === choice.id;
            return (
              <button key={choice.id} type="button" role="radio" aria-checked={checked} id={`${id}-${choice.id}`}
                className="studio-picker-choice" disabled={!group.enabled || !choice.enabled}
                onClick={() => { if (!checked) void model.choose(group.id, choice.id, `${id}-${choice.id}`); }}>
                <span className="choice-radio" aria-hidden="true" />
                <span>{choice.label}</span>
              </button>
            );
          })}
        </div>
        {group.actions?.map((action) => (
          <Button key={action.id} id={`${id}-${action.id}`} variant="ghost" size="sm" className="studio-picker-action justify-start"
            disabled={!action.enabled || action.busy} onClick={() => void model.choose(group.id, action.id, `${id}-${action.id}`)}>
            {action.label}
          </Button>
        ))}
        {fields.length > 0 && (
          <div className="studio-fields">
            {fields.map((part) => (
              <NumberSetting key={part.id} group={part} field={part.number!} disabled={!part.enabled}
                describedBy={pixels && part.number!.unit === "px" ? `${id}-pixels` : undefined} />
            ))}
          </div>
        )}
        {pixels && <p id={`${id}-pixels`} className="studio-note">{pixels}</p>}
        {switches.map((part) => <SwitchRow key={part.id} group={part} />)}
        <Failures groups={[group, ...parts]} />
      </PopoverContent>
      </Popover>
      </span>
    </ControlTooltip>
  );
}

/**
 * The recording type (plan 097, D6), first among the sources: Plain or Editable, the type chosen its words, each saying
 * in a line what it gives while the menu is open; where editable recordings are unavailable, listed unavailable with why,
 * never hidden. Locked while recording, it shows a lock in place of its menu's arrow.
 */
function TypePicker({ type }: { type: SettingsGroup }) {
  const chosen = model.committed(type);
  if (!chosen) return null;
  const id = `setting-${type.id}`;
  const current = type.choices.find((choice) => choice.id === chosen);
  const description = current?.description;
  return (<>
    <Select id={id} value={chosen} items={type.choices.map((choice) => ({ value: choice.id, label: choice.label }))} disabled={!type.enabled}
      onValueChange={(next) => { if (typeof next === "string" && next !== chosen) void model.choose(type.id, next, id); }}>
      <ControlTooltip label={`${type.label}: ${current?.label ?? chosen}`}>
        <SelectTrigger id={id} data-value={chosen} aria-label={type.label} aria-describedby={description ? `${id}-description` : undefined}
          data-locked={!type.enabled || undefined} className={cn(CONTROL, SOURCE, "studio-type")}>
          {chosen === "editable" ? <Film aria-hidden="true" /> : <Video aria-hidden="true" />}
          <SelectValue className="studio-source-label block flex-none overflow-visible whitespace-normal" />
          {!type.enabled && <Lock className="studio-picker-lock" aria-hidden="true" />}
        </SelectTrigger>
      </ControlTooltip>
      <SelectContent alignItemWithTrigger={false} align="start">
        {type.choices.map((choice) => (
          <SelectItem key={choice.id} value={choice.id} data-value={choice.id} disabled={!choice.enabled}>
            <span className="studio-preview-option">
              <span>{choice.label}</span>
              {choice.description && <span className="studio-preview-option-note">{choice.description}</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
    {description && <span id={`${id}-description`} className="sr-only">{description}</span>}
  </>);
}

/**
 * What the stage shows (plan 092, D3), a menu at the toolbar's end: every choice says in one line what it shows while
 * the menu is open, the one shown checked: As recorded, or Check camera (plan 097: Screen only removed). Its trigger
 * says what it is, Preview view, at every width (2026-10-31: an icon alone said nothing at 549 px); the picture shown
 * is its value, said to assistive technology and in its tooltip.
 */
function ViewMenu({ view, wrap }: { view: SettingsGroup; wrap: boolean }) {
  const chosen = model.committed(view);
  if (!chosen) return null;
  const id = `setting-${view.id}`;
  const current = view.choices.find((choice) => choice.id === chosen);
  const description = current?.description;
  return (<>
    <Select id={id} value={chosen} items={view.choices.map((choice) => ({ value: choice.id, label: choice.label }))} disabled={!view.enabled}
      onValueChange={(next) => { if (typeof next === "string" && next !== chosen) void model.choose(view.id, next, id); }}>
      <ControlTooltip label={`${view.label}: ${current?.label ?? chosen}`}>
        <SelectTrigger id={id} data-value={chosen} aria-label={view.label} aria-describedby={description ? `${id}-description` : undefined}
          className={cn(CONTROL, "studio-view", wrap && WRAP)}>
          <span className="studio-view-name">{view.label}</span><SelectValue className="sr-only" />
        </SelectTrigger>
      </ControlTooltip>
      <SelectContent alignItemWithTrigger={false} align="end">
        {view.choices.map((choice) => (
          <SelectItem key={choice.id} value={choice.id} data-value={choice.id} disabled={!choice.enabled}>
            {/* The radio alone marks the choice (2026-11-01): no icon beside it. */}
            <span className="studio-preview-option">
              <span>{choice.label}</span>
              {choice.description && <span className="studio-preview-option-note">{choice.description}</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
    {description && <span id={`${id}-description`} className="sr-only">{description}</span>}
  </>);
}

/** Live preview, a switch at the toolbar's end (2026-10-23): always in sight. On, its signal is green, not the recording's red. */
function LiveSwitch({ live, iconOnly }: { live: SettingsGroup; iconOnly: boolean }) {
  const on = model.committed(live) === "on";
  return (
    <ControlTooltip label={live.label} enabled={iconOnly}>
      <Button id={`setting-${live.id}`} variant="outline" role="switch" aria-checked={on} aria-label={live.label}
        className={cn(CONTROL, "studio-live", iconOnly && ICON_ONLY)} data-icon-only={iconOnly || undefined}
        disabled={!live.enabled} aria-describedby={live.note ? `setting-${live.id}-note` : undefined}
        onClick={() => void model.choose(live.id, on ? "off" : "on", `setting-${live.id}`)}>
        <Radio aria-hidden="true" /><span className={iconOnly ? "sr-only" : undefined}>{live.label}</span>
      </Button>
    </ControlTooltip>
  );
}

/**
 * The preview's rate (plan 092, D1), behind ⋯ at the toolbar's end (plan 097): set now and then, so out of the
 * way; every choice says in one line what it does.
 */
function RateMenu({ rate }: { rate: SettingsGroup }) {
  const chosen = model.committed(rate);
  const id = `setting-${rate.id}`;
  return (
    <Popover>
      <ControlTooltip label={rate.label}>
        <PopoverTrigger render={<Button id={`${id}-more`} variant="ghost" className={cn(CONTROL, ICON_ONLY, "studio-more border-transparent bg-transparent dark:bg-transparent")}
          data-icon-only aria-label={rate.label} />}>
          <Ellipsis aria-hidden="true" />
        </PopoverTrigger>
      </ControlTooltip>
      <PopoverContent align="end" className="studio-picker-menu w-72 gap-2">
        <div role="radiogroup" aria-label={rate.label} className="grid gap-px">
          <span className="font-semibold">{rate.label}</span>
          {rate.choices.map((choice) => {
            const checked = chosen === choice.id;
            return (
              <button key={choice.id} type="button" role="radio" aria-checked={checked} id={`${id}-${choice.id}`} data-value={choice.id}
                className="studio-picker-choice" disabled={!rate.enabled || !choice.enabled}
                onClick={() => { if (!checked) void model.choose(rate.id, choice.id, `${id}-${choice.id}`); }}>
                <span className="choice-radio" aria-hidden="true" />
                <span className="studio-preview-option">
                  <span>{choice.label}</span>
                  {choice.description && <span className="studio-preview-option-note">{choice.description}</span>}
                </span>
              </button>
            );
          })}
        </div>
        <Failures groups={[rate]} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The toolbar's end (plan 097, D1; moved from the page's title line to the record control's line on 2026-10-28, at the
 * maintainer's request): what only changes what is watched, never the file.
 */
function StudioHead({ view, live, rate, iconOnly, wrap }: {
  view: SettingsGroup | undefined; live: SettingsGroup | undefined; rate: SettingsGroup | undefined; iconOnly: boolean; wrap: boolean;
}) {
  if (!view && !live && !rate) return null;
  return (
    <div className="studio-head">
      {view && <ViewMenu view={view} wrap={wrap} />}
      {live && <LiveSwitch live={live} iconOnly={iconOnly} />}
      {rate && <RateMenu rate={rate} />}
    </div>
  );
}

/**
 * The recording's one control (2026-10-21): Start while ready, Cancel under a short countdown line, and Stop with the
 * elapsed time while recording, so the button itself says a recording is under way. Start and Stop are drawn in ink, black
 * or in the dark theme white, the recording's red kept to Stop's square (2026-10-21). The phase is said aloud always,
 * shown only while counting down or starting, in a place of its own kept in every phase (2026-10-31).
 */
function RecordControl({ controls, wrap }: { controls: SettingsGroup; wrap: boolean }) {
  const choice = controls.choices[0];
  const busy = Boolean(model.savingOf(controls.id)) || choice?.busy === true;
  const id = choice && `setting-${controls.id}-${choice.id}`;
  const shown = controls.phase === "countdown" || controls.phase === "starting";
  const filled = choice?.id === "start" || choice?.id === "stop";
  return (
    <div className="studio-record">
      {choice && id && (
        <div className="studio-record-slot">
          {/* As wide as its widest phase, Stop with up to ten hours' time, unseen: Record keeps one width whatever the
              phase or language, so nothing moves as a recording starts or lasts (2026-10-31). */}
          <span aria-hidden="true" className={cn(buttonVariants({ variant: "outline" }), CONTROL, "studio-record-room grid")}>
            {(["Start recording", "Cancel recording", "Saving…"] as const).map((label) => <span key={label}>{model.text(label)}</span>)}
            <span><Square className="size-2.5" />{model.text("Stop recording")}<span className="studio-elapsed">0:00:00</span></span>
          </span>
          <Button id={id} data-action={choice.id} variant="outline"
            className={cn(CONTROL, wrap && WRAP, filled && "border-foreground bg-foreground text-background hover:bg-foreground/85 hover:text-background dark:border-foreground dark:bg-foreground dark:text-background dark:hover:bg-foreground/85")}
            disabled={!controls.enabled || !choice.enabled} aria-disabled={busy || !controls.enabled || !choice.enabled}
            onClick={() => { if (!busy && controls.enabled && choice.enabled) void model.choose(controls.id, choice.id, id); }}>
            {choice.id === "stop" && <Square className="size-2.5 fill-current text-primary" aria-hidden="true" />}
            {choice.label}
            {controls.elapsedSince && <Elapsed since={controls.elapsedSince} />}
          </Button>
        </div>
      )}
      {/* Its place kept in every phase, its words unseen but said while ready or recording (ui.css), so nothing moves as
          a recording starts. */}
      <span className="studio-state" data-shown={shown || undefined} id="setting-studioControls-label">{controls.label}</span>
    </div>
  );
}

/**
 * How much the toolbar says (2026-10-28; since 2026-10-31 only Record, its phase and what is watched, the sources under
 * the preview): every control with its name while all fit; then Live preview as its icon; then the phase's words in
 * the room left, on up to two lines; then what is watched on a line of its own under Record; narrowest, zoomed in,
 * Record's words wrap. Record and the view keep their words always. An icon names itself in a tooltip. Decided by the
 * toolbar's own width, so the sidebar or zoom count as the window does.
 *
 * The widths below are only where a density may start: whether it fits is measured (2026-10-31). After each layout no
 * two controls may overlap or pass the toolbar's edge; where they do, that density is marked too wide for that width
 * and the next is taken, before the frame shows. The countdown's words keep their place in every phase (ui.css), so
 * being ready, counting down and recording are measured alike and nothing moves between them.
 */
type Density = "full" | "compact" | "tight" | "stacked" | "wrapped";
const DENSITIES: Density[] = ["full", "compact", "tight", "stacked", "wrapped"];
/** The narrowest toolbar (CSS px) each density may start at, its labels at their usual lengths. */
const DENSITY_WIDTHS: Partial<Record<Density, number>> = { full: 560, compact: 420 };

/** Whether any of the toolbar's controls overlap or pass its edges as it is laid out now. */
function crowded(toolbar: HTMLElement): boolean {
  const edge = toolbar.getBoundingClientRect();
  // The controls in the flow: not a select's hidden native input or a name said only to assistive technology.
  // Record and its phase rather than what holds them.
  const boxes = [...toolbar.querySelectorAll(".studio-record > *, .studio-head > *")]
    .filter((element) => !["absolute", "fixed"].includes(getComputedStyle(element).position))
    .map((element) => element.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
  // Half a pixel either way: subpixel layout is not an overlap.
  const apart = (a: DOMRect, b: DOMRect): boolean =>
    a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
  return boxes.some((box, i) => box.left < edge.left - 0.5 || box.right > edge.right + 0.5 || boxes.slice(i + 1).some((other) => !apart(box, other)));
}

function useDensity(toolbar: RefObject<HTMLDivElement | null>, content: string): Density {
  const [density, setDensity] = useState<Density>("full");
  // Failed widths belong to this content only: shorter state/device labels must be allowed to unfold again.
  const seen = useRef({ content: "", tooNarrow: new Map<Density, number>() });
  const settle = useCallback((update: (next: Density) => void) => {
    const element = toolbar.current;
    if (!element) return;
    const width = element.clientWidth;
    if (seen.current.content !== content) seen.current = { content, tooNarrow: new Map() };
    const shown = element.dataset.density as Density | undefined;
    if (shown && shown !== "wrapped" && crowded(element)) {
      seen.current.tooNarrow.set(shown, Math.max(seen.current.tooNarrow.get(shown) ?? 0, width));
    }
    update(DENSITIES.find((each) => width >= (DENSITY_WIDTHS[each] ?? 0) && width > (seen.current.tooNarrow.get(each) ?? -1)) ?? "wrapped");
  }, [toolbar, content]);
  // After every layout, so a new language or a longer name is measured as well as a new width; a density that does not
  // fit is replaced before the frame shows.
  useLayoutEffect(() => settle(setDensity));
  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element) return;
    const observer = new ResizeObserver(() => settle((next) => flushSync(() => setDensity(next))));
    observer.observe(element);
    return () => observer.disconnect();
  }, [toolbar, settle]);
  return density;
}

/**
 * Over the preview (plan 097, D1; one line since 2026-10-28): the record control and its phase at its start, what is
 * watched at its end. The sources it records are under the preview (2026-10-31), so they stay put and named as a
 * recording starts.
 */
function Toolbar({ controls }: { controls: SettingsGroup | undefined }) {
  const toolbar = useRef<HTMLDivElement>(null);
  const view = groupOf("studioPreviewView");
  const live = groupOf("studioLive");
  const rate = groupOf("studioPreviewRate");
  const density = useDensity(toolbar, JSON.stringify([controls, view, live, rate]));
  return (
    <div ref={toolbar} className="studio-toolbar" data-density={density}>
      <div className="studio-toolbar-row">
        <section className="studio-choices" data-phase={controls?.phase} aria-labelledby="studio-choices-heading">
          <h2 id="studio-choices-heading" className="sr-only">{controls?.sectionHeading ?? model.text("What is recorded")}</h2>
          {controls && <RecordControl controls={controls} wrap={density === "wrapped"} />}
        </section>
        <StudioHead view={view} live={live} rate={rate} iconOnly={density !== "full"} wrap={density === "wrapped"} />
      </div>
      <Failures groups={[controls]} />
      <Failures groups={[view, live]} />
    </div>
  );
}

/**
 * Under the preview, first (2026-10-31, at the maintainer's request: folded to icons over the preview they said neither
 * what they were nor what they were set to; then, as two-line cards, they took too much of the preview's room): what
 * the recording records, one short control each on a line that wraps only where it must, its heading said to
 * assistive technology alone. The same in every phase; while a recording locks one, it shows a lock in its place.
 */
function Sources({ phase }: { phase: string | undefined }) {
  const type = groupOf("studioType");
  const pickers = ["studioScreen", "studioCameraDevice", "studioSystemAudio", "studioMicrophoneDevice"].map(groupOf).filter((group): group is SettingsGroup => Boolean(group?.picker));
  if (!type && pickers.length === 0) return null;
  return (
    <section className="studio-sources" data-phase={phase} aria-labelledby="studio-sources-heading">
      <h2 id="studio-sources-heading" className="sr-only">{model.text("Recording sources")}</h2>
      <div className="studio-sources-grid">
        {type && <TypePicker type={type} />}
        {pickers.map((group) => <Picker key={group.id} group={group} />)}
      </div>
      <Failures groups={[type]} />
    </section>
  );
}

/**
 * One input under the preview: its name and, in a plain recording, a speaker beside it that says and switches whether
 * the input is recorded (2026-10-31, the maintainer's choice: a speaker, struck through when not recorded, in place of
 * Don't record); its level; its fader. Not recorded, the name, level and fader are greyed and the speaker is struck
 * through in the warning colour. Assistive technology hears a switch, Record and the input's name, on while it is recorded.
 */
function Channel({ group }: { group: SettingsGroup }) {
  const fader = groupOf(`${group.meter!.source}Gain`);
  const muted = model.committed(group) === "mute";
  const recordable = group.choices.some((choice) => choice.id === "mute");
  const id = `setting-${group.id}`;
  const Icon = muted ? VolumeX : Volume2;
  const language = model.view?.language;
  const press = translate(muted ? "Record {label}" : "Don't record {label}", language, { label: group.label });
  return (
    <div className="studio-channel" data-muted={recordable && muted ? true : undefined}>
      <div className="studio-channel-head">
        <span id={`${id}-label`}>{group.label}</span>
        {recordable && (
          <ControlTooltip label={press}>
            <Button id={id} variant="ghost" size="icon-sm" className="studio-channel-record" role="switch"
              aria-checked={!muted} aria-label={translate("Record {label}", language, { label: group.label })} disabled={!group.enabled}
              onClick={() => void model.choose(group.id, muted ? "unmute" : "mute", id)}>
              <Icon className="size-4" aria-hidden="true" />
            </Button>
          </ControlTooltip>
        )}
      </div>
      <AudioMeter group={group} source={group.meter!.source} muted={muted} disabled={!group.enabled} describedBy={undefined} />
      {fader?.slider && <SliderSetting id={`setting-${fader.id}`} group={fader} slider={fader.slider} disabled={!fader.enabled} />}
    </div>
  );
}

/**
 * Under the preview (plan 097, D6): the live controls of the recording's type. A plain recording's camera Show / Hide
 * and each input's speaker toggle, meter and fader; an editable recording's meters alone (the line saying where its
 * volumes and the camera are set removed on 2026-10-28 at the maintainer's request: the type's own description says it).
 */
function LiveRow({ type }: { type: SettingsGroup | undefined }) {
  const shown = groupOf("cameraShown");
  const channels = ["systemAudio", "microphoneAudio"].map(groupOf).filter((group): group is SettingsGroup => Boolean(group?.meter));
  if (!shown && channels.length === 0) return null;
  return (
    <section className="studio-live-row" data-type={type?.recordingType} aria-labelledby="studio-live-heading">
      <h2 id="studio-live-heading" className="studio-heading">{channels[0]?.sectionHeading ?? shown?.sectionHeading ?? model.text("While recording")}</h2>
      <div className="studio-live-controls">
        {shown && (
          <div className="studio-channel studio-camera-shown">
            <SwitchRow group={shown} steady label={model.text("Show camera")} />
          </div>
        )}
        {channels.map((group) => <Channel key={group.id} group={group} />)}
      </div>
      <Failures groups={[shown, ...channels, groupOf("systemGain"), groupOf("microphoneGain")]} />
    </section>
  );
}

/**
 * Over the stage while Live preview is off (2026-10-25, at the maintainer's request): a glass button in the middle of the
 * picture that turns Live preview on as the switch in the toolbar does. Always in sight since 2026-10-31 (the
 * maintainer's request: shown only on hover, the bare gradient read as a picture that had not loaded); its words say
 * the preview is off, so nothing else is drawn, and assistive technology hears why the stage is empty.
 */
function StageStart({ live }: { live: SettingsGroup }) {
  const id = `setting-${live.id}-stage`;
  return (
    <div className="studio-stage-start">
      <p id={`${id}-said`} className="sr-only">{model.text("Live preview is off.")}</p>
      {/* Kept inside a narrow portrait picture, which clips: its words wrap rather than run past it. */}
      <Button id={id} variant="outline" aria-describedby={`${id}-said`}
        className="h-auto min-h-9 max-w-full gap-1.5 rounded-full border-(--studio-glass-edge) bg-transparent px-4 py-1.5 text-center text-sm whitespace-normal hover:bg-transparent hover:text-(--studio-live-ink-on) dark:bg-transparent"
        onClick={() => void model.choose(live.id, "on", id)}>
        <Radio aria-hidden="true" />{model.text("Turn on preview")}
      </Button>
    </div>
  );
}

/**
 * Paces the Studio at the chosen rate (studio-pace.ts) and tells the capture process the chosen view; returns what
 * the stage shows of them. The picture is off until a session's picture is shown (2026-10-25: Live preview is its one
 * switch), so the Studio opens no camera of its own; main's word on the switch decides, not a choice still saving.
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
  const type = groupOf("studioType");
  // Its preview and meters at the chosen rate (plan 092, D1), and the chosen view (D3).
  const shown = usePreviewChoice(rate, view, live, preview?.cameraPreview?.mode === "recording");
  return (
    <div className="studio">
      <Toolbar controls={controls} />
      {preview?.cameraPreview && (
        <section className="studio-stage" aria-label={preview.label}
          style={{ ["--preview-ratio" as string]: preview.cameraPreview.display.width / preview.cameraPreview.display.height }}>
          <CameraPreview group={preview} preview={preview.cameraPreview} disabled={!preview.enabled} statusOutside shown={live ? shown : undefined}
            overlay={live && shown.off && live.enabled && model.committed(live) !== "on" ? <StageStart live={live} /> : undefined}
            describedBy={preview.info ? "setting-cameraPreview-info" : undefined} />
          {/* Over the stage, not under it, so the picture keeps its size while a Live preview starts (2026-10-24). The
              camera's own state is its picker's to say (plan 097, D2). */}
          {live?.note && <p id="setting-studioLive-note" className="studio-stage-note" role="status">{live.note}</p>}
          {/* How to move the bubble, for assistive technology only: on screen the bubble shows it can be dragged. */}
          {preview.info && <p id="setting-cameraPreview-info" className="sr-only">{preview.info}</p>}
          <Failures groups={[preview]} />
        </section>
      )}
      <Sources phase={controls?.phase} />
      <LiveRow type={type} />
    </div>
  );
}
