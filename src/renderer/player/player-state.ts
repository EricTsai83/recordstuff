import type { PlaybackState } from "../../shared/video-player";

export function playbackOf(video: HTMLVideoElement): PlaybackState {
  return {
    time: video.currentTime || 0,
    playing: !video.paused && !video.ended,
    volume: video.volume,
    muted: video.muted,
  };
}
