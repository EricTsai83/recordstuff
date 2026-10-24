/**
 * The edit view (plan 085): which recording is being cut, the timeline's parts, the selection and Undo. Main owns the
 * edit (the removed ranges it saved, snapped to frames by the engine) and the export; the page keeps only what has
 * not been saved: where the timeline was split without removing anything, the selected part, and the ranges each
 * change replaced, for Undo. Every change is saved at once, as one choice on `recordingEdit:<id>`.
 */
import type { LibraryItemView } from "../../../shared/settings-panel";
import { normalizeRanges, type EditorChoice, type EditorView, type EditRange } from "../../../shared/editing";
import { translate } from "../../../shared/i18n";
import { announce, draw, focus, render, view } from "./core";
import { forgetMenu } from "./library";

export let editingItem: LibraryItemView | undefined;
export let editorVideo: HTMLVideoElement | null = null;
/** Where the timeline was split without a removal on either side, in the video's timescale. */
let splits: number[] = [];
/** The selected part, by where it starts. */
export let selectedFrom: number | undefined;
/** The removed ranges each saved change replaced, newest last. */
const undoStack: EditRange[][] = [];
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

export function canUndo(): boolean {
  return undoStack.length > 0 && !editorSaving;
}

/** Opens the edit view for `item`. */
export async function openEditor(item: LibraryItemView): Promise<void> {
  forgetMenu();
  editingItem = item;
  splits = [];
  selectedFrom = undefined;
  undoStack.length = 0;
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
  undoStack.length = 0;
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
  editorVideo = video;
  // Chromium has it; a page test's DOM may not.
  if (video && typeof video.requestVideoFrameCallback === "function") watchFrames(video);
}

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

/** Selects the part at `from` (the video's timescale) and moves the playhead to its start. */
export function selectPart(part: TimelinePart, seek = true): void {
  selectedFrom = part.from;
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
  splits = [...splits, at];
  selectedFrom = at;
  announce(translate("Split at {time}", view?.language, { time: clock(at / editor.timescale) }));
  draw();
}

/** Removes the selected part, or keeps it again when it was removed. */
export async function toggleSelected(): Promise<void> {
  const editor = editorView();
  if (!editor || editor.state !== "ready" || editorSaving || editor.export.phase === "exporting") return;
  const part = selectedPart(editor);
  if (!part) return;
  const removed = part.removed ? subtract(editor.removed, part) : normalizeRanges([...editor.removed, [part.from, part.to]]);
  undoStack.push(editor.removed.map(([from, to]): EditRange => [from, to]));
  const saved = await save(removed);
  if (!saved) undoStack.pop();
  else announce(translate(part.removed ? "Kept {from} to {to}" : "Removed {from} to {to}", view?.language, {
    from: clock(part.from / editor.timescale), to: clock(part.to / editor.timescale),
  }));
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

export async function undoEdit(): Promise<void> {
  const editor = editorView();
  if (!editor || editor.state !== "ready" || editorSaving || editor.export.phase === "exporting") return;
  const previous = undoStack.pop();
  if (!previous) return;
  if (await save(previous)) announce(translate("Undone", view?.language));
  else undoStack.push(previous);
}

async function save(removed: EditRange[]): Promise<boolean> {
  const editor = editorView();
  if (!editor) return false;
  editorSaving = true;
  draw();
  try {
    return await send({ action: "save", removed, revision: editor.revision });
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
