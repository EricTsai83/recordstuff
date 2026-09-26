/**
 * Pure part of `pnpm matrix` (scripts/run-matrix.mts; plan 042): the fixed
 * matrices, argument parsing, the order of a multi-matrix round, per-phase
 * timing read from the app log, and the summary that groups repeated runs.
 * Development only; nothing here ships with the app.
 */
import { lineTime } from "./acceptance.mts";
import type { ToolTiming } from "./media-tools.mts";
import type { VerifyResult } from "./verify-recording.mts";
import { blocksSuccess, type Verdict } from "./verify.mts";
import type { Dimensions, QualitySettings } from "../../src/shared/quality.ts";

export interface MatrixEntry {
  name: string;
  seconds: number;
  quality: Partial<QualitySettings>;
}

/**
 * Fixed matrices; every entry merges over DEFAULT_QUALITY inside the app, not
 * over settings.json. `quick` and `fps` record 15 s (plan 042): with one flash
 * per second that still holds about 14 marker pairs, and every judged metric
 * stayed within the run-to-run spread of the earlier 30-second cases.
 */
export const MATRICES: Record<string, MatrixEntry[]> = {
  quick: [
    { name: "1440p Standard", seconds: 15, quality: { resolutionCap: "1440p", videoQuality: "standard", frameRate: 30 } },
    { name: "1440p High", seconds: 15, quality: { resolutionCap: "1440p", videoQuality: "high", frameRate: 30 } },
    { name: "Source Standard", seconds: 15, quality: { resolutionCap: "source", videoQuality: "standard", frameRate: 30 } },
  ],
  levels: [
    { name: "1080p Economy", seconds: 30, quality: { resolutionCap: "1080p", videoQuality: "economy", frameRate: 30 } },
    { name: "1080p Standard (original 8 Mbps baseline)", seconds: 30, quality: { resolutionCap: "1080p", videoQuality: "standard", frameRate: 30 } },
    { name: "1080p High", seconds: 30, quality: { resolutionCap: "1080p", videoQuality: "high", frameRate: 30 } },
  ],
  fps: [
    { name: "Source Standard 30 fps", seconds: 15, quality: { resolutionCap: "source", videoQuality: "standard", frameRate: 30 } },
    { name: "Source Standard 60 fps", seconds: 15, quality: { resolutionCap: "source", videoQuality: "standard", frameRate: 60 } },
  ],
  /**
   * The formal 10-minute CPU/sync baseline was recorded once
   * on 2026-09-13 (drift 3 ms at both 3 and 10 minutes). Regression runs use
   * 3 minutes since then; the length is a user decision, not a tool limit.
   */
  long: [
    { name: "1080p Standard 30 fps 3 minutes", seconds: 180, quality: { resolutionCap: "1080p", videoQuality: "standard", frameRate: 30 } },
  ],
};

/**
 * One sitting: the levels, 60 fps and quick cases at 15 s (the sync window
 * needs ≥ 3 marker pairs), the 30 fps source case covered by `quick`, and
 * drift measured on a 3-minute segment shared with `long`.
 */
const shorten = (entries: MatrixEntry[], seconds: number): MatrixEntry[] => entries.map((e) => ({ ...e, seconds }));
MATRICES["all"] = [
  ...shorten(MATRICES["levels"]!, 15),
  ...shorten(MATRICES["fps"]!.filter((e) => e.quality.frameRate === 60), 15),
  ...shorten(MATRICES["quick"]!, 15),
  ...MATRICES["long"]!.map((e) => ({ ...e, name: `${e.name} (drift)` })),
];

/** Upper bound of `--repeat`, as for the cadence diagnostic's `--runs`. */
export const MAX_REPEAT = 10;

export interface MatrixOptions {
  /** Matrix names in the order given; a name listed twice runs twice per round. */
  names: string[];
  repeat: number;
  openMaterial: boolean;
  dryRun: boolean;
  screen?: Dimensions;
}

export type MatrixArgs = { ok: true; options: MatrixOptions } | { ok: false; error: string };

/**
 * `<name>[,<name>…] [--repeat N] [--no-open-material] [--screen WxH] [--dry-run]`.
 * Several positional lists are joined; an empty item, an unknown name or an
 * unknown flag is an error rather than a silently narrower round.
 */
