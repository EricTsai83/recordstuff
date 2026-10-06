/**
 * What `pnpm preview:ui` measures on each picture (plan 067, 2026-10-06): computed text sizes, the hit rectangles of
 * the page's controls, outer and panel overflow, text cut off without a way to read the whole, and the contrast of
 * each text against the colours actually composited beneath it. It runs inside the page and returns plain data; it
 * judges nothing (the plan's targets are applied in the audit report, the defects it found in the Playwright suite).
 * Page source text, as the fixtures' other page scripts are, since this project compiles without the DOM's types.
 */
export interface UiMeasurement {
  viewport: { width: number; height: number };
  overflow: { page: boolean; panel: boolean };
  /** Every visible element with text of its own: where it is, how big its letters are and how they read. */
  /** `disabled` text is exempt from the contrast minimum. Contrast includes the opacity that fades text against its backdrop. */
  texts: Array<{ at: string; text: string; size: number; weight: string; lineHeight: number; contrast: number; disabled: boolean; large: boolean; clipped: boolean }>;
  /** Every visible control a pointer or the keyboard operates. */
  targets: Array<{ at: string; name: string; width: number; height: number; offscreen: boolean }>;
}

/** An expression that evaluates, in the page, to a `UiMeasurement`. */
export const MEASURE_UI = String.raw`(() => {
  const describe = el => {
    const classes = [...el.classList].filter(c => !c.includes(":") && !c.includes("[")).slice(0, 2);
    const own = el.id ? "#" + el.id : el.tagName.toLowerCase() + (classes.length ? "." + classes.join(".") : "");
    const owner = el.parentElement && el.parentElement.closest("[id]");
    return owner && !el.id ? owner.id + ">" + own : own;
  };
  const shown = el => {
    if (el.closest("[hidden], .sr-only, [aria-hidden='true']")) return false;
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && Number(style.opacity) > 0.05;
  };
  const canvas = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
  const rgba = value => {
    canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = "#0000"; canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255];
  };
  const over = (top, under) => top.slice(0, 3).map((c, i) => c * top[3] + under[i] * (1 - top[3])).concat(1);
  const luminance = ([r, g, b]) => [r, g, b].map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // The text and its backdrop as finally drawn: each ancestor's background composited from the page down, then every
  // element's opacity, the text's own and each ancestor's (backdrop owners included), blending its whole content
  // with what lies beneath it, from the text outwards (review: opacity).
  const contrastOf = (el, colourValue) => {
    const chain = [];
    for (let node = el; node; node = node.parentElement) chain.unshift(node);
    const bases = [[255, 255, 255, 1]];
    for (const node of chain) bases.push(over(rgba(getComputedStyle(node).backgroundColor), bases.at(-1)));
    let backdrop = bases.at(-1), text = over(rgba(colourValue), backdrop);
    for (let i = chain.length - 1; i >= 0; i--) {
      const opacity = Number(getComputedStyle(chain[i]).opacity);
      if (opacity >= 1) continue;
      const mix = colour => colour.slice(0, 3).map((c, k) => c * opacity + bases[i][k] * (1 - opacity)).concat(1);
      text = mix(text); backdrop = mix(backdrop);
    }
    return Math.round(ratio(text, backdrop) * 100) / 100;
  };
  const texts = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el instanceof SVGElement || !shown(el)) continue;
    // A field's value or placeholder and a menu's selected option are text too (review: inputs).
    const field = el.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), select");
    const value = el.matches("select") ? el.selectedOptions[0]?.textContent ?? "" : field ? el.value || el.placeholder : "";
    if (field ? !value.trim() : ![...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
    const style = getComputedStyle(el), size = parseFloat(style.fontSize), weight = style.fontWeight;
    const colourValue = field && !el.value && el.matches("input") ? getComputedStyle(el, "::placeholder").color : style.color;
    const ellipsis = style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none";
    const cut = el.scrollWidth > el.clientWidth + 1 && !["visible", "auto", "scroll"].includes(style.overflowX);
    texts.push({ at: describe(el), text: (field ? value : el.textContent).trim().replace(/\s+/g, " ").slice(0, 48), size, weight,
      lineHeight: parseFloat(style.lineHeight) || size * 1.2, contrast: contrastOf(el, colourValue), disabled: Boolean(el.closest(":disabled, [data-disabled]")),
      large: size >= 24 || (size >= 18.66 && Number(weight) >= 700),
      clipped: cut && !(ellipsis && (el.title || el.closest("[title], [aria-label]"))) });
  }
  const targets = [];
  for (const el of document.querySelectorAll("button, [role=tab], [role=switch], [role=menuitem], select, input, a[href]")) {
    if (!shown(el)) continue;
    const rect = el.getBoundingClientRect();
    targets.push({ at: describe(el), name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40),
      width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10,
      offscreen: rect.right > innerWidth + 0.5 || rect.left < -0.5 });
  }
  const panel = document.getElementById("settings-panel");
  return { viewport: { width: innerWidth, height: innerHeight }, texts, targets,
    overflow: { page: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
      panel: Boolean(panel && panel.scrollWidth > panel.clientWidth + 1) } };
})()`;
