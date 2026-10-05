/**
 * The shared CPU sampler of `pnpm measure:cpu` and `pnpm matrix` (plan 049,
 * docs/system-design/tooling.md#cpu-budget). A small C helper
 * ([cpu-sampler.c](cpu-sampler.c)), compiled with clang from the Command Line
 * Tools into the run's folder, reads proc_pid_rusage once a second for the
 * app's process tree and any followed system helper; this module turns its
 * cumulative counters into per-second figures and statistics. Development
 * only, never shipped.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { scrubbedEnv } from "./runner-env.mts";
import { percentile } from "./stats.mts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "cpu-sampler.c");
/** The system's hardware encoder: reported beside the app, never counted as the app. */
export const ENCODER_SERVICE = "VTEncoderXPCService";

/** Missing Command Line Tools block the measurement; they never turn it into a pass. */
export class SamplerBlockedError extends Error {}
/** clang was stopped by a signal (Ctrl-C reaches it as well as the runner): an interrupt, not missing tools. */
export class SamplerInterruptedError extends Error {
  readonly signal: "SIGINT" | "SIGTERM";
  constructor(signal: "SIGINT" | "SIGTERM") { super(`compiling the CPU sampler was interrupted by ${signal}`); this.signal = signal; }
}

/** Compiles the helper into `dir` and returns its path. */
export function compileSampler(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const binary = path.join(dir, "cpu-sampler");
  const env = scrubbedEnv();
  const result = spawnSync("clang", ["-O2", "-Wall", "-Wextra", "-o", binary, SOURCE], { encoding: "utf8", env });
  // The runner's own handler only runs once this synchronous call returns, so the signal is read from clang's end.
  if (result.signal === "SIGINT" || result.signal === "SIGTERM") throw new SamplerInterruptedError(result.signal);
  if (result.error || result.status !== 0) {
    throw new SamplerBlockedError(`could not compile the CPU sampler with clang (install the Command Line Tools: xcode-select --install): ${result.error?.message ?? result.stderr.trim()}`);
  }
  return binary;
}

export interface ProcessCounters {
  pid: number;
  ppid: number;
  name: string;
  /** A named helper outside the app's tree. */
  followed: boolean;
  cpu_ns: number;
  idle_wakeups: number;
  interrupt_wakeups: number;
  energy_nj: number;
  resident_bytes: number;
}
export interface Sample {
  /** Monotonic nanoseconds from the helper. */
  t_ns: number;
  /** Wall-clock milliseconds when the line arrived, to place the sample against log timestamps. */
  at: number;
  procs: ProcessCounters[];
}

export function parseSample(line: string, at: number): Sample | undefined {
  try {
    const value = JSON.parse(line) as Omit<Sample, "at">;
    if (typeof value.t_ns !== "number" || !Array.isArray(value.procs)) return undefined;
    return { ...value, at };
  } catch {
    return undefined;
  }
}

export interface ProcessDelta {
  pid: number;
  name: string;
  followed: boolean;
  /** Percent of one core. */
  cpuPercent: number;
  wakeupsPerSecond: number;
  energyWatts: number;
  residentBytes: number;
}
export interface Interval {
  /** Wall-clock start and end of the interval, from the two samples' arrival. */
  startAt: number;
  at: number;
  seconds: number;
  /** The app's own processes, summed; followed helpers are apart. */
  app: { cpuPercent: number; wakeupsPerSecond: number; energyWatts: number; residentBytes: number };
  followed: { cpuPercent: number; present: boolean };
  processes: ProcessDelta[];
  /** The app's processes differed between the two samples, so the sums are incomplete. */
  setChange?: { added: string[]; removed: string[] };
}

const label = (p: { name: string; pid: number }): string => `${p.name} (${p.pid})`;

