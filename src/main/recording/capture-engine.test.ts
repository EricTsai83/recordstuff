import { expect, it } from "vitest";
import { captureEngine } from "./capture-engine";

it.each(["darwin", "win32"] as const)("records natively on %s unless the development flag asks for Chromium", (platform) => {
  expect(captureEngine(platform, {})).toBe("native");
  expect(captureEngine(platform, { RECORDSTUFF_CAPTURE_ENGINE: "native" })).toBe("native");
  expect(captureEngine(platform, { RECORDSTUFF_CAPTURE_ENGINE: "chromium" })).toBe("chromium");
});

it("has only the hidden renderer elsewhere", () => {
  expect(captureEngine("linux", { RECORDSTUFF_CAPTURE_ENGINE: "native" })).toBe("chromium");
});
