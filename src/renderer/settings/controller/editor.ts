/**
 * The edit view (plan 085): which recording is being cut, the timeline's parts, the selection and Undo. Main owns the
 * edit (the removed ranges it saved, snapped to frames by the engine) and the export; the page keeps only what has
 * not been saved: where the timeline was split without removing anything, the selected part, and the edits each
 * change replaced, for Undo. Every change is saved at once, as one choice on `recordingEdit:<id>`.
 *
 * An editable recording (plan 087) also has a scene: the camera's place, size and visibility, and each input's
 * volume. While the bubble is dragged or a slider moves, the page shows a draft of it; letting go saves it, one change
 * for Undo. Since 2026-10-26 the camera can be hidden or shown again over any stretch: the selected range or part, with
 * the toolbar's camera button or C, each a change Undo takes back. Its preview plays the recording (the screen with its first sound) with the camera's and the second sound's
 * own tracks beside it, kept to the recording's time, and each sound through a gain at its volume.
 */
import type { LibraryItemView } from "../../../shared/settings-panel";
import { normalizeRanges, type EditorChoice, type EditorView, type EditRange } from "../../../shared/editing";
import {
  cameraHidden, cameraStretches as storedStretches, MAX_CAMERA_HIDDEN, mergeRanges, setVolumeOver, subtractRange, volumeAt, volumeStretchesOf,
  withCameraHidden, withVolumeStretches, type EditableSound, type EditScene, type VolumeInput,
} from "../../../shared/editable";
import { softLimit } from "../../../shared/audio-volume";
import { translate } from "../../../shared/i18n";
import { announce, draw, focus, render, subscribe, view } from "./core";
import { forgetMenu } from "./library";
import { openPlayer, playingItem } from "./player";

export let editingItem: LibraryItemView | undefined;
export let editorVideo: HTMLVideoElement | null = null;
/**
 * Why the preview stopped, said over it with Reload preview (2026-10-26: a media error left Play showing Pause over a
 * still picture, with nothing on screen to say so, and the view opened again on the same element kept it; Codex's
 * computer-use round). Empty while it plays.
 */
export let editorPreviewError = "";
/** Where the timeline was split without a removal on either side, in the video's timescale. */
let splits: number[] = [];
/** The selected part, by where it starts. */
export let selectedFrom: number | undefined;
/** A range dragged across the timeline (2026-10-25), in the video's timescale: Remove takes it out. */
export let rangeSelection: EditRange | undefined;
/**
 * Skimming (2026-10-25, the maintainer's choice, as Final Cut Pro's): while on, the preview shows the picture under the
 * pointer as it moves over the timeline, and goes back to the playhead when it leaves. Off by default again since
 * 2026-10-26, as Final Cut Pro's (the maintainer's choice); kept while the app runs.
 */
export let skimming = false;
/**
 * Enlarge preview (2026-10-27, the maintainer's request): the timeline and its toolbar step aside and the picture takes
 * the view, playing as edited, with the player's own controls; for the view only, never saved.
 */
export let enlarged = false;
/** Where the skimmer is, in the video's timescale, while the pointer skims. */
export let skimAt: number | undefined;
/** The playhead's time before the pointer began skimming, which it returns to; none once a press put it elsewhere. */
let skimFrom: number | undefined;
/**
 * An edit as Undo restores it: its cuts, an editable recording's scene, and the timeline's splits (2026-10-25: a
 * split is a step Undo takes back too, though it is the view's own and never saved).
 */
interface EditState { removed: EditRange[]; scene?: EditScene; splits: number[] }
/** The edits each saved change replaced, newest last. */
const undoStack: EditState[] = [];
/** The edits Undo took back, newest last, which Redo makes again; a new change clears it. */
const redoStack: EditState[] = [];
/** The scene shown while the bubble is dragged or a slider moves, until it is let go and saved. */
let sceneDraft: EditScene | undefined;
/**
 * A change being saved: further edits wait for its answer, which brings the revision they change. Nothing is drawn
 * unavailable meanwhile (2026-10-26, the maintainer's report: each save dimmed the trim handles, the parts and the
 * toolbar for the moment it took, a flicker at every step of a volume or an Undo); every change waits its turn instead.
 */
export let editorSaving = false;
let frameCallback: number | undefined;

/** One stretch of the timeline between two cuts or splits. */
export interface TimelinePart {
  from: number;
  to: number;
  removed: boolean;
}

/** The edit view main sent for the recording being edited, once it has. */
export function editorView(): EditorView | undefined {
  const editor = view?.editor;
  return editor && editingItem && editor.id === editingItem.id ? editor : undefined;
}

/** The timeline's parts: the removed ranges and the splits cut it; each part is kept or removed. */
export function timelineParts(editor: EditorView, extra: readonly number[] = splits): TimelinePart[] {
  const frame = editor.timescale / Math.max(1, editor.frameRate);
  const cuts = new Set<number>([0, editor.duration]);
  for (const [from, to] of editor.removed) {
    cuts.add(from);
    cuts.add(to);
  }
  // A split within a frame of a cut is that cut: no part a frame wide or less is drawn.
  for (const split of extra) {
    if (split > 0 && split < editor.duration && ![...cuts].some((cut) => Math.abs(cut - split) < frame)) cuts.add(split);
  }
  const sorted = [...cuts].filter((cut) => cut >= 0 && cut <= editor.duration).sort((a, b) => a - b);
  const parts: TimelinePart[] = [];
  for (let index = 0; index + 1 < sorted.length; index++) {
    const from = sorted[index]!, to = sorted[index + 1]!;
    if (to <= from) continue;
    const middle = (from + to) / 2;
    parts.push({ from, to, removed: editor.removed.some(([a, b]) => middle >= a && middle < b) });
  }
  return parts;
}

/** The part holding `time` (the video's timescale). */
export function partAt(parts: readonly TimelinePart[], time: number): TimelinePart | undefined {
  return parts.find((part) => time >= part.from && time < part.to) ?? parts.at(-1);
}

export function selectedPart(editor: EditorView): TimelinePart | undefined {
  if (selectedFrom === undefined) return undefined;
  return partAt(timelineParts(editor), selectedFrom);
}

/** Undo and Redo pressed while a change saves wait for it (`step`): only an empty stack makes them unavailable. */
export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

