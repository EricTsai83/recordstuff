import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze, fixture, wav, RATE, TONES, AMPLITUDE, FIXTURE_SECONDS, END_MARKER_START, type AudioReport } from "./audio-quality.mts";
import { summarize } from "./audio-quality-summary.mts";
import { inspectAudio } from "./audio-quality-tools.mts";

const failures = (r: AudioReport): string[] => r.checks.filter(c => !c.pass).map(c => c.metric);
function changeTone(pcm: Float32Array, frequency: number, map: (v: number, index: number) => number): void {
  for (const t of TONES.filter(t => t.frequency === frequency)) {
    for (let i = Math.round(t.start * RATE); i < Math.round((t.start + 0.6) * RATE); i++) {
      const p = i * 2 + t.channel;
      pcm[p] = map(pcm[p]!, i);
    }
  }
}

function clockControl(ppm: number): Float32Array {
  const speed = 1 + ppm / 1e6;
  const pcm = new Float32Array(Math.ceil(FIXTURE_SECONDS * RATE / speed) * 2);
  const sections = [
    { start: 0.5, duration: 0.5, frequencies: [1000], channels: [0, 1], amplitude: AMPLITUDE },
    ...TONES.map(t => ({ start: t.start, duration: 0.6, frequencies: t.frequency === 1000 ? [1000] : [1000, t.frequency], channels: [t.channel], amplitude: AMPLITUDE / 2 })),
    { start: END_MARKER_START, duration: 0.5, frequencies: [2000], channels: [0, 1], amplitude: AMPLITUDE },
  ];
  for (const section of sections) {
    for (let i = Math.ceil(section.start / speed * RATE); i < Math.floor((section.start + section.duration) / speed * RATE); i++) {
      const time = i / RATE * speed - section.start;
      const fade = Math.min(1, time / 0.01, (section.duration - time) / 0.01);
      const value = section.amplitude * fade * section.frequencies.reduce((sum, f) => sum + Math.sin(2 * Math.PI * f * time + 0.37), 0);
      for (const channel of section.channels) pcm[i * 2 + channel] = value;
    }
  }
  return pcm;
}

