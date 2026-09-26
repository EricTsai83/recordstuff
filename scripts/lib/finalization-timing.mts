/**
 * Plan 037's finalization measurement: reads one autorecord run's log lines
 * and reports where the wait between stop and the next admitted start went.
 * Stop-to-ready is `state → stopping` to `state → idle`, the moment a toggle
 * starts a new recording again; the phases come from the recorder's
 * `finalize timing` line. Pure, so the runner's parsing is testable.
 */
import { lineTime } from "./acceptance.mts";

export interface FinalizeTiming {
  session: string;
  /** Stop request to the host's `stopped`: final Blob handoff. */
  hostMs?: number;
  /** `stopped` to the last queued append settling. */
  writesMs?: number;
  flushMs?: number;
  closeMs?: number;
  publishMs?: number;
  method?: "link" | "copy";
  /** Why the file was copied instead of linked. */
  linkError?: string;
  cleanupMs?: number;
  bytes?: number;
}

export interface FinalizationSample extends FinalizeTiming {
  stopToReadyMs: number;
  /** `file finalized` to `state → idle`: settling the state and its subscribers. */
  uiMs?: number;
  path: string;
  stoppedEarly: boolean;
}

const TIMING = /^recorder: session (\S+) finalize timing: host (\S+) ms, writes (\S+) ms, flush (\S+) ms, close (\S+) ms, publish (\S+) ms by (\S+)(?: \(link (\S+)\))?, cleanup (\S+) ms; (\S+) bytes$/;

const number = (text: string | undefined): number | undefined => {
  if (text === undefined || text === "?") return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
};

/** The recorder's `finalize timing` message, without the log timestamp. */
export function parseFinalizeTiming(message: string): FinalizeTiming | undefined {
  const m = TIMING.exec(message);
  if (!m) return undefined;
  const timing: FinalizeTiming = { session: m[1]! };
  const fields: Array<[keyof FinalizeTiming, string | undefined]> = [
    ["hostMs", m[2]], ["writesMs", m[3]], ["flushMs", m[4]], ["closeMs", m[5]], ["publishMs", m[6]], ["cleanupMs", m[9]], ["bytes", m[10]],
  ];
  for (const [key, text] of fields) {
    const value = number(text);
    if (value !== undefined) (timing as unknown as Record<string, number>)[key] = value;
  }
  if (m[7] === "link" || m[7] === "copy") timing.method = m[7];
  if (m[8]) timing.linkError = m[8];
  return timing;
}

const message = (line: string): string => line.replace(/^\[[^\]]+\] /, "");

/**
 * The last saved session in one run's log lines (each `[timestamp] message`).
 * Undefined when the run did not reach `state → idle` after a finalized file.
 */
export function finalizationSample(lines: readonly string[]): FinalizationSample | undefined {
  let stopping: Date | undefined;
  let finalized: { at: Date; path: string; stoppedEarly: boolean } | undefined;
  let timing: FinalizeTiming | undefined;
  let sample: FinalizationSample | undefined;
  for (const line of lines) {
    const text = message(line);
    const at = lineTime(line);
    if (text === "state → stopping") {
      stopping = at;
      finalized = undefined;
      timing = undefined;
      continue;
    }
    if (!stopping) continue;
    const done = /^recorder: session \S+ file finalized (.+?)( \(stopped early: disk almost full\))?$/.exec(text);
    if (done && at) {
      finalized = { at, path: done[1]!, stoppedEarly: done[2] !== undefined };
      continue;
    }
    const parsed = parseFinalizeTiming(text);
    if (parsed) {
      timing = parsed;
      continue;
    }
    if (text === "state → idle" && at && finalized) {
      sample = {
        ...(timing ?? { session: "?" }),
        stopToReadyMs: at.getTime() - stopping.getTime(),
        uiMs: at.getTime() - finalized.at.getTime(),
        path: finalized.path,
        stoppedEarly: finalized.stoppedEarly,
      };
      stopping = undefined;
    }
  }
  return sample;
}

export interface Distribution {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
}

/** Nearest-rank percentiles; with fewer than 20 samples p95 is the maximum. */
export function distribution(values: readonly number[]): Distribution | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  return { n: sorted.length, min: sorted[0]!, p50: rank(0.5), p95: rank(0.95), max: sorted.at(-1)! };
}

export const formatDistribution = (d: Distribution | undefined, unit = "ms"): string =>
  d ? `n=${d.n} min ${d.min} / p50 ${d.p50} / p95 ${d.p95} / max ${d.max} ${unit}` : "no samples";
