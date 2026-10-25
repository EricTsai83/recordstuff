/**
 * The microphone and the camera are on by default (2026-10-26, the maintainer's decision), and an input macOS refuses
 * is turned off rather than left on to fail the next recording. macOS is asked only at the user's own press, in the
 * first-launch guide or as a switch is turned on (actions.ts); at launch an input it refused earlier is turned off here.
 * Elsewhere there is no answer to read.
 */
import type { MicrophoneAccess } from "../permission/permission";

export interface InputAccess {
  /** For the log: "microphone" or "camera". */
  name: string;
  /** The input's switch is on (and, for the camera, there is one to record). */
  enabled(): boolean;
  /** macOS's answer now; undefined where there is none to read. */
  status(): MicrophoneAccess | undefined;
  /** Saves the input's switch off; false when it could not be changed now (a recording holds it). */
  turnOff(): Promise<boolean>;
}

/** Access refused for good: only System Settings changes it. */
export function accessRefused(status: MicrophoneAccess | undefined): boolean {
  return status === "denied" || status === "restricted";
}

/** Turns off each input that is on and refused, asking nothing. Never rejects. */
export async function settleInputAccess(inputs: readonly InputAccess[], log: (line: string) => void): Promise<void> {
  for (const input of inputs) {
    try {
      if (!input.enabled() || !accessRefused(input.status())) continue;
      log(`settings: ${input.name} access is not allowed: ${await input.turnOff() ? "turned off" : "left out of the recording in progress"}`);
    } catch (cause) {
      log(`settings: settling ${input.name} access failed: ${String(cause)}`);
    }
  }
}
