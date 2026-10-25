/**
 * The edit view (plan 085): which recording is being cut, the timeline's parts, the selection and Undo. Main owns the
 * edit (the removed ranges it saved, snapped to frames by the engine) and the export; the page keeps only what has
 * not been saved: where the timeline was split without removing anything, the selected part, and the edits each
 * change replaced, for Undo. Every change is saved at once, as one choice on `recordingEdit:<id>`.
 *
 * An editable recording (plan 087) also has a scene: the camera's place, size and visibility, and each input's
 * volume. While the bubble is dragged or a slider moves, the page shows a draft of it; letting go saves it, one change
 * for Undo. Its preview plays the recording (the screen with its first sound) with the camera's and the second sound's
 * own tracks beside it, kept to the recording's time, and each sound through a gain at its volume.
 */
import type { LibraryItemView } from "../../../shared/settings-panel";
import { normalizeRanges, type EditorChoice, type EditorView, type EditRange } from "../../../shared/editing";
import type { EditableSound, EditScene } from "../../../shared/editable";
import { softLimit } from "../../../shared/audio-volume";
import { translate } from "../../../shared/i18n";
import { announce, draw, focus, render, view } from "./core";
import { forgetMenu } from "./library";

export let editingItem: LibraryItemView | undefined;
export let editorVideo: HTMLVideoElement | null = null;
/** Where the timeline was split without a removal on either side, in the video's timescale. */
let splits: number[] = [];
/** The selected part, by where it starts. */
export let selectedFrom: number | undefined;
/** A range dragged across the timeline (2026-10-25), in the video's timescale: Remove takes it out. */
export let rangeSelection: EditRange | undefined;
/** A trim handle being dragged (2026-10-25): where the kept recording would start or end, until it is let go. */
let trimDraft: { edge: TrimEdge; at: number } | undefined;
/**
 * Skimming (2026-10-25, the maintainer's choice, as Final Cut Pro's): while on, the preview shows the picture under the
 * pointer as it moves over the timeline, and goes back to the playhead when it leaves. On by default since 2026-10-25,
 * as most editors' (the maintainer's choice); kept while the app runs.
 */
