#!/usr/bin/env node
/**
 * `node scripts/ui-close-timings.mts [file] [--top 10]`
 *
 * The background suite's close timings (plan 078 step 5): every launch's teardown appends its phases to
 * `test-results/ui-close-timings.jsonl` (tests/ui/fixtures.ts), and this prints how the normal closes are spread
 * (median, 95th percentile, slowest) and the slowest launches with each phase, so a Windows shard whose close timed
 * out shows whether its closes were slow throughout or one stalled. check.yml runs it after every UI shard. Reads one
 * file; launches nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { formatCloseTimings, parseCloseTimings } from "./lib/verification/ui-close-timings.mts";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const topAt = args.indexOf("--top");
const top = topAt >= 0 ? Number(args.splice(topAt, 2)[1]) : 10;
const file = args[0] ?? path.join(process.cwd(), "test-results", "ui-close-timings.jsonl");
if (!fs.existsSync(file)) {
  console.log(`no close timings at ${file}`);
  process.exit(0);
}
console.log(formatCloseTimings(parseCloseTimings(fs.readFileSync(file, "utf8")), Number.isFinite(top) && top > 0 ? top : 10));
