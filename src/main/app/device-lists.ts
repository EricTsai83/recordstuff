import type { CameraDevice, MicrophoneDevice } from "../../shared/protocol";
import { SerialQueue } from "../lib/serial-queue";

export interface DeviceListsDeps {
  /** The engine's listings (native-capture-host.ts); each asks `allowed` again once its process is ready. */
  listMicrophones(allowed: () => boolean): Promise<readonly MicrophoneDevice[]>;
  listCameras(allowed: () => boolean): Promise<readonly CameraDevice[]>;
  /** Whether a listing may run: never while a session runs (plan 074). */
  allowed(): boolean;
  /** Whether the engine records a camera on this platform (plan 075). */
  cameraAvailable(): boolean;
  /** What the lists or the search show changed: the UI draws again. */
  changed(): void;
  log(message: string): void;
}

/**
 * The audio inputs and cameras the engine listed last (plans 074, 075 D9, 079 D2), for the Input device and Camera
 * device menus. Refreshed when Settings comes forward and when an input is turned on, never while a session runs, and at
 * most one listing of each kind at a time: a second request waits for the one in flight. The host lists one kind at a
 * time and a newer listing ends the one in flight, so the kinds take turns, and one that fails leaves the next its turn.
 */
export class DeviceLists {
  microphones: readonly MicrophoneDevice[] | undefined;
  cameras: readonly CameraDevice[] | undefined;
  /** Settings' Search for devices is running: its button reads Searching…. */
  searching = false;
  private readonly turns = new SerialQueue();
  private listingMicrophones: Promise<void> | undefined;
  private listingCameras: Promise<void> | undefined;

  constructor(private readonly deps: DeviceListsDeps) {}

  refreshMicrophones(): Promise<void> {
    if (this.listingMicrophones) return this.listingMicrophones;
    if (!this.deps.allowed()) return Promise.resolve();
    return this.listingMicrophones = this.inTurn(() => this.deps.listMicrophones(() => this.deps.allowed()).then(
      (devices) => { this.microphones = devices; },
      (cause: unknown) => this.deps.log(`microphone: the inputs could not be listed: ${describe(cause)}`),
    )).finally(() => { this.listingMicrophones = undefined; this.deps.changed(); });
  }

  refreshCameras(): Promise<void> {
    if (this.listingCameras) return this.listingCameras;
    if (!this.deps.cameraAvailable() || !this.deps.allowed()) return Promise.resolve();
    return this.listingCameras = this.inTurn(() => this.deps.listCameras(() => this.deps.allowed()).then(
      (devices) => { this.cameras = devices; },
      (cause: unknown) => this.deps.log(`camera: the cameras could not be listed: ${describe(cause)}`),
    )).finally(() => { this.listingCameras = undefined; this.deps.changed(); });
  }

  /** Both kinds, as Settings comes forward. */
  refresh(): void {
    void this.refreshMicrophones();
    void this.refreshCameras();
  }

  /** Settings' Search for devices (plan 079, D2): lists the inputs at once, its button busy meanwhile. */
  async search(): Promise<void> {
    if (this.searching || !this.deps.allowed()) return;
    this.searching = true;
    this.deps.log("microphone: searching for devices");
    this.deps.changed();
    try { await this.refreshMicrophones(); }
    finally { this.searching = false; this.deps.changed(); }
  }

  /** The inputs Settings' monitor process saw change (plan 079). */
  setMicrophones(devices: readonly MicrophoneDevice[]): void {
    this.microphones = devices;
    this.deps.changed();
  }

  private inTurn(list: () => Promise<void>): Promise<void> {
    // A listing that fails is its own caller's to report; the next one still takes its turn.
    return this.turns.run(list);
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
