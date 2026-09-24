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
console.log(`Evidence: ${dir}`);
