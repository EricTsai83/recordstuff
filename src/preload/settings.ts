/**
 * The settings panel's only door to main (docs/system-design/desktop.md):
 * read the current view, choose one offered option, arm the shortcut editor,
 * subscribe to pushes, say when the first content is painted, and watch the
 * camera preview, whose frames come on a port posted into the page.
 * No Node API and no generic IPC reaches the page.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { MicrophoneLevel, SettingsBridge, SettingsView, SettingsZoom, StudioLevels } from "../shared/settings-panel";

// Literal copies of `SETTINGS_CHANNELS` (channels.test.ts): a sandboxed preload imports nothing at runtime.

const bridge: SettingsBridge = {
  zoom: (request) => ipcRenderer.invoke("settings:zoom", request),
  onZoomChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, zoom: SettingsZoom): void => callback(zoom);
    ipcRenderer.on("settings:zoom-changed", listener);
    return () => ipcRenderer.removeListener("settings:zoom-changed", listener);
  },
  capture: (armed) => ipcRenderer.invoke("settings:capture", armed),
  read: () => ipcRenderer.invoke("settings:read"),
  choose: (group, choice) => ipcRenderer.invoke("settings:choose", group, choice),
  onChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, view: SettingsView): void => callback(view);
    ipcRenderer.on("settings:changed", listener);
    return () => ipcRenderer.removeListener("settings:changed", listener);
  },
  ready: () => ipcRenderer.invoke("settings:ready"),
  onHidden: (callback) => {
    const listener = (): void => callback();
    ipcRenderer.on("settings:hidden", listener);
    return () => ipcRenderer.removeListener("settings:hidden", listener);
  },
  watchCameraPreview: (watching) => ipcRenderer.invoke("settings:camera-preview", watching),
  watchLevels: (watching) => ipcRenderer.invoke("settings:watch-levels", watching),
  watchStudio: (open) => ipcRenderer.invoke("settings:watch-studio", open),
  onLevels: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, levels: StudioLevels): void => callback(levels);
    ipcRenderer.on("settings:levels", listener);
    return () => ipcRenderer.removeListener("settings:levels", listener);
  },
  watchMicrophoneLevel: (watching) => ipcRenderer.invoke("settings:watch-microphone-level", watching),
  onMicrophoneLevel: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, level: MicrophoneLevel): void => callback(level);
    ipcRenderer.on("settings:microphone-level", listener);
    return () => ipcRenderer.removeListener("settings:microphone-level", listener);
  },
};
contextBridge.exposeInMainWorld("settings", bridge);

/** The page's `window`, which the preload's Node-typed build does not name. */
const page = globalThis as unknown as { postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void };
// A port cannot cross the context bridge; it is posted into the page's world, as the prototype's preview page has it.
ipcRenderer.on("settings:camera-preview-port", (event) => {
  page.postMessage("settings:camera-preview-port", "*", event.ports);
});
