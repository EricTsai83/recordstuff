/**
 * A recording played full screen in a window of its own (2026-10-05, docs/system-design/desktop.md). The page's
 * own fullscreen had to grow RecordStuff's window to the screen first, so the window grew and shrank around the
 * video; this window covers the screen over it, fades in once its first frame is drawn and fades out, and the
 * player carries on from where it ended. Shared by main, the player's page and the fullscreen page, so it has no
 * Electron or DOM import.
 */

/** Where a video is and what it does: handed to the fullscreen window and handed back when it ends. */
export interface PlaybackState {
  /** Seconds from the start. */
  time: number;
  playing: boolean;
  /** 0 to 1. */
  volume: number;
  muted: boolean;
}

/** The player's request, sent with `choose("recordingFile:<id>", …)`; main answers when the fullscreen ends. */
export interface FullScreenChoice {
  action: "fullscreen";
  state: PlaybackState;
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

/** The fullscreen page's two messages; the preload spells them out (channels.test.ts). */
export const VIDEO_CHANNELS = {
  /** The first frame at the starting time is drawn: the window may fade in. */
  ready: "video:ready",
  /** The viewer left (Escape, a double-click or the exit button), with where the video is now. */
  exit: "video:exit",
} as const;

/** Query parameters the fullscreen page is loaded with. */
export const VIDEO_QUERY = { src: "src", time: "t", playing: "play", volume: "vol", muted: "mute", language: "lang", title: "title" } as const;

export const VIDEO_TIMING = {
  /** The window's fade in and out. */
  fadeMs: 150,
  /** A page that never reports its first frame (a file it cannot decode) is shown after this, to be left again. */
  readyTimeoutMs: 2000,
  /** The player's controls and the pointer hide after the pointer has rested this long while a video plays. */
  idleMs: 2000,
} as const;

/** What the fullscreen preload exposes. */
export interface VideoBridge {
  ready(): void;
  exit(state: PlaybackState): void;
}
