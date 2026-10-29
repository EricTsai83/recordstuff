/**
 * Plan 096 stage B, the parts that need no desktop (docs/system-design/tooling.md#real-speaker-echo-round): where an
 * editable recording's own sound tracks are, where the played material starts in it, how a take on the Mac's speakers
 * and the maintainer's read voice become a condition the analyzer reads as it reads stage A's, and the guided reading
 * page with the state it polls. `scripts/echo-record.mts` drives the app; everything here is pure or local.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { RATE, db, fft, nextPow2 } from "./echo-dsp.mts";
import { SCRIPT, SCRIPT_SECONDS, place, type Segment, type VolumeEvent } from "./echo-material.mts";
import type { EditableDescription } from "../../../src/shared/editable.ts";

/** Where an editable recording's own system and microphone tracks are among its sound tracks (plan 098's layout). */
export function soundTrackIndexes(description: EditableDescription, soundTracks: number): { system: number; microphone: number } | undefined {
  const offset = description.mix ? 1 : 0;
  const system = description.sounds.indexOf("system"), microphone = description.sounds.indexOf("microphone");
  if (system < 0 || microphone < 0 || soundTracks !== description.sounds.length + offset) return undefined;
  return { system: system + offset, microphone: microphone + offset };
}

/**
 * The lag (in samples, 0..maxLag) at which `played` best matches `recorded`: recorded[i + lag] ≈ k·played[i]. Judged
 * by normalized cross-correlation over the first `span` samples of `played`; `score` is that correlation (1 when the
 * recording is the material, scaled). The system track is the material digitally, so a real take scores near 1.
 */
export function findOffset(recorded: Float32Array, played: Float32Array, maxLag: number, span = 12 * RATE): { lag: number; score: number } {
  const length = Math.min(span, played.length);
  const size = nextPow2(length + maxLag);
  const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size);
  for (let i = 0; i < length; i++) ar[i] = played[i]!;
  for (let i = 0; i < Math.min(size, recorded.length); i++) br[i] = recorded[i]!;
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < size; i++) {
    const r = br[i]! * ar[i]! + bi[i]! * ai[i]!, m = bi[i]! * ar[i]! - br[i]! * ai[i]!;
    br[i] = r; bi[i] = m;
  }
  fft(br, bi, true);
  let playedEnergy = 0;
  for (let i = 0; i < length; i++) playedEnergy += played[i]! ** 2;
  // A running window of the recording's energy under the material, for the normalization.
  const prefix = new Float64Array(recorded.length + 1);
  for (let i = 0; i < recorded.length; i++) prefix[i + 1] = prefix[i]! + recorded[i]! ** 2;
  let best = { lag: 0, score: -Infinity };
  for (let lag = 0; lag <= maxLag && lag + length <= recorded.length; lag++) {
    const energy = prefix[lag + length]! - prefix[lag]!;
    const score = br[lag]! / Math.sqrt(Math.max(1e-30, energy * playedEnergy));
    if (score > best.score) best = { lag, score };
  }
  return best;
}

/** `length` samples of each channel from `offset`, zero past the end. */
export const cut = (channels: readonly Float32Array[], offset: number, length: number): Float32Array[] =>
  channels.map(c => { const out = new Float32Array(length); out.set(c.subarray(offset, Math.min(c.length, offset + length))); return out; });

export const mean = (channels: readonly Float32Array[]): Float32Array =>
  Float32Array.from(channels[0]!, (_, i) => channels.reduce((sum, c) => sum + c[i]!, 0) / channels.length);

/** Mean energy in dB of `pcm` from `from` to `to` seconds. */
export function levelDb(pcm: Float32Array, from: number, to: number): number {
  let sum = 0;
  const a = Math.max(0, Math.round(from * RATE)), b = Math.min(pcm.length, Math.round(to * RATE));
  for (let i = a; i < b; i++) sum += pcm[i]! ** 2;
  return db(sum / Math.max(1, b - a));
}

/**
 * The read voice's stretch: `seconds` of the voice take's microphone from where the reading started, refused when the
 * reading is not 15 dB over the take's quiet stretch before it (nobody read, or the wrong microphone).
 */
export function readVoice(mic: Float32Array, readStart: number, seconds: number): { voice: Float32Array; overQuietDb: number } | { problem: string } {
  const quiet = levelDb(mic, Math.max(0, readStart - 2.5), readStart - 0.5), read = levelDb(mic, readStart, readStart + seconds);
  if (read - quiet < 15) return { problem: `the reading was ${(read - quiet).toFixed(1)} dB over the quiet before it, not 15 dB: nothing read, or not on this microphone` };
  const start = Math.round(readStart * RATE);
  return { voice: mic.slice(start, start + Math.round(seconds * RATE)), overQuietDb: read - quiet };
}

/** How many seconds of read voice the script needs: its near-end-only and double-talk stretches. */
export const VOICE_SECONDS = SCRIPT.filter(s => s.kind === "near" || s.kind === "double").reduce((sum, s) => sum + s.end - s.start, 0);

export interface StageBTake {
  mic: Float32Array;
  reference: Float32Array[];
  ideal: Float32Array;
  echo: Float32Array;
  script: Segment[];
  events: VolumeEvent[];
}

/**
 * A condition as stage A's: the echo take's microphone (the speakers' echo and the room) plus the read voice placed in
 * the near-end and double-talk stretches; the ideal is that voice alone; the reference is the echo take's system track.
 */
