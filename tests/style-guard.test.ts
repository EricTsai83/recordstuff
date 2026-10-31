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

/**
 * Sizes on one scale (plan 102): a margin, padding, gap or offset, a font size, a corner and a small even size are
 * `--spacing(n)`, `var(--text-*)` and `var(--radius-*)` in ui.css and the scale's names in TSX, never a pixel value.
 * Allowed as pixels: 1px hairlines, a size that is odd (a glyph's) or past 48px (a floor or a cap), a corner smaller
 * than --radius-xs (a tiny element's shape), values inside calc() or a custom property, and the geometry below.
 */
const SPACE_PROPS = new Set(["margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "margin-inline", "margin-block",
  "margin-inline-start", "margin-inline-end", "margin-block-start", "margin-block-end", "padding", "padding-top", "padding-right",
  "padding-bottom", "padding-left", "padding-inline", "padding-block", "padding-inline-start", "padding-inline-end",
  "padding-block-start", "padding-block-end", "gap", "row-gap", "column-gap", "inset", "top", "right", "bottom", "left",
  "inset-inline", "inset-block", "inset-inline-start", "inset-inline-end", "inset-block-start", "inset-block-end"]);
const SIZE_PROPS = new Set(["width", "height", "min-width", "min-height", "max-width", "max-height", "flex-basis"]);
/**
 * Rules whose pixels are geometry rather than spacing, type or a corner, kept by design (plan 102), each selector
 * named whole: the selected sidebar tab's bar, the shortcut capture's three bars, dots set over a corner, a card's
 * focus offset and its scrubber, Share…'s drawn files and their marks, the timeline's measured geometry, the
 * player's glyphs, the brand beside the macOS window buttons, the info popup's arrow and a separator starting under
 * its row's mark.
 */
const GEOMETRY = new Set([
  '[data-variant="sidebar"] [role="tab"][aria-selected="true"]::before',
  ".listening-indicator", ".listening-indicator span",
  ".notice-dot", ".result-unread",
  ".clip::after", ".clip-scrub", ".clip-scrub-knob",
  ".share-icon", ".share-doc", ".share-doc-extension", ".share-folder", ".share-mark", ".share-mark > svg", ".share-mark-progress::after",
  ".editor-timeline", ".editor-ruler", ".editor-ruler span", ".editor-ruler-playhead", ".editor-split-mark", ".editor-playhead",
  ".editor-note-mark", ".editor-trimmer > .editor-playhead", ".editor-progress", ".editor-camera-handle::before",
  ".pc-seek-arrow svg", ".pc-spinner > span",
  ':root[data-platform="darwin"] .brand',
  '.info-popup[data-side="top"]::after', '.info-popup[data-side="bottom"]::after',
  ".recording-result + .recording-result::before",
]);
/** Nested corners: an inner control's corner plus the padding around it. */
const NESTED_RADII = new Set([".segments", ".share-panel", 'main[data-sidebar="collapsed"] .sidebar-about']);
/** Tailwind's spacing, size, type and corner utilities with an arbitrary pixel value, a type hint (`length:`) included. */
const UTILITY_PIXELS =
  /(?<![\w-])((?:[\w-]+:)*)(-?(?:gap(?:-[xy])?|p[xytrblse]?|m[xytrblse]?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end|size|w|h|min-[wh]|max-[wh]|basis|text|leading|rounded(?:-[trblse]{1,2})?)-\[(?:[a-z-]+:)?-?\d+(?:\.\d+)?px\])(?![\w-])/gi;
/** A primitive's own geometry, kept so it stays comparable with upstream or with its nested corner. */
const PIXEL_UPSTREAM = new Map([
  ["components/ui/slider.tsx", ["h-[3px]", "size-[13px]"]],
  ["components/ui/tooltip.tsx", ["rounded-[2px]"]],
  ["components/ui/toggle.tsx", ["rounded-[7px]"]],
  ["components/ui/tabs.tsx", ["w-[3px]", "bottom-[-5px]"]],
  ["settings/settings-app.tsx", ["rounded-[14px]"]],
]);

/** A corner: the shorthand and its physical and logical longhands. */
const RADIUS_PROPS = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/;

/** A value's top-level components, split at spaces and `/` outside parentheses. */
function topLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0, current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth === 0 && (/\s/.test(char) || char === "/")) {
      if (current) parts.push(current);
      current = "";
    } else current += char;
  }
  if (current) parts.push(current);
  return parts.filter((part) => !part.includes("("));
}

/** A selector list's members, split at its top-level commas (not those inside `:is(…)` or an attribute). */
function selectorList(selector: string): string[] {
  const members: string[] = [];
  let depth = 0, start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      members.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  members.push(selector.slice(start).trim());
  return members;
}

