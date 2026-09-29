/**
 * Waits until a promise chain stops growing: the chain behind `current()` and
 * every link appended while it was awaited. The stores that serialize their
 * writes (settings, window size, log) flush with it before quitting.
 */
export async function drainQueue(current: () => Promise<unknown>): Promise<void> {
  let pending: Promise<unknown>;
  do { pending = current(); await pending; } while (pending !== current());
}
