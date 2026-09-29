import type { RecordingState } from "../shared/state";
import { preferencesUnlocked } from "./ui-model";

/**
 * Keeps the display and the system awake while a session runs (plan 050). An
 * idle display sleep or system sleep would end the capture, so one Electron
 * `prevent-display-sleep` blocker is held from `starting` until the state
 * settles; on macOS it also keeps idle system sleep away. A sleep the user asks
 * for cannot be refused: the Recorder stops and saves instead.
 */
export interface PowerBlocker {
  start(type: "prevent-display-sleep"): number;
  stop(id: number): void;
}

export class KeepAwake {
  private id: number | undefined;

  constructor(private readonly blocker: PowerBlocker, private readonly log: (message: string) => void) {}

  /**
   * Follows every Recorder state; a blocker that cannot start never affects the recording.
   * A session (its countdown, capture or save) exists exactly while preferences are locked.
   */
  update(state: RecordingState): void {
    if (preferencesUnlocked(state)) {
      this.release();
      return;
    }
    if (this.id !== undefined) return;
    try {
      this.id = this.blocker.start("prevent-display-sleep");
      this.log(`power: keeping the display awake (blocker ${this.id})`);
    } catch (error) {
      this.log(`power: could not keep the display awake (${String(error)})`);
    }
  }

  dispose(): void {
    this.release();
  }

  private release(): void {
    const id = this.id;
    if (id === undefined) return;
    this.id = undefined;
    try {
      this.blocker.stop(id);
      this.log(`power: display may sleep again (blocker ${id})`);
    } catch (error) {
      this.log(`power: could not release blocker ${id} (${String(error)})`);
    }
  }
}
