import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASELINES_PATH, CPU_BUDGET, CpuSampler, IDLE_ROLES, checkBaselines, compileSampler, cpuBaseline, intervals, judgeCoverage, judgeIdle, judgeRecording, judgeRoles, judgeSettingsOpen, judgeSteadyState, parseSample,
  processRole, rolesFromPs, summarize, type Sample, type Summary,
} from "./cpu-sampler.mts";

/**
 * Five samples recorded from the real helper, 500 ms apart: a shell whose busy
 * `yes` child runs for about a second and is then killed while a `sleep` is
 * replaced, with the system's VTEncoderXPCService instances followed.
 */
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "cpu-samples.jsonl");
const recorded = (): Sample[] => fs.readFileSync(FIXTURE, "utf8").trim().split("\n").map((line, i) => parseSample(line, 1000 + i * 500)!);

describe("CPU sampler on recorded samples (plan 049)", () => {
  it("parses every helper line and refuses anything else", () => {
    const samples = recorded();
    expect(samples).toHaveLength(5);
    expect(samples.every((s) => s.procs.length > 0)).toBe(true);
    expect(parseSample("not json", 0)).toBeUndefined();
    expect(parseSample('{"procs":[]}', 0)).toBeUndefined();
  });

  it("turns cumulative counters into per-second CPU, wake-ups and energy per process", () => {
    const all = intervals(recorded());
    expect(all).toHaveLength(4);
    const busy = all[1]!.processes.find((p) => p.name === "yes")!;
    expect(busy.cpuPercent).toBeGreaterThan(85);
    expect(busy.cpuPercent).toBeLessThan(105);
    expect(busy.energyWatts).toBeGreaterThan(0);
    expect(all[1]!.app.cpuPercent).toBeGreaterThanOrEqual(busy.cpuPercent);
    // The followed encoder service is kept apart from the app's sum.
    expect(all[1]!.followed.present).toBe(true);
    expect(all[1]!.processes.filter((p) => p.followed).every((p) => p.name === "VTEncoderXPCService")).toBe(true);
  });

  it("marks the intervals in which the app's process set changed", () => {
    const all = intervals(recorded());
    expect(all[0]!.setChange?.added).toEqual(expect.arrayContaining([expect.stringMatching(/^yes \(\d+\)$/), expect.stringMatching(/^sleep \(\d+\)$/)]));
    expect(all[1]!.setChange).toBeUndefined();
    expect(all[2]!.setChange?.removed).toEqual(expect.arrayContaining([expect.stringMatching(/^yes /)]));
    expect(all[3]!.setChange).toBeUndefined();
  });

  it("summarizes a window, discarding the changed intervals unless changes are expected", () => {
    const all = intervals(recorded());
    const strict = summarize(all);
    expect(strict.judged).toBe(2);
    expect(strict.discarded).toHaveLength(2);
    expect(strict.cpuPercent.max).toBeGreaterThan(85);
    expect(strict.processes[0]!.name).toBe("yes");
    expect(strict.processNames).toContain("bash");
    expect(summarize(all, -Infinity, Infinity, true).judged).toBe(4);
    // A window by arrival time: only the last interval, after `yes` was gone.
    const quiet = summarize(all, 2500, 3100);
    expect(quiet.judged).toBe(1);
    expect(quiet.cpuPercent.average).toBeLessThan(5);
  });

  it("counts only intervals wholly inside the window, so CPU before its start never leaks in (review)", () => {
    const all = intervals(recorded());
    expect(all.map((i) => [i.startAt, i.at])).toEqual([[1000, 1500], [1500, 2000], [2000, 2500], [2500, 3000]]);
    // Starting mid-interval leaves that interval out; ending mid-interval does too.
    expect(summarize(all, 2900, 3100, true).judged).toBe(0);
    expect(summarize(all, 1500, 2600, true).judged).toBe(2);
    expect(summarize(all, 1500, 2500, true).judged).toBe(2);
  });

  it("fails a window the sampler did not cover, whatever its CPU (review)", () => {
    const all = intervals(recorded());
    const covered = summarize(all, -Infinity, Infinity, true);
    expect(judgeCoverage(covered, 2).verdict).toBe("pass");
    expect(judgeCoverage(covered, 2.6).verdict).toBe("fail");
    expect(judgeCoverage(summarize([], 0, 300_000), 300)).toMatchObject({ verdict: "fail", actual: "0 s judged (0%)" });
    expect(judgeCoverage(covered, 2, "the CPU sampler exited early (code 1) after 5 sample(s)")).toMatchObject({ verdict: "fail" });
  });
});