/** Opens the edit view for `item`. */
export async function openEditor(item: LibraryItemView): Promise<void> {
  forgetMenu();
  editingItem = item;
  exportWatched = undefined;
  enlarged = false;
  splits = [];
  selectedFrom = undefined;
  rangeSelection = undefined;
  undoStack.length = 0;
  redoStack.length = 0;
  sceneDraft = undefined;
  editorPreviewError = "";
  dropReload();
  // The dialog keeps its player between views: one that failed last time loads again rather than stay broken.
  if (editorVideo?.error && editingItem.video === editorVideo.getAttribute("src")) editorVideo.load();
  draw();
  // Refused (another recording's export runs): the view closes and says so.
  if (!(await send({ action: "open" })) && editingItem === item && !editorView()) {
    editingItem = undefined;
    draw();
    announce(view?.failure ?? "");
    focus(`clip-${item.id}-open`);
  }
}

/** The recording whose edit view waits for its saves before it closes. */
let closing: LibraryItemView | undefined;

/**
 * Closes the edit view, unless an export is running (it is cancelled first, or left to finish). A change still saving
 * (the X clicked straight after a cut) is waited for first: main drops a save whose view has closed.
 */
export function closeEditor(restore = true): Promise<void> {
  const item = editingItem;
  if (!item || closing === item) return Promise.resolve();
  if (editorView()?.export.phase === "exporting") return Promise.resolve();
  editorVideo?.pause();
  closing = item;
  return saved().finally(() => {
    closing = undefined;
    if (editingItem === item && editorView()?.export.phase !== "exporting") finishClose(item, restore);
  });
}

/**
 * Escape in the edit view (2026-10-26, the maintainer's request: a key pressed so often while editing must not close
 * it): it lets go of what is chosen, a range on the timeline or a part, and otherwise does nothing; the bubble's
 * selection is the page's (editor-scene.tsx), let go by moving the focus. Called by the dialog's dismissal, which takes
 * Escape before the page's keys see it. Returns whether it let go of anything.
 */
export function escapeEditor(): boolean {
  if (!editingItem) return false;
  // An enlarged preview first: Escape brings the timeline back.
  if (enlarged) {
    toggleEnlarged();
    return true;
  }
  // The bubble first while it has the focus, as that is what was last chosen.
  if (document.activeElement?.id === "editor-camera") {
    document.querySelector<HTMLElement>("#editor .editor-timeline")?.focus({ preventScroll: true });
    return true;
  }
  return deselect();
}

/**
 * Lets go of the timeline's selection, a range or a part (Escape, or the selection's ✕), and returns whether there was
 * one. The focus goes with it to the timeline, which draws no ring: left on the part a press focused, or on the ✕ that
 * goes with the actions, a key would ring it though nothing is chosen any more (a native round's R20, 2026-10-27).
 */
export function deselect(): boolean {
  if (!rangeSelection && selectedFrom === undefined) return false;
  rangeSelection = undefined;
  selectedFrom = undefined;
  if (document.activeElement?.closest(".editor-timeline .editor-part, .editor-camera-lane, #editor-selection-actions")) {
    document.querySelector<HTMLElement>("#editor .editor-timeline")?.focus({ preventScroll: true });
  }
  draw();
  return true;
}

/** How long Play on the export's toast waits for the library to list the new file. */
const LISTED_TIMEOUT_MS = 15_000;

/**
 * Play on the export's toast (2026-10-26): the edit view it was shown over closes, saving what waits, and the new file,
 * beside the recording, plays in the player once the library lists it (main publishes it before it says the export is
 * done; the listing follows). Opening another view or the player meanwhile drops the wait; a file still not listed after
 * a while is said by name instead, with the library in sight.
 */
export async function playExport(name: string, from: string): Promise<void> {
  const source = editingItem;
  if (!source || source.id !== from) return;
  const find = (): LibraryItemView | undefined => view?.library?.items.find((item) => item.name === name && item.folder === source.folder);
  await closeEditor(false);
  if (editingItem) return;
  let item = find();
  if (!item) {
    item = await new Promise<LibraryItemView | undefined>((resolve) => {
      const stop = subscribe(() => {
        const found = find();
        if (found || editingItem || playingItem) { clearTimeout(timer); stop(); resolve(found); }
      });
      const timer = setTimeout(() => { stop(); resolve(undefined); }, LISTED_TIMEOUT_MS);
    });
  }
  if (editingItem || playingItem) return;
  if (item) openPlayer(item);
  else {
    announce(translate("Exported as {name}.", view?.language, { name }));
    focus(`clip-${source.id}-open`);
  }
}

/** Settles once no change waits or saves, including one queued while the last was waited for. */
async function saved(): Promise<void> {
  for (;;) {
    const waiting = [edits, saveDone];
    await Promise.all(waiting);
    if (waiting[0] === edits && waiting[1] === saveDone) return;
  }
}

function finishClose(item: LibraryItemView, restore: boolean): void {
  editingItem = undefined;
  editorPreviewError = "";
  dropReload();
  volumeOpen = false;
  laneInput = undefined;
  exportWatched = undefined;
  enlarged = false;
  splits = [];
  selectedFrom = undefined;
  rangeSelection = undefined;
  undoStack.length = 0;
  redoStack.length = 0;
  sceneDraft = undefined;
  draw();
  void window.settings.choose(`recordingEdit:${item.id}`, { action: "close" } satisfies EditorChoice).then((result) => render(result.view), () => undefined);
  if (restore) focus(`clip-${item.id}-open`);
}

/** The recording went from the listing: the view goes with it. */
export function forgetEditor(ids: ReadonlySet<string>): void {
  if (editingItem && !ids.has(editingItem.id)) closeEditor(false);
}

export function attachEditorVideo(video: HTMLVideoElement | null): void {
  if (editorVideo && frameCallback !== undefined) editorVideo.cancelVideoFrameCallback(frameCallback);
  frameCallback = undefined;
  if (editorVideo) for (const [name, listener] of followers) editorVideo.removeEventListener(name, listener);
  editorVideo = video;
  // Chromium has it; a page test's DOM may not.
  if (video && typeof video.requestVideoFrameCallback === "function") watchFrames(video);
  if (video) for (const [name, listener] of followers) video.addEventListener(name, listener);
  // The view draws again with it, so the playhead follows it from the first seek (a ref is set while React commits).
  if (video) queueMicrotask(draw);
}

