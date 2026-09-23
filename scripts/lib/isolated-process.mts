import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface IsolatedProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFd: number;
  timeoutMs: number;
  graceMs?: number;
  signal?: AbortSignal;
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

/** macOS/Linux: owns one new process group, never searches for or kills other apps. */
export async function runIsolatedProcess(options: IsolatedProcessOptions): Promise<{
  code: number | null; pid: number | undefined; stopped: string | undefined; forced: boolean; groupGone: boolean; error: string | undefined;
}> {
  if (process.platform === "win32") throw new Error("Isolated process-group cleanup requires macOS/Linux.");
  options.signal?.throwIfAborted();
  const grace = options.graceMs ?? 5000;
  const child = spawn(options.executable, options.args, {
    cwd: options.cwd, env: options.env, detached: true,
    stdio: ["ignore", options.logFd, options.logFd],
  });
  let stopped: string | undefined;
  let forced = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: string): void => {
    if (stopped) return;
    stopped = reason;
    // Give Electron main a chance to dispose windows, shortcuts and timers first.
    child.kill("SIGTERM");
    escalation = setTimeout(() => {
      if (child.pid && groupExists(child.pid)) {
        forced = true;
        signalGroup(child.pid, "SIGKILL");
      }
    }, grace);
  };
  const abort = (): void => stop("interrupted");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
  let code: number | null = null;
  let error: string | undefined;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
  } catch (cause) {
    error = String(cause);
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    options.signal?.removeEventListener("abort", abort);
    // Main can exit before Chromium helpers. Reap the entire group we created.
    if (child.pid && groupExists(child.pid)) {
      signalGroup(child.pid, "SIGTERM");
      const until = Date.now() + grace;
      while (groupExists(child.pid) && Date.now() < until) await delay(25);
      if (groupExists(child.pid)) {
        forced = true;
        signalGroup(child.pid, "SIGKILL");
        const killedUntil = Date.now() + grace;
        while (groupExists(child.pid) && Date.now() < killedUntil) await delay(25);
      }
    }
  }
  return { code, error, pid: child.pid, stopped, forced, groupGone: !child.pid || !groupExists(child.pid) };
}