describe("CPU budget verdicts (plan 049)", () => {
  const summary = (cpu: number, p95 = cpu, wakeups = 1, encoder = true): Summary => ({
    seconds: 300, judged: 300, discarded: [], cpuPercent: { average: cpu, p95, max: p95 }, wakeupsPerSecond: { average: wakeups, p95: wakeups, max: wakeups },
    energyWatts: { average: 0, p95: 0, max: 0 }, followed: { cpuPercent: { average: 2, p95: 2, max: 2 }, present: encoder }, maxResidentBytes: 0, processes: [], processNames: [],
  });

  it("judges idle on the average, the 95th percentile and wake-ups", () => {
    expect(judgeIdle(summary(0.1, 0.5, 0.4)).map((v) => v.verdict)).toEqual(["pass", "pass", "pass"]);
    expect(judgeIdle(summary(0.3, 1.5, 6)).map((v) => v.verdict)).toEqual(["fail", "fail", "fail"]);
    expect(judgeSettingsOpen(summary(0.4))[0]!.verdict).toBe("pass");
    expect(judgeSettingsOpen(summary(0.6))[0]!.verdict).toBe("fail");
  });

  it("fails above the frame rate's threshold and flags a regression against the baseline", () => {
    expect(judgeRecording(summary(20), 30)[0]!.verdict).toBe("pass");
    expect(judgeRecording(summary(30), 30)[0]!.verdict).toBe("pass");
    expect(judgeRecording(summary(31), 30)[0]!.verdict).toBe("fail");
    expect(judgeRecording(summary(35), 60)[0]!.verdict).toBe("pass");
    expect(judgeRecording(summary(41), 60)[0]!.verdict).toBe("fail");
    expect(judgeRecording(summary(20), 30, 15).at(-1)).toMatchObject({ verdict: "warn" });
    expect(judgeRecording(summary(18), 30, 15).at(-1)).toMatchObject({ verdict: "pass" });
    expect(judgeRecording(summary(20, 20, 1, false), 30)[1]!.actual).toContain("absent");
    expect(CPU_BUDGET.regressionFraction).toBe(0.25);
  });

  it("reads this machine's recorded baseline and nothing for another machine or key", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cpu-baselines-")), "cpu-baselines.json");
    expect(cpuBaseline("measure:cpu recording 30", "MacBookPro18,1", file)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ "MacBookPro18,1": { recorded: "2026-09-28", source: "history", percent: { "measure:cpu recording 30": 14.3, zero: 0 } } }));
    expect(cpuBaseline("measure:cpu recording 30", "MacBookPro18,1", file)).toBe(14.3);
    expect(cpuBaseline("measure:cpu recording 30", "Mac14,2", file)).toBeUndefined();
    expect(cpuBaseline("measure:cpu recording 60", "MacBookPro18,1", file)).toBeUndefined();
    expect(cpuBaseline("zero", "MacBookPro18,1", file)).toBeUndefined();
    fs.writeFileSync(file, "{");
    expect(() => cpuBaseline("measure:cpu recording 30", "MacBookPro18,1", file)).toThrow();
  });

  it("checks the whole hand-edited file at once, so a runner refuses it before recording", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cpu-baselines-")), "cpu-baselines.json");
    expect(checkBaselines(file)).toEqual({});
    expect(() => checkBaselines(BASELINES_PATH)).not.toThrow();
    for (const bad of ["{", "[]", JSON.stringify({ "Mac14,2": { recorded: "x", source: "y" } }), JSON.stringify({ "Mac14,2": { percent: { a: "15" } } })]) {
      fs.writeFileSync(file, bad);
      expect(() => checkBaselines(file), bad).toThrow(/cpu-baselines\.json/);
    }
  });
});