/** Each declaration outside the token blocks with the selector of its rule; a block's last declaration needs no `;`. */
function rules(css: string): { selector: string; property: string; value: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack: string[] = [];
  const found: { selector: string; property: string; value: string }[] = [];
  let buffer = "";
  const flush = (): void => {
    const declaration = /^\s*([\w-]+)\s*:([\s\S]*)$/.exec(buffer);
    buffer = "";
    if (!declaration || !stack.length || /^(?::root|\.dark|@theme(?:\s+inline)?)$/.test(stack[0]!)) return;
    const selector = [...stack].reverse().find((prelude) => !prelude.startsWith("@")) ?? "";
    found.push({ selector, property: declaration[1]!.toLowerCase(), value: declaration[2]!.trim() });
  };
  for (const char of text) {
    if (char === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (char === "}") {
      flush();
      stack.pop();
    } else if (char === ";") flush();
    else buffer += char;
  }
  return found;
}

function pixelViolations(files: StyleFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (EXEMPT.has(file.path)) continue;
    if (file.path.endsWith(".css")) {
      for (const { selector, property, value } of rules(file.text)) {
        // Each top-level component of the value: a pixel inside a function (calc(), var(), min()) is not one.
        const parts = topLevel(value.replace(/\s*!important$/i, "").toLowerCase());
        const pixels = parts.filter((part) => /^-?\d+(?:\.\d+)?px$/.test(part)).map((part) => Math.abs(Number.parseFloat(part)));
        if (!pixels.length) continue;
        const members = selectorList(selector);
        const off = SPACE_PROPS.has(property) ? pixels.some((px) => px !== 1)
          : SIZE_PROPS.has(property) ? pixels.some((px) => px % 2 === 0 && px >= 2 && px <= 48)
            : property === "font-size" ? true
              : RADIUS_PROPS.test(property) ? pixels.some((px) => px >= 6 && px < 999) && !members.every((member) => NESTED_RADII.has(member))
                : false;
        // Exempt only when every selector of the list is listed geometry.
        if (off && !members.every((member) => GEOMETRY.has(member)))
          problems.push(`${file.path}: ${selector} { ${property}: ${value} } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)`);
      }
    } else {
      const allowed = PIXEL_UPSTREAM.get(file.path) ?? [];
      for (const match of file.text.matchAll(UTILITY_PIXELS))
        if (!allowed.includes(match[2]!)) problems.push(`${file.path}: ${match[0]} is a pixel value; use the scale's name`);
    }
  }
  return problems;
}

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

  it("writes margins, paddings, gaps, font sizes, corners and small sizes on the token scale (plan 102)", () => {
    expect(pixelViolations(rendererFiles())).toEqual([]);
  });

  it("catches a planted pixel value and leaves hairlines, floors, glyphs, calc() and geometry alone", () => {
    const css = [
      ":root { --gap: 6px; }",
      "@layer components {",
      ".a { gap: 6px; font-size: 12px; border-radius: 10px; width: 20px; margin: 0 auto; }",
      ".b { border: 1px solid; padding: 1px 0; width: 272px; height: 15px; border-radius: 999px; top: calc(100% - 4px); }",
      ".c { border-radius: 3px; gap: --spacing(1.5); font-size: var(--text-2xs); }",
      ".editor-ruler { height: 20px; } .segments { border-radius: 9px; }",
      ".e { gap: 6px !important; font-size: 12PX } .f { inset-block-start: 12px; }",
      ".editor-ruler,\n.g { padding: 10px; } .clip-scrub .frame-peek { bottom: 26px; } .share-document-title { font-size: 12px; }",
      ".segments, .share-panel { border-radius: 9px; } :is(.h, .i) { margin: 1px; }",
      ".j { padding: 6px var(--x); gap: 6px normal; top: calc(100% - 6px); border-top-left-radius: 10px; border-radius: 10px / 10px; }",
      "@container (max-width: 220px) { .d { padding-inline: 10px; } }",
      "}",
    ].join("\n");
    expect(pixelViolations([{ path: "ui.css", text: css }])).toEqual([
      "ui.css: .a { gap: 6px } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .a { font-size: 12px } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .a { border-radius: 10px } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .a { width: 20px } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .e { gap: 6px !important } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .e { font-size: 12PX } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .f { inset-block-start: 12px } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .editor-ruler, .g { padding: 10px } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .clip-scrub .frame-peek { bottom: 26px } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .share-document-title { font-size: 12px } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .j { padding: 6px var(--x) } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .j { gap: 6px normal } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .j { border-top-left-radius: 10px } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .j { border-radius: 10px / 10px } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
      "ui.css: .d { padding-inline: 10px } is a pixel value; use --spacing(n), var(--text-*) or var(--radius-*)",
    ]);
    // Commas inside a selector function are not a list's.
    expect(selectorList(':is(.h, .i), .j[data-a="b,c"]')).toEqual([":is(.h, .i)", '.j[data-a="b,c"]']);
    const tsx = 'const a = <div className="gap-[6px] hover:text-[12px] -mt-[2px] rounded-[10px] ring-[0.5px] max-w-[min(100%,20px)] gap-1.5 duration-[80ms] text-[length:12px]" />;';
    expect(pixelViolations([{ path: "settings/x.tsx", text: tsx }])).toEqual([
      "settings/x.tsx: gap-[6px] is a pixel value; use the scale's name",
      "settings/x.tsx: hover:text-[12px] is a pixel value; use the scale's name",
      "settings/x.tsx: -mt-[2px] is a pixel value; use the scale's name",
      "settings/x.tsx: rounded-[10px] is a pixel value; use the scale's name",
      "settings/x.tsx: text-[length:12px] is a pixel value; use the scale's name",
    ]);
    expect(pixelViolations([{ path: "components/ui/slider.tsx", text: '"h-[3px] size-[13px]"' }])).toEqual([]);
    expect(pixelViolations([{ path: "countdown/countdown.css", text: ".a { gap: 6px; }" }])).toEqual([]);
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
