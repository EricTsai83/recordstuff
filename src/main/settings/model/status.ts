/**
 * The status card at the head of Settings: what needs attention now and the action that resolves it.
 */
import { displayResolution, primaryDisplayChoosable } from "../../display/display-source";
import { translate as t, type PlainMessageKey } from "../../../shared/i18n";
import type { SettingsStatus, StatusActionId } from "../../../shared/settings-panel";
import type { RecordingState } from "../../../shared/state";
import { QUITTING_TEXT, type AppAction, type AppContext } from "../../app/ui-model";
import { chosenDisplayUnavailable } from "./recording";

/**
 * The status card above the tabs: the same states the tray shows, said as
 * what the user can do now. A settled app explains how to start; a busy one
 * leaves the explanation to the lock `hint`.
 */
export function settingsStatus(state: RecordingState, ctx: AppContext): SettingsStatus {
  const text = statusText(state, ctx);
  const status = { ...text, phase: ctx.quitting ? "quitting" as const : text.phase ?? state.type };
  if (ctx.quitting) return status;
  const id = statusActionId(state, ctx);
  // Keep an optional recovery action for access that may already have been granted.
  const relaunch = state.type === "needsPermission" && !state.needsRelaunch;
  return {
    ...status,
    ...(id ? { action: { id, label: t(STATUS_ACTION_LABELS[id], ctx.language) } } : {}),
    ...(relaunch ? { secondaryAction: { id: "relaunch" as const, label: t("Already allowed? Relaunch", ctx.language) } } : {}),
  };
}

/**
 * The card's button, in the tray's words, and the tray action it runs: only a fix for what blocks the next
 * recording. Start, Stop and Cancel stay with the menu bar icon, its menu and the shortcut, where recording begins.
 */
const STATUS_ACTION_LABELS: Record<StatusActionId, PlainMessageKey> = {
  permission: "Open Settings", relaunch: "Relaunch", folder: "Change output folder…", primary: "Use Primary display",
  mediaComponents: "Open Optional features",
};
export const STATUS_ACTIONS: Record<StatusActionId, AppAction> = {
  permission: "openPermissionSettings", relaunch: "relaunch", folder: "changeOutputDir", primary: { setDisplay: { kind: "primary" } },
  mediaComponents: "openOptionalFeatures",
};
function statusActionId(state: RecordingState, ctx: AppContext): StatusActionId | undefined {
  switch (state.type) {
    case "needsPermission": return state.needsRelaunch ? "relaunch" : "permission";
    case "idle":
      if (ctx.mediaComponentsMissing) return "mediaComponents";
      if (state.outputDirUnavailable) return "folder";
      // The Screen row's own way back (its `recovery`), when there is one.
      return chosenDisplayUnavailable(ctx) && primaryDisplayChoosable(ctx.displays) ? "primary" : undefined;
    default: return undefined;
  }
}

function statusText(state: RecordingState, ctx: AppContext): SettingsStatus {
  const language = ctx.language;
  if (ctx.quitting) return { tone: "busy", title: t(QUITTING_TEXT[ctx.quitStep ?? "media"], language), detail: "" };
  switch (state.type) {
    case "needsPermission":
      return { tone: "attention", title: t("Screen recording access", language),
        detail: t(state.needsRelaunch
          ? "Relaunch RecordStuff after allowing access in System Settings."
          : "Allow screen recording in System Settings.", language) };
    case "starting": return { tone: "busy", title: t("Starting… Check for system permission prompts", language), detail: "" };
    case "countdown": return { tone: "busy", title: t("Recording starts in {seconds} s", language, { seconds: state.remaining }), detail: "" };
    case "recording": return { tone: "recording", title: t("Recording", language), detail: "" };
    case "stopping": return { tone: "busy", title: t("Saving…", language), detail: "" };
    case "idle": break;
  }
  // Before anything else: no other fix lets a recording start (plan 078).
  if (ctx.mediaComponentsMissing) return { tone: "attention", title: t("Windows's media components are missing, so recording cannot start.", language),
    detail: t("Install the Media Feature Pack from Optional features in Windows Settings, then restart Windows and record again.", language) };
  if (state.outputDirUnavailable) return { tone: "attention", title: t("Output folder unavailable", language),
    detail: t("Check the output folder, its permissions and the connected drive before recording again.", language) };
  const resolution = displayResolution(ctx.displays, ctx.display);
  // The Screen row below says why and offers the way back; the card only names the problem.
  if (!resolution.ok) return { tone: "attention", title: t("Selected display is unavailable", language), detail: "" };
  // A save in the background (2026-10-09) locks nothing, so the card names it with no lock hint below.
  const saving = ctx.saving?.[0];
  if (saving) return { tone: "busy", phase: "saving", detail: "",
    title: t(saving.slow ? "Still saving {file}. The drive may not be responding." : "Saving {file}…", language, { file: saving.file }) };
  // Nothing to say while ready: the page shows no card then, and the menu bar icon is where recording starts.
  return { tone: "ready", title: t("Ready to record", language), detail: "" };
}
