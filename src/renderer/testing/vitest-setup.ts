/** Runs in every Vitest file (vitest.config.ts); only files with a DOM environment have anything to end. */
import { afterAll, vi } from "vitest";

afterAll(async () => {
  if (typeof window === "undefined") return;
  // A page's root unmounts on pagehide (lib/mount-root.ts), as when its window closes.
  window.dispatchEvent(new Event("pagehide"));
  // React's scheduler runs passive effects on a later setImmediate, and its callback reads `window.event` first: a few
  // turns of the event loop let it run while the DOM still exists, not after the environment is torn down.
  vi.useRealTimers();
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
});