/** Per-second figures between consecutive samples. */
export function intervals(samples: readonly Sample[]): Interval[] {
  const result: Interval[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1]!, b = samples[i]!;
    const seconds = (b.t_ns - a.t_ns) / 1e9;
    if (seconds <= 0) continue;
    const before = new Map(a.procs.map((p) => [p.pid, p]));
    const processes: ProcessDelta[] = [];
    for (const p of b.procs) {
      const old = before.get(p.pid);
      if (!old) continue;
      processes.push({
        pid: p.pid, name: p.name, followed: p.followed,
        cpuPercent: Math.max(0, p.cpu_ns - old.cpu_ns) / 1e9 / seconds * 100,
        wakeupsPerSecond: Math.max(0, p.idle_wakeups + p.interrupt_wakeups - old.idle_wakeups - old.interrupt_wakeups) / seconds,
        energyWatts: Math.max(0, p.energy_nj - old.energy_nj) / 1e9 / seconds,
        residentBytes: p.resident_bytes,
      });
    }
    const appBefore = new Set(a.procs.filter((p) => !p.followed).map((p) => p.pid));
    const appAfter = new Set(b.procs.filter((p) => !p.followed).map((p) => p.pid));
    const added = b.procs.filter((p) => !p.followed && !appBefore.has(p.pid)).map(label);
    const removed = a.procs.filter((p) => !p.followed && !appAfter.has(p.pid)).map(label);
    const app = processes.filter((p) => !p.followed);
    const followed = processes.filter((p) => p.followed);
    result.push({
      startAt: a.at, at: b.at, seconds,
      app: {
        cpuPercent: sum(app.map((p) => p.cpuPercent)),
        wakeupsPerSecond: sum(app.map((p) => p.wakeupsPerSecond)),
        energyWatts: sum(app.map((p) => p.energyWatts)),
        residentBytes: sum(b.procs.filter((p) => !p.followed).map((p) => p.resident_bytes)),
      },
      followed: { cpuPercent: sum(followed.map((p) => p.cpuPercent)), present: b.procs.some((p) => p.followed) },
      processes,
      ...(added.length || removed.length ? { setChange: { added, removed } } : {}),
    });
  }
  return result;
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export interface Stat { average: number; p95: number; max: number }
function stat(values: readonly number[]): Stat {
  return { average: values.length ? sum(values) / values.length : 0, p95: percentile(values, 0.95) ?? 0, max: values.length ? Math.max(...values) : 0 };
}

export interface Summary {
  /** Seconds judged, after discarding. */
  seconds: number;
  judged: number;
  /** Intervals in which the app's process set changed, reported and left out. */
  discarded: Array<{ at: number; added: string[]; removed: string[] }>;
  cpuPercent: Stat;
  wakeupsPerSecond: Stat;
  energyWatts: Stat;
  /** The followed helpers, such as the hardware encoder. */
  followed: { cpuPercent: Stat; present: boolean };
  maxResidentBytes: number;
  /** Per process, heaviest first. */
  processes: Array<{ name: string; pid: number; followed: boolean; cpuPercent: Stat; wakeupsPerSecond: number; maxResidentBytes: number }>;
  /** The app's own process names seen in the window, sorted; followed helpers are in `followed` and `processes` only. */
  processNames: string[];
}

/**
 * Statistics over the intervals lying wholly in [fromMs, toMs], so CPU spent before a window's
 * start (a recording's start-up) is never counted. An interval whose app process set changed is
 * discarded unless `expectChanges` says the window spans an expected start or end, such as a
 * recording's capture host.
 */
export function summarize(all: readonly Interval[], fromMs = -Infinity, toMs = Infinity, expectChanges = false): Summary {
  const window = all.filter((i) => i.startAt >= fromMs && i.at <= toMs);
  const discarded = expectChanges ? [] : window.filter((i) => i.setChange).map((i) => ({ at: i.at, ...i.setChange! }));
  const judged = expectChanges ? window : window.filter((i) => !i.setChange);
  const perProcess = new Map<string, { name: string; pid: number; followed: boolean; cpu: number[]; wakeups: number[]; resident: number }>();
  for (const interval of judged) {
    for (const p of interval.processes) {
      const key = `${p.pid}`;
      const entry = perProcess.get(key) ?? { name: p.name, pid: p.pid, followed: p.followed, cpu: [], wakeups: [], resident: 0 };
      entry.cpu.push(p.cpuPercent); entry.wakeups.push(p.wakeupsPerSecond); entry.resident = Math.max(entry.resident, p.residentBytes);
      perProcess.set(key, entry);
    }
  }
  const processes = [...perProcess.values()]
    .map((p) => ({ name: p.name, pid: p.pid, followed: p.followed, cpuPercent: stat(p.cpu), wakeupsPerSecond: p.wakeups.length ? sum(p.wakeups) / p.wakeups.length : 0, maxResidentBytes: p.resident }))
    .sort((a, b) => b.cpuPercent.average - a.cpuPercent.average);
  return {
    seconds: sum(judged.map((i) => i.seconds)),
    judged: judged.length,
    discarded,
    cpuPercent: stat(judged.map((i) => i.app.cpuPercent)),
    wakeupsPerSecond: stat(judged.map((i) => i.app.wakeupsPerSecond)),
    energyWatts: stat(judged.map((i) => i.app.energyWatts)),
    followed: { cpuPercent: stat(judged.map((i) => i.followed.cpuPercent)), present: judged.some((i) => i.followed.present) },
    maxResidentBytes: judged.length ? Math.max(...judged.map((i) => i.app.residentBytes)) : 0,
    processes,
    processNames: [...new Set(processes.filter((p) => !p.followed).map((p) => p.name))].sort(),
  };
}

