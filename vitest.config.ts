import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src/renderer", import.meta.url)) } },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["src/renderer/testing/vitest-setup.ts"],
    // `--changed` (pnpm test:changed) selects tests through the import graph; a change to these runs them all.
    forceRerunTriggers: ["**/package.json", "**/pnpm-lock.yaml", "**/vitest.config.ts", "**/tsconfig*.json", "**/src/renderer/testing/**"],
  },
});
