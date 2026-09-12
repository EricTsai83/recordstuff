/**
 * Development-only unattended recording (plans/008-recording-verification-toolkit.md §B).
 * `RECORDSTUFF_AUTORECORD='{"seconds":30,"quality":{...}}'` makes the app
 * start recording once it is ready, stop after `seconds`, and quit after the
 * file is saved. The quality override is applied in memory only; settings.json
 * is never written. A packaged build ignores the variable entirely.
 */
import {
  AUDIO_QUALITIES,
  DEFAULT_QUALITY,
  FRAME_RATES,
  RESOLUTION_CAPS,
  VIDEO_QUALITIES,
  isQualitySettings,
  type QualitySettings,
} from "../shared/quality";
import type { RecordingState } from "../shared/state";
import type { RecorderEvent } from "./recorder";

export interface AutoRecordConfig {
  seconds: number;
  /** Full settings: the given keys merged over DEFAULT_QUALITY (not over settings.json), so a matrix is reproducible. */
  quality: QualitySettings;
}

export type AutoRecordParse = { ok: true; config: AutoRecordConfig } | { ok: false; error: string };

export const MAX_AUTORECORD_SECONDS = 3600;

const QUALITY_KEYS: Record<keyof QualitySettings, readonly unknown[]> = {
  videoQuality: VIDEO_QUALITIES,
  resolutionCap: RESOLUTION_CAPS,
  frameRate: FRAME_RATES,
  audioQuality: AUDIO_QUALITIES,
};

/**
 * `undefined` when there is nothing to do: the variable is absent or empty,
 * or the build is packaged. Otherwise the parsed config or a reason it was
 * rejected (the caller logs it and runs normally).
 */
export function parseAutoRecord(value: string | undefined, isPackaged: boolean): AutoRecordParse | undefined {
  if (isPackaged || value === undefined || value.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    return { ok: false, error: `not JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, error: "must be an object" };
  const record = parsed as Record<string, unknown>;
  const seconds = record["seconds"];
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_AUTORECORD_SECONDS) {
    return { ok: false, error: `seconds must be a number in (0, ${MAX_AUTORECORD_SECONDS}]` };
  }
  const merged: Record<string, unknown> = { ...DEFAULT_QUALITY };
  const patch = record["quality"];
  if (patch !== undefined) {
    if (typeof patch !== "object" || patch === null) return { ok: false, error: "quality must be an object" };
    for (const [key, given] of Object.entries(patch as Record<string, unknown>)) {
      const allowed = Object.hasOwn(QUALITY_KEYS, key) ? QUALITY_KEYS[key as keyof QualitySettings] : undefined;
      if (!allowed) return { ok: false, error: `quality.${key}: unknown key` };
      if (!allowed.includes(given)) return { ok: false, error: `quality.${key}: unsupported value ${JSON.stringify(given)}` };
      merged[key] = given;
    }
  }
  if (!isQualitySettings(merged)) return { ok: false, error: "quality is incomplete" };
  return { ok: true, config: { seconds, quality: merged } };
}

export interface AutoRecordDeps {
  state: () => RecordingState;
  toggle: () => void;
  stop: () => void;
  subscribe: (listener: (event: RecorderEvent) => void) => () => void;
  quit: () => void;
  log: (message: string) => void;
  /** How long to wait after ready before pressing the button; lets the permission check settle. */
  startDelayMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

/**
 * Drive one recording through the public recorder surface (the same toggle
 * and stop the tray uses): press start after a short delay, press stop after
 * `seconds` once recording, quit after `saved` or `failed`. Every step is
 * logged with an `autorecord:` prefix so the matrix runner can read the outcome.
 */
export function runAutoRecord(config: AutoRecordConfig, deps: AutoRecordDeps): void {
  const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const startDelay = deps.startDelayMs ?? 1500;
  let stopScheduled = false;
  let done = false;
  const finish = (message: string): void => {
    if (done) return;
    done = true;
    deps.log(`autorecord: ${message}`);
    deps.quit();
  };
  deps.log(`autorecord: ${config.seconds} s with quality ${JSON.stringify(config.quality)}`);
  deps.subscribe((event) => {
    if (done) return;
    switch (event.type) {
      case "state":
        if (event.state.type === "recording" && !stopScheduled) {
          stopScheduled = true;
          deps.log(`autorecord: recording, will stop in ${config.seconds} s`);
          schedule(() => {
            if (!done) deps.stop();
          }, config.seconds * 1000);
        } else if (event.state.type === "needsPermission") {
          finish("failed: needs screen recording permission");
        }
        return;
      case "saved":
        finish(`saved ${event.path}`);
        return;
      case "failed":
        finish(`failed: ${event.code} ${event.detail}${event.partialPath ? ` (kept ${event.partialPath})` : ""}`);
        return;
      default:
        return;
    }
  });
  schedule(() => {
    if (done) return;
    const state = deps.state();
    if (state.type === "idle") {
      deps.toggle();
    } else {
      finish(`failed: cannot start from state ${state.type}`);
    }
  }, startDelay);
}