/**
 * The budget (plan 049; docs/system-design/tooling.md#cpu-budget), in percent
 * of one core and wake-ups per second. The 2026-09-28 baseline on the reference
 * M1 Pro confirmed every target with margin (idle 0.04%, 2.3 wake-ups per
 * second; Settings open 0.09%; recording medians 15.1% at 30 fps and 22.2% at
 * 60 fps), so the recording targets replaced the former 40% ceiling.
 */
export const CPU_BUDGET = {
  idle: { averagePercent: 0.2, p95Percent: 1, wakeupsPerSecond: 5 },
  settingsOpen: { averagePercent: 0.5 },
  recording: { 30: { averagePercent: 30 }, 60: { averagePercent: 40 } },
  /** Above the case's last baseline by this fraction: a warning, since CPU drifts between rounds. */
  regressionFraction: 0.25,
} as const;

export interface Verdict { check: string; limit: string; actual: string; verdict: "pass" | "fail" | "warn" | "report" }
const pct = (value: number): string => `${value.toFixed(value < 1 ? 3 : 1)}%`;

/** Idle, after launch or after a recording: average, 95th percentile and wake-ups. */
export function judgeIdle(summary: Summary): Verdict[] {
  const { averagePercent, p95Percent, wakeupsPerSecond } = CPU_BUDGET.idle;
  return [
    { check: "CPU average", limit: `≤ ${averagePercent}%`, actual: pct(summary.cpuPercent.average), verdict: summary.cpuPercent.average <= averagePercent ? "pass" : "fail" },
    { check: "CPU 95th percentile", limit: `≤ ${p95Percent}%`, actual: pct(summary.cpuPercent.p95), verdict: summary.cpuPercent.p95 <= p95Percent ? "pass" : "fail" },
    { check: "Wake-ups", limit: `≤ ${wakeupsPerSecond}/s`, actual: `${summary.wakeupsPerSecond.average.toFixed(2)}/s`, verdict: summary.wakeupsPerSecond.average <= wakeupsPerSecond ? "pass" : "fail" },
  ];
}

/** Judged intervals must cover this share of a window: a stalled or dead sampler is no measurement. */
export const MIN_COVERAGE = 0.8;

/** Whether the judged seconds cover the window; missing samples never pass as zero CPU. */
export function judgeCoverage(summary: Summary, windowSeconds: number, samplerFailure?: string): Verdict {
  const share = windowSeconds > 0 ? summary.seconds / windowSeconds : 0;
  const ok = !samplerFailure && share >= MIN_COVERAGE;
  return {
    check: "Sampled coverage", limit: `≥ ${MIN_COVERAGE * 100}% of ${windowSeconds.toFixed(0)} s`, verdict: ok ? "pass" : "fail",
    actual: `${summary.seconds.toFixed(0)} s judged (${(share * 100).toFixed(0)}%)${samplerFailure ? `; ${samplerFailure}` : ""}`,
  };
}

export function judgeSettingsOpen(summary: Summary): Verdict[] {
  const { averagePercent } = CPU_BUDGET.settingsOpen;
  return [{ check: "CPU average", limit: `≤ ${averagePercent}%`, actual: pct(summary.cpuPercent.average), verdict: summary.cpuPercent.average <= averagePercent ? "pass" : "fail" }];
}

