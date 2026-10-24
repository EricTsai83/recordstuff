/**
 * What goes over the Recording Studio's port (plan 081): main gives the capture process one end of a channel and the
 * Settings page the other while the page shows the recording's preview or meters, so neither the preview's chunks
 * (preview-stream.ts) nor its levels pass through main. The page tells the capture process on it how often to show
 * the preview.
 */
import { PIPELINE_SCHEMA, isHistogramJson, type HistogramJson } from "./pipeline-histogram";

import { STUDIO_FPS, STUDIO_RATES, STUDIO_SMOOTH_FPS, type StudioFps } from "./studio-rates";
import { STUDIO_STALL_MAX_MS } from "./studio-stall";

export { STUDIO_ACTIVE_MS, STUDIO_FPS, STUDIO_RATES, STUDIO_RESTING_FPS, STUDIO_SMOOTH_FPS, type StudioFps } from "./studio-rates";

/**
 * The Studio's preview rate (plan 092, D1), one persisted choice for a Live preview and a recording alike: Off (the
 * default: no preview is composed, encoded or drawn, and the Studio opens no camera of its own), Power saving (5 a
 * second while only looked at, 10 while someone works in it), Standard (10) and Smooth (15).
 */
export const STUDIO_PREVIEW_RATES = ["off", "power", "standard", "smooth"] as const;
export type StudioPreviewRate = (typeof STUDIO_PREVIEW_RATES)[number];
/**
 * What the preview shows (plan 092, D3; plan 094, D1): the composed picture, the screen without the camera, or the camera
 * alone, enlarged at the bubble's shape; never the recording's.
 */
export const STUDIO_VIEWS = ["composed", "screen", "camera"] as const;
export type StudioView = (typeof STUDIO_VIEWS)[number];
/** The choice as stored: the rate and the view. */
export interface StudioPreviewSettings { rate: StudioPreviewRate; view: StudioView }
export const DEFAULT_STUDIO_PREVIEW: StudioPreviewSettings = { rate: "off", view: "composed" };
/** The one rate of a choice that holds one; Power saving's follows the Studio's use (studio-pace.ts), Off has none. */
export const FIXED_STUDIO_FPS: Partial<Record<StudioPreviewRate, StudioFps>> = { standard: STUDIO_FPS, smooth: STUDIO_SMOOTH_FPS };

export const isStudioPreviewRate = (value: unknown): value is StudioPreviewRate => STUDIO_PREVIEW_RATES.includes(value as StudioPreviewRate);
export const isStudioView = (value: unknown): value is StudioView => STUDIO_VIEWS.includes(value as StudioView);

export function isStudioPreviewSettings(value: unknown): value is StudioPreviewSettings {
  const m = value as { rate?: unknown; view?: unknown } | null;
  return !!m && typeof m === "object" && !Array.isArray(m) && isStudioPreviewRate(m.rate) && isStudioView(m.view);
}

/** The inputs' loudest samples since the last, linear, before muting (plan 075, D19): from the capture process. */
export interface StudioLevelsMessage { type: "levels"; system: number; microphone?: number }
/** The preview's frames a second the page asks for: from the page. */
export interface StudioRateMessage { type: "rate"; fps: StudioFps }
/** What the preview shows (plan 092, D3), from a key frame: from the page. */
export interface StudioViewMessage { type: "view"; view: StudioView }

/**
 * The last preview chunk the page is done with, by its number (`PreviewMessage.n`): drawn, or dropped by the page
 * (plan 084). From the page, at most once a chunk; the capture host posts no more than a few chunks beyond it.
 */
export interface StudioDrawnMessage {
  type: "drawn"; through: number;
  /** The page dropped its decoder (a gap, a decoding error, a decoder fallen behind) and takes nothing until a key frame. */
  key?: true;
}

const isLevel = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 16;

export function isStudioLevels(value: unknown): value is StudioLevelsMessage {
  const m = value as Partial<StudioLevelsMessage> | null;
  return !!m && typeof m === "object" && m.type === "levels" && isLevel(m.system) && (m.microphone === undefined || isLevel(m.microphone));
}

export function isStudioRate(value: unknown): value is StudioRateMessage {
  const m = value as Partial<StudioRateMessage> | null;
  return !!m && typeof m === "object" && m.type === "rate" && STUDIO_RATES.includes(m.fps as StudioFps);
}

/**
 * The preview chunks posted and not yet acknowledged that the capture host allows (plan 084, preview-delivery.ts), and
 * the most the page keeps waiting to be drawn or in its decoder's queue (preview-decoder.ts): a page drawing at 15 a
 * second answers well within three. A single chunk larger than the bytes' limit still goes when none is outstanding.
 */
export const PREVIEW_OUTSTANDING_CHUNKS = 3;
export const PREVIEW_OUTSTANDING_BYTES = 512 * 1024;

export function isStudioDrawn(value: unknown): value is StudioDrawnMessage {
  const m = value as Partial<StudioDrawnMessage> | null;
  return !!m && typeof m === "object" && m.type === "drawn" && typeof m.through === "number" && Number.isSafeInteger(m.through) && m.through >= 0
    && (m.key === undefined || m.key === true);
}

export function isStudioViewMessage(value: unknown): value is StudioViewMessage {
  const m = value as Partial<StudioViewMessage> | null;
  return !!m && typeof m === "object" && m.type === "view" && isStudioView(m.view);
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
  /** The most chunks waiting in `pending` and in the decoder's queue at once (plan 084). */
  pendingHigh: number; decodingHigh: number;
  /** The most of the page's JavaScript heap in use when a chunk came, in bytes (plan 084); 0 where Chromium does not say. */
  heapHigh: number;
  restarts: { codec: number; error: number };
  port: HistogramJson; decode: HistogramJson;
  /** From the first chunk received over a second after it was sent to the first drawn within one (plan 084). */
  recover: HistogramJson;
}

export function isStudioDiagnosticsRequest(value: unknown): value is StudioDiagnosticsRequest {
  const m = value as Partial<StudioDiagnosticsRequest> | null;
  return !!m && typeof m === "object" && m.type === "diagnostics" && typeof m.everyMs === "number" && Number.isInteger(m.everyMs) && m.everyMs >= 1000;
}

export function isStudioPreviewDiagnostics(value: unknown): value is StudioPreviewDiagnostics {
  const m = value as Partial<StudioPreviewDiagnostics> | null;
  const count = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n >= 0;
  return !!m && typeof m === "object" && m.type === "previewDiagnostics" && m.schema === PIPELINE_SCHEMA
    && count(m.received) && count(m.drawn) && count(m.missed) && count(m.notDecoded) && count(m.pendingHigh) && count(m.decodingHigh) && count(m.heapHigh)
    && !!m.restarts && count(m.restarts.codec) && count(m.restarts.error) && isHistogramJson(m.port) && isHistogramJson(m.decode) && isHistogramJson(m.recover);
}

export { STUDIO_STALL_ENV, STUDIO_STALL_MAX_MS, studioStallOf } from "./studio-stall";

/** The capture process asks the page to stall (plan 084's development switch, studio-stall.ts). */
export interface StudioStallRequest { type: "stall"; ms: number }

export function isStudioStallRequest(value: unknown): value is StudioStallRequest {
  const m = value as Partial<StudioStallRequest> | null;
  return !!m && typeof m === "object" && m.type === "stall" && typeof m.ms === "number" && Number.isInteger(m.ms) && m.ms > 0 && m.ms <= STUDIO_STALL_MAX_MS;
}
