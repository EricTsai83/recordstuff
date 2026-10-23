/**
 * What goes over the Recording Studio's port (plan 081): main gives the capture process one end of a channel and the
 * Settings page the other while the page shows the recording's preview or meters, so neither the preview's chunks
 * (preview-stream.ts) nor its levels pass through main. The page tells the capture process on it how often to show
 * the preview.
 */
import { PIPELINE_SCHEMA, isHistogramJson, type HistogramJson } from "./pipeline-histogram";

/** How often the Studio shows its preview and meters while someone works in it (D21), and while it is only looked at (plan 081, D1). */
export const STUDIO_FPS = 10;
export const STUDIO_RESTING_FPS = 5;
/** How long the full rate lasts after a key, click or scroll in the Studio with the pointer outside it (studio-pace.ts). */
export const STUDIO_ACTIVE_MS = 3000;

/** The inputs' loudest samples since the last, linear, before muting (plan 075, D19): from the capture process. */
export interface StudioLevelsMessage { type: "levels"; system: number; microphone?: number }
/** The preview's frames a second the page asks for: from the page. */
export interface StudioRateMessage { type: "rate"; fps: typeof STUDIO_FPS | typeof STUDIO_RESTING_FPS }

const isLevel = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 16;

export function isStudioLevels(value: unknown): value is StudioLevelsMessage {
  const m = value as Partial<StudioLevelsMessage> | null;
  return !!m && typeof m === "object" && m.type === "levels" && isLevel(m.system) && (m.microphone === undefined || isLevel(m.microphone));
}

export function isStudioRate(value: unknown): value is StudioRateMessage {
  const m = value as Partial<StudioRateMessage> | null;
  return !!m && typeof m === "object" && m.type === "rate" && (m.fps === STUDIO_FPS || m.fps === STUDIO_RESTING_FPS);
}

/** How often the page reports its preview figures when asked (plan 083). */
export const STUDIO_DIAGNOSTICS_MS = 5000;
/**
 * The capture process asks the page for its preview figures (plan 083): only under the development switch
 * `RECORDSTUFF_DIAGNOSTICS=1`; until asked the page keeps none.
 */
export interface StudioDiagnosticsRequest { type: "diagnostics"; everyMs: number }
/**
 * The page's preview figures since its last report (plan 083): chunks received, drawn, never received (a gap in their
 * numbers) and received but not decoded (no decoder yet, or waiting for a key frame); decoder restarts by cause; the
 * port's delay (the capture process's send to the page's receipt, both `Date.now()` on this machine's wall clock, so
 * whole milliseconds) and decoding with drawing (receipt to drawn into the canvas, which is not yet on the screen).
 */
export interface StudioPreviewDiagnostics {
  type: "previewDiagnostics"; schema: typeof PIPELINE_SCHEMA;
  received: number; drawn: number; missed: number; notDecoded: number;
  restarts: { codec: number; error: number };
  port: HistogramJson; decode: HistogramJson;
}

export function isStudioDiagnosticsRequest(value: unknown): value is StudioDiagnosticsRequest {
  const m = value as Partial<StudioDiagnosticsRequest> | null;
  return !!m && typeof m === "object" && m.type === "diagnostics" && typeof m.everyMs === "number" && Number.isInteger(m.everyMs) && m.everyMs >= 1000;
}

export function isStudioPreviewDiagnostics(value: unknown): value is StudioPreviewDiagnostics {
  const m = value as Partial<StudioPreviewDiagnostics> | null;
  const count = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n >= 0;
  return !!m && typeof m === "object" && m.type === "previewDiagnostics" && m.schema === PIPELINE_SCHEMA
    && count(m.received) && count(m.drawn) && count(m.missed) && count(m.notDecoded)
    && !!m.restarts && count(m.restarts.codec) && count(m.restarts.error) && isHistogramJson(m.port) && isHistogramJson(m.decode);
}
