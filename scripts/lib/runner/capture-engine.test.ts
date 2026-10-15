import { expect, it } from "vitest";
import { CAPTURE_KEYS, baselineKey, engineEnv, engineFromLog, engineMismatch, takeEngineOption } from "./capture-engine.mts";
import { scrubbedEnv } from "./runner-env.mts";

it("takes --engine out of a runner's arguments, native by default", () => {
  expect(takeEngineOption(["--fps", "60"])).toEqual({ engine: "native", rest: ["--fps", "60"] });
  expect(takeEngineOption(["--engine", "chromium", "--out", "x"])).toEqual({ engine: "chromium", rest: ["--out", "x"] });
  expect(takeEngineOption(["--engine"])).toBeUndefined();
  expect(takeEngineOption(["--engine", "webrtc"])).toBeUndefined();
});

it("asks a child for Chromium only, and never passes on the shell's capture switches", () => {
  expect(engineEnv("native")).toEqual({});
  expect(engineEnv("chromium")).toEqual({ RECORDSTUFF_CAPTURE_ENGINE: "chromium" });
  const env = scrubbedEnv({ PATH: "/bin", RECORDSTUFF_CAPTURE_ENGINE: "chromium", RECORDSTUFF_CAPTURE_SOURCE: "area:0,0,10,10", RECORDSTUFF_CAPTURE_AUDIO: "off" });
  expect(env).toEqual({ PATH: "/bin" });
  for (const key of CAPTURE_KEYS) expect(env).not.toHaveProperty(key);
});

it("reads the engine the app's last launch logged", () => {
  expect(engineFromLog(["[t] start: RecordStuff", "[t] capture engine: native"])).toBe("native");
  expect(engineFromLog(["[t] capture engine: native", "[t] capture engine: chromium (RECORDSTUFF_CAPTURE_ENGINE=chromium)"])).toBe("chromium");
  expect(engineFromLog(["[t] start: RecordStuff"])).toBeUndefined();
});

it("refuses a run whose app recorded through another engine, or did not say which", () => {
  expect(engineMismatch(["[t] capture engine: native"], "native")).toBeUndefined();
  expect(engineMismatch(["[t] capture engine: chromium (RECORDSTUFF_CAPTURE_ENGINE=chromium)"], "native")).toBe("the app recorded through chromium, not the native engine this round asked for");
  expect(engineMismatch(["[t] start: RecordStuff"], "chromium")).toBe("the app recorded through an engine it did not log, not the chromium engine this round asked for");
});

it("keeps the hidden renderer's baselines under their old keys and prefixes the native engine's", () => {
  expect(baselineKey("measure:cpu recording 30", "chromium")).toBe("measure:cpu recording 30");
  expect(baselineKey("measure:cpu recording 30", "native")).toBe("native measure:cpu recording 30");
});
