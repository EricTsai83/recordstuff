/**
 * Verdict and report of `pnpm acceptance:tray` (scripts/acceptance-tray.mts, plan 063).
 * Every case is scripted-input evidence: the OS delivered real clicks and keys
 * and the native menu, log and folder reached the expected state. The
 * screenshots it saves are for a separate visual review, which stays pending
 * here. Pure, so the verdict is unit-tested (tray-acceptance.test.ts).
 */
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
  exitCode: 0 | 1 | 2;
  reasons: string[];
  counts: Record<CaseStatus, number>;
}

/**
 * Cleanup failures and failed cases fail the round; a lock or missing
 * Accessibility access blocks it even when cases passed; a refusal before or
 * during the round fails it. A case that could not reach its state is not run
 * and shown in the counts, never a pass.
 */
export function classifyTrayRound(input: {
  cases: readonly TrayCase[];
  cleanup: readonly string[];
  roundError: string | undefined;
  blocked: string | undefined;
  lockedAt: string | undefined;
  interrupted: boolean;
}): TrayVerdict {
  const counts: Record<CaseStatus, number> = { pass: 0, fail: 0, blocked: 0, "not run": 0 };
  for (const c of input.cases) counts[c.status ?? "not run"] += 1;
  const failed = input.cases.filter(c => c.status === "fail").map(c => `${c.id}${c.language ? ` (${c.language})` : ""}: ${c.problems.join("; ")}`);
  const reasons = [...input.cleanup.map(problem => `cleanup: ${problem}`), ...failed, ...(input.roundError ? [input.roundError.split("\n")[0]!] : [])];
  if (input.cleanup.length || failed.length || input.roundError) return { status: "FAIL", exitCode: 1, reasons, counts };
  if (input.interrupted) return { status: "INTERRUPTED", exitCode: 1, reasons: ["interrupted before every case ran"], counts };
  if (input.lockedAt) return { status: "BLOCKED", exitCode: 2, reasons: [`the screen locked at ${input.lockedAt}`], counts };
  if (input.blocked) return { status: "BLOCKED", exitCode: 2, reasons: [input.blocked], counts };
  if (!input.cases.length) return { status: "FAIL", exitCode: 1, reasons: ["no case ran"], counts };
  return { status: "PASS", exitCode: 0, reasons: [], counts };
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
