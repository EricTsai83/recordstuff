/** The Recording and General tabs: model-driven rows grouped into sections, with their controls and explanations. */
import { useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, CircleHelp, Sun, Moon, Monitor, Keyboard, Settings2, Folder, Globe, Power, Code2, Bell, Timer, Volume2, Gauge, FileText, HardDrive, Info } from "lucide-react";
import type { SettingsGroup, SettingsChoice } from "../../../shared/settings-panel";
import { translate } from "../../../shared/i18n";
import { fileNameTemplateProblem, fileNameProblemText, formatFileName } from "../../../shared/file-name";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { NativeSelect, NativeSelectOption } from "../../components/ui/native-select";
import { Switch } from "../../components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { Card, CardContent } from "../../components/ui/card";
import { Popover, PopoverTrigger, PopoverContent } from "../../components/ui/popover";
import { flushSync } from "react-dom";
import * as model from "../settings-controller";
import { ShortcutEditor } from "./shortcut-editor";

const icons = {
  screen: Monitor,
  outputFolder: Folder,
  fileName: FileText,
  countdown: Timer,
  countdownSound: Volume2,
  videoQuality: Gauge,
  resolutionCap: Monitor,
  frameRate: Gauge,
  trayClick: Monitor,
  hotkey: Keyboard,
  notifications: Bell,
  language: Globe,
  appearance: Sun,
  updateChecks: Globe,
  updates: Globe,
  log: FileText,
  localData: HardDrive,
  about: Info,
};
export function GroupIcon({ id }: { id: string }) {
  const Icon = icons[id as keyof typeof icons] ?? Settings2;
  return <Icon className="row-icon" aria-hidden="true" />;
}
export function ActionIcon({ id }: { id: string }) {
  const Icon = id === "source" ? Code2 : id === "quit" ? Power : Globe;
  return <Icon aria-hidden="true" />;
}
export function Action({
  group,
  choice,
  id = `setting-${group.id}-${choice.id}`,
  wrap,
  className,
}: {
  group: SettingsGroup;
  choice: SettingsChoice;
  id?: string;
  /** A row's button wraps its label rather than run past the card, which would hide its end (plan 067). */
  wrap?: boolean;
  className?: string | undefined;
}) {
  const busy = Boolean(model.saving) || choice.busy === true;
  return (
    <Button
      id={id}
      data-action={choice.id}
      variant={group.id === "localData" ? "destructive" : choice.id === "quit" ? "ghost" : "outline"}
      wrap={wrap}
      className={className}
      disabled={!group.enabled || !choice.enabled}
      aria-disabled={busy || !group.enabled || !choice.enabled}
      aria-label={group.id === "about" ? choice.label : undefined}
      title={group.id === "about" ? choice.label : undefined}
      onClick={() => {
        if (!busy && group.enabled && choice.enabled)
          void model.choose(group.id, choice.id, id);
      }}
    >
      {group.id === "about" && <ActionIcon id={choice.id} />}
      {choice.label}
    </Button>
  );
}
export function Explanation({ group }: { group: SettingsGroup }) {
  const id = `setting-${group.id}`,
    open = model.infoOpen?.id === group.id;
  return (
    <>
      <span id={`${id}-info`} hidden={!group.info} className="sr-only">
        {group.info}
      </span>
      <Popover
        open={open && Boolean(group.info)}
        onOpenChange={(value) => {
          if (value) model.showInfo(group.id, true);
          else if (open && !model.infoOpen?.pinned) model.hideInfo();
        }}
      >
        <PopoverTrigger
          render={<Button variant="ghost" size="icon-sm" />}
          id={`${id}-info-button`}
          hidden={!group.info}
          aria-label={translate("More about {label}", model.view?.language, {
            label: group.label,
          })}
          aria-describedby={group.info ? `${id}-info` : undefined}
          aria-expanded={open}
          onMouseEnter={() => model.showInfo(group.id, false)}
          onMouseLeave={() => model.leaveInfo(group.id)}
          onFocus={() => model.showInfo(group.id, false)}
          onBlur={() => {
            if (open) model.hideInfo();
          }}
          onClick={(event) => {
            event.preventBaseUIHandler();
            event.preventDefault();
            if (open && model.infoOpen?.pinned) model.hideInfo();
            else model.showInfo(group.id, true);
          }}
        >
          <CircleHelp className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          id={`${id}-info-popup`}
          className="info-popup"
          side="top"
          initialFocus={false}
          finalFocus={false}
          onMouseEnter={() => model.showInfo(group.id, false)}
          onMouseLeave={() => model.leaveInfo(group.id)}
        >
          {group.info}
        </PopoverContent>
      </Popover>
    </>
  );
}
export function TextSetting({
  group,
  description,
}: {
  group: SettingsGroup;
  description: string;
}) {
  const value = model.committed(group),
    [draft, setDraft] = useState(value),
    field = useRef<HTMLInputElement>(null),
    submitted = useRef<string | undefined>(undefined),
    lastCommitted = useRef(value);
  useLayoutEffect(() => {
    if (lastCommitted.current !== value) {
      lastCommitted.current = value;
      if (draft.trim() === value || document.activeElement !== field.current)
        setDraft(value);
    }
  }, [value, draft]);
  const submit = (): void => {
    const name = (field.current?.value ?? draft).trim();
    if (
      !group.enabled ||
      name === model.committed(group) ||
      name === submitted.current
    )
      return;
    submitted.current = name;
    void model.choose(group.id, name, `setting-${group.id}`).finally(() => {
      submitted.current = undefined;
    });
  };
  const problem = fileNameTemplateProblem(draft.trim()),
    refused = Boolean(problem) && draft.trim() !== value;
  const note =
    draft.trim() === value
      ? (group.note ?? "")
      : problem
        ? fileNameProblemText(problem, model.view?.language ?? "en")
        : translate("Example: {name}", model.view?.language, {
            name: `${formatFileName(draft.trim(), new Date())}.mp4`,
          });
  return (
    <>
      <Input
        ref={field}
        id={`setting-${group.id}`}
        className="text-field"
        value={draft}
        disabled={
          !group.enabled ||
          Boolean(model.saving && model.saving.group !== group.id)
        }
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-describedby={description || undefined}
        aria-invalid={refused || undefined}
        onInput={(event) => {
          const draft = event.currentTarget.value;
          model.clearFailure(group.id);
          flushSync(() => setDraft(draft));
        }}
        onBlur={submit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (
            event.key === "Escape" &&
            (field.current?.value ?? draft) !== value
          ) {
            event.preventDefault();
            event.stopPropagation();
            setDraft(value);
            model.clearFailure(group.id);
          }
        }}
      />
      <p
        className={`note text-note${refused ? " text-note-error" : ""}`}
        id={`setting-${group.id}-note`}
        hidden={!note}
      >
        {note}
      </p>
    </>
  );
}
export function SettingRow({ group }: { group: SettingsGroup }) {
  const id = `setting-${group.id}`,
    ownFailure = model.failure?.group === group.id ? model.failure : undefined;
  const actions =
    group.kind === "actions" ? group.choices : (group.actions ?? []);
  const busy = Boolean(model.saving && model.saving.group !== group.id),
    value = model.committed(group),
    diagnosticVisible = Boolean(group.diagnostics?.length || ownFailure);
  const description = [
    group.capturing ? `${id}-help` : "",
    group.note ? `${id}-note` : "",
    group.info ? `${id}-info` : "",
    diagnosticVisible ? `${id}-diagnostics` : "",
    group.captureTimedOut ? `${id}-timeout` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const desc = { "aria-describedby": description || undefined };
  const [hadCapture, setHadCapture] = useState(Boolean(group.capturing));
  useLayoutEffect(() => {
    if (
      hadCapture &&
      !group.capturing &&
      document.hasFocus() &&
      document.activeElement?.closest(".capture-area")
    )
      document.getElementById(id)?.focus({ preventScroll: true });
    setHadCapture(Boolean(group.capturing));
  }, [group.capturing, hadCapture, id]);
  const recoveryRef = useRef<HTMLButtonElement>(null),
    retryRef = useRef<HTMLButtonElement>(null);
  const recover = Boolean(
      group.recovery &&
      group.choices.some(
        (choice) => choice.id === group.recovery?.choice && choice.enabled,
      ),
    ),
    retry = model.retryAllowed(group);
  useLayoutEffect(() => {
    if (
      document.hasFocus() &&
      ((!recover && document.activeElement === recoveryRef.current) ||
        (!retry && document.activeElement === retryRef.current))
    )
      model
        .groupControl(group.id, model.saving?.choice ?? model.failure?.choice)
        ?.focus({ preventScroll: true });
  });
  return (
    <div
      id={`${id}-row`}
      className="row"
      aria-busy={model.saving?.group === group.id}
    >
      <div className="row-line">
        <div className="group-title">
          <GroupIcon id={group.id} />
          {group.kind === "actions" || group.control === "segmented" ? (
            <span
              id={`${id}-label`}
              className="group-label text-xs leading-[1.35]"
              hidden={!group.label}
            >
              {group.label}
            </span>
          ) : (
            <Label
              id={`${id}-label`}
              className="group-label text-xs leading-[1.35]"
              htmlFor={id}
              hidden={!group.label}
            >
              {group.label}
            </Label>
          )}
          <Explanation group={group} />
        </div>
        <div
          className="controls"
          role={group.kind === "actions" ? "group" : undefined}
          aria-labelledby={group.kind === "actions" ? `${id}-label` : undefined}
        >
          {group.kind === "actions" ? (
            actions.map((choice) => (
              <Action
                key={choice.id}
                group={group}
                choice={choice}
                wrap
                // The sidebar's own Quit stands in for this one where the sidebar shows.
                className={
                  group.id === "about" && choice.id === "quit"
                    ? "wide:hidden"
                    : undefined
                }
              />
            ))
          ) : group.control === "switch" ? (
            <Switch
              id={id}
              aria-labelledby={`${id}-label`}
              checked={value === "on"}
              disabled={
                !group.enabled ||
                busy ||
                !group.choices.find(
                  (choice) => choice.id === (value === "on" ? "off" : "on"),
                )?.enabled
              }
              {...desc}
              onCheckedChange={(checked) =>
                void model.choose(group.id, checked ? "on" : "off", id)
              }
            />
          ) : group.control === "text" ? (
            <TextSetting group={group} description={description} />
          ) : group.control === "segmented" ? (
            <ToggleGroup
              id={id}
              className="segments rounded-[8px] bg-muted p-0.5"
              variant="segmented"
              size="segment"
              spacing={0.5}
              value={[value]}
              aria-labelledby={`${id}-label`}
              {...desc}
              onValueChange={(values) => {
                if (values[0] && values[0] !== value)
                  void model.choose(
                    group.id,
                    String(values[0]),
                    `${id}-${values[0]}`,
                  );
              }}
            >
              {group.choices.map((choice) => (
                <ToggleGroupItem
                  key={choice.id}
                  id={`${id}-${choice.id}`}
                  value={choice.id}
                  onClick={() => {
                    if (
                      model.saving?.group === group.id &&
                      model.saving.choice !== value &&
                      choice.id === value
                    )
                      void model.choose(
                        group.id,
                        choice.id,
                        `${id}-${choice.id}`,
                      );
                  }}
                  disabled={!group.enabled || !choice.enabled || busy}
                  aria-label={choice.label}
                  title={group.iconChoices ? choice.label : undefined}
                >
                  {group.iconChoices ? (
                    choice.id === "dark" ? (
                      <Moon className="segment-glyph" />
                    ) : choice.id === "light" ? (
                      <Sun className="segment-glyph" />
                    ) : (
                      <Monitor className="segment-glyph" />
                    )
                  ) : (
                    choice.label
                  )}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : (
            <NativeSelect
              id={id}
              className="max-w-[min(280px,100%)]"
              value={value}
              disabled={!group.enabled || busy}
              {...desc}
              onChange={(event) => {
                const choice = event.currentTarget.value;
                if (group.kind === "shortcut" && choice === "custom") {
                  event.currentTarget.value = value;
                  void model.capture(true);
                } else void model.choose(group.id, choice, id);
              }}
            >
              {group.choices.map((choice) => (
                <NativeSelectOption
                  key={choice.id}
                  value={choice.id}
                  disabled={!choice.enabled}
                >
                  {choice.label}
                </NativeSelectOption>
              ))}
              {group.kind === "shortcut" && (
                <NativeSelectOption
                  value="custom"
                  disabled={Boolean(
                    model.saving || model.arming || group.capturing,
                  )}
                >
                  {model.text("Custom shortcut…")}
                </NativeSelectOption>
              )}
            </NativeSelect>
          )}
        </div>
      </div>
      {group.kind === "shortcut" && <ShortcutEditor group={group} />}
      <div
        id={`${id}-diagnostics`}
        className="diagnostics"
        hidden={!diagnosticVisible}
      >
        <div className="diagnostic-content">
          {group.diagnostics?.map((diagnostic, index) => (
            <div key={index} className={`diagnostic ${diagnostic.kind}`}>
              <strong className="diagnostic-heading">
                <CircleAlert />
                {diagnostic.heading}
              </strong>
              <p>{diagnostic.reason}</p>
              <p className="guidance">{diagnostic.guidance}</p>
            </div>
          ))}
        </div>
        <div className="save-error diagnostic" hidden={!ownFailure}>
          <strong>
            {model.text(
              ownFailure?.refused && group.kind === "shortcut"
                ? "Shortcut unavailable"
                : ownFailure && model.isAction(group, ownFailure.choice)
                  ? "Action failed"
                  : "Change was not saved",
            )}
          </strong>
          <p>{ownFailure?.text}</p>
        </div>
        <Button
          ref={recoveryRef}
          id={`${id}-recovery`}
          className="recovery"
          variant="outline"
          hidden={!recover}
          disabled={!group.enabled}
          aria-disabled={!group.enabled || Boolean(model.saving)}
          onClick={() => {
            if (group.recovery && !model.saving && group.enabled)
              void model.choose(
                group.id,
                group.recovery.choice,
                `${id}-recovery`,
              );
          }}
        >
          {group.recovery?.label}
        </Button>
        <Button
          ref={retryRef}
          id={`${id}-retry`}
          className="retry"
          variant="outline"
          hidden={!retry}
          disabled={!group.enabled}
          aria-disabled={!group.enabled || Boolean(model.saving)}
          onClick={() => {
            if (retry && model.failure?.choice && !model.saving)
              void model.choose(group.id, model.failure.choice, `${id}-retry`);
          }}
        >
          {model.text(
            ownFailure && model.isAction(group, ownFailure.choice)
              ? "Retry"
              : "Retry save",
          )}
        </Button>
        <p
          className="reselect"
          hidden={
            !ownFailure ||
            model.isAction(group, ownFailure.choice) ||
            ownFailure.refused === true ||
            retry
          }
        >
          {model.text("Choose the setting again to retry.")}
        </p>
      </div>
      {group.control !== "text" && (
        <p id={`${id}-note`} className="note" hidden={!group.note}>
          {group.note}
        </p>
      )}
      {group.kind !== "actions" && actions.length > 0 && (
        <div className="row-actions">
          {actions.map((choice) => (
            <Action key={choice.id} group={group} choice={choice} wrap />
          ))}
        </div>
      )}
      <span className="applying sr-only">
        {model.saving?.group === group.id &&
        !actions.some((choice) => choice.id === model.saving?.choice)
          ? model.text("Applying…")
          : ""}
      </span>
    </div>
  );
}
export function Preferences() {
  const groups =
    model.view?.groups.filter((group) => group.tab === model.selectedTab) ?? [];
  const sections: Array<{ id: string; groups: SettingsGroup[] }> = [];
  for (const group of groups) {
    const id = group.section ?? group.id,
      prior = sections.at(-1);
    if (prior?.id === id) prior.groups.push(group);
    else sections.push({ id, groups: [group] });
  }
  return sections.map((section) => (
    <section
      className={`section${section.id === "about" ? " about" : ""}`}
      key={section.id}
    >
      <h2
        className="section-heading"
        id={`setting-${section.groups[0]!.id}-section-heading`}
        hidden={!section.groups[0]!.sectionHeading}
      >
        {section.groups[0]!.sectionHeading}
      </h2>
      {/* The rows' own 12px plus the card's 4px puts the first and last rows as far from its edge as its sides (14px). */}
      <Card size="xs">
        <CardContent className="inset-list px-3.5">
          {section.groups.map((group) => (
            <SettingRow key={group.id} group={group} />
          ))}
        </CardContent>
      </Card>
      <p
        className="section-footnote"
        hidden={!section.groups.some((group) => group.footnote)}
      >
        {section.groups.find((group) => group.footnote)?.footnote}
      </p>
    </section>
  ));
}
