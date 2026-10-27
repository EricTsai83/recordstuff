/**
 * The Recording Studio's rows (plan 075, D19, D20; laid out again by plan 097, D1): over the preview what is recorded
 * (the record control, the recording type and the screen, camera and microphone pickers), the preview with its view,
 * Live preview and rate, and under it what is watched and changed while recording, which follows the recording's type.
 */
import { failureReason } from "../../recording/recording-result";
import { translate as t, type PlainMessageKey } from "../../../shared/i18n";
import type { RecordingState } from "../../../shared/state";
import type { AppAction, AppContext } from "../../app/ui-model";
import { microphoneDeviceGroup, microphoneGroup, studioAudioGroups } from "./audio";
import { cameraGroups, cameraPreviewGroup, cameraShapeGroups } from "./camera";
import { type Group, group, switchChoices } from "./group";
import { inputNames, inputProblems, type InputProblem, type InputProblems } from "./inputs";
import { hideSystemUiGroup, screenGroup } from "./recording";
import { DEFAULT_STUDIO_PREVIEW, STUDIO_PREVIEW_RATES, STUDIO_VIEWS, type StudioPreviewRate, type StudioView } from "../../../shared/studio-port";

const VIEW_LABELS: Record<StudioView, [PlainMessageKey, PlainMessageKey]> = {
  composed: ["As recorded", "The screen and the camera, as the recording has them."],
  camera: ["Check camera", "The camera enlarged, to check framing, light and focus."],
};

const RATE_LABELS: Record<StudioPreviewRate, [PlainMessageKey, PlainMessageKey]> = {
  power: ["Power saving", "5 fps while you only watch, 10 fps while you work in the Studio."],
  standard: ["Standard", "10 fps all the time."],
  smooth: ["Smooth", "15 fps all the time; uses the most power."],
};

/**
 * The preview's rate and view (plan 092, D1, D3): one persisted choice each, changed at any time, the same for a Live
 * preview and a recording; the page paces the preview and tells the capture process both (studio-pace.ts, studio-feed.ts).
 */
function studioPreviewGroups(ctx: AppContext): Group[] {
  const language = ctx.language;
  const chosen = ctx.studioPreview ?? DEFAULT_STUDIO_PREVIEW;
  const rate = group("studioPreviewRate", t("Preview rate", language), true, STUDIO_PREVIEW_RATES.map((id) => ({
    id, label: t(RATE_LABELS[id][0], language), description: t(RATE_LABELS[id][1], language), enabled: true, checked: id === chosen.rate,
    action: { setStudioPreview: { rate: id } } as AppAction })));
  const view = group("studioPreviewView", t("Preview view", language), true, STUDIO_VIEWS.map((id) => ({
    id, label: t(VIEW_LABELS[id][0], language), description: t(VIEW_LABELS[id][1], language), enabled: true, checked: id === chosen.view,
    action: { setStudioPreview: { view: id } } as AppAction })));
  return [rate, view];
}

/**
 * The Recording Studio (plan 097): the record control, the recording type and the three pickers over the preview;
 * the preview with its view, Live preview and rate; under it the live controls of the recording's type.
 */
export function studioGroups(state: RecordingState, ctx: AppContext, unlocked: boolean): Group[] {
  const problems = inputProblems(state, ctx);
  const preview = ctx.camera?.available ? cameraPreviewGroup(ctx) : undefined;
  const live = studioLiveGroup(state, ctx);
  return [
    studioControlsGroup(state, ctx),
    studioTypeGroup(ctx, unlocked),
    ...studioScreenGroups(ctx, unlocked, problems),
    ...studioCameraGroups(ctx, unlocked, problems),
    ...studioMicrophoneGroups(ctx, unlocked, problems),
    ...(preview ? [preview, ...studioPreviewGroups(ctx)] : []),
    ...(live ? [live] : []),
    ...studioLiveGroups(state, ctx),
  ];
}

/** The type of the recording the live controls follow (D6): the session's, else the next recording's. */
export function liveRecordingType(ctx: AppContext): "plain" | "editable" {
  return (ctx.editableSession ?? ctx.editableNext ?? false) ? "editable" : "plain";
}

/**
 * The recording type (D6): the same Editable recordings setting as Recording settings' switch, locked while recording,
 * where it shows the recording's own type (the tray's Start editable recording makes one editable while the setting
 * stays off). Where the engine records no editable file (Windows), Editable recording is listed but unavailable, with why.
 */
function studioTypeGroup(ctx: AppContext, unlocked: boolean): Group {
  const language = ctx.language;
  const darwin = ctx.platform === "darwin";
  const editable = !unlocked && ctx.editableSession !== undefined ? ctx.editableSession : darwin && (ctx.editableRecording ?? false);
  const type = liveRecordingType(ctx);
  return { ...group("studioType", t("Recording type", language), unlocked, [
    { id: "plain", label: t("Plain recording", language), description: t("Ready to share as soon as it stops.", language),
      enabled: true, checked: !editable, action: { setEditableRecording: false } },
    { id: "editable", label: t("Editable recording", language),
      description: darwin ? t("Move the camera and set the volumes afterwards in Edit…. Export it before sharing; files are about twice as large.", language)
        : t("Editable recordings are available on macOS only.", language),
      enabled: darwin, checked: editable, action: { setEditableRecording: true } },
  ]), recordingType: type };
}

