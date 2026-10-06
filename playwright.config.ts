import { defineConfig } from "@playwright/test";

/**
 * The background UI and integration suite (plan 066, docs/testing.md): hidden offscreen Electron on the production
 * `out/` pages, preloads and main, with no desktop effect. `background` is `pnpm test:ui`; `drills` are the cleanup
 * drills of the hosts themselves (`pnpm test:ui:drills`), some of which fail on purpose and are checked for it.
 * One worker: every launch is isolated by its own folders, but a single executor keeps a slow machine's timing
 * assertions apart from each other.
 */
export default defineConfig({
  testDir: "tests/ui",
  globalSetup: "./tests/ui/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"], ["html", { open: "never" }], ["json", { outputFile: "test-results/ui-report.json" }], ["./tests/ui/summary-reporter.ts"]],
  outputDir: "test-results/ui",
  // Reviewed baselines are named by runtime in the test (settings-matrix.spec.ts), not by project or platform here.
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  // A baseline is written only on request (`--update-snapshots`), after its picture was looked at; never by a plain run.
  updateSnapshots: "none",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "background", testMatch: "**/*.spec.ts", testIgnore: ["**/drills.spec.ts", "**/drill-target.spec.ts"] },
    { name: "drills", testMatch: ["**/drills.spec.ts", "**/drill-target.spec.ts"] },
  ],
});