export let skimming = true;
/** Where the skimmer is, in the video's timescale, while the pointer skims. */
export let skimAt: number | undefined;
/** The playhead's time before the pointer began skimming, which it returns to; none once a press put it elsewhere. */
let skimFrom: number | undefined;
/** The shortest stretch the trim handles leave between them, in seconds. */
const TRIM_GAP = 0.2;
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
/** A change being saved: further edits wait for its answer, which brings the revision they change. */
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
  const removed = shownRemoved(editor);
  for (const [from, to] of removed) {
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
    parts.push({ from, to, removed: removed.some(([a, b]) => middle >= a && middle < b) });
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

export function canUndo(): boolean {
  return undoStack.length > 0 && !editorSaving;
}

export function canRedo(): boolean {
  return redoStack.length > 0 && !editorSaving;
}

/** Opens the edit view for `item`. */
export async function openEditor(item: LibraryItemView): Promise<void> {
  forgetMenu();
  editingItem = item;
  splits = [];
  selectedFrom = undefined;
  rangeSelection = undefined;
  trimDraft = undefined;
  undoStack.length = 0;
  redoStack.length = 0;
  sceneDraft = undefined;
  draw();
  // Refused (another recording's export runs): the view closes and says so.
  if (!(await send({ action: "open" })) && editingItem === item && !editorView()) {
    editingItem = undefined;
    draw();
    announce(view?.failure ?? "");
    focus(`clip-${item.id}-open`);
  }
}

/** Closes the edit view, unless an export is running (it is cancelled first, or left to finish). */
export function closeEditor(restore = true): void {
  const item = editingItem;
  if (!item) return;
  if (editorView()?.export.phase === "exporting") return;
  editorVideo?.pause();
  editingItem = undefined;
  splits = [];
  selectedFrom = undefined;
  rangeSelection = undefined;
  trimDraft = undefined;
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
  ["pause", () => followAll(true)], ["seeked", () => followAll(true)], ["ratechange", () => followAll(false)],
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

/** A sound's volume in `scene`, as a gain. */
export function soundGain(scene: EditScene, sound: EditableSound | undefined): number {
  const percent = sound === "microphone" ? scene.volumes.microphone : sound === "system" ? scene.volumes.system : 100;
  return percent / 100;
}

/**
 * Sets each sound's gain to the scene shown: the recording plays the first sound, the follower the second. Any other
 * recording plays as it is: the edit view's player keeps its element, and so its gain, from one recording to the next.
 */
export function syncPreviewAudio(): void {
  const editor = editorView();
  const scene = editor && editorScene(editor);
  // What the element's volume did to its source undone: the gain alone is the scene's.
  const set = (media: HTMLMediaElement, gain: GainNode, factor: number): void => {
    const level = media.muted ? 0 : media.volume;
    gain.gain.value = level > 0 ? factor / level : 0;
  };
  if (audio && editorVideo) audio.master.gain.value = editorVideo.muted ? 0 : editorVideo.volume;
  if (!editor?.editable || !scene) {
    const kept = editorVideo && audio?.nodes.get(editorVideo);
    if (kept && editorVideo) set(editorVideo, kept.gain, 1);
    return;
  }
  const pairs: Array<[HTMLMediaElement | null, EditableSound | undefined]> = [[editorVideo, editor.editable.sounds[0]], [previewSound, editor.editable.sounds[1]]];
  for (const [media, sound] of pairs) {
    if (!media) continue;
    const gain = gainFor(media);
    if (gain) set(media, gain, soundGain(scene, sound));
  }
  if (audio && editorVideo) audio.master.gain.value = editorVideo.muted ? 0 : editorVideo.volume;
}

/** Scene changes being saved, one after another, and how many are waiting. */
let sceneSaves: Promise<unknown> = Promise.resolve();
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
  const run = sceneSaves.then(async () => {
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
  sceneSaves = run.catch(() => false);
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
    const time = metadata.mediaTime * editor.timescale;
    const range = editor.skipped.find(([from, to]) => time >= from && time < to);
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

/** Plays the preview, or pauses it. */
export function togglePlayback(): void {
  if (!editorVideo) return;
  if (editorVideo.paused) void editorVideo.play().catch(() => undefined);
  else editorVideo.pause();
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

/** Splits the timeline at the playhead; the part after it is selected. */
export function splitAtPlayhead(): void {
  const editor = editorView();
  if (!editor || editor.state !== "ready" || editor.export.phase === "exporting") return;
  const at = playhead(editor);
  if (at <= 0 || at >= editor.duration) return;
  undoStack.push(current(editor));
  redoStack.length = 0;
  splits = [...splits, at];
  selectedFrom = at;
  rangeSelection = undefined;
  announce(translate("Split at {time}", view?.language, { time: clock(at / editor.timescale) }));
  draw();
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

export type TrimEdge = "start" | "end";

/** Where the kept recording starts and ends: the ends of a removal touching the recording's start or end. */
export function trimmed(editor: EditorView, removed: readonly EditRange[] = editor.removed): { start: number; end: number } {
  const frame = editor.timescale / Math.max(1, editor.frameRate);
  const head = removed.find(([from]) => from < frame);
  const tail = removed.find(([, to]) => to > editor.duration - frame);
  return { start: head ? head[1] : 0, end: tail ? tail[0] : editor.duration };
}

/** The trim handle being moved, if one is. */
export function trimming(): TrimEdge | undefined {
  return trimDraft?.edge;
}

/** The trim handles as drawn: a handle being dragged where it is. */
export function shownTrim(editor: EditorView): { start: number; end: number } {
  const now = trimmed(editor);
  return trimDraft ? { ...now, [trimDraft.edge]: trimDraft.at } : now;
}

/** The removals as drawn: with a trim handle's drag applied. */
function shownRemoved(editor: EditorView): EditRange[] {
  return trimDraft ? trimRemoved(editor, trimDraft.edge, trimDraft.at) : editor.removed;
}

/** The removals with the recording's start or end trimmed to `at`: what was trimmed before goes, `at` takes its place. */
function trimRemoved(editor: EditorView, edge: TrimEdge, at: number): EditRange[] {
  const now = trimmed(editor);
  const kept = edge === "start"
    ? subtract(editor.removed, { from: 0, to: now.start, removed: true })
    : subtract(editor.removed, { from: now.end, to: editor.duration, removed: true });
  const range: EditRange | undefined = edge === "start" ? (at > 0 ? [0, at] : undefined) : (at < editor.duration ? [at, editor.duration] : undefined);
  return normalizeRanges(range ? [...kept, range] : kept);
}

/** Moves a trim handle while it is dragged or stepped, kept clear of the other one; the preview shows that frame. */
export function moveTrim(edge: TrimEdge, ticks: number): void {
  const editor = editorView();
  // A save under way does not stop it (keys pressed in quick turn): the handle's own save waits for that one.
  if (!editor || editor.state !== "ready" || editor.export.phase === "exporting") return;
  const now = trimmed(editor), gap = TRIM_GAP * editor.timescale;
  const at = Math.round(edge === "start" ? Math.max(0, Math.min(ticks, now.end - gap)) : Math.min(editor.duration, Math.max(ticks, now.start + gap)));
  trimDraft = { edge, at };
  rangeSelection = undefined;
  editorVideo?.pause();
  seekTo(at / editor.timescale);
  draw();
}

/** Saves where a trim handle was let go, as one change Undo takes back. */
export function commitTrim(): Promise<void> {
  return inTurn(commitTrimNow);
}

async function commitTrimNow(): Promise<void> {
  while (editorSaving) await saveDone;
  const draft = trimDraft;
  const editor = editorView();
  if (!draft || !editor) {
    trimDraft = undefined;
    draw();
    return;
  }
  const removed = trimRemoved(editor, draft.edge, draft.at);
  if (JSON.stringify(removed) === JSON.stringify(editor.removed)) {
    trimDraft = undefined;
    draw();
    return;
  }
  undoStack.push(current(editor));
  const saved = await save(removed);
  // A handle moved again while this saved (a key pressed in quick turn) keeps its new place, for its own save.
  if (trimDraft === draft) trimDraft = undefined;
  if (!saved) {
    undoStack.pop();
    draw();
    return;
  }
  redoStack.length = 0;
  draw();
  announce(translate(draft.edge === "start" ? "The export starts at {time}" : "The export ends at {time}", view?.language, { time: clock(draft.at / editor.timescale) }));
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

/** An editable recording's camera and volumes back to how the recording left them, as one change Undo takes back. */
export function resetScene(): Promise<boolean> {
  const editor = editorView();
  const recorded = editor?.editable?.recorded;
  if (!editor || !recorded || sameScene(editorScene(editor), recorded)) return Promise.resolve(false);
  return changeScene(recorded, true);
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

export function exportEdit(): Promise<boolean> {
  return send({ action: "export" });
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

export function revealExport(): Promise<boolean> {
  return send({ action: "reveal" });
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
