import { describe, expect, it } from "vitest";
import { distribution, finalizationSample, parseByteSize, parseFinalizeTiming } from "./finalization-timing.mts";

const TIMING = "recorder: session s1 finalize timing: host 12 ms, writes 1 ms, flush 40 ms, close 0 ms, publish 580 ms by copy, cleanup 2 ms; 614400000 bytes";

describe("finalize timing line", () => {
  it("reads every phase, the method and the byte count", () => {
    expect(parseFinalizeTiming(TIMING)).toEqual({
      session: "s1", hostMs: 12, writesMs: 1, flushMs: 40, closeMs: 0, publishMs: 580, method: "copy", cleanupMs: 2, bytes: 614400000,
    });
  });

  it("keeps why a file was copied instead of linked", () => {
    expect(parseFinalizeTiming("recorder: session s1 finalize timing: host 9 ms, writes 0 ms, flush 30 ms, close 0 ms, publish 1400 ms by copy (link ENOTSUP), cleanup 3 ms; 10 bytes"))
      .toMatchObject({ method: "copy", linkError: "ENOTSUP", publishMs: 1400, cleanupMs: 3, bytes: 10 });
  });

  it("leaves unknown phases out and ignores other lines", () => {
    expect(parseFinalizeTiming("recorder: session s1 finalize timing: host ? ms, writes 0 ms, flush ? ms, close ? ms, publish ? ms by ?, cleanup ? ms; ? bytes"))
      .toEqual({ session: "s1", writesMs: 0 });
    expect(parseFinalizeTiming("recorder: session s1 file finalized /x.mp4")).toBeUndefined();
  });
});

describe("one run's sample", () => {
  const run = (finalized: string) => [
    "[2026-09-27T10:00:00.000Z] state → recording",
    "[2026-09-27T10:00:15.000Z] state → stopping",
    "[2026-09-27T10:00:15.012Z] recorder: session s1 host stopped; tracksStoppedAt=1",
    `[2026-09-27T10:00:15.640Z] recorder: session s1 file finalized ${finalized}`,
    `[2026-09-27T10:00:15.640Z] ${TIMING}`,
    "[2026-09-27T10:00:15.643Z] state → idle",
    "[2026-09-27T10:00:15.643Z] autorecord: saved /v/a.mp4",
  ];

  it("measures stop to ready from the state lines and keeps the phases", () => {
    expect(finalizationSample(run("/v/a b.mp4"))).toMatchObject({
      stopToReadyMs: 643, uiMs: 3, path: "/v/a b.mp4", stoppedEarly: false, publishMs: 580, method: "copy",
    });
  });

  it("marks a low-disk early stop without taking its note into the path", () => {
    expect(finalizationSample(run("/v/a.mp4 (stopped early: disk almost full)"))).toMatchObject({ path: "/v/a.mp4", stoppedEarly: true });
  });

  it("has no sample when the stop ended in a failure", () => {
    expect(finalizationSample([
      "[2026-09-27T10:00:15.000Z] state → stopping",
      "[2026-09-27T10:00:16.000Z] recorder: session s1 failed: disk_full publication",
      "[2026-09-27T10:00:16.001Z] state → idle",
    ])).toBeUndefined();
  });
});

describe("distribution", () => {
  it("uses nearest-rank percentiles", () => {
    expect(distribution([5, 1, 3])).toEqual({ n: 3, min: 1, p50: 3, p95: 5, max: 5 });
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(distribution(twenty)).toMatchObject({ p50: 10, p95: 19, max: 20 });
    expect(distribution([])).toBeUndefined();
  });
});

describe("byte sizes", () => {
  it("reads binary units and plain bytes, and refuses anything else", () => {
    expect(parseByteSize("64m")).toBe(64 * 1024 ** 2);
    expect(parseByteSize("2G")).toBe(2 * 1024 ** 3);
    expect(parseByteSize("1.5g")).toBe(1.5 * 1024 ** 3);
    expect(parseByteSize("4096")).toBe(4096);
    for (const bad of ["", "0", "-1m", "2t", "m", "1e9"]) expect(parseByteSize(bad)).toBeUndefined();
  });
});
