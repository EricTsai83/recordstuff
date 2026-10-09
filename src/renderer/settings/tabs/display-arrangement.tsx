/**
 * The Screen row as the desktop's arrangement (2026-10-08): every screen drawn where it stands, as macOS's Displays pane
 * draws them, and picked by a click. Following the primary display is a switch in the picture's bottom-right corner,
 * since it names whichever screen holds the menu bar rather than one of them: turning it off keeps today's primary
 * screen chosen, no longer following. Each screen's name and size are written beside it, as macOS writes them, so a
 * small screen cuts neither. Positions are percentages of the arrangement's box: the picture scales with CSS alone, with
 * no measuring or observers.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import type { SettingsChoice, SettingsGroup } from "../../../shared/settings-panel";
import { Switch } from "../../components/ui/switch";
import { ControlTooltip } from "../../components/control-tooltip";
import * as model from "../settings-controller";

const percent = (value: number): string => `${(value * 100).toFixed(3)}%`;

/** A screen in the desk's own units: 0–1 of its width and of its height. */
interface Box { x: number; y: number; w: number; h: number }
/** About how much of the desk's height a two-line label takes, for telling whether another screen is in its way. */
const LABEL_BAND = 0.34;
/** How far past the desk's edge a label at either end may reach, in desk widths. */
const EDGE_ROOM = 0.1;
export type LabelPlace = "below" | "above" | "inside";
/**
 * Where each screen's name and size go, from the arrangement alone (no measuring): under the screen as macOS writes
 * them, above it when another screen stands right below, inside it when it is boxed in. A label may be wider than its
 * screen, up to halfway to the next label on its line, so a narrow portrait screen still names itself in full.
 */
export function placeLabels(boxes: Box[]): Array<{ place: LabelPlace; maxWidth: number | undefined }> {
  const overlapsX = (a: Box, b: Box): boolean => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6;
  const free = (box: Box, from: number, to: number): boolean =>
    boxes.every((other) => other === box || !overlapsX(box, other) || other.y >= to - 1e-6 || other.y + other.h <= from + 1e-6);
  const places = boxes.map((box): LabelPlace => {
    const bottom = box.y + box.h;
    if (free(box, bottom, bottom + LABEL_BAND)) return "below";
    if (free(box, box.y - LABEL_BAND, box.y)) return "above";
    return "inside";
  });
  const line = (index: number): number => places[index] === "below" ? boxes[index]!.y + boxes[index]!.h
    : places[index] === "above" ? boxes[index]!.y - LABEL_BAND : boxes[index]!.y + boxes[index]!.h / 2;
  return boxes.map((box, index) => {
    if (places[index] === "inside") return { place: "inside", maxWidth: undefined };
    const centre = box.x + box.w / 2;
    let leftRoom = centre + EDGE_ROOM, rightRoom = 1 - centre + EDGE_ROOM;
    boxes.forEach((other, at) => {
      if (at === index || places[at] === "inside" || Math.abs(line(at) - line(index)) >= LABEL_BAND) return;
      const gap = (other.x + other.w / 2 - centre) / 2;
      if (gap > 0) rightRoom = Math.min(rightRoom, gap);
      else leftRoom = Math.min(leftRoom, -gap);
    });
    // A share of the label's room, in its own screen's widths: CSS sizes it against the screen it belongs to.
    return { place: places[index]!, maxWidth: (2 * Math.min(leftRoom, rightRoom) - 0.02) / box.w };
  });
}

