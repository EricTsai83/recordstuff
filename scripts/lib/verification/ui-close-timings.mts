/** The background suite's close timings (plan 078 step 5); see scripts/ui-close-timings.mts. */

export interface CloseTiming {
  test: string;
  kind: string;
  closedNormally: boolean;
  audit?: number;
  close?: number;
  exit?: number;
  killed?: boolean;
}

export function parseCloseTimings(text: string): CloseTiming[] {
  return text.split("\n").filter((line) => line.trim()).flatMap((line) => {
    try {
      const value = JSON.parse(line) as CloseTiming;
      return typeof value.test === "string" && typeof value.kind === "string" ? [value] : [];
    } catch { return []; }
  });
}

const percentile = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

export function formatCloseTimings(timings: readonly CloseTiming[], top = 10): string {
  const closes = timings.flatMap((timing) => timing.close === undefined ? [] : [timing.close]).sort((a, b) => a - b);
  const failed = timings.filter((timing) => !timing.closedNormally || timing.killed);
  const lines = [
    `${timings.length} launches; normal close ms: median ${percentile(closes, 50)}, 95th ${percentile(closes, 95)}, slowest ${closes.at(-1) ?? 0}; ${failed.length} not closed normally or killed`,
  ];
  const total = (timing: CloseTiming): number => (timing.audit ?? 0) + (timing.close ?? 0) + (timing.exit ?? 0);
  for (const timing of [...timings].sort((a, b) => total(b) - total(a)).slice(0, top)) {
    lines.push(`  ${String(total(timing)).padStart(6)} ms  audit ${timing.audit ?? "-"}, close ${timing.close ?? "-"}, exit ${timing.exit ?? "-"}${timing.killed ? ", killed" : ""}${timing.closedNormally ? "" : ", close failed"}  ${timing.kind}: ${timing.test}`);
  }
  return lines.join("\n");
}
