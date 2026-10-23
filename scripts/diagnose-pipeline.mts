#!/usr/bin/env node
/**
 * `pnpm diagnose:pipeline -- [<log>…] [--session <id>]… [--last N] [--json <file>]`
 *
 * Summarizes the media pipeline's figures (plan 083): record with `RECORDSTUFF_DIAGNOSTICS=1` in the app's environment
 * (`pnpm measure:cpu -- --diagnostics` sets it on the bundle it launches; `RECORDSTUFF_DIAGNOSTICS=1 pnpm matrix -- quick`
 * passes it to the development app), then point this at the app's log, by default `~/Library/Logs/recordstuff/`'s
 * archive and current file. Prints, per session, each stage's count, mean, p50, p95 and maximum and the queue and drop
 * counts; `--json` also writes the report (`recordstuff.pipeline-diagnostics/1`, with the merged histograms). Reads files
 * only; launches nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { APP_LOG_PATH } from "./lib/runner/runner-env.mts";
import { formatSession, parsePipelineLog, summarizeSession } from "./lib/verification/pipeline-report.mts";

const usage = "usage: pnpm diagnose:pipeline -- [<log>…] [--session <id>]… [--last N] [--json <file>]";
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const files: string[] = [];
const wanted: string[] = [];
let last: number | undefined;
let json: string | undefined;
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!;
  if (arg === "--session" && args[index + 1]) wanted.push(args[++index]!);
  else if (arg === "--last" && args[index + 1]) last = Number(args[++index]);
  else if (arg === "--json" && args[index + 1]) json = args[++index];
  else if (arg.startsWith("--")) { console.error(usage); process.exit(2); }
  else files.push(arg);
}
if (last !== undefined && !(Number.isInteger(last) && last > 0)) { console.error(usage); process.exit(2); }
if (files.length === 0) {
  // The archive first: its lines are the older ones.
  const archive = path.join(path.dirname(APP_LOG_PATH), "recordstuff.1.log");
  files.push(...[archive, APP_LOG_PATH].filter((file) => fs.existsSync(file)));
}
const missing = files.filter((file) => !fs.existsSync(file));
if (missing.length) { console.error(`No such log: ${missing.join(", ")}`); process.exit(2); }
const lines = files.flatMap((file) => fs.readFileSync(file, "utf8").split("\n"));
const report = parsePipelineLog(lines);
let sessions = wanted.length ? report.sessions.filter((s) => wanted.includes(s.session)) : report.sessions;
if (last !== undefined) sessions = sessions.slice(-last);
if (sessions.length === 0) {
  console.error(`No diagnostics in ${files.join(", ") || "no log"}: record with RECORDSTUFF_DIAGNOSTICS=1 in the app's environment.`);
  process.exit(1);
}
for (const session of sessions) console.log(formatSession(summarizeSession(session)));
for (const problem of report.problems) console.log(`Not read: ${problem}`);
if (json) {
  fs.writeFileSync(json, `${JSON.stringify({ ...report, sessions: sessions.map((s) => ({ ...s, summary: summarizeSession(s) })) }, null, 2)}\n`);
  console.log(`Report: ${json}`);
}
