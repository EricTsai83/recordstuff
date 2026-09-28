/**
 * Capture-host preload: the only job is to hand the MessagePort from main to
 * the page (docs/system-design/recording.md). Runs sandboxed; no API is exposed to the renderer.
 */
import { ipcRenderer } from "electron";

// The preload is compiled with Node types only; this is the one DOM call it makes.
declare const window: {
  postMessage(message: unknown, targetOrigin: string, transfer?: readonly unknown[]): void;
};

// Literal copies of `CAPTURE_HOST_PORT_CHANNEL` (channels.test.ts): a sandboxed preload imports nothing at runtime.
ipcRenderer.on("capture-host-port", (event) => {
  // `window.postMessage` from the isolated world is delivered to the page's
  // `message` event; the port is transferred, not copied.
  window.postMessage("capture-host-port", "*", event.ports);
});
