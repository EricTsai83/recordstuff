/**
 * Plan 075 step 2's preview page's only door: main hands it a message port that the capture process sends preview
 * frames on. The port is passed into the page's world with `window.postMessage`; nothing else is exposed.
 */
import { ipcRenderer } from "electron";

/** Kept in step with `CAMERA_PREVIEW_PORT_CHANNEL` (channels.test.ts); a sandboxed preload imports nothing at runtime. */
const CHANNEL = "camera-preview:port";

/** The page's `window`, which the preload's Node-typed build does not name. */
const page = globalThis as unknown as { postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void };

ipcRenderer.on(CHANNEL, (event) => {
  page.postMessage(CHANNEL, "*", event.ports);
});