describe("audio quality regression detector", () => {
  it("passes the clean reference and remains aligned with leading delay and moderate gain", () => {
    expect(failures(analyze(fixture()))).toEqual([]);
    const original = fixture();
    const delayed = new Float32Array(original.length + 147_000);
    delayed.set(original.map(v => v * 0.8), 147_000);
    expect(failures(analyze(delayed))).toEqual([]);
  });
  it("ignores an unrelated startup transient before the marker", () => {
    const pcm = fixture();
    for (let i = 0; i < RATE * 0.2; i++) {
      pcm[i * 2] = pcm[i * 2 + 1] = 0.7 * Math.sin(2 * Math.PI * 330 * i / RATE);
    }
    expect(failures(analyze(pcm))).toEqual([]);
  });
  it.each([-100, -20, -10, 10, 20, 100])("fits clean signals with %s ppm clock offset and nonzero phase", (ppm) => {
    const report = analyze(clockControl(ppm));
    expect(failures(report)).toEqual([]);
    expect(report.clockPpm).toBeCloseTo(ppm, 0);
  });
  it("reports excessive clock offset separately from distortion", () => {
    const report = analyze(clockControl(300));
    expect(failures(report)).toContain("Clock offset (ppm)");
    expect(failures(report).filter(name => name.includes("residual"))).toEqual([]);
  });
  it("detects the previously missed removal of the first/last 100 ms of every probe", () => {
    const pcm = fixture();
    for (const t of TONES) {
      pcm.fill(0, Math.round(t.start * RATE) * 2, Math.round((t.start + 0.1) * RATE) * 2);
      pcm.fill(0, Math.round((t.start + 0.5) * RATE) * 2, Math.round((t.start + 0.6) * RATE) * 2);
    }
    const report = analyze(pcm);
    expect(failures(report).filter(name => name.includes("minimum 10 ms"))).toHaveLength(12);
  });
  it.each([0.025, 0.08, 0.25, 0.48, 0.545])("detects a 20 ms dropout at probe offset %s s", (offset) => {
    const pcm = fixture();
    pcm.fill(0, Math.round((1.5 + offset) * RATE) * 2, Math.round((1.52 + offset) * RATE) * 2);
    expect(failures(analyze(pcm))).toContain("L 250 Hz minimum 10 ms level (dB)");
  });
  it("detects a missing probe at the edge even while the pilot continues", () => {
    const pcm = fixture();
    const t = TONES.find(t => t.frequency === 8000)!;
    for (let i = Math.round(0.03 * RATE); i < Math.round(0.1 * RATE); i++) {
      const p = (Math.round(t.start * RATE) + i) * 2 + t.channel;
      pcm[p] = pcm[p]! - AMPLITUDE / 2 * Math.sin(2 * Math.PI * t.frequency * i / RATE);
    }
    expect(failures(analyze(pcm))).toContain("L 8000 Hz minimum 10 ms level (dB)");
  });
  it("detects a 50 ms insertion before the end marker", () => {
    const original = fixture();
    const split = Math.round(END_MARKER_START * RATE) * 2;
    const added = Math.round(0.05 * RATE) * 2;
    const pcm = new Float32Array(original.length + added);
    pcm.set(original.subarray(0, split));
    pcm.set(original.subarray(split), split + added);
    expect(failures(analyze(pcm))).toContain("End timing error (ms)");
  });
  it("does not mistake different constant gains between probes for frequency loss", () => {
    const pcm = fixture();
    for (const [i, f] of [250, 4000, 8000, 12000, 16000].entries()) changeTone(pcm, f, v => v * (0.6 + i * 0.15));
    expect(failures(analyze(pcm))).toEqual([]);
  });
  it("flags noise in probe gaps", () => {
    const pcm = fixture();
    pcm.fill(0.05, Math.round(2.17 * RATE) * 2, Math.round(2.21 * RATE) * 2);
    expect(failures(analyze(pcm))).toContain("L 250 Hz following gap (dB)");
  });
  it("does not dilute a short clipped region with trailing silence", () => {
    const pcm = new Float32Array(RATE * 60 * 2);
    pcm.set(fixture());
    pcm.fill(1, Math.round(1.535 * RATE) * 2, Math.round(1.54 * RATE) * 2);
    expect(failures(analyze(pcm))).toContain("L 250 Hz maximum clipped block fraction");
  });
  it("rejects a missing terminal marker even when silence pads the duration", () => {
    const pcm = fixture();
    pcm.fill(0, Math.round(END_MARKER_START * RATE) * 2);
    const report = analyze(pcm);
    expect(report.verdict).toBe("invalid");
    expect(failures(report)).toContain("End marker detected");
    expect(report.checks.some(c => c.metric.includes("response"))).toBe(false);
  });
  it("detects high-frequency loss independently of overall level", () => {
    const pcm = fixture();
    for (const frequency of [8000, 16000]) {
      for (const t of TONES.filter(t => t.frequency === frequency)) {
        for (let i = 0; i < Math.round(0.6 * RATE); i++) {
          const fade = Math.min(1, i / 480, (Math.round(0.6 * RATE) - 1 - i) / 480);
          const position = (Math.round(t.start * RATE) + i) * 2 + t.channel;
          pcm[position] = pcm[position]! - 0.9 * AMPLITUDE / 2 * fade * Math.sin(2 * Math.PI * frequency * i / RATE);
        }
      }
    }
    expect(failures(analyze(pcm))).toEqual(expect.arrayContaining(["L 8000 Hz response (dB)", "R 16000 Hz response (dB)"]));
  });
  it("rejects dual-mono even when both channels have plenty of energy", () => {
    const pcm = fixture();
    for (let i = 0; i < pcm.length; i += 2) pcm[i] = pcm[i + 1] = (pcm[i]! + pcm[i + 1]!) / 2;
    expect(failures(analyze(pcm))).toContain("L 1000 Hz separation (dB)");
  });
  it("rejects swapped or missing channels", () => {
    const pcm = fixture();
    for (let i = 0; i < pcm.length; i += 2) [pcm[i], pcm[i + 1]] = [pcm[i + 1]!, pcm[i]!];
    expect(analyze(pcm).verdict).not.toBe("pass");
    const missing = fixture();
    for (let i = 1; i < missing.length; i += 2) missing[i] = 0;
    expect(failures(analyze(missing))).toContain("R 1000 Hz gain (dB)");
  });
  it("detects attenuation, clipping and harmonic distortion", () => {
    expect(failures(analyze(fixture().map(v => v * 0.1)))).toContain("L 1000 Hz gain (dB)");
    const clipped = fixture();
    changeTone(clipped, 1000, v => Math.max(-1, Math.min(1, v * 16)));
    expect(failures(analyze(clipped))).toContain("L 1000 Hz maximum clipped block fraction");
    const pcm = fixture();
    changeTone(pcm, 1000, (v, i) => v + 0.04 * Math.sin(2 * Math.PI * 2000 * i / RATE));
    expect(failures(analyze(pcm))).toContain("L 1000 Hz residual (dB)");
  });
  it("detects a 30 ms dropout inside a measured tone", () => {
    const pcm = fixture();
    pcm.fill(0, Math.round(1.78 * RATE) * 2, Math.round(1.81 * RATE) * 2);
    expect(failures(analyze(pcm))).toContain("L 250 Hz minimum 10 ms level (dB)");
  });
  it("rejects silence, truncation, invalid PCM and wrong formats", () => {
    for (const pcm of [new Float32Array(), new Float32Array(RATE * 24), fixture().slice(0, RATE * 4), new Float32Array([NaN, 0]), new Float32Array([1])]) {
      expect(analyze(pcm).verdict).not.toBe("pass");
    }
    expect(analyze(fixture(), 44100).verdict).toBe("fail");
    expect(analyze(fixture(), RATE, 1).verdict).toBe("fail");
  });
  it("does not report frequency measurements when marker validation fails", () => {
    const pcm = fixture();
    pcm.fill(0.1, RATE * 2, Math.round(1.5 * RATE) * 2);
    const report = analyze(pcm);
    expect(failures(report)).toContain("Marker gap (dB)");
    expect(report.checks.some(c => c.metric.includes("response"))).toBe(false);
  });
  it("rejects a continuous tone that is not the fixture", () => {
    const pcm = fixture();
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.25 * Math.sin(2 * Math.PI * 1000 * Math.floor(i / 2) / RATE);
    expect(analyze(pcm).verdict).not.toBe("pass");
  });
});

