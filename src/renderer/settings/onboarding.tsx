/**
 * The first-launch guide (2026-10-26, the maintainer's request): over the main window on a new install, what a
 * recording needs, one line to a step, each with its name and the one press that moves it on, what it is for behind its
 * ⓘ (the maintainer's choice of a sparse layout, the same day). macOS's own prompts come only from those presses, and
 * the microphone's and the camera's only once the screen is allowed, so the steps are taken in order. Main says what
 * each step stands at (`view.onboarding`) and owns every press (the `onboarding` group's choices); the page words them.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { Camera, CircleCheck, CircleHelp, Mic, MonitorUp, TriangleAlert } from "lucide-react";
import type { OnboardingInputView } from "../../shared/settings-panel";
import { translate, type PlainMessageKey } from "../../shared/i18n";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { ControlTooltip } from "../components/control-tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import * as model from "./settings-controller";

const GROUP = "onboarding";

function press(choice: string, control: string): void {
  void model.choose(GROUP, choice, control);
}

function Allowed() {
  return <span className="onboarding-allowed"><CircleCheck aria-hidden="true" />{model.text("Allowed")}</span>;
}

/** One step: its icon, name, badge and ⓘ, then where it stands with its press at the line's end; a notice under it. */
function Step({ id, icon, title, badge, about, children, notice }: {
  id: string; icon: ReactNode; title: string; badge: string; about: PlainMessageKey; children: ReactNode; notice?: ReactNode;
}) {
  const detail = model.text(about);
  return (
    <li className="onboarding-step">
      <span className="onboarding-step-icon" aria-hidden="true">{icon}</span>
      <span className="flex items-center gap-1.5 min-w-0">
        <span id={`${id}-title`} className="text-xs font-semibold">{title}</span>
        <span className="py-0 px-1.5 rounded-full text-2xs text-muted-foreground bg-muted">{badge}</span>
        {/* Opened at once, as every ? in the app (2026-10-26, the maintainer's request): it is hovered to be read. */}
        <ControlTooltip label={detail} delay={0}>
          <Button variant="ghost" size="icon-sm" className="onboarding-about" id={`${id}-about`}
            aria-label={translate("More about {label}", model.view?.language, { label: title })} aria-describedby={`${id}-detail`}>
            <CircleHelp aria-hidden="true" />
          </Button>
        </ControlTooltip>
        <span id={`${id}-detail`} className="sr-only">{detail}</span>
      </span>
      <span className="flex items-center justify-end gap-2">{children}</span>
      {notice}
    </li>
  );
}

/**
 * The microphone's or the camera's line (2026-11-01, the maintainer's choice of one control): its switch, which asks
 * macOS as it is turned on and reads on only once the input will be recorded; Allowed beside it when it is. Refused by
 * macOS, the switch can do nothing until System Settings allows it, so in its place a notice under the line says why,
 * in the words Recording settings uses, with the same filled Open Settings as the screen's step (the maintainer's
 * request the same day: a grey "Not allowed", an outlined button and an off switch side by side said neither why nor
 * what to press).
 */
function InputStep({ name, input, busy, waiting }: { name: "microphone" | "camera"; input: OnboardingInputView; busy: boolean; waiting: boolean }) {
  const id = `onboarding-${name}`;
  const label = model.text(name === "microphone" ? "Microphone" : "Camera");
  // The screen first (native round, 2026-10-26): the inputs wait for it, so the first press is plain.
  const disabled = busy || input.locked || waiting;
  // Never asked, it is not recorded yet, whatever is stored: off until turned on asks macOS (finishing turns it off).
  const on = input.enabled && input.access !== "ask";
  const refused = input.access === "denied";
  // Refused at the prompt, the switch the press came from is gone: its place in the dialog is Open Settings, whose
  // description says why (review, 2026-11-01), not the tab under the modal dialog, which cannot take the focus.
  const toggle = (checked: boolean): void => {
    void model.choose(GROUP, `${name}:${checked ? "on" : "off"}`, `${id}-switch`).then(() => requestAnimationFrame(() => {
      const settings = document.getElementById(`${id}-settings`);
      if (settings && !document.getElementById(`${id}-switch`) && !document.getElementById("onboarding")?.contains(document.activeElement))
        settings.focus({ preventScroll: true });
    }));
  };
  const notice = refused ? (
    <div className="onboarding-step-notice">
      <TriangleAlert aria-hidden="true" />
      <p id={`${id}-refused`}>{model.text(name === "microphone"
        ? "macOS does not allow the microphone. Allow RecordStuff in System Settings to turn it on."
        : "macOS does not allow the camera. Allow RecordStuff in System Settings to turn it on.")}</p>
      <Button id={`${id}-settings`} size="sm" disabled={busy} aria-describedby={`${id}-refused`}
        onClick={() => press(`${name}:settings`, `${id}-settings`)}>
        {model.text("Open Settings")}
      </Button>
    </div>
  ) : undefined;
  return (
    <Step id={id} icon={name === "microphone" ? <Mic /> : <Camera />} title={label} badge={model.text("Optional")} notice={notice}
      about={name === "microphone" ? "Mixes your voice with the system's sound in the recording." : "Shows you in a bubble over the recording."}>
      {refused ? null : (<>
        {on && <Allowed />}
        <Switch id={`${id}-switch`} aria-labelledby={`${id}-title`} aria-describedby={`${id}-detail`} checked={on}
          disabled={disabled} onCheckedChange={toggle} />
      </>)}
    </Step>
  );
}

