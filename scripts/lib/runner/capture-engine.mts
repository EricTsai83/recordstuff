import { spawnSync } from "node:child_process";

/**
 * The app's development capture switches (native-host-process.ts `developmentCapture`, and plan 075's camera
 * prototype and plan 091's capture interval, which `pnpm measure:cpu -- --camera` and `--capture-interval` set on
 * purpose, and plan 087's editable recording): inherited from a runner's shell, they would silently change the recorded
 * source, its sound, its pacing or its tracks,
 * so `scrubbedEnv` removes them. The native engine
 * is the only one since plan 076 removed the hidden capture renderer; `RECORDSTUFF_CAPTURE_ENGINE` is listed so an old
 * shell's value never reaches the app either.
 */
export const CAPTURE_KEYS = ["RECORDSTUFF_CAPTURE_ENGINE", "RECORDSTUFF_CAPTURE_SOURCE", "RECORDSTUFF_CAPTURE_AUDIO", "RECORDSTUFF_CAMERA_PROTOTYPE", "RECORDSTUFF_CAPTURE_INTERVAL", "RECORDSTUFF_CAPTURE_EDITABLE"] as const;

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
