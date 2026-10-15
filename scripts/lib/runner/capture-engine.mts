/**
 * Which capture engine a runner records through (plan 076, step 7). The app records natively by default
 * (src/main/recording/capture-engine.ts); `RECORDSTUFF_CAPTURE_ENGINE=chromium` brings back the hidden capture renderer
 * until it is removed. A runner chooses one with `--engine native|chromium` (native by default), never inherits it
 * or the development capture switches from its shell, and reports the engine the app said it used.
 */
import { spawnSync } from "node:child_process";

export type CaptureEngine = "native" | "chromium";

/**
 * The app's capture switches (native-host-process.ts `developmentCapture` and capture-engine.ts): inherited, they would
 * silently change the engine, the recorded source or its sound.
 */
export const CAPTURE_KEYS = ["RECORDSTUFF_CAPTURE_ENGINE", "RECORDSTUFF_CAPTURE_SOURCE", "RECORDSTUFF_CAPTURE_AUDIO"] as const;

export const ENGINE_USAGE = "[--engine native|chromium]";

/**
 * Takes `--engine <name>` out of `args`, returning the engine and the arguments left; undefined when the value is
 * missing or unknown.
 */
export function takeEngineOption(args: readonly string[]): { engine: CaptureEngine; rest: string[] } | undefined {
  const rest: string[] = [];
  let engine: CaptureEngine = "native";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--engine") { rest.push(args[i]!); continue; }
    const value = args[++i];
    if (value !== "native" && value !== "chromium") return undefined;
    engine = value;
  }
  return { engine, rest };
}

/** The variables a child Electron needs to record through `engine`, to add to an environment without CAPTURE_KEYS. */
export function engineEnv(engine: CaptureEngine): Record<string, string> {
  return engine === "chromium" ? { RECORDSTUFF_CAPTURE_ENGINE: "chromium" } : {};
}

/** The engine the app's launch logged (index.ts `capture engine: …`), the last in `lines`. */
export function engineFromLog(lines: readonly string[]): CaptureEngine | undefined {
  let found: CaptureEngine | undefined;
  for (const line of lines) {
    const match = /\] capture engine: (native|chromium)\b/.exec(line);
    if (match) found = match[1] as CaptureEngine;
  }
  return found;
}

/** Why a run's log shows it did not record through `engine`, or undefined when it did: a run that did is the only kind measured. */
export function engineMismatch(lines: readonly string[], engine: CaptureEngine): string | undefined {
  const logged = engineFromLog(lines);
  return logged === engine ? undefined : `the app recorded through ${logged ?? "an engine it did not log"}, not the ${engine} engine this round asked for`;
}

/**
 * A CPU baseline's key for `engine` (cpu-baselines.json): the keys recorded before plan 076 are the hidden renderer's
 * and stay as they were; the native engine's carry a `native ` prefix.
 */
export function baselineKey(key: string, engine: CaptureEngine): string {
  return engine === "chromium" ? key : `native ${key}`;
}

/** The capture switches launchd would hand an app `open` starts (`launchctl setenv`), by name. */
export function launchdCaptureVariables(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const key of CAPTURE_KEYS) {
    const value = spawnSync("launchctl", ["getenv", key], { encoding: "utf8" }).stdout?.trim();
    if (value) found[key] = value;
  }
  return found;
}

/**
 * For a bundle `open` starts: sets launchd's engine variable for `engine` and returns what undoes it. Refuses, with the
 * reason, while launchd already holds a capture switch, which belongs to someone else's session.
 */
export function useLaunchdEngine(engine: CaptureEngine): { restore: () => void } | string {
  const held = Object.entries(launchdCaptureVariables());
  if (held.length) return `launchd holds ${held.map(([key, value]) => `${key}=${value}`).join(", ")}; unset it (\`launchctl unsetenv <name>\`) before this round`;
  const set = engineEnv(engine)["RECORDSTUFF_CAPTURE_ENGINE"];
  if (!set) return { restore: () => {} };
  spawnSync("launchctl", ["setenv", "RECORDSTUFF_CAPTURE_ENGINE", set]);
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    spawnSync("launchctl", ["unsetenv", "RECORDSTUFF_CAPTURE_ENGINE"]);
  };
  // However the runner ends from here on (a throw before its own cleanup, an exit), launchd gets its value back.
  process.once("exit", restore);
  return { restore };
}
