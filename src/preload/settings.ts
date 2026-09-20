/**
 * The settings panel's only door to main (docs/system-design/desktop.md):
 * read the current view, choose one offered option, and subscribe to pushes.
 * No Node API and no generic IPC reaches the page.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { SettingsBridge, SettingsView } from "../shared/settings-panel";

const bridge: SettingsBridge = {
  read: () => ipcRenderer.invoke("settings:read"),
  choose: (group, choice) => ipcRenderer.invoke("settings:choose", group, choice),
  onChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, view: SettingsView): void => callback(view);
    ipcRenderer.on("settings:changed", listener);
    return () => ipcRenderer.removeListener("settings:changed", listener);
  },
};
contextBridge.exposeInMainWorld("settings", bridge);
