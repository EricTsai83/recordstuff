/**
 * The inputs' volumes (plan 075, D21): system audio's and the microphone's, in whole percent of the input as it comes,
 * 100% leaving it as it is, 0% silent and at most 600%, saved as settings and taken by a recording from its next sound
 * on. Since 2026-10-21, at the maintainer's request, a percent rather than whole dB, which few read at a glance; the
 * engine still takes dB (`volumeDb`), with the same bounds as its core (`SILENT_GAIN_DB`, `MAX_GAIN_DB`).
 */
export interface AudioVolume {
  system: number;
  microphone: number;
}

export const AUDIO_VOLUME_MAX = 600;
/** The fader's step; a volume saved off it (one kept from whole dB) is still a volume. */
export const AUDIO_VOLUME_STEP = 5;
export const DEFAULT_AUDIO_VOLUME: AudioVolume = { system: 100, microphone: 100 };

/**
 * A volume fader's position (2026-10-25, at the maintainer's request): 100% in the middle, the left half 0–100% by the
 * fader's step and the right half 100–600% by 25%, so turning an input down, the common change, has half the travel
 * instead of a sixth. Faders move by whole positions; a volume saved off this grid sits between two of them.
 */
export const VOLUME_FADER_MIDDLE = 100 / AUDIO_VOLUME_STEP;
const RAISED_STEP = (AUDIO_VOLUME_MAX - 100) / VOLUME_FADER_MIDDLE;
export const VOLUME_FADER_MAX = 2 * VOLUME_FADER_MIDDLE;

/** Where a volume sits on a fader. */
export function volumeToFader(percent: number): number {
  const v = Math.min(AUDIO_VOLUME_MAX, Math.max(0, percent));
  return v <= 100 ? v / AUDIO_VOLUME_STEP : VOLUME_FADER_MIDDLE + (v - 100) / RAISED_STEP;
}

/** The volume at a fader's position: whole steps of the fader, so always a volume. */
export function volumeFromFader(position: number): number {
  const p = Math.min(VOLUME_FADER_MAX, Math.max(0, position));
  const v = p <= VOLUME_FADER_MIDDLE ? p * AUDIO_VOLUME_STEP : 100 + (p - VOLUME_FADER_MIDDLE) * RAISED_STEP;
  return Math.round(v / AUDIO_VOLUME_STEP) * AUDIO_VOLUME_STEP;
}

/** The engine's silence: a gain at or under it is no sound at all. */
export const SILENT_GAIN_DB = -60;
/** 600% in dB, about +15.6 dB. */
export const MAX_GAIN_DB = 20 * Math.log10(AUDIO_VOLUME_MAX / 100);

export function isVolume(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= AUDIO_VOLUME_MAX;
}

export function isAudioVolume(value: unknown): value is AudioVolume {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { system, microphone } = value as Record<string, unknown>;
  return isVolume(system) && isVolume(microphone);
}

/** A volume as the gain the engine applies: 0% its silence. */
export function volumeDb(percent: number): number {
  return percent <= 0 ? SILENT_GAIN_DB : Math.max(SILENT_GAIN_DB, Math.min(MAX_GAIN_DB, 20 * Math.log10(percent / 100)));
}

/** A gain the engine takes: a number from its silence to 600%'s. */
export function isGainDb(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= SILENT_GAIN_DB && value <= MAX_GAIN_DB;
}

/** Volumes saved before 2026-10-21 (`audioGain`): whole dB from −60, which was silence, to +12. */
export function isLegacyGain(value: unknown): value is AudioVolume {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const db = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n >= SILENT_GAIN_DB && n <= 12;
  const { system, microphone } = value as Record<string, unknown>;
  return db(system) && db(microphone);
}

/** A volume saved in whole dB as the fader's nearest step: 0 dB 100%, −6 dB 50%, +6 dB 200%, −60 dB silent. */
export function volumeFromDb(db: number): number {
  if (db <= SILENT_GAIN_DB) return 0;
  return Math.min(AUDIO_VOLUME_MAX, Math.round(100 * 10 ** (db / 20) / AUDIO_VOLUME_STEP) * AUDIO_VOLUME_STEP);
}

/** -1 dBFS: where the engine's soft limit begins (native/capture/src/core/mixer.rs `LIMIT_THRESHOLD`). */
const LIMIT_THRESHOLD = 0.8912509;

/**
 * The engine's soft limit of a mix or a raised input (mixer.rs `limit`): unchanged up to -1 dBFS, approaching full
 * scale above it without reaching it. The edit view's preview mixes through it (plan 087), as the export does.
 */
export function softLimit(sum: number): number {
  const level = Math.abs(sum);
  if (level <= LIMIT_THRESHOLD) return sum;
  const room = 1 - LIMIT_THRESHOLD;
  return Math.sign(sum) * Math.min(LIMIT_THRESHOLD + room * Math.tanh((level - LIMIT_THRESHOLD) / room), 1 - 2 ** -24);
}
