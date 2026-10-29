/**
 * Plan 096 stage A: material made by the tool and a simulated room, so the right answer is known in advance. A take is
 * a microphone (the near voice plus the speaker's echo plus a noise floor), the reference the system track would hold
 * (what the speakers played), and the ideal output (the microphone without the echo). Deterministic from the seed and
 * the sources; `say` voices also depend on the macOS release, which the bench records. Developer tooling only.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixture } from "./audio-quality.mts";
import { RATE, convolve, fromDb, gaussian, random, readWav } from "./echo-dsp.mts";

export type SegmentKind = "silence" | "far" | "near" | "double";
/** A stretch of the take with known content: far = sound playing, nobody talking; near = talking, nothing playing. */
export interface Segment { kind: SegmentKind; start: number; end: number }
/** The speakers' level changes and the reference does not: the system's output volume, captured before it (worst case). */
export interface VolumeEvent { kind: "volume"; at: number; gainDb: number }

export const SCRIPT: readonly Segment[] = [
  { kind: "silence", start: 0, end: 1 },
  { kind: "far", start: 1, end: 9 },
  { kind: "silence", start: 9, end: 10 },
  { kind: "near", start: 10, end: 15 },
  { kind: "double", start: 15, end: 25 },
  { kind: "far", start: 25, end: 33 },
  { kind: "silence", start: 33, end: 34 },
];
export const SCRIPT_SECONDS = 34;
export const VOLUME_STEP: VolumeEvent = { kind: "volume", at: 28, gainDb: 6 };
/** The near voice's level in the microphone (-26 dBFS RMS) and the far end's digital level (-20 dBFS RMS). */
export const VOICE_RMS = 0.05;
export const FAR_RMS = 0.1;
/** The microphone's own noise floor, -70 dBFS RMS. */
export const NOISE_RMS = 10 ** (-70 / 20);

export const ROOMS = {
  small: { rt60: 0.15, drrDb: 6 },
  medium: { rt60: 0.35, drrDb: 2 },
  reverberant: { rt60: 0.7, drrDb: -3 },
} as const;
export type RoomName = keyof typeof ROOMS;
export type FarMaterial = "speech" | "music" | "tones";

export interface Condition {
  name: string;
  /** `none`: headphones or the speakers off, no echo at all. */
  room: RoomName | "none";
  /** A small speaker driven into soft clipping. */
  distortion: boolean;
  far: FarMaterial;
  volumeStep: boolean;
  /** The echo's RMS in the microphone relative to the near voice's, in dB. */
  echoDb: number;
}

/** Stage A's conditions: three rooms, clean and distorted, speech and music; a volume change, the tones, no echo. */
export function stageAConditions(): Condition[] {
  const list: Condition[] = [];
  for (const room of Object.keys(ROOMS) as RoomName[]) {
    for (const distortion of [false, true]) {
      for (const far of ["speech", "music"] as const) {
        list.push({ name: `${room}-${distortion ? "distorted" : "clean"}-${far}`, room, distortion, far, volumeStep: false, echoDb: -6 });
      }
    }
  }
  list.push({ name: "medium-clean-music-volume", room: "medium", distortion: false, far: "music", volumeStep: true, echoDb: -6 });
  list.push({ name: "medium-clean-tones", room: "medium", distortion: false, far: "tones", volumeStep: false, echoDb: -6 });
  list.push({ name: "headphones-speech", room: "none", distortion: false, far: "speech", volumeStep: false, echoDb: -6 });
  return list;
}

/** RBJ biquad, applied in place. */
function biquad(signal: Float32Array, kind: "highpass" | "bandpass", frequency: number, q: number): Float32Array {
  const w = 2 * Math.PI * frequency / RATE, alpha = Math.sin(w) / (2 * q), cos = Math.cos(w);
  const [b0, b1, b2] = kind === "highpass" ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2] : [alpha, 0, -alpha];
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < signal.length; i++) {
    const x = signal[i]!;
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    signal[i] = y;
  }
  return signal;
}

/** A band-limited (PolyBLEP) sawtooth step: harmonics up to Nyquist without strong aliasing. */
function saw(phase: number, increment: number): number {
  let value = 2 * phase - 1;
  if (phase < increment) { const t = phase / increment; value -= t + t - t * t - 1; }
  else if (phase > 1 - increment) { const t = (phase - 1) / increment; value -= t * t + t + t + 1; }
  return value;
}