/** An editable recording's camera and second sound (plan 087), played beside the recording for its preview. */
let previewCamera: HTMLVideoElement | null = null;
let previewSound: HTMLAudioElement | null = null;
/** How far a follower may drift from the playing recording before it is put back to its time. */
const DRIFT_SECONDS = 0.12;

export function attachPreviewCamera(video: HTMLVideoElement | null): void {
  previewCamera = video;
  if (video) follow(video, true);
}

export function attachPreviewSound(media: HTMLAudioElement | null): void {
  // A view's element goes with its view: its sound graph is released, so none is kept for an element no longer shown.
  if (previewSound && previewSound !== media) release(previewSound);
  previewSound = media;
  if (media) {
    follow(media, true);
    syncPreviewAudio();
  }
}

/**
 * Puts `media` where the recording is, playing or not as it is, at its rate and with its mute and volume (the player's
 * own controls). `exact` after a seek or when it joins; while playing it is moved back only once it drifts.
 */
function follow(media: HTMLMediaElement, exact: boolean): void {
  const main = editorVideo;
  if (!main || !Number.isFinite(main.currentTime)) return;
  const drift = Math.abs(media.currentTime - main.currentTime);
  if (exact ? drift > 0.001 : drift > DRIFT_SECONDS) media.currentTime = main.currentTime;
  media.playbackRate = main.playbackRate;
  media.muted = main.muted;
  media.volume = main.volume;
  if (main.paused && !media.paused) media.pause();
  else if (!main.paused && media.paused) void media.play().catch(() => undefined);
}

function followAll(exact: boolean): void {
  for (const media of [previewCamera, previewSound]) if (media) follow(media, exact);
}

/** The recording's events its followers take. */
const followers: Array<[string, () => void]> = [
  ["play", () => { resumeAudio(); followAll(true); }],
  ["pause", () => { followAll(true); syncPreviewAudio(); }], ["seeked", () => { followAll(true); syncPreviewAudio(); }], ["ratechange", () => followAll(false)],
  ["volumechange", () => { followAll(false); syncPreviewAudio(); }], ["timeupdate", () => followAll(false)],
];

/**
 * The preview's sound (plan 087): each element through a gain at its track's volume, summed, then through the export's
 * soft limit (core's `limit`, as a wave shaper), so a loud or raised mix sounds as the export will, and only then the
 * player's own volume and mute, as a master gain: Chromium applies an element's volume and mute to its source node
 * (measured 2026-10-25), so each element's gain divides its own volume back out, and the mix is limited as the export
 * limits it whatever the player's volume (Codex's second review). Created once; each element's source can be made only
 * once, so an element's nodes live as long as it is shown, and are released after.
 */
let audio: { context: AudioContext; mix: AudioNode; master: GainNode; nodes: Map<HTMLMediaElement, { source: AudioNode; gain: GainNode }> } | undefined;
/** The span of sums the limiter's curve covers: past it a sum is as limited as full scale is. */
const LIMIT_SPAN = 8;

function gainFor(media: HTMLMediaElement): GainNode | undefined {
  if (typeof AudioContext !== "function") return undefined;
  if (!audio) {
    const context = new AudioContext();
    // Scaled into the shaper's -1…1 and out again by its curve, which is the limit of the sums -LIMIT_SPAN…LIMIT_SPAN.
    const into = context.createGain();
    into.gain.value = 1 / LIMIT_SPAN;
    const shaper = context.createWaveShaper();
    shaper.curve = Float32Array.from({ length: 4096 }, (_, n) => softLimit((n / 4095 * 2 - 1) * LIMIT_SPAN));
    const master = context.createGain();
    into.connect(shaper).connect(master).connect(context.destination);
    audio = { context, mix: into, master, nodes: new Map() };
  }
  let nodes = audio.nodes.get(media);
  if (!nodes) {
    const source = audio.context.createMediaElementSource(media);
    const gain = audio.context.createGain();
    source.connect(gain).connect(audio.mix);
    nodes = { source, gain };
    audio.nodes.set(media, nodes);
  }
  return nodes.gain;
}

/** Stops a follower that left and lets its nodes go. */
function release(media: HTMLMediaElement): void {
  media.pause();
  const nodes = audio?.nodes.get(media);
  if (!nodes) return;
  nodes.source.disconnect();
  nodes.gain.disconnect();
  audio!.nodes.delete(media);
}

function resumeAudio(): void {
  if (audio?.context.state === "suspended") void audio.context.resume().catch(() => undefined);
}

/** The scene shown now: the draft being moved, or the one saved. */
export function editorScene(editor: EditorView): EditScene | undefined {
  return sceneDraft ?? editor.editable?.scene;
}

/** A sound's volume in `scene` at `time` (the video's timescale; a stretch's there, 2026-10-26), as a gain. */
export function soundGain(scene: EditScene, sound: EditableSound | undefined, time = 0): number {
  const percent = sound === "microphone" || sound === "system" ? volumeAt(scene, sound, time) : 100;
  return percent / 100;
}

/** The last gain each sound node was told, so a frame that changes nothing schedules nothing. */
const told = new WeakMap<GainNode, number>();

/**
 * Sets each sound's gain to the scene shown: the recording plays the first sound, the follower the second. Any other
 * recording plays as it is: the edit view's player keeps its element, and so its gain, from one recording to the next.
 */
export function syncPreviewAudio(): void {
  const editor = editorView();
  const scene = editor && editorScene(editor);
  // What the element's volume did to its source undone: the gain alone is the scene's. While it plays a change of
  // stretch eases over a few milliseconds, as the export's does, so it does not click.
  const set = (media: HTMLMediaElement, gain: GainNode, factor: number): void => {
    const level = media.muted ? 0 : media.volume;
    const value = level > 0 ? factor / level : 0;
    if (told.get(gain) === value) return;
    told.set(gain, value);
    if (audio && !media.paused) gain.gain.setTargetAtTime(value, audio.context.currentTime, 0.004);
    else {
      gain.gain.cancelScheduledValues(0);
      gain.gain.value = value;
    }
  };
  if (audio && editorVideo) audio.master.gain.value = editorVideo.muted ? 0 : editorVideo.volume;
  if (!editor?.editable || !scene) {
    const kept = editorVideo && audio?.nodes.get(editorVideo);
    if (kept && editorVideo) set(editorVideo, kept.gain, 1);
    return;
  }
  const pairs: Array<[HTMLMediaElement | null, EditableSound | undefined]> = [[editorVideo, editor.editable.sounds[0]], [previewSound, editor.editable.sounds[1]]];
  const time = Math.round((editorVideo?.currentTime ?? 0) * editor.timescale);
  for (const [media, sound] of pairs) {
    if (!media) continue;
    const gain = gainFor(media);
    if (gain) set(media, gain, soundGain(scene, sound, time));
  }
  if (audio && editorVideo) audio.master.gain.value = editorVideo.muted ? 0 : editorVideo.volume;
}