export function parseMatrixArgs(argv: readonly string[], known: readonly string[]): MatrixArgs {
  const options: MatrixOptions = { names: [], repeat: 1, openMaterial: true, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--open-material") options.openMaterial = true;
    else if (arg === "--no-open-material") options.openMaterial = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--screen") {
      const match = /^(\d+)x(\d+)$/.exec((argv[i + 1] ?? "").trim());
      if (!match) return { ok: false, error: "--screen needs WxH, for example 1920x1080" };
      options.screen = { width: Number(match[1]), height: Number(match[2]) };
      i += 1;
    } else if (arg === "--repeat") {
      const text = argv[i + 1] ?? "";
      const n = Number(text);
      if (!/^\d+$/.test(text) || n < 1 || n > MAX_REPEAT) return { ok: false, error: `--repeat needs a whole number from 1 to ${MAX_REPEAT}, got ${text || "nothing"}` };
      options.repeat = n;
      i += 1;
    } else if (arg.startsWith("--")) return { ok: false, error: `unknown option ${arg}` };
    else {
      for (const name of arg.split(",")) {
        if (name === "") return { ok: false, error: `empty matrix name in "${arg}"` };
        if (!known.includes(name)) return { ok: false, error: `unknown matrix ${name}; choose from ${known.join(", ")}` };
        options.names.push(name);
      }
    }
  }
  if (options.names.length === 0) return { ok: false, error: "name at least one matrix" };
  return { ok: true, options };
}

export interface PlannedCase {
  entry: MatrixEntry;
  /** Groups repeats: name, duration and quality together identify a case. */
  key: string;
  /** Measurements heading; repeats get "run k of n". */
  title: string;
  /** 1-based pass through the named matrices. */
  round: number;
}

export const caseLabel = (entry: MatrixEntry): string => `${entry.name} (${entry.seconds} s)`;

/**
 * Every pass runs the named matrices in order, and `--repeat` repeats the
 * whole pass, so a case's repeats interleave with the others (as the cadence
 * diagnostic alternates rates): no case always runs first or warmest.
 */
export function planCases(names: readonly string[], repeat: number, matrices: Record<string, MatrixEntry[]> = MATRICES): PlannedCase[] {
  const order: Omit<PlannedCase, "title">[] = [];
  for (let round = 1; round <= repeat; round += 1) {
    for (const name of names) {
      for (const entry of matrices[name] ?? []) order.push({ entry, key: `${caseLabel(entry)} ${JSON.stringify(entry.quality)}`, round });
    }
  }
  const totals = new Map<string, number>();
  for (const planned of order) totals.set(planned.key, (totals.get(planned.key) ?? 0) + 1);
  const seen = new Map<string, number>();
  return order.map((planned) => {
    const k = (seen.get(planned.key) ?? 0) + 1;
    seen.set(planned.key, k);
    const total = totals.get(planned.key) ?? 1;
    return { ...planned, title: total > 1 ? `${caseLabel(planned.entry)} — run ${k} of ${total}` : caseLabel(planned.entry) };
  });
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export interface CasePhases {
  /** Launch until the app logged that autorecord is recording. */
  launchToRecording?: number;
  /** Recording until the stop request (`state → stopping`). */
  recording?: number;
  /** Stop request until the autorecord outcome (saved or failed). */
  stopToSaved?: number;
  /** Outcome until the launched app exited. */
  quit?: number;
}

/**
 * Phases of one case, in seconds, from the timestamps of its own log lines
 * and the runner's launch and exit times (the same machine clock). A phase
 * whose boundary line is missing stays undefined.
 */
export function casePhases(lines: readonly string[], launchedAtMs: number, exitedAtMs: number | undefined): CasePhases {
  let recordingAt: number | undefined;
  let stoppingAt: number | undefined;
  let outcomeAt: number | undefined;
  for (const line of lines) {
    const at = lineTime(line)?.getTime();
    if (at === undefined) continue;
    if (recordingAt === undefined && /\] autorecord: recording, will stop in /.test(line)) recordingAt = at;
    else if (recordingAt !== undefined && stoppingAt === undefined && /\] state → stopping/.test(line)) stoppingAt = at;
    if (outcomeAt === undefined && /\] autorecord: (saved |failed: )/.test(line)) outcomeAt = at;
  }
  const span = (from: number | undefined, to: number | undefined): number | undefined =>
    from === undefined || to === undefined ? undefined : (to - from) / 1000;
  const phases: CasePhases = {};
  const assign = (key: keyof CasePhases, value: number | undefined): void => { if (value !== undefined) phases[key] = value; };
  assign("launchToRecording", span(launchedAtMs, recordingAt));
  assign("recording", span(recordingAt, stoppingAt));
  assign("stopToSaved", span(stoppingAt, outcomeAt));
  assign("quit", span(outcomeAt, exitedAtMs));
  return phases;
}

