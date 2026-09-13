/** Diagnostic fixture v2 and deterministic PCM analysis. See docs/system-design/audio-quality.md. */
export const RATE = 48_000;
export const AMPLITUDE = 0.25;
export const FREQUENCIES = [250, 1000, 4000, 8000, 12000, 16000] as const;
export const FIXTURE_VERSION = 2;
export const END_MARKER_START = 11.1;
export const FIXTURE_SECONDS = 12.1;
export const TONES = [0, 1].flatMap((channel) =>
  FREQUENCIES.map((frequency, index) => ({ channel, frequency, start: 1.5 + (channel * 6 + index) * 0.8 })),
);
export const LIMITS = {
  responseDb: 3, gainDb: 6, separationDb: 30, residualDb: -25,
  dropoutDb: -15, clippingFraction: 0.001, clockPpm: 200, timingMs: 20, gapDb: -35,
};
export interface AudioCheck { metric: string; value: number | null; expected: string; pass: boolean }
export interface AudioReport {
  version: 2;
  fixtureVersion: 2;
  verdict: "pass" | "fail" | "invalid";
  onsetSeconds: number | null;
  clockPpm: number | null;
  limits: typeof LIMITS;
  checks: AudioCheck[];
}

/** Each isolated-channel probe includes a simultaneous 1 kHz pilot at the same amplitude. */
export function fixture(): Float32Array {
  const pcm = new Float32Array(Math.round(FIXTURE_SECONDS * RATE) * 2);
  const tone = (start: number, duration: number, frequencies: number[], channels: number[], amplitude: number): void => {
    const count = Math.round(duration * RATE);
    for (let i = 0; i < count; i++) {
      const fade = Math.min(1, i / 480, (count - 1 - i) / 480);
      const sample = amplitude * fade * frequencies.reduce((sum, f) => sum + Math.sin(2 * Math.PI * f * i / RATE), 0);
      for (const channel of channels) pcm[(Math.round(start * RATE) + i) * 2 + channel] = sample;
    }
  };
  tone(0.5, 0.5, [1000], [0, 1], AMPLITUDE);
  for (const t of TONES) tone(t.start, 0.6, t.frequency === 1000 ? [1000] : [1000, t.frequency], [t.channel], AMPLITUDE / 2);
  tone(END_MARKER_START, 0.5, [2000], [0, 1], AMPLITUDE);
  return pcm;
}

