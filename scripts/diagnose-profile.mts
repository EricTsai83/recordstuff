#!/usr/bin/env node
/**
 * `pnpm diagnose:profile -- <measurement dir>… [--role utility-node] [--json <file>]`
 *
 * Where a process's CPU goes (plan 091), from the `sample` call graphs `pnpm measure:cpu -- --profile` writes beside
 * its report (`profile-<n>-<window>-<role>-<pid>.txt`). For each window (`R30`, `R60`, `S30`, `L30`, …) the graphs of
 * the chosen role, by default the capture process, are merged and shared out by cause, thread or queue and library
 * (scripts/lib/verification/sample-profile.mts); each share is also given in milliseconds of CPU a second, scaled by
 * that process's average CPU in the same recording, which the report's `recordings` hold by pid (`recordingCpu`: left
 * unscaled for a Live preview and for a process that outlives one recording, such as main). Several directories
 * of one workload merge, so three single runs read as one. Reads files only; launches nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { attribute, formatAttribution, parseCallGraph, recordingCpu, type CallNode, type ReportRecording } from "./lib/verification/sample-profile.mts";

const usage = "usage: pnpm diagnose:profile -- <measurement dir>… [--role utility-node] [--json <file>]";
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const dirs: string[] = [];
let role = "utility-node";
let json: string | undefined;
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!;
  if (arg === "--role" && args[index + 1]) role = args[++index]!;
  else if (arg === "--json" && args[index + 1]) json = args[++index];
  else if (arg.startsWith("--")) { console.error(usage); process.exit(2); }
  else dirs.push(arg);
}
if (dirs.length === 0) { console.error(usage); process.exit(2); }

/** The recordings a report holds, or none without one. */
function reportRecordings(dir: string): ReportRecording[] {
  const file = path.join(dir, "report.json");
  if (!fs.existsSync(file)) return [];
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { recordings?: ReportRecording[] }).recordings ?? [];
}

const windows = new Map<string, { graphs: CallNode[][]; cpu: number[]; files: string[] }>();
for (const dir of dirs) {
  if (!fs.existsSync(dir)) { console.error(`No such directory: ${dir}`); process.exit(2); }
  const recordings = reportRecordings(dir);
  for (const name of fs.readdirSync(dir).sort()) {
    const match = /^profile-\d+-([A-Z]+\d+)-(.+)-(\d+)\.txt$/.exec(name);
    if (!match || match[2] !== role) continue;
    const window = windows.get(match[1]!) ?? { graphs: [], cpu: [], files: [] };
    window.graphs.push(parseCallGraph(fs.readFileSync(path.join(dir, name), "utf8")));
    const measured = recordingCpu(recordings, match[1]!, Number(match[3]));
    if (measured !== undefined) window.cpu.push(measured);
    window.files.push(path.join(dir, name));
    windows.set(match[1]!, window);
  }
}
if (windows.size === 0) { console.error(`No ${role} profiles in ${dirs.join(", ")}: record with \`pnpm measure:cpu -- --profile\`.`); process.exit(1); }
const results = [...windows].map(([window, { graphs, cpu, files }]) => {
  // Scaled only when every graph's process was found: a mean over part of them would misstate the rest.
  const cpuPercent = cpu.length === graphs.length ? cpu.reduce((sum, value) => sum + value, 0) / cpu.length : undefined;
  return { window, files, cpuPercent, attribution: attribute(graphs) };
});
for (const { window, files, cpuPercent, attribution } of results) {
  console.log(formatAttribution(`${window}, ${role}, ${files.length} profile(s)`, attribution, cpuPercent));
}
if (json) {
  fs.writeFileSync(json, `${JSON.stringify({ role, windows: results }, null, 2)}\n`);
  console.log(`Report: ${json}`);
}