export function DisplayArrangement({
  group,
  value,
  disabled,
  held,
  describedBy,
}: {
  group: SettingsGroup;
  value: string;
  disabled: boolean;
  held: boolean;
  describedBy: string | undefined;
}) {
  const id = `setting-${group.id}`;
  const placed = group.choices.filter((choice): choice is SettingsChoice & { display: NonNullable<SettingsChoice["display"]> } => Boolean(choice.display));
  // A screen that cannot be placed (an unavailable one still chosen) is listed under the picture.
  const others = group.choices.filter((choice) => !choice.display && choice.id !== "primary");
  const follow = group.choices.find((choice) => choice.id === "primary");
  const primaryScreen = placed.find((choice) => choice.display.primary);
  const left = Math.min(...placed.map((choice) => choice.display.x)),
    top = Math.min(...placed.map((choice) => choice.display.y)),
    width = Math.max(...placed.map((choice) => choice.display.x + choice.display.width)) - left,
    height = Math.max(...placed.map((choice) => choice.display.y + choice.display.height)) - top;
  const boxes = placed.map(({ display: frame }) => ({ x: (frame.x - left) / width, y: (frame.y - top) / height, w: frame.width / width, h: frame.height / height }));
  const labels = placeLabels(boxes);
  // Room under (or over) the desk for the labels of the screens along its foot (or head).
  const roomBelow = labels.some((label, index) => label.place === "below" && boxes[index]!.y + boxes[index]!.h > 1 - LABEL_BAND),
    roomAbove = labels.some((label, index) => label.place === "above" && boxes[index]!.y < LABEL_BAND);
  const following = value === "primary";
  // Whether the stage is too narrow to write the switch's name (CSS decides, by the stage's width): read after a render
  // and again as the pointer or focus enters the picture, before it can reach the switch, so nothing watches the layout.
  const followName = useRef<HTMLSpanElement>(null);
  const [nameHidden, setNameHidden] = useState(false);
  const checkName = () => setNameHidden((followName.current?.offsetWidth ?? 1) <= 1);
  useLayoutEffect(checkName);
  // While another screen is being saved, choosing the committed one again is a newer intent that replaces it.
  const pending = model.saving?.group === group.id && model.saving.choice !== value;
  const choose = (choice: SettingsChoice, control = `${id}-${choice.id}`) => {
    if (!disabled && choice.enabled && (choice.id !== value || pending)) void model.choose(group.id, choice.id, control);
  };
  // The switch shows the newest intent, so a click while another screen saves turns following on rather than off.
  const followIntended = (pending ? model.saving!.choice : value) === "primary";
  const screens = [...placed, ...others];
  // One stop in the Tab order; the arrows move between the screens, choosing as they go.
  const focusable = (screens.find((choice) => choice.id === value && choice.enabled) ??
    (following && primaryScreen?.enabled ? primaryScreen : screens.find((choice) => choice.enabled)))?.id;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]:not(:disabled)")];
    const at = radios.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const next = radios[(at + step + radios.length) % radios.length]!;
    next.focus();
    const choice = group.choices.find((item) => `${id}-${item.id}` === next.id);
    if (choice) choose(choice);
  };
  return (
    <div id={id} role="group" className="arrangement" data-held={held || undefined} aria-labelledby={`${id}-label`} aria-describedby={describedBy} onPointerEnter={checkName} onFocus={checkName}>
      <div className="arrangement-stage">
        <div role="radiogroup" className="arrangement-screens" aria-labelledby={`${id}-label`} onKeyDown={onKeyDown}>
        <div
          className="arrangement-desk"
          data-room-below={roomBelow || undefined}
          data-room-above={roomAbove || undefined}
          style={{ aspectRatio: `${width} / ${height}`, ["--desk-ratio" as string]: width / height }}
        >
          {placed.map((choice, index) => {
            const frame = choice.display,
              box = boxes[index]!,
              label = labels[index]!,
              checked = choice.id === value;
            return (
              <button
                key={choice.id}
                id={`${id}-${choice.id}`}
                type="button"
                role="radio"
                className="display-tile"
                aria-checked={checked}
                aria-label={choice.label}
                data-primary={frame.primary || undefined}
                data-stand={label.place === "below" || undefined}
                data-following={(following && frame.primary) || undefined}
                tabIndex={choice.id === focusable ? 0 : -1}
                disabled={disabled || !choice.enabled}
                style={{ left: percent(box.x), top: percent(box.y), width: percent(box.w), height: percent(box.h) }}
                onClick={() => choose(choice)}
              >
                <span className="display-screen">
                  {(checked || (following && frame.primary)) && <Check className="display-check" aria-hidden="true" />}
                </span>
                {/* Part of the button, so a click on the name chooses the screen; the button's label already reads it. */}
                <span
                  className="display-label"
                  data-place={label.place}
                  style={label.maxWidth === undefined ? undefined : { maxWidth: `min(180px, ${percent(label.maxWidth)})` }}
                >
                  <span className="display-name">{frame.name}</span>
                  <span className="display-pixels">{frame.pixels}</span>
                </span>
              </button>
            );
          })}
        </div>
        {others.length > 0 && (
        <div className="arrangement-options">
        {others.map((choice) => (
          <button
            key={choice.id}
            id={`${id}-${choice.id}`}
            type="button"
            role="radio"
            className="arrangement-option"
            aria-checked={choice.id === value}
            tabIndex={choice.id === focusable ? 0 : -1}
            disabled={disabled || !choice.enabled}
            onClick={() => choose(choice)}
          >
            <span className="arrangement-radio" aria-hidden="true" />
            {choice.label}
          </button>
        ))}
        </div>
        )}
        </div>
        {follow && (
          <div className="arrangement-options">
            <div className="arrangement-option">
              {/* A narrow stage keeps only the switch in its corner, its name read aloud and shown on hover. */}
              <ControlTooltip label={nameHidden ? model.text("Follow the primary display") : undefined}>
                <Switch
                  id={`${id}-primary`}
                  size="sm"
                  checked={followIntended}
                  disabled={disabled || (followIntended ? !primaryScreen?.enabled : !follow.enabled)}
                  className={held ? "data-disabled:cursor-default data-disabled:opacity-100" : undefined}
                  onCheckedChange={(checked) => {
                    const next = checked ? follow : primaryScreen;
                    if (next) choose(next, `${id}-primary`);
                  }}
                />
              </ControlTooltip>
              {/* The name is always read; it is written only where the stage has room for it. */}
              <label htmlFor={`${id}-primary`}>
                <span className="sr-only">{model.text("Follow the primary display")}</span>
                <span ref={followName} className="arrangement-follow-text" aria-hidden="true">{model.text("Follow the primary display")}</span>
              </label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
