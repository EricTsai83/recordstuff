import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MATRICES,
  MAX_REPEAT,
  casePhases,
  formatRepeatSummary,
  formatRoundTiming,
  parseMatrixArgs,
  planCases,
  runPassed,
  runVerdict,
  spread,
  summarizeRuns,
  withUnreached,
  type MatrixRun,
  type PlannedCase,
} from "./matrix.mts";
import type { VerifyResult } from "./verify-recording.mts";
import type { Verdict } from "./verify.mts";

const KNOWN = Object.keys(MATRICES);
const ROOT = path.resolve(import.meta.dirname, "../..");

describe("arguments", () => {
  it("keeps a single matrix working as before and reads lists, several positionals and a repeat", () => {
    expect(parseMatrixArgs(["quick"], KNOWN)).toEqual({ ok: true, options: { names: ["quick"], repeat: 1, openMaterial: true, dryRun: false } });
    expect(parseMatrixArgs(["fps,long", "--repeat", "2", "--no-open-material", "--screen", "1920x1080", "--dry-run"], KNOWN)).toEqual({
      ok: true,
      options: { names: ["fps", "long"], repeat: 2, openMaterial: false, dryRun: true, screen: { width: 1920, height: 1080 } },
    });
    expect(parseMatrixArgs(["fps", "quick,long"], KNOWN)).toMatchObject({ ok: true, options: { names: ["fps", "quick", "long"] } });
    // A name listed twice runs twice per round: fps twice plus long once in one invocation.
    expect(parseMatrixArgs(["fps,fps,long"], KNOWN)).toMatchObject({ ok: true, options: { names: ["fps", "fps", "long"] } });
  });

  it("bounds --repeat to whole numbers from 1 to the maximum", () => {
    expect(parseMatrixArgs(["fps", "--repeat", "1"], KNOWN)).toMatchObject({ ok: true, options: { repeat: 1 } });
    expect(parseMatrixArgs(["fps", "--repeat", String(MAX_REPEAT)], KNOWN)).toMatchObject({ ok: true, options: { repeat: MAX_REPEAT } });
    for (const bad of ["0", String(MAX_REPEAT + 1), "1.5", "-1", "two", ""]) {
      expect(parseMatrixArgs(["fps", "--repeat", bad], KNOWN)).toMatchObject({ ok: false, error: expect.stringContaining("--repeat") });
    }
    expect(parseMatrixArgs(["fps", "--repeat"], KNOWN)).toMatchObject({ ok: false });
  });

  it("rejects unknown and empty names, unknown options, a bad screen and no matrix at all", () => {
    expect(parseMatrixArgs(["fps,quik"], KNOWN)).toEqual({ ok: false, error: `unknown matrix quik; choose from ${KNOWN.join(", ")}` });
    expect(parseMatrixArgs(["fps,"], KNOWN)).toMatchObject({ ok: false, error: expect.stringContaining("empty matrix name") });
    expect(parseMatrixArgs([",fps"], KNOWN)).toMatchObject({ ok: false });
    expect(parseMatrixArgs(["fps", "--repeats", "2"], KNOWN)).toEqual({ ok: false, error: "unknown option --repeats" });
    expect(parseMatrixArgs(["fps", "--screen", "wide"], KNOWN)).toMatchObject({ ok: false, error: expect.stringContaining("--screen") });
    expect(parseMatrixArgs([], KNOWN)).toEqual({ ok: false, error: "name at least one matrix" });
    expect(parseMatrixArgs(["--dry-run"], KNOWN)).toMatchObject({ ok: false });
  });
});

describe("case order", () => {
  const matrices = {
    a: [{ name: "A1", seconds: 5, quality: { frameRate: 30 as const } }, { name: "A2", seconds: 5, quality: { frameRate: 60 as const } }],
    b: [{ name: "B", seconds: 9, quality: {} }],
  };
  const order = (cases: PlannedCase[]) => cases.map((c) => `${c.round}:${c.title}`);

  it("repeats the whole list so repeats interleave, and numbers each repeated case's runs", () => {
    expect(order(planCases(["a", "b"], 2, matrices))).toEqual([
      "1:A1 (5 s) — run 1 of 2", "1:A2 (5 s) — run 1 of 2", "1:B (9 s) — run 1 of 2",
      "2:A1 (5 s) — run 2 of 2", "2:A2 (5 s) — run 2 of 2", "2:B (9 s) — run 2 of 2",
    ]);
  });

  it("titles a case that runs once as before, and groups a matrix listed twice as repeats of the same cases", () => {
    expect(order(planCases(["b"], 1, matrices))).toEqual(["1:B (9 s)"]);
    const cases = planCases(["a", "a", "b"], 1, matrices);
    expect(order(cases)).toEqual(["1:A1 (5 s) — run 1 of 2", "1:A2 (5 s) — run 1 of 2", "1:A1 (5 s) — run 2 of 2", "1:A2 (5 s) — run 2 of 2", "1:B (9 s)"]);
    expect(cases[0]?.key).toBe(cases[2]?.key);
    expect(cases[0]?.key).not.toBe(cases[1]?.key);
  });

  it("keeps same-named cases of different durations or quality apart", () => {
    const named = {
      short: [{ name: "C", seconds: 15, quality: { frameRate: 30 as const } }],
      long: [{ name: "C", seconds: 30, quality: { frameRate: 30 as const } }],
      fast: [{ name: "C", seconds: 15, quality: { frameRate: 60 as const } }],
    };
    const cases = planCases(["short", "long", "fast"], 1, named);
    expect(new Set(cases.map((c) => c.key)).size).toBe(3);
    expect(cases.map((c) => c.title)).toEqual(["C (15 s)", "C (30 s)", "C (15 s)"]);
  });
});

