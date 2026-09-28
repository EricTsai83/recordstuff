import { beforeEach, expect, it, vi } from "vitest";
import { COUNTDOWN_VALUE_CHANNEL } from "../shared/countdown";
import { CAPTURE_HOST_PORT_CHANNEL } from "../shared/protocol";
import { SETTINGS_CHANNELS } from "../shared/settings-panel";

/** Each sandboxed preload spells its channels out; these pin them to the constants main uses. */
const electron = vi.hoisted(() => ({ used: new Set<string>(), exposed: {} as Record<string, any> }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { electron.exposed[key] = api; } },
  ipcRenderer: {
    invoke: async (channel: string) => { electron.used.add(channel); },
    on: (channel: string) => { electron.used.add(channel); },
    removeListener: (channel: string) => { electron.used.add(channel); },
  },
}));
beforeEach(() => { electron.used.clear(); vi.resetModules(); });

it("settings preload uses exactly the settings channels main handles and sends", async () => {
  await import("./settings");
  const bridge = electron.exposed.settings;
  await bridge.capture(true); await bridge.read(); await bridge.choose("hotkey", "off");
  bridge.onChanged(() => {})();
  expect([...electron.used].sort()).toEqual(Object.values(SETTINGS_CHANNELS).sort());
});

it("countdown preload subscribes to the channel the overlay sends on", async () => {
  await import("./countdown");
  electron.exposed.countdown.onValue(() => {});
  expect([...electron.used]).toEqual([COUNTDOWN_VALUE_CHANNEL]);
});

it("capture-host preload listens for the port on the channel main posts it to", async () => {
  await import("./index");
  expect([...electron.used]).toEqual([CAPTURE_HOST_PORT_CHANNEL]);
});
