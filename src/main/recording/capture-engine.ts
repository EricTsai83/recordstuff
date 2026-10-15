/**
 * Which engine records (plan 076, steps 5 and 6). On macOS and Windows the native engine does, unless D7's development
 * flag `RECORDSTUFF_CAPTURE_ENGINE=chromium` asks for the hidden capture renderer, kept for side-by-side comparison
 * until the native engine passes acceptance. Elsewhere only the hidden renderer exists.
 */
export type CaptureEngine = "native" | "chromium";

export function captureEngine(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): CaptureEngine {
  if (platform !== "darwin" && platform !== "win32") return "chromium";
  return env["RECORDSTUFF_CAPTURE_ENGINE"] === "chromium" ? "chromium" : "native";
}
