/** The embedded player: which recording plays, its error, and the hand-off to and back from full screen. */
import type { LibraryItemView } from "../../../shared/settings-panel";
import type { FullScreenChoice, PlaybackState } from "../../../shared/video-player";
import { playbackOf } from "../../player/player-state";
import { announce, clearFeedback, draw, focus, render, text } from "./core";
import { forgetMenu } from "./library";

export let playingItem: LibraryItemView | undefined;
export let playerError = "";
export let playerVideo: HTMLVideoElement | null = null;
export let fullScreenPending = false;
let hideCount = 0;
let escapeClosed = -Infinity;
export const settlingEscape = (): boolean => {
  const elapsed = performance.now() - escapeClosed;
  return elapsed >= 0 && elapsed < 1000;
};
export function attachVideo(video: HTMLVideoElement | null): void {
  playerVideo = video;
}
/** Plays `item`, from `start` seconds when given (where its card's hover preview had reached). */
export function openPlayer(item: LibraryItemView, start?: number): void {
  forgetMenu();
  playingItem = item;
  playerError = "";
  clearFeedback();
  draw();
  // The source was set by the render above; a position set before its metadata is where playback starts.
  if (start !== undefined && playerVideo) playerVideo.currentTime = start;
  playerVideo?.focus();
  void playerVideo?.play().catch(() => {});
}
export function closePlayer(restore = true): void {
  const id = playingItem?.id;
  playerVideo?.pause();
  playerVideo?.removeAttribute("src");
  playerVideo?.load();
  playingItem = undefined;
  draw();
  if (restore && id) focus(`clip-${id}-open`);
}
export function playerFailed(): void {
  if (!playingItem || !playerVideo?.getAttribute("src")) return;
  playerError = text(
    "This recording cannot be played here. Choose Open from its ⋯ menu to play it in another app.",
  );
  announce(playerError);
}
export function markEscapeClosed(): void {
  escapeClosed = performance.now();
}
/** The window was hidden: playback pauses, and a full-screen hand-off still pending comes back paused. */
export function playerHidden(): void {
  hideCount++;
  playerVideo?.pause();
}
export async function playFullScreen(): Promise<void> {
  const item = playingItem,
    video = playerVideo;
  if (!item || !video || fullScreenPending) return;
  const state = playbackOf(video);
  fullScreenPending = true;
  video.pause();
  draw();
  let end: PlaybackState = { ...state, playing: false };
  const hides = hideCount;
  try {
    const result = await window.settings.choose(`recordingFile:${item.id}`, {
      action: "fullscreen",
      state,
    } satisfies FullScreenChoice);
    render(result.view);
    end = result.playback ?? end;
  } catch {
    /* No viewer opened: retain the paused handoff state. */
  } finally {
    fullScreenPending = false;
    draw();
  }
  if (playingItem?.id !== item.id || playerVideo !== video) return;
  if (hideCount !== hides) end = { ...end, playing: false };
  markEscapeClosed();
  video.volume = end.volume;
  video.muted = end.muted;
  video.currentTime = end.time;
  if (end.playing) void video.play().catch(() => {});
  video.focus({ preventScroll: true });
}
