import { describe, expect, it } from "vitest";
import { captureExclusion, type Protectable } from "./capture-exclusion";

class FakeWindow implements Protectable {
  protected = false;
  destroyed = false;
  isDestroyed(): boolean { return this.destroyed; }
  setContentProtection(enable: boolean): void {
    if (this.destroyed) throw new Error("used after destroy");
    this.protected = enable;
  }
}

function setup(open: FakeWindow[]) {
  const listeners = new Set<(window: FakeWindow) => void>();
  const exclude = captureExclusion({
    windows: () => open,
    onCreated: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  });
  const create = (): FakeWindow => {
    const window = new FakeWindow();
    for (const listener of listeners) listener(window);
    return window;
  };
  return { exclude, create, listeners };
}

describe("captureExclusion", () => {
  it("marks the open windows and every window created while excluded, and lets them all back in", () => {
    const settings = new FakeWindow();
    const { exclude, create, listeners } = setup([settings]);
    exclude(true);
    const countdown = create();
    expect([settings.protected, countdown.protected]).toEqual([true, true]);
    exclude(false);
    expect([settings.protected, countdown.protected, listeners.size]).toEqual([false, false, 0]);
    expect(create().protected).toBe(false);
  });

  it("skips a destroyed window and leaves a window destroyed during the session alone", () => {
    const gone = Object.assign(new FakeWindow(), { destroyed: true });
    const { exclude, create } = setup([gone]);
    exclude(true);
    const overlay = create();
    overlay.destroyed = true;
    expect(() => exclude(false)).not.toThrow();
    expect(gone.protected).toBe(false);
  });

  it("excluding twice listens once, and letting in without excluding does nothing", () => {
    const { exclude, listeners } = setup([]);
    exclude(false);
    exclude(true);
    exclude(true);
    expect(listeners.size).toBe(1);
  });
});
