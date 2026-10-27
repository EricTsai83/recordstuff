/** Model-driven preference, diagnostic and cleanup rows grouped into sections. */
import { useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, Monitor, Moon, Sun, TriangleAlert } from "lucide-react";
import type { SettingsGroup } from "../../../shared/settings-panel";
import { Button } from "../../components/ui/button";
import { Field, FieldLabel, FieldTitle, FieldDescription, FieldError } from "../../components/ui/field";
import { ControlTooltip } from "../../components/control-tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { Card, CardContent } from "../../components/ui/card";
import * as model from "../settings-controller";
import { ShortcutEditor } from "./shortcut-editor";
import { ShortcutRows } from "./shortcut-list";
import { DisplayArrangement } from "./display-arrangement";
import { CameraPreview } from "./camera-preview";
import { AudioMeter, InputMeter } from "./audio-meter";
import { CameraTestButton, CameraTestPicture } from "./camera-test";
import { Action } from "./row-parts/action";
import { Elapsed } from "./row-parts/elapsed";
import { Explanation } from "./row-parts/explanation";
import { GroupIcon, SectionIcon } from "./row-parts/icons";
import { SliderSetting } from "./row-parts/slider";
import { TextSetting } from "./row-parts/text-setting";

function SettingRow({ group }: { group: SettingsGroup }) {
  return group.kind === "shortcutList" ? <ShortcutRows group={group} /> : <PreferenceRow group={group} />;
}
function PreferenceRow({ group }: { group: SettingsGroup }) {
  const id = `setting-${group.id}`,
    ownFailure = model.failureOf(group.id);
  const actions =
    group.kind === "actions" ? group.choices : (group.actions ?? []);
  // While another setting saves, this row's controls stay usable: each setting's choice is sent at once, never behind
  // another's (controller/core.ts, 2026-10-22), so nothing holds still or dims for another setting's save.
  const value = model.committed(group),
    diagnosticVisible = Boolean(group.diagnostics?.length || ownFailure);
  const description = [
    group.capturing ? `${id}-help` : "",
    group.note ? `${id}-note` : "",
    group.problem ? `${id}-problem` : "",
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
        .groupControl(group.id, model.savingOf(group.id)?.choice ?? ownFailure?.choice)
        ?.focus({ preventScroll: true });
  });
  // Test camera's picture (plan 097, D4) lasts while the row is shown and pressed: leaving the tab ends it.
  const [testing, setTesting] = useState(false);
  const Row = group.kind === "actions" ? "div" : Field;
  return (
    <Row
      id={`${id}-row`}
      // The Keyboard Shortcuts tab's Change… lands here when a recording or a save has the control disabled (plan 073).
      tabIndex={group.kind === "shortcut" ? -1 : undefined}
      className={group.id === "about" ? "row about-row" : "row block gap-0 [&>*]:w-auto"}
      aria-busy={Boolean(model.savingOf(group.id))}
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
          {group.kind === "actions" || group.control === "segmented" || group.control === "arrangement" || group.control === "cameraPreview" || group.control === "meter" || group.control === "inputMeter" || group.control === "cameraTest" ? (
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
          {group.elapsedSince && <Elapsed since={group.elapsedSince} />}
          {group.kind === "actions" ? (
            // Hide and Quit are the sidebar's, at every width.
            actions.filter(choice => group.id !== "about" || (choice.id !== "hide" && choice.id !== "quit")).map((choice) => (
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
              disabled={
                !group.enabled ||
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
          ) : group.control === "arrangement" ? (
            <DisplayArrangement group={group} value={value} disabled={!group.enabled} describedBy={description || undefined} />
          ) : group.control === "meter" && group.meter ? (
            <AudioMeter group={group} source={group.meter.source} muted={value === "mute"} disabled={!group.enabled} describedBy={description || undefined} />
          ) : group.control === "inputMeter" ? (
            <InputMeter group={group} disabled={!group.enabled} describedBy={description || undefined} />
          ) : group.control === "cameraTest" ? (
            <CameraTestButton group={group} on={testing} onChange={setTesting} describedBy={description || undefined} />
          ) : group.control === "cameraPreview" && group.cameraPreview ? (
            <CameraPreview group={group} preview={group.cameraPreview} disabled={!group.enabled} describedBy={description || undefined} />
          ) : group.control === "slider" && group.slider ? (
            <SliderSetting id={id} group={group} slider={group.slider} disabled={!group.enabled} describedBy={description || undefined} />
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
                      const saving = model.savingOf(group.id);
                      if (saving && saving.choice !== value && choice.id === value)
                        void model.choose(
                          group.id,
                          choice.id,
                          `${id}-${choice.id}`,
                        );
                    }}
                    disabled={!group.enabled || !choice.enabled}
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
              disabled={!group.enabled}
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
                className="max-w-[min(280px,100%)] whitespace-normal data-[size=default]:h-auto min-h-7 py-1 leading-[1.4]"
                {...desc}
              >
                {/* A block, not a flex box: a long choice (a screen with its size) wraps in full instead of running past the card. */}
                <SelectValue className="block! whitespace-normal!" />
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
                      model.anySaving() || model.arming || group.capturing,
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
      {/* A device's problem in the words the Studio's picker uses (plan 097, D2). */}
      {group.problem && <p id={`${id}-problem`} className="row-problem"><TriangleAlert aria-hidden="true" />{group.problem}</p>}
      {group.control === "cameraTest" && <CameraTestPicture group={group} on={testing} onChange={setTesting} />}
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
          aria-disabled={!group.enabled || Boolean(model.savingOf(group.id))}
          onClick={() => {
            if (group.recovery && !model.savingOf(group.id) && group.enabled)
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
          aria-disabled={!group.enabled || Boolean(model.savingOf(group.id))}
          onClick={() => {
            if (retry && ownFailure?.choice && !model.savingOf(group.id))
              void model.choose(group.id, ownFailure.choice, `${id}-retry`);
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
          {model.text("This cannot be undone, and RecordStuff will quit.")}
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
        {model.savingOf(group.id) &&
        !actions.some((choice) => choice.id === model.savingOf(group.id)?.choice)
          ? model.text("Applying…")
          : ""}
      </span>
    </Row>
  );
}
function CleanupSection({ groups }: { groups: SettingsGroup[] }) {
  return (
    <section className="section plain-section cleanup-section" id="settings-data-cleanup" aria-labelledby="settings-data-cleanup-heading" aria-describedby="settings-data-cleanup-warning">
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
      className={section.id === "diagnostics" ? "section plain-section" : "section"}
      key={section.id}
    >
      <h2
        className="section-heading"
        id={`setting-${section.groups[0]!.id}-section-heading`}
        hidden={!section.groups[0]!.sectionHeading}
      >
        <SectionIcon id={section.id} />
        {section.groups[0]!.sectionHeading}
      </h2>
      {/* A section's rows share one raised panel and are told apart by their spacing alone: no hairline between them. */}
      {section.id === "diagnostics" ? section.groups.map((group) => (
        <SettingRow key={group.id} group={group} />
      )) : <Card size="xs" className="rounded-xl bg-card py-1 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_2px_10px_rgb(0_0_0/0.035)] ring-0 dark:bg-card dark:shadow-none">
        <CardContent className="inset-list px-4">
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
