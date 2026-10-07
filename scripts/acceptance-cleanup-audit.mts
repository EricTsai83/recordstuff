import fs from "node:fs";
import { auditToolCleanup } from "./lib/runner/tool-cleanup-audit.mts";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
if (args.includes("--help")) {
  console.log("Usage: pnpm acceptance:cleanup-audit [--owned-pid PID ...] [--output report.json]\nRead-only: checks known Software Cursor windows and supplied owned PIDs, including zombies.\nExit 0: audited scope clear; 1: remnants; 2: inspection unavailable/invalid arguments. No tools or apps are terminated.");
  process.exit(0);
}
const ownedPids: number[] = [];
let output: string | undefined;
try {
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[++index];
    if (flag === "--owned-pid" && value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0) {
      ownedPids.push(Number(value));
    } else if (flag === "--output" && value && !value.startsWith("--")) {
      output = value;
    } else throw new Error(`Invalid argument: ${flag}`);
  }
  const report = { time: new Date().toISOString(), requestedOwnedPids: [...new Set(ownedPids)], ...auditToolCleanup(ownedPids) };
  const json = JSON.stringify(report, null, 2);
  if (output) fs.writeFileSync(output, `${json}\n`, { flag: "wx" });
  console.log(json);
  process.exitCode = report.status === "pass" ? 0 : 1;
} catch (cause) {
  console.error(JSON.stringify({ status: "blocked", error: cause instanceof Error ? cause.message : String(cause) }));
  process.exitCode = 2;
}
