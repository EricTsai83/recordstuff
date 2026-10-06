/**
 * Writes test-results/ui-summary.json after a background run (plan 066): the build it tested, every test's outcome
 * with the ledger IDs in its title, and each launch's containment and cleanup as its teardown reported them. A
 * missing build or clip is reported as blocked, a failed case as failed; the run's exit code stays Playwright's.
 */
import fs from "node:fs";
import path from "node:path";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

interface Entry { title: string; file: string; project: string; status: string; expected: string; durationMs: number; ids: string[]; teardown?: unknown }

export default class SummaryReporter implements Reporter {
  private readonly entries: Entry[] = [];
  private readonly started = Date.now();
  onTestEnd(test: TestCase, result: TestResult): void {
    const teardown = result.attachments.find(attachment => attachment.name === "teardown.json")?.body?.toString("utf8");
    this.entries.push({
      title: test.title, file: path.relative(process.cwd(), test.location.file), project: test.parent.project()?.name ?? "", status: result.status,
      expected: test.expectedStatus, durationMs: result.duration, ids: [...test.title.matchAll(/\b[A-Z]{1,2}-?[A-Z]?\d{2,3}[a-z]?\b/g)].map(match => match[0]),
      ...(teardown ? { teardown: JSON.parse(teardown) as unknown } : {}),
    });
  }
  onEnd(result: FullResult): void {
    const outcome = (entry: Entry): string => entry.status === "skipped" ? "skipped" : entry.status === entry.expected ? "pass" : "fail";
    const summary = {
      status: result.status, startedAt: new Date(this.started).toISOString(), wallMs: Date.now() - this.started,
      out: process.env.RECORDSTUFF_UI_OUT_DIGEST ?? "unknown", platform: `${process.platform} ${process.arch}`,
      scope: "Background: hidden offscreen Electron, production out/ pages and preloads; OS effects are adapter calls. No OS input, focus, notification delivery or capture.",
      counts: { pass: this.entries.filter(entry => outcome(entry) === "pass").length, fail: this.entries.filter(entry => outcome(entry) === "fail").length,
        skipped: this.entries.filter(entry => outcome(entry) === "skipped").length },
      tests: this.entries.map(entry => ({ ...entry, outcome: outcome(entry) })),
    };
    fs.mkdirSync("test-results", { recursive: true });
    fs.writeFileSync(path.join("test-results", "ui-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  }
}
