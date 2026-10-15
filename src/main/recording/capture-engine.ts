/**
 * Which engine records (plan 076, step 5). On macOS the native engine does, unless D7's development flag
 * `RECORDSTUFF_CAPTURE_ENGINE=chromium` asks for the hidden capture renderer, kept for side-by-side comparison until the
 * native engine passes acceptance. On Windows the hidden renderer still does, and `=native` opts in, until the
 * Windows builds carry the module (step 6). Elsewhere only the hidden renderer exists.
 */
export type CaptureEngine = "native" | "chromium";

export function captureEngine(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): CaptureEngine {
  const flag = env["RECORDSTUFF_CAPTURE_ENGINE"];
  if (platform === "darwin") return flag === "chromium" ? "chromium" : "native";
  if (platform === "win32") return flag === "native" ? "native" : "chromium";
  return "chromium";
}
