import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UI_GROUPS } from "./ui-groups.mts";
import { REPO_ROOT } from "../verification/verify-recording.mts";

/** The background project's specs (playwright.config.ts): every `*.spec.ts` under tests/ui except the drills'. */
function backgroundSpecs(dir = path.join(REPO_ROOT, "tests/ui")): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return backgroundSpecs(full);
    return entry.name.endsWith(".spec.ts") && !["drills.spec.ts", "drill-target.spec.ts"].includes(entry.name)
      ? [path.relative(path.join(REPO_ROOT, "tests/ui"), full).split(path.sep).join("/")]
      : [];
  });
}

describe("CI's background suite groups", () => {
  it("run every background spec exactly once", () => {
    const grouped = Object.values(UI_GROUPS).flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(backgroundSpecs().sort());
  });

  it("name no spec another's name contains, since Playwright matches each as a pattern", () => {
    const specs = backgroundSpecs();
    for (const file of Object.values(UI_GROUPS).flat()) expect(specs.filter((spec) => spec.includes(file))).toEqual([file]);
  });
});
