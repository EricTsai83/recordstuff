/**
 * The first-launch guide (2026-10-26, the maintainer's request): over the main window on a new install, what a
 * recording needs, one line to a step, each with its name and the one press that moves it on, what it is for behind its
 * ⓘ (the maintainer's choice of a sparse layout, the same day). macOS's own prompts come only from those presses, and
 * the microphone's and the camera's only once the screen is allowed, so the steps are taken in order. Main says what
 * each step stands at (`view.onboarding`) and owns every press (the `onboarding` group's choices); the page words them.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { Camera, CircleCheck, CircleHelp, Mic, MonitorUp } from "lucide-react";
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

/** One step: its icon, name, badge and ⓘ, then where it stands with its press at the line's end. */
function Step({ id, icon, title, badge, about, children }: {
  id: string; icon: ReactNode; title: string; badge: string; about: PlainMessageKey; children: ReactNode;
}) {
  const detail = model.text(about);
  return (
    <li className="onboarding-step">
      <span className="onboarding-step-icon" aria-hidden="true">{icon}</span>
      <span className="onboarding-step-head">
        <span id={`${id}-title`} className="onboarding-step-title">{title}</span>
        <span className="onboarding-badge">{badge}</span>
        <ControlTooltip label={detail}>
          <Button variant="ghost" size="icon-sm" className="onboarding-about" id={`${id}-about`}
            aria-label={translate("More about {label}", model.view?.language, { label: title })} aria-describedby={`${id}-detail`}>
            <CircleHelp aria-hidden="true" />
          </Button>
        </ControlTooltip>
        <span id={`${id}-detail`} className="sr-only">{detail}</span>
      </span>
      <span className="onboarding-step-end">{children}</span>
    </li>
  );
}

/** The microphone's or the camera's line: Allow, Allowed or the way to System Settings, and its switch. */
function InputStep({ name, input, busy, waiting }: { name: "microphone" | "camera"; input: OnboardingInputView; busy: boolean; waiting: boolean }) {
  const id = `onboarding-${name}`;
  const label = model.text(name === "microphone" ? "Microphone" : "Camera");
  // The screen first (native round, 2026-10-26): the inputs wait for it, so the first press is plain.
  const disabled = busy || input.locked || waiting;
  return (
    <Step id={id} icon={name === "microphone" ? <Mic /> : <Camera />} title={label} badge={model.text("Optional")}
      about={name === "microphone" ? "Mixes your voice with the system's sound in the recording." : "Shows you in a bubble over the recording."}>
      {input.access === "denied" ? (<>
        <span className="onboarding-note">{model.text("Not allowed")}</span>
        <Button id={`${id}-settings`} variant="outline" size="sm" disabled={busy} onClick={() => press(`${name}:settings`, `${id}-settings`)}>
          {model.text("Open Settings")}
        </Button>
      </>)
        : !input.enabled ? null
        : input.access === "granted" ? <Allowed />
        : (
          <Button id={`${id}-allow`} size="sm" disabled={disabled} onClick={() => press(`${name}:allow`, `${id}-allow`)}>
            {model.text("Allow")}
          </Button>
        )}
      <Switch id={`${id}-switch`} aria-labelledby={`${id}-title`} aria-describedby={`${id}-detail`} checked={input.enabled}
        disabled={disabled} onCheckedChange={(checked) => press(`${name}:${checked ? "on" : "off"}`, `${id}-switch`)} />
    </Step>
  );
}

export function OnboardingDialog() {
  useSyncExternalStore(model.subscribe, model.snapshot);
  const guide = model.view?.onboarding;
  const language = model.view?.language;
  // One press at a time: Allow waits on macOS's prompt, and nothing else should start under it.
  const busy = model.savingOf(GROUP) !== undefined;
  const ready = guide?.screen === "granted";
  const failure = model.failureOf(GROUP)?.text;
  // An optional input still to allow goes off as the guide closes: said once, beside the way out, only while one is.
  const unasked = guide ? [guide.microphone, guide.camera].some(input => input?.enabled && input.access === "ask") : false;
  return (
    <Dialog open={guide !== undefined} onOpenChange={(open) => { if (!open && !busy) press("finish", "onboarding-later"); }}>
      {guide && (
        <DialogContent id="onboarding" className="onboarding max-h-[calc(100dvh-32px)] overflow-y-auto sm:max-w-[460px]" showCloseButton={false}
          finalFocus={false}>
          <DialogHeader>
            <DialogTitle id="onboarding-title">{model.text("Welcome to RecordStuff")}</DialogTitle>
            <DialogDescription>{model.text("Allow these to start recording.")}</DialogDescription>
          </DialogHeader>
          <ol className="onboarding-steps">
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
          {failure && <p id="onboarding-failure" className="onboarding-failure" role="alert">{failure}</p>}
          <DialogFooter className="onboarding-footer">
            <span className="onboarding-start">
              {!ready ? "" : unasked ? model.text("Not allowed ones turn off when you finish.")
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