describe("phases from the app log", () => {
  const t0 = Date.parse("2026-09-26T10:00:00.000Z");
  const at = (seconds: number, text: string): string => `[${new Date(t0 + seconds * 1000).toISOString()}] ${text}`;

  it("splits a case into launch, recording, stop and quit by its own log lines", () => {
    const lines = [
      at(0.8, "start: RecordStuff 1.0.0; run r"),
      at(0.9, "state → stopping"), // before recording: not the autorecord stop
      at(1.0, "autorecord: 30 s with quality {}"),
      at(2.9, "autorecord: recording, will stop in 30 s"),
      at(32.9, "state → stopping"),
      at(33.0, "autorecord: saved /x/a.mp4"),
    ];
    expect(casePhases(lines, t0, t0 + 33_600)).toEqual({ launchToRecording: 2.9, recording: 30, stopToSaved: expect.closeTo(0.1, 5), quit: expect.closeTo(0.6, 5) });
  });

  it("leaves a phase undefined when its boundary is missing, and times a failure to quit", () => {
    expect(casePhases([at(1, "autorecord: failed: needs screen recording permission")], t0, t0 + 1500)).toEqual({ quit: 0.5 });
    expect(casePhases([at(3, "autorecord: recording, will stop in 30 s")], t0, undefined)).toEqual({ launchToRecording: 3 });
    expect(casePhases(["no timestamp: autorecord: recording, will stop in 30 s"], t0, t0)).toEqual({});
  });

  it("reports round totals and one row per case", () => {
    const text = formatRoundTiming({
      preflightSeconds: 2.5, buildSeconds: 0.7, materialSeconds: 5, totalSeconds: 31,
      cases: [{ title: "A (15 s)", phases: { launchToRecording: 2.9 }, tools: [{ tool: "ffprobe", seconds: 1.25 }, { tool: "ffmpeg astats", seconds: 0.2 }], totalSeconds: 22 }],
    });
    expect(text).toContain("Preflight 2.5, build 0.7, material open 5.0, cases 22.0, cleanup and report 0.8, wall 31.0.");
    expect(text).toContain("| A (15 s) | 2.9 | — | — | — | 1.4 | ffprobe 1.3, ffmpeg astats 0.2 | 22.0 |");
  });
});

