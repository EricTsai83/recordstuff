/**
 * A recording played full screen in a window of its own (2026-10-05, docs/system-design/desktop.md). The page's
 * own fullscreen had to grow RecordStuff's window to the screen first, so the window grew and shrank around the
 * video; this window covers the screen over it, fades in once its first frame is drawn and fades out, and the
 * player carries on from where it ended. Shared by main, the player's page and the fullscreen page, so it has no
 * Electron or DOM import.
 */
import { isEditScene, type EditableSound, type EditScene } from "./editable";
import type { EditRange } from "./editing";

/** Where a video is and what it does: handed to the fullscreen window and handed back when it ends. */
export interface PlaybackState {
  /** Seconds from the start. */
  time: number;
  playing: boolean;
  /** 0 to 1. */
  volume: number;
  muted: boolean;
}

/**
 * A length or a position as `1:05`, or `1:02:05` past an hour; an unknown one reads `0:00`. Whole seconds are counted
 * down, as a player's time is, so a card's length and its player's total read the same.
 */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const two = (n: number): string => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * The player's request, sent with `choose("recordingFile:<id>", …)`; main answers when the fullscreen ends. `edited`
 * from the edit view (2026-10-27): the viewer plays the recording's open edit as the preview does (`PlaybackEdit`),
 * which main takes from its own edit, never from the page.
 */
export interface FullScreenChoice {
  action: "fullscreen";
  state: PlaybackState;
  edited?: boolean;
}

/**
 * An edit for the full-screen viewer to play as the edit view's preview plays it (2026-10-27): the ranges the export
 * leaves out, in the video's timescale, and an editable recording's scene with its preview tracks' URLs. Main's own,
 * built from the edit it holds open.
 */
export interface PlaybackEdit {
  timescale: number;
  /** The recording's length in its timescale. */
  duration: number;
  frameRate: number;
  skipped: EditRange[];
  editable?: {
    sounds: EditableSound[];
    camera?: { rounding: number; mirror: boolean };
    scene: EditScene;
    preview: { camera?: string; secondSound?: string };
  };
}

/** At most as many skipped ranges as an edit record holds, both its own and its plan's joins. */
const MAX_SKIPPED = 512;
const PREVIEW_URL = /^recordstuff-media:\/\/preview\/\d+\/(camera|secondSound)$/;

/** An edit from another process, or undefined: every number finite, every range ordered, every URL a preview's. */
export function playbackEdit(value: unknown): PlaybackEdit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { timescale, duration, frameRate, skipped, editable } = value as Record<string, unknown>;
  const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (!positive(timescale) || !positive(duration) || !positive(frameRate)) return undefined;
  if (!Array.isArray(skipped) || skipped.length > MAX_SKIPPED) return undefined;
  const ranges: EditRange[] = [];
  for (const range of skipped) {
    if (!Array.isArray(range) || range.length !== 2) return undefined;
    const [from, to] = range as unknown[];
    if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) return undefined;
    ranges.push([from, to]);
  }
  const edit: PlaybackEdit = { timescale, duration, frameRate, skipped: ranges };
  if (editable === undefined) return edit;
  if (!editable || typeof editable !== "object") return undefined;
  const { sounds, camera, scene, preview } = editable as Record<string, unknown>;
  if (!Array.isArray(sounds) || sounds.length > 2 || !sounds.every((sound) => sound === "system" || sound === "microphone" || sound === "silent")) return undefined;
  if (!isEditScene(scene)) return undefined;
  let shape: { rounding: number; mirror: boolean } | undefined;
  if (camera !== undefined) {
    const { rounding, mirror } = (camera ?? {}) as Record<string, unknown>;
    if (typeof rounding !== "number" || !Number.isFinite(rounding) || rounding < 0 || rounding > 1 || typeof mirror !== "boolean") return undefined;
    shape = { rounding, mirror };
  }
  if (!preview || typeof preview !== "object") return undefined;
  const urls: { camera?: string; secondSound?: string } = {};
  for (const track of ["camera", "secondSound"] as const) {
    const url = (preview as Record<string, unknown>)[track];
    if (url === undefined) continue;
    if (typeof url !== "string" || !PREVIEW_URL.test(url)) return undefined;
    urls[track] = url;
  }
  return { ...edit, editable: { sounds: sounds as EditableSound[], ...(shape ? { camera: shape } : {}), scene, preview: urls } };
}

/** A state from another process, or undefined: numbers finite and in range, flags boolean. */
export function playbackState(value: unknown): PlaybackState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { time, playing, volume, muted } = value as Record<string, unknown>;
  if (typeof time !== "number" || !Number.isFinite(time) || time < 0) return undefined;
  if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 1) return undefined;
  if (typeof playing !== "boolean" || typeof muted !== "boolean") return undefined;
  return { time, playing, volume, muted };
}

export function isFullScreenChoice(value: unknown): value is FullScreenChoice {
  return Boolean(value && typeof value === "object" && (value as { action?: unknown }).action === "fullscreen"
    && playbackState((value as { state?: unknown }).state));
}

/** The fullscreen page's messages; the preload spells them out (channels.test.ts). */
export const VIDEO_CHANNELS = {
  /** Main to a page loaded in standby: the recording to play, as a page loaded for it reads from its query. */
  load: "video:load",
  /** The first frame at the starting time is drawn: the window may fade in. */
  ready: "video:ready",
  /** The viewer left (Escape, ⌘W, a double-click, F or the exit button), with where the video is now. */
  exit: "video:exit",
} as const;

/** Query parameters the fullscreen page is loaded with. */
export const VIDEO_QUERY = { src: "src", time: "t", playing: "play", volume: "vol", muted: "mute", language: "lang", title: "title", standby: "standby", edit: "edit" } as const;

/** What a page loaded in standby is sent to play; main's own values, never a page's. */
export interface VideoLoad {
  src: string;
  state: PlaybackState;
  language: string;
  title?: string;
  /** From the edit view: the edit, played as its preview plays it. */
  edit?: PlaybackEdit;
}

/** A load from another process, or undefined. */
export function videoLoad(value: unknown): VideoLoad | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { src, state, language, title, edit } = value as Record<string, unknown>;
  const playback = playbackState(state);
  if (typeof src !== "string" || !src || !playback || typeof language !== "string") return undefined;
  if (title !== undefined && typeof title !== "string") return undefined;
  const played = edit === undefined ? undefined : playbackEdit(edit);
  if (edit !== undefined && !played) return undefined;
  return { src, state: playback, language, ...(title ? { title } : {}), ...(played ? { edit: played } : {}) };
}

export const VIDEO_TIMING = {
  /** The window's fade in and out. */
  fadeMs: 150,
  /** A page that never reports its first frame (a file it cannot decode) is shown after this, to be left again. */
  readyTimeoutMs: 2000,
  /** The player's controls and the pointer hide after the pointer has rested this long while a video plays. */
  idleMs: 2000,
  /** After the player's window opens, or a full screen ends, before a page is loaded hidden for the next one. */
  standbyDelayMs: 1000,
} as const;

/** What the fullscreen preload exposes. */
export interface VideoBridge {
  ready(): void;
  exit(state: PlaybackState): void;
  /** A page loaded in standby hears here what to play; main sends it once, if at all. Returns the unsubscribe. */
  onLoad(listener: (load: unknown) => void): () => void;
}
