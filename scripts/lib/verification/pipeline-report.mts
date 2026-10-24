/**
 * Reads the pipeline's figures from the app's log (plan 083): each session's `diagnostics: {"kind":"engine",…}` line,
 * logged by the capture host once the session ended, and the Studio page's `{"kind":"page",…}` reports while it showed
 * the preview, merged into one record per session with each stage's count, mean, p50, p95 and maximum. Development
 * only, never shipped; the lines exist only under `RECORDSTUFF_DIAGNOSTICS=1`.
 *
 * The report (`PIPELINE_REPORT_SCHEMA`) keeps the merged histograms beside their summaries, so reports of several runs
 * combine without the samples (`mergeSessions`).
 */
import {
  PIPELINE_SCHEMA, isHistogramJson, mergeHistograms, summarizeHistogram, emptyHistogram, type HistogramJson, type HistogramSummary,
} from "../../../src/shared/pipeline-histogram.ts";

export const PIPELINE_REPORT_SCHEMA = "recordstuff.pipeline-diagnostics/1";

/** The engine's stages, in the order of the pipeline (core/diagnostics.rs). */
export const ENGINE_STAGES = [
  "capture_callback", "encode_submit", "compose", "encode_latency", "write_wait", "write", "preview_compose", "preview_encode",
] as const;

export interface PagePart {
  /** Reports merged: one every 5 s while the page showed the preview, and its last at the port's release. */
  reports: number;
  received: number; drawn: number; missed: number; notDecoded: number;
  /** The most chunks waiting to be drawn and in the decoder's queue at once (plan 084); 0 in figures from before it. */
  pendingHigh: number; decodingHigh: number;
  /** The page's JavaScript heap's most in use, bytes; 0 in figures from before it. */
  heapHigh: number;
  restarts: { codec: number; error: number };
  port: HistogramJson; decode: HistogramJson;
  /** A stalled page's catching up (plan 084); empty in figures from before it. */
  recover: HistogramJson;
}

export interface PipelineSession {
  session: string;
  /** How the session ended; absent when the log holds no engine line for it (still running, or the log cut). */
  outcome?: string;
  /** When the engine's line was logged. */
  at?: string;
  stages: Record<string, HistogramJson>;
  counts: Record<string, number>;
  /** The capture host's counts: those of plan 083 and, from plan 084, its delivery's (`…High` are high-water marks). */
  host?: { previewForwarded: number; previewWithoutPort: number } & Record<string, number>;
  page?: PagePart;
}

export interface PipelineReport {
  schema: typeof PIPELINE_REPORT_SCHEMA;
  sessions: PipelineSession[];
  /** Diagnostics lines that could not be read, with why. */
  problems: string[];
}

/** A diagnostics line whose figures are JSON; the host's own `diagnostics: the engine's figures could not be read` is not one. */
const LINE = /^(?:\[(?<at>[^\]]+)\] )?(?:capture host: )?diagnostics: (?<json>\{.*?)\s*$/;

const isCounts = (value: unknown): value is Record<string, number> =>
  !!value && typeof value === "object" && Object.values(value).every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);

function engineFigures(value: unknown): { stages: Record<string, HistogramJson>; counts: Record<string, number> } | string {
  const v = value as { schema?: unknown; stages?: unknown; counts?: unknown } | null;
  if (!v || typeof v !== "object") return "no engine figures";
  if (v.schema !== PIPELINE_SCHEMA) return `engine schema ${String(v.schema)}, not ${PIPELINE_SCHEMA}`;
  if (!v.stages || typeof v.stages !== "object" || !Object.values(v.stages).every(isHistogramJson)) return "malformed engine stages";
  if (!isCounts(v.counts)) return "malformed engine counts";
  return { stages: v.stages as Record<string, HistogramJson>, counts: v.counts };
}

/** The page's figures as `StudioPreviewDiagnostics` has them (studio-port.ts, whose imports node cannot resolve here). */
function isPageFigures(value: Record<string, unknown>): value is Record<string, unknown> & Omit<PagePart, "reports"> {
  const count = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n >= 0;
  const restarts = value["restarts"] as { codec?: unknown; error?: unknown } | undefined;
  return value["schema"] === PIPELINE_SCHEMA && ["received", "drawn", "missed", "notDecoded"].every((key) => count(value[key]))
    && !!restarts && count(restarts.codec) && count(restarts.error) && isHistogramJson(value["port"]) && isHistogramJson(value["decode"]);
}

