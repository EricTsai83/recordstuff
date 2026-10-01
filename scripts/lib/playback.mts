/**
 * The QuickTime playback check (`pnpm acceptance:playback`): the AppleScript it
 * sends, the replies it reads and the verdict. The runner owns QuickTime only
 * for the round: it refuses to start beside a running copy, so `document 1` and
 * the front window are always the file it opened.
 */

export interface DocumentState {
  duration: number;
  currentTime: number;
  playing: boolean;
  muted: boolean;
  width: number;
  height: number;
}

export interface Rect { x: number; y: number; width: number; height: number }

export type CheckStatus = "pass" | "fail" | "info";
export interface Check { name: string; status: CheckStatus; detail: string }

/** Seconds a QuickTime duration may differ from ffprobe's: container rounding, not a lost frame. */
export const DURATION_TOLERANCE_S = 0.5;
/** Seconds a seek may land from the request: QuickTime snaps to a displayable frame. */
export const SEEK_TOLERANCE_S = 0.25;
/** Of the wall time waited, how much playback must cover to count as playing in real time. */
export const MIN_PLAYBACK_RATIO = 0.75;
/**
 * Mean absolute gray-level change (0–255) the window must show between two seek
 * positions, and how far it must stand above the same position shown twice.
 * The test material scrolls and moves, so frames seconds apart differ widely;
 * the controls' time label alone changes a few hundred pixels.
 */
export const MIN_PICTURE_CHANGE = 1;
export const MIN_CHANGE_OVER_NOISE = 4;

const APP = "QuickTime Player";
const tell = (body: string): string => `tell application ${JSON.stringify(APP)} to ${body}`;

export const playbackScript = {
  documents: tell("return count of documents"),
  state: tell("tell document 1 to return {duration, current time, playing, muted, natural dimensions}"),
  bounds: tell("return bounds of front window"),
  seek: (seconds: number): string => tell(`set current time of document 1 to ${seconds.toFixed(3)}`),
  play: tell("play document 1"),
  pause: tell("pause document 1"),
  close: tell("close every document saving no"),
  quit: tell("quit"),
};

/** osascript prints a list flat and comma-separated: `10.3, 0.0, false, false, 1920, 1080`. */
export function parseDocumentState(reply: string): DocumentState {
  const parts = reply.trim().split(/\s*,\s*/);
  const [duration, currentTime, playing, muted, width, height] = parts;
  const numbers = [duration, currentTime, width, height].map(Number);
  if (parts.length !== 6 || numbers.some(n => !Number.isFinite(n)) || ![playing, muted].every(b => b === "true" || b === "false")) {
    throw new Error(`Unexpected QuickTime document state: ${reply.trim()}`);
  }
  return { duration: numbers[0]!, currentTime: numbers[1]!, playing: playing === "true", muted: muted === "true", width: numbers[2]!, height: numbers[3]! };
}

/** `bounds` is `{left, top, right, bottom}` in points, the same space `screencapture -R` takes. */
export function parseBounds(reply: string): Rect {
  const values = reply.trim().split(/\s*,\s*/).map(Number);
  const [left, top, right, bottom] = values;
  if (values.length !== 4 || values.some(n => !Number.isFinite(n)) || right! <= left! || bottom! <= top!) {
    throw new Error(`Unexpected QuickTime window bounds: ${reply.trim()}`);
  }
  return { x: left!, y: top!, width: right! - left!, height: bottom! - top! };
}

/** `get volume settings`: `output volume:50, input volume:75, alert volume:100, output muted:false`. */
export function parseVolumeSettings(reply: string): { volume?: number; muted?: boolean } {
  const volume = /output volume:(\d+)/.exec(reply)?.[1];
  const muted = /output muted:(true|false)/.exec(reply)?.[1];
  return { ...(volume === undefined ? {} : { volume: Number(volume) }), ...(muted === undefined ? {} : { muted: muted === "true" }) };
}

/** Mean absolute difference of two equally sized 8-bit gray images. */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) throw new Error(`Screenshots differ in size (${a.length} vs ${b.length} pixels)`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

export interface PlaybackObservations {
  expected: { duration: number; width: number; height: number; audio: boolean };
  opened: DocumentState;
  /** Played from the start for `waitedSeconds` of wall time. */
  played: { from: number; to: number; playing: boolean; waitedSeconds: number };
  seeks: Array<{ requested: number; reached: number }>;
  /** The window between two seek positions, and the same position shown twice. */
  picture: { change: number; noise: number };
  /** Played from shortly before the end until it stopped. */
  ended: { stopped: boolean; currentTime: number };
  output: { volume?: number; muted?: boolean };
}

const s = (seconds: number): string => `${seconds.toFixed(2)} s`;

export function judgePlayback(o: PlaybackObservations): { checks: Check[]; verdict: "pass" | "fail" } {
  const check = (name: string, ok: boolean, detail: string): Check => ({ name, status: ok ? "pass" : "fail", detail });
  const advanced = o.played.to - o.played.from;
  const seekMiss = Math.max(...o.seeks.map(seek => Math.abs(seek.reached - seek.requested)));
  const { change, noise } = o.picture;
  const checks: Check[] = [
    check("Opens with the file's duration", Math.abs(o.opened.duration - o.expected.duration) <= DURATION_TOLERANCE_S,
      `QuickTime ${s(o.opened.duration)}, ffprobe ${s(o.expected.duration)} (±${DURATION_TOLERANCE_S} s)`),
    check("Opens at the file's dimensions", o.opened.width === o.expected.width && o.opened.height === o.expected.height,
      `QuickTime ${o.opened.width}x${o.opened.height}, ffprobe ${o.expected.width}x${o.expected.height}`),
    check("Plays in real time", o.played.playing && advanced >= MIN_PLAYBACK_RATIO * o.played.waitedSeconds,
      `${s(advanced)} played in ${s(o.played.waitedSeconds)} (at least ${MIN_PLAYBACK_RATIO * 100}%); playing ${o.played.playing}`),
    check("Seeks land where asked", seekMiss <= SEEK_TOLERANCE_S,
      `${o.seeks.map(seek => `${s(seek.requested)} → ${s(seek.reached)}`).join(", ")} (±${SEEK_TOLERANCE_S} s)`),
    check("The picture follows the seek", change >= MIN_PICTURE_CHANGE && change > MIN_CHANGE_OVER_NOISE * noise,
      `mean change ${change.toFixed(2)} between seek positions, ${noise.toFixed(2)} for the same position twice `
      + `(at least ${MIN_PICTURE_CHANGE} and ${MIN_CHANGE_OVER_NOISE}× the repeat). If the screenshots show no QuickTime window, `
      + "grant Screen Recording to the terminal and rerun"),
    check("Plays to the end and stops", o.ended.stopped && o.ended.currentTime >= o.opened.duration - SEEK_TOLERANCE_S,
      `stopped ${o.ended.stopped} at ${s(o.ended.currentTime)} of ${s(o.opened.duration)}`),
    { name: "Audio (not judged)", status: "info", detail: `audio track ${o.expected.audio ? "present" : "absent"}; QuickTime muted ${o.opened.muted}; `
      + `system output volume ${o.output.volume ?? "unknown"}, muted ${o.output.muted ?? "unknown"}. Whether it sounds right needs a listener` },
  ];
  return { checks, verdict: checks.some(c => c.status === "fail") ? "fail" : "pass" };
}
