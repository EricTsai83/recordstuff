import { describe, expect, it } from "vitest";
import { DIGIT_DIFF_THRESHOLD, TICK_EXCESS_DB, TICK_FLOOR_DBFS, TICK_PITCHES_HZ, compareCrops, compareTickLevels, countdownTimeline, digitRegion, peakToneLevelDb } from "./countdown-evidence.mts";

const at = (ms: number, text: string): string => `[${new Date(Date.UTC(2026, 8, 26, 5, 0, 0) + ms).toISOString()}] ${text}`;

describe("countdown timeline", () => {
  it("separates preparation, ticks, dismissal, record → started and the first chunk", () => {
    const lines = [
      at(10, "hotkey: CommandOrControl+Shift+1 pressed"),
      at(15, "state → starting"),
      at(300, "recorder: session s1 prepared after 290 ms; countdown 3 s"),
      at(301, "state → countdown (3)"),
      at(305, "countdown overlay: display 1 at 1408,37 88x88 in display bounds 0,0 1512x982"),
      at(1302, "state → countdown (2)"),
      at(2301, "state → countdown (1)"),
      at(3155, "recorder: session s1 countdown overlay dismissed after 155 ms"),
      at(3301, "recorder: session s1 record sent 3000 ms after the 3 s countdown began"),
      at(3340, "recorder: session s1 started 39 ms after record"),
      at(3341, "state → recording"),
      at(4400, "recorder: session s1 first chunk 812345 bytes"),
    ];
    expect(countdownTimeline(lines, new Date(Date.UTC(2026, 8, 26, 5, 0, 0) + 10))).toEqual({
      countdown: 3, preparationMs: 290,
      ticks: [{ remaining: 3, atMs: 0 }, { remaining: 2, atMs: 1001 }, { remaining: 1, atMs: 2000 }],
      overlay: { window: { x: 1408, y: 37, width: 88, height: 88 }, display: { x: 0, y: 0, width: 1512, height: 982 } },
      dismissal: { outcome: "dismissed", ms: 155 }, recordAfterAnchorMs: 3000, recordToStartedMs: 39, startedToFirstChunkMs: 1059,
    });
  });

  it("reads whether the countdown ticked, and nothing from a build before plan 046", () => {
    const base = new Date(Date.UTC(2026, 8, 26, 5));
    expect(countdownTimeline([at(0, "recorder: session s4 prepared after 1 ms; countdown 3 s; sound on")], base)).toMatchObject({ countdown: 3, sound: true });
    expect(countdownTimeline([at(0, "recorder: session s5 prepared after 1 ms; countdown 0 s; sound off")], base)).toMatchObject({ countdown: 0, sound: false });
    expect(countdownTimeline([at(0, "recorder: session s6 prepared after 1 ms; countdown 3 s")], base)).not.toHaveProperty("sound");
  });

  it("reads Off and a dismissal that timed out", () => {
    expect(countdownTimeline([at(100, "recorder: session s2 prepared after 90 ms; countdown 0 s"), at(101, "recorder: session s2 record sent without a countdown")], new Date(Date.UTC(2026, 8, 26, 5))))
      .toMatchObject({ countdown: 0, ticks: [] });
    expect(countdownTimeline([at(0, "recorder: session s3 prepared after 1 ms; countdown 3 s"),
      at(3200, "recorder: session s3 countdown overlay did not confirm dismissal within 500 ms; destroying it")], new Date(Date.UTC(2026, 8, 26, 5))).dismissal)
      .toEqual({ outcome: "timed out" });
  });
});

describe("digit region", () => {
  const overlay = { window: { x: 1408, y: 37, width: 88, height: 88 }, display: { x: 0, y: 0, width: 1512, height: 982 } };
  it("scales points to the recorded frame size", () => {
    expect(digitRegion(overlay, { width: 3024, height: 1964 })).toEqual({ x: 2816, y: 74, width: 176, height: 176 });
    expect(digitRegion(overlay, { width: 1512, height: 982 })).toEqual({ x: 1408, y: 36, width: 88, height: 88 });
  });
  it("scales a window sized for the display (plan 045)", () => {
    // 14% of a 1920 × 1080 display's 1080 pt short side: a 238 pt window.
    const scaled = { window: { x: 1666, y: 37, width: 238, height: 238 }, display: { x: 0, y: 0, width: 1920, height: 1080 } };
    expect(digitRegion(scaled, { width: 1920, height: 1080 })).toEqual({ x: 1666, y: 36, width: 238, height: 238 });
    expect(digitRegion(scaled, { width: 3840, height: 2160 })).toEqual({ x: 3332, y: 74, width: 476, height: 476 });
    // A capped recording scales the region down with the frame.
    expect(digitRegion(scaled, { width: 1280, height: 720 })).toEqual({ x: 1110, y: 24, width: 158, height: 158 });
  });
  it("uses the display's own origin on a secondary display", () => {
    expect(digitRegion({ window: { x: -104, y: 12, width: 88, height: 88 }, display: { x: -1920, y: 0, width: 1920, height: 1080 } }, { width: 1920, height: 1080 }))
      .toEqual({ x: 1816, y: 12, width: 88, height: 88 });
  });
});

