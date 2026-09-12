/**
 * Pure logic for the recording verification toolkit
 * (plans/008-recording-verification-toolkit.md §A): parse the app's `capture:`
 * log lines, turn ffprobe / ffmpeg output into numbers, judge them against
 * the threshold table and format the result. No I/O here; everything that
 * runs a process lives in `media-tools.ts`. Development only, never shipped.
 */
import {
  RESOLUTION_CAPS,
  fitWithinCap,
  isQualitySettings,
  type Dimensions,
  type QualitySettings,
  type ResolutionCap,
} from "../../src/shared/quality.ts";

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

export interface TrackReport {
  width?: number;
  height?: number;
  frameRate?: number;
  sampleRate?: number;
  channelCount?: number;
}

/** One `recorder: session <id> capture: …` line (plan 007 §A1). */
export interface CaptureLogEntry {
  sessionId: string;
  requested: QualitySettings;
  track: TrackReport;
  targetVideoBps: number;
  targetAudioBps: number;
  warnings: string | undefined;
}

const numberOrUndefined = (text: string | undefined): number | undefined => {
  if (text === undefined || text === "未知") return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
};

export function parseCaptureLine(line: string): CaptureLogEntry | undefined {
  const match =
    /recorder: session (\S+) capture: requested video=(\S+) cap=(\S+) fps=(\S+) audio=(\S+); track size=(\S+) fps=(\S+) sampleRate=(\S+)(?: Hz)? channels=(\S+); target videoBps=(\d+) audioBps=(\d+)(?:; warnings: (.*))?$/.exec(
      line,
    );
  if (!match) return undefined;
  const [, sessionId, video, cap, fps, audio, size, trackFps, sampleRate, channels, videoBps, audioBps, warnings] = match;
  const requested = { videoQuality: video, resolutionCap: cap, frameRate: Number(fps), audioQuality: audio };
  if (!isQualitySettings(requested)) return undefined;
  const track: TrackReport = {};
  const sizeMatch = size === undefined ? undefined : /^(\d+)x(\d+)$/.exec(size);
  if (sizeMatch) {
    track.width = Number(sizeMatch[1]);
    track.height = Number(sizeMatch[2]);
  }
  const frameRate = numberOrUndefined(trackFps);
  if (frameRate !== undefined) track.frameRate = frameRate;
  const rate = numberOrUndefined(sampleRate);
  if (rate !== undefined) track.sampleRate = rate;
  const channelCount = numberOrUndefined(channels);
  if (channelCount !== undefined) track.channelCount = channelCount;
  return {
    sessionId: sessionId ?? "",
    requested,
    track,
    targetVideoBps: Number(videoBps),
    targetAudioBps: Number(audioBps),
    warnings,
  };
}

/**
 * Pair every saved (or kept partial) file with the `capture:` line of the
 * session that produced it. Sessions are sequential, but a failure's
 * `failed: … (kept …)` line is written only after the partial file is closed
 * (review F5): if the next session starts meanwhile, its `capture:` line comes
 * first. So each session is tracked: `recorder: session <id> failed:` marks
 * it failed, `saved` goes to the latest non-failed session, and a `kept`
 * path goes to the earliest failed session still without a file. Keys are
 * file basenames because the log holds absolute paths of the machine that
 * recorded, while the verifier may be handed a copied file.
 */
