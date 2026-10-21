import type { RecordingState } from "../../shared/state";
import { preferencesUnlocked } from "./recording-lock";

/**
 * Keeps the machine awake while a recording needs it (plan 050). An idle display sleep or system sleep would end the
 * capture, so one Electron `prevent-display-sleep` blocker is held from `starting` until the session settles; on
 * every platform it keeps idle system sleep away as well as the display's. A recording that is still being saved after
 * its session ended (in the background since 2026-10-09) holds `prevent-app-suspension` instead: the display may
 * sleep, but idle system sleep would drop a network volume mid-write. A sleep the user asks for cannot be refused: the
 * Recorder stops and saves instead.
 */
export type BlockerType = "prevent-display-sleep" | "prevent-app-suspension";

export interface PowerBlocker {
  start(type: BlockerType): number;
  stop(id: number): void;
}

export class KeepAwake {
  private held: { id: number; type: BlockerType } | undefined;

  constructor(private readonly blocker: PowerBlocker, private readonly log: (message: string) => void) {}

  /**
   * Follows every Recorder state and change to its background saves; a blocker that cannot start never affects the
   * recording. A session (its countdown or capture) exists exactly while preferences are locked.
   */
  update(state: RecordingState, saving: number): void {
    const wanted: BlockerType | undefined = !preferencesUnlocked(state) ? "prevent-display-sleep"
      : saving > 0 ? "prevent-app-suspension" : undefined;
    if (this.held?.type === wanted) return;
    const previous = this.held;
    // The new blocker starts before the old one stops, so the machine is never left unguarded between them. One that
    // cannot start leaves the old one held (either keeps idle system sleep away) and is tried again at the next update.
    if (wanted) {
      try {
        this.held = { id: this.blocker.start(wanted), type: wanted };
        this.log(`power: ${wanted === "prevent-display-sleep" ? "keeping the display awake" : "keeping the system awake for a save"} (blocker ${this.held.id})`);
      } catch (error) {
        this.log(`power: could not start ${wanted} (${String(error)})`);
        return;
      }
    } else this.held = undefined;
    if (previous) this.release(previous);
  }

  dispose(): void {
    const held = this.held;
    this.held = undefined;
    if (held) this.release(held);
  }

  private release({ id, type }: { id: number; type: BlockerType }): void {
    try {
      this.blocker.stop(id);
      this.log(`power: ${type === "prevent-display-sleep" ? "display" : "system"} may sleep again (blocker ${id})`);
    } catch (error) {
      this.log(`power: could not release blocker ${id} (${String(error)})`);
    }
  }
}