/** Scales the signal so its RMS over 20 ms frames above -50 dB of the loudest is `target`. */
function normalizeActive(channels: Float32Array[], target: number): void {
  const frame = RATE / 50, energies: number[] = [];
  for (const c of channels) for (let s = 0; s + frame <= c.length; s += frame) {
    let e = 0;
    for (let i = s; i < s + frame; i++) e += c[i]! ** 2;
    energies.push(e / frame);
  }
  const loudest = Math.max(...energies, 1e-20), active = energies.filter(e => e > loudest * 1e-5);
  const level = Math.sqrt(active.reduce((a, b) => a + b, 0) / Math.max(1, active.length));
  if (level > 0) for (const c of channels) for (let i = 0; i < c.length; i++) c[i] = c[i]! * target / level;
}

const VOWELS = [[700, 1200, 2600], [300, 2300, 3000], [500, 1900, 2600], [350, 800, 2400], [600, 1000, 2500]] as const;

/**
 * Speech-like sound where `say` is unavailable (CI, Linux, Windows): syllables of a gliding glottal sawtooth through
 * three formants, consonant noise bursts and pauses. It stands in for a voice's spectrum and rhythm, not its sound.
 */
export function syntheticVoice(seconds: number, seed: number, pitch = 140): Float32Array {
  const next = random(seed), out = new Float32Array(Math.round(seconds * RATE));
  let at = 0, count = 0;
  while (at < out.length) {
    const length = Math.round((0.12 + next() * 0.16) * RATE);
    const syllable = new Float32Array(length);
    const vowel = VOWELS[Math.floor(next() * VOWELS.length)]!, base = pitch * (0.85 + next() * 0.3), glide = (next() - 0.5) * 0.3;
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const f0 = base * (1 + glide * i / length), increment = f0 / RATE;
      syllable[i] = saw(phase, increment) + 0.02 * gaussian(next);
      phase = (phase + increment) % 1;
    }
    const voiced = new Float32Array(length);
    vowel.forEach((formant, index) => {
      const band = biquad(Float32Array.from(syllable), "bandpass", formant * (0.9 + next() * 0.2), 6 + index * 2);
      for (let i = 0; i < length; i++) voiced[i] = voiced[i]! + band[i]! / (index + 1);
    });
    const attack = 0.015 * RATE, release = 0.03 * RATE;
    for (let i = 0; i < length && at + i < out.length; i++) out[at + i] = voiced[i]! * Math.min(1, i / attack, (length - i) / release);
    if (next() < 0.5) {
      // A fricative before the next syllable: noise above about 4 kHz.
      const burst = biquad(Float32Array.from({ length: Math.round((0.03 + next() * 0.05) * RATE) }, () => gaussian(next)), "highpass", 4000, 0.7);
      const start = at + length;
      for (let i = 0; i < burst.length && start + i < out.length; i++) out[start + i] = out[start + i]! + 0.15 * burst[i]! * Math.sin(Math.PI * i / burst.length);
      at += burst.length;
    }
    at += length + Math.round((0.02 + next() * 0.06) * RATE);
    if (++count % (4 + Math.floor(next() * 6)) === 0) at += Math.round((0.25 + next() * 0.35) * RATE);
  }
  normalizeActive([out], VOICE_RMS);
  return out;
}

/**
 * Synthesized music, stereo: chords of band-limited sawtooths panned left and right, a bass line, a kick, a snare and
 * hi-hats, so low, high (to 16 kHz and beyond) and sudden sounds are all present.
 */
export function music(seconds: number, seed: number): [Float32Array, Float32Array] {
  const next = random(seed), length = Math.round(seconds * RATE);
  const left = new Float32Array(length), right = new Float32Array(length);
  const beat = 0.6, progression = [[261.6, 329.6, 392.0], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6], [196.0, 246.9, 293.7]];
  const phases = [0, 0, 0, 0];
  for (let i = 0; i < length; i++) {
    const t = i / RATE, beatIndex = Math.floor(t / beat), inBeat = t - beatIndex * beat;
    const chord = progression[Math.floor(beatIndex / 2) % progression.length]!;
    const sinceChord = t - Math.floor(beatIndex / 2) * 2 * beat;
    const chordEnvelope = Math.exp(-sinceChord / 0.8) * Math.min(1, sinceChord / 0.005);
    let l = 0, r = 0;
    chord.forEach((frequency, index) => {
      const increment = frequency / RATE;
      const value = saw(phases[index]!, increment) * chordEnvelope * 0.25;
      phases[index] = (phases[index]! + increment) % 1;
      l += value * [0.9, 0.5, 0.2][index]!; r += value * [0.2, 0.5, 0.9][index]!;
    });
    const bassFrequency = chord[0]! / 4, bassIncrement = bassFrequency / RATE;
    const bass = (Math.sin(2 * Math.PI * phases[3]!) + 0.4 * Math.sin(4 * Math.PI * phases[3]!)) * Math.exp(-inBeat / 0.4) * Math.min(1, inBeat / 0.005) * 0.5;
    phases[3] = (phases[3]! + bassIncrement) % 1;
    const kick = beatIndex % 2 === 0 ? Math.sin(2 * Math.PI * (50 * inBeat + 70 * 0.05 * (1 - Math.exp(-inBeat / 0.05)))) * Math.exp(-inBeat / 0.15) : 0;
    left[i] = l + bass + kick; right[i] = r + bass + kick;
  }
  // Noise drums, then high-passed for the hi-hats: a snare on beats 2 and 4, a hi-hat every half beat.
  const hats = new Float32Array(length), snare = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / RATE, half = t % (beat / 2), inBeat = t % beat, beatIndex = Math.floor(t / beat);
    const noise = gaussian(next);
    hats[i] = noise * Math.exp(-half / 0.03) * 0.3;
    snare[i] = beatIndex % 2 === 1 ? noise * Math.exp(-inBeat / 0.12) * 0.4 : 0;
  }
  biquad(hats, "highpass", 7000, 0.7);
  biquad(snare, "bandpass", 1800, 0.8);
  for (let i = 0; i < length; i++) {
    left[i] = left[i]! + 0.8 * hats[i]! + snare[i]!;
    right[i] = right[i]! + hats[i]! + 0.8 * snare[i]!;
  }
  normalizeActive([left, right], FAR_RMS);
  return [left, right];
}

