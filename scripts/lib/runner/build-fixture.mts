/** Compile standalone test entries only; application fixtures use electron-vite. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, transformWithEsbuild } from "vite";

export async function buildFixture(
  name: "quit-dialog" | "recording-lifecycle" | "history-quit" | "settings-native" | "window-drag" | "player-panel" | "ui-preview" | "shortcut-failure" | "shortcut-layout"
    | "release-record-network" | "publication-bench" | "export-bench",
  outputDir: string,
): Promise<string> {
  const source = fileURLToPath(new URL(`../../fixtures/${name}.ts`, import.meta.url));
  // Settings snapshots use the real model and its pure shared dependencies.
  if (name === "window-drag" || name === "settings-native" || name === "player-panel" || name === "ui-preview" || name === "recording-lifecycle" || name === "history-quit" || name === "quit-dialog"
    || name === "publication-bench" || name === "export-bench") {
    await build({ configFile: false, logLevel: "error", build: {
      outDir: outputDir, emptyOutDir: false, minify: false,
      lib: { entry: source, formats: ["es"], fileName: () => `${name}.mjs` },
      rollupOptions: { external: ["electron", /^node:/] },
    } });
    return path.join(outputDir, `${name}.mjs`);
  }
  // The shortcut fixtures intercept CommonJS loading before requiring the app.
  const format = name === "shortcut-failure" || name === "shortcut-layout" ? "cjs" : "esm";
  const result = await transformWithEsbuild(await fs.readFile(source, "utf8"), source, {
    loader: "ts", format, target: "es2023", sourcemap: "inline",
  });
  await fs.mkdir(outputDir, { recursive: true });
  const entry = path.join(outputDir, `${name}.${format === "cjs" ? "cjs" : "mjs"}`);
  await fs.writeFile(entry, result.code);
  return entry;
}
