/** Real process-lifetime checks through the production quit coordinator. */
import { buildFixture } from "./lib/build-fixture.mts";
import { runIsolatedProcess } from "./lib/isolated-process.mts";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = path.join(root, "docs/verification/measurements", `${new Date().toISOString().replace(/[:.]/g, "-")}-lifecycle`);
fs.mkdirSync(dir, { recursive: true });
const fixture = await buildFixture("recording-lifecycle", dir);
const env = { ...process.env };
for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "RECORDSTUFF_AUTORECORD", "NODE_OPTIONS"]) delete env[key];
const require = createRequire(import.meta.url);
const results = [];
for (const mode of ["copy", "cleanup", "result"]) {
  const output = path.join(dir, mode); fs.mkdirSync(output);
  const logFd = fs.openSync(path.join(output, "electron.log"), "w");
  try {
    const execution = await runIsolatedProcess({ executable: require("electron") as string,
      args: [fixture, output, mode], cwd: root, env, logFd, timeoutMs: 15_000 });
    results.push({ mode, execution });
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(results, null, 2));
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
  const output = path.join(dir, "history"); fs.mkdirSync(output);
  const logFd = fs.openSync(path.join(output, "electron.log"), "w");
  try {
    const execution = await runIsolatedProcess({ executable: require("electron") as string,
      args: [historyFixture, output], cwd: root, env, logFd, timeoutMs: 20_000 });
    results.push({ mode: "history", execution });
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(results, null, 2));
    assert.equal(execution.code, 0); assert.equal(execution.stopped, undefined);
    assert.equal(execution.forced, false); assert.equal(execution.groupGone, true);
    const result = JSON.parse(fs.readFileSync(path.join(output, "result.json"), "utf8"));
    assert.ok(result.lagMs < 100, `main event loop lag ${result.lagMs} ms`);
    assert.ok(Math.max(...result.roundTripsMs) < 1000, "renderer round trips");
    assert.equal(result.joined, 1); assert.equal(result.resumed, 1); assert.equal(result.deferred, 1);
    assert.equal(result.peak, 1); assert.equal(result.busyAtExit, false); assert.equal(result.historyFileWritten, false);
    assert.equal(result.prompts.length, 3);
    assert.deepEqual(result.prompts[2].buttons, ["Retry", "Stay in app", "Exit without saving these reminders"]);
    assert.equal(result.prompts[2].copyHeld, false); assert.ok(result.prompts[2].savedPath);
    assert.match(result.prompts[2].detail, /Unsaved reminders: 1/);
    assert.deepEqual(result.mediaBytes, [44, 55, 66]); assert.deepEqual(result.partialBytes, [11, 22, 33]);
    console.log(`PASS history: responsive main (lag ${result.lagMs} ms), joined quit, open while writing, stay restores capture, media before metadata, explicit exit`);
  } finally { fs.closeSync(logFd); }
}
console.log(`Evidence: ${dir}`);
