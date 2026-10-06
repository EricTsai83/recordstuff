/**
 * The Settings type scale, hit targets, contrast and reach that plan 067 fixed (its audit ledger in
 * docs/verification/history-2026-10.md#plan-067-closure--2026-10-06): the page once inherited a 13px root, so every
 * rem-sized control drew 9.75px labels in a 22.75px box; light muted text read at 4.4:1; and at the app's last zoom
 * step a long button or the tabs ran past a minimum-size window. These are the plan's acceptance rules, measured on
 * the computed page: essential text at least 12px, controls at least 24px both ways (a switch or slider counts the
 * hit area its ::after adds), meaningful text at least 4.5:1, and every control inside the window horizontally.
 * View host (hosts/view-host.ts); offscreen, no desktop round.
 */
import { test, expect, type Launched } from "./fixtures";
import type { Page } from "@playwright/test";
import { read } from "./helpers";
import { MEASURE_UI, type UiMeasurement } from "../../scripts/fixtures/ui-measure";

let host: Launched, page: Page;
test.beforeEach(async ({ launchView }) => {
  ({ launched: host, page } = await launchView());
  // The library's third recording has no picture: the scheme answers its thumbnail 404 (settings-matrix S028).
  host.expectedErrors.push(/Failed to load resource: the server responded with a status of 404 .*\(recordstuff-media:\/\/thumb\//);
  await expect(page.locator("#setting-hotkey")).toBeVisible();
});

/** The app's last zoom step (src/main/settings/settings-window.ts ZOOM_STEPS), the most ⌘+ reaches. */
const LAST_ZOOM = 1.5;
const TABS = ["library", "recording", "general", "failures"] as const;

/** What the page draws now: text smaller than 12px, controls under 24px, text under its contrast minimum, controls outside the window. */
const measure = (page: Page): Promise<{ small: string[]; tiny: string[]; faint: string[]; outside: string[] }> => read(page, `(() => {
  const shown = el => !el.closest("[hidden], .sr-only, [aria-hidden='true']") && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden";
  const name = el => (el.id ? "#" + el.id : el.className.baseVal ?? el.className) + " " + (el.getAttribute("aria-label") ?? el.textContent).trim().slice(0, 30);
  const ctx = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
  const rgba = v => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#0000"; ctx.fillStyle = v; ctx.fillRect(0, 0, 1, 1); const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
  const over = (t, u) => t.slice(0, 3).map((c, i) => c * t[3] + u[i] * (1 - t[3])).concat(1);
  // The text and its backdrop as finally drawn: backgrounds composited from the page down, then every element's opacity
  // (the text's own and each ancestor's, backdrop owners included) blending its content with what lies beneath it.
  const drawn = (el, colour) => {
    const chain = []; for (let n = el; n; n = n.parentElement) chain.unshift(n);
    const bases = [[255, 255, 255, 1]]; for (const n of chain) bases.push(over(rgba(getComputedStyle(n).backgroundColor), bases.at(-1)));
    let back = bases.at(-1), text = over(rgba(colour), back);
    for (let i = chain.length - 1; i >= 0; i--) { const o = Number(getComputedStyle(chain[i]).opacity); if (o >= 1) continue;
      const mix = c => c.slice(0, 3).map((v, k) => v * o + bases[i][k] * (1 - o)).concat(1); text = mix(text); back = mix(back); }
    return { text, back };
  };
  const lum = ([r, g, b]) => [r, g, b].map(c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [.2126, .7152, .0722][i], 0);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const small = [], tiny = [], faint = [], outside = [];
  for (const el of document.querySelectorAll("main *, [role=dialog] *")) {
    if (el instanceof SVGElement || !shown(el) || el.closest(":disabled, [data-disabled]")) continue;
    // A field's value or placeholder and a menu's selected option are text too.
    const field = el.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), select");
    const value = el.matches("select") ? el.selectedOptions[0]?.textContent ?? "" : field ? el.value || el.placeholder : "";
    if (field ? !value.trim() : ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el), size = parseFloat(s.fontSize);
    const { text, back } = drawn(el, field && !el.value && el.matches("input") ? getComputedStyle(el, "::placeholder").color : s.color);
    const contrast = ratio(text, back);
    if (size < 12) small.push(name(el) + " " + size + "px");
    const minimum = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700) ? 3 : 4.5;
    if (contrast < minimum) faint.push(name(el) + " " + contrast.toFixed(2));
  }
  for (const el of document.querySelectorAll("main button, main select, main input, main [role=tab], main [role=switch]")) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect(), after = getComputedStyle(el, "::after"), grow = after.content !== "none" && after.position === "absolute"
      ? { x: -parseFloat(after.left) - parseFloat(after.right), y: -parseFloat(after.top) - parseFloat(after.bottom) } : { x: 0, y: 0 };
    if (r.width + Math.max(0, grow.x) < 24 - 0.5 || r.height + Math.max(0, grow.y) < 24 - 0.5) tiny.push(name(el) + " " + r.width.toFixed(1) + "x" + r.height.toFixed(1));
    // Inside the window, and not cut off by the card or panel that clips it.
    let clip = { left: 0, right: innerWidth };
    for (let n = el.parentElement; n; n = n.parentElement) { if (getComputedStyle(n).overflowX !== "visible") { const b = n.getBoundingClientRect(); clip = { left: Math.max(clip.left, b.left), right: Math.min(clip.right, b.right) }; } }
    if (r.left < clip.left - 0.5 || r.right > clip.right + 0.5) outside.push(name(el));
  }
  return { small, tiny, faint, outside };
})()`);

for (const lang of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`U067-1 ${lang}/${scheme}: every tab at the default size draws text of at least 12px, controls of at least 24px and text at its contrast minimum`, async () => {
    await host.evaluate((h, args) => { h.theme(args.scheme); h.setSize(...h.SNAPSHOT_SIZES.default); h.pushModel({ type: "idle" }, { language: args.lang, library: h.library().state, recordingResults: [
      { id: "disk", occurredAt: new Date(Date.now() - 1800_000).toISOString(), code: "disk_full", detail: "ENOSPC", outcome: "partial", partialPath: "/tmp/partial.mp4", acknowledged: false },
      { id: "capture", occurredAt: new Date(Date.now() - 7200_000).toISOString(), code: "capture_start_failed", detail: "timed out", outcome: "empty", acknowledged: true }] }); }, { lang, scheme });
    for (const tab of TABS) {
      await page.locator(`#tab-${tab}`).click();
      await page.waitForTimeout(120);
      const found = await measure(page);
      expect.soft(found.small, `U067-1 ${lang}/${scheme}/${tab}: no text below 12px`).toEqual([]);
      expect.soft(found.tiny, `U067-1 ${lang}/${scheme}/${tab}: no control below 24px`).toEqual([]);
      expect.soft(found.faint, `U067-1 ${lang}/${scheme}/${tab}: no text below its contrast minimum`).toEqual([]);
    }
  });
}

for (const lang of ["en", "zh-TW"] as const) {
  test(`U067-2 ${lang}: at the app's last zoom step in a minimum-size window every tab and control stays inside the window and its card`, async () => {
    await host.evaluate((h, args) => { h.theme("light"); h.setSize(...h.SNAPSHOT_SIZES.minimum); h.window().webContents.setZoomFactor(args.zoom);
      h.pushModel({ type: "idle" }, { language: args.lang, library: h.library().state }); }, { lang, zoom: LAST_ZOOM });
    for (const tab of TABS) {
      await page.locator(`#tab-${tab}`).click();
      await page.waitForTimeout(150);
      const found = await measure(page);
      expect.soft(found.outside, `U067-2 ${lang}/${tab}: nothing runs past the window or is cut off by its card at ${LAST_ZOOM * 100}%`).toEqual([]);
      expect.soft(await read<boolean>(page, `document.documentElement.scrollWidth <= innerWidth && document.getElementById("settings-panel").scrollWidth <= document.getElementById("settings-panel").clientWidth`),
        `U067-2 ${lang}/${tab}: no horizontal overflow at ${LAST_ZOOM * 100}%`).toBe(true);
    }
  });
}

test("U067-3 a file name format the app would refuse marks the field invalid and says why in the error colour; Escape restores the saved one", async () => {
  await host.evaluate(h => { h.theme("light"); h.pushModel({ type: "idle" }, { language: "en" }); });
  await page.locator("#tab-recording").click();
  const field = page.locator("#setting-fileName");
  await field.fill("{date} {nonsense}");
  const refused = await read<{ invalid: string | null; note: string; red: boolean }>(page, `(() => { const note = document.getElementById("setting-fileName-note");
    return { invalid: document.getElementById("setting-fileName").getAttribute("aria-invalid"), note: note.textContent,
      red: (() => { const probe = document.createElement("p"); probe.style.color = "var(--destructive)"; document.body.append(probe); const colour = getComputedStyle(probe).color; probe.remove();
        return getComputedStyle(note).color === colour; })() }; })()`);
  expect.soft(refused.invalid === "true" && refused.red && /\{date\}/.test(refused.note), `U067-3 the refused format is marked invalid with its reason ${JSON.stringify(refused)}`).toBe(true);
  await field.press("Escape");
  const restored = await read<{ invalid: string | null; value: string }>(page, `({ invalid: document.getElementById("setting-fileName").getAttribute("aria-invalid"), value: document.getElementById("setting-fileName").value })`);
  expect.soft(restored, "U067-3 Escape restores the saved format and clears the mark").toEqual({ invalid: null, value: "{date} {time}" });
});

test("U067-0 both measurements see what they claim to: faded text over a faded backdrop, and a field's small value", async () => {
  await host.evaluate(h => { h.theme("light"); h.pushModel({ type: "idle" }, { language: "en" }); });
  await page.locator("#tab-recording").click();
  // Black text in a white box at half opacity over the light page draws at about 4:1, under the 4.5:1 minimum; a 10px value is below 12px.
  // Styled through the CSSOM: the page's CSP refuses style attributes.
  await read(page, `(() => { const panel = document.getElementById("settings-panel"), box = document.createElement("div"), field = document.createElement("input");
    box.id = "probe-faded"; box.textContent = "probe faded"; Object.assign(box.style, { background: "#fff", opacity: "0.5", color: "#000" });
    field.id = "probe-field"; field.value = "probe value"; field.style.fontSize = "10px"; panel.prepend(box, field); })()`);
  expect(await read<boolean>(page, `Boolean(document.getElementById("probe-faded") && document.getElementById("probe-field"))`), "U067-0 the probes are in the page").toBe(true);
  const found = await measure(page);
  expect.soft(found.faint.some(entry => entry.startsWith("#probe-faded")), `U067-0 the spec's contrast counts a faded backdrop owner ${JSON.stringify(found.faint)}`).toBe(true);
  expect.soft(found.small.some(entry => entry.startsWith("#probe-field")), `U067-0 the spec measures a field's value ${JSON.stringify(found.small)}`).toBe(true);
  const gallery = await read<UiMeasurement>(page, MEASURE_UI);
  const faded = gallery.texts.find(entry => entry.at === "#probe-faded"), field = gallery.texts.find(entry => entry.at === "#probe-field");
  expect.soft(Boolean(faded && faded.contrast < 4.5 && faded.contrast > 3.5) && field?.size === 10,
    `U067-0 the gallery's measurement agrees ${JSON.stringify({ faded, field })}`).toBe(true);
});
