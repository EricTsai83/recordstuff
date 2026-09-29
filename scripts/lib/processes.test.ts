import { spawn, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { INHERITED_ELECTRON_KEYS } from "./runner-env.mts";
import {
  electronPattern, groupAlive, interruptExitCode, pgrepPids, pgrepProcesses, recordStuffPattern, startBuild, stopGroup,
} from "./processes.mts";

/** A checkout under a folder whose name holds every pattern character a path can carry. */
const CHECKOUT = "/Users/x/Code (2026) [a]+b.$c/recordstuff";
const ELECTRON = `${CHECKOUT}/node_modules/.pnpm/electron@1.0.0/node_modules/electron/dist/Electron.app`;
const SIBLING = ELECTRON.replace("Code (2026) [a]+b.$c", "Code 2026 a+bx$c");
const HELPER = `${ELECTRON}/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer`;

const reply = (status: number | null, stdout = "", error?: Error): SpawnSyncReturns<string> =>
  ({ pid: 1, output: [], stdout, stderr: status === 2 ? "pgrep: bad pattern" : "", status, signal: null, ...(error ? { error } : {}) });

describe("process patterns", () => {
  it("match a checkout's Electron.app literally and nothing beside it", () => {
    const bundle = new RegExp(electronPattern(ELECTRON, "bundle"));
    const main = new RegExp(electronPattern(ELECTRON, "main"));
    expect(main.test(`${ELECTRON}/Contents/MacOS/Electron`)).toBe(true);
    expect(main.test(`${ELECTRON}/Contents/MacOS/Electron ${CHECKOUT}`)).toBe(true);
    expect(bundle.test(`${ELECTRON}/Contents/MacOS/Electron ${CHECKOUT}`)).toBe(true);
    expect(bundle.test(HELPER)).toBe(true);
    // The main pattern is the root of the tree only; neither follows a sibling checkout or a mention in arguments.
    expect(main.test(HELPER)).toBe(false);
    expect(main.test(`${ELECTRON}/Contents/MacOS/ElectronX`)).toBe(false);
    for (const pattern of [bundle, main]) {
      expect(pattern.test(`${SIBLING}/Contents/MacOS/Electron`)).toBe(false);
      expect(pattern.test(`/usr/bin/tail -f ${ELECTRON}/Contents/MacOS/Electron`)).toBe(false);
    }
  });

  it("match a RecordStuff bundle under such a path literally, and any bundle without one", () => {
    const app = `${CHECKOUT}/dist/mac-arm64/RecordStuff.app`;
    const own = new RegExp(recordStuffPattern(app));
    expect(own.test(`${app}/Contents/MacOS/RecordStuff`)).toBe(true);
    expect(own.test(`${app}/Contents/MacOS/RecordStuff --flag`)).toBe(true);
    expect(own.test(`${app.replace("Code (2026) [a]+b.$c", "Code 2026 a+bx$c")}/Contents/MacOS/RecordStuff`)).toBe(false);
    expect(own.test(`${app}/Contents/MacOS/RecordStuffX`)).toBe(false);
    expect(own.test(`/bin/cat ${app}/Contents/MacOS/RecordStuff`)).toBe(false);
    const any = new RegExp(recordStuffPattern());
    expect(any.test("/Applications/RecordStuff.app/Contents/MacOS/RecordStuff")).toBe(true);
    expect(any.test(`${app}/Contents/MacOS/RecordStuff`)).toBe(true);
    expect(any.test("/Applications/NotRecordStuff.app/Contents/MacOS/RecordStuff")).toBe(false);
    expect(any.test("/Applications/RecordStuffXapp/Contents/MacOS/RecordStuff")).toBe(false);
    // A program that only names an installed bundle is not RecordStuff running.
    expect(any.test("/bin/cat /Applications/RecordStuff.app/Contents/MacOS/RecordStuff")).toBe(false);
    expect(any.test("/usr/bin/codesign -dv /Applications/RecordStuff.app/Contents/MacOS/RecordStuff")).toBe(false);
    expect(any.test("lldb /Applications/RecordStuff.app/Contents/MacOS/RecordStuff")).toBe(false);
  });
});

describe("pgrep", () => {
  it("reads status 1 as none and parses the pids of status 0", () => {
    expect(pgrepPids("x", () => reply(1))).toEqual([]);
    expect(pgrepPids("x", () => reply(0, "12\n345\n"))).toEqual([12, 345]);
    expect(pgrepProcesses("x", () => reply(0, "12 /a/b c\n"))).toEqual(["12 /a/b c"]);
  });

  it("throws for any other status and for a spawn error instead of reporting nothing running", () => {
    expect(() => pgrepPids("x", () => reply(2))).toThrow(/pgrep failed \(2\): pgrep: bad pattern/);
    expect(() => pgrepPids("x", () => reply(null, "", Object.assign(new Error("spawn pgrep ENOENT"), { code: "ENOENT" })))).toThrow(/could not run: spawn pgrep ENOENT/);
    expect(() => pgrepProcesses("x", () => reply(3))).toThrow(/pgrep failed \(3\)/);
  });

  it.runIf(process.platform === "darwin")("finds a real process under such a path with the system pgrep", async () => {
    const executable = `${ELECTRON}/Contents/MacOS/Electron`;
    // exec -a sets the command line pgrep -f reads, without creating the path; $0 keeps it unexpanded.
    const child = spawn("/bin/bash", ["-c", 'exec -a "$0" /bin/sleep 30', executable], { stdio: "ignore" });
    try {
      let found: number[] = [];
      for (let i = 0; i < 40 && found.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        found = pgrepPids(electronPattern(ELECTRON, "main"));
      }
      expect(found).toEqual([child.pid]);
      expect(pgrepPids(electronPattern(SIBLING, "main"))).toEqual([]);
      // The unescaped path is an invalid extended expression: pgrep exits 2, which must not read as "none".
      expect(() => pgrepPids(`${CHECKOUT.replace("(2026)", "(2026")}/`)).toThrow(/pgrep failed/);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("interrupted build", () => {
  let pid: number | undefined;
  afterEach(async () => { if (groupAlive(pid)) await stopGroup(pid); pid = undefined; });

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("%s during the build stops its whole group and exits %i", async (name, code) => {
    // A shell with a background grandchild: stopping pnpm alone would leave the child writing out/.
    const build = startBuild(process.cwd(), ["/bin/sh", "-c", "/bin/sleep 30 & /bin/sleep 30; wait"]);
    pid = build.child.pid;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(groupAlive(pid)).toBe(true);
    const lines: string[] = [];
    const exit = await interruptExitCode(name, async () => {
      await stopGroup(pid);
      return groupAlive(pid) ? ["the build"] : [];
    }, (line) => lines.push(line));
    expect(exit).toBe(code);
    expect(groupAlive(pid)).toBe(false);
    expect(await build.done).toBe(1);
    expect(lines).toEqual(["cleanup: every owned process exited"]);
  });

  it("exits 1 when cleanup leaves a process or cannot tell", async () => {
    const lines: string[] = [];
    expect(await interruptExitCode("SIGINT", async () => ["the material browser"], (line) => lines.push(line))).toBe(1);
    expect(await interruptExitCode("SIGTERM", async () => { throw new Error("pgrep failed (2)"); }, (line) => lines.push(line))).toBe(1);
    expect(lines).toEqual(["CLEANUP INCOMPLETE: the material browser still running", "CLEANUP FAILED: pgrep failed (2)"]);
  });

  it("reports a build that exits on its own with its code", async () => {
    expect(await startBuild(process.cwd(), ["/bin/sh", "-c", "exit 3"]).done).toBe(3);
    expect(await startBuild(process.cwd(), ["/nonexistent/build-tool"]).done).toBe(1);
  });
});

describe("runner launch environment", () => {
  const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  /** Tools that start no Electron and no app: signing identity creation and release publication. */
  const NOT_LAUNCHERS = new Set(["create-signing-identity.mts", "release.mts"]);
  const files = [scripts, path.join(scripts, "lib")]
    .flatMap((dir) => fs.readdirSync(dir).filter((name) => name.endsWith(".mts")).map((name) => path.join(dir, name)))
    .filter((file) => path.basename(file) !== "runner-env.mts");

  it("starts every runner's child environment from scrubbedEnv, never from its own key list", () => {
    const keys = INHERITED_ELECTRON_KEYS.join("|");
    const offences = files.flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      const name = path.relative(scripts, file);
      return [
        ...(new RegExp(`delete\\s+[\\w.]+(\\.(${keys})\\b|\\[\\s*["'](${keys})["']\\s*\\])`).test(text) ? [`${name} deletes an inherited key itself`] : []),
        ...(new RegExp(`\\[[^\\]]*["'](${keys})["'][^\\]]*["'](${keys})["']`).test(text) ? [`${name} keeps its own inherited-key list`] : []),
        ...(!NOT_LAUNCHERS.has(path.basename(file)) && /\.\.\.process\.env\b/.test(text) ? [`${name} copies process.env instead of scrubbedEnv()`] : []),
      ];
    });
    expect(offences).toEqual([]);
    expect(files.length).toBeGreaterThan(20);
  });
});
