/** Bounded subprocesses and recording cleanup for notification acceptance. */
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { currentState } from "./acceptance.mts";

export function command(
  file: string,
  args: string[],
  signal: AbortSignal,
  timeout = 10_000,
  allowedCodes = [0],
): Promise<string> {
  signal.throwIfAborted();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    let outcome: (() => void) | undefined;
    const child = execFile(file, args, { encoding: "utf8", env, timeout, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      outcome = () => {
        if (error && !(typeof error.code === "number" && allowedCodes.includes(error.code))) {
          reject(new Error(`${file}: ${stderr.trim() || error.message}`, { cause: error }));
        } else resolve(stdout.trimEnd());
      };
    });
    const abort = (): void => { child.kill("SIGKILL"); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    // Wait for exit before restoring files, even when cancellation kills a copy command.
    child.once("close", () => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (outcome) outcome();
      else reject(new Error(`${file}: no exit result`));
    });
  });
}

/** Only inspect the current recording's log slice; never toggle a stopped session. */
export async function finishRecording(options: {
  read: () => string[];
  from: number;
  stop: () => Promise<unknown>;
  stopSent: boolean;
  signal: AbortSignal;
}): Promise<string | undefined> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
  let stopSent = options.stopSent;
  while (true) {
    signal.throwIfAborted();
    const lines = options.read().slice(options.from);
    const state = currentState(lines);
    const saved = lines.map((line) => /\] saved (.+)$/.exec(line)?.[1]).find(Boolean);
    if (state === "idle" && saved) return saved;
    if (state === "idle" && lines.some((line) => /\] failed:/.test(line))) return undefined;
    if (state === "recording" && !stopSent) {
      stopSent = true;
      await options.stop();
    }
    await delay(100, undefined, { signal });
  }
}
