/**
 * Waits until a promise chain stops growing: the chain behind `current()` and
 * every link appended while it was awaited. The stores that serialize their
 * writes (settings, window size) flush with it before quitting; `log.ts` keeps
 * its own copy of this loop because development scripts load it under Node.
 */
export async function drainQueue(current: () => Promise<unknown>): Promise<void> {
  let pending: Promise<unknown>;
  do { pending = current(); await pending; } while (pending !== current());
}
