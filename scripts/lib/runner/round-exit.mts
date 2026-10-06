/**
 * How a desktop runner's round ends, in one order shared by the runners (2026-10-05):
 *
 * 1. Something the round owned is still running, or its cleanup could not be confirmed: fail (1), whatever else
 *    happened. The next round must not start over it, so neither a lock nor an interrupt may hide it.
 * 2. Interrupted (Ctrl-C or SIGTERM) and nothing left: 130 or 143, as a shell reports a command it stopped.
 * 3. The screen locked: blocked (2), even when a case failed, since the lock may be why it failed.
 * 4. A case failed: fail (1). A missing prerequisite or a case that could not run does not hide a real failure.
 * 5. Something else blocked the round (a prerequisite, a case that could not run): blocked (2). Otherwise pass (0).
 */
import { DESKTOP_BLOCKED_EXIT } from "./desktop-session.mts";
import { INTERRUPT_EXIT } from "./processes.mts";

export type RoundOutcome = "pass" | "fail" | "blocked" | "interrupted";

export interface RoundExitInput {
  cleanupIncomplete: boolean;
  interrupted?: keyof typeof INTERRUPT_EXIT | undefined;
  /** The session locked during the round. */
  locked: boolean;
  failed: boolean;
  /** A prerequisite was missing or a case could not run; outranked by a failure. */
  blocked?: boolean;
}

export function roundExit(input: RoundExitInput): { outcome: RoundOutcome; code: number } {
  if (input.cleanupIncomplete) return { outcome: "fail", code: 1 };
  if (input.interrupted) return { outcome: "interrupted", code: INTERRUPT_EXIT[input.interrupted] };
  if (input.locked) return { outcome: "blocked", code: DESKTOP_BLOCKED_EXIT };
  if (input.failed) return { outcome: "fail", code: 1 };
  return input.blocked ? { outcome: "blocked", code: DESKTOP_BLOCKED_EXIT } : { outcome: "pass", code: 0 };
}
