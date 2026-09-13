import type { AudioReport } from "./audio-quality.mts";

/** Preserve failures and count missing measurements; never calibrate thresholds from a bad run. */
export function summarize(reports: AudioReport[], requestedRuns = reports.length) {
  if (reports.length === 0) throw new Error("Cannot summarize an empty audio run");
  if (!Number.isInteger(requestedRuns) || requestedRuns < reports.length) throw new Error("Invalid requested run count");
  const metrics = [...new Set(reports.flatMap(r => r.checks.map(c => c.metric)))].map(metric => {
    const values = reports.flatMap(r => r.verdict === "invalid" ? [] : r.checks.filter(c => c.metric === metric && c.value !== null && Number.isFinite(c.value)).map(c => c.value!)).sort((a, b) => a - b);
    const count = values.length;
    return { metric, measuredCount: count, missingCount: reports.length - count,
      min: count ? values[0]! : null, median: count ? (values[Math.floor((count - 1) / 2)]! + values[Math.floor(count / 2)]!) / 2 : null,
      max: count ? values[count - 1]! : null };
  });
  return { version: 2, requestedRuns, runs: reports.length, passed: reports.filter(r => r.verdict === "pass").length,
    failed: reports.filter(r => r.verdict === "fail").length, invalid: reports.filter(r => r.verdict === "invalid").length,
    verdict: reports.length < requestedRuns ? "incomplete" : reports.some(r => r.verdict === "invalid") ? "invalid" : reports.some(r => r.verdict === "fail") ? "fail" : "pass",
    metrics };
}
