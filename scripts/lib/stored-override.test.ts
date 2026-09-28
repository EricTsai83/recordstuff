import { describe, expect, it } from "vitest";
import { StoredOverride } from "./stored-override.mts";

/** A fake app and settings file: `running` is whether a process could still hold the value in memory. */
function harness(options: { quitFails?: boolean; relaunchFails?: "before start" | "after start" } = {}) {
  const events: string[] = [];
  let running = true;
  let stored = false;
  const override = new StoredOverride<boolean>({
    quit: async () => {
      events.push("quit");
      if (options.quitFails) throw new Error("not idle");
      running = false;
    },
    running: () => running,
    write: (value) => { events.push(`write ${value}`); if (running) events.push("(written while running)"); stored = value; },
    relaunch: async () => {
      events.push("relaunch");
      if (options.relaunchFails === "before start") throw new Error("open failed");
      running = true;
      if (options.relaunchFails === "after start") throw new Error("never became idle");
    },
  }, false, true);
  return { override, events, state: () => ({ running, stored }), stop: () => { running = false; } };
}

describe("stored override (plan 046 review)", () => {
  it("writes the round's value only while the app is quit, and sets it back after the final quit", async () => {
    const h = harness();
    await h.override.apply();
    expect(h.events).toEqual(["quit", "write true", "relaunch"]);
    expect(h.override.pending).toBe(true);
    h.stop();
    expect(await h.override.restore(false)).toBeUndefined();
    expect(h.state()).toEqual({ running: false, stored: false });
    expect(h.events).not.toContain("(written while running)");
    expect(await h.override.restore(false)).toBeUndefined();
    expect(h.events.filter((e) => e === "write false")).toHaveLength(1);
  });

  it("does not restore while the app still runs after a failed final quit, and says why", async () => {
    const h = harness();
    await h.override.apply();
    expect(await h.override.restore(false)).toMatch(/still running/);
    expect(h.state().stored).toBe(true);
    expect(h.override.pending).toBe(true);
  });

  it("quits the app it relaunched before restoring when setup fails after the relaunch", async () => {
    const h = harness();
    await h.override.apply();
    expect(await h.override.restore(true)).toBeUndefined();
    expect(h.events.slice(-2)).toEqual(["quit", "write false"]);
    expect(h.state()).toEqual({ running: false, stored: false });
  });

  it.each(["before start", "after start"] as const)("restores after a relaunch that failed %s", async (when) => {
    const h = harness({ relaunchFails: when });
    await expect(h.override.apply()).rejects.toThrow();
    expect(h.override.pending).toBe(true);
    expect(await h.override.restore(true)).toBeUndefined();
    expect(h.state()).toEqual({ running: false, stored: false });
    expect(h.events).not.toContain("(written while running)");
  });

  it("changes nothing when the first quit fails", async () => {
    const h = harness({ quitFails: true });
    await expect(h.override.apply()).rejects.toThrow("not idle");
    expect(h.override.pending).toBe(false);
    expect(h.events).toEqual(["quit"]);
    expect(await h.override.restore(true)).toBeUndefined();
    expect(h.state().stored).toBe(false);
  });

  it("returns why a quit during restore failed and leaves the value pending", async () => {
    let running = true;
    let quits = 0;
    const override = new StoredOverride<boolean>({
      quit: async () => { quits += 1; if (quits > 1) throw new Error("recording"); running = false; },
      running: () => running,
      write: () => undefined,
      relaunch: async () => { running = true; },
    }, false, true);
    await override.apply();
    expect(await override.restore(true)).toMatch(/could not be quit \(Error: recording\)/);
    expect(override.pending).toBe(true);
  });
});
