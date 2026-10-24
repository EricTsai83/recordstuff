import { expect, it } from "vitest";
import { CAPTURE_KEYS } from "./capture-engine.mts";
import { scrubbedEnv } from "./runner-env.mts";

it("never passes the shell's capture switches on to the app", () => {
  const env = scrubbedEnv({ PATH: "/bin", RECORDSTUFF_CAPTURE_ENGINE: "chromium", RECORDSTUFF_CAPTURE_SOURCE: "area:0,0,10,10", RECORDSTUFF_CAPTURE_AUDIO: "off", RECORDSTUFF_CAPTURE_INTERVAL: "frame", RECORDSTUFF_CAPTURE_EDITABLE: "1" });
  expect(env).toEqual({ PATH: "/bin" });
  for (const key of CAPTURE_KEYS) expect(env).not.toHaveProperty(key);
});
