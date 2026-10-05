/**
 * Verdict and report of `pnpm acceptance:tray` (scripts/acceptance-tray.mts, plan 063).
 * Every case is scripted-input evidence: the OS delivered real clicks and keys
 * and the native menu, log and folder reached the expected state. The
 * screenshots it saves are for a separate visual review, which stays pending
 * here. Pure, so the verdict is unit-tested (tray-acceptance.test.ts).
 */
import { createHash } from "node:crypto";
import type { INTERRUPT_EXIT } from "./processes.mts";
import { roundExit, type RoundOutcome } from "./round-exit.mts";

/**
 * The HTML id of a Recordings card's Play button (settings.ts `clip-<id>-open`), whose id is the library's
 * `fileId` of the file's path (recordings-library.ts): unique per recording, unlike its title. The runner
 * cannot import the main-process module, so the derivation is repeated here and a test keeps the two equal.
 */
export function recordingCardOpenId(filePath: string): string {
  return `clip-${createHash("sha256").update(filePath).digest("hex").slice(0, 20)}-open`;
}

export type CaseStatus = "pass" | "fail" | "blocked" | "not run";

export interface TrayCase {
  id: string;
  title: string;
  language: string | undefined;
  status: CaseStatus | undefined;
  evidence: "scripted input";
  problems: string[];
  details: string[];
  screenshots: string[];
}

export interface TrayVerdict {
  status: "PASS" | "FAIL" | "BLOCKED" | "INTERRUPTED";
  exitCode: number;
  reasons: string[];
  counts: Record<CaseStatus, number>;
}

const STATUS: Record<RoundOutcome, TrayVerdict["status"]> = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED", interrupted: "INTERRUPTED" };

/**
 * The round's exit in the order the desktop runners share (round-exit.mts): a cleanup problem fails it; an
 * interrupt that left nothing exits 130/143 and a lock blocks it, even after a failed case, which the lock may
 * have caused; then a failed case, a refusal or a round where no case ran fails it, and missing Accessibility
 * access blocks it. A case that could not reach its state is not run and shown in the counts, never a pass.
 */
export function classifyTrayRound(input: {
  cases: readonly TrayCase[];
  cleanup: readonly string[];
  roundError: string | undefined;
  blocked: string | undefined;
  lockedAt: string | undefined;
  interrupted: keyof typeof INTERRUPT_EXIT | undefined;
}): TrayVerdict {
  const counts: Record<CaseStatus, number> = { pass: 0, fail: 0, blocked: 0, "not run": 0 };
  for (const c of input.cases) counts[c.status ?? "not run"] += 1;
  const failed = input.cases.filter(c => c.status === "fail").map(c => `${c.id}${c.language ? ` (${c.language})` : ""}: ${c.problems.join("; ")}`);
  const failures = [...failed, ...(input.roundError ? [input.roundError.split("\n")[0]!] : [])];
  const noCase = !input.cases.length && !input.blocked;
  const { outcome, code } = roundExit({
    cleanupIncomplete: input.cleanup.length > 0, interrupted: input.interrupted, locked: input.lockedAt !== undefined,
    failed: failures.length > 0 || noCase, blocked: input.blocked !== undefined,
  });
  const reasons = outcome === "fail" ? [...input.cleanup.map(problem => `cleanup: ${problem}`), ...failures, ...(noCase && !failures.length && !input.cleanup.length ? ["no case ran"] : [])]
    : outcome === "interrupted" ? [`interrupted by ${input.interrupted} before every case ran`, ...failures]
    : outcome === "blocked" ? [input.lockedAt ? `the screen locked at ${input.lockedAt}` : input.blocked!, ...failures]
    : [];
  return { status: STATUS[outcome], exitCode: code, reasons, counts };
}

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

export function renderTrayReport(input: {
  verdict: TrayVerdict;
  cases: readonly TrayCase[];
  cleanup: readonly string[];
  notes: readonly string[];
  recordings: readonly string[];
  roundError: string | undefined;
  blocked: string | undefined;
  desktop: string | undefined;
  bundle: string;
  interrupted: string | undefined;
}): string {
  const { verdict } = input;
  const shots = input.cases.flatMap(c => c.screenshots);
  return [
    `# Tray acceptance — ${verdict.status}`,
    "",
    `Scripted native input (\`pnpm acceptance:tray\`) against \`${input.bundle}\`: CoreGraphics clicks and keys and Accessibility presses on the real status item and menu, judged from the native menu, the app log and the output folder. ${verdict.counts.pass} pass, ${verdict.counts.fail} fail, ${verdict.counts.blocked} blocked, ${verdict.counts["not run"]} not run.${verdict.reasons.length ? ` Reasons: ${verdict.reasons.join("; ")}.` : ""}`,
    "",
    "| Case | Language | Status | Evidence | Details |",
    "| --- | --- | --- | --- | --- |",
    ...input.cases.map(c => `| ${cell(`${c.id}: ${c.title}`)} | ${c.language ?? "—"} | ${(c.status ?? "not run").toUpperCase()} | ${c.evidence} | ${cell([...c.problems, ...c.details].join("; "))} |`),
    "",
    `Visual review: **pending**. Appearance (light and dark menu bar), alignment and legibility are not judged by this runner; review ${shots.length ? shots.map(shot => `[${shot}](${shot})`).join(", ") : "the menus (no screenshot was saved)"} by Computer Use observation or by the maintainer and label that evidence separately.`,
    "",
    `Recordings this round saved (kept): ${input.recordings.length ? input.recordings.map(file => `\`${file}\``).join(", ") : "none"}. They record the current display without the test material; media checks are not part of this runner.`,
    "",
    `Cleanup: ${input.cleanup.length ? input.cleanup.join("; ") : input.cases.length ? "menus closed, the round's Settings window closed, the stored language and icon click restored when they were changed, and the app quit with no process left" : "nothing to clean up: the round took over no app"}.`,
    ...(input.desktop ? ["", input.desktop] : []),
    ...(input.interrupted ? ["", `Interrupted by ${input.interrupted}.`] : []),
    ...(input.blocked ? ["", `Blocked: ${input.blocked}`] : []),
    ...(input.roundError ? ["", "```text", input.roundError, "```"] : []),
    "",
    "## Notes",
    "",
    ...input.notes.map(note => `- ${note}`),
    "",
    "Details: [result.json](result.json), [app.log](app.log).",
    "",
  ].join("\n");
}