export function OnboardingDialog() {
  useSyncExternalStore(model.subscribe, model.snapshot);
  const guide = model.view?.onboarding;
  const language = model.view?.language;
  // One press at a time: a switch turned on waits on macOS's prompt, and nothing else should start under it.
  const busy = model.savingOf(GROUP) !== undefined;
  const ready = guide?.screen === "granted";
  const failure = model.failureOf(GROUP)?.text;
  return (
    <Dialog open={guide !== undefined} onOpenChange={(open) => { if (!open && !busy) press("finish", "onboarding-later"); }}>
      {guide && (
        <DialogContent id="onboarding" className="onboarding max-h-[calc(100dvh-32px)] overflow-y-auto sm:max-w-115" showCloseButton={false}
          finalFocus={false}>
          <DialogHeader>
            <DialogTitle id="onboarding-title">{model.text("Welcome to RecordStuff")}</DialogTitle>
            <DialogDescription>{model.text("Allow these to start recording.")}</DialogDescription>
          </DialogHeader>
          <ol className="grid m-0 p-0 list-none">
            <Step id="onboarding-screen" icon={<MonitorUp />} title={model.text("Screen recording")} badge={model.text("Required")}
              about="Lets RecordStuff record your screen and its sound. Turn RecordStuff on in System Settings; macOS may then ask you to quit and reopen it.">
              {guide.screen === "granted" ? <Allowed />
                : guide.screen === "relaunch" ? (
                  <Button id="onboarding-screen-relaunch" size="sm" disabled={busy} onClick={() => press("screen:relaunch", "onboarding-screen-relaunch")}>
                    {model.text("Relaunch")}
                  </Button>
                ) : (
                  <Button id="onboarding-screen-open" size="sm" disabled={busy} onClick={() => press("screen:open", "onboarding-screen-open")}>
                    {model.text("Open Settings")}
                  </Button>
                )}
            </Step>
            <InputStep name="microphone" input={guide.microphone} busy={busy} waiting={!ready} />
            {guide.camera && <InputStep name="camera" input={guide.camera} busy={busy} waiting={!ready} />}
          </ol>
          {/* A press that did not apply, said in the dialog, which hides the page under it (review pass 2). */}
          {failure && <p id="onboarding-failure" className="m-0 text-2xs text-destructive-ink" role="alert">{failure}</p>}
          <DialogFooter className="onboarding-footer">
            <span className="onboarding-start">
              {!ready ? ""
                : guide.shortcut ? translate("Press {keys} to start recording.", language, { keys: guide.shortcut })
                : model.text("Start recording from the menu bar icon.")}
            </span>
            {ready ? (<>
              <Button id="onboarding-studio" variant="outline" disabled={busy} onClick={() => press("studio", "onboarding-studio")}>
                {model.text("Open Recording Studio")}
              </Button>
              <Button id="onboarding-done" disabled={busy} onClick={() => press("finish", "onboarding-done")}>{model.text("Done")}</Button>
            </>) : (
              <Button id="onboarding-later" variant="outline" disabled={busy} onClick={() => press("finish", "onboarding-later")}>
                {model.text("Set up later")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
