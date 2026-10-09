import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_SCOPES, resolveSelection, type TestScope } from "./test-scopes.mts";

const root = path.resolve(__dirname, "../../..");
const scopes: TestScope[] = [
  { name: "a", covers: "", unit: ["src/a/", "src/shared.test.ts"], ui: [{ file: "one.spec.ts", tags: ["@a"] }, { file: "two.spec.ts" }] },
  { name: "b", covers: "", unit: ["src/shared.test.ts"], ui: [{ file: "one.spec.ts", tags: ["@b"] }] },
  { name: "c", covers: "", unit: [], ui: [{ file: "one.spec.ts" }] },
];

describe("resolveSelection", () => {
  it("merges scopes without duplicates: a file's tags add up", () => {
    const selection = resolveSelection(["a", "b", "a"], scopes);
    expect(selection.scopes).toEqual(["a", "b", "a"]);
    expect(selection.unit).toEqual(["src/a/", "src/shared.test.ts"]);
    expect(selection.ui).toEqual([{ file: "one.spec.ts", tags: ["@a", "@b"] }, { file: "two.spec.ts" }]);
    expect(selection.grep).toBe("one\\.spec\\.ts.*(?:@a|@b)(?:\\s|$)|two\\.spec\\.ts");
  });

  it("keeps a file whole once any scope or a named spec selects it whole, whatever the order", () => {
    expect(resolveSelection(["a", "c"], scopes).ui[0]).toEqual({ file: "one.spec.ts" });
    expect(resolveSelection(["c", "b"], scopes).ui[0]).toEqual({ file: "one.spec.ts" });
    expect(resolveSelection(["b", "tests/ui/one.spec.ts"], scopes).ui).toEqual([{ file: "one.spec.ts" }]);
  });

  it("takes test files by path and refuses what names nothing, never widening to a full suite", () => {
    expect(resolveSelection(["src/x.test.ts"], scopes)).toEqual({ scopes: [], unit: ["src/x.test.ts"], ui: [] });
    expect(() => resolveSelection([], scopes)).toThrow(/at least one/);
    expect(() => resolveSelection(["genral"], scopes)).toThrow(/Unknown scope or test file "genral"; known scopes: a, b, c/);
    expect(() => resolveSelection(["src/gone.test.ts"], scopes, () => false)).toThrow(/does not exist/);
    expect(() => resolveSelection(["tests/ui/gone.spec.ts"], scopes, () => false)).toThrow(/does not exist/);
  });

  it("matches a tag only whole, so @general never selects @general-anything", () => {
    const grep = new RegExp(resolveSelection(["b"], scopes).grep!);
    expect(grep.test("background one.spec.ts a case @b")).toBe(true);
    expect(grep.test("background one.spec.ts a case @b @layout")).toBe(true);
    expect(grep.test("background one.spec.ts a case @bb")).toBe(false);
    expect(grep.test("background three.spec.ts a case @b")).toBe(false);
  });
});

describe("the scope catalog", () => {
  const specs = fs.readdirSync(path.join(root, "tests/ui")).filter(file => file.endsWith(".spec.ts"));
  const testFiles = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? entry.name === "node_modules" ? [] : testFiles(`${dir}/${entry.name}`)
      : /\.test\.m?ts$/.test(entry.name) ? [`${dir}/${entry.name}`] : []);
  const units = [...testFiles("src"), ...testFiles("scripts"), ...testFiles("tests")];

  it("names unique scopes whose unit filters each match a test file", () => {
    expect(new Set(TEST_SCOPES.map(scope => scope.name)).size).toBe(TEST_SCOPES.length);
    for (const scope of TEST_SCOPES) for (const filter of scope.unit)
      expect(units.some(file => file.includes(filter)), `${scope.name}: ${filter}`).toBe(true);
  });

  it("selects background specs that exist, by tags their cases carry", () => {
    for (const scope of TEST_SCOPES) for (const { file, tags } of scope.ui) {
      expect(specs, `${scope.name}: ${file}`).toContain(file);
      const source = fs.readFileSync(path.join(root, "tests/ui", file), "utf8");
      for (const tag of tags ?? []) expect(source.includes(`"${tag}"`), `${scope.name}: ${file} has no case tagged ${tag}`).toBe(true);
    }
  });

  it("leaves no background spec outside every scope, so a full suite's files are all reachable by name", () => {
    const reached = new Set(TEST_SCOPES.flatMap(scope => scope.ui.map(({ file }) => file)));
    // The drills check the hosts' own cleanup (`pnpm test:ui:drills`), not app behaviour.
    expect(specs.filter(file => !reached.has(file) && !file.startsWith("drill"))).toEqual([]);
  });
});