/** How many scene changes wait to be saved (in turn with the timeline's, `inTurn`); the draft stays until the last. */
let scenesWaiting = 0;

/**
 * The scene changes: while `commit` is false it is a draft (the bubble dragged, a slider moving), shown and heard at
 * once; once committed it is saved, one change for Undo. The controls stay usable while a change saves (a key held on
 * a slider, a disabled control would lose the keyboard's focus): committed changes queue and save in turn, each against
 * the revision the one before brought, and the draft stays shown until the last is saved.
 */
export function changeScene(next: EditScene, commit: boolean): Promise<boolean> {
  const editor = editorView();
  if (!editor?.editable || editor.state !== "ready" || editor.export.phase === "exporting") return Promise.resolve(false);
  sceneDraft = next;
  syncPreviewAudio();
  draw();
  if (!commit) return Promise.resolve(true);
  scenesWaiting++;
  // In turn with the timeline's changes, after the save in flight (Codex's second review): a camera change pressed
  // while a cut saves is saved against the revision and the cuts that save brings, never a stale one main refuses.
  const run = inTurn(async () => {
    while (editorSaving) await saveDone;
    const now = editorView();
    if (!now?.editable || now.state !== "ready" || now.export.phase === "exporting") return false;
    undoStack.push(current(now));
    const saved = await save(now.removed, next);
    if (!saved) undoStack.pop();
    else redoStack.length = 0;
    return saved;
  }).finally(() => {
    if (--scenesWaiting === 0) sceneDraft = undefined;
    syncPreviewAudio();
    draw();
  });
  return run;
}

const copy = (ranges: readonly EditRange[]): EditRange[] => ranges.map(([from, to]): EditRange => [from, to]);

/**
 * While the preview plays, each frame shown is checked: one in a removed range jumps to where that range ends, so the
 * preview plays what the export will hold. A seek into a removed range shows it, marked on the timeline.
 */
function watchFrames(video: HTMLVideoElement): void {
  const check = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
    frameCallback = video.requestVideoFrameCallback(check);
    const editor = editorView();
    if (!editor || video.paused) return;
    // Volume stretches (2026-10-26): each frame shown sets the sounds' gains for its time; nothing without any.
    if (editorScene(editor)?.volumeStretches) syncPreviewAudio();
    // Half a frame either way: a frame's media time is rounded to microseconds and need not fall on the timescale's
    // grid, so the frame a range ends at could read as just inside it and be sought to again and again, the preview
    // standing still while it shows Pause.
    const time = metadata.mediaTime * editor.timescale,
      slack = editor.timescale / Math.max(1, editor.frameRate) / 2;
    const range = editor.skipped.find(([from, to]) => time >= from - slack && time < to - slack);
    if (!range) return;
    if (range[1] >= editor.duration) {
      video.pause();
      video.currentTime = range[0] / editor.timescale;
    } else {
      video.currentTime = range[1] / editor.timescale;
    }
  };
  frameCallback = video.requestVideoFrameCallback(check);
}

/** The video's position in its timescale, on a frame start. */
function playhead(editor: EditorView): number {
  const seconds = editorVideo?.currentTime ?? 0;
  const frame = Math.round(seconds * editor.frameRate);
  return Math.min(editor.duration, Math.round((frame / Math.max(1, editor.frameRate)) * editor.timescale));
}

export function seekTo(seconds: number): void {
  if (editorVideo) editorVideo.currentTime = seconds;
}

export function toggleSkimming(): void {
  skimming = !skimming;
  if (!skimming) endSkim();
  draw();
}

/** Shows the picture at `ticks` while the pointer skims the timeline. */
export function skimTo(ticks: number): void {
  const editor = editorView();
  if (!skimming || !editor || !editorVideo) return;
  if (skimFrom === undefined) {
    skimFrom = editorVideo.currentTime;
    editorVideo.pause();
  }
  skimAt = ticks;
  seekTo(ticks / editor.timescale);
  draw();
}

/** The pointer left the timeline: the preview goes back to the playhead, unless a press moved it meanwhile. */
export function endSkim(): void {
  if (skimFrom !== undefined) seekTo(skimFrom);
  skimFrom = undefined;
  skimAt = undefined;
  draw();
}

/** Where the playhead is, in seconds: while the pointer skims, where it was before, not the picture skimmed to. */
export function playheadTime(): number | undefined {
  return skimFrom ?? editorVideo?.currentTime;
}

/** A press on the timeline while skimming: what it does to the playhead stays when the pointer leaves. */
export function keepSkimmed(): void {
  skimFrom = undefined;
}

/** Plays the preview, or pauses it; a preview that failed loads again first, then plays. */
export function togglePlayback(): void {
  if (!editorVideo) return;
  if (editorVideo.error) reloadEditorPreview(true);
  else if (editorVideo.paused) void editorVideo.play().catch(() => undefined);
  else editorVideo.pause();
}

/** Enlarge preview on or off (T, or its button); the focus goes to the picture, or back to the timeline. */
export function toggleEnlarged(): void {
  if (!editingItem) return;
  enlarged = !enlarged;
  draw();
  requestAnimationFrame(() => {
    const target = enlarged ? editorVideo : document.querySelector<HTMLElement>("#editor .editor-timeline");
    target?.focus({ preventScroll: true });
  });
}

/** The preview's media failed while the view is open: said over it, with Reload preview. */
export function editorPreviewFailed(): void {
  if (!editingItem || !editorVideo?.getAttribute("src")) return;
  dropReload();
  editorPreviewError = translate("The preview stopped because the recording could not be read. Reload it to go on.", view?.language);
  announce(editorPreviewError);
}

/**
 * A reload waiting for its metadata. Let go when the view closes or opens, the preview fails again or reloads again,
 * so a reload that never ends cannot seek or play the next recording the kept-mounted player shows (review of
 * 2026-10-26).
 */
