/**
 * The microphone and the camera are on by default (2026-10-26, the maintainer's decision). macOS is asked only at the
 * user's own press, in the first-launch guide or as a switch is turned on (actions.ts), and a refusal to that prompt
 * turns the switch back off. A refusal found later, made in System Settings, leaves the switch on (2026-11-01, the
 * maintainer's choice): the input is said to have no access where it is shown, and a recording leaves it out.
 */
import type { MicrophoneAccess } from "../permission/permission";

/** Access refused for good: only System Settings changes it. */
export function accessRefused(status: MicrophoneAccess | undefined): boolean {
  return status === "denied" || status === "restricted";
}
