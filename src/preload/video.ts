/**
 * The fullscreen video page's only door to main (src/shared/video-player.ts): say when its first frame is drawn,
 * and leave with where the video is. No Node API and no generic IPC reaches the page.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { PlaybackState, VideoBridge } from "../shared/video-player";

// Literal copies of `VIDEO_CHANNELS` (channels.test.ts): a sandboxed preload imports nothing at runtime.
const bridge: VideoBridge = {
  ready: () => { void ipcRenderer.invoke("video:ready"); },
  exit: (state: PlaybackState) => { void ipcRenderer.invoke("video:exit", state); },
};
contextBridge.exposeInMainWorld("video", bridge);
