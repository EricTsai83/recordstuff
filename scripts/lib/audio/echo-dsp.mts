/**
 * Signal helpers for plan 096's echo-removal bench (docs/system-design/tooling.md#echo-removal-bench): an FFT, FFT
 * convolution, float WAV files, a seeded generator and the statistics the analyzer reports. Developer tooling only.
 */
export const RATE = 48_000;

/** In-place radix-2 FFT of a complex signal; `inverse` also divides by the length. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n !== im.length || n < 1 || (n & (n - 1)) !== 0) throw new Error(`FFT length must be a power of two, not ${n}`);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const wr = Math.cos(angle), wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k, b = a + size / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] = re[i]! / n; im[i] = im[i]! / n; }
}

export const nextPow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/** `signal` convolved with `kernel` by overlap-add, truncated to the signal's length (the tail past it is dropped). */
export function convolve(signal: Float32Array, kernel: Float32Array): Float32Array {
  const block = nextPow2(kernel.length), size = block * 2;
  const kre = new Float64Array(size), kim = new Float64Array(size);
  kre.set(kernel);
  fft(kre, kim);
  const out = new Float32Array(signal.length);
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let start = 0; start < signal.length; start += block) {
    re.fill(0); im.fill(0);
    re.set(signal.subarray(start, Math.min(signal.length, start + block)));
    fft(re, im);
    for (let i = 0; i < size; i++) {
      const r = re[i]! * kre[i]! - im[i]! * kim[i]!;
      im[i] = re[i]! * kim[i]! + im[i]! * kre[i]!;
      re[i] = r;
    }
    fft(re, im, true);
    for (let i = 0; i < size && start + i < signal.length; i++) out[start + i] = out[start + i]! + re[i]!;
  }
  return out;
}

/** Mulberry32: the same seed always gives the same sequence in [0, 1). */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal sample (Box–Muller) from a uniform generator. */
export const gaussian = (next: () => number): number => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());

export const db = (ratio: number): number => 10 * Math.log10(Math.max(1e-20, ratio));
export const fromDb = (decibels: number): number => 10 ** (decibels / 20);

export function rms(pcm: Float32Array): number {
  let sum = 0;
  for (const v of pcm) sum += v * v;
  return Math.sqrt(sum / Math.max(1, pcm.length));
}

/** Linear interpolation between order statistics; `null` for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p / 100, low = Math.floor(index), high = Math.ceil(index);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}

/** A 32-bit float WAV of one or more equally long channels. */
export function writeWav(channels: readonly Float32Array[], rate = RATE): Buffer {
  const frames = channels[0]?.length ?? 0;
  if (!channels.length || channels.some(c => c.length !== frames)) throw new Error("WAV channels must be nonempty and equally long");
  const bytes = frames * channels.length * 4;
  const out = Buffer.alloc(44 + bytes);
  out.write("RIFF", 0); out.writeUInt32LE(36 + bytes, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(3, 20); out.writeUInt16LE(channels.length, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * channels.length * 4, 28);
  out.writeUInt16LE(channels.length * 4, 32); out.writeUInt16LE(32, 34); out.write("data", 36); out.writeUInt32LE(bytes, 40);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels.length; c++) out.writeFloatLE(channels[c]![i]!, 44 + (i * channels.length + c) * 4);
  return out;
}

/** Reads PCM (16, 24 or 32-bit integers) or 32-bit float WAV, plain or extensible, into one array per channel. */
export function readWav(file: Buffer): { rate: number; channels: Float32Array[] } {
  if (file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
  let format: { tag: number; channels: number; rate: number; bits: number } | undefined;
  for (let offset = 12; offset + 8 <= file.length;) {
    const id = file.toString("ascii", offset, offset + 4), size = file.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") {
      let tag = file.readUInt16LE(body);
      if (tag === 0xfffe) tag = file.readUInt16LE(body + 24);
      format = { tag, channels: file.readUInt16LE(body + 2), rate: file.readUInt32LE(body + 4), bits: file.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!format) throw new Error("WAV data before its format");
      const { tag, channels, bits } = format, width = bits / 8;
      if (!((tag === 3 && bits === 32) || (tag === 1 && [16, 24, 32].includes(bits)))) throw new Error(`Unsupported WAV format ${tag}/${bits}`);
      const frames = Math.floor(Math.min(size, file.length - body) / (width * channels));
      const out = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
          const at = body + (i * channels + c) * width;
          out[c]![i] = tag === 3 ? file.readFloatLE(at) : file.readIntLE(at, width) / 2 ** (bits - 1);
        }
      }
      return { rate: format.rate, channels: out };
    }
    offset = body + size + (size & 1);
  }
  throw new Error("WAV file has no data");
}
