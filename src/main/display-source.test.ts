import { afterEach, describe, expect, it, vi } from "vitest";
import type { DisplayInfo, DisplayPreference } from "../shared/display";
import { DisplayRequest, resolveDisplayPreference, selectScreenSource } from "./display-source";
const display: DisplayInfo = { id: "1", label: "Same name", logicalWidth: 100, logicalHeight: 100, scaleFactor: 2, internal: true, primary: true };
const explicit: DisplayPreference = { kind: "display", id: "1", label: "Same name" };
const primary: DisplayPreference = { kind: "primary" };
const source = { display_id: "1" };
const resolve = (preference: DisplayPreference = explicit, displays = [display]) => resolveDisplayPreference({ displays, primaryDisplayId: "1", preference });
afterEach(() => vi.useRealTimers());
describe("display resolution", () => {
  it("requires one exact id, never name/size or list order", () => {
    expect(resolve()).toMatchObject({ ok: true, id: "1" });
    expect(resolve(explicit, [{ ...display, id: "2" }])).toEqual({ ok: false, detail: "target_missing" });
    expect(resolve(explicit, [display, display])).toMatchObject({ ok: false });
    expect(resolve(explicit, [{ ...display, id: "2" }, { ...display, id: "3" }])).toMatchObject({ ok: false });
  });
  it("preserves primary fallback and applies explicit empty-source precedence", () => {
    for (const sources of [[], [{ display_id: "" }], [source, source]]) {
      expect(selectScreenSource({ preference: explicit, resolution: resolve(), sources })).toMatchObject({ ok: false, code: "display_unavailable" });
    }
    expect(selectScreenSource({ preference: primary, resolution: resolve(primary), sources: [] })).toMatchObject({ ok: false, code: "no_display" });
    expect(selectScreenSource({ preference: primary, resolution: resolve(primary), sources: [{ display_id: "" }] })).toMatchObject({ ok: true, rule: "first" });
    expect(selectScreenSource({ preference: primary, resolution: resolve(primary), sources: [{ display_id: "2" }, source] })).toMatchObject({ ok: true, source, rule: "primary" });
  });
});
function setup(preference = explicit, platform: NodeJS.Platform = "darwin") {
  let generation = 0;
  let displays = [display];
  const getSources = vi.fn(async () => [source]);
  const selected = vi.fn(); const denied = vi.fn(); const callback = vi.fn();
  const request = new DisplayRequest({ preference, platform, snapshot: () => ({ generation, displays, primaryDisplayId: "1" }), getSources, selected, denied });
  return { request, callback, getSources, selected, denied, change: (next = displays) => { generation++; displays = next; } };
}
describe("bounded request lifetime", () => {
  it("rejects definitely missing targets without enumeration", async () => {
    const x = setup(); x.change([]); await x.request.run(x.callback);
    expect(x.getSources).not.toHaveBeenCalled(); expect(x.denied).toHaveBeenCalledWith("display_unavailable", "target_missing", 1);
  });
  it("retries a transient missing source then grants once", async () => {
    vi.useFakeTimers(); const x = setup(); x.getSources.mockResolvedValueOnce([]);
    const run = x.request.run(x.callback); await vi.runAllTimersAsync(); await run;
    expect(x.getSources).toHaveBeenCalledTimes(2); expect(x.callback).toHaveBeenCalledExactlyOnceWith(source);
  });
  it("bounds source and topology retries to three attempts", async () => {
    vi.useFakeTimers();
    for (const [topology, platform, code] of [[true, "darwin", "display_unavailable"], [false, "win32", "display_unavailable"], [false, "darwin", "permission_denied"]] as const) {
      const x = setup(explicit, platform); x.getSources.mockImplementation(async () => { if (topology) x.change(); return topology ? [source] : []; });
      const run = x.request.run(x.callback); await vi.runAllTimersAsync(); await run;
      expect(x.getSources).toHaveBeenCalledTimes(3); expect(x.callback).toHaveBeenCalledTimes(1);
      expect(x.denied).toHaveBeenCalledWith(code, topology ? "topology_changed" : "source_missing", 3);
    }
  });
  it("reports a macOS capture that lists no screen at all as a permission problem, not a missing display (plan 035 D2)", async () => {
    for (const [platform, code] of [["darwin", "permission_denied"], ["win32", "no_display"]] as const) {
      const x = setup(primary, platform); x.getSources.mockResolvedValue([]);
      await x.request.run(x.callback);
      expect(x.getSources).toHaveBeenCalledTimes(1);
      expect(x.denied).toHaveBeenCalledExactlyOnceWith(code, "source_missing", 1);
      expect(x.callback).toHaveBeenCalledExactlyOnceWith(undefined);
    }
    // No display connected at all is still a missing display, not a permission problem.
    const none = setup(primary); none.change([]); none.getSources.mockResolvedValue([]);
    await none.request.run(none.callback);
    expect(none.denied).toHaveBeenCalledExactlyOnceWith("no_display", "source_missing", 1);
    // A source list without the primary display still falls back to the first source.
    const other = setup(primary); other.getSources.mockResolvedValue([{ display_id: "2" }]);
    await other.request.run(other.callback);
    expect(other.selected).toHaveBeenCalledTimes(1);
  });
  it("rechecks topology and exact target after enumeration", async () => {
    const x = setup(); x.getSources.mockImplementation(async () => { x.change([]); return [source]; });
    await x.request.run(x.callback); expect(x.selected).not.toHaveBeenCalled(); expect(x.denied).toHaveBeenCalledWith("display_unavailable", "target_missing", 1);
  });
  it.each([primary, explicit])("cancels hung enumeration and ignores late results after a new start: %j", async (preference) => {
    const x = setup(preference); let complete!: (s: typeof source[]) => void;
    x.getSources.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const run = x.request.run(x.callback); x.request.cancel();
    expect(x.callback).toHaveBeenCalledTimes(1);
    const next = setup(preference); await next.request.run(next.callback);
    complete([source]); await run;
    expect(x.callback).toHaveBeenCalledExactlyOnceWith(undefined); expect(x.selected).not.toHaveBeenCalled(); expect(x.denied).not.toHaveBeenCalled();
    expect(next.selected).toHaveBeenCalledTimes(1);
  });
  it("cancels retry timers and ignores late enumeration errors", async () => {
    vi.useFakeTimers(); const x = setup(); x.getSources.mockResolvedValue([]);
    const run = x.request.run(x.callback); await vi.advanceTimersByTimeAsync(1); x.request.cancel(); await run;
    expect(vi.getTimerCount()).toBe(0); expect(x.getSources).toHaveBeenCalledTimes(1);
    const late = setup(); let reject!: (e: Error) => void;
    late.getSources.mockImplementation(() => new Promise((_resolve, r) => { reject = r; }));
    const pending = late.request.run(late.callback); late.request.cancel(); reject(new Error("denied")); await pending;
    expect(late.denied).not.toHaveBeenCalled(); expect(late.callback).toHaveBeenCalledTimes(1);
  });
  it.each(["darwin", "linux"] as const)("does not retry exceptions, preserving %s mapping", async (platform) => {
    const x = setup(explicit, platform); x.getSources.mockRejectedValue(new Error("permission"));
    await x.request.run(x.callback); expect(x.getSources).toHaveBeenCalledTimes(1);
    expect(x.denied).toHaveBeenCalledWith(platform === "darwin" ? "permission_denied" : "no_display", "source_missing", 1);
  });
});
