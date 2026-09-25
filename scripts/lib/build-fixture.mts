/** Compile standalone test entries only; application fixtures use electron-vite. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, transformWithEsbuild } from "vite";

export async function buildFixture(
  name: "quit-dialog" | "recording-lifecycle" | "history-quit" | "settings-panel" | "shortcut-failure" | "shortcut-layout"
    | "release-record-network" | "frame-cadence" | "frame-cadence-renderer",
  outputDir: string,
): Promise<string> {
  const source = fileURLToPath(new URL(`../fixtures/${name}.ts`, import.meta.url));
  // A classic script, so the diagnostic page loads it from file:// under the host's CSP.
  if (name === "frame-cadence-renderer") {
    await build({ configFile: false, logLevel: "error", build: {
      outDir: outputDir, emptyOutDir: false, minify: false,
      lib: { entry: source, formats: ["iife"], name: "RecordStuffFrameCadence", fileName: () => `${name}.js` },
    } });
    return path.join(outputDir, `${name}.js`);
  }
  // Settings snapshots use the real model and its pure shared dependencies.
  if (name === "settings-panel" || name === "recording-lifecycle" || name === "history-quit" || name === "quit-dialog" || name === "frame-cadence") {
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
