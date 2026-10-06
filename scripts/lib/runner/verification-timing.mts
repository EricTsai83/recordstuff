/**
 * Phase timing for verification recipes (plan 061): runs each leaf command of a composite
 * check in its own process group, records monotonic durations, outcomes, cleanup and the
 * identities that bound reuse, and renders the cost breakdown. Nested durations that a
 * child reports (start-app's build/package/verify) are shown inside their phase and never
 * added to the totals a second time.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runIsolatedProcess } from "./isolated-process.mts";
import { appArchiveDigest, runtimeInputDigest, runtimeInputFiles } from "./runtime-inputs.mjs";

export type PhaseOutcome = "pass" | "fail" | "blocked" | "interrupted" | "not run";
export type RecipeOutcome = Exclude<PhaseOutcome, "not run"> | "invalid";

export interface PhaseSpec {
  name: string;
  executable: string;
  args: string[];
  /** Desktop runners exit 2 for blocked; for type checkers and pnpm 2 is an ordinary failure. */
  blockedExit?: boolean;
  /** The bound in milliseconds after which the phase is stopped and fails. */
  timeoutMs?: number;
}

export interface Recipe {
  name: string;
  /** The change it verifies and the composite command(s) it replaces. */
  purpose: string;
  replaces: string;
  phases: PhaseSpec[];
  /** The recipe opens the development bundle (start:app), so it quits the app on any exit its last runner did not. */
  ownsApp?: boolean;
}

export interface NestedTiming { runner: string; phase: string; ms: number; ok: boolean }

export interface PhaseRecord {
  name: string;
  command: string;
  outcome: PhaseOutcome;
  /** Offset from the recipe start and duration, both from the monotonic clock. */
  startMs?: number;
  durationMs?: number;
  exit?: number | null;
  detail?: string;
  cleanup?: { groupGone: boolean; forced: boolean; error: string | undefined };
  nested: NestedTiming[];
}

const NODE_FLAGS = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"];
const HOUR = 3_600_000;
const pnpm = (name: string, script: string): PhaseSpec => ({ name, executable: "pnpm", args: [script], timeoutMs: HOUR });
const runner = (name: string, script: string, blockedExit = true): PhaseSpec =>
  ({ name, executable: process.execPath, args: [...NODE_FLAGS, `scripts/${script}`], blockedExit, timeoutMs: HOUR });

/** `pnpm check`, phase by phase, as `package.json` chains it. */
const CHECK = [pnpm("typecheck", "typecheck"), pnpm("test", "test"), pnpm("build", "build")];

/**
 * The background Playwright suite (plan 066): no desktop. Its global setup exits 2 when `out/` or the test clips are
 * missing, which is blocked; a failed case exits 1.
 */
const UI: PhaseSpec = { ...pnpm("background UI and integration", "test:ui"), blockedExit: true };

/** Recipes: each runs the same leaf checks as the composites it replaces, with one build of identical inputs. */
export const RECIPES: readonly Recipe[] = [
  {
    name: "check", purpose: "Logic-only app change: the baseline phase breakdown", replaces: "pnpm check",
    phases: CHECK,
  },
  {
    name: "settings", purpose: "Settings layout, controls, persistence, window lifecycle or settings IPC/preload, in the background (no desktop)",
    replaces: "pnpm acceptance:regression",
    phases: [...CHECK, UI],
  },
  {
    name: "shortcut-registration", purpose: "Global shortcut registration or an Electron upgrade",
    replaces: "pnpm acceptance:regression && pnpm acceptance:shortcut-native && pnpm acceptance:shortcut-layout (each builds again)",
    phases: [...CHECK, UI, runner("shortcut native", "acceptance-shortcut-native.mts"), runner("keyboard layout", "acceptance-shortcut-layout.mts")],
  },
  {
    name: "native-ui", purpose: "The native Settings, shortcut and player cases a background run cannot answer: frame, activation, real registration, window state and full screen (a desktop round)",
    replaces: "pnpm build && pnpm acceptance:settings-native && pnpm acceptance:shortcut-native && pnpm acceptance:player (shortcut-native builds again)",
    phases: [CHECK[2]!, runner("settings native", "acceptance-settings-native.mts"), runner("shortcut native", "acceptance-shortcut-native.mts"), runner("player full screen", "acceptance-player.mts")],
  },
  {
    name: "recording", ownsApp: true, purpose: "Recording start/stop, capture, encoding or file writing: the smoke round",
    replaces: "pnpm check && pnpm start:app && pnpm acceptance (start:app builds the same inputs again)",
    // start:app's `electron-vite build` is check's `pnpm build`; it runs once, inside start:app.
    phases: [CHECK[0]!, CHECK[1]!, runner("build, package, sign and open", "start-app.mjs", false), runner("hotkey recording", "acceptance-hotkey.mts")],
  },
];

