/**
 * Plan 037's finalization measurement: reads one autorecord run's log lines
 * and reports where the wait between stop and the saved file went.
 * Stop-to-ready is `state → stopping` to `state → idle`, the moment a toggle
 * starts a new recording again; stop-to-saved is `state → stopping` to `file
 * finalized`. Since saves moved to the background (2026-10-09) idle usually
 * comes first, so a sample pairs a stop with its save whichever order they
 * arrive in. The phases come from the recorder's `finalize timing` line, and
 * with the native engine (plan 076) from its `engine finished` line too. Pure,
 * so the runner's parsing is testable.
 */
import { EARLY_STOP_TEXT } from "../../../src/shared/session-record.ts";
import { lineTime } from "../runner/log-reader.mts";
import { escapeRegExp } from "../runner/processes.mts";
import { percentileSorted } from "./stats.mts";

/** The recorder's saved line, with any early-stop reason the app can name. */
const FINALIZED = new RegExp(`^recorder: session \\S+ file finalized (.+?)( \\(stopped early: (?:${Object.values(EARLY_STOP_TEXT).map(escapeRegExp).join("|")})\\))?$`);

export interface FinalizeTiming {
  session: string;
  /** Stop request to the host's `stopped`: final Blob handoff. */
  hostMs?: number;
  /** `stopped` to the last queued append settling. */
  writesMs?: number;
  flushMs?: number;
  /** Making the file plain MP4: the TypeScript finalizer's, or the native engine's own figure. */
  finalizeMs?: number;
  /** Why the file was left fragmented; absent when it was made plain. */
  fragmented?: string;
  closeMs?: number;
  publishMs?: number;
  method?: "link" | "copy";
  /** Why the file was copied instead of linked. */
  linkError?: string;
  cleanupMs?: number;
  /** Why the temporary name was kept beside the saved file. */
  cleanupError?: string;
  /** Rewriting the interruption sentinel with the saved path; absent from lines logged before plan 053. */
  checkpointMs?: number;
  bytes?: number;
}

export interface FinalizationSample extends FinalizeTiming {
  /** `state → stopping` to `state → idle`; absent when the run ended before idle. */
  stopToReadyMs?: number;
  /** `state → stopping` to `file finalized`. */
  stopToSavedMs: number;
  /** `file finalized` to `state → idle`, when idle came after the save: settling the state and its subscribers. */
  uiMs?: number;
  /** The native engine's `engine finished … ms after the stop` (plan 076): its stop to a finished file. */
  engineFinishMs?: number;
  path: string;
  stoppedEarly: boolean;
}

/**
 * The error fields are `errnoCode ?? messageOf(cause)` (file-writer.ts): a message may hold spaces and
 * parentheses, so they match lazily up to the fixed text that follows them.
 */
const TIMING = /^recorder: session (\S+) finalize timing: host (\S+) ms, writes (\S+) ms, flush (\S+) ms, (?:finalize (\S+) ms (?:to plain MP4|kept fragmented \((.+?)\)|\?), )?close (\S+) ms, publish (\S+) ms by (\S+)(?: \(link (.+?)\))?, cleanup (\S+) ms(?: \(temporary name kept: (.+?)\))?(?:, checkpoint (\S+) ms)?; (\S+) bytes$/;
/** The native engine's finished file (native-capture-host.ts). */
const ENGINE_FINISHED = /^capture host: engine finished \d+ bytes (\d+) ms after the stop/;

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
    ["hostMs", m[2]], ["writesMs", m[3]], ["flushMs", m[4]], ["finalizeMs", m[5]], ["closeMs", m[7]], ["publishMs", m[8]], ["cleanupMs", m[11]],
    ["checkpointMs", m[13]], ["bytes", m[14]],
  ];
  for (const [key, text] of fields) {
    const value = number(text);
    if (value !== undefined) (timing as unknown as Record<string, number>)[key] = value;
  }
  if (m[6]) timing.fragmented = m[6];
  if (m[9] === "link" || m[9] === "copy") timing.method = m[9];
  if (m[10]) timing.linkError = m[10];
  if (m[12]) timing.cleanupError = m[12];
  return timing;
}

const message = (line: string): string => line.replace(/^\[[^\]]+\] /, "");

/**
 * The last saved session in one run's log lines (each `[timestamp] message`): its stop, save and, when the run got
 * there, idle. Undefined when no stop ended in a saved file.
 */
export function finalizationSample(lines: readonly string[]): FinalizationSample | undefined {
  let stopping: Date | undefined;
  let idleAt: Date | undefined;
  let engineFinishMs: number | undefined;
  let finalized: { at: Date; path: string; stoppedEarly: boolean } | undefined;
  let timing: FinalizeTiming | undefined;
  let sample: FinalizationSample | undefined;
  const settle = (): void => {
    if (!stopping || !finalized) return;
    const idleAfterSave = idleAt && idleAt.getTime() >= finalized.at.getTime();
    sample = {
      ...(timing ?? { session: "?" }),
      ...(idleAt ? { stopToReadyMs: idleAt.getTime() - stopping.getTime() } : {}),
      stopToSavedMs: finalized.at.getTime() - stopping.getTime(),
      ...(idleAfterSave ? { uiMs: idleAt!.getTime() - finalized.at.getTime() } : {}),
      ...(engineFinishMs === undefined ? {} : { engineFinishMs }),
      path: finalized.path,
      stoppedEarly: finalized.stoppedEarly,
    };
  };
  for (const line of lines) {
    const text = message(line);
    const at = lineTime(line);
    if (text === "state → stopping") {
      stopping = at;
      idleAt = undefined;
      engineFinishMs = undefined;
      finalized = undefined;
      timing = undefined;
      continue;
    }
    if (!stopping) continue;
    let m: RegExpExecArray | null;
    if (text === "state → idle" && at) {
      idleAt ??= at;
      settle();
    } else if ((m = ENGINE_FINISHED.exec(text))) {
      engineFinishMs = Number(m[1]);
      settle();
    } else if ((m = FINALIZED.exec(text)) && at) {
      finalized = { at, path: m[1]!, stoppedEarly: m[2] !== undefined };
      settle();
    } else {
      const parsed = parseFinalizeTiming(text);
      if (parsed) {
        timing = parsed;
        settle();
      }
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
  return { n: sorted.length, min: sorted[0]!, p50: percentileSorted(sorted, 0.5)!, p95: percentileSorted(sorted, 0.95)!, max: sorted.at(-1)! };
}

export const formatDistribution = (d: Distribution | undefined, unit = "ms"): string =>
  d ? `n=${d.n} min ${d.min} / p50 ${d.p50} / p95 ${d.p95} / max ${d.max} ${unit}` : "no samples";

const UNITS: Record<string, number> = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** `64m`, `2g`, `512k` or plain bytes, binary units; undefined unless a positive whole byte count. */
export function parseByteSize(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)$/i.exec(text.trim());
  if (!m) return undefined;
  const bytes = Math.round(Number(m[1]) * UNITS[m[2]!.toLowerCase()]!);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}
