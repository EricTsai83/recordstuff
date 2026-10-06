import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RECIPES, classifyPhase, exitCode, quitOwnedApp, findRecipe, inputsChanged, readNestedTimings, recipeOutcome, renderMarkdown, runPhases, summarize,
  treeDigest, workingTreeIdentity, type Identity, type PhaseRecord, type PhaseSpec,
} from "./verification-timing.mts";

const temporary: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-timing-test-"));
  temporary.push(dir);
  return dir;
};
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const node = (name: string, source: string, extra: Partial<PhaseSpec> = {}): PhaseSpec =>
  ({ name, executable: process.execPath, args: ["-e", source], timeoutMs: 5000, ...extra });

async function run(phases: PhaseSpec[], signal?: AbortSignal): Promise<{ records: PhaseRecord[]; marks: string }> {
  const dir = tempDir();
  const fd = fs.openSync("/dev/null", "w");
  try {
    const records = await runPhases(phases, {
      cwd: dir, env: { ...process.env, MARKS: path.join(dir, "marks") }, scratchDir: dir, graceMs: 500, logFd: fd,
      ...(signal ? { signal } : {}),
    });
    const marks = fs.existsSync(path.join(dir, "marks")) ? fs.readFileSync(path.join(dir, "marks"), "utf8") : "";
    return { records, marks };
  } finally { fs.closeSync(fd); }
}
const mark = (label: string): string => `require('node:fs').appendFileSync(process.env.MARKS, '${label}\\n');`;

describe.skipIf(process.platform === "win32")("verification phases", () => {
  it("times phases in order and reads the durations a child reports inside its own", async () => {
    const { records, marks } = await run([
      node("first", `${mark("first")} setTimeout(() => {}, 120)`),
      node("second", `${mark("second")} require('node:fs').appendFileSync(process.env.RECORDSTUFF_TIMING_FILE,
        JSON.stringify({ runner: 'child', phase: 'package', ms: 40, ok: true }) + '\\nnot json\\n')`),
    ]);
    expect(marks).toBe("first\nsecond\n");
    expect(records.map(record => record.outcome)).toEqual(["pass", "pass"]);
    expect(records[0]!.durationMs).toBeGreaterThanOrEqual(100);
    expect(records[1]!.startMs).toBeGreaterThanOrEqual(records[0]!.startMs! + records[0]!.durationMs!);
    expect(records[0]!.nested).toEqual([]);
    expect(records[1]!.nested).toEqual([{ runner: "child", phase: "package", ms: 40, ok: true }]);
    expect(records.every(record => record.cleanup?.groupGone && !record.cleanup.forced)).toBe(true);
  });

  it("stops at the first failure and runs nothing after it, as && does", async () => {
    const { records, marks } = await run([node("fails", "process.exit(3)"), node("later", mark("later"))]);
    expect(records.map(record => [record.outcome, record.detail])).toEqual([["fail", "exit 3"], ["not run", undefined]]);
    expect(marks).toBe("");
    expect(recipeOutcome(records, false)).toBe("fail");
  });

  it("treats exit 2 as blocked only for desktop runners", async () => {
    expect((await run([node("runner", "process.exit(2)", { blockedExit: true })])).records[0]!.outcome).toBe("blocked");
    expect((await run([node("tsc", "process.exit(2)")])).records[0]!.outcome).toBe("fail");
  });

  it("fails a phase that outlives its bound", async () => {
    const { records } = await run([node("hangs", "setInterval(() => {}, 50)", { timeoutMs: 300 })]);
    expect(records[0]).toMatchObject({ outcome: "fail", detail: "stopped after 300 ms" });
    expect(records[0]!.cleanup?.groupGone).toBe(true);
  });

  it("lets an interrupted phase finish its own cleanup, then skips the rest", async () => {
    const controller = new AbortController();
    const pending = run([
      node("runner", `process.on('SIGTERM', () => { ${mark("cleaned")} process.exit(143); }); ${mark("started")} setInterval(() => {}, 50)`),
      node("later", mark("later")),
    ], controller.signal);
    // Abort only after the child installed its handler; `run` created its directory synchronously.
    const marks = path.join(temporary.at(-1)!, "marks");
    await new Promise<void>(resolve => {
      const poll = setInterval(() => { if (fs.existsSync(marks)) { clearInterval(poll); resolve(); } }, 20);
    });
    controller.abort();
    const { records, marks: written } = await pending;
    expect(written).toBe("started\ncleaned\n");
    expect(records.map(record => record.outcome)).toEqual(["interrupted", "not run"]);
    expect(records[0]!.cleanup).toMatchObject({ groupGone: true, forced: false });
    expect(recipeOutcome(records, false)).toBe("interrupted");
    expect(exitCode("interrupted", "SIGTERM")).toBe(143);
    expect(exitCode("interrupted", "SIGINT")).toBe(130);
  });

  it("fails an exit 0 whose leftover descendant ignored SIGTERM", async () => {
    const { records } = await run([node("leaves", `require('node:child_process').spawn(process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 50)"], { stdio: 'ignore' }); setTimeout(() => process.exit(0), 200)`)]);
    expect(records[0]).toMatchObject({ outcome: "fail", cleanup: { groupGone: true, forced: true } });
  });

  it("never passes a phase whose process group outlived it", () => {
    const spec = node("x", "");
    expect(classifyPhase(spec, { code: 143, stopped: "interrupted", forced: true, groupGone: true, error: undefined }))
      .toEqual({ outcome: "fail", detail: "interrupted; exit 143, but its process group needed SIGKILL to clean up" });
    expect(classifyPhase(spec, { code: null, stopped: "interrupted", forced: false, groupGone: false, error: undefined }).outcome).toBe("fail");
    expect(classifyPhase(spec, { code: 143, stopped: "interrupted", forced: false, groupGone: true, error: undefined }).outcome).toBe("interrupted");
    // A desktop runner that reports its own cleanup incomplete fails the phase; a check stopped with 1 was only interrupted.
    const desktop = { ...spec, blockedExit: true };
    expect(classifyPhase(desktop, { code: 1, stopped: "interrupted", forced: false, groupGone: true, error: undefined }))
      .toEqual({ outcome: "fail", detail: "interrupted; exit 1: its own cleanup was incomplete" });
    expect(classifyPhase(desktop, { code: 130, stopped: "interrupted", forced: false, groupGone: true, error: undefined }).outcome).toBe("interrupted");
    expect(classifyPhase(spec, { code: 1, stopped: "interrupted", forced: false, groupGone: true, error: undefined }).outcome).toBe("interrupted");
    expect(classifyPhase(spec, { code: 0, stopped: undefined, forced: false, groupGone: false, error: undefined }).outcome).toBe("fail");
    expect(classifyPhase(spec, { code: 0, stopped: undefined, forced: true, groupGone: true, error: undefined }))
      .toEqual({ outcome: "fail", detail: "exit 0, but its process group needed SIGKILL to clean up" });
    expect(classifyPhase(spec, { code: null, stopped: undefined, forced: false, groupGone: true, error: "spawn ENOENT" }))
      .toEqual({ outcome: "fail", detail: "spawn ENOENT" });
  });
});

