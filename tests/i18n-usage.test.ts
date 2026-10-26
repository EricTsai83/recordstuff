/**
 * The language catalog holds only messages something still shows: every message is written out where it is used
 * (`translate("…")`), so one no source names any more is dead weight to translate and review. The acceptance scripts
 * count, since they find the app's text by its message.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { ZH_TW } from "../src/shared/i18n";

const ROOT = path.resolve(".");
const CATALOG = path.join(ROOT, "src", "shared", "i18n.ts");

function sources(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((file) => /\.(tsx?|mts)$/.test(file) && !/\.test\.(tsx?|mts)$/.test(file))
    .map((file) => path.join(dir, file))
    .filter((file) => file !== CATALOG);
}

it("holds only messages the app or its acceptance scripts still use", () => {
  const text = [...sources(path.join(ROOT, "src")), ...sources(path.join(ROOT, "scripts"))].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const unused = Object.keys(ZH_TW).filter((key) => ![JSON.stringify(key), `'${key}'`, `\`${key}\``].some((literal) => text.includes(literal)));
  expect(unused).toEqual([]);
});