let pendingReload: AbortController | undefined;
function dropReload(): void {
  pendingReload?.abort();
  pendingReload = undefined;
}

/** Reload preview: the recording loads again and comes back to where the playhead was, playing if asked. */
export function reloadEditorPreview(play = false): void {
  const video = editorVideo, item = editingItem;
  if (!video || !item) return;
  dropReload();
  const at = video.currentTime, source = video.getAttribute("src");
  const reload = new AbortController();
  pendingReload = reload;
  editorPreviewError = "";
  draw();
  video.addEventListener("loadedmetadata", () => {
    if (pendingReload !== reload) return;
    pendingReload = undefined;
    if (editingItem !== item || editorVideo !== video || video.getAttribute("src") !== source) return;
    video.currentTime = at;
    if (play) void video.play().catch(() => undefined);
  }, { once: true, signal: reload.signal });
  video.load();
}

/** Moves the paused playhead by `frames` frames and `seconds` seconds, onto a frame start. */
export function stepPlayhead(frames: number, seconds: number): void {
  const editor = editorView();
  if (!editor || !editorVideo) return;
  editorVideo.pause();
  const rate = Math.max(1, editor.frameRate);
  const frame = Math.round(editorVideo.currentTime * rate) + frames + Math.round(seconds * rate);
  seekTo(Math.min(editor.seconds, Math.max(0, frame / rate)));
}

/** Selects the part at `from` (the video's timescale) and moves the playhead to its start. */
export function selectPart(part: TimelinePart, seek = true): void {
  selectedFrom = part.from;
  rangeSelection = undefined;
  const editor = editorView();
  if (seek && editor) seekTo(part.from / editor.timescale);
  draw();
}

/**
 * Splits the timeline at the playhead; the part after it is selected. In turn with the saving changes, so Undo keeps the
 * edit as it is once a change still saving has landed (the controls stay available while one saves, 2026-10-26).
 */
export function splitAtPlayhead(): Promise<void> {
  // Where S was pressed, read now: the playhead may move while a save is waited for (Codex's second review).
  const editor = editorView();
  const at = editor ? playhead(editor) : 0;
  const item = editingItem;
  return inTurn(async () => {
    while (editorSaving) await saveDone;
    if (editingItem === item) splitNow(at);
  });
}

function splitNow(at: number): void {
  const editor = editorView();
  if (!editor || editor.state !== "ready" || editor.export.phase === "exporting") return;
  if (at <= 0 || at >= editor.duration) return;
  undoStack.push(current(editor));
  redoStack.length = 0;
  splits = [...splits, at];
  selectedFrom = at;
  rangeSelection = undefined;
  announce(translate("Split at {time}", view?.language, { time: clock(at / editor.timescale) }));
  draw();
}

/**
 * Whether the selected part can join the one before it (2026-10-26, the maintainer's request: a split had no way back
 * but Undo, and only while it was the last change): when it starts at a split of the timeline's own and the two read
 * as one part without it. A boundary a cut makes is not a split, so it stays.
 */
export function canJoinPrevious(editor: EditorView): boolean {
  const part = rangeSelection ? undefined : selectedPart(editor);
  if (!part || !splits.includes(part.from)) return false;
  return timelineParts(editor, splits.filter((at) => at !== part.from)).length < timelineParts(editor).length;
}

/** Joins the selected part to the one before it, its split gone, as one step Undo takes back; the joined part chosen. */
export function joinPrevious(): Promise<void> {
  return inTurn(async () => {
    while (editorSaving) await saveDone;
    const editor = editorView();
    if (!editor || editor.state !== "ready" || editor.export.phase === "exporting" || !canJoinPrevious(editor)) return;
    const part = selectedPart(editor)!;
    undoStack.push(current(editor));
    redoStack.length = 0;
    splits = splits.filter((at) => at !== part.from);
    const joined = partAt(timelineParts(editor), Math.max(0, part.from - 1));
    selectedFrom = joined?.from;
    announce(translate("Joined to the part before, from {from} to {to}", view?.language, {
      from: clock((joined?.from ?? 0) / editor.timescale), to: clock((joined?.to ?? part.to) / editor.timescale),
    }));
    draw();
  });
}

/** Removes the selected part, or keeps it again when it was removed. */
export function toggleSelected(): Promise<void> {
  return inTurn(toggleNow);
}

async function toggleNow(): Promise<void> {
  while (editorSaving) await saveDone;
  const editor = editorView();
  if (!editor || editor.state !== "ready" || editorSaving || editor.export.phase === "exporting") return;
  if (rangeSelection) return removeRange(editor, rangeSelection);
  const part = selectedPart(editor);
  if (!part) return;
  const removed = part.removed ? subtract(editor.removed, part) : normalizeRanges([...editor.removed, [part.from, part.to]]);
  undoStack.push(current(editor));
  const saved = await save(removed);
  if (!saved) undoStack.pop();
  else redoStack.length = 0;
  // The part stays selected though main snapped its ends to frames: the part now holding its middle.
  const after = saved ? editorView() : undefined;
  if (after) selectedFrom = partAt(timelineParts(after), Math.round((part.from + part.to) / 2))?.from;
  if (saved) announce(translate(part.removed ? "Kept {from} to {to}" : "Removed {from} to {to}", view?.language, {
    from: clock(part.from / editor.timescale), to: clock(part.to / editor.timescale),
  }));
}

/** Removes a range dragged across the timeline, as one change Undo takes back; the part it leaves is selected. */
async function removeRange(editor: EditorView, [from, to]: EditRange): Promise<void> {
  undoStack.push(current(editor));
  const saved = await save(normalizeRanges([...editor.removed, [from, to]]));
  if (!saved) {
    undoStack.pop();
    return;
  }
  redoStack.length = 0;
  rangeSelection = undefined;
  const after = editorView();
  if (after) selectedFrom = partAt(timelineParts(after), Math.round((from + to) / 2))?.from;
  // A part chosen by a removal is the pictures', whatever lane chose the one before (review of 2026-10-26).
  draw();
  announce(translate("Removed {from} to {to}", view?.language, { from: clock(from / editor.timescale), to: clock(to / editor.timescale) }));
}

