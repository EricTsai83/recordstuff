/** Compile standalone test entries only; application fixtures use electron-vite. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, transformWithEsbuild } from "vite";

export async function buildFixture(
  name: "quit-dialog" | "recording-lifecycle" | "settings-panel" | "shortcut-failure" | "release-record-network",
  outputDir: string,
): Promise<string> {
  const source = fileURLToPath(new URL(`../fixtures/${name}.ts`, import.meta.url));
  // Settings snapshots use the real model and its pure shared dependencies.
  if (name === "settings-panel" || name === "recording-lifecycle" || name === "quit-dialog") {
    await build({ configFile: false, logLevel: "error", build: {
      outDir: outputDir, emptyOutDir: false, minify: false,
      lib: { entry: source, formats: ["es"], fileName: () => `${name}.mjs` },
      rollupOptions: { external: ["electron", /^node:/] },
    } });
    return path.join(outputDir, `${name}.mjs`);
  }
  // The shortcut fixture intercepts CommonJS loading before requiring the app.
  const format = name === "shortcut-failure" ? "cjs" : "esm";
  const result = await transformWithEsbuild(await fs.readFile(source, "utf8"), source, {
    loader: "ts", format, target: "es2023", sourcemap: "inline",
  });
  await fs.mkdir(outputDir, { recursive: true });
  const entry = path.join(outputDir, `${name}.${format === "cjs" ? "cjs" : "mjs"}`);
  await fs.writeFile(entry, result.code);
  return entry;
}