export function pairRecordingsWithLog(logText: string): Map<string, CaptureLogEntry> {
  const pairs = new Map<string, CaptureLogEntry>();
  const sessions: { entry: CaptureLogEntry; failed: boolean; paired: boolean }[] = [];
  for (const raw of logText.split(/\r?\n/)) {
    const line = raw.replace(/^\[[^\]]*\]\s*/, "");
    const capture = parseCaptureLine(line);
    if (capture) {
      sessions.push({ entry: capture, failed: false, paired: false });
      continue;
    }
    const failedSession = /^recorder: session (\S+) failed:/.exec(line);
    if (failedSession) {
      const session = sessions.find((s) => s.entry.sessionId === failedSession[1] && !s.paired);
      if (session) session.failed = true;
      continue;
    }
    const saved = /^saved (.+)$/.exec(line);
    if (saved?.[1] !== undefined) {
      const session = [...sessions].reverse().find((s) => !s.failed && !s.paired);
      if (session) {
        session.paired = true;
        pairs.set(basename(saved[1]), session.entry);
      }
      continue;
    }
    // `failed: <code> <detail>[ (kept <path>)]` closes the earliest failed
    // session: with a kept path it is paired, without one (nothing was
    // written) it is simply retired so a later kept file is not misassigned.
    const failedLine = /^failed: /.test(line);
    if (failedLine) {
      const kept = /\(kept (.+)\)$/.exec(line);
      const session = sessions.find((s) => s.failed && !s.paired);
      if (session) {
        session.paired = true;
        if (kept?.[1] !== undefined) pairs.set(basename(kept[1]), session.entry);
      }
    }
  }
  return pairs;
}

/** The app's own verdict lines written by `runAutoRecord`; the last of each kind wins. */
export function parseAutorecordOutcome(logText: string): { saved?: string; failed?: string } {
  const outcome: { saved?: string; failed?: string } = {};
  for (const line of logText.split(/\r?\n/)) {
    const saved = /autorecord: saved (.+)$/.exec(line);
    const failed = /autorecord: failed: (.+)$/.exec(line);
    if (saved?.[1]) outcome.saved = saved[1];
    if (failed?.[1]) outcome.failed = failed[1];
  }
  return outcome;
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

// ---------------------------------------------------------------------------
// ffprobe / ffmpeg output
// ---------------------------------------------------------------------------

/** The subset of `ffprobe -show_format -show_streams -count_frames -of json` we read. */
export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_read_frames?: string;
  bit_rate?: string;
  duration?: string;
  start_time?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
}

export interface ProbeInfo {
  format: { duration?: string; bit_rate?: string; size?: string };
  streams: ProbeStream[];
}

export function parseRatio(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const [num, den] = text.split("/").map(Number);
  if (num === undefined || !Number.isFinite(num)) return undefined;
  return den ? num / den : num;
}

/** `ffprobe -show_entries frame=pts_time -of csv=p=0` prints one pts per line (a trailing comma is allowed). */
export function parseFrameTimes(csv: string): number[] {
  const times: number[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const first = line.split(",")[0]?.trim();
    if (!first) continue;
    const value = Number(first);
    if (Number.isFinite(value)) times.push(value);
  }
  return times.sort((a, b) => a - b);
}

export interface FrameStats {
  /** Frames seen in the sampled interval(s). */
  frames: number;
  /** Frames the timestamps say are missing (gap ≈ n × expected → n − 1 dropped). */
  dropped: number;
  /** dropped ÷ (frames + dropped); 0 when nothing was sampled. */
  dropRate: number;
  /** Largest gap between consecutive frames, in milliseconds. */
  maxGapMs: number;
}

/**
 * Drops from presentation timestamps: a gap longer than 1.5× the nominal
 * interval counts as `round(gap / interval) − 1` missing frames. Several
 * sampled intervals (head and tail of a long file) are evaluated separately
 * so the jump between them is not mistaken for a drop.
 */
export function frameStats(intervals: number[][], fps: number): FrameStats {
  const expected = 1 / fps;
  let frames = 0;
  let dropped = 0;
  let maxGap = 0;
  for (const times of intervals) {
    frames += times.length;
    for (let i = 1; i < times.length; i += 1) {
      const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
      maxGap = Math.max(maxGap, gap);
      if (gap > expected * 1.5) dropped += Math.round(gap / expected) - 1;
    }
  }
  const total = frames + dropped;
  return { frames, dropped, dropRate: total === 0 ? 0 : dropped / total, maxGapMs: maxGap * 1000 };
}

/**
 * ffmpeg closes a still-open black / silent interval at EOF and prints an
 * end for it too (review F1); that is not a flash or beep. Anything within
 * `EOF_CLOSURE_SECONDS` of the stream end is dropped when the duration is known.
 */
