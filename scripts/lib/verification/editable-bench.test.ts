import { describe, expect, it } from "vitest";
import { figures, judge, judgeMix, problems, type BenchTrack, type Mode, type Run } from "./editable-bench.mts";

const track = (kind: string, bytes: number, enabled: boolean, seconds = 60): BenchTrack => ({ descriptions: [kind], samples: kind === "avc1" ? 1800 : 2813, bytes, seconds, enabled });
const run = (mode: Mode, engineCpu: number, residentBytes: number, round = 1): Run => ({
  mode, round, engineCpu, encoderCpu: 3, residentBytes,
  line: {
    mode, seconds: 60, fileBytes: mode === "direct" ? 24e6 : 32e6, fragmented: false, cameraLost: 0, failures: [],
    tracks: mode === "direct"
      ? [track("avc1", 22e6, true), track("mp4a", 2e6, true)]
      : mode === "editable-unmixed"
        ? [track("avc1", 18e6, true), track("mp4a", 2e6, true), track("mp4a", 2e6, false), track("avc1", 10e6, false)]
        : [track("avc1", 18e6, true), track("mp4a", 2e6, true), track("mp4a", 2e6, false), track("mp4a", 2e6, false), track("avc1", 10e6, false)],
  },
});

describe("the editable recording benchmark (plan 087)", () => {
  it("judges the medians: the app's estimated CPU against 1.5 times its R, and the memory increase", () => {
    const runs = [run("direct", 7, 90e6), run("direct", 8, 91e6), run("direct", 30, 92e6), run("editable", 10, 95e6), run("editable", 11, 96e6), run("editable", 9, 94e6)];
    const direct = figures(runs, "direct")!, editable = figures(runs, "editable")!;
    // A one-off outlier does not move the median.
    expect(direct.engineCpu).toBe(8);
    expect(editable.trackBytesPerMinute).toEqual([18e6, 2e6, 2e6, 2e6, 10e6]);
    const verdicts = judge(direct, editable, 12);
    expect(verdicts.find((v) => v.check === "app CPU, estimated")).toMatchObject({ verdict: "pass", actual: "14.00% (1.17×)" });
    expect(verdicts.find((v) => v.check === "resident memory increase")!.verdict).toBe("pass");
    // 7 points more on an R of 12 is 1.58 times: over the budget.
    expect(judge(direct, { ...editable, engineCpu: 15 }, 12).find((v) => v.check === "app CPU, estimated")!.verdict).toBe("fail");
    expect(judge(direct, { ...editable, residentBytes: direct.residentBytes + 300 * 1024 ** 2 }, 12).find((v) => v.check === "resident memory increase")!.verdict).toBe("fail");
  });

  it("refuses a recording whose file is not what the mode makes", () => {
    expect(problems(run("editable", 10, 1))).toEqual([]);
    expect(problems(run("editable-unmixed", 10, 1))).toEqual([]);
    expect(problems(run("direct", 10, 1))).toEqual([]);
    const wrong = run("editable-unmixed", 10, 1);
    wrong.line.tracks[3]!.enabled = true;
    wrong.line.tracks[2]!.seconds = 59.5;
    wrong.line.fragmented = true;
    expect(problems(wrong)).toEqual([
      "the file stayed fragmented",
      "tracks presented true, true, false, true: only the first picture and sound should be",
      "track lengths 60.000, 60.000, 59.500, 60.000 s differ by more than 0.1 s",
    ]);
    // A camera whose encoder dropped most pictures: less work, so its CPU would mislead.
    const dropped = run("editable-unmixed", 10, 1);
    dropped.line.tracks[3]!.samples = 900;
    expect(problems(dropped)).toEqual(["video track 4 holds 900 pictures in 60.0 s, fewer than 1710"]);
    // Plan 098: an editable recording without its mixed track is not one.
    const unmixed = run("editable", 10, 1);
    unmixed.line.tracks.splice(1, 1);
    expect(problems(unmixed)[0]).toBe("tracks avc1, mp4a, mp4a, avc1 instead of avc1, mp4a, mp4a, mp4a, avc1");
  });

  it("judges plan 098's mixed track against the gates frozen at its D1", () => {
    const runs = [run("editable-unmixed", 10, 100e6), run("editable-unmixed", 10.2, 101e6), run("editable-unmixed", 10.1, 100e6), run("editable", 10.6, 103e6), run("editable", 10.8, 104e6), run("editable", 10.7, 103e6)];
    for (const r of runs) if (r.mode === "editable") r.line.fileBytes = 33.9e6;
    const verdicts = judgeMix(figures(runs, "editable-unmixed")!, figures(runs, "editable")!);
    expect(verdicts.map((v) => [v.check.slice(0, 2), v.verdict])).toEqual([["M1", "pass"], ["M3", "pass"], ["M4", "pass"], ["M5", "report"]]);
    expect(verdicts[0]!.actual).toBe("+0.60 points (10.10% → 10.70%)");
    const unmixed = figures(runs, "editable-unmixed")!;
    expect(judgeMix(unmixed, { ...unmixed, engineCpu: unmixed.engineCpu + 1.01 })[0]!.verdict).toBe("fail");
    expect(judgeMix(unmixed, { ...unmixed, fileBytesPerMinute: unmixed.fileBytesPerMinute + 2.6e6 })[1]!.verdict).toBe("fail");
    expect(judgeMix(unmixed, { ...unmixed, residentBytes: unmixed.residentBytes + 17 * 1024 ** 2 })[2]!.verdict).toBe("fail");
  });
});
