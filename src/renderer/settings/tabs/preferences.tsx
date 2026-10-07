/** Model-driven preference, diagnostic and cleanup rows grouped into sections. */
import { useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, CircleHelp, Sun, Moon, Monitor, Keyboard, Settings2, Folder, Globe, Power, Bell, Timer, Volume2, Gauge, FileText, Info } from "lucide-react";
import type { SettingsGroup, SettingsChoice } from "../../../shared/settings-panel";
import { translate } from "../../../shared/i18n";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Field, FieldLabel, FieldTitle, FieldDescription, FieldError } from "../../components/ui/field";
import { ControlTooltip } from "../../components/control-tooltip";
import { useTextSetting } from "../use-text-setting";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { Card, CardContent } from "../../components/ui/card";
import { Popover, PopoverTrigger, PopoverContent } from "../../components/ui/popover";
import { flushSync } from "react-dom";
import * as model from "../settings-controller";
import { ShortcutEditor } from "./shortcut-editor";
import { WindowActions } from "../window-actions";

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
  localData: CircleAlert,
  about: Info,
};
export function GroupIcon({ id }: { id: string }) {
  const Icon = icons[id as keyof typeof icons] ?? Settings2;
  return <Icon className="row-icon" aria-hidden="true" />;
}
export function ActionIcon({ id }: { id: string }) {
  if (id === "source") return (
    // The same GitHub mark as the website's GitHubMark.astro; Lucide's installed set has no brand icons.
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 007.86 10.93c.58.1.79-.25.79-.56v-2c-3.2.69-3.88-1.37-3.88-1.37-.52-1.33-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.68 1.25 3.33.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.27-5.24-5.67 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.45.11-3.02 0 0 .96-.31 3.15 1.18a10.96 10.96 0 015.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.57.23 2.73.11 3.02.74.8 1.18 1.83 1.18 3.08 0 4.41-2.7 5.38-5.27 5.66.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.56A11.5 11.5 0 0023.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
  const Icon = id === "quit" ? Power : Globe;
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
  const busy = Boolean(model.saving) || choice.busy === true,
    iconOnly = group.id === "about" && (choice.id === "website" || choice.id === "source");
  return (
    <ControlTooltip label={iconOnly ? choice.label : undefined}>
      <Button
        id={id}
        data-action={choice.id}
        variant={group.id === "log" ? "link" : group.id === "localData" ? "destructive" : group.id === "about" || choice.id === "quit" ? "ghost" : "outline"}
        size={iconOnly ? "icon" : "default"}
        wrap={iconOnly ? false : wrap}
        className={group.id === "log" ? `h-auto min-h-6 justify-start gap-2 rounded-none px-0 text-foreground hover:text-primary hover:[&>svg]:text-primary hover:border-b-primary hover:no-underline ${className ?? ""}` : iconOnly ? `px-0 ${className ?? ""}` : className}
        disabled={!group.enabled || !choice.enabled}
        aria-disabled={busy || !group.enabled || !choice.enabled}
        aria-label={group.id === "about" ? choice.label : undefined}
        aria-describedby={group.id === "localData" ? "setting-localData-note settings-data-cleanup-warning" : undefined}
        onClick={() => {
          if (!busy && group.enabled && choice.enabled)
            void model.choose(group.id, choice.id, id);
        }}
      >
        {group.id === "log" && <GroupIcon id={group.id} />}
        {group.id === "about" && <ActionIcon id={choice.id} />}
        {!iconOnly && (group.id === "log" ? group.label : choice.label)}
      </Button>
    </ControlTooltip>
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
  const { value, held, draft, field, submit, refused, note, edit, reset } = useTextSetting(group);
  return (
    <>
      <Input
        ref={field}
        id={`setting-${group.id}`}
        className={held ? "text-field disabled:cursor-default disabled:opacity-100" : "text-field"}
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
          flushSync(() => edit(draft));
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
            reset();
          }
        }}
      />
      <FieldDescription
        variant="note"
        className={`note text-note${refused ? " text-note-error" : ""}`}
        id={`setting-${group.id}-note`}
        hidden={!note}
      >
        {note}
      </FieldDescription>
    </>
  );
}
export function SettingRow({ group }: { group: SettingsGroup }) {
  const id = `setting-${group.id}`,
    ownFailure = model.failure?.group === group.id ? model.failure : undefined;
  const actions =
    group.kind === "actions" ? group.choices : (group.actions ?? []);
  const busy = Boolean(model.saving && model.saving.group !== group.id),
    // While another setting saves, this row's controls hold still but keep their look: dimming every control on the
    // page for each save read as the whole tab flickering (2026-10-07; the pre-shadcn page had .saving-disabled).
    held = busy && group.enabled,
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
  const Row = group.kind === "actions" ? "div" : Field;
  return (
    <Row
      id={`${id}-row`}
      className={group.id === "about" ? "row about-row" : "row block gap-0 [&>*]:w-auto"}
      aria-busy={model.saving?.group === group.id}
    >
      <div className="row-line">
        {group.id === "log" ? (
          <Action group={group} choice={group.choices[0]!} wrap />
        ) : group.id === "about" ? (
          <div className="about-identity">
            <h2 id={`${id}-label`} className="about-title">
              <span className="about-mark" aria-hidden="true" />
              RecordStuff
            </h2>
            <p id={`${id}-note`} className="about-version" hidden={!group.note}>{group.note}</p>
            <p className="group-label about-credit">{group.label}</p>
          </div>
        ) : <div className="group-title">
          <GroupIcon id={group.id} />
          {group.kind === "actions" || group.control === "segmented" ? (
            <FieldTitle
              id={`${id}-label`}
              className="group-label text-xs leading-[1.35]"
              hidden={!group.label}
            >
              {group.id === "localData" ? model.text("Clear local app data") : group.label}
            </FieldTitle>
          ) : (
            <FieldLabel
              id={`${id}-label`}
              className="group-label text-xs leading-[1.35]"
              htmlFor={id}
              hidden={!group.label}
            >
              {group.label}
            </FieldLabel>
          )}
          <Explanation group={group} />
        </div>}
        {group.id !== "log" && <div
          className="controls"
          role={group.kind === "actions" ? "group" : undefined}
          aria-labelledby={group.kind === "actions" ? `${id}-label` : undefined}
        >
          {group.kind === "actions" ? (
            actions.filter(choice => group.id !== "about" || choice.id !== "hide").map((choice) => group.id === "about" && choice.id === "quit" ? (
              <div key={choice.id} className="wide:hidden">
                <WindowActions group={group} quit={choice} />
              </div>
            ) : (
              <Action
                key={choice.id}
                group={group}
                choice={choice}
                wrap
              />
            ))
          ) : group.control === "switch" ? (
            <Switch
              id={id}
              aria-labelledby={`${id}-label`}
              checked={value === "on"}
              className={held ? "data-disabled:cursor-default data-disabled:opacity-100" : undefined}
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
              className="segments"
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
                <ControlTooltip key={choice.id} label={group.iconChoices ? choice.label : undefined}>
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
                    className={held && choice.enabled ? "disabled:opacity-100" : undefined}
                    aria-label={choice.label}
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
                </ControlTooltip>
              ))}
            </ToggleGroup>
          ) : (
            <Select
              id={id}
              value={value}
              items={[
                ...group.choices.map((choice) => ({ value: choice.id, label: choice.label })),
                ...(group.kind === "shortcut"
                  ? [{ value: "custom", label: model.text("Custom shortcut…") }]
                  : []),
              ]}
              disabled={!group.enabled || busy}
              onValueChange={(choice) => {
                if (typeof choice !== "string" || choice === value) return;
                // Custom… opens the shortcut editor; the menu keeps showing the shortcut in use.
                if (group.kind === "shortcut" && choice === "custom")
                  void model.capture(true);
                else void model.choose(group.id, choice, id);
              }}
            >
              <SelectTrigger
                id={id}
                data-value={value}
                className={
                  held
                    ? "max-w-[min(280px,100%)] disabled:cursor-default disabled:opacity-100"
                    : "max-w-[min(280px,100%)]"
                }
                {...desc}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} align="end">
                {group.choices.map((choice) => (
                  <SelectItem
                    key={choice.id}
                    value={choice.id}
                    data-value={choice.id}
                    disabled={!choice.enabled}
                  >
                    {choice.label}
                  </SelectItem>
                ))}
                {group.kind === "shortcut" && (
                  <SelectItem
                    value="custom"
                    data-value="custom"
                    disabled={Boolean(
                      model.saving || model.arming || group.capturing,
                    )}
                  >
                    {model.text("Custom shortcut…")}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          )}
        </div>}
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
        <FieldError role={undefined} className="save-error diagnostic" hidden={!ownFailure}>
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
        </FieldError>
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
      {group.control !== "text" && group.id !== "about" && (
        <FieldDescription variant="note" id={`${id}-note`} className="note" hidden={!group.note}>
          {group.note}
        </FieldDescription>
      )}
      {group.id === "localData" && (
        <p id="settings-data-cleanup-warning" className="note cleanup-warning">
          {model.text("This permanently deletes the listed app data and cannot be undone.")}
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
    </Row>
  );
}
function CleanupSection({ groups }: { groups: SettingsGroup[] }) {
  return (
    <section className="section cleanup-section" id="settings-data-cleanup" aria-labelledby="settings-data-cleanup-heading" aria-describedby="settings-data-cleanup-warning">
      <h2 className="section-heading" id="settings-data-cleanup-heading">
        {groups[0]?.sectionHeading ?? model.text("Reset and cleanup")}
      </h2>
      {groups.map((group) => <SettingRow key={group.id} group={group} />)}
    </section>
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
  return sections.map((section) => section.id === "cleanup" ? (
    <CleanupSection key={section.id} groups={section.groups} />
  ) : section.id === "about" ? (
    <footer className="section about" key={section.id} aria-label={model.text("About RecordStuff")}>
      {section.groups.map((group) => <SettingRow key={group.id} group={group} />)}
    </footer>
  ) : (
    <section
      className="section"
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
      {section.id === "diagnostics" ? section.groups.map((group) => (
        <SettingRow key={group.id} group={group} />
      )) : <Card size="xs">
        <CardContent className="inset-list px-3.5">
          {section.groups.map((group) => (
            <SettingRow key={group.id} group={group} />
          ))}
        </CardContent>
      </Card>}
      <p
        className="section-footnote"
        hidden={!section.groups.some((group) => group.footnote)}
      >
        {section.groups.find((group) => group.footnote)?.footnote}
      </p>
    </section>
  ));
}
