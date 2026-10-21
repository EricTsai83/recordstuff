/**
 * The Recording Studio's rows (plan 075, D19, D20): what is watched and changed around a recording, and its Start,
 * Cancel or Stop.
 */
import { failureReason } from "../../recording/recording-result";
import { translate as t, type PlainMessageKey } from "../../../shared/i18n";
import type { RecordingState } from "../../../shared/state";
import type { AppAction, AppContext } from "../../app/ui-model";
import { studioAudioGroups } from "./audio";
import { cameraPreviewGroup, cameraShapeGroups } from "./camera";
import { type Group, group, switchChoices } from "./group";

/**
 * The Recording Studio (plan 075, D19): the preview, the camera's switch, its showing in the recording in progress
 * (D13), its shape, and Start, Cancel or Stop with the elapsed time, each a row of its own sections.
 */
export function studioGroups(state: RecordingState, ctx: AppContext, unlocked: boolean): Group[] {
  const camera = ctx.camera;
  const language = ctx.language;
  const camerasRows: Group[] = [];
  if (camera?.available) {
    const preview = cameraPreviewGroup(ctx, unlocked);
    if (preview) camerasRows.push(preview);
    camerasRows.push({ ...group("studioCamera", t("Camera", language), unlocked,
      switchChoices(language, camera.enabled, (value) => ({ setCamera: value }))),
    ...(unlocked ? {} : { note: t("Turned on or off between recordings.", language) }) });
    if (camera.session) {
      camerasRows.push(group("cameraShown", t("Show camera in recording", language), true,
        switchChoices(language, !camera.session.hidden, (value) => ({ setCameraHidden: !value }))));
    }
    camerasRows.push(...cameraShapeGroups(ctx, unlocked));
  }
  const live = studioLiveGroup(state, ctx);
  return [...camerasRows, ...(live ? [live] : []), ...studioAudioGroups(ctx), studioControlsGroup(state, ctx)];
}


/**
 * Live preview (D20) as a switch of the preview's own, apart from the recording's controls (2026-10-21): between
 * recordings it holds the recording's session to show the picture it will hold, and during one it shows or hides
 * the recording's picture, which costs nothing to the file. None where the engine makes no preview.
 */
function studioLiveGroup(state: RecordingState, ctx: AppContext): Group | undefined {
  if (!ctx.camera?.available) return undefined;
  const language = ctx.language;
  const preview = ctx.studio?.preview;
  const between = state.type === "idle" || state.type === "needsPermission";
  // During a recording the switch follows its picture; Saving… ends the session, so there is nothing left to show.
  const on = between ? preview !== undefined : ctx.studio?.pictureHidden !== true;
  const enabled = between ? state.type === "idle" && !ctx.mediaComponentsMissing : state.type !== "stopping";
  const choices = [true, false].map((value) => ({ id: value ? "on" : "off", label: t(value ? "On" : "Off", language), enabled: true,
    checked: value === on, action: (between ? (value ? "startPreview" : "stopPreview") : (value ? "showStudioPicture" : "hideStudioPicture")) as AppAction }));
  const failure = ctx.studio?.previewFailure;
  return { ...group("studioLive", t("Live preview", language), enabled, choices), control: "switch",
    ...(between && preview && !preview.live ? { note: t("Starting preview…", language), noteKind: "status" as const }
      : failure && state.type === "idle" && !preview
        ? { note: t("Live preview could not start: {reason}", language, { reason: failureReason(failure, language) }), noteKind: "status" as const } : {}) };
}

/** Start, Cancel or Stop, as the tray offers it now, with the recording's phase and elapsed time (D19). */
function studioControlsGroup(state: RecordingState, ctx: AppContext): Group {
  const language = ctx.language;
  const choice = (id: string, label: PlainMessageKey, action: AppAction, enabled = true): Group["choices"][number] =>
    ({ id, label: t(label, language), enabled, checked: false, action });
  // Start as the tray offers it: without screen recording's permission it waits, the status card above every tab
  // offering the fix (opening the pane, or relaunching once it is allowed), which is not repeated here.
  const choices = state.type === "idle" || state.type === "needsPermission"
    ? [choice("start", "Start recording", "start", state.type === "idle" && !ctx.mediaComponentsMissing)]
    : state.type === "starting" || state.type === "countdown" ? [choice("cancel", "Cancel recording", "cancelCountdown")]
    : state.type === "recording" ? [choice("stop", "Stop recording", "stop")]
    : [choice("saving", "Saving…", "stop", false)];
  // The row says where the recording is; its section heading names the controls.
  const label = state.type === "recording" ? t("Recording", language)
    : state.type === "countdown" ? t("Recording starts in {seconds} s", language, { seconds: state.remaining })
    : state.type === "starting" ? t("Starting…", language) : state.type === "stopping" ? t("Saving…", language)
    : state.type === "needsPermission" ? t("Screen recording permission required", language)
    : t("Ready", language);
  const phase = state.type === "needsPermission" ? "blocked" : state.type === "stopping" ? "saving" : state.type;
  return { ...group("studioControls", label, true, choices), kind: "actions", phase,
    ...(state.type === "recording" ? { elapsedSince: state.startedAt } : {}) };
}
