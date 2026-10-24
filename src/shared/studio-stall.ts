/**
 * Plan 084's development switch, `RECORDSTUFF_STUDIO_STALL=<at>,<for>` in seconds: once the Studio's page has held a
 * port for `at` seconds, the capture process asks it to stop for `for` (studio-port.ts `StudioStallRequest`), its main
 * thread held as a stalled renderer or a long garbage collection would hold it, so what grows while a page draws nothing
 * can be measured. Main, the capture process and the recorded apps go on; without the switch nothing is ever asked.
 * Without imports, so the measuring scripts read it under node.
 */
export const STUDIO_STALL_ENV = "RECORDSTUFF_STUDIO_STALL";
/** The longest stall asked for. */
export const STUDIO_STALL_MAX_MS = 120_000;

/** The switch's value read: when, from the port's joining, and for how long, in ms; nothing when unset or malformed. */
export function studioStallOf(value: string | undefined): { atMs: number; forMs: number } | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(value ?? "");
  if (!match) return undefined;
  const atMs = Math.round(Number(match[1]) * 1000), forMs = Math.round(Number(match[2]) * 1000);
  return atMs <= 600_000 && forMs > 0 && forMs <= STUDIO_STALL_MAX_MS ? { atMs, forMs } : undefined;
}