export function wav(pcm: Float32Array): Buffer {
  const result = Buffer.alloc(44 + pcm.length * 2);
  result.write("RIFF", 0); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(2, 22);
  result.writeUInt32LE(RATE, 24); result.writeUInt32LE(RATE * 4, 28);
  result.writeUInt16LE(4, 32); result.writeUInt16LE(16, 34); result.write("data", 36);
  result.writeUInt32LE(pcm.length * 2, 40);
  pcm.forEach((v, i) => result.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return result;
}

const db = (ratio: number): number => 10 * Math.log10(Math.max(1e-15, ratio));
function energy(pcm: Float32Array, start: number, length: number, channel: number): number {
  let sum = 0;
  for (let i = start; i < start + length; i++) sum += (pcm[i * 2 + channel] ?? 0) ** 2;
  return sum / length;
}

/** Least-squares sinusoid fit includes DC and solves the Gram matrix: fractional cycles are valid. */
function fit(pcm: Float32Array, start: number, count: number, channel: number, frequencies: number[]) {
  const size = frequencies.length * 2 + 1;
  const matrix = Array.from({ length: size }, () => new Float64Array(size + 1));
  const sin = frequencies.map(() => 0), cos = frequencies.map(() => 1);
  const ds = frequencies.map(f => Math.sin(2 * Math.PI * f / RATE));
  const dc = frequencies.map(f => Math.cos(2 * Math.PI * f / RATE));
  const row = new Float64Array(size);
  let total = 0;
  for (let i = 0; i < count; i++) {
    row[0] = 1;
    for (let f = 0; f < frequencies.length; f++) {
      row[f * 2 + 1] = sin[f]!; row[f * 2 + 2] = cos[f]!;
      const nextSin = sin[f]! * dc[f]! + cos[f]! * ds[f]!;
      cos[f] = cos[f]! * dc[f]! - sin[f]! * ds[f]!;
      sin[f] = nextSin;
    }
    const sample = pcm[(start + i) * 2 + channel] ?? 0;
    total += sample * sample;
    for (let a = 0; a < size; a++) {
      matrix[a]![size] = matrix[a]![size]! + row[a]! * sample;
      for (let b = 0; b < size; b++) matrix[a]![b] = matrix[a]![b]! + row[a]! * row[b]!;
    }
  }
  const rhs = matrix.map(r => r[size]!);
  for (let a = 0; a < size; a++) {
    const divisor = matrix[a]![a]!;
    if (Math.abs(divisor) < 1e-12) throw new Error("Degenerate sinusoid fit");
    for (let b = a; b <= size; b++) matrix[a]![b] = matrix[a]![b]! / divisor;
    for (let c = 0; c < size; c++) {
      if (c === a) continue;
      const factor = matrix[c]![a]!;
      for (let b = a; b <= size; b++) matrix[c]![b] = matrix[c]![b]! - factor * matrix[a]![b]!;
    }
  }
  const coefficients = matrix.map(r => r[size]!);
  const powers = frequencies.map((_, i) => (coefficients[i * 2 + 1]! ** 2 + coefficients[i * 2 + 2]! ** 2) / 2);
  const explained = coefficients.reduce((sum, c, i) => sum + c * rhs[i]!, 0);
  // DC is not silently forgiven: include it in the reported residual.
  const residual = Math.max(0, (total - explained) / count) + coefficients[0]! ** 2;
  return { powers, total: total / count, residual };
}

/** Search a bounded frequency interval, then refine its best lobe. Not an unrestricted distortion repair. */
function estimateFrequency(pcm: Float32Array, start: number, count: number, channel: number, nominal: number): number {
  const span = Math.max(0.5, nominal * 0.001);
  const score = (frequency: number): number => -fit(pcm, start, count, channel, [frequency]).residual;
  let best = nominal, bestScore = -Infinity;
  for (let f = nominal - span; f <= nominal + span + 1e-9; f += 0.5) {
    const value = score(f);
    if (value > bestScore) { best = f; bestScore = value; }
  }
  let lo = Math.max(nominal - span, best - 0.5), hi = Math.min(nominal + span, best + 0.5);
  for (let i = 0; i < 24; i++) {
    const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
    if (score(a) > score(b)) hi = b; else lo = a;
  }
  return (lo + hi) / 2;
}

/** Coherent marker runs ignore unrelated startup transients; marker gaps are validated separately. */
function markerOnset(pcm: Float32Array, frequency: number, from = 0, to = pcm.length / 2 / RATE): number | undefined {
  let run = 0;
  const last = Math.min(Math.floor(to * 100), Math.floor(pcm.length / 2 / 480));
  for (let i = Math.max(0, Math.floor(from * 100)); i < last; i++) {
    const tone = fit(pcm, i * 480, 480, 0, [frequency]);
    run = tone.powers[0]! > 1e-8 && tone.residual <= tone.total * 0.05 ? run + 1 : 0;
    if (run >= 30) return (i - run + 1) * 0.01;
  }
  return undefined;
}

/** Fixture-v2-only diagnostic gate, with invalid measurement separated from valid quality failures. */
export function analyze(pcm: Float32Array, sampleRate = RATE, channels = 2): AudioReport {
  const checks: AudioCheck[] = [];
  let onsetSeconds: number | null = null, clockPpm: number | null = null;
  const add = (metric: string, value: number, expected: string, pass: boolean): void => {
    checks.push({ metric, value: Number.isFinite(value) ? value : null, expected, pass: pass && Number.isFinite(value) });
  };
  const result = (invalid = false): AudioReport => ({ version: 2, fixtureVersion: FIXTURE_VERSION,
    verdict: invalid ? "invalid" : checks.every(c => c.pass) ? "pass" : "fail", onsetSeconds, clockPpm, limits: LIMITS, checks });
  add("Sample rate", sampleRate, "48000 Hz", sampleRate === RATE);
  add("Channels", channels, "2", channels === 2);
  if (sampleRate !== RATE || channels !== 2) return result();
  const valid = pcm.length > 0 && pcm.length % 2 === 0 && pcm.every(Number.isFinite);
  add("Valid PCM", valid ? 1 : 0, "nonempty, finite stereo PCM", valid);
  if (!valid) return result(true);
  const onset = markerOnset(pcm, 1000);
  add("Start marker detected", onset ?? -1, "300 ms coherent 1 kHz above -80 dBFS", onset !== undefined);
  if (onset === undefined) return result(true);
  onsetSeconds = onset;
  const markerFrequency = estimateFrequency(pcm, Math.round((onset + 0.1) * RATE), RATE * 0.3, 0, 1000);
  const speed = markerFrequency / 1000;
  clockPpm = (speed - 1) * 1e6;
  add("Clock offset (ppm)", clockPpm, `±${LIMITS.clockPpm} ppm`, Math.abs(clockPpm) <= LIMITS.clockPpm);
  const at = (seconds: number): number => Math.round((onset + (seconds - 0.5) / speed) * RATE);
  const complete = at(FIXTURE_SECONDS - 0.02) <= pcm.length / 2;
  add("Complete fixture", pcm.length / 2 / RATE, `>= ${(at(FIXTURE_SECONDS - 0.02) / RATE).toFixed(3)} s`, complete);
  if (!complete) return result();
  const marker = fit(pcm, at(0.6), RATE * 0.3, 0, [markerFrequency]);
  const gap = energy(pcm, at(1.15), RATE * 0.2, 0);
  const gapDb = db(gap / Math.max(marker.total, 1e-15));
  add("Marker gap (dB)", gapDb, "<= -30 dB relative to marker", gapDb <= -30);
  const expectedEnd = at(END_MARKER_START) / RATE;
  const end = markerOnset(pcm, 2000, expectedEnd - 0.2, expectedEnd + 0.7);
  add("End marker detected", end ?? -1, "fixture v2 2 kHz end marker", end !== undefined);
  if (gapDb > -30 || end === undefined) return result(true);
  const timingMs = (end - expectedEnd) * 1000;
  add("End timing error (ms)", timingMs, `±${LIMITS.timingMs} ms`, Math.abs(timingMs) <= LIMITS.timingMs);

  for (const t of TONES) {
    const prefix = `${t.channel === 0 ? "L" : "R"} ${t.frequency} Hz`;
    const start = at(t.start + 0.15), count = Math.round(RATE * 0.3 / speed);
    // Estimate the pilot, which survives high-frequency attenuation. Its small
    // possible bias from the other component is covered by drift/codec controls.
    const pilotFrequency = estimateFrequency(pcm, start, count, t.channel, 1000);
    const frequencies = t.frequency === 1000 ? [pilotFrequency] : [pilotFrequency, t.frequency * pilotFrequency / 1000];
    const measured = fit(pcm, start, count, t.channel, frequencies);
    const pilot = measured.powers[0]!, fundamental = measured.powers[measured.powers.length - 1]!;
    const response = db(fundamental / Math.max(pilot, 1e-15));
    const gain = db(pilot / ((AMPLITUDE / 2) ** 2 / 2));
    const residual = db(measured.residual / Math.max(pilot + (t.frequency === 1000 ? 0 : fundamental), 1e-15));
    const other = fit(pcm, start, count, 1 - t.channel, frequencies);
    const separation = db((pilot + (t.frequency === 1000 ? 0 : fundamental)) / Math.max(other.total, 1e-15));
    add(`${prefix} pilot offset (ppm)`, (pilotFrequency / 1000 - 1) * 1e6, `±${LIMITS.clockPpm} ppm`, Math.abs(pilotFrequency / 1000 - 1) * 1e6 <= LIMITS.clockPpm);
    add(`${prefix} response (dB)`, response, `simultaneous 1 kHz ±${LIMITS.responseDb} dB`, Math.abs(response) <= LIMITS.responseDb && fundamental > 1e-8);
    add(`${prefix} gain (dB)`, gain, `0 ±${LIMITS.gainDb} dB`, Math.abs(gain) <= LIMITS.gainDb);
    add(`${prefix} separation (dB)`, separation, `>= ${LIMITS.separationDb} dB`, separation >= LIMITS.separationDb);
    add(`${prefix} residual (dB)`, residual, `<= ${LIMITS.residualDb} dB`, residual <= LIMITS.residualDb);

    // Inspect overlapping 10 ms blocks over 20..580 ms, not just the spectral window.
    // Fit each component separately so beating and a surviving pilot cannot hide a dropout.
    let minimumDb = Infinity, maxClipped = 0;
    for (let seconds = 0.02; seconds <= 0.570001; seconds += 0.005) {
      const blockStart = at(t.start + seconds), blockCount = Math.round(RATE * 0.01 / speed);
      const block = fit(pcm, blockStart, blockCount, t.channel, frequencies);
      // Inspect both components: a surviving pilot must not hide a missing probe.
      for (let component = 0; component < block.powers.length; component++) {
        minimumDb = Math.min(minimumDb, db(block.powers[component]! / Math.max(measured.powers[component]!, 1e-15)));
      }
      let clipped = 0;
      for (let i = blockStart; i < blockStart + blockCount; i++) if (Math.abs(pcm[i * 2 + t.channel]!) >= 0.999) clipped++;
      maxClipped = Math.max(maxClipped, clipped / blockCount);
    }
    add(`${prefix} minimum 10 ms level (dB)`, minimumDb, `>= ${LIMITS.dropoutDb} dB relative to each local component`, minimumDb >= LIMITS.dropoutDb);
    add(`${prefix} maximum clipped block fraction`, maxClipped, `<= ${LIMITS.clippingFraction}`, maxClipped <= LIMITS.clippingFraction);
    const silence = Math.max(energy(pcm, at(t.start + 0.66), Math.round(RATE * 0.08 / speed), 0), energy(pcm, at(t.start + 0.66), Math.round(RATE * 0.08 / speed), 1));
    const silenceDb = db(silence / Math.max(measured.total, 1e-15));
    add(`${prefix} following gap (dB)`, silenceDb, `<= ${LIMITS.gapDb} dB relative to local RMS`, silenceDb <= LIMITS.gapDb);
  }
  return result();
}
