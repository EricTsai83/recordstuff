/**
 * What is wrong with each input, said once and in the same words wherever it is shown (plan 097, D2): the Studio's
 * pickers, the Recording tab's device rows, the tray and the countdown. Quiet when fine: an input without a problem has
 * none here, and its picker shows the device's name alone.
 */
import { displayLabel } from "../../../shared/display";
import { translate as t } from "../../../shared/i18n";
import type { RecordingState } from "../../../shared/state";
import type { AppContext } from "../../app/ui-model";
import { chosenDisplayUnavailable } from "./recording";

export interface InputProblem {
  text: string;
  /** Known only while a session runs (the camera's state): the countdown never names it, the tray during a recording (D5). */
  session?: true;
  /** The camera is starting: said by its picker, but not a problem to warn of anywhere else. */
  waiting?: true;
}

export interface InputProblems {
  screen?: InputProblem;
  camera?: InputProblem;
  microphone?: InputProblem;
}

const refused = (access: string | undefined): boolean => access === "denied" || access === "restricted";

/** Each input's problem now, if any; an input switched off has none. */
export function inputProblems(state: RecordingState, ctx: AppContext): InputProblems {
  const language = ctx.language;
  const result: InputProblems = {};
  if (state.type === "needsPermission") result.screen = { text: t("No screen recording permission", language) };
  else if (ctx.display.kind === "display" && chosenDisplayUnavailable(ctx)) {
    result.screen = { text: t("{label} is unavailable", language, { label: displayLabel(ctx.display, language) }) };
  }
  const camera = ctx.camera;
  if (camera?.available && camera.enabled) {
    const stored = camera.device;
    const missing = stored !== undefined && camera.devices !== undefined && !camera.devices.some((device) => device.id === stored.id);
    const state = camera.session?.state;
    if (ctx.platform === "darwin" && refused(camera.access)) result.camera = { text: t("No camera access", language) };
    else if (ctx.platform === "darwin" && camera.access === "not-determined" && !camera.session) result.camera = { text: t("Camera access not allowed yet", language) };
    else if (state === "lost") result.camera = { text: t("The camera dropped out", language), session: true };
    else if (state === "notReady") result.camera = { text: t("The camera is not ready", language), session: true };
    else if (missing) result.camera = { text: t("{label} not found", language, { label: stored.label }) };
    else if (state === "waiting") result.camera = { text: t("Waiting for the camera…", language), session: true, waiting: true };
  }
  const microphone = ctx.microphone;
  if (microphone?.enabled) {
    const stored = microphone.device;
    const devices = microphone.devices;
    const missing = stored !== undefined && devices !== undefined && !devices.some((device) => device.id === stored.id);
    // The device the next recording opens (or this one records, when it is the one chosen): its lid, when closed.
    const used = stored === undefined || missing ? devices?.find((device) => device.default) : devices?.find((device) => device.id === stored.id);
    if (ctx.platform === "darwin" && refused(microphone.access)) result.microphone = { text: t("No microphone access", language) };
    else if (missing) result.microphone = { text: t("{label} not found", language, { label: stored.label }) };
    else if (used?.lidClosed && !ctx.audioSession?.microphone) result.microphone = { text: t("{label} — Lid closed", language, { label: used.name }) };
  }
  return result;
}

/** The problems a recording about to start would have, which the countdown names (plan 097): none a session must tell. */
export function startProblems(state: RecordingState, ctx: AppContext): string[] {
  const problems = inputProblems(state, ctx);
  return [problems.screen, problems.camera, problems.microphone].filter((problem): problem is InputProblem => problem !== undefined && !problem.session)
    .map((problem) => problem.text);
}

/** The name an input's picker and the tray show while it is fine: the device's, or the system default's. */
export function inputNames(ctx: AppContext): { screen: string; camera: string; microphone: string } {
  const language = ctx.language;
  const primary = ctx.displays.find((display) => display.primary);
  const screen = ctx.display.kind === "display" ? displayLabel(ctx.display, language)
    // Its own name, without the Primary suffix a menu adds to tell displays apart.
    : primary ? displayLabel({ id: primary.id, label: primary.label }, language) : t("Primary display", language);
  const device = (stored: { label: string } | undefined, devices: readonly { name: string; default: boolean }[] | undefined): string =>
    stored?.label ?? devices?.find((each) => each.default)?.name ?? t("System default", language);
  return { screen, camera: device(ctx.camera?.device, ctx.camera?.devices), microphone: device(ctx.microphone?.device, ctx.microphone?.devices) };
}