export interface CaseTiming {
  title: string;
  phases: CasePhases;
  tools: ToolTiming[];
  /** Launch until verification ended. */
  totalSeconds: number;
}

export interface RoundTiming {
  /** Start until the build: arguments, display size, tool checks and the desktop round. */
  preflightSeconds: number;
  buildSeconds: number;
  materialSeconds: number;
  totalSeconds: number;
  cases: CaseTiming[];
}

const sec = (value: number | undefined): string => (value === undefined ? "—" : value.toFixed(1));
const toolSeconds = (tools: readonly ToolTiming[]): number => tools.reduce((sum, t) => sum + t.seconds, 0);
const toolList = (tools: readonly ToolTiming[]): string => tools.map((t) => `${t.tool} ${t.seconds.toFixed(1)}`).join(", ") || "—";

/** One console line per case. */
export function formatCaseTiming(timing: CaseTiming): string {
  const p = timing.phases;
  return `  Timing: launch→recording ${sec(p.launchToRecording)} s, recording ${sec(p.recording)} s, stop→saved ${sec(p.stopToSaved)} s, quit ${sec(p.quit)} s; verify ${toolSeconds(timing.tools).toFixed(1)} s (${toolList(timing.tools)}); case ${timing.totalSeconds.toFixed(1)} s`;
}

