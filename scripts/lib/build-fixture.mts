/** Compile standalone test entries only; application fixtures use electron-vite. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild } from "vite";

export async function buildFixture(
  name: "settings-panel" | "shortcut-failure" | "release-record-network",
  outputDir: string,
): Promise<string> {
  const source = fileURLToPath(new URL(`../fixtures/${name}.ts`, import.meta.url));
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
