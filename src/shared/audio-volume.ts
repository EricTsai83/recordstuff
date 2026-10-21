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