describe("crop comparison", () => {
  const flat = (value: number, size = 64): Uint8Array => new Uint8Array(size).fill(value);
  it("passes a static dark region and skips the material's flash", () => {
    const result = compareCrops([flat(10), flat(250), flat(11)], [flat(10), flat(250), flat(10)]);
    expect(result).toMatchObject({ judged: 2, pass: true, worst: 1 });
    expect(result.comparisons[1]).toEqual({ frame: 1, skipped: "flash" });
  });
  it("fails when an early frame still carries a faint digit", () => {
    const digit = flat(10);
    for (let i = 0; i < 16; i += 1) digit[i] = 10 + 71;
    const result = compareCrops([digit], [flat(10)]);
    expect(result.worst).toBeGreaterThan(DIGIT_DIFF_THRESHOLD);
    expect(result.pass).toBe(false);
  });
  it("is not a pass when nothing could be judged", () => {
    expect(compareCrops([flat(250)], [flat(250)])).toMatchObject({ judged: 0, pass: false });
  });
});

describe("tick check (plan 046)", () => {
  const rate = 48000;
  /** Half a second of the material as a mono mix: its 660 Hz tone (10 ms attack, 40 ms release) starting at `beepAt`. */
  function material(beepAt: number, amplitude = 0.15): Float32Array {
    const out = new Float32Array(rate / 2);
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate - beepAt;
      if (t < 0 || t > 0.12) continue;
      const envelope = t < 0.01 ? t / 0.01 : t < 0.08 ? 1 : (0.12 - t) / 0.04;
      out[i] = amplitude * envelope * Math.sin(2 * Math.PI * 660 * t);
    }
    return out;
  }
  /** Deterministic noise of peak `amplitude` from `from` to `to` seconds. */
  function noise(samples: Float32Array, amplitude: number, from = 0, to = samples.length / rate): Float32Array {
    const out = samples.slice();
    let seed = 1;
    for (let i = Math.round(from * rate); i < Math.round(to * rate); i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      out[i] = out[i]! + amplitude * (2 * seed / 2147483648 - 1);
    }
    return out;
  }
  /** The file as capture wrote it: digital silence until capture began, `seconds` in. */
  const capturedFrom = (samples: Float32Array, seconds: number): Float32Array => samples.slice().fill(0, 0, Math.round(seconds * rate));
  /** Adds the shared tick: −20 dBFS peak by default, 4 ms attack, exponential release over 140 ms. */
  function withTick(samples: Float32Array, at: number, hz: number, amplitude = 0.1): Float32Array {
    const out = samples.slice();
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate - at;
      if (t < 0 || t > 0.14) continue;
      const envelope = t < 0.004 ? t / 0.004 : Math.exp(Math.log(0.001) * (t - 0.004) / 0.136);
      out[i] = out[i]! + amplitude * envelope * Math.sin(2 * Math.PI * hz * t);
    }
    return out;
  }

  it("measures a steady sine at its level", () => {
    const sine = new Float32Array(rate / 2).map((_, i) => 0.1 * Math.sin((2 * Math.PI * 523 * i) / rate));
    expect(peakToneLevelDb(sine, rate, 523)).toBeCloseTo(-20, 0);
    expect(peakToneLevelDb(new Float32Array(rate / 2), rate, 523)).toBe(-Infinity);
  });

  it("passes the material's tone alone, which leaks equally into both windows", () => {
    const result = compareTickLevels(material(0.2), material(0.2), rate);
    expect(result.pass).toBe(true);
    for (const level of result.levels) expect(level.earlyDb - level.laterDb).toBeLessThan(TICK_EXCESS_DB);
  });

  it.each([523, 784.5])("fails when a %s Hz tick reaches the first audio, even at the start of the file", (hz) => {
    const result = compareTickLevels(withTick(material(0.2), 0, hz), material(0.2), rate);
    expect(result.pass).toBe(false);
    const level = result.levels.find((l) => l.hz === hz)!;
    expect(level.earlyDb).toBeGreaterThan(-40);
  });

  // The 2026-09-29 round: 40 ms of silence, then a −10 dBFS beep already past its attack (plan 054).
  it("passes a material beep the file starts inside, whose abrupt onset reaches both tick pitches", () => {
    const later = material(0.01, 0.3);
    const early = capturedFrom(later, 0.04);
    // Against the later window as recorded, the onset alone would read as a tick.
    for (const hz of TICK_PITCHES_HZ) expect(peakToneLevelDb(early, rate, hz)).toBeGreaterThan(Math.max(TICK_FLOOR_DBFS, peakToneLevelDb(later, rate, hz) + TICK_EXCESS_DB));
    const result = compareTickLevels(early, later, rate);
    expect(result.onsetSeconds).toBeCloseTo(0.04, 3);
    expect(result.pass).toBe(true);
    // The fade keeps the reference near the untruncated beep's leakage, far below a tick.
    for (const level of result.levels) expect(level.laterDb).toBeLessThan(-60);
    // Pre-echo up to 22 ms ahead of the onset, and a noise floor in both windows, do not hide it (review of plan 054).
    const preEcho = compareTickLevels(noise(early, 0.003, 0.018, 0.04), later, rate);
    expect(preEcho).toMatchObject({ pass: true });
    expect(preEcho.onsetSeconds).toBeCloseTo(0.04, 3);
    expect(compareTickLevels(noise(early, 0.0003), noise(later, 0.0003), rate).pass).toBe(true);
  });

  it("compares a beep that rises through its own attack, or a file that starts with sound, as recorded", () => {
    expect(compareTickLevels(material(0.2), material(0.2), rate)).not.toHaveProperty("onsetSeconds");
    expect(compareTickLevels(capturedFrom(material(0.2, 0.3), 0.1), material(0.2, 0.3), rate)).toMatchObject({ pass: true });
    expect(compareTickLevels(capturedFrom(material(0.2, 0.3), 0.1), material(0.2, 0.3), rate)).not.toHaveProperty("onsetSeconds");
    expect(compareTickLevels(material(-0.03, 0.3), material(-0.03, 0.3), rate)).not.toHaveProperty("onsetSeconds");
  });

  it.each([523, 784.5])("still fails a %s Hz tick the file starts inside, or one beside a truncated beep", (hz) => {
    // Capture began 20 ms into a tick: silence, then the tick's tail.
    expect(compareTickLevels(capturedFrom(withTick(material(0.2), 0, hz), 0.02), material(0.2), rate).pass).toBe(false);
    const later = material(0.01, 0.3);
    expect(compareTickLevels(withTick(capturedFrom(later, 0.04), 0.04, hz), later, rate).pass).toBe(false);
    // The tail of a tick that began before the file, 20 and 60 ms before capture, under the truncated beep's onset (review of plan 054).
    for (const tickAt of [0.02, -0.02]) expect(compareTickLevels(capturedFrom(withTick(later, tickAt, hz), 0.04), later, rate).pass).toBe(false);
  });

  it.each([523, 784.5])("never discards a quiet %s Hz tick that reaches the floor (review of plan 054)", (hz) => {
    // Below −60 dBFS at every sample, yet above −70 dBFS at its pitch, with no material in the window.
    const quiet = withTick(new Float32Array(rate / 2), 0.1, hz, 0.0015);
    expect(Math.max(...quiet.map(Math.abs))).toBeLessThan(0.002);
    expect(compareTickLevels(quiet, new Float32Array(rate / 2), rate)).toMatchObject({ pass: false });
    // Recorded sound before a truncated onset keeps the window as recorded rather than silencing it.
    const later = material(0.17, 0.3);
    const before = compareTickLevels(withTick(capturedFrom(later, 0.2), 0.05, hz, 0.001), later, rate);
    expect(before).not.toHaveProperty("onsetSeconds");
    expect(before.pass).toBe(false);
  });

  it("passes silence and is not a pass without audio", () => {
    expect(compareTickLevels(new Float32Array(rate / 2), new Float32Array(rate / 2), rate).pass).toBe(true);
    expect(compareTickLevels(new Float32Array(0), new Float32Array(rate / 2), rate).pass).toBe(false);
  });
});
