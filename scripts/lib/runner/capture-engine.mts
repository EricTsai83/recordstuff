import { spawnSync } from "node:child_process";

/**
 * The app's development capture switches (native-host-process.ts `developmentCapture`): inherited from a runner's
 * shell, they would silently change the recorded source or its sound, so `scrubbedEnv` removes them. The native engine
 * is the only one since plan 076 removed the hidden capture renderer; `RECORDSTUFF_CAPTURE_ENGINE` is listed so an old
 * shell's value never reaches the app either.
 */
export const CAPTURE_KEYS = ["RECORDSTUFF_CAPTURE_ENGINE", "RECORDSTUFF_CAPTURE_SOURCE", "RECORDSTUFF_CAPTURE_AUDIO"] as const;

/**
 * The capture switches launchd would hand an app `open` starts (`launchctl setenv`), by name: a runner that launches
 * the bundle refuses to measure while any is set, since `scrubbedEnv` cannot reach that environment.
 */
export function launchdCaptureVariables(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const key of CAPTURE_KEYS) {
    const value = spawnSync("launchctl", ["getenv", key], { encoding: "utf8" }).stdout?.trim();
    if (value) found[key] = value;
  }
  return found;
}