export const EOF_CLOSURE_SECONDS = 0.1;

function dropEofClosures(times: number[], durationSeconds: number | undefined): number[] {
  if (durationSeconds === undefined) return times;
  return times.filter((t) => t < durationSeconds - EOF_CLOSURE_SECONDS);
}

/** `blackdetect` prints `black_start:… black_end:… black_duration:…`; black_end is when the flash begins. */
export function parseBlackdetect(stderr: string, durationSeconds?: number): number[] {
  const ends: number[] = [];
  for (const match of stderr.matchAll(/black_end:\s*([\d.]+)/g)) ends.push(Number(match[1]));
  return dropEofClosures(ends, durationSeconds);
}

/** `silencedetect` prints `silence_end: … | silence_duration: …`; silence_end is when the beep begins. */
export function parseSilencedetect(stderr: string, durationSeconds?: number): number[] {
  const ends: number[] = [];
  for (const match of stderr.matchAll(/silence_end:\s*([\d.]+)/g)) ends.push(Number(match[1]));
  return dropEofClosures(ends, durationSeconds);
}

/**
 * `astats` summary: per-channel `RMS level dB` lines follow each `Channel: n`
 * line; the `Overall` block comes last and is ignored. `-inf` means digital
 * silence.
 */
export function parseChannelRms(stderr: string): number[] {
  const levels: number[] = [];
  let inChannel = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/\bChannel:\s*\d+/.test(line)) {
      inChannel = true;
      continue;
    }
    if (/\bOverall\b/.test(line)) inChannel = false;
    const match = inChannel ? /RMS level dB:\s*(-?[\d.]+|-inf|inf|nan)/.exec(line) : null;
    if (match) {
      const text = match[1] ?? "";
      levels.push(text === "-inf" ? Number.NEGATIVE_INFINITY : Number(text));
      inChannel = false;
    }
  }
  return levels;
}