export function findRecipe(name: string): Recipe | undefined {
  return RECIPES.find(recipe => recipe.name === name);
}

export const displayCommand = (phase: PhaseSpec): string =>
  [phase.executable === process.execPath ? "node" : phase.executable, ...phase.args.filter(arg => !NODE_FLAGS.includes(arg))].join(" ");

/** The outcome of one finished phase; an unconfirmed cleanup is never a pass. */
export function classifyPhase(spec: PhaseSpec, execution: {
  code: number | null; stopped: string | undefined; forced: boolean; groupGone: boolean; error: string | undefined;
}): { outcome: PhaseOutcome; detail?: string } {
  // Incomplete cleanup fails the phase even when an interrupt stopped it.
  const interrupted = execution.stopped === "interrupted" ? "interrupted; " : "";
  if (execution.error) return { outcome: "fail", detail: `${interrupted}${execution.error}` };
  if (!execution.groupGone) return { outcome: "fail", detail: `${interrupted}its process group was still running after cleanup` };
  if (execution.forced) return { outcome: "fail", detail: `${interrupted}exit ${execution.code ?? "by signal"}, but its process group needed SIGKILL to clean up` };
  // A desktop runner stopped cleanly exits 130 or 143; its 1 says its own cleanup was incomplete (round-exit.mts).
  if (interrupted && spec.blockedExit && execution.code === 1) return { outcome: "fail", detail: "interrupted; exit 1: its own cleanup was incomplete" };
  if (interrupted) return { outcome: "interrupted", detail: "stopped by an interrupt" };
  if (execution.stopped === "timeout") return { outcome: "fail", detail: `stopped after ${spec.timeoutMs ?? HOUR} ms` };
  if (execution.code === 0) return { outcome: "pass" };
  if (execution.code === 2 && spec.blockedExit) return { outcome: "blocked", detail: "exit 2 (blocked)" };
  return { outcome: "fail", detail: `exit ${execution.code ?? "by signal"}` };
}

/** JSON lines a child appended to its timing file; malformed lines are skipped, not trusted. */
export function readNestedTimings(file: string): NestedTiming[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").flatMap(line => {
    try {
      const value = JSON.parse(line) as Partial<NestedTiming>;
      return typeof value.runner === "string" && typeof value.phase === "string" && typeof value.ms === "number" && typeof value.ok === "boolean"
        ? [{ runner: value.runner, phase: value.phase, ms: value.ms, ok: value.ok }] : [];
    } catch { return []; }
  });
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Holds each phase's timing file. */
  scratchDir: string;
  signal?: AbortSignal;
  /** Graceful stop before the group is killed; runners that quit the app need their own cleanup time. */
  graceMs?: number;
  /** Where children write; the console by default. */
  logFd?: number;
  now?: () => number;
}

/** Runs phases in order and stops at the first that does not pass, as `&&` does; later phases are "not run". */
export async function runPhases(phases: readonly PhaseSpec[], options: RunOptions): Promise<PhaseRecord[]> {
  const now = options.now ?? (() => performance.now());
  const origin = now();
  const records: PhaseRecord[] = [];
  let stopped = false;
  for (const [index, spec] of phases.entries()) {
    const command = displayCommand(spec);
    if (stopped || options.signal?.aborted) {
      records.push({ name: spec.name, command, outcome: "not run", nested: [] });
      stopped = true;
      continue;
    }
    const timingFile = path.join(options.scratchDir, `phase-${index + 1}.jsonl`);
    const start = now();
    const execution = await runIsolatedProcess({
      executable: spec.executable, args: spec.args, cwd: options.cwd,
      env: { ...options.env, RECORDSTUFF_TIMING_FILE: timingFile },
      logFd: options.logFd ?? 1, timeoutMs: spec.timeoutMs ?? HOUR, graceMs: options.graceMs ?? 60_000,
      ...(options.signal ? { signal: options.signal } : {}),
    }).catch((cause: unknown) => ({
      code: null, stopped: options.signal?.aborted ? "interrupted" : undefined, forced: false, groupGone: true, error: String(cause),
    }));
    const end = now();
    const verdict = classifyPhase(spec, execution);
    records.push({
      name: spec.name, command, outcome: verdict.outcome, startMs: start - origin, durationMs: end - start,
      exit: execution.code, ...(verdict.detail ? { detail: verdict.detail } : {}),
      cleanup: { groupGone: execution.groupGone, forced: execution.forced, error: execution.error },
      nested: readNestedTimings(timingFile),
    });
    if (verdict.outcome !== "pass") stopped = true;
  }
  return records;
}

