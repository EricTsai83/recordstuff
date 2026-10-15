import fs from "node:fs";
import { expect, it } from "vitest";
import { engineSources } from "./audio-quality-tools.mts";

it("fingerprints the engine that records: the hidden renderer's host, or the native engine's sources (plan 076)", () => {
  expect(engineSources("chromium")).toEqual(["../src/renderer/capture/capture-host.ts"]);
  const native = engineSources("native");
  expect(native).toContain("../src/main/recording/native-host-process.ts");
  expect(native).toContain("../native/capture/Cargo.lock");
  expect(native).toContain("../native/capture/src/core/mixer.rs");
  expect(native).toContain("../native/capture/src/mac/audio.rs");
  for (const file of native) expect(fs.existsSync(new URL(file, new URL("../../", import.meta.url))), file).toBe(true);
});