function emptyPage(): PagePart {
  return { reports: 0, received: 0, drawn: 0, missed: 0, notDecoded: 0, pendingHigh: 0, decodingHigh: 0, heapHigh: 0, restarts: { codec: 0, error: 0 }, port: emptyHistogram(), decode: emptyHistogram(), recover: emptyHistogram() };
}

function addPage(into: PagePart, page: Omit<PagePart, "reports" | "pendingHigh" | "decodingHigh" | "heapHigh" | "recover"> & Partial<PagePart>, reports = 1): PagePart {
  const high = (n: unknown): number => typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
  return {
    reports: into.reports + reports,
    received: into.received + page.received, drawn: into.drawn + page.drawn, missed: into.missed + page.missed, notDecoded: into.notDecoded + page.notDecoded,
    pendingHigh: Math.max(into.pendingHigh, high(page.pendingHigh)), decodingHigh: Math.max(into.decodingHigh, high(page.decodingHigh)),
    heapHigh: Math.max(into.heapHigh, high(page.heapHigh)),
    restarts: { codec: into.restarts.codec + page.restarts.codec, error: into.restarts.error + page.restarts.error },
    port: mergeHistograms(into.port, page.port), decode: mergeHistograms(into.decode, page.decode),
    recover: isHistogramJson(page.recover) ? mergeHistograms(into.recover, page.recover) : into.recover,
  };
}

/** Every session's figures in `lines` (the app's log, oldest first), in the order the sessions first appear. */
export function parsePipelineLog(lines: readonly string[]): PipelineReport {
  const sessions = new Map<string, PipelineSession>();
  const problems: string[] = [];
  const of = (id: string): PipelineSession => {
    let session = sessions.get(id);
    if (!session) sessions.set(id, session = { session: id, stages: {}, counts: {} });
    return session;
  };
  for (const line of lines) {
    const match = LINE.exec(line);
    if (!match?.groups) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(match.groups["json"]!) as Record<string, unknown>;
    } catch {
      problems.push(`unreadable diagnostics line: ${line.slice(0, 120)}`);
      continue;
    }
    const id = typeof record["session"] === "string" ? record["session"] : undefined;
    if (record["kind"] === "engine" && id) {
      const figures = engineFigures(record["engine"]);
      const session = of(id);
      session.outcome = typeof record["outcome"] === "string" ? record["outcome"] : "unknown";
      if (match.groups["at"]) session.at = match.groups["at"];
      const host = record["host"] as PipelineSession["host"] | undefined;
      if (isCounts(host) && typeof host.previewForwarded === "number" && typeof host.previewWithoutPort === "number") session.host = host;
      if (typeof figures === "string") problems.push(`session ${id}: ${figures}`);
      else Object.assign(session, figures);
    } else if (record["kind"] === "page" && id) {
      const page = record;
      if (!isPageFigures(page)) {
        problems.push(`session ${id}: malformed page figures`);
        continue;
      }
      const session = of(id);
      session.page = addPage(session.page ?? emptyPage(), page);
    } else if (record["kind"] === "page" || record["kind"] === "engine") {
      // A page's report with no session yet: a port joined before any session of this capture process.
      problems.push(`${String(record["kind"])} figures without a session`);
    }
  }
  return { schema: PIPELINE_REPORT_SCHEMA, sessions: [...sessions.values()], problems };
}

/** Two hosts' counts as one: added, high-water marks (`…High`) at their highest. */
function addHost(into: PipelineSession["host"], host: NonNullable<PipelineSession["host"]>): NonNullable<PipelineSession["host"]> {
  const merged: NonNullable<PipelineSession["host"]> = { ...(into ?? { previewForwarded: 0, previewWithoutPort: 0 }) };
  for (const [key, n] of Object.entries(host)) merged[key] = /High$/.test(key) ? Math.max(merged[key] ?? 0, n) : (merged[key] ?? 0) + n;
  return merged;
}

