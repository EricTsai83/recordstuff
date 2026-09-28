/** Build-only instrumentation, seeds and arguments of acceptance:controlled. No production module imports this file. */
import fs from "node:fs";
import { replaceOnce as replaceOnceShared } from "./replace-once.mts";
import path from "node:path";
import { parseArgs } from "node:util";
import type { RecordingResult } from "../../src/shared/recording-result.ts";
import { isFaultMode, isFaultName, isHoldTarget, type FaultName, type HoldTarget } from "../fixtures/controlled-modes.ts";

export const CONTROLLED_TOOL = "acceptance:controlled";
export const SEEDS = ["none", "v1", "retention"] as const;
export type Seed = (typeof SEEDS)[number];
/** Written beside the evidence so later commands find the run; self-tests are never the default target. */
export interface RunMarker { tool: typeof CONTROLLED_TOOL; createdAt: string; seed: Seed; selftest: boolean }

const replaceOnce = (source: string, from: string, to: string): string => replaceOnceShared(source, from, to, "Controlled acceptance");

const PUBLISH = `    publishFailure: result => recordingResults.receive(result, {
      stat: file => fs.stat(file), refresh: refreshUi,
      notify: code => tray.notifyRecordingFailure(code),
    }),`;
const RESULTS = `  const recordingResults = new RecordingResults(
    new RecordingResultStore(path.join(app.getPath("userData"), "recording-history.json"), log,
      path.join(app.getPath("userData"), "recording-result.json")), log, () => refreshUi());`;

/**
 * Wires the controlled build into a throwaway copy of `src/main/index.ts`. Each anchor must
 * occur exactly once, so drifted production wiring stops preparation instead of testing a stale
 * substitute. Only data locations and the fault boundaries change; every UI and lifecycle path
 * stays the production one.
 */
export function instrumentControlledAcceptance(source: string, runDir: string): string {
  source = replaceOnce(source, "let currentLanguage: Language = DEFAULT_LANGUAGE;",
    `import { configureControlled } from "../../scripts/fixtures/controlled-acceptance";\n` +
    `const controlled = configureControlled(${JSON.stringify(runDir)});\nlet currentLanguage: Language = DEFAULT_LANGUAGE;`);
  source = replaceOnce(source, "defaultOutputDir: defaultOutputDir(),", "defaultOutputDir: controlled.outputDir || defaultOutputDir(),");
  source = replaceOnce(source, "openWriter: (recordingPath, finalPath) => FileWriter.open(recordingPath, finalPath),",
    "openWriter: (recordingPath, finalPath) => controlled.openWriter(recordingPath, finalPath),");
  source = replaceOnce(source, PUBLISH, PUBLISH
    .replace("publishFailure: result => recordingResults.receive(result, {",
      "publishFailure: async result => { await controlled.beforePublish(result); return recordingResults.receive(result, {")
    .replace(/\}\),$/, "}); },"));
  source = replaceOnce(source, RESULTS, RESULTS
    .replace("new RecordingResultStore(", "controlled.storage(new RecordingResultStore(")
    .replace(`"recording-result.json")), log,`, `"recording-result.json"))), log,`));
  source = replaceOnce(source, "  updates.flush();\n  log(`ready;",
    "  controlled.attach({ recorder, recordingResults, settings, tray, handleAction, log });\n  updates.flush();\n  log(`ready;");
  return source;
}

/** Recognizable filler for seeded partial files; it is not a playable recording. */
export const SEED_BYTES = "RecordStuff controlled acceptance seed: synthetic bytes, not a playable recording\n";
const HOUR = 3_600_000;

function record(id: string, occurredAt: number, fields: Partial<RecordingResult>): RecordingResult {
  return { id, occurredAt: new Date(occurredAt).toISOString(), code: "capture_failed", outcome: "empty",
    detail: `synthetic record ${id} seeded by ${CONTROLLED_TOOL}; not a real failure`, acknowledged: false, ...fields };
}

/**
 * Isolated data written before launch, keyed by path relative to the run directory.
 * `v1`: one unread legacy result whose partial exists, for migration (N23).
 * `retention`: twenty reviewed records between two unread ones, so acknowledging the
 * old unread record exercises the 20-most-recently-reviewed limit without evicting unread ones (N22).
 */
export function seedFiles(seed: Seed, runDir: string, now: number): Record<string, string> {
  if (seed === "none") return {};
  if (seed === "v1") {
    const partial = path.join(runDir, "recordings", "seed-v1.recording.mp4");
    const result = record("seed-v1", now - 2 * HOUR, { code: "output_write_failed", outcome: "partial", partialPath: partial });
    return { "user-data/recording-result.json": JSON.stringify({ version: 1, result }), "recordings/seed-v1.recording.mp4": SEED_BYTES };
  }
  const reviewed = Array.from({ length: 20 }, (_, i) => {
    const at = now - (i + 2) * HOUR;
    return record(`seed-reviewed-${String(i + 1).padStart(2, "0")}`, at,
      { acknowledged: true, acknowledgedAt: new Date(at + 10 * 60_000).toISOString() });
  });
  const results = [
    record("seed-unread-new", now - HOUR, { code: "disk_full" }),
    ...reviewed,
    record("seed-unread-old", now - 30 * 24 * HOUR, { code: "output_open_failed" }),
  ];
  return { "user-data/recording-history.json": JSON.stringify({ version: 2, results }) };
}