/** Chooses the range between two places on the timeline (the video's timescale), or none when they meet. */
export function selectRange(a: number, b: number): void {
  const editor = editorView();
  if (!editor) return;
  const from = Math.max(0, Math.min(a, b)), to = Math.min(editor.duration, Math.max(a, b));
  const frame = editor.timescale / Math.max(1, editor.frameRate);
  rangeSelection = to - from >= frame ? [from, to] : undefined;
  if (rangeSelection) selectedFrom = undefined;
  draw();
}

/** The ranges without `part`. */
function subtract(ranges: readonly EditRange[], part: TimelinePart): EditRange[] {
  const out: EditRange[] = [];
  for (const [from, to] of ranges) {
    if (to <= part.from || from >= part.to) out.push([from, to]);
    else {
      if (from < part.from) out.push([from, part.from]);
      if (to > part.to) out.push([part.to, to]);
    }
  }
  return out;
}

/** The edit as it is now, as Undo and Redo keep it. */
function current(editor: EditorView): EditState {
  return { removed: copy(editor.removed), ...(editor.editable ? { scene: editor.editable.scene } : {}), splits: [...splits] };
}

/**
 * The timeline's saving changes, run one after another (2026-10-25): a key pressed while one saves waits its turn, so
 * ⌘Z straight after ⇧⌘Z takes back what the redo made, not what lay under it.
 */
let edits: Promise<unknown> = Promise.resolve();
function inTurn<T>(run: () => Promise<T>): Promise<T> {
  const next = edits.then(run, run);
  edits = next.catch(() => undefined);
  return next;
}

export function undoEdit(): Promise<void> {
  return inTurn(() => step(undoStack, redoStack, "Undone"));
}

/** Makes again the change Undo took back last (⇧⌘Z / Ctrl+Shift+Z or Ctrl+Y). */
export function redoEdit(): Promise<void> {
  return inTurn(() => step(redoStack, undoStack, "Redone"));
}

/** Saves the newest edit of `from`, keeping the one it replaces on `to`; a failed save leaves both as they were. */
async function step(from: EditState[], to: EditState[], said: "Undone" | "Redone"): Promise<void> {
  // A key pressed while the last change saves waits for it rather than being lost (⇧⌘Z straight after ⌘Z, in CI).
  while (editorSaving) await saveDone;
  const editor = editorView();
  if (!editor || editor.state !== "ready" || editorSaving || editor.export.phase === "exporting") return;
  const next = from.pop();
  if (!next) return;
  rangeSelection = undefined;
  const now = current(editor);
  // A split alone changes nothing main keeps: it comes back or goes without a save.
  if (JSON.stringify(next.removed) === JSON.stringify(now.removed) && sameScene(next.scene, now.scene)) {
    splits = next.splits;
    to.push(now);
    announce(translate(said, view?.language));
    draw();
    return;
  }
  if (await save(next.removed, next.scene)) {
    splits = next.splits;
    to.push(now);
    syncPreviewAudio();
    announce(translate(said, view?.language));
  } else from.push(next);
}

/** Whether the view's recording has a camera whose stretches can be hidden: an editable recording with one. */
export function hasCamera(editor: EditorView): boolean {
  return Boolean(editor.editable?.camera && editorScene(editor)?.camera);
}

/** One stretch of the camera's lane under the timeline: the camera shown or hidden from `from` to `to`. */
export interface CameraStretch { from: number; to: number; hidden: boolean }

/** The camera's lane: the recording from start to end in stretches, each shown or hidden. */
export function cameraStretches(editor: EditorView): CameraStretch[] {
  const camera = editorScene(editor)?.camera;
  if (!camera) return [];
  const stretches: CameraStretch[] = [];
  let at = 0;
  for (const [from, to] of cameraHidden(camera, editor.duration)) {
    if (from > at) stretches.push({ from: at, to: from, hidden: false });
    stretches.push({ from, to, hidden: true });
    at = to;
  }
  if (at < editor.duration) stretches.push({ from: at, to: editor.duration, hidden: false });
  return stretches;
}

/**
 * The stretch the camera button acts on: the range dragged across the timeline, else the selected part, its ends on
 * frame starts. None without either: the button then says to choose one first.
 */
export function cameraTarget(editor: EditorView): EditRange | undefined {
  const frame = editor.timescale / Math.max(1, editor.frameRate);
  const snap = (ticks: number): number => Math.min(editor.duration, Math.max(0, Math.round(Math.round(ticks / frame) * frame)));
  const chosen = rangeSelection ?? (() => { const part = selectedPart(editor); return part ? [part.from, part.to] as EditRange : undefined; })();
  if (!chosen) return undefined;
  const from = chosen[0] <= 0 ? 0 : snap(chosen[0]), to = chosen[1] >= editor.duration ? editor.duration : snap(chosen[1]);
  return to > from ? [from, to] : undefined;
}

/** Whether the camera is hidden over the whole of `range` by the timeline's stretches, so the button shows it there again. */
export function cameraHiddenOver(editor: EditorView, [from, to]: EditRange): boolean {
  const camera = editorScene(editor)?.camera;
  return Boolean(camera && storedStretches(camera, editor.duration).some(([a, b]) => a <= from && b >= to));
}

/** Hidden throughout (the options' switch): the timeline's stretches wait, and the camera button with them. */
export function cameraHiddenThroughout(editor: EditorView): boolean {
  return editorScene(editor)?.camera?.shown === false;
}

/**
 * The camera button and C (2026-10-26, the maintainer's request): over the selected range or part, the camera is hidden,
 * or shown again where it was hidden throughout that stretch, as one change Undo takes back. The selection stays, so a
 * second press takes it back as well.
 */
