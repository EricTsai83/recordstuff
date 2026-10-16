/**
 * Reads the engine's per-frame log (`RECORDSTUFF_FRAME_LOG`, plan 078): the frames a recording kept, the gaps between
 * them, and what capture delivered around each long gap, so a gap can be traced to the pacer, an idle refresh or
 * capture itself. Development only, never shipped.
 */

export type FrameKind = "picture" | "idle" | "blank" | "first" | "skipped" | "due" | "refresh" | "stop";

export interface FrameLine {
  /** Milliseconds after the recording's start. */
  t: number;
  kind: FrameKind;
  kept: boolean;
  /** The pacer's next slot after this frame, in ms; null before the pacer exists. */
  next: number | null;
}

export interface Gap {
  from: number;
  to: number;
  ms: number;
  /** Every line from one interval before the gap to its end. */
  context: FrameLine[];
}

export interface FrameLogSummary {
  kept: number;
  deliveries: { picture: number; idle: number; blank: number };
  /** Kept frames encoded by the core itself rather than on a delivery. */
  own: { skipped: number; due: number; refresh: number; stop: number };
  intervalMs: number;
  /** Gaps between kept frames, rounded to the millisecond, and how often each occurred. */
  histogram: [number, number][];
  /** Gaps at least one and a half intervals long, and gaps at most half an interval. */
  long: Gap[];
  short: Gap[];
}

export function parseFrameLog(text: string): FrameLine[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const value = JSON.parse(line) as FrameLine;
      if (typeof value.t !== "number" || typeof value.kind !== "string" || typeof value.kept !== "boolean") {
        throw new Error(`line ${index + 1}: not a frame log line`);
      }
      return value;
    });
}

export function summarizeFrameLog(lines: readonly FrameLine[], frameRate: number): FrameLogSummary {
  const intervalMs = 1000 / frameRate;
  const kept = lines.filter((line) => line.kept).sort((a, b) => a.t - b.t);
  const count = (kind: FrameKind) => lines.filter((line) => line.kind === kind).length;
  const histogram = new Map<number, number>();
  const long: Gap[] = [];
  const short: Gap[] = [];
  for (let index = 1; index < kept.length; index++) {
    const from = kept[index - 1]!.t;
    const to = kept[index]!.t;
    const ms = to - from;
    histogram.set(Math.round(ms), (histogram.get(Math.round(ms)) ?? 0) + 1);
    // The last frame before the stop may land anywhere; it says nothing about cadence.
    if (kept[index]!.kind === "stop") continue;
    const gap = () => ({ from, to, ms, context: lines.filter((line) => line.t >= from - intervalMs && line.t <= to) });
    if (ms >= intervalMs * 1.5) long.push(gap());
    else if (ms <= intervalMs / 2) short.push(gap());
  }
  return {
    kept: kept.length,
    deliveries: { picture: count("picture"), idle: count("idle"), blank: count("blank") },
    own: { skipped: count("skipped"), due: count("due"), refresh: count("refresh"), stop: count("stop") },
    intervalMs,
    histogram: [...histogram.entries()].sort((a, b) => a[0] - b[0]),
    long,
    short,
  };
}

export function formatFrameLog(summary: FrameLogSummary): string {
  const out: string[] = [];
  const percent = (n: number) => (summary.kept > 1 ? ((n / (summary.kept - 1)) * 100).toFixed(2) : "0.00");
  out.push(`kept ${summary.kept} frames; capture delivered ${summary.deliveries.picture} pictures, ${summary.deliveries.idle} idle and ${summary.deliveries.blank} blank frames`);
  out.push(`encoded by the core itself: ${summary.own.skipped} for a skipped refresh, ${summary.own.due} due, ${summary.own.refresh} refresh, ${summary.own.stop} at the stop`);
  out.push(`gaps (ms × count): ${summary.histogram.map(([ms, n]) => `${ms}×${n}`).join(", ")}`);
  out.push(`long gaps (≥ ${(summary.intervalMs * 1.5).toFixed(1)} ms): ${summary.long.length} (${percent(summary.long.length)}%); short gaps (≤ ${(summary.intervalMs / 2).toFixed(1)} ms): ${summary.short.length}`);
  for (const [label, gaps] of [["long", summary.long], ["short", summary.short]] as const) {
    for (const gap of gaps) {
      out.push(`\n${label} gap ${gap.ms.toFixed(2)} ms, ${gap.from.toFixed(2)} → ${gap.to.toFixed(2)}:`);
      for (const line of gap.context) {
        out.push(`  ${line.t.toFixed(3).padStart(10)}  ${line.kind.padEnd(8)} ${line.kept ? "kept" : "    "}  next ${line.next === null ? "-" : line.next.toFixed(3)}`);
      }
    }
  }
  return out.join("\n");
}
