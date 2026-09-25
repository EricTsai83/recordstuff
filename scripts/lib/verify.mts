/**
 * Pure logic for the recording verification toolkit
 * (docs/system-design/tooling.md): pair recordings with the app's session
 * records (or legacy `capture:` lines), turn ffprobe / ffmpeg output into
 * numbers, judge them against the threshold table and format the result. No
 * I/O here; everything that runs a process lives in `media-tools.mts`.
 * Development only, never shipped.
 */
import path from "node:path";
import type { SessionRecord } from "../../src/shared/session-record.ts";
import { isProcessStart, isSessionRecordLine, logMessage, parseSessionRecord, startLineRun } from "./session-records.mts";
import {
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

/** One session's requested settings and capture report: a capture record, or a legacy `capture:` line. */
export interface CaptureLogEntry {
  sessionId: string;
  /** The launch that recorded it; absent for logs before session records. */
  runId?: string;
  requested: QualitySettings;
  track: TrackReport;
  targetVideoBps: number;
  targetAudioBps: number;
  warnings: string | undefined;
  /** Epoch ms of the session's `state → recording` line, when the log carried timestamps. */
  recordingStartedAtMs?: number;
  /** Epoch ms of its `state → stopping` line (or `saved` when no stopping line was seen). */
  stoppedAtMs?: number;
}

/** Seconds between the session's recording and stopping lines; the file should be about this long. */
export function sessionDurationSeconds(entry: CaptureLogEntry | undefined): number | undefined {
  if (entry?.recordingStartedAtMs === undefined || entry.stoppedAtMs === undefined) return undefined;
  const seconds = (entry.stoppedAtMs - entry.recordingStartedAtMs) / 1000;
  return seconds > 0 ? seconds : undefined;
}

const numberOrUndefined = (text: string | undefined): number | undefined => {
  if (text === undefined || (text === "unknown" || text === "未知")) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
};

export function parseCaptureLine(line: string): CaptureLogEntry | undefined {
  const match =
    /recorder: session (\S+) capture: requested video=(\S+) cap=(\S+) fps=(\S+)(?: audio=\S+)?; track size=(\S+) fps=(\S+) sampleRate=(\S+)(?: Hz)? channels=(\S+); target videoBps=(\d+) audioBps=(\d+)(?:; warnings: (.*))?$/.exec(
      line,
    );
  if (!match) return undefined;
  // `audio=` appeared in logs before 2026-09-13 (the audio quality setting was removed); it is skipped.
  const [, sessionId, video, cap, fps, size, trackFps, sampleRate, channels, videoBps, audioBps, warnings] = match;
  const requested = { videoQuality: video, resolutionCap: cap, frameRate: Number(fps) };
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

/** How a file's log metadata was found (plan 029); only `matched` and `legacy` carry an entry. */
export type PairingStatus = "matched" | "legacy" | "ambiguous" | "conflict" | "unknown";

export interface LogPairing {
  status: PairingStatus;
  entry?: CaptureLogEntry;
  /** Why metadata is missing, or a caveat about how it was found. */
  note?: string;
}

interface Claim {
  /** One session, or a unique token for a line no single session can own. */
  key: string;
  status: PairingStatus;
  entry?: CaptureLogEntry;
  note?: string;
}

/**
 * Log paths are absolute on the recording machine and files may not exist
 * (a failure that kept nothing), so identity is lexical: resolved, with
 * Unicode normalized the way APFS compares names.
 */
export function normalizeRecordingPath(filePath: string): string {
  return path.resolve(filePath).normalize("NFC");
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return (parts[parts.length - 1] ?? filePath).normalize("NFC");
}

/** Every path the log associates with a session, looked up by identity rather than line order. */
export class LogPairs {
  private readonly byPath = new Map<string, Claim[]>();
  private readonly byName = new Map<string, Claim[]>();

  claim(filePath: string, claim: Claim): void {
    for (const [index, key] of [[this.byPath, normalizeRecordingPath(filePath)], [this.byName, basename(filePath)]] as const) {
      const claims = index.get(key) ?? [];
      if (!claims.some((c) => c.key === claim.key)) claims.push(claim);
      index.set(key, claims);
    }
  }

  /** Distinct paths the log names. */
  get size(): number {
    return this.byPath.size;
  }

  /**
   * The full path first; a copied file falls back to its name only when a
   * single session in the log names a file of that name.
   */
  lookup(file: string): LogPairing {
    const exact = this.byPath.get(normalizeRecordingPath(file));
    if (exact) return resolveClaims(exact, false);
    const named = this.byName.get(basename(file));
    if (named) return resolveClaims(named, true);
    return { status: "unknown", note: this.size === 0 ? "the log names no recording" : "no session in the available log names this file" };
  }
}

function resolveClaims(claims: Claim[], byName: boolean): LogPairing {
  const first = claims[0];
  if (!first) return { status: "unknown" };
  if (claims.length > 1) {
    return { status: "ambiguous", note: `${claims.length} sessions name ${byName ? "a file with this name in different folders" : "this file"}` };
  }
  const notes = [first.note, byName && first.entry ? "matched by file name only; the log names another folder" : undefined].filter(Boolean);
  return {
    status: first.status,
    ...(first.entry ? { entry: first.entry } : {}),
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  };
}

interface LogMessage {
  message: string;
  atMs: number;
}

type CaptureRecord = Extract<SessionRecord, { kind: "capture" }>;
type TerminalRecord = Extract<SessionRecord, { kind: "saved" | "failed" }>;

function entryFromCapture(record: CaptureRecord): CaptureLogEntry {
  const report = record.capture;
  const track: TrackReport = {};
  if (report.width !== undefined && report.height !== undefined) {
    track.width = report.width;
    track.height = report.height;
  }
  if (report.frameRate !== undefined) track.frameRate = report.frameRate;
  if (report.sampleRate !== undefined) track.sampleRate = report.sampleRate;
  if (report.channelCount !== undefined) track.channelCount = report.channelCount;
  return {
    sessionId: record.session,
    runId: record.run,
    requested: record.requested,
    track,
    targetVideoBps: report.videoBitsPerSecond,
    targetAudioBps: report.audioBitsPerSecond,
    warnings: report.warnings.length > 0 ? report.warnings.join("; ") : undefined,
  };
}

const epochMs = (iso: string | undefined): number | undefined => {
  const value = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(value) ? value : undefined;
};

/**
 * Structured records (plan 029): a session is its run and session id. The
 * same record logged twice is one outcome; different outcomes for one session
 * are a conflict, and nothing is judged against either.
 */
function pairRecords(messages: LogMessage[], pairs: LogPairs): void {
  const sessions = new Map<string, { captures: Map<string, CaptureRecord>; terminals: Map<string, { record: TerminalRecord; atMs: number }> }>();
  for (const { message, atMs } of messages) {
    const record = parseSessionRecord(message);
    if (!record || record.kind === "refused") continue;
    const key = `${record.run}/${record.session}`;
    const session = sessions.get(key) ?? { captures: new Map(), terminals: new Map() };
    sessions.set(key, session);
    if (record.kind === "capture") session.captures.set(message, record);
    else if (!session.terminals.has(message)) session.terminals.set(message, { record, atMs });
  }
  for (const [key, session] of sessions) {
    const terminals = [...session.terminals.values()];
    const captures = [...session.captures.values()];
    // An empty failure left no file, and a same-second retry may reuse its temporary name: it claims none.
    const paths = new Set(terminals.flatMap(({ record }) => record.kind === "saved"
      ? [record.path]
      : [record.partialPath, record.outcome === "unknown" ? record.recordingPath : undefined].filter((p): p is string => p !== undefined)));
    if (paths.size === 0) continue;
    let claim: Claim;
    const only = terminals.length === 1 ? terminals[0] : undefined;
    if (!only) {
      const outcomes = terminals.map(({ record }) => (record.kind === "saved" ? `saved ${record.path}` : `failed ${record.code}`));
      claim = { key, status: "conflict", note: `session ${key} has conflicting outcomes (${outcomes.join("; ")})` };
    } else if (captures.length > 1) {
      claim = { key, status: "conflict", note: `session ${key} has conflicting capture records` };
    } else if (captures[0] === undefined) {
      claim = { key, status: "unknown", note: `the capture record of session ${key} is not in the available log` };
    } else {
      const entry = entryFromCapture(captures[0]);
      const started = epochMs(only.record.recordingAt);
      const stopped = epochMs(only.record.stoppingAt) ?? (only.record.kind === "saved" && Number.isFinite(only.atMs) ? only.atMs : undefined);
      if (started !== undefined) entry.recordingStartedAtMs = started;
      if (stopped !== undefined) entry.stoppedAtMs = stopped;
      claim = { key, status: "matched", entry };
    }
    for (const filePath of paths) pairs.claim(filePath, claim);
  }
}

interface LegacySession {
  entry?: CaptureLogEntry;
  failed: boolean;
  resolved: boolean;
  /** Once an outcome could have belonged to it or another, no later line can prove which. */
  tainted: boolean;
  /** What its `failed: …` line will say. */
  outcome?: string;
}

const EARLY_STOP = / \(stopped early: [^)]*\)$/;

/**
 * One launch of a build before session records. Its human lines name the
 * session only on `recorder: session …` lines, so an outcome is accepted only
 * when nothing else could own it: a `file finalized` line, the one session
 * still recording, or the one unresolved failure whose `failed:` text matches.
 * Otherwise the file is ambiguous: two unresolved failures are never assigned
 * by which one printed first, because failure cleanup can end after the next
 * session started.
 */
function pairLegacy(messages: LogMessage[], pairs: LogPairs, segment: number): void {
  const sessions = new Map<string, LegacySession>();
  const finalized = new Set<string>();
  let token = 0;
  const lone = (key: string): string => `legacy/${segment}/${key}/${token++}`;
  const session = (id: string): LegacySession => {
    const known = sessions.get(id) ?? { failed: false, resolved: false, tainted: false };
    sessions.set(id, known);
    return known;
  };
  const recording = (): LegacySession[] => [...sessions.values()].filter((s) => s.entry && !s.failed && !s.resolved);
  const claim = (filePath: string, id: string, s: LegacySession): void => {
    pairs.claim(filePath, s.entry
      ? { key: `legacy/${segment}/${id}`, status: "legacy", entry: s.entry }
      : { key: `legacy/${segment}/${id}`, status: "unknown", note: `session ${id} has no capture line in the available log` });
  };
  for (const { message, atMs } of messages) {
    const capture = parseCaptureLine(message);
    if (capture) {
      const s = session(capture.sessionId);
      s.entry ??= capture;
      continue;
    }
    if (message === "state → recording" || message === "state → stopping") {
      const [only, ...others] = recording();
      if (only?.entry && others.length === 0 && Number.isFinite(atMs)) {
        if (message === "state → recording") only.entry.recordingStartedAtMs = atMs;
        else only.entry.stoppedAtMs = atMs;
      }
      continue;
    }
    const failedSession = /^recorder: session (\S+) failed: (.*)$/.exec(message);
    if (failedSession?.[1] !== undefined) {
      const s = session(failedSession[1]);
      s.failed = true;
      s.outcome = failedSession[2] ?? "";
      continue;
    }
    const reclassified = /^recorder: session (\S+) start failure reported as (\S+): the writer retained (.*)$/.exec(message);
    if (reclassified?.[1] !== undefined) {
      const s = session(reclassified[1]);
      const detail = s.outcome?.replace(/^\S+ ?/, "") ?? "";
      s.outcome = `${reclassified[2]} ${reclassified[3]} (start ended: ${detail})`;
      continue;
    }
    const final = /^recorder: session (\S+) file finalized (.+)$/.exec(message);
    if (final?.[1] !== undefined && final[2] !== undefined) {
      const s = session(final[1]);
      const filePath = final[2].replace(EARLY_STOP, "");
      s.resolved = true;
      if (s.entry && s.entry.stoppedAtMs === undefined && Number.isFinite(atMs)) s.entry.stoppedAtMs = atMs;
      finalized.add(filePath);
      claim(filePath, final[1], s);
      continue;
    }
    const saved = /^saved (.+)$/.exec(message);
    if (saved?.[1] !== undefined) {
      const filePath = saved[1].replace(EARLY_STOP, "");
      if (finalized.has(filePath)) continue;
      const candidates = recording();
      const only = candidates.length === 1 ? candidates[0] : undefined;
      if (only?.entry) {
        only.resolved = true;
        if (only.entry.stoppedAtMs === undefined && Number.isFinite(atMs)) only.entry.stoppedAtMs = atMs;
        claim(filePath, only.entry.sessionId, only);
      } else if (candidates.length > 1) {
        pairs.claim(filePath, { key: lone("saved"), status: "ambiguous", note: `${candidates.length} legacy sessions could own this save` });
      }
      continue;
    }
    const failedLine = /^failed: (.*)$/.exec(message);
    if (failedLine?.[1] !== undefined) {
      const kept = / \(kept (.+)\)$/.exec(failedLine[1]);
      const text = kept ? failedLine[1].slice(0, kept.index) : failedLine[1];
      const unresolved = [...sessions.entries()].filter(([, s]) => s.failed && !s.resolved);
      const matching = unresolved.filter(([, s]) => s.outcome === text);
      // Text identifies the owner; without a match only a single unresolved failure can.
      const owners = matching.length > 0 ? matching : unresolved.length === 1 ? unresolved : [];
      const pool = owners.length > 0 ? owners : unresolved;
      const [only] = pool;
      if (only && pool.length === 1 && !only[1].tainted) {
        only[1].resolved = true;
        if (kept?.[1] !== undefined) claim(kept[1], only[0], only[1]);
        continue;
      }
      // Several sessions could own this line, so none may later look like its unique owner.
      for (const [, s] of pool) s.tainted = true;
      if (owners[0]) owners[0][1].resolved = true;
      if (kept?.[1] !== undefined) {
        pairs.claim(kept[1], pool.length > 0
          ? { key: lone("failed"), status: "ambiguous", note: `${pool.length > 1 ? pool.length : "several"} unresolved legacy failures could own this file` }
          : { key: lone("failed"), status: "unknown", note: "no identifiable legacy session owns this failure line" });
      }
    }
  }
}

/**
 * Pair recordings with their sessions. Launches that write session records
 * pair by run and session id; older launches (no run id in `start:`, no
 * records) use the conservative legacy association above. The two forms are
 * never mixed within one launch, so no outcome is counted twice.
 */
export function pairRecordingsWithLog(logText: string): LogPairs {
  const pairs = new LogPairs();
  const segments: { structured: boolean; messages: LogMessage[] }[] = [{ structured: false, messages: [] }];
  const all: LogMessage[] = [];
  for (const raw of logText.split(/\r?\n/)) {
    const stamp = /^\[([^\]]*)\]\s*/.exec(raw);
    const atMs = stamp?.[1] === undefined ? Number.NaN : Date.parse(stamp[1]);
    const message = logMessage(raw);
    if (isProcessStart(message)) segments.push({ structured: startLineRun(message) !== undefined, messages: [] });
    const current = segments[segments.length - 1]!;
    if (isSessionRecordLine(message)) current.structured = true;
    const entry = { message, atMs };
    current.messages.push(entry);
    all.push(entry);
  }
  pairRecords(all, pairs);
  segments.forEach((segment, index) => {
    if (!segment.structured) pairLegacy(segment.messages, pairs, index);
  });
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

/** Project thresholds; a change here must be mirrored in docs/system-design/tooling.md. */
export const THRESHOLDS = {
  fpsToleranceFps: 2,
  maxDropRate: 0.02,
  maxDurationDiffMs: 100,
  /**
   * ITU-R BT.1359 detectability: audio may run up to 125 ms late or 45 ms
   * early before viewers notice (sound after light is natural). Offsets are
   * audio − video, so positive = late.
   */
  maxAudioLateMs: 125,
  maxAudioEarlyMs: 45,
  maxDriftMs: 100,
  sampleRateHz: 48_000,
  channels: 2,
  /** A channel below this RMS is treated as silent. */
  minChannelRmsDb: -60,
  /**
   * Bitrate is a quality floor, not a size target: an encoder that delivers
   * more than requested makes larger files, one that delivers much less may
   * be starving the picture. Chromium's 60 fps output is routinely 1.5–2×
   * the request, so only the lower bound is judged.
   */
  minVideoBitrateRatio: 0.7,
  /** AAC output depends on content; sparse or quiet material legitimately encodes well below the request. */
  minAudioBitrateRatio: 0.5,
  /** Set from the first measurements (1080p30 all levels ≈ 15%, 1080p60 ≈ 23%); generous headroom for slower machines. */
  maxCpuAveragePercent: 40,
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
  /** Seconds the run asked for (matrix); overrides the log-derived session length. */
  expectedDurationSeconds?: number;
  /**
   * The recorded content moved continuously (the test material page). Only
   * then do frame-timing metrics mean anything: screen capture emits no
   * frames while the picture is still, so an ordinary desktop recording has
   * a low average fps and long gaps by design, not by fault.
   */
  movingMaterial?: boolean;
  /**
   * The recorded audio is the test material page: short beeps once a second
   * with silence between them (the sync detector needs that silence). AAC
   * spends almost nothing on silence, so the audio bitrate says nothing about
   * the recorder here; it is reported, not judged. Bitrate and fidelity of
   * dense audio are measured by the audio-quality diagnostics instead.
   */
  testMaterial?: boolean;
}

/** A recording this far from the requested length was cut short or ran long. */
export const DURATION_TOLERANCE_SECONDS = 2;

const fmt = (n: number | undefined, digits = 1): string => (n === undefined || Number.isNaN(n) ? "—" : n.toFixed(digits));
const mbps = (bps: number | undefined): string => (bps === undefined ? "—" : `${(bps / 1_000_000).toFixed(2)} Mbps`);
const kbps = (bps: number | undefined): string => (bps === undefined ? "—" : `${Math.round(bps / 1000)} kbps`);
const ms = (value: number | undefined): string => (value === undefined || Number.isNaN(value) ? "—" : `${value.toFixed(0)} ms`);
const pass = (ok: boolean): Verdict => (ok ? "pass" : "fail");
/** audio − video in ms: late audio is tolerated up to 125 ms, early audio up to 45 ms (ITU-R BT.1359). */
const offsetWithinLimits = (offsetMs: number): boolean => offsetMs < THRESHOLDS.maxAudioLateMs && offsetMs > -THRESHOLDS.maxAudioEarlyMs;
const OFFSET_EXPECTED = `Audio late < ${THRESHOLDS.maxAudioLateMs} ms / early < ${THRESHOLDS.maxAudioEarlyMs} ms (ITU-R BT.1359)`;

function aspectMatches(a: Dimensions, b: Dimensions): boolean {
  // Even-rounding of a scaled edge moves the ratio by less than 1%.
  return Math.abs(a.width / a.height - b.width / b.height) < 0.01;
}

/** Judge one measurement against the log entry (if any) and the threshold table. */
export function judge(m: Measurement, entry: CaptureLogEntry | undefined, options: VerifyOptions = {}): Check[] {
  const checks: Check[] = [];
  const requestedFps = entry?.requested.frameRate;
  const cap: ResolutionCap | undefined = entry?.requested.resolutionCap;

  // Output dimensions
  if (m.video) {
    const actual = `${m.video.width}x${m.video.height}`;
    const trackSize = entry?.track.width !== undefined && entry.track.height !== undefined ? `${entry.track.width}x${entry.track.height}` : undefined;
    const notes: string[] = [];
    let ok: boolean | undefined;
    if (trackSize !== undefined) {
      ok = trackSize === actual;
      if (!ok) notes.push(`differs from track size ${trackSize}`);
    }
    if (cap && cap !== "source") {
      // Within the cap: fitting the output into the cap must leave it unchanged (review F3: no --screen needed).
      const refit = fitWithinCap(m.video, cap);
      const within = refit.width === m.video.width && refit.height === m.video.height;
      if (!within) notes.push(`exceeds cap ${cap}`);
      ok = (ok ?? true) && within;
    }
    if (options.screen && !aspectMatches(m.video, options.screen)) {
      const expected = cap && cap !== "source" ? ` (expected ${fitWithinCap(options.screen, cap).width}x${fitWithinCap(options.screen, cap).height})` : "";
      notes.push(`aspect ratio differs from screen ${options.screen.width}x${options.screen.height}${expected}`);
      ok = false;
    }
    checks.push({
      metric: "Output dimensions",
      expected: trackSize ?? (cap ? `cap ${cap}` : "—"),
      actual,
      verdict: ok === undefined ? "n/a" : pass(ok),
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
    });
  } else {
    checks.push({ metric: "Output dimensions", expected: "—", actual: "No video track", verdict: "fail" });
  }

  // Recording duration: the requested matrix length, else the session length from the log.
  const sessionSeconds = sessionDurationSeconds(entry);
  const expectedSeconds = options.expectedDurationSeconds ?? sessionSeconds;
  const expectedSource = options.expectedDurationSeconds !== undefined ? "requested" : "log session";
  checks.push({
    metric: "Recording duration",
    expected: expectedSeconds === undefined ? "—" : `${fmt(expectedSeconds, 1)} ± ${DURATION_TOLERANCE_SECONDS} s (${expectedSource})`,
    actual: m.durationSeconds === undefined ? "—" : `${fmt(m.durationSeconds, 1)} s`,
    verdict:
      expectedSeconds === undefined || m.durationSeconds === undefined
        ? "n/a"
        : pass(Math.abs(m.durationSeconds - expectedSeconds) <= DURATION_TOLERANCE_SECONDS),
    ...(expectedSeconds === undefined ? { note: "Needs a timestamped log session or an expected duration" } : {}),
  });
  const MATERIAL_NOTE = "Frame timing is judged only for continuously moving material: pass --moving, or --sync with the test page";

  // Average frame rate
  const avgFps =
    m.video?.frames !== undefined && m.video.durationSeconds ? m.video.frames / m.video.durationSeconds : undefined;
  checks.push({
    metric: "Average frame rate",
    expected: requestedFps === undefined ? "—" : `${requestedFps} ± ${THRESHOLDS.fpsToleranceFps} fps`,
    actual: avgFps === undefined ? "—" : `${fmt(avgFps, 2)} fps (${m.video?.frames} frames)`,
    verdict:
      avgFps === undefined || requestedFps === undefined || !options.movingMaterial
        ? "n/a"
        : pass(Math.abs(avgFps - requestedFps) <= THRESHOLDS.fpsToleranceFps),
    ...(options.movingMaterial ? {} : { note: MATERIAL_NOTE }),
  });

  // Dropped frames
  checks.push({
    metric: "Dropped frames",
    expected: `< ${THRESHOLDS.maxDropRate * 100}%`,
    actual: m.frames ? `${(m.frames.dropRate * 100).toFixed(2)}% (${m.frames.dropped} frames / sampled ${m.frames.frames} frames, max gap ${ms(m.frames.maxGapMs)})` : "—",
    verdict: m.frames && options.movingMaterial ? pass(m.frames.dropRate < THRESHOLDS.maxDropRate) : "n/a",
    ...(options.movingMaterial ? {} : { note: MATERIAL_NOTE }),
  });

  // Audio-video duration difference
  const durationDiffMs =
    m.video?.durationSeconds !== undefined && m.audio?.durationSeconds !== undefined
      ? (m.audio.durationSeconds - m.video.durationSeconds) * 1000
      : undefined;
  checks.push({
    metric: "Audio-video duration difference",
    expected: `< ${THRESHOLDS.maxDurationDiffMs} ms`,
    actual: ms(durationDiffMs),
    verdict: durationDiffMs === undefined ? "n/a" : pass(Math.abs(durationDiffMs) < THRESHOLDS.maxDurationDiffMs),
  });

  // Start offset (container)
  const startOffsetMs =
    m.video?.startTime !== undefined && m.audio?.startTime !== undefined ? (m.audio.startTime - m.video.startTime) * 1000 : undefined;
  checks.push({
    metric: "Audio-video start offset (container)",
    expected: OFFSET_EXPECTED,
    actual: ms(startOffsetMs),
    verdict: startOffsetMs === undefined ? "n/a" : pass(offsetWithinLimits(startOffsetMs)),
  });

  // Sync markers (test material)
  checks.push({
    metric: "Audio-video offset (flash/beep)",
    expected: `${OFFSET_EXPECTED}; a stable excess indicates inherent latency`,
    actual: m.sync ? `${ms(m.sync.medianOffsetMs)} (${m.sync.pairs} pairs; head ${ms(m.sync.headOffsetMs)}, tail ${ms(m.sync.tailOffsetMs)})` : "—",
    verdict: m.sync ? pass(offsetWithinLimits(m.sync.medianOffsetMs)) : "n/a",
    ...(m.sync ? {} : { note: m.syncAttempted ? "--sync found no flash/beep pairs: check the recorded display and system audio" : "Requires --sync and the test material page" }),
  });
  checks.push({
    metric: "End-to-end A/V drift",
    expected: `< ${THRESHOLDS.maxDriftMs} ms`,
    actual: ms(m.sync?.driftMs),
    verdict: m.sync?.driftMs === undefined ? "n/a" : pass(Math.abs(m.sync.driftMs) < THRESHOLDS.maxDriftMs),
    ...(m.sync?.driftMs === undefined ? { note: "Requires --sync and a file longer than 60 seconds" } : {}),
  });

  // Sample rate/channels
  if (m.audio) {
    const rms = m.audio.channelRmsDb;
    const energetic = rms?.map((db) => db > THRESHOLDS.minChannelRmsDb);
    const rmsText = rms ? rms.map((db) => (Number.isFinite(db) ? `${db.toFixed(1)} dB` : "−∞")).join(" / ") : "not measured";
    const formatOk = m.audio.sampleRate === THRESHOLDS.sampleRateHz && m.audio.channels === THRESHOLDS.channels;
    const energyOk = energetic === undefined ? undefined : energetic.length === THRESHOLDS.channels && energetic.every(Boolean);
    checks.push({
      metric: "Sample rate/channels",
      expected: `${THRESHOLDS.sampleRateHz / 1000} kHz, ${THRESHOLDS.channels} channels, energy in both channels`,
      actual: `${m.audio.sampleRate ?? "—"} Hz, ${m.audio.channels ?? "—"} channels, RMS ${rmsText}` + (entry?.track.channelCount !== undefined ? ` (track reports ${entry.track.channelCount} channels)` : ""),
      verdict: pass(formatOk && energyOk !== false),
      ...(energyOk === undefined ? { note: "Channel energy requires ffmpeg" } : {}),
    });
  } else {
    checks.push({ metric: "Sample rate/channels", expected: `${THRESHOLDS.sampleRateHz / 1000} kHz, ${THRESHOLDS.channels} channels`, actual: "No audio track", verdict: "fail" });
  }

  // Bitrate
  const target = entry?.targetVideoBps;
  const videoBps = m.video?.bitsPerSecond;
  const ratio = target && videoBps !== undefined ? videoBps / target : undefined;
  checks.push({
    metric: "Video bitrate",
    expected: target === undefined ? "—" : `≥ ${THRESHOLDS.minVideoBitrateRatio * 100}% of ${mbps(target)}`,
    actual: ratio === undefined ? mbps(videoBps) : `${mbps(videoBps)} (of target ${(ratio * 100).toFixed(0)}%)`,
    verdict: ratio === undefined ? "n/a" : pass(ratio >= THRESHOLDS.minVideoBitrateRatio),
    ...(ratio !== undefined && ratio > 1.3 ? { note: "Above target: larger file, not a quality loss (Chromium overshoots at 60 fps)" } : {}),
  });
  const audioRatio = entry && m.audio?.bitsPerSecond !== undefined ? m.audio.bitsPerSecond / entry.targetAudioBps : undefined;
  checks.push({
    metric: "Audio bitrate",
    expected: entry ? `≥ ${THRESHOLDS.minAudioBitrateRatio * 100}% of ${kbps(entry.targetAudioBps)}` : "—",
    actual: audioRatio === undefined ? kbps(m.audio?.bitsPerSecond) : `${kbps(m.audio?.bitsPerSecond)} (of target ${(audioRatio * 100).toFixed(0)}%)`,
    verdict: audioRatio === undefined || options.testMaterial ? "n/a" : pass(audioRatio >= THRESHOLDS.minAudioBitrateRatio),
    ...(options.testMaterial
      ? { note: "Reported only: the test material's sparse beeps encode far below any request; use the audio-quality diagnostics for bitrate" }
      : audioRatio !== undefined && audioRatio < 1
        ? { note: "AAC output follows content; below the request is normal for quiet or sparse audio" }
        : {}),
  });

  // CPU
  checks.push({
    metric: "CPU (all Electron processes)",
    expected: `average ≤ ${THRESHOLDS.maxCpuAveragePercent}%`,
    actual: m.cpu ? `average ${m.cpu.averagePercent.toFixed(0)}%, peak ${m.cpu.peakPercent.toFixed(0)}%` : "—",
    verdict: m.cpu ? pass(m.cpu.averagePercent <= THRESHOLDS.maxCpuAveragePercent) : "n/a",
  });

  // Decodability
  checks.push({
    metric: "Decodability (ffprobe full frame decode)",
    expected: "No decode errors",
    actual: m.decodable ? `Decodable, ${fmt(m.durationSeconds, 1)} s, ${(m.fileBytes / 1024 / 1024).toFixed(1)} MB` : `Decode errors: ${m.decodeErrors ?? ""}`,
    verdict: pass(m.decodable),
    note: "Opening and seeking in QuickTime/Chrome still requires manual verification",
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

/**
 * Without an entry the requested-settings checks are n/a; the pairing says
 * why, so an ambiguous log never reads as a clean pass of those checks.
 */
export function describeRequested(entry: CaptureLogEntry | undefined, pairing?: LogPairing): string {
  if (!entry) {
    return pairing && pairing.status !== "matched" && pairing.status !== "legacy"
      ? `Log metadata ${pairing.status}${pairing.note ? `: ${pairing.note}` : ""}; checks against requested settings not judged`
      : "No matching session in log";
  }
  const q = entry.requested;
  const association = pairing?.status === "legacy" ? "legacy log association" : undefined;
  const caveats = [association, pairing?.note].filter(Boolean);
  return `Video ${q.videoQuality}, cap ${q.resolutionCap}, ${q.frameRate} fps; track ${entry.track.width ?? "?"}x${entry.track.height ?? "?"} @ ${entry.track.frameRate ?? "?"} fps, ${entry.track.sampleRate ?? "?"} Hz × ${entry.track.channelCount ?? "?"} channels; target ${mbps(entry.targetVideoBps)} / ${kbps(entry.targetAudioBps)}` +
    (entry.warnings ? `; warnings: ${entry.warnings}` : "") +
    (caveats.length > 0 ? ` (${caveats.join("; ")})` : "");
}

/** Plain-text table for the terminal. */
export function formatText(file: string, entry: CaptureLogEntry | undefined, checks: Check[], pairing?: LogPairing): string {
  const width = (key: keyof Check): number => Math.max(...checks.map((c) => String(c[key] ?? "").length));
  const pad = (text: string, n: number): string => text + " ".repeat(Math.max(0, n - text.length));
  const lines = [file, `  ${describeRequested(entry, pairing)}`];
  const w1 = width("metric");
  const w2 = width("expected");
  for (const c of checks) {
    lines.push(`  ${VERDICT_MARK[c.verdict]} ${pad(c.metric, w1)}  ${pad(c.expected, w2)}  ${c.actual}${c.note ? `  (${c.note})` : ""}`);
  }
  lines.push(`  Result: ${VERDICT_MARK[overallVerdict(checks)]}`);
  return lines.join("\n");
}

const cell = (text: string): string => text.replace(/\|/g, "\\|");

/** One Markdown section per file for `docs/verification/measurements/<date>.md`. */
export function formatMarkdown(
  title: string,
  file: string,
  entry: CaptureLogEntry | undefined,
  checks: Check[],
  context: { material?: string; note?: string; pairing?: LogPairing } = {},
): string {
  const lines = [
    `### ${title}`,
    "",
    `- File: \`${file}\``,
    `- Request and track: ${describeRequested(entry, context.pairing)}`,
  ];
  if (context.material) lines.push(`- Material: ${context.material}`);
  if (context.note) lines.push(`- Note: ${context.note}`);
  lines.push("", "| Metric | Threshold/request | Measured | Verdict |", "|---|---|---|---|");
  for (const c of checks) {
    lines.push(`| ${cell(c.metric)} | ${cell(c.expected)} | ${cell(c.actual)}${c.note ? ` (${cell(c.note)})` : ""} | ${VERDICT_MARK[c.verdict]} |`);
  }
  lines.push("", `Result: ${VERDICT_MARK[overallVerdict(checks)]}`, "", "Subjective comparison (manual):", "", "- Text sharpness:", "- Scrolling and motion:", "- Color edges (thin red/blue lines):", "- Volume/distortion/channel separation:", "");
  return lines.join("\n");
}
