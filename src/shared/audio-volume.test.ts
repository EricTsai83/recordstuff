import { describe, expect, it } from "vitest";
import bounds from "./audio-volume.bounds.json";
import { AUDIO_VOLUME_MAX, MAX_GAIN_DB, SILENT_GAIN_DB, isAudioVolume, isGainDb, isVolume, volumeDb, volumeFromDb, softLimit } from "./audio-volume";

describe("audio volume (plan 075, D21)", () => {
  it("is a whole percent from silent to 600%", () => {
    for (const volume of [0, 5, 71, 100, AUDIO_VOLUME_MAX]) expect(isVolume(volume), String(volume)).toBe(true);
    for (const volume of [-5, 601, 1.5, "100", Number.NaN]) expect(isVolume(volume), String(volume)).toBe(false);
    expect(isAudioVolume({ system: 100, microphone: 0 })).toBe(true);
    expect(isAudioVolume({ system: 100 })).toBe(false);
  });

  it("is given to the engine in dB: 100% unchanged, half −6 dB, 600% its top, 0% its silence", () => {
    expect(volumeDb(100)).toBe(0);
    expect(volumeDb(50)).toBeCloseTo(-6.02, 2);
    expect(volumeDb(200)).toBeCloseTo(6.02, 2);
    expect(volumeDb(AUDIO_VOLUME_MAX)).toBe(MAX_GAIN_DB);
    expect(volumeDb(0)).toBe(SILENT_GAIN_DB);
    for (const volume of [0, 1, 5, 100, 600]) expect(isGainDb(volumeDb(volume)), String(volume)).toBe(true);
  });

  it("takes a volume once saved in whole dB as the fader's nearest step", () => {
    expect([-60, -20, -6, -3, 0, 3, 6, 12].map(volumeFromDb)).toEqual([0, 10, 50, 70, 100, 140, 200, 400]);
  });

  it("has the bounds the engine applies (audio-volume.bounds.json, also read by native/capture/src/core/mod.rs)", () => {
    expect([SILENT_GAIN_DB, AUDIO_VOLUME_MAX]).toEqual([bounds.silentGainDb, bounds.maxVolumePercent]);
    for (const { percent, db } of bounds.volumes) expect(volumeDb(percent), `${percent}%`).toBeCloseTo(db, 12);
  });
});

describe("the engine's soft limit, as the edit view's preview mixes through it (plan 087)", () => {
  it("leaves a sum up to -1 dBFS as it is and brings a louder one under full scale, keeping its sign", () => {
    expect(softLimit(0.5)).toBe(0.5);
    expect(softLimit(-0.89)).toBe(-0.89);
    expect(softLimit(1.2)).toBeGreaterThan(0.95);
    expect(softLimit(1.2)).toBeLessThan(1);
    expect(softLimit(-6)).toBeCloseTo(-1, 6);
    expect(softLimit(-6)).toBeGreaterThan(-1);
    // Continuous at the threshold: no step where the curve begins.
    expect(softLimit(0.8912510) - softLimit(0.8912508)).toBeLessThan(1e-6);
  });
});
