/**
 * The first-launch guide (2026-10-26, the maintainer's request): on a new install, the main window opens over a guide
 * through what a recording needs, so that no system prompt comes before the user knows what it is for and presses for
 * it. Screen & System Audio Recording first (required: System Settings, then a relaunch macOS may ask for), then the
 * microphone and the camera (optional, on by default: Allow asks macOS, Off means it is never asked), then where
 * recording begins. Finished or set aside it does not open again by itself; General opens it.
 */
import type { AppAction, AppContext } from "../../app/ui-model";
import { describeAccelerator } from "../../../shared/hotkey";
import { translate as t } from "../../../shared/i18n";
import type { OnboardingInputView, OnboardingView } from "../../../shared/settings-panel";
import type { RecordingState } from "../../../shared/state";
import { preferencesUnlocked } from "../../recording/recording-lock";
import { group, type Group } from "./group";

type InputContext = { enabled: boolean; access?: string | undefined } | undefined;

function inputView(input: InputContext, locked: boolean): OnboardingInputView {
  const access = input?.access === "granted" || input?.access === undefined ? "granted"
    : input.access === "denied" || input.access === "restricted" ? "denied" : "ask";
  return { enabled: input?.enabled ?? false, access, locked };
}

/** What the guide shows, while it is open on macOS; nothing otherwise. */
export function onboardingView(state: RecordingState, ctx: AppContext): OnboardingView | undefined {
  if (!ctx.onboarding?.open || ctx.platform !== "darwin") return undefined;
  const locked = !preferencesUnlocked(state);
  const shortcut = ctx.hotkey.enabled && ctx.hotkey.registered ? describeAccelerator(ctx.hotkey.accelerator, ctx.platform) : undefined;
  return {
    screen: state.type !== "needsPermission" ? "granted" : state.needsRelaunch ? "relaunch" : "needed",
    microphone: inputView(ctx.microphone, locked),
    ...(ctx.camera?.available ? { camera: inputView(ctx.camera, locked) } : {}),
    ...(shortcut ? { shortcut } : {}),
  };
}

/** The guide's presses that apply now, by choice id. */
function onboardingActions(state: RecordingState, ctx: AppContext): Map<string, AppAction> {
  const view = onboardingView(state, ctx);
  const actions = new Map<string, AppAction>();
  if (!view) return actions;
  if (view.screen !== "granted") {
    actions.set("screen:open", "openPermissionSettings");
    // Allowed already but not seen until RecordStuff starts again, as macOS's own Quit & Reopen does.
    actions.set("screen:relaunch", "relaunch");
  }
  const inputs = [["microphone", view.microphone], ["camera", view.camera]] as const;
  for (const [name, input] of inputs) {
    if (!input) continue;
    // Saved only: the guide asks macOS at Allow alone, so turning a switch back on asks nothing (review F2).
    const set = (value: boolean): AppAction => ({ setOnboardingInput: { input: name, enabled: value } });
    // The screen first (native round, 2026-10-26): the inputs wait for its grant, so the guide is taken in order.
    if (!input.locked && view.screen === "granted") {
      actions.set(`${name}:on`, set(true));
      actions.set(`${name}:off`, set(false));
      if (input.enabled && input.access === "ask") actions.set(`${name}:allow`, name === "microphone" ? "askMicrophone" : "askCamera");
    }
    if (input.access === "denied") actions.set(`${name}:settings`, name === "microphone" ? "openMicrophoneSettings" : "openCameraSettings");
  }
  actions.set("finish", { finishOnboarding: {} });
  actions.set("studio", { finishOnboarding: { then: "studio" } });
  return actions;
}

export function onboardingAction(state: RecordingState, ctx: AppContext, choiceId: unknown): AppAction | undefined {
  return typeof choiceId === "string" ? onboardingActions(state, ctx).get(choiceId) : undefined;
}

/** A switch's press took effect when the switch reads it; every other press is a request the guide then shows. */
export function onboardingChecked(ctx: AppContext, choiceId: unknown): boolean {
  const match = typeof choiceId === "string" ? /^(microphone|camera):(on|off)$/.exec(choiceId) : null;
  if (!match) return true;
  const enabled = match[1] === "microphone" ? ctx.microphone?.enabled : ctx.camera?.enabled;
  return (enabled ?? false) === (match[2] === "on");
}

/** General's way back to the guide, on macOS. */
export function onboardingGuideGroup(ctx: AppContext): Group[] {
  if (ctx.platform !== "darwin") return [];
  return [{ ...group("setupGuide", t("Setup guide", ctx.language), true, [
    { id: "open", label: t("Open setup guide…", ctx.language), enabled: true, checked: false, action: "showOnboarding" },
  ], t("Screen recording, the microphone and the camera, step by step.", ctx.language)), kind: "actions" }];
}