export interface SyncStats {
  /** Flash/beep pairs that matched within the search window. */
  pairs: number;
  /** Median of (beep − flash) over all pairs, ms; positive = audio late. */
  medianOffsetMs: number;
  /** Median over the first / last `windowSeconds` of the file, ms. */
  headOffsetMs: number | undefined;
  tailOffsetMs: number | undefined;
  /** tail − head, ms; undefined when either side has no pairs. */
  driftMs: number | undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return Number.NaN;
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Fewer matched pairs than this is noise (a single EOF closure, a stray frame), not a measurement. */
export const MIN_SYNC_PAIRS = 3;

/**
 * Match every flash to the nearest beep within ±`windowMs`. The material page
 * fires both once per second on the same audio clock, so the offset is the
 * recording pipeline's audio-minus-video latency. Head and tail windows are
 * the first and the actual last `edgeSeconds` of the recording (review F2:
 * anchored to `durationSeconds`, not to the last marker found), and the
 * drift is their difference; a window with too few pairs yields no drift.
 */
export function syncStats(
  flashTimes: number[],
  beepTimes: number[],
  options: { windowMs?: number; edgeSeconds?: number; durationSeconds?: number } = {},
): SyncStats | undefined {
  const windowMs = options.windowMs ?? 400;
  const edge = options.edgeSeconds ?? 60;
  const beeps = [...beepTimes].sort((a, b) => a - b);
  const offsets: { at: number; offsetMs: number }[] = [];
  for (const flash of flashTimes) {
    let best: number | undefined;
    for (const beep of beeps) {
      const delta = (beep - flash) * 1000;
      if (Math.abs(delta) <= windowMs && (best === undefined || Math.abs(delta) < Math.abs(best))) best = delta;
    }
    if (best !== undefined) offsets.push({ at: flash, offsetMs: best });
  }
  if (offsets.length < MIN_SYNC_PAIRS) return undefined;
  const end = options.durationSeconds ?? Math.max(...flashTimes, ...beeps);
  const head = offsets.filter((o) => o.at < edge).map((o) => o.offsetMs);
  const tail = offsets.filter((o) => o.at >= end - edge).map((o) => o.offsetMs);
  const headOffsetMs = head.length >= MIN_SYNC_PAIRS ? median(head) : undefined;
  const tailOffsetMs = tail.length >= MIN_SYNC_PAIRS ? median(tail) : undefined;
  const windowsDistinct = end >= edge * 2;
  return {
    pairs: offsets.length,
    medianOffsetMs: median(offsets.map((o) => o.offsetMs)),
    headOffsetMs,
    tailOffsetMs,
    driftMs: headOffsetMs !== undefined && tailOffsetMs !== undefined && windowsDistinct ? tailOffsetMs - headOffsetMs : undefined,
  };
}

// ---------------------------------------------------------------------------
// Measurement → judgement
// ---------------------------------------------------------------------------

/** Everything measured from one file; `undefined` means the tool could not tell. */
export interface Measurement {
  file: string;
  fileBytes: number;
  durationSeconds: number | undefined;
  video:
    | {
        codec: string | undefined;
        width: number;
        height: number;
        frames: number | undefined;
        durationSeconds: number | undefined;
        startTime: number | undefined;
        bitsPerSecond: number | undefined;
        pixelFormat: string | undefined;
      }
    | undefined;
  audio:
    | {
        codec: string | undefined;
        sampleRate: number | undefined;
        channels: number | undefined;
        durationSeconds: number | undefined;
        startTime: number | undefined;
        bitsPerSecond: number | undefined;
        /** RMS per channel in dBFS, when ffmpeg was available. */
        channelRmsDb: number[] | undefined;
      }
    | undefined;
  frames: FrameStats | undefined;
  /** Only when `--sync` ran against the test material and found marker pairs. */
  sync: SyncStats | undefined;
  /** `--sync` ran; with `sync` undefined it means no flash / beep pairs were found. */
  syncAttempted: boolean;
  /** ffprobe decoded every frame without complaint. */
  decodable: boolean;
  decodeErrors: string | undefined;
  /** From the matrix runner; ps %cpu summed over the Electron processes. */
  cpu: { averagePercent: number; peakPercent: number } | undefined;
}

/**
 * Build the measurement from probe output. `frameIntervals` are the sampled
 * pts lists (whole file, or head + tail for a long one).
 */
export function measure(
  file: string,
  fileBytes: number,
  info: ProbeInfo,
  frameIntervals: number[][],
  extras: {
    channelRmsDb?: number[];
    sync?: SyncStats;
    syncAttempted?: boolean;
    decodeErrors?: string;
    cpu?: { averagePercent: number; peakPercent: number };
    nominalFps?: number;
  } = {},
): Measurement {
  const video = info.streams.find((s) => s.codec_type === "video");
  const audio = info.streams.find((s) => s.codec_type === "audio");
  const duration = numberOrUndefined(info.format.duration);
  const totalBps = numberOrUndefined(info.format.bit_rate) ?? (duration ? (fileBytes * 8) / duration : undefined);
  const audioBps = numberOrUndefined(audio?.bit_rate);
  // Fragmented MP4 from MediaRecorder rarely carries a per-stream bit_rate;
  // fall back to "everything that is not audio".
  const videoBps =
    numberOrUndefined(video?.bit_rate) ?? (totalBps !== undefined && audioBps !== undefined ? totalBps - audioBps : undefined);
  const frames = numberOrUndefined(video?.nb_read_frames);
  const nominal = extras.nominalFps ?? parseRatio(video?.r_frame_rate) ?? 30;
  return {
    file,
    fileBytes,
    durationSeconds: duration,
    video:
      video && video.width !== undefined && video.height !== undefined
        ? {
            codec: video.codec_name,
            width: video.width,
            height: video.height,
            frames,
            durationSeconds: numberOrUndefined(video.duration) ?? duration,
            startTime: numberOrUndefined(video.start_time),
            bitsPerSecond: videoBps,
            pixelFormat: video.pix_fmt,
          }
        : undefined,
    audio: audio
      ? {
          codec: audio.codec_name,
          sampleRate: numberOrUndefined(audio.sample_rate),
          channels: audio.channels,
          durationSeconds: numberOrUndefined(audio.duration) ?? duration,
          startTime: numberOrUndefined(audio.start_time),
          bitsPerSecond: audioBps,
          channelRmsDb: extras.channelRmsDb,
        }
      : undefined,
    frames: frameIntervals.length > 0 ? frameStats(frameIntervals, nominal) : undefined,
    sync: extras.sync,
    syncAttempted: extras.syncAttempted ?? false,
    decodable: extras.decodeErrors === undefined || extras.decodeErrors.trim() === "",
    decodeErrors: extras.decodeErrors && extras.decodeErrors.trim() !== "" ? extras.decodeErrors.trim() : undefined,
    cpu: extras.cpu,
  };
}

/** The threshold table of plan 008; a change here must be mirrored in the plan file. */
export const THRESHOLDS = {
  fpsToleranceFps: 2,
  maxDropRate: 0.02,
  maxDurationDiffMs: 100,
  maxStartOffsetMs: 50,
  maxDriftMs: 100,
  sampleRateHz: 48_000,
  channels: 2,
  /** A channel below this RMS is treated as silent. */
  minChannelRmsDb: -60,
  bitrateTolerance: 0.3,
} as const;

export type Verdict = "pass" | "fail" | "n/a";

export interface Check {
  metric: string;
  /** What was asked for / what the log reported; "—" when unknown. */
  expected: string;
  /** What the file shows. */
  actual: string;
  verdict: Verdict;
  note?: string;
}

export interface VerifyOptions {
  /** Logical or physical size of the recorded screen, for the aspect-ratio check. */
  screen?: Dimensions;
  /** Seconds the run asked for (matrix); the file must be about that long. */
  expectedDurationSeconds?: number;
}

/** A recording this far from the requested length was cut short or ran long. */
export const DURATION_TOLERANCE_SECONDS = 2;

const fmt = (n: number | undefined, digits = 1): string => (n === undefined || Number.isNaN(n) ? "—" : n.toFixed(digits));
const mbps = (bps: number | undefined): string => (bps === undefined ? "—" : `${(bps / 1_000_000).toFixed(2)} Mbps`);
const kbps = (bps: number | undefined): string => (bps === undefined ? "—" : `${Math.round(bps / 1000)} kbps`);
const ms = (value: number | undefined): string => (value === undefined || Number.isNaN(value) ? "—" : `${value.toFixed(0)} ms`);
const pass = (ok: boolean): Verdict => (ok ? "pass" : "fail");

function aspectMatches(a: Dimensions, b: Dimensions): boolean {
  // Even-rounding of a scaled edge moves the ratio by less than 1%.
  return Math.abs(a.width / a.height - b.width / b.height) < 0.01;
}

/** Judge one measurement against the log entry (if any) and the threshold table. */
export function judge(m: Measurement, entry: CaptureLogEntry | undefined, options: VerifyOptions = {}): Check[] {
  const checks: Check[] = [];
  const requestedFps = entry?.requested.frameRate;
  const cap: ResolutionCap | undefined = entry?.requested.resolutionCap;

  // 成品尺寸
  if (m.video) {
    const actual = `${m.video.width}x${m.video.height}`;
    const trackSize = entry?.track.width !== undefined && entry.track.height !== undefined ? `${entry.track.width}x${entry.track.height}` : undefined;
    const notes: string[] = [];
    let ok: boolean | undefined;
    if (trackSize !== undefined) {
      ok = trackSize === actual;
      if (!ok) notes.push(`與 track size ${trackSize} 不同`);
    }
    if (cap && cap !== "source") {
      // Within the cap: fitting the output into the cap must leave it unchanged (review F3: no --screen needed).
      const refit = fitWithinCap(m.video, cap);
      const within = refit.width === m.video.width && refit.height === m.video.height;
      if (!within) notes.push(`超過上限 ${cap}`);
      ok = (ok ?? true) && within;
    }
    if (options.screen && !aspectMatches(m.video, options.screen)) {
      const expected = cap && cap !== "source" ? `（預期 ${fitWithinCap(options.screen, cap).width}x${fitWithinCap(options.screen, cap).height}）` : "";
      notes.push(`比例與螢幕 ${options.screen.width}x${options.screen.height} 不一致${expected}`);
      ok = false;
    }
    checks.push({
      metric: "成品尺寸",
      expected: trackSize ?? (cap ? `cap ${cap}` : "—"),
      actual,
      verdict: ok === undefined ? "n/a" : pass(ok),
      ...(notes.length > 0 ? { note: notes.join("；") } : {}),
    });
  } else {
    checks.push({ metric: "成品尺寸", expected: "—", actual: "無影像軌", verdict: "fail" });
  }

  // 錄製時長（矩陣要求的秒數）
  const expectedSeconds = options.expectedDurationSeconds;
  checks.push({
    metric: "錄製時長",
    expected: expectedSeconds === undefined ? "—" : `${expectedSeconds} ± ${DURATION_TOLERANCE_SECONDS} s`,
    actual: m.durationSeconds === undefined ? "—" : `${fmt(m.durationSeconds, 1)} s`,
    verdict:
      expectedSeconds === undefined || m.durationSeconds === undefined
        ? "n/a"
        : pass(Math.abs(m.durationSeconds - expectedSeconds) <= DURATION_TOLERANCE_SECONDS),
  });

  // 平均幀率
  const avgFps =
    m.video?.frames !== undefined && m.video.durationSeconds ? m.video.frames / m.video.durationSeconds : undefined;
  checks.push({
    metric: "平均幀率",
    expected: requestedFps === undefined ? "—" : `${requestedFps} ± ${THRESHOLDS.fpsToleranceFps} fps`,
    actual: avgFps === undefined ? "—" : `${fmt(avgFps, 2)} fps（${m.video?.frames} 張）`,
    verdict: avgFps === undefined || requestedFps === undefined ? "n/a" : pass(Math.abs(avgFps - requestedFps) <= THRESHOLDS.fpsToleranceFps),
    note: "素材需持續動態；靜態畫面不適用",
  });

  // 掉幀
  checks.push({
    metric: "掉幀",
    expected: `< ${THRESHOLDS.maxDropRate * 100}%`,
    actual: m.frames ? `${(m.frames.dropRate * 100).toFixed(2)}%（${m.frames.dropped} 張／取樣 ${m.frames.frames} 張，最大間隔 ${ms(m.frames.maxGapMs)}）` : "—",
    verdict: m.frames ? pass(m.frames.dropRate < THRESHOLDS.maxDropRate) : "n/a",
  });

  // 音訊與影像時長差
  const durationDiffMs =
    m.video?.durationSeconds !== undefined && m.audio?.durationSeconds !== undefined
      ? (m.audio.durationSeconds - m.video.durationSeconds) * 1000
      : undefined;
  checks.push({
    metric: "音訊−影像時長差",
    expected: `< ${THRESHOLDS.maxDurationDiffMs} ms`,
    actual: ms(durationDiffMs),
    verdict: durationDiffMs === undefined ? "n/a" : pass(Math.abs(durationDiffMs) < THRESHOLDS.maxDurationDiffMs),
  });

  // 起始偏移（容器）
  const startOffsetMs =
    m.video?.startTime !== undefined && m.audio?.startTime !== undefined ? (m.audio.startTime - m.video.startTime) * 1000 : undefined;
  checks.push({
    metric: "音訊−影像起始偏移（容器）",
    expected: `< ${THRESHOLDS.maxStartOffsetMs} ms`,
    actual: ms(startOffsetMs),
    verdict: startOffsetMs === undefined ? "n/a" : pass(Math.abs(startOffsetMs) < THRESHOLDS.maxStartOffsetMs),
  });

  // 同步標記（素材頁）
  checks.push({
    metric: "音訊−影像偏移（閃光／短音）",
    expected: `< ${THRESHOLDS.maxStartOffsetMs} ms；穩定超過記為固有延遲`,
    actual: m.sync ? `${ms(m.sync.medianOffsetMs)}（${m.sync.pairs} 對；頭 ${ms(m.sync.headOffsetMs)}，尾 ${ms(m.sync.tailOffsetMs)}）` : "—",
    verdict: m.sync ? pass(Math.abs(m.sync.medianOffsetMs) < THRESHOLDS.maxStartOffsetMs) : "n/a",
    ...(m.sync ? {} : { note: m.syncAttempted ? "--sync 偵測不到閃光／短音配對：素材頁不在被錄的螢幕，或音訊未被錄到" : "需 --sync 與測試素材頁" }),
  });
  checks.push({
    metric: "結尾音畫漂移",
    expected: `< ${THRESHOLDS.maxDriftMs} ms`,
    actual: ms(m.sync?.driftMs),
    verdict: m.sync?.driftMs === undefined ? "n/a" : pass(Math.abs(m.sync.driftMs) < THRESHOLDS.maxDriftMs),
    ...(m.sync?.driftMs === undefined ? { note: "需 --sync 且檔案長於 60 秒" } : {}),
  });

  // 取樣率／聲道
  if (m.audio) {
    const rms = m.audio.channelRmsDb;
    const energetic = rms?.map((db) => db > THRESHOLDS.minChannelRmsDb);
    const rmsText = rms ? rms.map((db) => (Number.isFinite(db) ? `${db.toFixed(1)} dB` : "−∞")).join(" / ") : "未量";
    const formatOk = m.audio.sampleRate === THRESHOLDS.sampleRateHz && m.audio.channels === THRESHOLDS.channels;
    const energyOk = energetic === undefined ? undefined : energetic.length === THRESHOLDS.channels && energetic.every(Boolean);
    checks.push({
      metric: "取樣率／聲道",
      expected: `${THRESHOLDS.sampleRateHz / 1000} kHz、${THRESHOLDS.channels} 聲道、左右皆有能量`,
      actual: `${m.audio.sampleRate ?? "—"} Hz、${m.audio.channels ?? "—"} 聲道，RMS ${rmsText}` + (entry?.track.channelCount !== undefined ? `（track 回報 ${entry.track.channelCount} 聲道）` : ""),
      verdict: pass(formatOk && energyOk !== false),
      ...(energyOk === undefined ? { note: "聲道能量需 ffmpeg" } : {}),
    });
  } else {
    checks.push({ metric: "取樣率／聲道", expected: `${THRESHOLDS.sampleRateHz / 1000} kHz、${THRESHOLDS.channels} 聲道`, actual: "無音訊軌", verdict: "fail" });
  }

  // 位元率
  const target = entry?.targetVideoBps;
  const videoBps = m.video?.bitsPerSecond;
  const ratio = target && videoBps !== undefined ? videoBps / target : undefined;
  checks.push({
    metric: "影像位元率",
    expected: target === undefined ? "—" : `${mbps(target)} ± ${THRESHOLDS.bitrateTolerance * 100}%`,
    actual: ratio === undefined ? mbps(videoBps) : `${mbps(videoBps)}（目標的 ${(ratio * 100).toFixed(0)}%）`,
    verdict: ratio === undefined ? "n/a" : pass(Math.abs(ratio - 1) <= THRESHOLDS.bitrateTolerance),
    ...(ratio !== undefined && Math.abs(ratio - 1) > THRESHOLDS.bitrateTolerance ? { note: "超出即為 Chromium 實際夾住的值" } : {}),
  });
  checks.push({
    metric: "音訊位元率",
    expected: entry ? kbps(entry.targetAudioBps) : "—",
    actual: kbps(m.audio?.bitsPerSecond),
    verdict:
      entry && m.audio?.bitsPerSecond !== undefined
        ? pass(Math.abs(m.audio.bitsPerSecond / entry.targetAudioBps - 1) <= THRESHOLDS.bitrateTolerance)
        : "n/a",
  });

  // CPU（無門檻，先記錄）
  checks.push({
    metric: "CPU（Electron 各程序合計）",
    expected: "記錄；門檻待第一次量測後定",
    actual: m.cpu ? `平均 ${m.cpu.averagePercent.toFixed(0)}%，峰值 ${m.cpu.peakPercent.toFixed(0)}%` : "—",
    verdict: "n/a",
  });

  // 檔案可播
  checks.push({
    metric: "檔案可播（ffprobe 解碼全部影格）",
    expected: "無解碼錯誤",
    actual: m.decodable ? `可解碼，${fmt(m.durationSeconds, 1)} s，${(m.fileBytes / 1024 / 1024).toFixed(1)} MB` : `解碼錯誤：${m.decodeErrors ?? ""}`,
    verdict: pass(m.decodable),
    note: "QuickTime／Chrome 雙擊與拖曳仍需人工",
  });

  return checks;
}

export function overallVerdict(checks: Check[]): Verdict {
  if (checks.some((c) => c.verdict === "fail")) return "fail";
  return checks.some((c) => c.verdict === "pass") ? "pass" : "n/a";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const VERDICT_MARK: Record<Verdict, string> = { pass: "✅", fail: "❌", "n/a": "—" };

export function describeRequested(entry: CaptureLogEntry | undefined): string {
  if (!entry) return "log 中找不到對應 session";
  const q = entry.requested;
  return `影像 ${q.videoQuality}，上限 ${q.resolutionCap}，${q.frameRate} fps，音訊 ${q.audioQuality}；track ${entry.track.width ?? "?"}x${entry.track.height ?? "?"} @ ${entry.track.frameRate ?? "?"} fps，${entry.track.sampleRate ?? "?"} Hz × ${entry.track.channelCount ?? "?"} 聲道；目標 ${mbps(entry.targetVideoBps)} / ${kbps(entry.targetAudioBps)}` +
    (entry.warnings ? `；warnings: ${entry.warnings}` : "");
}

/** Plain-text table for the terminal. */
export function formatText(file: string, entry: CaptureLogEntry | undefined, checks: Check[]): string {
  const width = (key: keyof Check): number => Math.max(...checks.map((c) => String(c[key] ?? "").length));
  const pad = (text: string, n: number): string => text + " ".repeat(Math.max(0, n - text.length));
  const lines = [file, `  ${describeRequested(entry)}`];
  const w1 = width("metric");
  const w2 = width("expected");
  for (const c of checks) {
    lines.push(`  ${VERDICT_MARK[c.verdict]} ${pad(c.metric, w1)}  ${pad(c.expected, w2)}  ${c.actual}${c.note ? `  (${c.note})` : ""}`);
  }
  lines.push(`  結果：${VERDICT_MARK[overallVerdict(checks)]}`);
  return lines.join("\n");
}

const cell = (text: string): string => text.replace(/\|/g, "\\|");

/** One Markdown section per file for `plans/measurements/<date>.md`. */
export function formatMarkdown(
  title: string,
  file: string,
  entry: CaptureLogEntry | undefined,
  checks: Check[],
  context: { material?: string; note?: string } = {},
): string {
  const lines = [
    `### ${title}`,
    "",
    `- 檔案：\`${file}\``,
    `- 要求與 track：${describeRequested(entry)}`,
  ];
  if (context.material) lines.push(`- 素材：${context.material}`);
  if (context.note) lines.push(`- 備註：${context.note}`);
  lines.push("", "| 指標 | 門檻／要求 | 實測 | 判定 |", "|---|---|---|---|");
  for (const c of checks) {
    lines.push(`| ${cell(c.metric)} | ${cell(c.expected)} | ${cell(c.actual)}${c.note ? `（${cell(c.note)}）` : ""} | ${VERDICT_MARK[c.verdict]} |`);
  }
  lines.push("", `結果：${VERDICT_MARK[overallVerdict(checks)]}`, "", "主觀比對（人填）：", "", "- 文字清晰度：", "- 捲動與動態：", "- 色彩邊緣（紅藍細線）：", "- 音量／失真／左右聲道：", "");
  return lines.join("\n");
}

export { RESOLUTION_CAPS };
