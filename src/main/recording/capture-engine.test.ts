import { expect, it } from "vitest";
import { captureEngine } from "./capture-engine";

it("records natively on macOS unless the development flag asks for Chromium", () => {
  expect(captureEngine("darwin", {})).toBe("native");
  expect(captureEngine("darwin", { RECORDSTUFF_CAPTURE_ENGINE: "native" })).toBe("native");
  expect(captureEngine("darwin", { RECORDSTUFF_CAPTURE_ENGINE: "chromium" })).toBe("chromium");
});

it("keeps Chromium on Windows until its builds carry the module, with native as an opt-in", () => {
  expect(captureEngine("win32", {})).toBe("chromium");
  expect(captureEngine("win32", { RECORDSTUFF_CAPTURE_ENGINE: "native" })).toBe("native");
  expect(captureEngine("linux", { RECORDSTUFF_CAPTURE_ENGINE: "native" })).toBe("chromium");
});
