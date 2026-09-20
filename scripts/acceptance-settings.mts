/**
 * `pnpm acceptance:settings [-- --out <dir>]`
 *
 * Acceptance of the settings panel against the *built* artifacts: it runs
 * Electron on `scripts/fixtures/settings-panel.mjs`, which loads
 * `out/preload/settings.js` and `out/renderer/settings.html` in a real
 * window, drives it, and reports each case. This is the only check that
 * exercises the shipped CSP, the sandboxed preload boundary and a real IPC
 * round trip; `settings-model` and `SettingsWindow` are covered by unit
 * tests, so the fixture supplies its own view and handlers.
 *
 * It does not click the tray, open the window through Settings, or claim
 * anything about macOS window focus — a windowless app's tray is not
 * automatable (see .agents/skills/astra-acceptance-with-computer-use).
 *
 * Exit 0 when every case passed. A report and a screenshot are written to
 * docs/verification/measurements/<timestamp>-settings-acceptance/.
 * Requires `pnpm build` output. Nothing here ships with the app.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Case {
  name: string;
  ok: boolean;
  detail: string;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(REPO_ROOT, "scripts/fixtures/settings-panel.mjs");
const ELECTRON = path.join(REPO_ROOT, "node_modules/.bin/electron");
const TIMEOUT_MS = 90_000;

const argv = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
let outDir: string | undefined;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--out") outDir = argv[++i];
  else fail(`Unknown argument ${argv[i]}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

for (const required of ["out/preload/settings.js", "out/renderer/settings.html"]) {
  if (!fs.existsSync(path.join(REPO_ROOT, required))) fail(`${required} is missing; run \`pnpm build\` first.`);
}
if (!fs.existsSync(ELECTRON)) fail("node_modules/.bin/electron is missing; run `pnpm install` first.");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = outDir ? path.resolve(outDir) : path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-settings-acceptance`);
// Never overwrite another run's evidence.
fs.mkdirSync(dir, { recursive: !outDir });

/** Electron needs a real app launch: no ELECTRON_RUN_AS_NODE, no inherited signing env. */
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const code = await new Promise<number>((resolve, reject) => {
  const log = fs.openSync(path.join(dir, "electron.log"), "a");
  const child = spawn(ELECTRON, [FIXTURE, dir, REPO_ROOT], { cwd: REPO_ROOT, env, stdio: ["ignore", log, log] });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`the fixture did not finish within ${TIMEOUT_MS / 1000} s; see electron.log`));
  }, TIMEOUT_MS);
  child.on("error", (error) => {
    clearTimeout(timer);
    fs.closeSync(log);
    reject(error);
  });
  child.on("exit", (status) => {
    clearTimeout(timer);
    fs.closeSync(log);
    resolve(status ?? 1);
  });
});

const resultsPath = path.join(dir, "results.json");
if (!fs.existsSync(resultsPath)) {
  const detail = fs.existsSync(path.join(dir, "error.txt")) ? fs.readFileSync(path.join(dir, "error.txt"), "utf8") : "";
  fail(`The fixture produced no results (exit ${code}). ${detail}\nEvidence: ${dir}`);
}
const cases = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as Case[];
for (const result of cases) console.log(`${result.ok ? "PASS" : "FAIL"}: ${result.name} — ${result.detail}`);

const passed = cases.filter((result) => result.ok).length;
const report = [
  `# Settings panel acceptance — ${stamp}`,
  "",
  `Electron exit code ${code}; ${passed}/${cases.length} cases passed.`,
  "",
  "Built artifacts under test: `out/preload/settings.js`, `out/renderer/settings.html`.",
  "The fixture supplies its own view and IPC handlers, so this run judges the page,",
  "the preload boundary and the IPC round trip — not `settings-model` or `SettingsWindow`.",
  "No tray click, no Settings item and no macOS window focus behaviour was exercised.",
  "",
  ...cases.map((result) => `- ${result.ok ? "PASS" : "FAIL"} — ${result.name}\n  - ${result.detail}`),
  "",
  "Screenshot: `panel.png`. Raw cases: `results.json`. Electron output: `electron.log`.",
  "",
].join("\n");
fs.writeFileSync(path.join(dir, "report.md"), report);

console.log(`\n${passed}/${cases.length} cases passed. Evidence: ${dir}`);
process.exit(code === 0 && passed === cases.length ? 0 : 1);