/** A recording: the frame rate's threshold fails; the encoder and a baseline regression are reported. */
export function judgeRecording(summary: Summary, fps: 30 | 60, baselinePercent?: number): Verdict[] {
  const limit = CPU_BUDGET.recording[fps].averagePercent;
  const average = summary.cpuPercent.average;
  const verdicts: Verdict[] = [{
    check: `CPU average at ${fps} fps`, limit: `≤ ${limit}%`, actual: pct(average), verdict: average > limit ? "fail" : "pass",
  }, {
    check: `${ENCODER_SERVICE}`, limit: "reported", verdict: "report",
    actual: summary.followed.present ? `present, ${pct(summary.followed.cpuPercent.average)} average` : "absent: suspect a software-encoding fallback if the app's own CPU is high",
  }];
  if (baselinePercent !== undefined) {
    const limit = baselinePercent * (1 + CPU_BUDGET.regressionFraction);
    verdicts.push({ check: "Against the recorded baseline", limit: `≤ ${pct(limit)} (baseline ${pct(baselinePercent)} + 25%)`, actual: pct(average), verdict: average > limit ? "warn" : "pass" });
  }
  return verdicts;
}

/**
 * A Chromium process's role from its command line: `main`, `gpu`, `renderer`,
 * `utility:<service>` (`network`, `audio`, …) or `other:<type>`. Names alone
 * cannot tell the helpers apart: three are all "RecordStuff Helper".
 */
export function processRole(command: string): string {
  const type = /--type=(\S+)/.exec(command)?.[1];
  if (!type) return "main";
  if (type === "gpu-process") return "gpu";
  if (type === "renderer") return "renderer";
  if (type === "utility") return `utility:${(/--utility-sub-type=(\S+)/.exec(command)?.[1] ?? "unknown").replace(/\.mojom\..*$/, "")}`;
  return `other:${type}`;
}

export type RoleCounts = Record<string, number>;

/** The roles of `rootPid` and its descendants in `ps -axww -o pid=,ppid=,command=` output. */
export function rolesFromPs(output: string, rootPid: number): RoleCounts {
  const rows = output.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));
  const tree = new Set([rootPid]);
  for (let grown = true; grown;) {
    grown = false;
    for (const row of rows) if (!tree.has(row.pid) && tree.has(row.ppid)) { tree.add(row.pid); grown = true; }
  }
  const roles: RoleCounts = {};
  for (const row of rows) {
    if (!tree.has(row.pid)) continue;
    // A descendant without a Chromium type is some other program the app started, not a second main process.
    const typed = processRole(row.command);
    const role = typed === "main" && row.pid !== rootPid ? `child:${path.basename(row.command.split(" --")[0]!.trim())}` : typed;
    roles[role] = (roles[role] ?? 0) + 1;
  }
  return roles;
}

/** The live roles of an app's process tree. */
export function readRoles(rootPid: number): RoleCounts {
  return rolesFromPs(spawnSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).stdout ?? "", rootPid);
}

export const roleText = (roles: RoleCounts): string =>
  Object.entries(roles).sort(([a], [b]) => a.localeCompare(b)).map(([role, n]) => `${role} ×${n}`).join(", ") || "none";

/**
 * What may run while the app waits (plan 049; docs/system-design/design-overview.md#waiting-in-the-menu-bar),
 * by role: each required role exactly once, each allowed role at most its count, nothing else.
 * Right after launch Electron 44 keeps one pre-warmed renderer from the default session
 * (electron/electron#53144), which the first window takes and nothing re-creates. After a
 * recording Chromium's out-of-process audio service, started by the first system-audio capture,
 * stays until the app quits; Chromium 152 gives it no idle exit. With Settings closed no renderer
 * may remain: a capture host or countdown overlay left behind shows up here.
 */
export const IDLE_ROLES = {
  launch: { required: ["main", "gpu", "utility:network"], allowed: { renderer: 1 } },
  afterRecording: { required: ["main", "gpu", "utility:network"], allowed: { "utility:audio": 1 } },
  /** The Settings page's renderer must exist: without it the scenario measured closed idle. */
  settingsOpen: { required: ["main", "gpu", "utility:network", "renderer"], allowed: { "utility:audio": 1 } },
} as const satisfies Record<string, { required: readonly string[]; allowed: Readonly<Record<string, number>> }>;

