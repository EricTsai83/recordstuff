import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderWatch } from "./folder-watch";

class Handle extends EventEmitter { closed = false; close(): void { this.closed = true; } }

let dir: string;
let handles: Array<{ dir: string; handle: Handle; fire: () => void }>;
beforeEach(() => { vi.useFakeTimers(); dir = "/Movies/RecordStuff"; handles = []; });
afterEach(() => vi.useRealTimers());

function setup(fail?: string) {
  const changed = vi.fn(), log = vi.fn();
  const watch = new FolderWatch({
    dir: () => dir, changed, log, settleMs: 100, maxWaitMs: 1000,
    watch: (folder, listener) => {
      if (folder === fail) throw new Error("ENOENT");
      const handle = new Handle();
      handles.push({ dir: folder, handle, fire: listener });
      return handle as unknown as FSWatcher;
    },
  });
  return { watch, changed, log };
}

describe("the output folder's watch (plan 100)", () => {
  it("asks for one check once a burst of changes has settled", async () => {
    const { watch, changed } = setup();
    watch.start();
    for (let n = 0; n < 5; n++) { handles[0]!.fire(); await vi.advanceTimersByTimeAsync(50); }
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("checks at least every so often while events keep coming (Codex review)", async () => {
    const { watch, changed } = setup();
    watch.start();
    for (let n = 0; n < 30; n++) { handles[0]!.fire(); await vi.advanceTimersByTimeAsync(50); }
    expect(changed.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("watches the folder once, and the new one when it changes", () => {
    const { watch } = setup();
    watch.start();
    watch.start();
    expect(handles).toHaveLength(1);
    dir = "/Volumes/Drive/Recordings";
    watch.start();
    expect(handles.map((h) => [h.dir, h.handle.closed])).toEqual([["/Movies/RecordStuff", true], ["/Volumes/Drive/Recordings", false]]);
  });

  it("says once that a folder cannot be watched, and stops on an error, to start again later", () => {
    const { watch, log, changed } = setup("/Movies/RecordStuff");
    watch.start();
    watch.start();
    expect(log).toHaveBeenCalledTimes(1);
    dir = "/Other";
    watch.start();
    handles[0]!.handle.emit("error", new Error("gone"));
    expect(handles[0]!.handle.closed).toBe(true);
    // What changed while it was lost is checked at once (Codex review).
    expect(changed).toHaveBeenCalledTimes(1);
    watch.start();
    expect(handles).toHaveLength(2);
  });
});
