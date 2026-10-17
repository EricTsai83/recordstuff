#!/usr/bin/env node
/**
 * `pnpm diagnose:frames -- <file.frames.jsonl>… [--fps 30]`
 *
 * Summarizes the native engine's per-frame log (plan 078): record with `RECORDSTUFF_FRAME_LOG=<folder>` in the app's
 * environment (for example `RECORDSTUFF_FRAME_LOG=/tmp/frames pnpm matrix -- quick`), then point this at the files it
 * wrote. Prints the kept frames' gap histogram and, for every gap of one and a half intervals or more (and half an
 * interval or less), what capture delivered around it and what the pacer decided. Reads files only; launches nothing.
 */
import fs from "node:fs";
import { formatFrameLog, parseFrameLog, summarizeFrameLog } from "./lib/verification/frame-log.mts";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
let fps = 30;
const files: string[] = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!;
  if (arg === "--fps") fps = Number(args[++index]);
  else files.push(arg);
}
if (files.length === 0 || !Number.isFinite(fps) || fps <= 0) {
  console.error("usage: pnpm diagnose:frames -- <file.frames.jsonl>… [--fps 30]");
  process.exit(2);
}
for (const file of files) {
  console.log(`== ${file}`);
  console.log(formatFrameLog(summarizeFrameLog(parseFrameLog(fs.readFileSync(file, "utf8")), fps)));
}
