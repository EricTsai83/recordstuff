import { describe, expect, it, vi } from "vitest";
import type { DisplayInfo, DisplayPreference } from "../shared/display";
import { DisplayMedia } from "./display-media";

const main: DisplayInfo = { id: "1", label: "Built-in", logicalWidth: 1512, logicalHeight: 982, scaleFactor: 2, internal: true, primary: true };
const side: DisplayInfo = { id: "2", label: "Studio", logicalWidth: 2560, logicalHeight: 1440, scaleFactor: 2, internal: false, primary: false };

function setup(preference: DisplayPreference = { kind: "primary" }) {
  let current = preference;
  const getSources = vi.fn(async () => [{ display_id: "1" }, { display_id: "2" }]);
  const changed = vi.fn();
  const media = new DisplayMedia({
    platform: "darwin", preference: () => current, displays: () => [main, side], primaryDisplayId: () => "1",
    getSources, changed, log: () => undefined,
  });
  const answer = (owns = true) => new Promise<{ display_id: string } | undefined>((resolve) => media.answer(() => owns, resolve));
  return { media, getSources, changed, answer, choose: (next: DisplayPreference) => { current = next; } };
}

describe("display-media ownership", () => {
  it("grants the attempt's display and fails the recording only when that display disconnects", async () => {
    const x = setup({ kind: "display", id: "2", label: "Studio" });
    x.media.begin("s1");
    expect(await x.answer()).toEqual({ display_id: "2" });
    expect(x.media.topologyChanged(["1", "2"])).toBe(false);
    expect(x.media.topologyChanged(["1"])).toBe(true);
    x.media.settle();
    expect(x.media.topologyChanged([])).toBe(false);
  });

  it("gives no source to a request it does not own, before an attempt or after it settles", async () => {
    const x = setup();
    expect(await x.answer()).toBeUndefined();
    x.media.begin("s1");
    expect(await x.answer(false)).toBeUndefined();
    x.media.settle();
    expect(await x.answer()).toBeUndefined();
    expect(x.getSources).not.toHaveBeenCalled();
  });

  it("a new attempt settles the previous attempt's pending request without a source", async () => {
    const x = setup();
    x.getSources.mockReturnValueOnce(new Promise(() => undefined));
    x.media.begin("s1");
    const stale = x.answer();
    x.media.begin("s2");
    expect(await stale).toBeUndefined();
    expect(await x.answer()).toEqual({ display_id: "1" });
  });

  it("keeps the choice an attempt began with", async () => {
    const x = setup({ kind: "display", id: "2", label: "Studio" });
    x.media.begin("s1");
    x.choose({ kind: "primary" });
    expect(await x.answer()).toEqual({ display_id: "2" });
  });
});

describe("refusals", () => {
  it("explains the next explainable host error once with the real cause", async () => {
    const x = setup({ kind: "display", id: "9", label: "Gone" });
    x.media.begin("s1");
    expect(await x.answer()).toBeUndefined();
    expect(x.media.failure).toBe("target_missing");
    expect(x.changed).toHaveBeenCalledOnce();
    expect(x.media.explain("capture_start_failed")).toBe("display_unavailable");
    expect(x.media.explain("capture_start_failed")).toBe("capture_start_failed");
  });

  it("never rewrites an error the refusal cannot explain", async () => {
    const x = setup();
    x.getSources.mockRejectedValueOnce(new Error("TCC"));
    x.media.begin("s1");
    await x.answer();
    expect(x.media.explain("output_write_failed")).toBe("output_write_failed");
    expect(x.media.failure).toBeUndefined();
  });

  it("a later grant clears an earlier refusal of the same attempt", async () => {
    const x = setup();
    x.getSources.mockRejectedValueOnce(new Error("TCC"));
    x.media.begin("s1");
    await x.answer();
    expect(await x.answer()).toEqual({ display_id: "1" });
    expect(x.media.explain("permission_denied")).toBe("permission_denied");
  });
});