export function composeTake(echoMic: Float32Array, reference: readonly Float32Array[], voice: Float32Array, events: VolumeEvent[] = []): StageBTake {
  const length = Math.round(SCRIPT_SECONDS * RATE);
  const [echo] = cut([echoMic], 0, length) as [Float32Array];
  const ideal = place(voice, ["near", "double"]);
  const mic = Float32Array.from(echo, (v, i) => v + ideal[i]!);
  return { mic, reference: cut(reference, 0, length), ideal, echo, script: [...SCRIPT], events };
}

/**
 * Whether ScreenCaptureKit takes the system's sound before or after the output volume: the same material's reference
 * level at two output volumes. Equal within 1.5 dB is before (the reference does not follow the volume); 3 dB or more
 * lower at the lower volume is after.
 */
export function captureStage(lowVolumeDb: number, highVolumeDb: number): "before the output volume" | "after the output volume" | "unclear" {
  // Two silent references are equal too, and say nothing: the runner also requires each to match the material.
  if (Math.max(lowVolumeDb, highVolumeDb) < -90) return "unclear";
  const difference = highVolumeDb - lowVolumeDb;
  return Math.abs(difference) <= 1.5 ? "before the output volume" : difference >= 3 ? "after the output volume" : "unclear";
}

/** The median and the worst of a condition's runs (the lowest echo-to-voice is the worst case for G0). */
export function medianAndWorst(values: readonly number[]): { median: number | null; worst: number | null } {
  if (!values.length) return { median: null, worst: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor((sorted.length - 1) / 2)]!, worst: sorted[0]! };
}

/** What the guided page shows; the runner sets it and the page polls it. */
export type PageState =
  | { phase: "intro"; title: string; body: string }
  | { phase: "countdown"; title: string; remainingMs: number; lines: string[] }
  | { phase: "read"; title: string; remainingMs: number; totalMs: number; lines: string[] }
  | { phase: "quiet"; title: string; body: string; progress: string }
  | { phase: "done"; title: string; body: string };

/** The reading: Mandarin (Taiwan) and English sentences a person reads at a normal pace in about 20 seconds. */
export const READING_LINES = [
  "這段錄影示範如何建立一個新的專案。",
  "首先打開設定，選擇錄影要存放的資料夾。",
  "接著按下開始，畫面會先倒數三秒。",
  "Today we look at three ways to organize your notes.",
  "The first one is simple: keep a single inbox and review it every evening.",
  "錄完以後，檔案會出現在最近的錄影裡。",
] as const;

/**
 * The guided page, self-contained: it polls `/state` every 200 ms and draws the phase. Static text and no outside
 * resource, so the same page is shown every round and is kept with the round's evidence.
 */
export function readingPage(): string {
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>RecordStuff echo round</title>
<style>
  html, body { margin: 0; height: 100%; background: #111; color: #eee; font: 28px/1.5 -apple-system, "PingFang TC", sans-serif; }
  main { box-sizing: border-box; height: 100%; padding: 6vh 8vw; display: flex; flex-direction: column; justify-content: center; gap: 3vh; }
  h1 { font-size: 44px; margin: 0; }
  #count { font-size: 120px; font-variant-numeric: tabular-nums; }
  #lines p { margin: 0.3em 0; font-size: 40px; }
  #bar { height: 10px; background: #333; border-radius: 5px; overflow: hidden; }
  #bar div { height: 100%; width: 0; background: #4a9eff; }
  [hidden] { display: none !important; }
</style></head>
<body><main>
  <h1 id="title">…</h1>
  <div id="body"></div>
  <div id="count" hidden></div>
  <div id="lines" hidden></div>
  <div id="bar" hidden><div></div></div>
  <div id="progress"></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  function show(state) {
    $("title").textContent = state.title;
    $("body").textContent = state.body || "";
    $("progress").textContent = state.progress || "";
    $("count").hidden = state.phase !== "countdown";
    if (state.phase === "countdown") $("count").textContent = String(Math.max(1, Math.ceil(state.remainingMs / 1000)));
    const reading = state.phase === "countdown" || state.phase === "read";
    $("lines").hidden = !reading;
    if (reading && $("lines").dataset.text !== state.lines.join("\\n")) {
      $("lines").dataset.text = state.lines.join("\\n");
      $("lines").replaceChildren(...state.lines.map((line) => Object.assign(document.createElement("p"), { textContent: line })));
    }
    $("bar").hidden = state.phase !== "read";
    if (state.phase === "read") $("bar").firstElementChild.style.width = (100 * (1 - state.remainingMs / state.totalMs)).toFixed(1) + "%";
  }
  async function poll() {
    try { show(await (await fetch("/state", { cache: "no-store" })).json()); } catch {}
    setTimeout(poll, 200);
  }
  poll();
</script></body></html>
`;
}

/**
 * Serves the page and its state on 127.0.0.1 at a free port. `set` changes what the page shows; a countdown or a
 * reading counts down from when it was set. `close` stops the server.
 */
export async function servePage(initial: PageState): Promise<{ url: string; set(state: PageState): void; close(): Promise<void> }> {
  let state = initial, setAt = Date.now();
  const page = readingPage();
  const server = http.createServer((request, response) => {
    if (request.url === "/state") {
      const elapsed = Date.now() - setAt;
      const current = "remainingMs" in state ? { ...state, remainingMs: Math.max(0, state.remainingMs - elapsed) } : state;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(current));
    } else if (request.url === "/" || request.url?.startsWith("/?")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    set(next) { state = next; setAt = Date.now(); },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