const ffmpegAvailable = ["ffmpeg", "ffprobe"].every(tool => spawnSync(tool, ["-version"], { stdio: "ignore" }).status === 0);
describe.skipIf(!ffmpegAvailable)("FFmpeg audio quality integration (requires ffmpeg/ffprobe)", () => {
  it("passes PCM and AAC, fails actual low-pass and mono files, and exposes CLI exit status", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-audio-test-"));
    try {
      const source = path.join(dir, "reference.wav");
      fs.writeFileSync(source, wav(fixture()));
      expect(failures(inspectAudio(source))).toEqual([]);
      const encode = (name: string, args: string[]): string => {
        const file = path.join(dir, name);
        const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", source, ...args, file]);
        expect(result.status, result.stderr.toString()).toBe(0);
        return file;
      };
      const existing = spawnSync(process.execPath, ["scripts/audio-quality.mts", "record", dir], { encoding: "utf8" });
      expect(existing.status).toBe(2);
      expect(fs.readdirSync(dir)).toEqual(["reference.wav"]);
      const overwrite = spawnSync(process.execPath, ["scripts/audio-quality.mts", "fixture", source], { encoding: "utf8" });
      expect(overwrite.status).toBe(2);
      expect(fs.readFileSync(source)).toEqual(wav(fixture()));
      const aac = encode("good.m4a", ["-c:a", "aac", "-b:a", "256k"]);
      expect(failures(inspectAudio(aac))).toEqual([]);
      const lowpass = encode("muffled.wav", ["-af", "lowpass=f=3000"]);
      expect(failures(inspectAudio(lowpass))).toContain("L 8000 Hz response (dB)");
      const mono = encode("mono.wav", ["-ac", "1"]);
      expect(failures(inspectAudio(mono))).toEqual(["Channels"]);
      const silent = encode("silent.wav", ["-af", "volume=0"]);
      const wrongRate = encode("44100.wav", ["-ar", "44100"]);
      expect(failures(inspectAudio(wrongRate))).toEqual(["Sample rate"]);
      for (const [file, status] of [[aac, 0], [lowpass, 1], [silent, 2], [path.join(dir, "missing.wav"), 2]] as const) {
        const cli = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/audio-quality.mts", "verify", file], { encoding: "utf8" });
        expect(cli.status, cli.stderr || cli.stdout).toBe(status);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});


describe("repeat-run evidence", () => {
  const report = (value: number, verdict: AudioReport["verdict"]): AudioReport => ({
    version: 2, fixtureVersion: 2, verdict, onsetSeconds: 0.5, clockPpm: 0,
    limits: { responseDb: 3, gainDb: 6, separationDb: 30, residualDb: -25, dropoutDb: -15, clippingFraction: 0.001, clockPpm: 200, timingMs: 20, gapDb: -35 },
    checks: [{ metric: "response", value, expected: "±3 dB", pass: Math.abs(value) <= 3 }],
  });
  it("retains failures instead of letting the median hide them", () => {
    const result = summarize([report(0, "pass"), report(-12, "fail"), report(1, "pass")]);
    expect(result.verdict).toBe("fail");
    expect(result.metrics[0]).toMatchObject({ min: -12, median: 0, max: 1, measuredCount: 3, missingCount: 0 });
  });
  it("never labels an incomplete batch as passing", () => {
    const result = summarize([report(0, "pass")], 3);
    expect(result).toMatchObject({ verdict: "incomplete", requestedRuns: 3, runs: 1 });
    expect(() => summarize([report(0, "pass")], 0)).toThrow();
  });
  it("excludes invalid measurements explicitly and rejects an empty batch", () => {
    const result = summarize([report(-99, "invalid"), report(0, "pass")]);
    expect(result.verdict).toBe("invalid");
    expect(result.metrics[0]).toMatchObject({ min: 0, median: 0, max: 0, measuredCount: 1, missingCount: 1 });
    expect(() => summarize([])).toThrow();
  });
});
