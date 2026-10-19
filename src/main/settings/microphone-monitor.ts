/**
 * Settings' microphone monitor (plan 079): while the Settings window is in sight and the microphone is on, a capture
 * process of its own follows the device list, so an input connected or removed appears or leaves without the window
 * being activated (D2), also while recording, where the input device switches the recording's microphone (D3); and,
 * between recordings, while the Recording tab shows the Input level and the window has focus, it reads the chosen input
 * as a recording would and passes its levels to the page (D1). The microphone turned off, a quit, or the window hidden
 * or closed ends the process; an attempt's process is never asked.
 */
import type { HostMessage, MicrophoneDevice } from "../../shared/protocol";
import { SETTINGS_CHANNELS, type MicrophoneLevel } from "../../shared/settings-panel";
import type { MonitorProcess } from "../recording/native-capture-host";

/** The page that shows the meter: Electron's `WebContents`, narrowed for tests. */
export interface MeterPage {
  isDestroyed(): boolean;
  send(channel: string, level: MicrophoneLevel): void;
}

export interface MicrophoneMonitorOptions {
  /** NativeCaptureHost.openMonitor. */
  open(onMessage: (message: HostMessage) => void, onExit: (detail: string) => void): MonitorProcess;
  /** The microphone is on and no quit runs. */
  allowed(): boolean;
  /** The input the meter reads when it may: nothing records, the microphone on and allowed; `undefined` otherwise. */
  meterDevice(): { deviceId?: string } | undefined;
  /** The inputs as the device list changed. */
  devices(devices: MicrophoneDevice[]): void;
  log(line: string): void;
}

/** Processes that ended on their own in a row before the monitor stops starting one until the window opens again. */
export const MONITOR_RETRIES = 3;

export class MicrophoneMonitor {
  private process: MonitorProcess | undefined;
  private open = false;
  private page: MeterPage | undefined;
  /** The meter's device as last asked of the process (`""` the default input), or `undefined`: not reading. */
  private reading: string | undefined;
  private exits = 0;

  constructor(private readonly options: MicrophoneMonitorOptions) {}

  /** The Settings window is in sight, or no longer is. */
  window(open: boolean): void {
    this.open = open;
    if (!open) this.exits = 0;
    this.sync();
  }

  /** The page shows the meter in a focused window, or `undefined`: none does. */
  watch(page: MeterPage | undefined): void {
    this.page = page;
    this.sync();
  }

  /** Follows the recording state, the window and the microphone setting: called whenever any changes. */
  sync(): void {
    if (!this.open || !this.options.allowed()) {
      this.close();
      return;
    }
    if (!this.process) {
      if (this.exits >= MONITOR_RETRIES) return;
      const process = this.options.open((message) => this.message(process, message), (detail) => this.exited(process, detail));
      this.process = process;
      this.reading = undefined;
      process.post({ type: "watchDevices", watching: true });
      this.options.log("microphone monitor: started");
    }
    const page = this.page && !this.page.isDestroyed() ? this.page : undefined;
    const device = page ? this.options.meterDevice() : undefined;
    const reading = device ? device.deviceId ?? "" : undefined;
    if (reading === this.reading) return;
    this.reading = reading;
    this.postMeter();
  }

  private postMeter(): void {
    const deviceId = this.reading;
    this.process?.post(deviceId === undefined ? { type: "meter", watching: false } : { type: "meter", watching: true, ...(deviceId ? { deviceId } : {}) });
  }

  private message(process: MonitorProcess, message: HostMessage): void {
    if (process !== this.process) return;
    switch (message.type) {
      case "microphones":
        if ("devices" in message) {
          this.options.devices(message.devices);
          // The chosen input may have come or gone, and the default changed: read what a recording would now.
          if (this.reading !== undefined) this.postMeter();
        } else this.options.log(`microphone monitor: the inputs could not be listed: ${message.error}`);
        return;
      case "meterStarted":
        this.options.log(`microphone monitor: reading ${message.device}`);
        return;
      case "meterLevel":
        if (this.reading !== undefined && this.page && !this.page.isDestroyed()) {
          this.page.send(SETTINGS_CHANNELS.microphoneLevel, { peak: message.peak, rms: message.rms });
        }
        return;
      case "meterStopped":
        // Read again when the device list changes or another input is chosen, not in a loop.
        this.options.log(`microphone monitor: the meter stopped: ${message.error}`);
        return;
      default:
        return;
    }
  }

  private exited(process: MonitorProcess, detail: string): void {
    if (process !== this.process) return;
    this.process = undefined;
    this.reading = undefined;
    this.exits += 1;
    this.options.log(`microphone monitor: ended on its own: ${detail}`);
  }

  private close(): void {
    const process = this.process;
    if (!process) return;
    this.process = undefined;
    this.reading = undefined;
    process.close();
    this.options.log("microphone monitor: stopped");
  }
}