/** Markdown section for the measurements file: round totals and one row per case. */
export function formatRoundTiming(timing: RoundTiming): string {
  const cases = timing.cases.reduce((sum, c) => sum + c.totalSeconds, 0);
  const other = timing.totalSeconds - timing.preflightSeconds - timing.buildSeconds - timing.materialSeconds - cases;
  return [
    "### Timing (seconds)",
    "",
    `Preflight ${sec(timing.preflightSeconds)}, build ${sec(timing.buildSeconds)}, material open ${sec(timing.materialSeconds)}, cases ${sec(cases)}, cleanup and report ${sec(other)}, wall ${sec(timing.totalSeconds)}.`,
    "",
    "| Case | Launch→recording | Recording | Stop→saved | Quit | Verify | Verify tools | Case |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...timing.cases.map((c) => `| ${c.title} | ${sec(c.phases.launchToRecording)} | ${sec(c.phases.recording)} | ${sec(c.phases.stopToSaved)} | ${sec(c.phases.quit)} | ${sec(toolSeconds(c.tools))} | ${toolList(c.tools)} | ${sec(c.totalSeconds)} |`),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Repeats
// ---------------------------------------------------------------------------

export interface MatrixRun {
  planned: PlannedCase;
  result: VerifyResult | undefined;
  /** Why the run could not be judged, or what else kept it from passing (unmatched metadata). */
  error?: string;
  /** The error was a missing tool, not the case. */
  blocked?: boolean;
}

/** The verdict a run contributes to the exit code, as before plan 042. */
export function runVerdict(run: MatrixRun): Verdict {
  if (run.blocked) return "blocked";
  if (run.error !== undefined) return "fail";
  return run.result?.verdict ?? "fail";
}

export const runPassed = (run: MatrixRun): boolean => run.error === undefined && run.result !== undefined && !blocksSuccess(run.result.verdict);

export const REPEAT_METRICS = ["Average fps", "Median interval (ms)", "Drops (%)", "CPU average (%)", "A/V offset (ms)", "Drift (ms)", "Video bitrate (% of target)"] as const;
export type RepeatMetric = (typeof REPEAT_METRICS)[number];

/** The judged quantities of one verified run; absent evidence stays undefined. */
export function runMetrics(result: VerifyResult): Record<RepeatMetric, number | undefined> {
  const m = result.measurement;
  const sync = m.sync.status === "measured" ? m.sync.value : undefined;
  const target = result.entry?.targetVideoBps;
  return {
    "Average fps": m.video?.frames !== undefined && m.video.durationSeconds ? m.video.frames / m.video.durationSeconds : undefined,
    "Median interval (ms)": m.frames?.medianIntervalMs,
    "Drops (%)": m.frames ? m.frames.dropRate * 100 : undefined,
    "CPU average (%)": m.cpu?.averagePercent,
    "A/V offset (ms)": sync?.medianOffsetMs,
    "Drift (ms)": sync?.driftMs,
    "Video bitrate (% of target)": target && m.video?.bitsPerSecond !== undefined ? (m.video.bitsPerSecond / target) * 100 : undefined,
  };
}

export interface Spread { min: number; median: number; max: number; n: number }

export function spread(values: readonly number[]): Spread | undefined {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return undefined;
  const mid = Math.floor(finite.length / 2);
  const median = finite.length % 2 === 1 ? finite[mid]! : (finite[mid - 1]! + finite[mid]!) / 2;
  return { min: finite[0]!, median, max: finite[finite.length - 1]!, n: finite.length };
}

export interface CaseSummary {
  label: string;
  runs: number;
  /** Every run's verdict in run order, so a failed repeat stays visible. */
  verdicts: Verdict[];
  /** True only when every run passed. */
  passed: boolean;
  metrics: Partial<Record<RepeatMetric, Spread>>;
}

/**
 * Every planned case as a run: a case the round never reached, because it
 * stopped early when a tool went missing, becomes a blocked run, so a repeated
 * case cannot pass on the runs it happened to get (review). `runs` are in plan
 * order, one per case reached.
 */
export function withUnreached(planned: readonly PlannedCase[], runs: readonly MatrixRun[], reason: string): MatrixRun[] {
  return [...runs, ...planned.slice(runs.length).map((p): MatrixRun => ({ planned: p, result: undefined, error: reason, blocked: true }))];
}

/** Runs grouped per case in first-run order; a case passes only when all of its runs did. */
export function summarizeRuns(runs: readonly MatrixRun[]): CaseSummary[] {
  const groups = new Map<string, MatrixRun[]>();
  for (const run of runs) groups.set(run.planned.key, [...(groups.get(run.planned.key) ?? []), run]);
  return [...groups.values()].map((group) => {
    const metrics: Partial<Record<RepeatMetric, Spread>> = {};
    const measured = group.flatMap((run) => (run.result ? [runMetrics(run.result)] : []));
    for (const metric of REPEAT_METRICS) {
      const s = spread(measured.map((values) => values[metric]).filter((v): v is number => v !== undefined));
      if (s) metrics[metric] = s;
    }
    return {
      label: caseLabel(group[0]!.planned.entry),
      runs: group.length,
      verdicts: group.map(runVerdict),
      passed: group.every(runPassed),
      metrics,
    };
  });
}

const DIGITS: Record<RepeatMetric, number> = {
  "Average fps": 2, "Median interval (ms)": 2, "Drops (%)": 2, "CPU average (%)": 0, "A/V offset (ms)": 0, "Drift (ms)": 0, "Video bitrate (% of target)": 0,
};

function spreadCell(metric: RepeatMetric, s: Spread | undefined, runs: number): string {
  if (!s) return "—";
  const d = DIGITS[metric];
  const range = s.n === 1 ? s.median.toFixed(d) : `${s.min.toFixed(d)} / ${s.median.toFixed(d)} / ${s.max.toFixed(d)}`;
  return s.n < runs ? `${range} (${s.n} of ${runs} runs)` : range;
}

/** Markdown table of repeated cases: every verdict, and min / median / max of each quantity. */
export function formatRepeatSummary(summaries: readonly CaseSummary[]): string {
  return [
    "### Repeats (min / median / max)",
    "",
    `| Case | Runs | Result | ${REPEAT_METRICS.join(" | ")} |`,
    `| --- | --- | --- | ${REPEAT_METRICS.map(() => "---").join(" | ")} |`,
    ...summaries.map((s) => `| ${s.label} | ${s.runs} | ${s.passed ? "pass" : "not passed"} (${s.verdicts.join(", ")}) | ${REPEAT_METRICS.map((metric) => spreadCell(metric, s.metrics[metric], s.runs)).join(" | ")} |`),
    "",
  ].join("\n");
}
