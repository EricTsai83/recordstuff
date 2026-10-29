import { beforeAll, describe, expect, it } from "vitest";
import { RATE, convolve, fft, fromDb, percentile, random, readWav, writeWav } from "./echo-dsp.mts";
import { SCRIPT, VOLUME_STEP, buildTake, music, stageAConditions, syntheticVoice, type Condition, type Take } from "./echo-material.mts";
import { FRAME, analyzeEcho, type EchoReport } from "./echo-analyze.mts";

const condition = (name: string): Condition => stageAConditions().find(c => c.name === name)!;
const farVoice = (seconds: number): [Float32Array, Float32Array] => { const v = syntheticVoice(seconds, 2, 210); return [v, v]; };
const near = syntheticVoice(40, 1);
const analyze = (take: Take, output: Float32Array): EchoReport =>
  analyzeEcho({ input: take.mic, output, ideal: take.ideal, script: take.script, events: take.events });
const map = (take: Take, f: (i: number) => number): Float32Array => Float32Array.from(take.mic, (_, i) => f(i));
const failed = (r: EchoReport, gate: string): string[] => r.checks.filter(c => c.gate === gate && c.pass === false).map(c => c.metric);

describe("echo bench signal helpers", () => {
  it("transforms and inverts, and convolves like the direct sum", () => {
    const next = random(3), re = Float64Array.from({ length: 64 }, () => next() - 0.5), im = new Float64Array(64), copy = Float64Array.from(re);
    fft(re, im); fft(re, im, true);
    re.forEach((v, i) => expect(v).toBeCloseTo(copy[i]!, 12));
    const signal = Float32Array.from({ length: 300 }, () => next() - 0.5), kernel = Float32Array.from({ length: 37 }, () => next() - 0.5);
    const fast = convolve(signal, kernel);
    for (let n = 0; n < signal.length; n++) {
      let direct = 0;
      for (let k = 0; k < kernel.length && k <= n; k++) direct += signal[n - k]! * kernel[k]!;
      expect(fast[n]).toBeCloseTo(direct, 5);
    }
  });

  it("reads back the float WAV it writes, and integer PCM", () => {
    const channels = [Float32Array.of(0, 0.5, -0.25), Float32Array.of(1, -1, 0.125)];
    const read = readWav(writeWav(channels));
    expect(read.rate).toBe(RATE);
    expect(read.channels).toEqual(channels);
    const pcm = Buffer.from(writeWav([Float32Array.of(0)]));
    pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(16, 34); pcm.writeUInt32LE(2, 40); pcm.writeInt16LE(-16384, 44);
    expect(readWav(pcm.subarray(0, 46)).channels[0]![0]).toBe(-0.5);
  });

  it("repeats its random sequence for a seed and interpolates percentiles", () => {
    const a = random(7), b = random(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(percentile([4, 1, 3, 2], 50)).toBe(2.5);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("echo bench material", () => {
  let take: Take;
  beforeAll(() => { take = buildTake(condition("medium-clean-speech"), 11, near, farVoice(40)); });

  it("is the same take for the same seed, and the microphone is the ideal plus the echo", () => {
    const again = buildTake(condition("medium-clean-speech"), 11, near, farVoice(40));
    expect(again.mic).toEqual(take.mic);
    for (let i = 0; i < take.mic.length; i += 997) expect(take.mic[i]).toBeCloseTo(take.ideal[i]! + take.echo[i]!, 6);
  });

  it("places the voice and the far end only in their segments, at the condition's echo level", () => {
    const level = (pcm: Float32Array, kind: string): number => {
      let sum = 0, count = 0;
      for (const s of SCRIPT.filter(s => s.kind === kind)) for (let i = Math.round(s.start * RATE); i < Math.round(s.end * RATE); i++) { sum += pcm[i]! ** 2; count++; }
      return 10 * Math.log10(sum / count);
    };
    expect(level(take.reference[0], "near")).toBe(-Infinity);
    expect(level(take.ideal, "far")).toBeLessThan(-65);
    expect(level(take.echo, "far") - level(take.ideal, "near")).toBeCloseTo(-6, 1);
  });

  it("has no echo with headphones, and a volume step raises only the echo", () => {
    const headphones = buildTake(condition("headphones-speech"), 11, near, farVoice(40));
    expect(headphones.echo.every(v => v === 0)).toBe(true);
    const volume = buildTake(condition("medium-clean-music-volume"), 11, near, music(40, 5));
    const plain = buildTake({ ...condition("medium-clean-music-volume"), volumeStep: false }, 11, near, music(40, 5));
    const at = Math.round((VOLUME_STEP.at + 0.5) * RATE);
    expect(volume.echo[at]! / plain.echo[at]!).toBeCloseTo(fromDb(VOLUME_STEP.gainDb), 4);
    expect(volume.echo[at - RATE]).toBe(plain.echo[at - RATE]);
    expect(volume.reference).toEqual(plain.reference);
  });
});

describe("echo analyzer: testing the test", () => {
  let speech: Take, tunes: Take;
  beforeAll(() => {
    speech = buildTake(condition("medium-clean-speech"), 11, near, farVoice(40));
    tunes = buildTake(condition("medium-clean-music-volume"), 12, near, music(40, 5));
  });

  it("reads a known fraction of echo removed within 0.5 dB", () => {
    for (const known of [20, 30]) {
      const keep = fromDb(-known), report = analyze(speech, map(speech, i => speech.ideal[i]! + keep * speech.echo[i]!));
      expect(Math.abs(report.erle.full.median! - known)).toBeLessThan(0.5);
      expect(Math.abs(report.erle["1k-4k"].median! - known)).toBeLessThan(0.5);
    }
  });

  it("reads a pass-through as 0 dB ERLE and an unchanged voice", () => {
    const report = analyze(speech, Float32Array.from(speech.mic));
    expect(Math.abs(report.erle.full.median!)).toBeLessThan(0.01);
    expect(report.nearEnd.full.changeDb).toBe(-120);
    expect(report.nearEnd.full.levelDb).toBeCloseTo(0, 6);
    expect(Math.abs(report.doubleTalk.full.medianLossDb!)).toBeLessThan(0.01);
    expect(report.doubleTalk.full.p95LossDb!).toBeLessThan(0.01);
    expect(report.doubleTalk.full.dropoutFraction).toBe(0);
    expect(report.raw.echoToVoiceDb).toBeGreaterThan(-8);
    expect(report.verdict).toBe("fail");
    expect(failed(report, "G1a")).toHaveLength(1);
    expect(failed(report, "G2")).toEqual([]);
    expect(failed(report, "G3")).toEqual([]);
  });

  it("fails every voice metric for a canceller that outputs silence", () => {
    const report = analyze(speech, new Float32Array(speech.mic.length));
    const voice = report.checks.filter(c => c.gate === "G2" || c.gate === "G3");
    expect(voice.length).toBeGreaterThan(3);
    expect(voice.filter(c => c.pass !== false)).toEqual([]);
  });

  it("passes the perfect canceller, also when its output is late", () => {
    for (const take of [speech, tunes]) {
      const report = analyze(take, Float32Array.from(take.ideal));
      expect(report.checks.filter(c => c.pass === false)).toEqual([]);
      expect(report.verdict).toBe("pass");
    }
    const late = new Float32Array(speech.ideal.length);
    late.set(speech.ideal.subarray(0, late.length - 100), 100);
    const report = analyze(speech, late);
    expect(report.lagSamples).toBe(100);
    expect(failed(report, "G3")).toEqual([]);
  });

  it("times re-convergence after a volume change", () => {
    // A canceller that removes everything except during the 3 s after the step: G1c must fail that change only.
    const step = Math.round(VOLUME_STEP.at * RATE);
    const report = analyze(tunes, map(tunes, i => tunes.ideal[i]! + (i >= step && i < step + 3 * RATE ? tunes.echo[i]! : 0)));
    const g1c = report.checks.filter(c => c.gate === "G1c");
    expect(g1c.map(c => c.pass)).toEqual([true, false]);
    expect(report.convergence[1]!.seconds!).toBeGreaterThan(2.9);
    expect(report.convergence[1]!.seconds!).toBeLessThan(3.2);
  });

  it("judges a fixed phase per frequency as a change, and reports it normalized beside the gates", () => {
    // A perfect canceller whose output went through a first-order all-pass (magnitude 1, phase varying with frequency).
    const allPass = (pcm: Float32Array, a: number, gain = 1): Float32Array => {
      const out = new Float32Array(pcm.length);
      let x1 = 0, y1 = 0;
      for (let i = 0; i < pcm.length; i++) { const y = -a * pcm[i]! + x1 + a * y1; x1 = pcm[i]!; y1 = y; out[i] = gain * y; }
      return out;
    };
    // The gates judge the output as it is (D1 froze "output − input"): the phase change fails the unchanged-voice check.
    const shifted = analyze(speech, allPass(speech.ideal, 0.6));
    expect(failed(shifted, "G2")).toContain("Change without echo, full band (dB)");
    // Normalized, the same output reads unchanged; 3 dB quieter still reads as a loss there.
    expect(shifted.phaseNormalized!.full.changeDb!).toBeLessThan(-40);
    expect(shifted.phaseNormalized!.full.medianLossDb!).toBeLessThan(0.5);
    const quieter = analyze(speech, allPass(speech.ideal, 0.6, fromDb(-3)));
    expect(quieter.phaseNormalized!.full.changeDb!).toBeGreaterThan(-40);
    expect(quieter.phaseNormalized!.full.medianLossDb!).toBeGreaterThan(2.5);
  });

  it("judges convergence on complete 100 ms windows, not a stretch's last frame alone", () => {
    // 30 dB removed throughout, except the far-end stretch's last whole frame at 10 dB: every 100 ms window still
    // reads above 15 dB, so both convergence times are found at once.
    const last = Math.floor((33 - 0.03) * RATE / FRAME) - 1;
    const report = analyze(tunes, map(tunes, i => tunes.ideal[i]! + tunes.echo[i]! * fromDb(Math.floor(i / FRAME) === last ? -10 : -30)));
    expect(report.convergence.map(c => c.seconds)).toEqual([expect.any(Number), expect.any(Number)]);
    expect(report.convergence.every(c => c.seconds! <= 0.1)).toBe(true);
    expect(report.checks.filter(c => c.gate === "G1c").map(c => c.pass)).toEqual([true, true]);
  });

  it("keeps ERLE finite on noiseless material", () => {
    const silent = new Float32Array(tunes.echo.length);
    const report = analyzeEcho({ input: tunes.echo, output: silent, ideal: silent, script: tunes.script, events: tunes.events });
    expect(Number.isFinite(report.erle.full.median)).toBe(true);
    expect(report.checks.find(c => c.gate === "G1a")!.pass).toBe(true);
  });

  it("catches a voice damaged by attenuated frames or a 4 kHz low-pass", () => {
    const next = random(9), attenuated = Float32Array.from(speech.ideal);
    for (let f = 0; f < attenuated.length / FRAME; f++) {
      if (next() < 0.05) for (let i = f * FRAME; i < (f + 1) * FRAME && i < attenuated.length; i++) attenuated[i] = attenuated[i]! * fromDb(-12);
    }
    const dropped = analyze(speech, attenuated);
    expect(failed(dropped, "G3")).toContain("Voice frames down more than 10 dB, full band");
    expect(failed(dropped, "G1a")).toEqual([]);

    // A brick-wall 4 kHz low-pass (a long windowed sinc).
    const taps = 1023, kernel = Float32Array.from({ length: taps }, (_, i) => {
      const n = i - (taps - 1) / 2, cut = 4000 / RATE;
      const sinc = n === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * n) / (Math.PI * n);
      return sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1)));
    });
    const filtered = convolve(speech.ideal, kernel), lowpassed = new Float32Array(filtered.length);
    lowpassed.set(filtered.subarray((taps - 1) / 2));
    const report = analyze(speech, lowpassed);
    expect(failed(report, "G3").some(m => m.startsWith("Voice loss 4k-8k"))).toBe(true);
  });
});
