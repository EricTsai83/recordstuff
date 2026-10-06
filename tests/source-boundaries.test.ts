/**
 * Module boundaries in `src/` and `scripts/` (docs/system-design/repository.md#module-boundaries).
 * The TypeScript configs keep each process to its own APIs; this keeps the folders inside a
 * process, and the developer tools beside them, pointing one way, so a folder's imports say
 * where it sits. A new folder must be placed in `ALLOWED` before anything in it can import.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(".");
const SRC = path.join(ROOT, "src");
const SCRIPTS = path.join(ROOT, "scripts");
const MAIN_FEATURES = ["main/recording", "main/display", "main/permission", "main/library", "main/shortcuts"];
const RENDERER_SHARED = ["renderer/player", "renderer/components", "renderer/lib", "shared"];
/** Stands for every area under `src/`: the developer tools may load any of it, and nothing in `src/` loads them. */
const ANY_SRC = "src";

/** What production code in each area may import besides itself. */
const ALLOWED: Record<string, readonly string[]> = {
  shared: [],
  preload: ["shared"],
  "main/lib": ["shared"],
  ...Object.fromEntries(MAIN_FEATURES.map((feature) => [feature, ["main/lib", "shared"]])),
  "main/app": [...MAIN_FEATURES, "main/lib", "shared"],
  "main/settings": ["main/app", ...MAIN_FEATURES, "main/lib", "shared"],
  "main/menus": ["main/settings", "main/app", ...MAIN_FEATURES, "main/lib", "shared"],
  "main/actions": ["main/menus", "main/settings", "main/app", ...MAIN_FEATURES, "main/lib", "shared"],
  "main/index.ts": ["main/actions", "main/menus", "main/settings", "main/app", ...MAIN_FEATURES, "main/lib", "shared"],
  "renderer/lib": ["shared"],
  "renderer/components": ["renderer/lib"],
  "renderer/player": ["renderer/components", "renderer/lib", "shared"],
  "renderer/capture": RENDERER_SHARED,
  "renderer/countdown": RENDERER_SHARED,
  "renderer/settings": RENDERER_SHARED,
  "renderer/video": RENDERER_SHARED,
  "renderer/testing": [],
  "scripts/lib/runner": [ANY_SRC],
  "scripts/lib/release": [ANY_SRC],
  "scripts/lib/verification": ["scripts/lib/runner", "scripts/lib/release", ANY_SRC],
  "scripts/lib/audio": ["scripts/lib/verification", "scripts/lib/runner", ANY_SRC],
  "scripts/lib/acceptance": ["scripts/lib/verification", "scripts/lib/runner", "scripts/fixtures", ANY_SRC],
  "scripts/fixtures": ["scripts/lib/acceptance", "scripts/lib/verification", "scripts/lib/runner", ANY_SRC],
  scripts: ["scripts/fixtures", "scripts/lib/acceptance", "scripts/lib/verification", "scripts/lib/audio", "scripts/lib/runner", "scripts/lib/release", ANY_SRC],
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(tsx?|mts|mjs)$/.test(entry.name) ? [full] : [];
  });
}

/** `main/recording`, `main/index.ts`, `renderer/settings`, `shared`, `scripts/lib/runner`, `scripts` (an entry point)… */
function areaOf(file: string): string {
  if (file.startsWith(SCRIPTS + path.sep)) {
    const [first, second] = path.relative(SCRIPTS, file).split(path.sep);
    if (second === undefined) return "scripts";
    return first === "lib" ? `scripts/lib/${second.replace(/\.[^.]+$/, "")}` : `scripts/${first}`;
  }
  const [process, child] = path.relative(SRC, file).split(path.sep);
  return process === "main" || process === "renderer" ? `${process}/${child}` : process!;
}
const inSrc = (file: string): boolean => file.startsWith(SRC + path.sep);
const may = (from: string, to: string, target: string): boolean =>
  to === from || Boolean(ALLOWED[from]?.includes(to)) || (inSrc(target) && Boolean(ALLOWED[from]?.includes(ANY_SRC)));

function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const specifiers = [...text.matchAll(/^\s*(?:import|export)\b[^"'`]*?(?:\bfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gm)]
    .map((m) => (m[1] ?? m[2])!);
  return specifiers.flatMap((specifier) => {
    if (specifier.startsWith("@/")) return [path.join(SRC, "renderer", specifier.slice(2))];
    if (specifier.startsWith(".")) return [path.resolve(path.dirname(file), specifier)];
    return [];
  }).filter((target) => inSrc(target) || target.startsWith(SCRIPTS + path.sep));
}

const files = [...sourceFiles(SRC), ...sourceFiles(SCRIPTS)];
const isTest = (file: string): boolean => /\.test\.(tsx?|mts)$/.test(file);
const shown = (file: string): string => path.relative(ROOT, file);

describe("source boundaries", () => {
  it("places every source file in a known area", () => {
    const unknown = files.filter((file) => !(areaOf(file) in ALLOWED)).map(shown);
    expect(unknown).toEqual([]);
  });

  it("imports only from the areas each area may use", () => {
    const violations: string[] = [];
    for (const file of files.filter((f) => !isTest(f))) {
      const from = areaOf(file);
      for (const target of importsOf(file)) {
        if (!may(from, areaOf(target), target)) violations.push(`${shown(file)} → ${shown(target)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the composition root, the renderer test helpers and the developer tools out of other modules", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const target of importsOf(file)) {
        const to = areaOf(target);
        if (to === "main/index.ts" || (to === "renderer/testing" && !isTest(file)) || (inSrc(file) && !inSrc(target)))
          violations.push(`${shown(file)} → ${shown(target)}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
