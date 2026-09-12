/**
 * Recording quality settings (plans/007-recording-quality-settings.md) and the
 * pure arithmetic that turns them into capture constraints and encoder
 * targets. Shared by main (settings, tray, log) and the capture host (which
 * computes the actual encoder target once it knows the captured size). No
 * Electron or DOM import.
 */

export type VideoQuality = "economy" | "standard" | "high";
export type ResolutionCap = "1080p" | "1440p" | "4k" | "source";
export type FrameRate = 30 | 60;
export type AudioQuality = "standard" | "high";

export interface QualitySettings {
  videoQuality: VideoQuality;
  resolutionCap: ResolutionCap;
  frameRate: FrameRate;
  audioQuality: AudioQuality;
}

export const VIDEO_QUALITIES: readonly VideoQuality[] = ["economy", "standard", "high"];
export const RESOLUTION_CAPS: readonly ResolutionCap[] = ["1080p", "1440p", "4k", "source"];
export const FRAME_RATES: readonly FrameRate[] = [30, 60];
export const AUDIO_QUALITIES: readonly AudioQuality[] = ["standard", "high"];

/** Plan 007 defaults: standard video, source size, 30 fps, high audio. */
export const DEFAULT_QUALITY: QualitySettings = {
  videoQuality: "standard",
  resolutionCap: "source",
  frameRate: 30,
  audioQuality: "high",
};

export function isQualitySettings(value: unknown): value is QualitySettings {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (VIDEO_QUALITIES as readonly unknown[]).includes(record["videoQuality"]) &&
    (RESOLUTION_CAPS as readonly unknown[]).includes(record["resolutionCap"]) &&
    (FRAME_RATES as readonly unknown[]).includes(record["frameRate"]) &&
    (AUDIO_QUALITIES as readonly unknown[]).includes(record["audioQuality"])
  );
}

/**
 * 60 fps is offered only where plan 007 §A5 has (or can) verify it. Windows
 * stays at 30 until plan 005 measures it on a real machine; a stored 60 is
 * clamped at use, never silently rewritten in settings.json.
 */
export function isFrameRateAvailable(frameRate: FrameRate, platform: string): boolean {
  return frameRate === 30 || platform === "darwin";
}

/** What a recording started on `platform` actually asks for. */
export function effectiveQuality(settings: QualitySettings, platform: string): QualitySettings {
  return isFrameRateAvailable(settings.frameRate, platform) ? settings : { ...settings, frameRate: 30 };
}

export interface Dimensions {
  width: number;
  height: number;
}

/** Long / short edge bounds; the orientation follows the source (portrait swaps them). */
const CAP_EDGES: Record<Exclude<ResolutionCap, "source">, { long: number; short: number }> = {
  "1080p": { long: 1920, short: 1080 },
  "1440p": { long: 2560, short: 1440 },
  "4k": { long: 3840, short: 2160 },
};

/** H.264 4:2:0 wants even dimensions. */
function even(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/**
 * Largest size within the cap that keeps the source aspect ratio. Never
 * upscales; an ultra-wide source is limited by the width bound, a portrait
 * source by the swapped bounds.
 */
export function fitWithinCap(source: Dimensions, cap: ResolutionCap): Dimensions {
  if (cap === "source") return source;
  const edges = CAP_EDGES[cap];
  const landscape = source.width >= source.height;
  const maxWidth = landscape ? edges.long : edges.short;
  const maxHeight = landscape ? edges.short : edges.long;
  const scale = Math.min(1, maxWidth / source.width, maxHeight / source.height);
  if (scale >= 1) return source;
  return { width: Math.max(2, even(source.width * scale)), height: Math.max(2, even(source.height * scale)) };
}

/**
 * Encoder target in bits per pixel per frame. `standard` at 1080p30 lands on
 * the 8 Mbps the first version shipped with, so the baseline is unchanged;
 * the other two are the plan 007 §A starting points, to be tuned against
 * real recordings.
 */
export const BITS_PER_PIXEL: Record<VideoQuality, number> = {
  economy: 0.07,
  standard: 0.13,
  high: 0.24,
};

export const VIDEO_BITRATE_MIN = 1_500_000;
export const VIDEO_BITRATE_MAX = 60_000_000;

/** Rounded to 100 kbps so log lines and comparisons stay readable. */
export function videoBitsPerSecond(size: Dimensions, frameRate: number, quality: VideoQuality): number {
  const raw = size.width * size.height * frameRate * BITS_PER_PIXEL[quality];
  const rounded = Math.round(raw / 100_000) * 100_000;
  return Math.min(VIDEO_BITRATE_MAX, Math.max(VIDEO_BITRATE_MIN, rounded));
}

export const AUDIO_BITRATES: Record<AudioQuality, number> = {
  standard: 192_000,
  high: 256_000,
};

export function audioBitsPerSecond(quality: AudioQuality): number {
  return AUDIO_BITRATES[quality];
}

/**
 * What the capture host observed and asked the encoder for, reported in
 * `started`. Track settings the platform did not expose are left undefined
 * and logged as unknown; the bitrates are targets, not measured output.
 */
export interface CaptureReport {
  width?: number;
  height?: number;
  frameRate?: number;
  sampleRate?: number;
  channelCount?: number;
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  /** Non-fatal problems while applying the settings (e.g. a rejected constraint). */
  warnings: string[];
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

export function isCaptureReport(value: unknown): value is CaptureReport {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isOptionalFiniteNumber(record["width"]) &&
    isOptionalFiniteNumber(record["height"]) &&
    isOptionalFiniteNumber(record["frameRate"]) &&
    isOptionalFiniteNumber(record["sampleRate"]) &&
    isOptionalFiniteNumber(record["channelCount"]) &&
    typeof record["videoBitsPerSecond"] === "number" &&
    Number.isFinite(record["videoBitsPerSecond"]) &&
    typeof record["audioBitsPerSecond"] === "number" &&
    Number.isFinite(record["audioBitsPerSecond"]) &&
    Array.isArray(record["warnings"]) &&
    record["warnings"].every((w) => typeof w === "string")
  );
}

/**
 * A clear frame-rate downgrade: 60 was requested and the track settled on a
 * rate at or below 30. Plan 007 requires telling the user, not just the log.
 * Fewer frames because the content is static is not a downgrade, so anything
 * the track does not report, or reports above 30, is not flagged.
 */
export function frameRateDowngrade(requested: QualitySettings, report: CaptureReport): number | undefined {
  if (requested.frameRate !== 60) return undefined;
  if (report.frameRate === undefined || report.frameRate > 30) return undefined;
  return Math.round(report.frameRate);
}

const unknown = (value: number | undefined, unit = ""): string => (value === undefined ? "未知" : `${value}${unit}`);

/** One log line per session (plan 007 §A1); target bitrates are labelled as such. */
export function describeCapture(requested: QualitySettings, report: CaptureReport): string {
  const size = report.width === undefined || report.height === undefined ? "未知" : `${report.width}x${report.height}`;
  const parts = [
    `requested video=${requested.videoQuality} cap=${requested.resolutionCap} fps=${requested.frameRate} audio=${requested.audioQuality}`,
    `track size=${size} fps=${unknown(report.frameRate)} sampleRate=${unknown(report.sampleRate, " Hz")} channels=${unknown(report.channelCount)}`,
    `target videoBps=${report.videoBitsPerSecond} audioBps=${report.audioBitsPerSecond}`,
  ];
  if (report.warnings.length > 0) parts.push(`warnings: ${report.warnings.join("; ")}`);
  return parts.join("; ");
}