export interface Summary {
  wallMs: number;
  /** Sum of top-level phase durations; nested child phases are inside these. */
  phasesMs: number;
  /** Wall time outside any phase: identity hashing before and after, and the owned app's cleanup; report writing is not included. */
  outsidePhasesMs: number;
}

export function summarize(records: readonly PhaseRecord[], wallMs: number): Summary {
  const phasesMs = records.reduce((sum, record) => sum + (record.durationMs ?? 0), 0);
  return { wallMs, phasesMs, outsidePhasesMs: Math.max(0, wallMs - phasesMs) };
}

export interface AppCleanup { outcome: "not needed" | "quit" | "failed"; detail: string }

/**
 * Quits the app a recipe opened when a phase ended early, before the runner that owns its
 * shutdown could: a normal quit, which saves a recording in progress, then a bounded wait for
 * every process to exit. Nothing is killed; a process left running is a cleanup failure.
 */
export async function quitOwnedApp(options: {
  /** Every process of the bundle, helpers included; `main` only its main executable. */
  pids: () => number[]; main: () => number[]; quit: () => Promise<void>; timeoutMs?: number; pollMs?: number;
}): Promise<AppCleanup> {
  const read = (list: () => number[]): number[] | string => { try { return list(); } catch (error) { return String(error); } };
  const running = (): number[] | string => read(options.pids);
  const before = running();
  if (typeof before === "string") return { outcome: "failed", detail: `could not check for the app: ${before}` };
  if (!before.length) return { outcome: "not needed", detail: "no process of the development bundle was running" };
  // Only a running app is asked to quit; helpers left by one that already exited are only waited for.
  const main = read(options.main);
  if (typeof main === "string") return { outcome: "failed", detail: `could not check for the app: ${main}` };
  if (main.length) {
    try { await options.quit(); } catch (error) { return { outcome: "failed", detail: `quit request failed: ${String(error)}; pids ${before.join(", ")}` }; }
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  for (;;) {
    const left = running();
    if (typeof left === "string") return { outcome: "failed", detail: `could not confirm exit: ${left}` };
    if (!left.length) return { outcome: "quit", detail: `quit pids ${before.join(", ")} normally` };
    if (Date.now() >= deadline) return { outcome: "failed", detail: `pids ${left.join(", ")} still running after the quit request; quit RecordStuff from its menu` };
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 250));
  }
}

/** The first phase that did not pass decides; changed inputs make an otherwise passing run invalid. */
export function recipeOutcome(records: readonly PhaseRecord[], inputsChanged: boolean): RecipeOutcome {
  const decisive = records.find(record => record.outcome !== "pass");
  if (decisive && decisive.outcome !== "not run") return decisive.outcome;
  if (decisive) return "fail";
  return inputsChanged ? "invalid" : "pass";
}

export function exitCode(outcome: RecipeOutcome, signal?: NodeJS.Signals): number {
  if (outcome === "interrupted") return signal === "SIGTERM" ? 143 : 130;
  return outcome === "pass" ? 0 : outcome === "blocked" ? 2 : 1;
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** `latin1` keeps a binary diff byte for byte; paths are `utf8`, as git prints them. */
function git(cwd: string, args: string[], encoding: "latin1" | "utf8" = "latin1"): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.toString(encoding) : undefined;
}

/**
 * The checked-out revision plus a digest of every uncommitted change, including untracked
 * files, so two runs on the same HEAD with different edits do not look identical.
 */
export function workingTreeIdentity(cwd: string): { head: string; dirty: boolean; content: string } | undefined {
  const head = git(cwd, ["rev-parse", "HEAD"])?.trim();
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "utf8");
  const diff = git(cwd, ["diff", "HEAD", "--binary"]);
  if (!head || status === undefined || diff === undefined) return undefined;
  const untracked = status.split("\0").filter(entry => entry.startsWith("?? ")).map(entry => entry.slice(3)).sort();
  const hash = createHash("sha256").update(diff);
  for (const file of untracked) {
    const absolute = path.join(cwd, file);
    hash.update(`\0${file}\0`);
    try { hash.update(fs.lstatSync(absolute).isSymbolicLink() ? `link:${fs.readlinkSync(absolute)}` : fs.readFileSync(absolute)); }
    catch { hash.update("unreadable"); }
  }
  return { head, dirty: status.length > 0, content: hash.digest("hex") };
}

