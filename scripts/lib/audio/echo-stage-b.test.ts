import { describe, expect, it } from "vitest";
import { RATE, gaussian, random } from "./echo-dsp.mts";
import { SCRIPT_SECONDS, syntheticVoice, music } from "./echo-material.mts";
import { VOICE_SECONDS, captureStage, composeTake, cut, findOffset, medianAndWorst, readVoice, readingPage, servePage, soundTrackIndexes } from "./echo-stage-b.mts";

describe("echo stage B: the recording's tracks", () => {
  it("finds the inputs' own tracks after the mix, in the description's order", () => {
    expect(soundTrackIndexes({ sounds: ["system", "microphone"], mix: true, camera: null }, 3)).toEqual({ system: 1, microphone: 2 });
    expect(soundTrackIndexes({ sounds: ["microphone", "system"], mix: true, camera: null }, 3)).toEqual({ system: 2, microphone: 1 });
    expect(soundTrackIndexes({ sounds: ["system", "microphone"], camera: null }, 2)).toEqual({ system: 0, microphone: 1 });
    // One input only, or a file whose track count disagrees with its description: not a take this round can use.
    expect(soundTrackIndexes({ sounds: ["system"], camera: null }, 1)).toBeUndefined();
    expect(soundTrackIndexes({ sounds: ["system", "microphone"], mix: true, camera: null }, 2)).toBeUndefined();
  });

  it("finds where the material starts in a quieter, noisy recording of it", () => {
    const [played] = music(14, 4), next = random(8), lag = 31_337;
    const recorded = new Float32Array(played.length + 3 * RATE);
    for (let i = 0; i < recorded.length; i++) recorded[i] = 0.3 * (played[i - lag] ?? 0) + 0.01 * gaussian(next);
    const found = findOffset(recorded, played, 3 * RATE);
    expect(found.lag).toBe(lag);
    expect(found.score).toBeGreaterThan(0.9);
    // Silence where the material should be scores near nothing.
    expect(findOffset(Float32Array.from(recorded, () => 0.01 * gaussian(next)), played, 3 * RATE).score).toBeLessThan(0.1);
    expect(cut([recorded], lag, 4)[0]).toEqual(recorded.slice(lag, lag + 4));
  });
});

describe("echo stage B: the read voice and the composed take", () => {
  const quiet = (seconds: number, next = random(2)): Float32Array => Float32Array.from({ length: seconds * RATE }, () => 1e-4 * gaussian(next));

  it("takes the reading when it is well over the quiet before it, and refuses a silent one", () => {
    const mic = quiet(30), voice = syntheticVoice(20, 3);
    mic.set(voice.map((v, i) => v + mic[5 * RATE + i]!), 5 * RATE);
    const read = readVoice(mic, 5, VOICE_SECONDS);
    expect("voice" in read && read.voice.length).toBe(VOICE_SECONDS * RATE);
    expect("overQuietDb" in read && read.overQuietDb).toBeGreaterThan(30);
    expect(readVoice(quiet(30), 5, VOICE_SECONDS)).toHaveProperty("problem");
  });

  it("composes a stage A-shaped take: the microphone is the echo plus the voice, the ideal the voice alone", () => {
    const echo = quiet(SCRIPT_SECONDS + 2), [left, right] = music(SCRIPT_SECONDS + 2, 6), voice = syntheticVoice(VOICE_SECONDS, 7);
    const take = composeTake(echo, [left, right], voice, [{ kind: "volume", at: 28, gainDb: 5 }]);
    const length = SCRIPT_SECONDS * RATE;
    expect([take.mic.length, take.ideal.length, take.echo.length, take.reference[0]!.length]).toEqual([length, length, length, length]);
    for (let i = 0; i < length; i += 4999) expect(take.mic[i]).toBeCloseTo(take.echo[i]! + take.ideal[i]!, 6);
    // The voice only in the near-end and double-talk stretches (10–25 s).
    expect(take.ideal.subarray(0, 10 * RATE).every(v => v === 0)).toBe(true);
    expect(take.ideal.subarray(25 * RATE).every(v => v === 0)).toBe(true);
    expect(take.events).toHaveLength(1);
  });

  it("tells before from after the output volume, and reports a median and the worst run", () => {
    expect(captureStage(-20.4, -20)).toBe("before the output volume");
    expect(captureStage(-26, -20)).toBe("after the output volume");
    expect(captureStage(-22, -20)).toBe("unclear");
    expect(captureStage(-200, -200)).toBe("unclear");
    expect(medianAndWorst([-12, -20, -15])).toEqual({ median: -15, worst: -20 });
    expect(medianAndWorst([])).toEqual({ median: null, worst: null });
  });
});

describe("echo stage B: the guided page", () => {
  it("is self-contained and polls its state", () => {
    const page = readingPage();
    expect(page).toContain('fetch("/state"');
    expect(page).not.toMatch(/(src|href)=["']?https?:/);
  });

  it("serves the page and a countdown that runs down from when it was set", async () => {
    const server = await servePage({ phase: "intro", title: "Hi", body: "Wait" });
    try {
      expect(await (await fetch(server.url)).text()).toBe(readingPage());
      expect(await (await fetch(`${server.url}state`)).json()).toEqual({ phase: "intro", title: "Hi", body: "Wait" });
      server.set({ phase: "countdown", title: "Ready", remainingMs: 3000, lines: ["a"] });
      await new Promise(resolve => setTimeout(resolve, 120));
      const state = await (await fetch(`${server.url}state`)).json() as { remainingMs: number };
      expect(state.remainingMs).toBeLessThan(2900);
      expect(state.remainingMs).toBeGreaterThan(2000);
      expect((await fetch(`${server.url}elsewhere`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
