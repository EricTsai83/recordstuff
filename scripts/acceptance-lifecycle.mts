/** Real process-lifetime checks through the production quit coordinator. */
import { buildFixture } from "./lib/build-fixture.mts";
import { scrubbedEnv } from "./lib/runner-env.mts";
import { runIsolatedProcess } from "./lib/isolated-process.mts";
import { INTERRUPT_EXIT, interruptExitCode } from "./lib/processes.mts";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = path.join(root, "docs/verification/measurements", `${new Date().toISOString().replace(/[:.]/g, "-")}-lifecycle`);
fs.mkdirSync(dir, { recursive: true });
const fixture = await buildFixture("recording-lifecycle", dir);
const env = scrubbedEnv();
// The fixtures run in their own process group, which a terminal's Ctrl+C never reaches: stop them through the supervisor.
const controller = new AbortController();
/** The first signal names the exit code, as in every other runner. */
let signalName: keyof typeof INTERRUPT_EXIT | undefined;
const interrupt = (name: keyof typeof INTERRUPT_EXIT) => (): void => { signalName ??= name; controller.abort(); };
process.on("SIGINT", interrupt("SIGINT"));
process.on("SIGTERM", interrupt("SIGTERM"));
/**
 * After an interrupt the round is neither pass nor fail: 130/143 once the fixture's group is gone, 1 when it survived.
 * Without an execution the interrupt came during the history fixture's build, when no group exists; a signal
 * cannot be handled between the loop's runs, which pass from one to the next without yielding to the event loop.
 */
async function exitIfInterrupted(execution?: { groupGone: boolean }): Promise<void> {
  if (!controller.signal.aborted) return;
  console.error(`Interrupted${execution ? ": fixture stopped" : " between fixtures"}. Evidence: ${dir}`);
  process.exit(await interruptExitCode(signalName ?? "SIGINT", async () => execution?.groupGone === false ? ["the fixture's process group"] : []));
}
const require = createRequire(import.meta.url);
const results = [];
for (const mode of ["copy", "cleanup", "result"]) {
  const output = path.join(dir, mode); fs.mkdirSync(output);
  const logFd = fs.openSync(path.join(output, "electron.log"), "w");
  try {
    const execution = await runIsolatedProcess({ executable: require("electron") as string,
      args: [fixture, output, mode], cwd: root, env, logFd, timeoutMs: 15_000, signal: controller.signal });
    results.push({ mode, execution });
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(results, null, 2));
    await exitIfInterrupted(execution);
    assert.equal(execution.code, 0); assert.equal(execution.stopped, undefined);
    assert.equal(execution.forced, false); assert.equal(execution.groupGone, true);
    const result = JSON.parse(fs.readFileSync(path.join(output, "result.json"), "utf8"));
    assert.equal(result.deferred, 2); assert.equal(result.terminal, 1);
    console.log(`PASS ${mode}: two deferred quits, exact bytes, one terminal result, normal process exit`);
  } finally { fs.closeSync(logFd); }
}
// Plan 036: unsaved history through the same production quit wiring.
{
  const historyFixture = await buildFixture("history-quit", dir);
  await exitIfInterrupted();
  const output = path.join(dir, "history"); fs.mkdirSync(output);
  const logFd = fs.openSync(path.join(output, "electron.log"), "w");
  try {
    const execution = await runIsolatedProcess({ executable: require("electron") as string,
      args: [historyFixture, output], cwd: root, env, logFd, timeoutMs: 20_000, signal: controller.signal });
    results.push({ mode: "history", execution });
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(results, null, 2));
    await exitIfInterrupted(execution);
    assert.equal(execution.code, 0); assert.equal(execution.stopped, undefined);
    assert.equal(execution.forced, false); assert.equal(execution.groupGone, true);
    const result = JSON.parse(fs.readFileSync(path.join(output, "result.json"), "utf8"));
    assert.ok(result.lagMs < 100, `main event loop lag ${result.lagMs} ms`);
    assert.ok(Math.max(...result.roundTripsMs) < 1000, "renderer round trips");
    assert.equal(result.joined, 1); assert.equal(result.resumed, 1); assert.equal(result.deferred, 1);
    assert.equal(result.peak, 1); assert.equal(result.busyAtExit, false); assert.equal(result.historyFileWritten, false);
    assert.equal(result.prompts.length, 3);
    assert.deepEqual(result.prompts[2].buttons, ["Retry", "Stay in app", "Exit without saving these records"]);
    assert.equal(result.prompts[2].copyHeld, false); assert.ok(result.prompts[2].savedPath);
    assert.match(result.prompts[2].detail, /Unsaved records: 1/);
    assert.deepEqual(result.mediaBytes, [44, 55, 66]); assert.deepEqual(result.partialBytes, [11, 22, 33]);
    console.log(`PASS history: responsive main (lag ${result.lagMs} ms), joined quit, open while writing, stay restores capture, media before metadata, explicit exit`);
  } finally { fs.closeSync(logFd); }
}
console.log(`Evidence: ${dir}`);