const pickerProblem = (problem: InputProblem | undefined): { problem?: string; waiting?: boolean } =>
  problem ? { problem: problem.text, ...(problem.waiting ? { waiting: true } : {}) } : {};

/** The screen's picker: the displays, as Recording settings lists them, and Hide menu bar and Dock (or the taskbar's). */
function studioScreenGroups(ctx: AppContext, unlocked: boolean, problems: InputProblems): Group[] {
  const screen = screenGroup(ctx, unlocked);
  const hide = hideSystemUiGroup(ctx, unlocked);
  return [
    { ...group("studioScreen", screen.label, unlocked, screen.choices),
      picker: { input: "screen", name: inputNames(ctx).screen, ...pickerProblem(problems.screen), locked: !unlocked, parts: ["studioHideSystemUi"] },
      ...(screen.recovery ? { recovery: screen.recovery } : {}) },
    { ...hide, ...group("studioHideSystemUi", hide.label, hide.enabled, hide.choices), control: "switch",
      ...(hide.note ? { note: hide.note } : {}), ...(hide.info ? { info: hide.info } : {}) },
  ];
}

/**
 * The camera's picker (where the camera is available): its switch at the top of its menu, the devices, then the
 * bubble's shape and mirror, all chosen before recording and locked with the picker; the bubble's place is dragged in
 * the preview at any time.
 */
function studioCameraGroups(ctx: AppContext, unlocked: boolean, problems: InputProblems): Group[] {
  const camera = ctx.camera;
  if (!camera?.available) return [];
  const language = ctx.language;
  const device = cameraGroups(ctx, unlocked)[0]!;
  const on = { ...group("studioCamera", t("Camera", language), unlocked, switchChoices(language, camera.enabled, (value) => ({ setCamera: value }))) };
  return [
    { ...group("studioCameraDevice", t("Camera", language), unlocked && camera.enabled, device.choices),
      picker: { input: "camera", name: inputNames(ctx).camera, off: !camera.enabled, ...pickerProblem(problems.camera), locked: !unlocked,
        parts: ["studioCamera", "cameraWidth", "cameraHeight", "cameraRounding", "cameraMirror"] } },
    on,
    ...cameraShapeGroups(ctx, unlocked),
  ];
}

/**
 * The microphone's picker: its switch, then the inputs, the system default and a chosen input that is not connected
 * included (plan 074). The switch is locked while recording; the input stays switchable (plan 079, D3).
 */
function studioMicrophoneGroups(ctx: AppContext, unlocked: boolean, problems: InputProblems): Group[] {
  const language = ctx.language;
  const device = microphoneDeviceGroup(ctx, unlocked);
  const on = microphoneGroup(ctx, unlocked);
  return [
    { ...group("studioMicrophoneDevice", t("Microphone", language), device.enabled, device.choices),
      ...(device.actions ? { actions: device.actions } : {}),
      picker: { input: "microphone", name: inputNames(ctx).microphone, off: !(ctx.microphone?.enabled ?? false), ...pickerProblem(problems.microphone),
        parts: ["studioMicrophone"] } },
    { ...group("studioMicrophone", t("Microphone", language), on.enabled, on.choices), control: "switch" },
  ];
}

/**
 * Under the preview (D6): a plain recording's camera Show / Hide, and each input's Don't record, meter and fader; an
 * editable recording's meters alone, since it records every input as it comes and Edit… sets them afterwards.
 */
function studioLiveGroups(state: RecordingState, ctx: AppContext): Group[] {
  const type = liveRecordingType(ctx);
  const rows = studioAudioGroups(ctx, type);
  if (type === "editable" || !ctx.camera?.available) return rows;
  return [cameraShownGroup(state, ctx), ...rows];
}

/**
 * Show or hide the camera in the recording in progress (plan 075, D13), a plain recording's only: unavailable before
 * a recording, which records nothing yet, and during one without the camera, which it joins from the next recording.
 */
function cameraShownGroup(state: RecordingState, ctx: AppContext): Group {
  const language = ctx.language;
  const camera = ctx.camera!;
  const recording = state.type === "countdown" || state.type === "recording";
  const session = recording ? camera.session : undefined;
  const result = group("cameraShown", t("Camera", language), session !== undefined,
    switchChoices(language, session ? !session.hidden : camera.enabled, (value) => ({ setCameraHidden: !value })));
  if (!session) {
    result.note = !recording ? t("Shown or hidden while recording.", language)
      : camera.enabled ? t("The camera joins from the next recording.", language) : t("This recording has no camera.", language);
    result.noteKind = "status";
  }
  return { ...result, control: "switch" };
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
