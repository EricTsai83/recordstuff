/**
 * Capture-host preload: the only job is to hand the MessagePort from main to
 * the page (plans/001-first-version.md §9). Runs sandboxed; no API is exposed to the renderer.
 */
import { ipcRenderer } from "electron";

// The preload is compiled with Node types only; this is the one DOM call it makes.
declare const window: {
  postMessage(message: unknown, targetOrigin: string, transfer?: readonly unknown[]): void;
};

ipcRenderer.on("capture-host-port", (event) => {
  // `window.postMessage` from the isolated world is delivered to the page's
  // `message` event; the port is transferred, not copied.
  window.postMessage("capture-host-port", "*", event.ports);
});
