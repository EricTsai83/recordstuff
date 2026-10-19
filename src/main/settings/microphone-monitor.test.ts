import { describe, expect, it } from "vitest";
import type { HostMessage, MainMessage, MicrophoneDevice } from "../../shared/protocol";
import { SETTINGS_CHANNELS, type MicrophoneLevel } from "../../shared/settings-panel";
import { MONITOR_RETRIES, MicrophoneMonitor, type MeterPage } from "./microphone-monitor";

function rig() {
  const processes: Array<{ posted: MainMessage[]; closed: boolean; deliver: (message: HostMessage) => void; exit: (detail: string) => void }> = [];
  const state = { allowed: true, device: { deviceId: "usb" } as { deviceId?: string } | undefined };
  const listed: MicrophoneDevice[][] = [];
  const logs: string[] = [];
  const monitor = new MicrophoneMonitor({
    open: (onMessage, onExit) => {
      const process = { posted: [] as MainMessage[], closed: false, deliver: onMessage, exit: onExit };
      processes.push(process);
      return { post: (message) => process.posted.push(message), close: () => { process.closed = true; } };
    },
    allowed: () => state.allowed,
    meterDevice: () => state.device,
    devices: (devices) => listed.push(devices),
    log: (line) => logs.push(line),
  });
  const sent: Array<[string, MicrophoneLevel]> = [];
  const page: MeterPage = { isDestroyed: () => false, send: (channel, level) => sent.push([channel, level]) };
  return { monitor, processes, state, listed, logs, page, sent };
}

describe("MicrophoneMonitor (plan 079)", () => {
  it("follows the device list while the window is in sight and no quit runs, and ends its process otherwise", () => {
    const { monitor, processes, state } = rig();
    monitor.sync();
    expect(processes).toHaveLength(0);
    monitor.window(true);
    expect(processes).toHaveLength(1);
    expect(processes[0]!.posted).toEqual([{ type: "watchDevices", watching: true }]);
    // A quit begins.
    state.allowed = false;
    monitor.sync();
    expect(processes[0]!.closed).toBe(true);
    state.allowed = true;
    monitor.sync();
    expect(processes).toHaveLength(2);
    monitor.window(false);
    expect(processes[1]!.closed).toBe(true);
  });

  it("reads the chosen input only while a focused page shows the meter, again when the choice changes", () => {
    const { monitor, processes, state, page, sent } = rig();
    monitor.window(true);
    const process = processes[0]!;
    monitor.watch(page);
    expect(process.posted.at(-1)).toEqual({ type: "meter", watching: true, deviceId: "usb" });
    monitor.sync();
    expect(process.posted).toHaveLength(2);
    process.deliver({ type: "meterLevel", peak: 0.5, rms: 0.25 });
    expect(sent).toEqual([[SETTINGS_CHANNELS.microphoneLevel, { peak: 0.5, rms: 0.25 }]]);
    // The system default chosen.
    state.device = {};
    monitor.sync();
    expect(process.posted.at(-1)).toEqual({ type: "meter", watching: true });
    // A recording starts, the microphone is turned off, or its access is missing: the device list is still followed.
    state.device = undefined;
    monitor.sync();
    expect(process.posted.at(-1)).toEqual({ type: "meter", watching: false });
    expect(process.closed).toBe(false);
    process.deliver({ type: "meterLevel", peak: 0.5, rms: 0.25 });
    expect(sent).toHaveLength(1);
    // The window lost focus.
    state.device = { deviceId: "usb" };
    monitor.watch(page);
    monitor.watch(undefined);
    expect(process.posted.at(-1)).toEqual({ type: "meter", watching: false });
  });

  it("passes a changed device list on and reads what a recording would now", () => {
    const { monitor, processes, page, listed } = rig();
    monitor.window(true);
    monitor.watch(page);
    const process = processes[0]!;
    const devices = [{ id: "usb", name: "USB Microphone", default: false }];
    process.deliver({ type: "microphones", devices });
    expect(listed).toEqual([devices]);
    expect(process.posted.slice(-2)).toEqual([{ type: "meter", watching: true, deviceId: "usb" }, { type: "meter", watching: true, deviceId: "usb" }]);
    // A stopped meter waits for the next change rather than starting again at once.
    process.deliver({ type: "meterStopped", error: "the device is gone" });
    monitor.sync();
    expect(process.posted).toHaveLength(3);
  });

  it("starts a process that ended on its own again, at most a few times while the window stays open", () => {
    const { monitor, processes } = rig();
    monitor.window(true);
    for (let exit = 0; exit < MONITOR_RETRIES; exit += 1) {
      processes.at(-1)!.exit("it exited with 3");
      monitor.sync();
    }
    expect(processes).toHaveLength(MONITOR_RETRIES);
    // Opening the window again tries again.
    monitor.window(false);
    monitor.window(true);
    expect(processes).toHaveLength(MONITOR_RETRIES + 1);
    // A message from a process since replaced is not heard.
    processes[0]!.deliver({ type: "meterLevel", peak: 1, rms: 1 });
  });
});
