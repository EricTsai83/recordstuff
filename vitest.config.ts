import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src/renderer", import.meta.url)) } },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["src/renderer/testing/vitest-setup.ts"],
    // The Settings page tests drive whole flows through a DOM: 1-3 s each alone, several times that while the rest of
    // the suite (concurrent script spawns included) holds every core, which the default 5 s turned into failures. A
    // test that hangs still fails, later.
    testTimeout: 15_000,
    // `--changed` (pnpm test:changed) selects tests through the import graph; a change to these runs them all.
    forceRerunTriggers: ["**/package.json", "**/pnpm-lock.yaml", "**/vitest.config.ts", "**/tsconfig*.json", "**/src/renderer/testing/**"],
  },
});