describe("verification summary", () => {
  const record = (durationMs: number, nested = 0): PhaseRecord =>
    ({ name: "p", command: "c", outcome: "pass", startMs: 0, durationMs, nested: nested ? [{ runner: "r", phase: "n", ms: nested, ok: true }] : [] });

  it("does not count nested child durations a second time", () => {
    expect(summarize([record(1000, 900), record(500)], 1600)).toEqual({ wallMs: 1600, phasesMs: 1500, outsidePhasesMs: 100 });
  });

  it("makes a passing run on inputs that changed during it invalid, not a pass", () => {
    expect(recipeOutcome([record(1)], true)).toBe("invalid");
    expect(exitCode("invalid")).toBe(1);
    expect(exitCode("blocked")).toBe(2);
    expect(exitCode("pass")).toBe(0);
  });

  it("flags changed sources, tests or revision but not regenerated artifacts", () => {
    const base: Identity = { workingTree: { head: "a", dirty: true, content: "x" }, runtimeInputs: "r", out: "o", app: "p" };
    expect(inputsChanged(base, { ...base, out: "o2", app: "p2" })).toBe(false);
    expect(inputsChanged(base, { ...base, runtimeInputs: "r2" })).toBe(true);
    expect(inputsChanged(base, { ...base, workingTree: { head: "a", dirty: true, content: "y" } })).toBe(true);
  });

  it("labels intervals it cannot see as unknown and nested phases as already counted", () => {
    const identity: Identity = { workingTree: null, runtimeInputs: "r".repeat(64), out: null, app: null };
    const markdown = renderMarkdown({
      recipe: "check", purpose: "p", replaces: "pnpm check", startedAt: "t", outcome: "pass",
      summary: summarize([record(1000, 900)], 1100), phases: [record(1000, 900)], before: identity, after: identity, versions: { node: "24" },
    });
    expect(markdown).toContain("stay unknown, not zero");
    expect(markdown).toContain("already counted in its duration");
    expect(markdown).toContain("outside phases 0.10 s (identity hashing and app cleanup; writing this report is not included)");
  });

  it("reads only well-formed nested timing lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-nested-"));
    try {
      const file = path.join(dir, "t.jsonl");
      fs.writeFileSync(file, `${JSON.stringify({ runner: "a", phase: "b", ms: 1, ok: false })}\n{"runner":"a"}\n\n`);
      expect(readNestedTimings(file)).toEqual([{ runner: "a", phase: "b", ms: 1, ok: false }]);
      expect(readNestedTimings(path.join(dir, "missing"))).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("recipes", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const scripts = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const runnerScripts = (name: string): string[] => findRecipe(name)!.phases.flatMap(phase => phase.args.filter(arg => arg.startsWith("scripts/")));
  const builds = (name: string): number => findRecipe(name)!.phases
    .filter(phase => (phase.executable === "pnpm" && phase.args[0] === "build") || phase.args.includes("scripts/start-app.mjs")).length;

  it("build identical inputs once", () => {
    for (const recipe of RECIPES) expect(builds(recipe.name), recipe.name).toBe(1);
  });

  it("cover the composites they replace", () => {
    expect(scripts.check).toBe("pnpm typecheck && pnpm test && pnpm build");
    // acceptance:regression = check, Playwright UI, settings fixture and shortcut integration.
    expect(scripts["acceptance:regression"]).toContain("pnpm check && pnpm test:ui && pnpm acceptance:settings && ");
    expect(scripts["acceptance:regression"]).toContain("scripts/acceptance-shortcut.mts");
    expect(scripts["acceptance:settings"]).toContain("scripts/acceptance-settings.mts");
    expect(runnerScripts("settings")).toEqual(["scripts/acceptance-settings.mts", "scripts/acceptance-shortcut.mts"]);
    expect(scripts["acceptance:shortcut-layout"]).toBe("pnpm build && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/acceptance-shortcut-layout.mts");
    expect(runnerScripts("shortcut-registration")).toEqual([...runnerScripts("settings"), "scripts/acceptance-shortcut-layout.mts"]);
    expect(scripts["start:app"]).toBe("node scripts/start-app.mjs");
    expect(scripts.acceptance).toContain("scripts/acceptance-hotkey.mts");
    expect(runnerScripts("recording")).toEqual(["scripts/start-app.mjs", "scripts/acceptance-hotkey.mts"]);
    for (const name of ["settings", "shortcut-registration"]) {
      expect(findRecipe(name)!.phases.slice(0, 4).map(phase => phase.args[0])).toEqual(["typecheck", "test", "build", "test:ui"]);
    }
    expect(findRecipe("recording")!.phases.slice(0, 2).map(phase => phase.args[0])).toEqual(["typecheck", "test"]);
  });
});

describe("identity", () => {
  it("distinguishes uncommitted and untracked content on the same revision", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-identity-"));
    try {
      const git = (...args: string[]): void => {
        const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, encoding: "utf8" });
        if (result.status !== 0) throw new Error(result.stderr);
      };
      git("init", "-q");
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      git("add", "a.txt");
      git("commit", "-qm", "init");
      const clean = workingTreeIdentity(dir)!;
      expect(clean.dirty).toBe(false);
      fs.writeFileSync(path.join(dir, "new.txt"), "1\n");
      const first = workingTreeIdentity(dir)!;
      fs.writeFileSync(path.join(dir, "new.txt"), "2\n");
      const second = workingTreeIdentity(dir)!;
      expect(first.head).toBe(clean.head);
      expect(first.dirty).toBe(true);
      expect(new Set([clean.content, first.content, second.content]).size).toBe(3);
      // A non-ASCII name is read by its UTF-8 path, so its content counts too.
      fs.writeFileSync(path.join(dir, "é.txt"), "1\n");
      const named = workingTreeIdentity(dir)!;
      fs.writeFileSync(path.join(dir, "é.txt"), "2\n");
      expect(workingTreeIdentity(dir)!.content).not.toBe(named.content);
      expect(workingTreeIdentity(os.tmpdir())).toBeUndefined();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("digests a generated tree by path and content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-tree-"));
    try {
      expect(treeDigest(path.join(dir, "missing"))).toBeNull();
      fs.mkdirSync(path.join(dir, "main"));
      fs.writeFileSync(path.join(dir, "main/index.js"), "1");
      const first = treeDigest(dir);
      fs.writeFileSync(path.join(dir, "main/index.js"), "2");
      expect(treeDigest(dir)).not.toBe(first);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("owned app cleanup", () => {
  it("does nothing when the runner already quit the app", async () => {
    let quits = 0;
    expect(await quitOwnedApp({ pids: () => [], main: () => [], quit: async () => { quits++; } })).toMatchObject({ outcome: "not needed" });
    expect(quits).toBe(0);
  });

  it("quits normally and waits for every process to exit", async () => {
    let running = [41];
    const result = await quitOwnedApp({ pids: () => running, main: () => running.slice(0, 1), quit: async () => { setTimeout(() => { running = []; }, 30); }, pollMs: 5 });
    expect(result).toEqual({ outcome: "quit", detail: "quit pids 41 normally" });
  });

  it("waits for helpers an exited app left behind and fails when they stay, without a quit request", async () => {
    let quits = 0;
    const result = await quitOwnedApp({ pids: () => [42], main: () => [], quit: async () => { quits++; }, timeoutMs: 30, pollMs: 5 });
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("42");
    expect(quits).toBe(0);
  });

  it("fails without killing when the app does not exit in time or cannot be checked", async () => {
    expect((await quitOwnedApp({ pids: () => [41], main: () => [41], quit: async () => undefined, timeoutMs: 30, pollMs: 5 })).outcome).toBe("failed");
    expect((await quitOwnedApp({ pids: () => [41], main: () => [41], quit: async () => { throw new Error("denied"); } })).detail).toContain("denied");
    expect((await quitOwnedApp({ pids: () => { throw new Error("pgrep failed"); }, main: () => [], quit: async () => undefined })).outcome).toBe("failed");
  });
});
