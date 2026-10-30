/**
 * The governor of versions prepared alongside a recording (plan 100 step 4): preparing never costs a recording a
 * picture. It decides from what main knows (a recording, a Live preview, a save, the system's heat and Low Power Mode)
 * and from the recording's health, which the capture process sends once a second (core/health.rs), whether a version
 * prepared ahead is held at its next picture now, and whether it keeps the encoder to one picture at a time.
 *
 * - A Live preview, a save, serious or critical heat and Low Power Mode hold it while they last.
 * - A recording holds it for its whole length where the Mac's class has not passed the measured gate (`pause`). Where it
 *   has (`governed`), it holds it until `CLEAN_SECONDS` clean seconds in a row, from the recording's start and again from
 *   any second with a late or lost picture or more than one picture in the encoder, so it does not flap. A recording's
 *   end always lets go of what it held, whatever the last samples said.
 */
import type { HealthSample } from "../../shared/protocol";

/** Clean seconds in a row before a version held for a recording's health goes on (plan 100: 10 s, so it does not flap). */
export const CLEAN_SECONDS = 10;

/** How versions are paced during a recording on this Mac: by its health once its class passed the gate, else held. */
export type PacePolicy = "governed" | "pause";

/**
 * Mac classes, by chip name as `os.cpus()` gives it, that passed the gate (plan 100 step 4): a recording at 30 and 60
 * fps, with and without the camera, while a 10-minute Video was prepared, lost no more pictures than the same recording
 * alone, its sync unchanged. Every other Mac holds versions for a recording's whole length. None for now: the M1 Pro,
 * the only class measured (2026-10-30), is kept held by the maintainer's decision (plans/100-share-recordings.md, step 4).
 */
export const GOVERNED_CLASSES: readonly string[] = [];

export function pacePolicy(platform: NodeJS.Platform, chip: string | undefined): PacePolicy {
  return platform === "darwin" && chip !== undefined && GOVERNED_CLASSES.includes(chip.trim()) ? "governed" : "pause";
}

/** What main knows of what is going on. */
export interface Conditions {
  /** A recording, from its countdown until capture stopped. */
  recording: boolean;
  /** A Live preview, whose picture the person is watching. */
  preview: boolean;
  /** A recording's file still being finished after capture stopped. */
  saving: boolean;
  /** The system's thermal state, as Electron's powerMonitor says it. */
  thermal: "unknown" | "nominal" | "fair" | "serious" | "critical";
  lowPower: boolean;
}

export interface Pace {
  /** Why versions prepared ahead are held now; absent when they run. */
  held?: string;
  /** One picture in the encoder at a time: while a recording runs. */
  careful: boolean;
}

/** Whether a second of a recording lost nothing: no late or lost picture, at most one in the encoder. */
export function clean(sample: HealthSample): boolean {
  return sample.late === 0 && sample.lost === 0 && sample.backlog <= 1;
}

export class Governor {
  private conditions: Conditions = { recording: false, preview: false, saving: false, thermal: "unknown", lowPower: false };
  /** Clean seconds in a row of the recording that runs. */
  private cleanSeconds = 0;
  private current: Pace = { careful: false };
  /** The running recording's health so far, said once it ends: what the gate's evidence reads. */
  private seen = { seconds: 0, unclean: 0, late: 0, lost: 0, backlog: 0 };

  constructor(private readonly deps: { policy: PacePolicy; changed: (pace: Pace) => void; log: (message: string) => void }) {}

  get pace(): Pace {
    return this.current;
  }

  /** What changed of what main knows. */
  update(changed: Partial<Conditions>): void {
    const was = this.conditions.recording;
    this.conditions = { ...this.conditions, ...changed };
    if (this.conditions.recording !== was) {
      this.cleanSeconds = 0;
      const { seconds, unclean, late, lost, backlog } = this.seen;
      if (was && seconds > 0) this.deps.log(`versions: the recording's health: ${unclean} of ${seconds} s lost time (${late} late, ${lost} lost, at most ${backlog} in the encoder)`);
      this.seen = { seconds: 0, unclean: 0, late: 0, lost: 0, backlog: 0 };
    }
    this.decide();
  }

  /** One second of the running recording's health. */
  sample(sample: HealthSample): void {
    if (!this.conditions.recording) return;
    this.seen = { seconds: this.seen.seconds + 1, unclean: this.seen.unclean + (clean(sample) ? 0 : 1), late: this.seen.late + sample.late,
      lost: this.seen.lost + sample.lost, backlog: Math.max(this.seen.backlog, sample.backlog) };
    if (clean(sample)) {
      this.cleanSeconds += 1;
    } else {
      if (this.cleanSeconds >= CLEAN_SECONDS || !this.current.held) {
        this.deps.log(`versions: the recording lost time (${sample.late} late, ${sample.lost} lost, ${sample.backlog} in the encoder); holding versions`);
      }
      this.cleanSeconds = 0;
    }
    this.decide();
  }

  private held(): string | undefined {
    const { recording, preview, saving, thermal, lowPower } = this.conditions;
    if (preview) return "a Live preview";
    if (recording && this.deps.policy === "pause") return "a recording";
    if (recording && this.cleanSeconds < CLEAN_SECONDS) return "a recording's health";
    if (saving) return "a recording being saved";
    if (thermal === "serious" || thermal === "critical") return `the system's heat (${thermal})`;
    if (lowPower) return "Low Power Mode";
    return undefined;
  }

  private decide(): void {
    const held = this.held();
    const next: Pace = { ...(held ? { held } : {}), careful: this.conditions.recording };
    if (next.held === this.current.held && next.careful === this.current.careful) return;
    if (next.held !== this.current.held) this.deps.log(next.held ? `versions: held (${next.held})` : `versions: going on (${this.current.held} is over)`);
    this.current = next;
    this.deps.changed(next);
  }
}
