import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupAlive, stopGroup } from "./lib/processes.mts";
import { MEASUREMENTS_DIR, REPO_ROOT } from "./lib/verify-recording.mts";

/**
 * Plan 052: a signal during a recording runner's build must reach the
 * runner's handler, stop the whole build group and exit 130/143. The tools the
 * preflight and the build call are stand-ins on PATH: no app launches, nothing
 * records, the display is not held and the real `out/` is never rebuilt.
 */
const RUNNERS = [
  {
    name: "measure:finalization",
    script: "scripts/measure-finalization.mts",
    args: (scratch: string): string[] => ["--dir", path.join(scratch, "takes"), "--repeat", "1", "--no-open-material", "--label", `vitest-interrupt-${process.pid}`],
    stopping: "stopping this round's build, app and material",
  },
  {
    name: "diagnose:cadence",
    script: "scripts/diagnose-frame-cadence.mts",
    args: (): string[] => ["--rates", "30", "--runs", "1", "--no-open-material"],
    stopping: "stopping this round's build, fixture, load and material",
  },
] as const;

let scratch: string | undefined;
/** Evidence folders present before the test; each runner creates its own before building. */
let evidenceBefore: Set<string> | undefined;
/** What a failed test may leave behind: the runner, and the stand-in build's group and background child. */
let owned: { runner?: ChildProcess; build?: number | undefined; child?: number | undefined } = {};

const evidence = (): string[] => fs.existsSync(MEASUREMENTS_DIR) ? fs.readdirSync(MEASUREMENTS_DIR) : [];

afterEach(async () => {
  // Before the stand-ins go: a surviving runner would otherwise reach the real tools on PATH.
  const { runner } = owned;
  if (runner && runner.exitCode === null && runner.signalCode === null) {
    const gone = new Promise((resolve) => runner.once("exit", resolve));
    runner.kill("SIGKILL");
    await gone;
  }
  if (groupAlive(owned.build)) await stopGroup(owned.build);
  if (owned.child !== undefined && alive(owned.child)) process.kill(owned.child, "SIGKILL");
  owned = {};
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  // Only the empty folders this test's round created; a concurrent round's evidence is never empty for long, and is kept.
  if (evidenceBefore) {
    for (const name of evidence()) {
      const folder = path.join(MEASUREMENTS_DIR, name);
      if (!evidenceBefore.has(name) && fs.statSync(folder).isDirectory() && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
    }
  }
  scratch = undefined;
  evidenceBefore = undefined;
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

function tools(bin: string, state: string): void {
  const write = (name: string, body: string): void => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // The build: a shell whose background child stands for electron-vite, so stopping pnpm alone would leave it.
  write("pnpm", `/bin/sleep 60 &\necho $! > "${state}/child.pid"\necho $$ > "${state}/build.pid"\nwait`);
  write("ffprobe", "exit 0");
  // Neither this checkout's Electron.app nor any RecordStuff is running, whatever the machine runs.
  write("pgrep", "exit 1");
  write("ioreg", `echo '<plist><dict><key>IOConsoleUsers</key><array/></dict></plist>'`);
  write("caffeinate", `[ "$1" = "-u" ] && exit 0\nwhile kill -0 "$4" 2>/dev/null; do /bin/sleep 0.2; done`);
}

describe.runIf(process.platform === "darwin").each(RUNNERS)("$name interrupted during its build", (runnerCase) => {
  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("%s stops the build group and exits %i", async (name, code) => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-runner-interrupt-"));
    evidenceBefore = new Set(evidence());
    const bin = path.join(scratch, "bin");
    const state = path.join(scratch, "state");
    fs.mkdirSync(bin);
    fs.mkdirSync(state);
    tools(bin, state);
    const runner = spawn(process.execPath, [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.join(REPO_ROOT, runnerCase.script), "--", ...runnerCase.args(scratch),
    ], { cwd: REPO_ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdio: ["ignore", "pipe", "pipe"] });
    owned.runner = runner;
    let output = "";
    runner.stdout.on("data", (chunk) => { output += String(chunk); });
    runner.stderr.on("data", (chunk) => { output += String(chunk); });
    const exited = new Promise<number | null>((resolve) => runner.on("exit", (status) => resolve(status)));

    const pidFile = (file: string): number | undefined => {
      try { return Number(fs.readFileSync(path.join(state, file), "utf8").trim()) || undefined; } catch { return undefined; }
    };
    for (let i = 0; i < 200 && (pidFile("build.pid") === undefined || pidFile("child.pid") === undefined); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const build = pidFile("build.pid");
    const child = pidFile("child.pid");
    owned.build = build;
    owned.child = child;
    expect(build, output).toBeDefined();
    expect(child).toBeDefined();
    expect(alive(child!)).toBe(true);

    runner.kill(name);
    expect(await exited, output).toBe(code);
    expect(output).toContain(`${name}: ${runnerCase.stopping}`);
    expect(output).toContain("cleanup: every owned process exited");
    expect(alive(build!)).toBe(false);
    expect(alive(child!)).toBe(false);
  }, 30_000);
});