export function toggleCameraInSelection(): Promise<boolean> {
  const editor = editorView();
  const scene = editor && editorScene(editor);
  const camera = scene?.camera;
  const target = editor && cameraTarget(editor);
  if (!editor || !scene || !camera || editor.state !== "ready" || editor.export.phase === "exporting") return Promise.resolve(false);
  // Hidden throughout, C says why it does nothing, with or without a selection.
  if (!camera.shown) {
    announce(translate("Turn off Hide camera view in More options to hide or show it over a stretch.", view?.language));
    return Promise.resolve(false);
  }
  if (!target) return Promise.resolve(false);
  const hidden = storedStretches(camera, editor.duration);
  const show = cameraHiddenOver(editor, target);
  const next = show ? subtractRange(hidden, target) : mergeRanges([...hidden, target], editor.duration);
  // Past the most stretches a scene holds, the change is refused, never saved with a stretch dropped (Codex's review).
  if (next.length > MAX_CAMERA_HIDDEN) {
    announce(translate("The camera can be hidden over at most {count} stretches.", view?.language, { count: String(MAX_CAMERA_HIDDEN) }));
    return Promise.resolve(false);
  }
  const said = translate(show ? "Camera shown from {from} to {to}" : "Camera hidden from {from} to {to}", view?.language, {
    from: clock(target[0] / editor.timescale), to: clock(target[1] / editor.timescale),
  });
  // A change to a hidden lane shows it again, so what changed is seen.
  if (!laneShown("camera")) showLane("camera", true);
  return changeScene({ ...scene, camera: withCameraHidden(camera, next, editor.duration) }, true).then((saved) => {
    if (saved) announce(said);
    return saved;
  });
}

/**
 * Hide the camera throughout, the options' switch (2026-10-26, the maintainer's choice: a switch over the timeline's
 * stretches, never one that drops them): on, no camera in the export; off again, the stretches the timeline holds.
 */
export function hideCameraThroughout(hidden: boolean): Promise<boolean> {
  const editor = editorView();
  const scene = editor && editorScene(editor);
  const camera = scene?.camera;
  if (!editor || !scene || !camera || camera.shown === !hidden) return Promise.resolve(false);
  return changeScene({ ...scene, camera: { ...camera, shown: !hidden } }, true);
}

/** The inputs the view's editable recording holds, which have volume lanes (2026-10-26). */
export function volumeInputs(editor: EditorView): VolumeInput[] {
  const sounds = editor.editable?.sounds ?? [];
  return (["system", "microphone"] as const).filter((input) => sounds.includes(input));
}

/** One stretch of an input's lane: at the input's own volume (`volume` undefined) or a stretch's. */
export interface VolumeLaneStretch { from: number; to: number; volume?: number }

/** An input's lane: the recording from start to end, at its own volume or a stretch's. */
export function volumeLane(editor: EditorView, input: VolumeInput): VolumeLaneStretch[] {
  const scene = editorScene(editor);
  if (!scene) return [];
  const out: VolumeLaneStretch[] = [];
  let at = 0;
  for (const [from, to, volume] of volumeStretchesOf(scene, input)) {
    if (from > at) out.push({ from: at, to: from });
    out.push({ from, to, volume });
    at = to;
  }
  if (at < editor.duration) out.push({ from: at, to: editor.duration });
  return out;
}

/** A lane under the timeline's pictures: the camera's, or a sound input's. */
export type Lane = "camera" | VolumeInput;
/** Where the lanes hidden in Options are remembered (2026-10-26): this window's own look, as the sidebar's. */
const LANES_KEY = "recordstuff.editorHiddenLanes";
const LANES: readonly Lane[] = ["camera", "system", "microphone"];
let hiddenLanes: Set<Lane> = (() => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LANES_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((lane): lane is Lane => (LANES as readonly unknown[]).includes(lane)) : []);
  } catch {
    return new Set<Lane>();
  }
})();

/** Whether `lane` is shown under the timeline (Options' lanes, 2026-10-26, the maintainer's request). */
export function laneShown(lane: Lane): boolean {
  return !hiddenLanes.has(lane);
}

/** Shows or hides `lane`, remembered for the next edit views; what it holds is kept and exported either way. */
export function showLane(lane: Lane, shown: boolean): void {
  const next = new Set(hiddenLanes);
  if (shown) next.delete(lane);
  else next.add(lane);
  hiddenLanes = next;
  try { localStorage.setItem(LANES_KEY, JSON.stringify([...next])); } catch { /* a page without storage keeps it until closed */ }
  draw();
}

/** Whether the Volume popup is open: its button, or V (2026-10-26). */
export let volumeOpen = false;

/** Opens or closes the Volume popup; with nothing selected, V says what to choose instead of opening it. */
export function setVolumeOpen(open: boolean): void {
  volumeOpen = open;
  draw();
}

export function openVolume(): void {
  const editor = editorView();
  if (!editor || editor.state !== "ready" || editor.export.phase === "exporting" || volumeInputs(editor).length === 0) return;
  if (!cameraTarget(editor)) {
    announce(translate("Select a part or drag across the timeline, then set its volume (V)", view?.language));
    return;
  }
  setVolumeOpen(true);
}

/** The input whose lane was clicked last, which the volume popup lists first. */
export let laneInput: VolumeInput | undefined;
export function chooseLaneInput(input: VolumeInput | undefined): void {
  laneInput = input;
}

/** `input`'s volume over the selection as the popup shows it: at the selection's start. */
export function volumeOverSelection(editor: EditorView, input: VolumeInput): number | undefined {
  const scene = editorScene(editor);
  const target = cameraTarget(editor);
  return scene && target ? volumeAt(scene, input, target[0]) : undefined;
}

/**
 * The volume popup (2026-10-26, the maintainer's request): `input` at `percent` over the selected range or part (0%
 * silent), or back to its own volume there when `percent` is undefined. While `commit` is false a draft, heard at once
 * (a slider moving); committed, one change Undo takes back.
 */
export function setVolumeInSelection(input: VolumeInput, percent: number | undefined, commit: boolean): Promise<boolean> {
  const editor = editorView();
  const scene = editor && editorScene(editor);
  const target = editor && cameraTarget(editor);
  if (!editor || !scene || !target || editor.state !== "ready" || editor.export.phase === "exporting") return Promise.resolve(false);
  // Over the shown scene: a slider's next draft sets the same range again, so drafts never pile up.
  const next = setVolumeOver(volumeStretchesOf(scene, input), target[0], target[1], percent, editor.duration);
  if (next.length > MAX_CAMERA_HIDDEN) {
    announce(translate("An input can be at a volume of its own over at most {count} stretches.", view?.language, { count: String(MAX_CAMERA_HIDDEN) }));
    return Promise.resolve(false);
  }
  const name = translate(input === "system" ? "System audio" : "Microphone", view?.language);
  const range = { from: clock(target[0] / editor.timescale), to: clock(target[1] / editor.timescale) };
  const said = percent === undefined
    ? translate("{name} back to its volume from {from} to {to}", view?.language, { name, ...range })
    : percent === 0
    ? translate("{name} muted from {from} to {to}", view?.language, { name, ...range })
    : translate("{name} at {percent}% from {from} to {to}", view?.language, { name, percent: String(percent), ...range });
  if (commit && !laneShown(input)) showLane(input, true);
  return changeScene(withVolumeStretches(scene, input, next), commit).then((saved) => {
    if (saved && commit) announce(said);
    return saved;
  });
}