/** `SETTINGS_VERSION` in src/main/settings.ts; a test keeps them equal. */
export const SETTINGS_FILE_VERSION = 3;

/**
 * The self-test's isolated preferences: no notification banners, no global recording
 * shortcut and no first-run hint, so it never shows anything beyond the tray icon.
 */
export function selfTestFiles(runDir: string): Record<string, string> {
  return {
    "user-data/settings.json": JSON.stringify({ version: SETTINGS_FILE_VERSION, outputDir: path.join(runDir, "recordings"),
      notifications: false, hotkey: { enabled: false, accelerator: "CommandOrControl+Shift+1" } }),
    "user-data/tray-hint-shown": "",
  };
}

export function writeSeedFiles(runDir: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(runDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { flag: "wx" });
  }
}

export type ControlledArgs =
  | { command: "launch"; seed: Seed; holdHistoryLoad: boolean; out?: string }
  | { command: "selftest"; out?: string }
  | { command: "reopen"; holdHistoryLoad: boolean; dir?: string }
  | { command: "fault"; faults: Array<{ name: FaultName; mode: string }>; dir?: string }
  | { command: "release"; target: HoldTarget; dir?: string }
  | { command: "status" | "quit" | "clean"; dir?: string };

export const USAGE = `Usage: pnpm acceptance:controlled -- <command>
  launch [--seed none|v1|retention] [--hold-history-load] [--out <new dir>]
  reopen [--hold-history-load] [--dir <run>]
  fault <cleanup|write|close|history-save>=<mode> ... [--dir <run>]
  release <cleanup|history-save|history-load> [--dir <run>]
  status | quit | clean [--dir <run>]
  selftest [--out <new dir>]`;

export function parseControlledArgs(argv: readonly string[]): ControlledArgs {
  const { values, positionals } = parseArgs({ args: argv.filter(a => a !== "--"), allowPositionals: true, strict: true, options: {
    seed: { type: "string" }, "hold-history-load": { type: "boolean", default: false }, out: { type: "string" }, dir: { type: "string" },
  } });
  const [command, ...rest] = positionals;
  const given = Object.entries(values).filter(([, value]) => value !== undefined && value !== false).map(([name]) => name);
  const allow = (...names: string[]): void => {
    const other = given.find(name => !names.includes(name));
    if (other) throw new Error(`--${other} does not apply to ${command}`);
  };
  const none = (): void => { if (rest.length) throw new Error(`${command} takes no arguments: ${rest.join(" ")}`); };
  const dir = values.dir === undefined ? {} : { dir: values.dir };
  switch (command) {
    case "launch": {
      allow("seed", "hold-history-load", "out"); none();
      const seed = values.seed ?? "none";
      if (!(SEEDS as readonly string[]).includes(seed)) throw new Error(`unknown seed ${JSON.stringify(seed)}; choose ${SEEDS.join(", ")}`);
      return { command, seed: seed as Seed, holdHistoryLoad: values["hold-history-load"] === true, ...(values.out ? { out: values.out } : {}) };
    }
    case "selftest":
      allow("out"); none();
      return { command, ...(values.out ? { out: values.out } : {}) };
    case "reopen":
      allow("hold-history-load", "dir"); none();
      return { command, holdHistoryLoad: values["hold-history-load"] === true, ...dir };
    case "fault": {
      allow("dir");
      if (!rest.length) throw new Error("fault needs at least one <name>=<mode>");
      const faults = rest.map(arg => {
        const [name, mode, extra] = arg.split("=");
        if (extra !== undefined || !isFaultName(name) || mode === undefined || !isFaultMode(name, mode)) throw new Error(`invalid fault ${JSON.stringify(arg)}`);
        return { name, mode };
      });
      return { command, faults, ...dir };
    }
    case "release":
      allow("dir");
      if (rest.length !== 1 || !isHoldTarget(rest[0])) throw new Error(`release needs one of cleanup, history-save, history-load`);
      return { command, target: rest[0], ...dir };
    case "status": case "quit": case "clean":
      allow("dir"); none();
      return { command, ...dir };
    default:
      throw new Error(command ? `unknown command ${JSON.stringify(command)}` : "missing command");
  }
}

/** The newest guided run under `parent`; self-test runs are skipped. */
export function latestRun(parent: string): string | undefined {
  let best: { dir: string; createdAt: string } | undefined;
  let names: string[];
  try { names = fs.readdirSync(parent); } catch { return undefined; }
  for (const name of names) {
    const dir = path.join(parent, name);
    let marker: RunMarker;
    try { marker = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as RunMarker; } catch { continue; }
    if (marker.tool !== CONTROLLED_TOOL || marker.selftest) continue;
    if (!best || marker.createdAt > best.createdAt) best = { dir, createdAt: marker.createdAt };
  }
  return best?.dir;
}

/** A `pgrep -f` pattern that matches this bundle's executable literally, whatever characters its run path holds. */
export function bundleProcessPattern(appPath: string): string {
  const executable = `${appPath}/Contents/MacOS/RecordStuff`;
  return `${executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($| )`;
}

/** The next request number, continuing across relaunches so a new process never answers an old file. */
export function nextRequestNumber(names: readonly string[]): number {
  return Math.max(0, ...names.map(name => /^(\d+)\.json$/.exec(name)?.[1]).filter(n => n !== undefined).map(Number)) + 1;
}