/** Fixture v2's tones (docs/system-design/audio-quality.md), repeated to the length. */
export function tones(seconds: number): [Float32Array, Float32Array] {
  const source = fixture(), frames = source.length / 2, length = Math.round(seconds * RATE);
  const left = new Float32Array(length), right = new Float32Array(length);
  for (let i = 0; i < length; i++) { left[i] = source[(i % frames) * 2]!; right[i] = source[(i % frames) * 2 + 1]!; }
  return [left, right];
}

/** A voice from macOS speech synthesis, 48 kHz mono float, cycling sentences and voices to at least `seconds`. */
export function sayVoice(voices: readonly string[], sentences: readonly string[], seconds: number): Float32Array {
  if (process.platform !== "darwin") throw new Error("`say` voices need macOS; use --voices synthetic elsewhere");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-echo-say-"));
  const parts: Float32Array[] = [];
  let total = 0;
  try {
    for (let i = 0; total < seconds * RATE; i++) {
      const file = path.join(directory, `${i}.wav`);
      const voice = voices[i % voices.length]!, text = sentences[i % sentences.length]!;
      const result = spawnSync("say", ["-v", voice, "-o", file, "--file-format=WAVE", "--data-format=LEF32@48000", text], { encoding: "utf8", timeout: 60_000 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`say -v ${voice} failed: ${result.stderr.trim()}`);
      const { rate, channels } = readWav(fs.readFileSync(file));
      if (rate !== RATE || channels.length !== 1) throw new Error(`say wrote ${rate} Hz, ${channels.length} channels`);
      parts.push(channels[0]!, new Float32Array(Math.round(0.35 * RATE)));
      total += channels[0]!.length + Math.round(0.35 * RATE);
      if (i > 500) throw new Error("say produced no sound");
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const out = new Float32Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  normalizeActive([out], VOICE_RMS);
  return out;
}

/** The room between one speaker and the microphone: the direct sound, a few early reflections and a decaying tail. */
export function roomResponse(name: RoomName, seed: number): Float32Array {
  const room = ROOMS[name], next = random(seed);
  const length = Math.round(Math.min(1, room.rt60 * 1.2) * RATE), direct = Math.round(0.001 * RATE);
  const response = new Float32Array(length);
  response[direct] = 1;
  for (let i = 0; i < 6; i++) {
    const at = direct + Math.round((0.002 + next() * 0.013) * RATE);
    response[at] = response[at]! + (next() < 0.5 ? -1 : 1) * (0.2 + next() * 0.3);
  }
  let early = 0;
  for (const v of response) early += v * v;
  const tail = new Float32Array(length);
  let tailEnergy = 0;
  for (let i = direct + 48; i < length; i++) {
    tail[i] = gaussian(next) * Math.exp(-6.908 * (i - direct) / RATE / room.rt60);
    tailEnergy += tail[i]! ** 2;
  }
  const scale = Math.sqrt(early / fromDb(room.drrDb) ** 2 / tailEnergy);
  for (let i = 0; i < length; i++) response[i] = response[i]! + tail[i]! * scale;
  return response;
}

/** Fills the script's segments of the given kinds from `source` in order, with 10 ms fades; silence elsewhere. */
export function place(source: Float32Array, kinds: readonly SegmentKind[], script: readonly Segment[] = SCRIPT, seconds = SCRIPT_SECONDS): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE)), fade = 0.01 * RATE;
  let cursor = 0;
  for (const segment of script) {
    if (!kinds.includes(segment.kind)) continue;
    const start = Math.round(segment.start * RATE), length = Math.round((segment.end - segment.start) * RATE);
    for (let i = 0; i < length; i++) out[start + i] = source[(cursor + i) % source.length]! * Math.min(1, i / fade, (length - 1 - i) / fade);
    cursor += length;
  }
  return out;
}

