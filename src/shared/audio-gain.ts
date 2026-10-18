/**
 * The inputs' volumes (plan 075, D21): system audio's and the microphone's, in whole dB, from silent at the fader's
 * bottom to +12 dB, saved as settings and taken by a recording from its next sound on. The engine has the same bounds
 * (core `SILENT_GAIN_DB`, `MAX_GAIN_DB`).
 */
export interface AudioGain {
  system: number;
  microphone: number;
}

/** The fader's bottom, which is silence. */
export const AUDIO_GAIN_MIN_DB = -60;
export const AUDIO_GAIN_MAX_DB = 12;
export const DEFAULT_AUDIO_GAIN: AudioGain = { system: 0, microphone: 0 };

export function isGainDb(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= AUDIO_GAIN_MIN_DB && value <= AUDIO_GAIN_MAX_DB;
}

export function isAudioGain(value: unknown): value is AudioGain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { system, microphone } = value as Record<string, unknown>;
  return isGainDb(system) && isGainDb(microphone);
}

/** A volume as its fader says it: −∞ dB at the bottom, which is silence, and a sign away from 0. */
export function gainText(db: number): string {
  return db <= AUDIO_GAIN_MIN_DB ? "−∞ dB" : `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db)} dB`;
}