describe("process roles and the idle contract (plan 049)", () => {
  const APP = "/Applications/RecordStuff.app/Contents";
  const HELPER = `${APP}/Frameworks/RecordStuff Helper.app/Contents/MacOS/RecordStuff Helper`;
  // As `ps -axww -o pid=,ppid=,command=` printed the packaged app after its first recording.
  const ps = [
    `  100     1 ${APP}/MacOS/RecordStuff`,
    `  101   100 ${HELPER} --type=gpu-process --user-data-dir=/x --gpu-preferences=AB`,
    `  102   100 ${HELPER} --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en`,
    `  103   100 ${HELPER} --type=utility --utility-sub-type=audio.mojom.AudioService --lang=en --service-sandbox-type=audio`,
    `  200     1 ${APP}/MacOS/RecordStuff`,
    `  201   200 ${HELPER} (Renderer).app/Contents/MacOS/RecordStuff Helper (Renderer) --type=renderer --renderer-client-id=4`,
    `  300   103 /usr/bin/descendant --of-the-audio-service`,
  ].join("\n");

  it("names each Chromium process by its role, not its shared helper name", () => {
    expect(processRole(`${APP}/MacOS/RecordStuff`)).toBe("main");
    expect(processRole(`${HELPER} --type=gpu-process`)).toBe("gpu");
    expect(processRole(`${HELPER} --type=utility --utility-sub-type=network.mojom.NetworkService`)).toBe("utility:network");
    expect(processRole(`${HELPER} --type=utility --utility-sub-type=audio.mojom.AudioService`)).toBe("utility:audio");
    expect(processRole(`${HELPER} --type=utility`)).toBe("utility:unknown");
    expect(processRole(`${HELPER} --type=renderer --renderer-client-id=4`)).toBe("renderer");
    expect(processRole(`${HELPER} --type=zygote`)).toBe("other:zygote");
  });

  it("counts the roles of one app's tree to any depth and nothing of another's", () => {
    expect(rolesFromPs(ps, 100)).toEqual({ main: 1, gpu: 1, "utility:network": 1, "utility:audio": 1, "child:descendant": 1 });
    expect(judgeRoles(rolesFromPs(ps, 100), IDLE_ROLES.afterRecording).actual).toContain("unexpected child:descendant ×1");
    expect(rolesFromPs(ps, 200)).toEqual({ main: 1, renderer: 1 });
    expect(rolesFromPs(ps, 999)).toEqual({});
  });

  it("allows the pre-warmed renderer only at launch and the audio service only after a recording", () => {
    const base = { main: 1, gpu: 1, "utility:network": 1 };
    expect(judgeRoles({ ...base, renderer: 1 }, IDLE_ROLES.launch).verdict).toBe("pass");
    expect(judgeRoles(base, IDLE_ROLES.launch).verdict).toBe("pass");
    expect(judgeRoles({ ...base, renderer: 2 }, IDLE_ROLES.launch).actual).toContain("renderer ×2, at most ×1");
    expect(judgeRoles({ ...base, "utility:audio": 1 }, IDLE_ROLES.launch).actual).toContain("unexpected utility:audio ×1");
    expect(judgeRoles({ ...base, "utility:audio": 1 }, IDLE_ROLES.afterRecording).verdict).toBe("pass");
    // A capture host or overlay left behind after a recording, even with the pre-warmed renderer gone.
    const leaked = judgeRoles({ ...base, "utility:audio": 1, renderer: 1 }, IDLE_ROLES.afterRecording);
    expect(leaked).toMatchObject({ verdict: "fail" });
    expect(leaked.actual).toContain("unexpected renderer ×1");
    expect(judgeRoles({ main: 1, gpu: 1 }, IDLE_ROLES.afterRecording).actual).toContain("utility:network ×0, expected ×1");
    expect(judgeRoles({ ...base, "utility:audio": 1, renderer: 1 }, IDLE_ROLES.settingsOpen).verdict).toBe("pass");
    // Settings that never opened measured closed idle: its renderer is required (review).
    expect(judgeRoles({ ...base, "utility:audio": 1 }, IDLE_ROLES.settingsOpen).actual).toContain("renderer ×0, expected ×1");
  });

  it("fails a role that grows with each recording, and only reports a single snapshot", () => {
    const after = { main: 1, gpu: 1, "utility:network": 1, "utility:audio": 1 };
    expect(judgeSteadyState([after, after, after]).verdict).toBe("pass");
    const growing = judgeSteadyState([after, { ...after, renderer: 1 }, { ...after, renderer: 2 }]);
    expect(growing.verdict).toBe("fail");
    expect(growing.actual).toContain("3: gpu ×1, main ×1, renderer ×2");
    expect(judgeSteadyState([after]).verdict).toBe("report");
  });
});

describe("a sampler that stops on its own (review)", () => {
  it.skipIf(process.platform === "win32")("reports an early exit and a helper that could not start", async () => {
    const quits = new CpuSampler("/usr/bin/true", process.pid);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(quits.failure).toMatch(/^the CPU sampler exited early \(code 0\) after 0 sample\(s\)$/);
    await quits.stop();
    const missing = new CpuSampler(path.join(os.tmpdir(), "no-such-cpu-sampler"), process.pid);
    await missing.stop();
    expect(missing.failure).toMatch(/^the CPU sampler failed: .*ENOENT/);
  });
});

describe("the helper resolves the process tree (macOS)", () => {
  const clang = spawnSync("clang", ["--version"]).status === 0;
  it.skipIf(process.platform !== "darwin" || !clang)("samples the root and its descendants and nothing else", async () => {
    const binary = compileSampler(fs.mkdtempSync(path.join(os.tmpdir(), "cpu-sampler-")));
    // Its own process group, so the sleeps end with it.
    const root = spawn("sh", ["-c", "sleep 10 & sleep 10; wait"], { stdio: "ignore", detached: true });
    const sampler = new CpuSampler(binary, root.pid!, [], 200);
    const whole = (sample: Sample): boolean =>
      sample.procs.some((p) => p.pid === root.pid) && sample.procs.filter((p) => p.name === "sleep").length === 2;
    // Wait for the whole tree, not a fixed time: under the full suite's load the first sample can take over a second.
    try {
      const deadline = Date.now() + 5000;
      while (!sampler.samples.some(whole) && sampler.failure === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await sampler.stop();
      try { process.kill(-root.pid!, "SIGTERM"); } catch { /* already gone */ }
    }
    expect(sampler.failure).toBeUndefined();
    expect(sampler.samples.some(whole), `no sample with the root and both sleeps in 5 s (${sampler.samples.length} sample(s))`).toBe(true);
    const procs = sampler.samples.flatMap((sample) => sample.procs);
    expect(procs.map((p) => p.pid)).not.toContain(process.pid);
    expect(procs.every((p) => p.pid === root.pid || p.ppid === root.pid)).toBe(true);
  }, 15_000);
});