/** Back to the overall volume over the selection, for every input at once, as one change Undo takes back. */
export function resetVolumesInSelection(): Promise<boolean> {
  const editor = editorView();
  let scene = editor && editorScene(editor);
  const target = editor && cameraTarget(editor);
  if (!editor || !scene || !target || editor.export.phase === "exporting") return Promise.resolve(false);
  for (const input of volumeInputs(editor)) {
    const next = setVolumeOver(volumeStretchesOf(scene, input), target[0], target[1], undefined, editor.duration);
    // Given back inside a stretch, it splits in two: past the limit the whole change is refused (Codex's review).
    if (next.length > MAX_CAMERA_HIDDEN) {
      announce(translate("An input can be at a volume of its own over at most {count} stretches.", view?.language, { count: String(MAX_CAMERA_HIDDEN) }));
      return Promise.resolve(false);
    }
    scene = withVolumeStretches(scene, input, next);
  }
  if (sameScene(scene, editorScene(editor))) return Promise.resolve(false);
  const said = translate("Volumes back to the overall volume from {from} to {to}", view?.language, { from: clock(target[0] / editor.timescale), to: clock(target[1] / editor.timescale) });
  return changeScene(scene, true).then((saved) => {
    if (saved) announce(said);
    return saved;
  });
}

/**
 * The overall volumes back to 100%, as one change Undo takes back (2026-10-26, the maintainer's review: Reset in the
 * volume panel resets those two and nothing set on the timeline, neither the volumes of its own nor the camera).
 */
export function resetOverallVolumes(): Promise<boolean> {
  const editor = editorView();
  const scene = editor && editorScene(editor);
  if (!editor || !scene || (scene.volumes.system === 100 && scene.volumes.microphone === 100)) return Promise.resolve(false);
  return changeScene({ ...scene, volumes: { ...scene.volumes, system: 100, microphone: 100 } }, true);
}

/** Whether the edit changes nothing: every part kept, no split, and an editable recording's scene as recorded. */
export function isOriginal(editor: EditorView): boolean {
  return editor.removed.length === 0 && splits.length === 0 && (!editor.editable || sameScene(editorScene(editor), editor.editable.recorded));
}

/**
 * Revert to original recording (2026-10-26, the maintainer's request, as Photos' Revert to Original): every cut kept
 * again, the splits gone and an editable recording's camera and volumes as recorded, as one change Undo takes back. Its
 * record then goes (main keeps none for an edit that changes nothing), and with it the card's Edited mark.
 */
export function revertToOriginal(): Promise<boolean> {
  return inTurn(async () => {
    while (editorSaving) await saveDone;
    const editor = editorView();
    if (!editor || editor.state !== "ready" || editor.export.phase === "exporting" || isOriginal(editor)) return false;
    const before = current(editor);
    rangeSelection = undefined;
    selectedFrom = undefined;
    const saved = editor.removed.length === 0 && sameScene(editorScene(editor), editor.editable?.recorded) ? true : await save([], editor.editable?.recorded);
    if (!saved) {
      draw();
      return false;
    }
    undoStack.push(before);
    redoStack.length = 0;
    splits = [];
    syncPreviewAudio();
    draw();
    announce(translate("Back to the original recording", view?.language));
    return true;
  });
}

/** Whether two scenes place and mix alike. */
export function sameScene(a: EditScene | undefined, b: EditScene | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Settles when the save under way does. */
let saveDone: Promise<unknown> = Promise.resolve();

async function save(removed: EditRange[], scene?: EditScene): Promise<boolean> {
  const editor = editorView();
  if (!editor) return false;
  editorSaving = true;
  draw();
  const sent = send({ action: "save", removed, revision: editor.revision, ...(scene ? { scene } : {}) });
  saveDone = sent.catch(() => undefined);
  try {
    return await sent;
  } finally {
    editorSaving = false;
    draw();
  }
}

/**
 * The recording whose export's outcome the view says next (2026-10-26, as a toast): set once main answers Export with
 * the export under way, or already ended (a start that failed goes straight to its failure, and a quick one may be done),
 * so an outcome left from before, seen on reopening the view, is never said again.
 */
export let exportWatched: string | undefined;

export async function exportEdit(): Promise<boolean> {
  const id = editingItem?.id;
  // The export takes the edit as saved: a change still saving or queued (a volume just let go) is waited for first, so
  // Export need not be drawn unavailable while one saves (2026-10-26).
  await saved();
  if (editingItem?.id !== id || !editorView()?.exportable) return false;
  const applied = await send({ action: "export" });
  const phase = editorView()?.export.phase;
  // Refused, the export is not this one's, unless the refusal is a failure to start.
  exportWatched = id && (phase === "exporting" || phase === "failed" || (phase === "done" && applied)) ? id : undefined;
  draw();
  return applied;
}

/** The outcome the view was watching for has been said. */
export function exportSaid(): void {
  exportWatched = undefined;
}

export function cancelExport(): Promise<boolean> {
  return send({ action: "cancelExport" });
}

export function discardEdit(): Promise<boolean> {
  undoStack.length = 0;
  redoStack.length = 0;
  sceneDraft = undefined;
  splits = [];
  return send({ action: "discard" });
}

async function send(choice: EditorChoice): Promise<boolean> {
  const item = editingItem;
  if (!item) return false;
  try {
    const result = await window.settings.choose(`recordingEdit:${item.id}`, choice);
    render(result.view);
    const failure = editorView()?.saveFailure;
    if (!result.applied && choice.action === "save" && failure) announce(failure);
    return result.applied;
  } catch {
    return false;
  }
}

/** `m:ss.s` (or `h:mm:ss.s`): a position on the timeline, to a tenth of a second. */
export function clock(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const hours = Math.floor(tenths / 36000), minutes = Math.floor((tenths % 36000) / 600), rest = (tenths % 600) / 10;
  const secondsText = rest.toFixed(1).padStart(4, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secondsText}` : `${minutes}:${secondsText}`;
}