/** Several sessions as one, for a scenario run more than once: histograms and counts added, high-water marks at their highest. */
export function mergeSessions(name: string, sessions: readonly PipelineSession[]): PipelineSession {
  const merged: PipelineSession = { session: name, stages: {}, counts: {} };
  for (const s of sessions) {
    for (const [stage, h] of Object.entries(s.stages)) merged.stages[stage] = mergeHistograms(merged.stages[stage] ?? emptyHistogram(), h);
    for (const [key, n] of Object.entries(s.counts)) merged.counts[key] = /_high/.test(key) ? Math.max(merged.counts[key] ?? 0, n) : (merged.counts[key] ?? 0) + n;
    if (s.host) merged.host = addHost(merged.host, s.host);
    if (s.page) merged.page = addPage(merged.page ?? emptyPage(), s.page, s.page.reports);
  }
  return merged;
}

export interface SessionSummary {
  session: string;
  outcome?: string;
  stages: Record<string, HistogramSummary>;
  counts: Record<string, number>;
  host?: PipelineSession["host"];
  page?: Omit<PagePart, "port" | "decode" | "recover"> & { port: HistogramSummary; decode: HistogramSummary; recover: HistogramSummary };
}

export function summarizeSession(session: PipelineSession): SessionSummary {
  const stages = Object.fromEntries(Object.entries(session.stages).map(([stage, h]) => [stage, summarizeHistogram(h)]));
  return {
    session: session.session,
    ...(session.outcome ? { outcome: session.outcome } : {}),
    stages, counts: session.counts,
    ...(session.host ? { host: session.host } : {}),
    ...(session.page ? { page: { ...session.page, port: summarizeHistogram(session.page.port), decode: summarizeHistogram(session.page.decode),
      recover: summarizeHistogram(session.page.recover) } } : {}),
  };
}

const cell = (value: number | undefined): string => value === undefined ? "–" : value.toFixed(2);

/** A Markdown table of one session's stages, counts and page figures. */
export function formatSession(summary: SessionSummary): string {
  // A merged scenario has stages but no single outcome; a session without either never logged the engine's line.
  const ended = summary.outcome ? ` (${summary.outcome})` : Object.keys(summary.stages).length ? "" : " (no engine figures)";
  const out = [`#### ${summary.session}${ended}`, "",
    "| Stage | n | mean ms | p50 ms | p95 ms | max ms |", "| --- | ---: | ---: | ---: | ---: | ---: |"];
  const row = (name: string, s: HistogramSummary | undefined) => s && s.n > 0
    ? out.push(`| ${name} | ${s.n} | ${cell(s.meanMs)} | ${cell(s.p50Ms)} | ${cell(s.p95Ms)} | ${cell(s.maxMs)} |`) : undefined;
  for (const stage of ENGINE_STAGES) row(stage, summary.stages[stage]);
  for (const [stage, s] of Object.entries(summary.stages)) if (!(ENGINE_STAGES as readonly string[]).includes(stage)) row(stage, s);
  if (summary.page) {
    row("page: port (wall clock)", summary.page.port);
    row("page: decode and draw", summary.page.decode);
    row("page: recovery after a stall", summary.page.recover);
  }
  out.push("");
  const counts = Object.entries(summary.counts).map(([key, n]) => `${key} ${n}`);
  if (summary.host) {
    const snake = (key: string): string => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    counts.push(...Object.entries(summary.host).map(([key, n]) => `host ${snake(key)} ${n}`));
  }
  if (summary.page) {
    const p = summary.page;
    counts.push(`page received ${p.received}`, `page drawn ${p.drawn}`, `page missed ${p.missed}`, `page not_decoded ${p.notDecoded}`,
      `page pending_high ${p.pendingHigh}`, `page decoding_high ${p.decodingHigh}`, `page heap_high ${p.heapHigh}`,
      `page restarts codec ${p.restarts.codec} error ${p.restarts.error}`, `page reports ${p.reports}`);
  }
  if (counts.length) out.push(`Counts: ${counts.join(", ")}.`, "");
  return out.join("\n");
}
