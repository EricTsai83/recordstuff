import { beforeEach, expect, it, vi } from "vitest";
import { COUNTDOWN_VALUE_CHANNEL } from "../shared/countdown";
import { CAPTURE_HOST_PORT_CHANNEL } from "../shared/protocol";
import { SETTINGS_CHANNELS } from "../shared/settings-panel";
import { VIDEO_CHANNELS } from "../shared/video-player";

/** Each sandboxed preload spells its channels out; these pin them to the constants main uses. */
const electron = vi.hoisted(() => ({ used: new Set<string>(), exposed: {} as Record<string, any>,
  listeners: new Map<string, (event: { ports: unknown[] }) => void>() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { electron.exposed[key] = api; } },
  ipcRenderer: {
    invoke: async (channel: string) => { electron.used.add(channel); },
    on: (channel: string, listener: (event: { ports: unknown[] }) => void) => { electron.used.add(channel); electron.listeners.set(channel, listener); },
    removeListener: (channel: string) => { electron.used.add(channel); },
  },
}));
beforeEach(() => { electron.used.clear(); electron.listeners.clear(); vi.resetModules(); });

it("settings preload uses exactly the settings channels main handles and sends", async () => {
  await import("./settings");
  const bridge = electron.exposed.settings;
  await bridge.capture(true); await bridge.read(); await bridge.choose("hotkey", "off"); await bridge.ready();
  bridge.onChanged(() => {})();
  bridge.onHidden(() => {})();
  await bridge.zoom("in");
  bridge.onZoomChanged(() => {})();
  expect([...electron.used].sort()).toEqual(Object.values(SETTINGS_CHANNELS).sort());
});

it("fullscreen video preload uses exactly the channels main handles for it", async () => {
  await import("./video");
  const bridge = electron.exposed.video;
  bridge.ready(); bridge.exit({ time: 1, playing: false, volume: 1, muted: false }); bridge.onLoad(() => {});
  expect([...electron.used].sort()).toEqual(Object.values(VIDEO_CHANNELS).sort());
});

it("countdown preload subscribes to the channel the overlay sends on", async () => {
  await import("./countdown");
  electron.exposed.countdown.onValue(() => {});
  expect([...electron.used]).toEqual([COUNTDOWN_VALUE_CHANNEL]);
});

it("capture-host preload listens for the port on the channel main posts it to, and hands it on under the name the page waits for", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("window", { postMessage });
  try {
    await import("./index");
    expect([...electron.used]).toEqual([CAPTURE_HOST_PORT_CHANNEL]);
    // The page's startup listener matches this message against the same constant; a drifted copy would leave every recording unready.
    const port = {};
    electron.listeners.get(CAPTURE_HOST_PORT_CHANNEL)!({ ports: [port] });
    expect(postMessage).toHaveBeenCalledWith(CAPTURE_HOST_PORT_CHANNEL, "*", [port]);
  } finally { vi.unstubAllGlobals(); }
});
