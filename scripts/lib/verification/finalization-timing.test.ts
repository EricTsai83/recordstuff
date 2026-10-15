import { describe, expect, it } from "vitest";
import { EARLY_STOP_TEXT } from "../../../src/shared/session-record.ts";
import { distribution, finalizationSample, parseByteSize, parseFinalizeTiming } from "./finalization-timing.mts";

const TIMING = "recorder: session s1 finalize timing: host 12 ms, writes 1 ms, flush 40 ms, close 0 ms, publish 580 ms by copy, cleanup 2 ms; 614400000 bytes";

describe("finalize timing line", () => {
  it("reads every phase, the method and the byte count", () => {
    expect(parseFinalizeTiming(TIMING)).toEqual({
      session: "s1", hostMs: 12, writesMs: 1, flushMs: 40, closeMs: 0, publishMs: 580, method: "copy", cleanupMs: 2, bytes: 614400000,
    });
  });

  it("reads the checkpoint, and leaves it out of lines logged before it existed", () => {
    expect(parseFinalizeTiming(TIMING.replace("cleanup 2 ms;", "cleanup 2 ms, checkpoint 9 ms;"))).toEqual({
      session: "s1", hostMs: 12, writesMs: 1, flushMs: 40, closeMs: 0, publishMs: 580, method: "copy", cleanupMs: 2, checkpointMs: 9, bytes: 614400000,
    });
    expect(parseFinalizeTiming(TIMING)).not.toHaveProperty("checkpointMs");
    expect(parseFinalizeTiming("recorder: session s1 finalize timing: host 9 ms, writes 0 ms, flush 30 ms, close 0 ms, publish 1 ms by link, cleanup 3 ms (temporary name kept: EPERM), checkpoint 4 ms; 10 bytes"))
      .toMatchObject({ cleanupError: "EPERM", checkpointMs: 4, bytes: 10 });
    // A session whose sentinel was never written logs no checkpoint time.
    expect(parseFinalizeTiming(TIMING.replace("cleanup 2 ms;", "cleanup 2 ms, checkpoint ? ms;"))).not.toHaveProperty("checkpointMs");
  });

  it("keeps why a file was copied instead of linked", () => {
    expect(parseFinalizeTiming("recorder: session s1 finalize timing: host 9 ms, writes 0 ms, flush 30 ms, close 0 ms, publish 1400 ms by copy (link ENOTSUP), cleanup 3 ms; 10 bytes"))
      .toMatchObject({ method: "copy", linkError: "ENOTSUP", publishMs: 1400, cleanupMs: 3, bytes: 10 });
  });

  it("keeps why the temporary name was left behind", () => {
    expect(parseFinalizeTiming("recorder: session s1 finalize timing: host 9 ms, writes 0 ms, flush 30 ms, close 0 ms, publish 1400 ms by copy (link ENOTSUP), cleanup 3 ms (temporary name kept: EPERM); 10 bytes"))
      .toMatchObject({ method: "copy", linkError: "ENOTSUP", cleanupMs: 3, cleanupError: "EPERM", bytes: 10 });
  });

  it("keeps an error without an errno code, whose message has spaces and parentheses", () => {
    expect(parseFinalizeTiming("recorder: session s1 finalize timing: host 9 ms, writes 0 ms, flush 30 ms, close 0 ms, publish 1400 ms by copy (link Operation not supported (os error 45)), cleanup 3 ms (temporary name kept: file is busy (locked)), checkpoint 2 ms; 10 bytes"))
      .toMatchObject({ method: "copy", linkError: "Operation not supported (os error 45)", cleanupMs: 3, cleanupError: "file is busy (locked)", checkpointMs: 2, bytes: 10 });
  });

  it("reads the finalize phase the recorder logs since plan 076, plain or kept fragmented", () => {
    const line = (finalize: string) => `recorder: session s9 finalize timing: host 4 ms, writes 0 ms, flush 0 ms, ${finalize}, close 1 ms, publish 2 ms by link, cleanup 0 ms, checkpoint 3 ms; 5000 bytes`;
    expect(parseFinalizeTiming(line("finalize 21 ms to plain MP4"))).toEqual({
      session: "s9", hostMs: 4, writesMs: 0, flushMs: 0, finalizeMs: 21, closeMs: 1, publishMs: 2, method: "link", cleanupMs: 0, checkpointMs: 3, bytes: 5000,
    });
    expect(parseFinalizeTiming(line("finalize 3 ms kept fragmented (index write failed (EIO))"))).toMatchObject({ finalizeMs: 3, fragmented: "index write failed (EIO)", closeMs: 1 });
    expect(parseFinalizeTiming(line("finalize ? ms ?"))).toMatchObject({ flushMs: 0, closeMs: 1 });
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
      stopToReadyMs: 643, stopToSavedMs: 640, uiMs: 3, path: "/v/a b.mp4", stoppedEarly: false, publishMs: 580, method: "copy",
    });
  });

  it("marks every early stop the app can name without taking its note into the path", () => {
    expect(finalizationSample(run("/v/a.mp4 (stopped early: disk almost full)"))).toMatchObject({ path: "/v/a.mp4", stoppedEarly: true });
    for (const text of Object.values(EARLY_STOP_TEXT)) {
      expect(finalizationSample(run(`/v/a.mp4 (stopped early: ${text})`)), text).toMatchObject({ path: "/v/a.mp4", stoppedEarly: true });
    }
  });

  it("pairs a stop with a save that comes after idle, as background saves and the native engine do (plan 076)", () => {
    expect(finalizationSample([
      "[2026-10-15T10:00:15.000Z] state → stopping",
      "[2026-10-15T10:00:15.010Z] recorder: session n1 host stopped; tracksStoppedAt=1",
      "[2026-10-15T10:00:15.011Z] state → idle",
      "[2026-10-15T10:00:15.030Z] capture host: engine finished 9000 bytes 20 ms after the stop, plain MP4",
      "[2026-10-15T10:00:15.034Z] recorder: session n1 file finalized /v/n.mp4",
      "[2026-10-15T10:00:15.034Z] recorder: session n1 finalize timing: host 10 ms, writes 0 ms, flush 0 ms, finalize 19 ms to plain MP4, close 1 ms, publish 2 ms by link, cleanup 0 ms, checkpoint 1 ms; 9000 bytes",
    ])).toEqual({
      session: "n1", hostMs: 10, writesMs: 0, flushMs: 0, finalizeMs: 19, closeMs: 1, publishMs: 2, method: "link", cleanupMs: 0, checkpointMs: 1, bytes: 9000,
      stopToReadyMs: 11, stopToSavedMs: 34, engineFinishMs: 20, path: "/v/n.mp4", stoppedEarly: false,
    });
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
