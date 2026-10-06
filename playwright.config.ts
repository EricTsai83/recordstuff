import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/ui",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results/ui",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