export function judgeRoles(roles: RoleCounts, contract: { required: readonly string[]; allowed: Readonly<Record<string, number>> }): Verdict {
  const problems: string[] = [];
  for (const role of contract.required) if (roles[role] !== 1) problems.push(`${role} ×${roles[role] ?? 0}, expected ×1`);
  for (const [role, n] of Object.entries(roles)) {
    if (contract.required.includes(role)) continue;
    const allowed = (contract.allowed as Record<string, number>)[role] ?? 0;
    if (n > allowed) problems.push(allowed ? `${role} ×${n}, at most ×${allowed}` : `unexpected ${role} ×${n}`);
  }
  const allowed = Object.entries(contract.allowed).map(([role, n]) => `≤${n} ${role}`).join(", ");
  return { check: "Process roles", limit: `${contract.required.join(", ")}${allowed ? `; ${allowed}` : ""}`, actual: problems.length ? `${roleText(roles)}: ${problems.join("; ")}` : roleText(roles), verdict: problems.length ? "fail" : "pass" };
}

/**
 * Steady state across repetitions (plan 049): after the first recording has started what a
 * recording starts once, every later recording must leave the same roles, so something added
 * once per recording is a leak, as a leak detector counts growth per iteration rather than the
 * difference from a cold start.
 */
export function judgeSteadyState(snapshots: readonly RoleCounts[]): Verdict {
  const texts = snapshots.map(roleText);
  const same = texts.every((text) => text === texts[0]);
  return { check: "Same roles after every recording", limit: texts[0] ?? "—", actual: same ? `${texts.length} snapshots alike` : texts.map((t, i) => `${i + 1}: ${t}`).join(" | "), verdict: snapshots.length < 2 ? "report" : same ? "pass" : "fail" };
}

/**
 * Recording baselines by machine model (`sysctl hw.model`): the median averages of a baseline
 * round, entered by hand from its report together with the verification history entry. A key is
 * `measure:cpu recording <fps>` or `matrix <case key>`.
 */
export const BASELINES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "cpu-baselines.json");
export interface MachineBaselines { recorded: string; source: string; percent: Record<string, number> }

export function machineModel(): string {
  return spawnSync("sysctl", ["-n", "hw.model"], { encoding: "utf8" }).stdout?.trim() || "unknown";
}

/** This machine's baseline for `key`, when one was recorded; a malformed file is an error, not "no baseline". */
export function cpuBaseline(key: string, model = machineModel(), file = BASELINES_PATH): number | undefined {
  if (!fs.existsSync(file)) return undefined;
  const all = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, MachineBaselines | undefined>;
  const value = all[model]?.percent[key];
  return typeof value === "number" && value > 0 ? value : undefined;
}

/** Streams the helper's samples for a process tree until stopped. */
export class CpuSampler {
  readonly samples: Sample[] = [];
  private readonly child: ChildProcess;
  private buffer = "";
  private readonly exited: Promise<void>;
  private stopping = false;
  private early: string | undefined;

  constructor(binary: string, rootPid: number, follow: readonly string[] = [ENCODER_SERVICE], intervalMs = 1000) {
    this.child = spawn(binary, [String(rootPid), String(intervalMs), "0", ...follow], { stdio: ["ignore", "pipe", "inherit"] });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const sample = parseSample(line, Date.now());
        if (sample) this.samples.push(sample);
      }
    });
    this.exited = new Promise((resolve) => {
      // A helper that could not start emits `error` and may never close.
      this.child.once("error", (error) => { this.early ??= `the CPU sampler failed: ${error.message}`; resolve(); });
      this.child.once("close", (code, signal) => {
        if (!this.stopping) this.early ??= `the CPU sampler exited early (${signal ?? `code ${code}`}) after ${this.samples.length} sample(s)`;
        resolve();
      });
    });
  }

  /** Why sampling ended before `stop`, if it did: the samples after that moment are missing. */
  get failure(): string | undefined { return this.early; }

  async stop(): Promise<void> {
    this.stopping = true;
    // Only a child that has a pid: a failed spawn has none, and signalling it must never reach pid 0, the whole process group.
    const alive = (): boolean => this.child.pid !== undefined && this.child.pid > 0 && this.child.exitCode === null && this.child.signalCode === null;
    if (alive()) this.child.kill("SIGTERM");
    // A sampler that ignores SIGTERM must not hold the runner's cleanup forever.
    let escalate: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => { escalate = setTimeout(() => { if (alive()) this.child.kill("SIGKILL"); resolve(); }, 5000); }),
    ]);
    clearTimeout(escalate);
    await this.exited;
  }
}