/** A digest of a generated tree such as `out/`, or null when it does not exist. */
export function treeDigest(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const hash = createHash("sha256");
  const walk = (relative: string): void => {
    for (const name of fs.readdirSync(path.join(dir, relative)).sort()) {
      const child = path.posix.join(relative, name);
      const stat = fs.lstatSync(path.join(dir, child));
      if (stat.isDirectory()) walk(child);
      else hash.update(`${child}\0${stat.isSymbolicLink() ? `link:${fs.readlinkSync(path.join(dir, child))}` : sha256(fs.readFileSync(path.join(dir, child)))}\n`);
    }
  };
  walk("");
  return hash.digest("hex");
}

export interface Identity {
  workingTree: ReturnType<typeof workingTreeIdentity> | null;
  runtimeInputs: string;
  out: string | null;
  app: string | null;
}

export const developmentAppPath = (root: string): string =>
  path.join(root, "dist", process.arch === "arm64" ? "mac-arm64" : "mac", "RecordStuff.app");

export function identity(root: string): Identity {
  return {
    workingTree: workingTreeIdentity(root) ?? null,
    runtimeInputs: runtimeInputDigest(runtimeInputFiles(root)),
    out: treeDigest(path.join(root, "out")),
    app: appArchiveDigest(developmentAppPath(root)),
  };
}

/** Sources, tests and configuration the run judged; generated `out/` and the bundle are expected to change. */
export function inputsChanged(before: Identity, after: Identity): boolean {
  return before.runtimeInputs !== after.runtimeInputs || before.workingTree?.head !== after.workingTree?.head
    || before.workingTree?.content !== after.workingTree?.content;
}

export interface RecipeReport {
  recipe: string;
  purpose: string;
  replaces: string;
  startedAt: string;
  outcome: RecipeOutcome;
  interruptedBy?: string;
  appCleanup?: AppCleanup;
  summary: Summary;
  phases: PhaseRecord[];
  before: Identity;
  after: Identity;
  versions: Record<string, string>;
}

const seconds = (ms: number | undefined): string => ms === undefined ? "—" : `${(ms / 1000).toFixed(2)} s`;

export function renderMarkdown(report: RecipeReport): string {
  const tree = report.before.workingTree;
  return [
    `# Verification recipe \`${report.recipe}\` — ${report.startedAt}`,
    "",
    `Result: **${report.outcome}**${report.interruptedBy ? ` (${report.interruptedBy})` : ""}.`,
    report.outcome === "invalid" ? "Sources, tests or configuration changed during the run, so its evidence belongs to no single revision." : "",
    report.appCleanup ? `App cleanup: ${report.appCleanup.outcome} — ${report.appCleanup.detail}.` : "",
    `Purpose: ${report.purpose}. Replaces: \`${report.replaces}\`.`,
    "",
    `Wall time ${seconds(report.summary.wallMs)}; phases ${seconds(report.summary.phasesMs)}; outside phases ${seconds(report.summary.outsidePhasesMs)} (identity hashing and app cleanup; writing this report is not included).`,
    "Not measured here: agent orchestration gaps and desktop-readiness waits happen outside this process and stay unknown, not zero.",
    "",
    "| Phase | Command | Start | Duration | Outcome | Detail |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.phases.map(phase => `| ${phase.name} | \`${phase.command}\` | ${seconds(phase.startMs)} | ${seconds(phase.durationMs)} | ${phase.outcome} | ${phase.detail ?? ""}${phase.cleanup?.forced ? " (forced cleanup)" : ""} |`),
    "",
    ...report.phases.filter(phase => phase.nested.length).flatMap(phase => [
      `Inside **${phase.name}** (already counted in its duration): ${phase.nested.map(nested => `${nested.phase} ${seconds(nested.ms)}${nested.ok ? "" : " (failed)"}`).join(", ")}.`,
    ]),
    "",
    `Revision: ${tree ? `${tree.head}${tree.dirty ? ` with uncommitted changes (content ${tree.content.slice(0, 12)})` : ""}` : "unknown (not a Git checkout)"}.`,
    `Runtime inputs ${report.before.runtimeInputs.slice(0, 12)}${report.after.runtimeInputs === report.before.runtimeInputs ? "" : ` → ${report.after.runtimeInputs.slice(0, 12)}`}.`,
    `Artifacts after the run: out/ ${report.after.out?.slice(0, 12) ?? "missing"}; app.asar ${report.after.app?.slice(0, 12) ?? "missing"}.`,
    `Versions: ${Object.entries(report.versions).map(([name, version]) => `${name} ${version}`).join(", ")}.`,
    "",
    "Each phase's own report, when it writes one, is named in its console output above.",
    "",
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}
