/**
 * The renderer's style layers (plan 069): a colour is written once, as a token in ui.css, and a feature stylesheet does
 * not reach into a primitive with a `[data-slot=…]` selector (a change to a primitive is a variant or prop of it, or
 * utilities at its call site). The countdown overlay keeps its own stylesheet outside shadcn by design.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/renderer");
const EXEMPT = new Set(["countdown/countdown.css"]);
/** Literal colours shadcn itself writes in a primitive, kept so the primitive stays comparable with upstream. */
const UPSTREAM = new Map([
  ["components/ui/dialog.tsx", ["bg-black/80"]],
  ["components/ui/slider.tsx", ["bg-white"]],
]);
const NAMED =
  "white|black|red|green|blue|gray|grey|silver|maroon|purple|fuchsia|lime|olive|yellow|navy|teal|aqua|orange|pink|brown|cyan|magenta|gold|indigo|violet";
const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const CSS_COLOUR = new RegExp(
  `#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(|\\b(?:${NAMED})\\b`,
  "i",
);
const UTILITY_COLOUR = new RegExp(
  `(?<![\\w-])(?:[\\w-]+:)*(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|fill|stroke|from|via|to|shadow|decoration|accent|caret|divide|placeholder)-(?:(?:white|black)(?:/\\d+)?|(?:${PALETTE})-\\d{2,3}(?:/\\d+)?|\\[(?:#[^\\]]*|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\([^\\]]*|${NAMED})\\])(?![\\w-])`,
  "g",
);
/** A colour in a string: a hex value or a colour function anywhere, or a named colour as a style property's value. */
const SOURCE_COLOUR = new RegExp(
  `["'\`][^"'\`\\n]*(?:#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\()[^"'\`\\n]*["'\`]|\\b[\\w-]+["']?\\s*[:,]\\s*["'\`](?:${NAMED})["'\`]`,
  "i",
);

interface StyleFile {
  /** Path relative to src/renderer, with forward slashes. */
  path: string;
  text: string;
}

/** The declarations outside the token blocks: top-level `:root`, `.dark` and `@theme` blocks may write colours. */
function declarations(css: string): string[] {
  let text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const kept: string[] = [];
  let depth = 0,
    start = 0,
    skip = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      if (depth === 0) {
        const prelude = text.slice(start, index).trim();
        skip = /^(?::root|\.dark|@theme(?:\s+inline)?)$/.test(prelude);
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        if (!skip) kept.push(text.slice(start, index + 1));
        start = index + 1;
      }
    } else if (char === ";" && depth === 0) start = index + 1;
  }
  text = kept.join("\n");
  const found: string[] = [];
  for (const block of text.matchAll(/\{([^{}]*)\}/g))
    for (const part of block[1]!.split(";")) {
      const declaration = /^\s*([\w-]+)\s*:([\s\S]*)$/.exec(part);
      if (declaration) found.push(`${declaration[1]}:${declaration[2]!.trim()}`);
    }
  return found;
}

function styleViolations(files: StyleFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (EXEMPT.has(file.path)) continue;
    if (file.path.endsWith(".css")) {
      for (const declaration of declarations(file.text))
        // A custom property's name is not a colour, even one named --outcome-red.
        if (CSS_COLOUR.test(declaration.slice(declaration.indexOf(":") + 1).replace(/--[\w-]+/g, "")))
          problems.push(`${file.path}: hard-coded colour in "${declaration}"; add a token to ui.css`);
      const uncommented = file.text.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of uncommented.matchAll(/\[data-slot[^\]]*\]/g))
        problems.push(`${file.path}: ${match[0]} reaches into a primitive; use a variant, prop or call-site utilities`);
    } else {
      const allowed = UPSTREAM.get(file.path) ?? [];
      for (const match of file.text.matchAll(UTILITY_COLOUR)) {
        const utility = match[0].split(":").at(-1)!;
        if (!allowed.includes(utility))
          problems.push(`${file.path}: hard-coded colour utility ${match[0]}; use a token`);
      }
      for (const line of file.text.split("\n"))
        if (SOURCE_COLOUR.test(line))
          problems.push(`${file.path}: hard-coded colour in ${line.trim()}; use a token`);
    }
  }
  return problems;
}

function rendererFiles(directory = RENDERER): StyleFile[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return rendererFiles(full);
    if (!/\.(css|tsx?)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [{ path: path.relative(RENDERER, full).split(path.sep).join("/"), text: fs.readFileSync(full, "utf8") }];
  });
}

describe("renderer style layers", () => {
  it("writes colours only as tokens and keeps feature stylesheets out of the primitives", () => {
    expect(styleViolations(rendererFiles())).toEqual([]);
  });

  it("catches a planted colour and a planted [data-slot] selector", () => {
    const css = ":root { --x: #fff; }\n@layer components { .a { color: #ef4444; } .b [data-slot=\"card\"] { gap: 0; } .c { background: white; } }";
    expect(styleViolations([{ path: "ui.css", text: css }])).toEqual([
      'ui.css: hard-coded colour in "color:#ef4444"; add a token to ui.css',
      'ui.css: hard-coded colour in "background:white"; add a token to ui.css',
      'ui.css: [data-slot="card"] reaches into a primitive; use a variant, prop or call-site utilities',
    ]);
    const tsx = 'const a = <div className="bg-red-500 hover:text-white/60 bg-[#000] text-media-foreground" style={{ color: "#123456" }} />;';
    expect(styleViolations([{ path: "settings/x.tsx", text: tsx }])).toEqual([
      "settings/x.tsx: hard-coded colour utility bg-red-500; use a token",
      "settings/x.tsx: hard-coded colour utility hover:text-white/60; use a token",
      "settings/x.tsx: hard-coded colour utility bg-[#000]; use a token",
      `settings/x.tsx: hard-coded colour in ${tsx}; use a token`,
    ]);
    const inline = [
      'const b = <div style={{ color: "rgb(255, 0, 0)" }} />;',
      "const c = <div style={{ background: 'white' }} />;",
      'element.style.setProperty("--x", "oklch(0.5 0.1 20)");',
      'const d = <div className="bg-[white]" />;',
    ];
    expect(styleViolations(inline.map((text, index) => ({ path: `settings/i${index}.tsx`, text })))).toEqual([
      `settings/i0.tsx: hard-coded colour in ${inline[0]}; use a token`,
      `settings/i1.tsx: hard-coded colour in ${inline[1]}; use a token`,
      `settings/i2.tsx: hard-coded colour in ${inline[2]}; use a token`,
      "settings/i3.tsx: hard-coded colour utility bg-[white]; use a token",
    ]);
    expect(styleViolations([{ path: "settings/ok.tsx", text: 'const e = { background: "transparent", label: "White balance" };' }])).toEqual([]);
    expect(styleViolations([{ path: "countdown/countdown.css", text: ".a { color: #fff; }" }])).toEqual([]);
    expect(styleViolations([{ path: "ui.css", text: "@layer components { .a { color: var(--outcome-red); } }" }])).toEqual([]);
    expect(styleViolations([{ path: "components/ui/slider.tsx", text: '"bg-white"' }])).toEqual([]);
  });
});