export interface Take {
  condition: Condition;
  seed: number;
  /** The microphone track: ideal + echo. */
  mic: Float32Array;
  /** What the system track holds: the far end as played, stereo. */
  reference: [Float32Array, Float32Array];
  /** The microphone without the echo: the near voice and the noise floor. */
  ideal: Float32Array;
  echo: Float32Array;
  script: Segment[];
  events: VolumeEvent[];
  /** The speakers-to-microphone device delay, in samples. */
  delaySamples: number;
}

/** Builds one take from a near voice and the far end (both continuous sources; the script places them). */
export function buildTake(condition: Condition, seed: number, nearSource: Float32Array, farSource: readonly [Float32Array, Float32Array]): Take {
  const next = random(seed ^ 0x9e3779b9);
  const voice = place(nearSource, ["near", "double"]);
  const reference: [Float32Array, Float32Array] = [place(farSource[0], ["far", "double"]), place(farSource[1], ["far", "double"])];
  const length = voice.length, delaySamples = Math.round((0.035 + next() * 0.01) * RATE);
  const echo = new Float32Array(length);
  if (condition.room !== "none") {
    reference.forEach((channel, index) => {
      // A laptop speaker: little below 150 Hz, and with `distortion` soft clipping at its peaks.
      const speaker = biquad(Float32Array.from(channel), "highpass", 150, 0.7);
      if (condition.distortion) {
        let peak = 0;
        for (const v of speaker) peak = Math.max(peak, Math.abs(v));
        const drive = 1.5 / Math.max(peak, 1e-9);
        for (let i = 0; i < speaker.length; i++) speaker[i] = Math.tanh(speaker[i]! * drive) / drive;
      }
      const heard = convolve(speaker, roomResponse(condition.room as RoomName, seed + index * 7919));
      for (let i = delaySamples; i < length; i++) echo[i] = echo[i]! + heard[i - delaySamples]!;
    });
    // The echo's level relative to the voice, measured where each is alone.
    const level = (pcm: Float32Array, kind: SegmentKind): number => {
      let sum = 0, count = 0;
      for (const s of SCRIPT.filter(s => s.kind === kind)) for (let i = Math.round(s.start * RATE); i < Math.round(s.end * RATE); i++) { sum += pcm[i]! ** 2; count++; }
      return Math.sqrt(sum / Math.max(1, count));
    };
    const scale = level(voice, "near") * fromDb(condition.echoDb) / Math.max(level(echo, "far"), 1e-12);
    for (let i = 0; i < length; i++) echo[i] = echo[i]! * scale;
  }
  const events: VolumeEvent[] = condition.volumeStep ? [VOLUME_STEP] : [];
  for (const event of events) {
    const at = Math.round(event.at * RATE), ramp = 0.01 * RATE, gain = fromDb(event.gainDb);
    for (let i = at; i < length; i++) echo[i] = echo[i]! * (1 + (gain - 1) * Math.min(1, (i - at) / ramp));
  }
  const ideal = new Float32Array(length), mic = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    ideal[i] = voice[i]! + NOISE_RMS * gaussian(next);
    mic[i] = ideal[i]! + echo[i]!;
  }
  return { condition, seed, mic, reference, ideal, echo, script: [...SCRIPT], events, delaySamples };
}

export const NEAR_VOICES = ["Meijia", "Eddy (中文（台灣）)"] as const;
export const FAR_VOICES = ["Samantha", "Reed (英文（美國）)"] as const;
export const NEAR_SENTENCES = [
  "這段錄影示範如何建立一個新的專案。",
  "首先打開設定，選擇錄影要存放的資料夾。",
  "接著按下開始，畫面會先倒數三秒。",
  "如果想要暫停，可以再按一次同一個快捷鍵。",
  "錄完以後，檔案會出現在最近的錄影裡。",
] as const;
export const FAR_SENTENCES = [
  "Welcome back to the channel. Today we look at three ways to organize your notes.",
  "The first one is simple: keep a single inbox and review it every evening.",
  "Next, let's talk about tags, and why you probably need fewer of them than you think.",
  "Finally, remember to back everything up before you try something new.",
] as const;
