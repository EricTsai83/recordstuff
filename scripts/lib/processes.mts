/**
 * Finding the processes a runner owns and building safe `pgrep` patterns.
 * Every runner that must not rebuild, replace or quit a foreign copy goes
 * through here rather than spelling a pattern out: each path is escaped, so a
 * checkout under `~/Code (2026)/` matches itself, and a `pgrep` that fails
 * throws instead of reading as "nothing is running".
 */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";

/** Escapes a literal for use inside a RegExp or an extended `pgrep -f` pattern. */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Any absolute path ending in `/RecordStuff.app` at the start of the command
 * line. A folder name may hold spaces, but a space followed by `/` starts the
 * next argument, so a path given to another program never matches.
 */
const ANY_BUNDLE = "/([^ ]| [^/])*/RecordStuff\\.app";

/**
 * The `pgrep -f` pattern for a RecordStuff bundle's main process: the
 * executable path, with or without arguments, and never a helper process or
 * a program that only names it (`/bin/cat …/MacOS/RecordStuff`).
 * With `bundleDir` only that bundle matches; without it, any RecordStuff.app.
 */
export function recordStuffPattern(bundleDir?: string): string {
  return `^${bundleDir ? escapeRegExp(bundleDir.replace(/\/$/, "")) : ANY_BUNDLE}/Contents/MacOS/RecordStuff($| )`;
}

/**
 * The `pgrep -f` pattern for a checkout's `Electron.app` (pass the resolved
 * path: pnpm's symlink is resolved on process command lines). `bundle`
 * matches every process inside the bundle, the main process and its helpers;
 * `main` only the main executable, the root of the app's process tree.
 */
export function electronPattern(appPath: string, part: "bundle" | "main"): string {
  const bundle = `^${escapeRegExp(appPath.replace(/\/$/, ""))}/Contents/`;
  return part === "bundle" ? bundle : `${bundle}MacOS/Electron($| )`;
}

type Pgrep = (args: string[]) => SpawnSyncReturns<string>;
const runPgrep: Pgrep = (args) => spawnSync("pgrep", args, { encoding: "utf8" });

/** `pgrep`'s output lines; throws on a spawn error or any status but 0 and 1 (1 means none). */
function pgrepLines(args: string[], run: Pgrep): string[] {
  const result = run(args);
  if (result.error) throw new Error(`pgrep could not run: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0 && result.status !== 1) throw new Error(`pgrep failed (${result.status ?? result.signal}): ${result.stderr.trim()}`);
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Pids whose command line matches `pattern`; throws when `pgrep` itself fails. */
export function pgrepPids(pattern: string, run: Pgrep = runPgrep): number[] {
  return pgrepLines(["-f", pattern], run).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** `pid command` lines for the same match, for messages that name what still runs. */
export function pgrepProcesses(pattern: string, run: Pgrep = runPgrep): string[] {
  return pgrepLines(["-fl", pattern], run);
}

/** Pids of RecordStuff main processes; throws when `pgrep` itself fails. */
export function recordStuffPids(bundleDir?: string): number[] {
  return pgrepPids(recordStuffPattern(bundleDir));
}

/** Sends `name` to each pid, ignoring one that has already gone. */
export function signalPids(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try { process.kill(pid, name); } catch { /* already gone */ }
  }
}

/** Whether any process of the group led by `pid` still runs; signal 0 only tests. */
export function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts a build in its own process group, so a Ctrl-C reaches only the
 * runner, whose handler stops the whole group (`stopGroup`), not pnpm alone.
 * `done` resolves with the exit code, 1 when the build could not start or was
 * ended by a signal.
 */
export function startBuild(cwd: string, command: readonly string[] = ["pnpm", "exec", "electron-vite", "build"]): { child: ChildProcess; done: Promise<number> } {
  const [program, ...args] = command;
  if (!program) throw new Error("startBuild needs a command");
  const child = spawn(program, args, { cwd, stdio: "inherit", detached: true });
  const done = new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
  return { child, done };
}

/** Stops a whole process group, so no electron-vite or esbuild child keeps writing `out/`; SIGKILL after 5 s. */
export async function stopGroup(pid: number | undefined): Promise<void> {
  if (pid === undefined || !groupAlive(pid)) return;
  const signalGroup = (name: NodeJS.Signals): void => { try { process.kill(-pid, name); } catch { /* already gone */ } };
  signalGroup("SIGTERM");
  for (let i = 0; i < 20 && groupAlive(pid); i += 1) await sleep(250);
  if (groupAlive(pid)) signalGroup("SIGKILL");
  for (let i = 0; i < 8 && groupAlive(pid); i += 1) await sleep(250);
}

/** The exit codes a runner reports after SIGINT or SIGTERM once its cleanup left nothing running. */
export const INTERRUPT_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Runs an interrupted round's cleanup and returns its exit code: 130/143 when
 * nothing it owned is left, 1 when something is, or when cleanup itself threw
 * (a `pgrep` that failed cannot prove the round's processes exited).
 */
export async function interruptExitCode(name: keyof typeof INTERRUPT_EXIT, cleanup: () => Promise<string[]>, report: (line: string) => void = console.error): Promise<number> {
  let left: string[];
  try {
    left = await cleanup();
  } catch (cause) {
    report(`CLEANUP FAILED: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  if (left.length > 0) report(`CLEANUP INCOMPLETE: ${left.join("; ")} still running`);
  else report("cleanup: every owned process exited");
  return left.length > 0 ? 1 : INTERRUPT_EXIT[name];
}
