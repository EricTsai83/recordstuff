/**
 * Recording quality settings (docs/system-design/recording.md) and the
 * pure arithmetic that turns them into capture constraints and encoder
 * targets. Shared by main (settings, tray, log) and the capture host (which
 * computes the actual encoder target once it knows the captured size). No
 * Electron or DOM import.
 */

export const VIDEO_QUALITIES = ["economy", "standard", "high"] as const;
export const RESOLUTION_CAPS = ["1080p", "1440p", "4k", "source"] as const;
export const FRAME_RATES = [30, 60] as const;

export type VideoQuality = (typeof VIDEO_QUALITIES)[number];
export type ResolutionCap = (typeof RESOLUTION_CAPS)[number];
export type FrameRate = (typeof FRAME_RATES)[number];

export interface QualitySettings {
  videoQuality: VideoQuality;
  resolutionCap: ResolutionCap;
  frameRate: FrameRate;
}

/** Recording defaults: standard video, source size, 30 fps. */
export const DEFAULT_QUALITY: QualitySettings = {
  videoQuality: "standard",
  resolutionCap: "source",
  frameRate: 30,
};

export function isQualitySettings(value: unknown): value is QualitySettings {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (VIDEO_QUALITIES as readonly unknown[]).includes(record["videoQuality"]) &&
    (RESOLUTION_CAPS as readonly unknown[]).includes(record["resolutionCap"]) &&
    (FRAME_RATES as readonly unknown[]).includes(record["frameRate"])
  );
}

/**
 * 60 fps is enabled only on the verified macOS platform. Other platforms
 * remain unverified and use 30 fps. A stored 60 is clamped at use, never
 * silently rewritten in settings.json.
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
 * the 8 Mbps the first version shipped with, so the baseline is unchanged.
 * Local verification (2026-09-13, macOS 26 / Electron 44, 1920x1080) measured the
 * encoder honouring these targets within 2% at 30 fps for all three levels
 * (4.4 / 8.1 / 14.9 Mbps); at 60 fps Chromium delivered about twice the
 * target (31 Mbps for 16.2). The native engine (plan 076) delivers 101–102% of
 * the target at 30 and 60 fps. The values are kept; whether they *look* right
 * is the subjective comparison tracked in docs/verification/measurements/.
 */
const BITS_PER_PIXEL: Record<VideoQuality, number> = {
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

/**
 * One AAC target for every recording. Early measurements with voice processing
 * enabled delivered about 160 kbps for both 192 k and 256 k requests, so the
 * former audio-quality selector was removed. Explicitly disabling capture
 * voice processing later restored spectral fidelity and stereo separation;
 * bitrate still depends on the encoder/content and is not a fidelity metric.
 * Old settings.json audioQuality keys remain ignored.
 */
export const AUDIO_BITS_PER_SECOND = 256_000;

/**
 * About how many bytes one minute takes: the encoder targets above plus audio. The native engine delivers 101–102%
 * of its video target at 30 and 60 fps (8.25–8.28 of 8.10 Mbps, 15.11–15.19 of 14.90, 16.33–16.47 of 16.20; plan
 * 078), so the target is the estimate at both rates; a still screen records smaller. Chromium's twice the target at
 * 60 fps, which the estimate doubled for, went with it (plan 076).
 */
export function estimatedBytesPerMinute(size: Dimensions, quality: QualitySettings): number {
  const video = videoBitsPerSecond(size, quality.frameRate, quality.videoQuality);
  return (video + AUDIO_BITS_PER_SECOND) * 60 / 8;
}

/**
 * "400 KB", "62 MB", "480 MB", "1.2 GB": decimal units, as Finder shows file sizes, two significant figures at most.
 * The unit follows the rounded value, so 999.6 KB reads "1 MB", 999.6 MB "1.0 GB" and 9.97 GB "10 GB", never
 * "1000 MB" or "10.0 GB". A short clip in the Recordings tab is not "1 MB".
 */
export function formatBytes(bytes: number): string {
  const kb = bytes / 1e3;
  const roundedKb = kb >= 100 ? Math.round(kb / 10) * 10 : Math.round(kb);
  if (roundedKb < 1000) return `${roundedKb} KB`;
  const mb = bytes / 1e6;
  const roundedMb = mb >= 100 ? Math.round(mb / 10) * 10 : Math.round(mb);
  if (roundedMb < 1000) return `${roundedMb} MB`;
  const tenthsGb = Math.round(mb / 100) / 10;
  return tenthsGb >= 10 ? `${Math.round(mb / 1000)} GB` : `${tenthsGb.toFixed(1)} GB`;
}

/**
 * What the capture host observed and asked the encoder for, reported in
 * `prepared`. Track settings the platform did not expose are left undefined
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
  /** The microphone mixed into the track, by the name of the device the engine opened (plan 074); absent without one. */
  microphone?: string;
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
    record["warnings"].every((w) => typeof w === "string") &&
    (record["microphone"] === undefined || typeof record["microphone"] === "string")
  );
}

const unknown = (value: number | undefined, unit = ""): string => (value === undefined ? "unknown" : `${value}${unit}`);

/** One log line per session; target bitrates are labelled as such. */
export function describeCapture(requested: QualitySettings, report: CaptureReport): string {
  const size = report.width === undefined || report.height === undefined ? "unknown" : `${report.width}x${report.height}`;
  const parts = [
    `requested video=${requested.videoQuality} cap=${requested.resolutionCap} fps=${requested.frameRate}`,
    `track size=${size} fps=${unknown(report.frameRate)} sampleRate=${unknown(report.sampleRate, " Hz")} channels=${unknown(report.channelCount)}`,
    `target videoBps=${report.videoBitsPerSecond} audioBps=${report.audioBitsPerSecond}`,
  ];
  if (report.warnings.length > 0) parts.push(`warnings: ${report.warnings.join("; ")}`);
  return parts.join("; ");
}