describe("repeat summary", () => {
  const planned = planCases(["fps"], 2);
  const result = (verdict: Verdict, fps: number, cpu: number, offsetMs: number | undefined): VerifyResult => ({
    file: "/x.mp4",
    pairing: { status: "matched" },
    entry: { targetVideoBps: 10_000_000 },
    measurement: {
      video: { frames: fps * 30, durationSeconds: 30, bitsPerSecond: 10_100_000 },
      frames: { frames: fps * 30, dropped: 0, dropRate: 0.001, maxGapMs: 40, medianIntervalMs: 1000 / fps },
      cpu: { averagePercent: cpu, peakPercent: cpu + 5 },
      sync: offsetMs === undefined ? { status: "error", reason: "ffmpeg exited 1" } : { status: "measured", value: { medianOffsetMs: offsetMs, driftMs: undefined } },
    },
    checks: [],
    verdict,
  }) as unknown as VerifyResult;

  it("groups repeats per case with min / median / max and keeps every verdict", () => {
    const runs: MatrixRun[] = [
      { planned: planned[0]!, result: result("pass", 29.9, 13, 80) },
      { planned: planned[1]!, result: result("pass", 59.9, 21, 90) },
      { planned: planned[2]!, result: result("pass", 29.95, 14, 70) },
      { planned: planned[3]!, result: result("pass", 59.96, 22, 95) },
    ];
    const summaries = summarizeRuns(runs);
    expect(summaries.map((s) => [s.label, s.runs, s.passed])).toEqual([["Source Standard 30 fps (15 s)", 2, true], ["Source Standard 60 fps (15 s)", 2, true]]);
    expect(summaries[0]?.metrics["Average fps"]).toEqual({ min: 29.9, median: expect.closeTo(29.925, 5), max: 29.95, n: 2 });
    expect(summaries[0]?.metrics["A/V offset (ms)"]).toEqual({ min: 70, median: 75, max: 80, n: 2 });
    expect(summaries[0]?.metrics["Drift (ms)"]).toBeUndefined();
    expect(summaries[0]?.metrics["Video bitrate (% of target)"]?.median).toBeCloseTo(101, 5);
  });

  it("never lets a failed, blocked, incomplete or unverified repeat pass the case", () => {
    const ok = { planned: planned[0]!, result: result("pass", 29.9, 13, 80) };
    for (const bad of [
      { planned: planned[2]!, result: result("fail", 20, 13, 80) },
      { planned: planned[2]!, result: result("incomplete", 29.9, 13, undefined) },
      { planned: planned[2]!, result: undefined, error: "ffprobe is missing", blocked: true },
      { planned: planned[2]!, result: undefined, error: "app exited without an autorecord: saved log entry" },
      { planned: planned[2]!, result: result("pass", 29.9, 13, 80), error: "log metadata unknown; requested-settings checks not judged" },
    ] satisfies MatrixRun[]) {
      const [summary] = summarizeRuns([ok, bad]);
      expect(summary?.passed).toBe(false);
      expect(summary?.verdicts[0]).toBe("pass");
      expect(runPassed(bad)).toBe(false);
      expect(formatRepeatSummary([summary!])).toContain(`not passed (pass, ${runVerdict(bad)})`);
    }
    expect(runVerdict({ planned: planned[2]!, result: undefined, error: "ffprobe is missing", blocked: true })).toBe("blocked");
    expect(runVerdict({ planned: planned[2]!, result: undefined, error: "timed out" })).toBe("fail");
  });

  it("counts the repeats a round stopped before reaching as blocked, so their case cannot pass (review)", () => {
    // fps --repeat 2 stopped after run 3 (a tool went missing): 60 fps got one passing run of two.
    const reached: MatrixRun[] = [
      { planned: planned[0]!, result: result("pass", 29.9, 13, 80) },
      { planned: planned[1]!, result: result("pass", 59.9, 21, 90) },
      { planned: planned[2]!, result: undefined, error: "ffmpeg is missing", blocked: true },
    ];
    const judged = withUnreached(planned, reached, "not run: the round stopped early after a tool went missing");
    expect(judged.map(runVerdict)).toEqual(["pass", "pass", "blocked", "blocked"]);
    expect(judged[3]).toMatchObject({ planned: planned[3], error: "not run: the round stopped early after a tool went missing" });
    expect(summarizeRuns(judged).map((s) => [s.label, s.passed, s.verdicts])).toEqual([
      ["Source Standard 30 fps (15 s)", false, ["pass", "blocked"]],
      ["Source Standard 60 fps (15 s)", false, ["pass", "blocked"]],
    ]);
    expect(withUnreached(planned, judged, "unused")).toHaveLength(4);
  });

  it("shows how many runs a quantity came from when some runs lack it", () => {
    const [summary] = summarizeRuns([
      { planned: planned[0]!, result: result("pass", 29.9, 13, 80) },
      { planned: planned[2]!, result: undefined, error: "app exited without an autorecord: saved log entry" },
    ]);
    expect(formatRepeatSummary([summary!])).toContain("| 29.90 (1 of 2 runs) |");
    expect(spread([])).toBeUndefined();
    expect(spread([3, 1, 2])).toEqual({ min: 1, median: 2, max: 3, n: 3 });
  });
});

describe.skipIf(process.platform !== "darwin")("matrix CLI", () => {
  const cli = (args: string[]) => spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/run-matrix.mts", ...args], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });

  it("prints the interleaved order of a multi-matrix repeat without recording", () => {
    const result = cli(["fps,long", "--repeat", "2", "--screen", "1920x1080", "--dry-run"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Matrix fps,long × 2: 6 cases");
    expect(result.stdout.match(/^ {2}\d\. .+?:/gm)).toEqual([
      "  1. Source Standard 30 fps (15 s) — run 1 of 2:",
      "  2. Source Standard 60 fps (15 s) — run 1 of 2:",
      "  3. 1080p Standard 30 fps 3 minutes (180 s) — run 1 of 2:",
      "  4. Source Standard 30 fps (15 s) — run 2 of 2:",
      "  5. Source Standard 60 fps (15 s) — run 2 of 2:",
      "  6. 1080p Standard 30 fps 3 minutes (180 s) — run 2 of 2:",
    ]);
  });

  it("exits 2 with the reason and usage for an unknown matrix", () => {
    const result = cli(["fps,nope", "--screen", "1920x1080"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown matrix nope");
    expect(result.stderr).toContain("usage: pnpm matrix --");
  });
});
