/**
 * The Settings type scale, hit targets, contrast and reach that plan 067 fixed (its audit ledger in
 * docs/verification/history-2026-10.md#plan-067-closure--2026-10-06): the page once inherited a 13px root, so every
 * rem-sized control drew 9.75px labels in a 22.75px box; light muted text read at 4.4:1; and at the app's last zoom
 * step a long button or the tabs ran past a minimum-size window. These are the plan's acceptance rules, measured on
 * the computed page: essential text at least 12px, controls at least 24px both ways (a switch or slider counts the
 * hit area its ::after adds), ordinary text at least 4.5:1, and every control inside the window horizontally.
 * The requested light primary is shared by action/navigation labels and filled controls: these use a 3:1 minimum,
 * including their white labels, rather than altering the requested colour. Other text, including permission
 * guidance, retains 4.5:1.
 * View host (hosts/view-host.ts); offscreen, no desktop round.
 */
import { test, expect, type Launched } from "./fixtures";
import fs from "node:fs/promises";
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

for (const language of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`compact content ${language}/${scheme}: labels and choices reflow beside the sidebar and under zoom`, async () => {
    for (const [width, zoom] of [[600, 1], [960, LAST_ZOOM], [380, LAST_ZOOM]] as const) {
      await host.evaluate((h, args) => {
        h.theme(args.scheme);
        h.setContentSize(args.width, 640);
        h.window().webContents.setZoomFactor(args.zoom);
        h.pushModel({ type: "idle" }, { language: args.language });
      }, { width, zoom, language, scheme });
      await page.locator("#tab-recording").click();
      const field = page.locator("#setting-fileName");
      await field.scrollIntoViewIfNeeded();
      const layout = await page.locator("#setting-fileName-row").evaluate(row => {
        const label = row.querySelector(".group-title")!.getBoundingClientRect();
        const controls = row.querySelector(".controls")!.getBoundingClientRect();
        const field = row.querySelector("input")!.getBoundingClientRect();
        return { below: controls.top >= label.bottom, aligned: Math.abs(field.left - label.left - 26) < 1,
          fits: field.right <= row.getBoundingClientRect().right + 1 };
      });
      expect(layout, `${width}px at ${zoom * 100}%`).toEqual({ below: true, aligned: true, fits: true });
      const measured = await read<UiMeasurement>(page, MEASURE_UI);
      expect(measured.overflow).toEqual({ page: false, panel: false });
      expect(measured.texts.filter(text => text.clipped && text.at.startsWith("setting-"))).toEqual([]);
      // Reflow does not take the countdown sound switch away from its own label.
      await page.locator("#setting-countdownSound").scrollIntoViewIfNeeded();
      expect(await page.locator("#setting-countdownSound-row").evaluate(row => {
        const label = row.querySelector(".group-title")!.getBoundingClientRect();
        const control = row.querySelector(".controls")!.getBoundingClientRect();
        return control.top < label.bottom && control.bottom > label.top;
      })).toBe(true);
    }
  });

  test(`long rename ${language}/${scheme}: an unbroken title fits and actions remain reachable in a zoomed minimum window`, async ({}, testInfo) => {
    await host.evaluate((h, args) => {
      h.theme(args.scheme);
      h.setContentSize(380, 360);
      h.window().webContents.setZoomFactor(1.5);
      const view = h.settingsView({ type: "idle" }, { ...h.baseContext(), language: args.language, library: h.library().state });
      view.library.items[0].title = "Recording".repeat(24);
      h.push(view);
    }, { language, scheme });
    await page.locator("#tab-library").click();
    await page.locator(".clip-more").first().click();
    await page.locator("#clip-menu-rename").click();
    const dialog = page.locator("#clip-rename");
    await expect(page.locator("#clip-rename-input")).toBeFocused();
    expect(await dialog.evaluate(el => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
        && el.scrollWidth <= el.clientWidth && el.scrollHeight > el.clientHeight;
    })).toBe(true);
    const picture = async (name: string): Promise<void> => {
      // Chromium's page screenshot crops at unscaled coordinates under Electron zoom; capture the hidden frame.
      const frame = await host.evaluate(async h => (await h.window().webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString("base64"));
      await fs.writeFile(testInfo.outputPath(name), Buffer.from(frame, "base64"));
    };
    await page.waitForTimeout(150);
    await picture("long-rename-title.png");
    await page.locator("#clip-rename-cancel").scrollIntoViewIfNeeded();
    await picture("long-rename-actions.png");
    await page.locator("#clip-rename-cancel").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".clip-more").first()).toBeFocused();
  });
}

test("the macOS top strip covers the window width without covering settings controls", async () => {
  test.skip(process.platform !== "darwin", "Other platforms use the native title bar.");
  await host.evaluate(h => h.pushModel({ type: "idle" }, { library: h.library().state }));
  for (const zoom of [1, LAST_ZOOM]) for (const size of ["default", "minimum"] as const) {
    await host.evaluate((h, args) => {
      h.window().webContents.setZoomFactor(args.zoom);
      h.setSize(...h.SNAPSHOT_SIZES[args.size]);
      h.pushModel({ type: "idle" }, { library: h.library().state });
    }, { zoom, size });
    for (const tab of TABS) {
      await page.locator(`#tab-${tab}`).click();
      const geometry = await read<{ fullWidth: boolean; hit: boolean; covered: string[] }>(page, `(() => {
        const strip = document.querySelector(".titlebar"), r = strip.getBoundingClientRect();
        const covered = [...document.querySelectorAll("main button, main input, main select, main a, main [role=slider]")]
          .filter(el => el.checkVisibility())
          .filter(el => { const b = el.getBoundingClientRect(); return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top; })
          .map(el => el.id || el.tagName);
        // innerWidth rounds CSS pixels at 150% zoom; compare both edges in DOM rectangle coordinates.
        return { fullWidth: r.left === 0 && r.right === document.documentElement.getBoundingClientRect().right && r.top === 0 && r.height > 0,
          hit: [0.25, 0.5, 0.9].every(x => document.elementFromPoint(innerWidth * x, r.height / 2) === strip), covered };
      })()`);
      expect(geometry, `${size}, zoom ${zoom}, ${tab}: drag anywhere along the top, leaving controls reachable`)
        .toEqual({ fullWidth: true, hit: true, covered: [] });
    }
  }
});

test("the macOS sidebar's blank space drags while tabs, window actions and overlays stay clickable", async () => {
  test.skip(process.platform !== "darwin", "Other platforms use the native title bar.");
  const backdrop = page.locator(".sidebar-background"), region = "-webkit-app-region";
  await host.evaluate(h => {
    h.setSize(...h.SNAPSHOT_SIZES.default);
    h.pushModel({ type: "needsPermission", needsRelaunch: false }, { library: h.library().state });
  });
  await expect(backdrop).toHaveCSS(region, "drag");
  await expect(page.locator(".brand")).toHaveCSS("user-select", "none");
  await expect(page.locator(".titlebar")).toHaveCSS("user-select", "none");
  const coverage = await read<{ top: number; bottom: number; height: number; blank: boolean; brand: boolean }>(page, `(() => {
    const box = document.querySelector(".sidebar-background").getBoundingClientRect(),
      tabs = document.querySelector(".tabs").getBoundingClientRect(),
      status = document.querySelector(".status").getBoundingClientRect(),
      brand = document.querySelector(".brand").getBoundingClientRect();
    const x = box.left + box.width / 2, y = (tabs.bottom + status.top) / 2;
    return { top: box.top, bottom: box.bottom, height: innerHeight,
      blank: y > tabs.bottom && y < status.top && x > box.left && x < box.right,
      brand: brand.left >= box.left && brand.right <= box.right && brand.top >= box.top && brand.bottom <= box.bottom };
  })()`);
  expect(coverage.top).toBe(0);
  expect(coverage.bottom).toBe(coverage.height);
  expect(coverage.blank).toBe(true);
  expect(coverage.brand).toBe(true);
  for (const selector of ["#tab-library", "#status-action", "#status-secondary", "#sidebar-about-hide", "#sidebar-about-hide-menu"])
    await expect(page.locator(selector)).toHaveCSS(region, "no-drag");
  await page.locator("#tab-general").click();
  await expect(page.locator("#tab-general")).toHaveAttribute("aria-selected", "true");
  await page.locator("#sidebar-about-hide-menu").click();
  await expect(page.locator("#sidebar-about-hide-menu-content")).toBeVisible();
  await expect(backdrop).toHaveCSS(region, "no-drag");
  await page.keyboard.press("Escape");
  await expect(backdrop).toHaveCSS(region, "drag");
  await page.locator("#tab-library").click();
  await page.locator(".clip-more").first().click();
  await page.locator("#clip-menu-rename").click();
  await expect(page.locator("#clip-rename-input")).toBeFocused();
  await expect(backdrop).toHaveCSS(region, "no-drag");
  await page.locator("#clip-rename-cancel").click();
  await expect(backdrop).toHaveCSS(region, "drag");
  await host.evaluate(h => h.setSize(...h.SNAPSHOT_SIZES.minimum));
  await expect(backdrop).toBeHidden();
});

test("settings hides its scrollbar while wheel and keyboard scrolling keep controls below the macOS drag strip", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "Other platforms use the native title bar.");
  for (const zoom of [1, LAST_ZOOM]) {
    await host.evaluate((h, factor) => {
      h.window().webContents.setZoomFactor(factor);
      h.setContentSize(960, 400);
      h.pushModel({ type: "idle" }, { library: h.library().state });
    }, zoom);
    await page.locator("#tab-general").click();
    const panel = page.locator("#settings-panel"), toggle = page.locator("#setting-notifications");
    await toggle.evaluate(el => el.scrollIntoView({ block: "start" }));
    const geometry = await read<{ stripBottom: number; panelTop: number; controlTop: number; hit: boolean; scrolled: number; ancestors: unknown[] }>(page, `(() => {
      const strip = document.querySelector(".titlebar").getBoundingClientRect(),
        panel = document.querySelector("#settings-panel"), p = panel.getBoundingClientRect(),
        control = document.querySelector("#setting-notifications"), c = control.getBoundingClientRect();
      return { stripBottom: strip.bottom, panelTop: p.top, controlTop: c.top,
        hit: control.contains(document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)), scrolled: panel.scrollTop,
        ancestors: [...document.querySelectorAll("html, body, #root, main, .settings-content, .settings-viewport")].map(el => ({
          node: el.id || el.className || el.tagName, top: el.getBoundingClientRect().top, scrollTop: el.scrollTop,
          height: el.clientHeight, scrollHeight: el.scrollHeight, overflow: getComputedStyle(el).overflow })) };
    })()`);
    expect(geometry.scrolled, `zoom ${zoom}: exercise the scrolled state`).toBeGreaterThan(0);
    expect(geometry.panelTop, `zoom ${zoom}: ${JSON.stringify(geometry)}`).toBeGreaterThanOrEqual(geometry.stripBottom);
    expect(geometry.controlTop).toBeGreaterThanOrEqual(geometry.stripBottom);
    expect(geometry.hit).toBe(true);
    const checked = await toggle.getAttribute("aria-checked");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", checked === "true" ? "false" : "true");
    // The host answers a saved toggle with its minimal view; restore the full production projection for scrolling.
    await host.evaluate(h => h.pushModel({ type: "idle" }, { library: h.library().state }));
    await expect.poll(() => panel.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(panel).toHaveCSS("scrollbar-width", "none");
    expect(await panel.evaluate(el => getComputedStyle(el, "::-webkit-scrollbar").display)).toBe("none");
    await panel.evaluate(el => { el.scrollTop = 0; });
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => panel.evaluate(el => el.scrollTop), { message: `zoom ${zoom}: wheel input still scrolls the panel` }).toBeGreaterThan(0);
    await panel.evaluate(el => { el.scrollTop = 0; });
    await panel.focus();
    await page.keyboard.press("PageDown");
    await expect.poll(() => panel.evaluate(el => el.scrollTop), { message: `zoom ${zoom}: keyboard input still scrolls the panel` }).toBeGreaterThan(0);
    // Electron zoom makes Chromium's screenshot clip use unscaled coordinates; capture the whole hidden frame.
    const frame = await host.evaluate(async h => (await h.window().webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString("base64"));
    await fs.writeFile(testInfo.outputPath(`scrolled-settings-${zoom}.png`), Buffer.from(frame, "base64"));
  }
});

for (const language of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`Window actions ${language}/${scheme}: icon and label have breathing room in both placements, with mouse and keyboard access`, async ({}, testInfo) => {
    for (const size of ["default", "minimum"] as const) {
      await host.evaluate((h, args) => {
        h.theme(args.scheme);
        h.setSize(...h.SNAPSHOT_SIZES[args.size]);
        h.pushModel({ type: "idle" }, { language: args.language });
      }, { language, scheme, size });
      await page.locator("#tab-general").click();
      const id = size === "default" ? "sidebar-about-hide" : "setting-about-hide";
      const hide = page.locator(`#${id}`);
      await hide.scrollIntoViewIfNeeded();
      const spacing = await read<{ left: number; right: number; gap: number; height: number }>(page, `(() => {
        const button = document.getElementById("${id}"), box = button.getBoundingClientRect(), icon = button.querySelector("svg").getBoundingClientRect();
        const range = document.createRange();
        range.selectNode([...button.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()));
        const label = range.getBoundingClientRect();
        return { left: icon.left - box.left, right: box.right - label.right, gap: label.left - icon.right, height: box.height };
      })()`);
      expect(spacing.left, `${size}: the icon is inset from the edge`).toBeGreaterThanOrEqual(10);
      expect(spacing.right, `${size}: the complete label has space after it`).toBeGreaterThanOrEqual(10);
      expect(spacing.gap, `${size}: icon and label stay separate`).toBeGreaterThanOrEqual(6);
      expect(spacing.height).toBeGreaterThanOrEqual(size === "default" ? 32 : 24);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: testInfo.outputPath(`window-actions-${size}.png`), animations: "disabled" });
      await hide.hover();
      await page.screenshot({ path: testInfo.outputPath(`window-actions-${size}-hover.png`), animations: "disabled" });
      const before = await host.evaluate(h => h.chooseCalls.length);
      await hide.click();
      await expect.poll(() => host.evaluate((h, offset) => h.chooseCalls.slice(offset), before)).toEqual([["about", "hide"]]);
      // The host records the hide request without hiding; restore the production view for the keyboard case.
      await host.evaluate((h, language) => h.pushModel({ type: "idle" }, { language }), language);
      await expect(hide).toHaveAttribute("aria-disabled", "false");
      await hide.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(hide).toBeFocused();
      await expect.poll(() => hide.evaluate(node => /0px 0px 0px 2px/.test(getComputedStyle(node).boxShadow))).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`window-actions-${size}-focus.png`), animations: "disabled" });
      await page.keyboard.press("Enter");
      await expect.poll(() => host.evaluate((h, offset) => h.chooseCalls.slice(offset), before)).toEqual([["about", "hide"], ["about", "hide"]]);
      await host.evaluate((h, language) => h.pushModel({ type: "idle" }, { language }), language);
      const trigger = page.locator(`#${id}-menu`), menu = page.locator(`#${id}-menu-content`);
      await trigger.click();
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem")).toHaveText(language === "en"
        ? ["Quit RecordStuff"] : ["結束 RecordStuff"]);
      // Measure the settled popup, after its slide/scale entrance animation.
      await expect.poll(async () => {
        const popup = await menu.boundingBox(), control = await hide.locator("..").boundingBox();
        return popup && control ? control.y - popup.y - popup.height : 0;
      }, { message: `${size}: menu opens above with breathing room` }).toBeGreaterThanOrEqual(7);
      const bounds = await menu.boundingBox(), viewport = await read<{ width: number; height: number }>(page, `({ width: innerWidth, height: innerHeight })`);
      expect(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height).toBe(true);
      const actions = await hide.locator("..").boundingBox();
      if (bounds && actions) {
        expect(Math.abs(bounds.x + bounds.width - actions.x - actions.width), `${size}: menu aligns with the control's right edge`).toBeLessThanOrEqual(1);
        expect(actions.y - bounds.y - bounds.height, `${size}: menu opens above with breathing room`).toBeGreaterThanOrEqual(7);
        if (size === "default") expect(Math.abs(bounds.x - actions.x), "sidebar: menu stays within the sidebar control's width").toBeLessThanOrEqual(1);
      }
      await page.screenshot({ path: testInfo.outputPath(`window-actions-${size}-menu.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
      // Escape dismisses this menu, rather than closing the Settings window.
      await expect(hide).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expect(menu).toBeVisible();
      // The popup becomes visible before its focus handoff completes; send navigation to its item, not the trigger.
      await expect(menu.getByRole("menuitem")).toBeFocused();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await expect.poll(() => host.evaluate((h, offset) => h.chooseCalls.slice(offset), before)).toEqual([["about", "hide"], ["about", "hide"], ["about", "quit"]]);
      await host.evaluate((h, language) => h.pushModel({ type: "idle" }, { language }), language);
      await trigger.click();
      await menu.getByRole("menuitem", { name: language === "en" ? "Quit RecordStuff" : "結束 RecordStuff" }).click();
      await expect.poll(() => host.evaluate((h, offset) => h.chooseCalls.slice(offset), before)).toEqual([["about", "hide"], ["about", "hide"], ["about", "quit"], ["about", "quit"]]);
    }
  });
}

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
  const reference = !document.documentElement.classList.contains("dark") && rgba(getComputedStyle(document.documentElement).getPropertyValue("--primary"));
  const primaryInk = rgba(getComputedStyle(document.documentElement).getPropertyValue("--primary-foreground"));
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
    const referenceLabel = reference && rgba(s.color).every((value, i) => value === reference[i]);
    const primaryLabel = reference && rgba(s.color).every((value, i) => value === primaryInk[i]) &&
      Boolean(el.closest('[data-slot="button"].bg-primary, [role=tab][aria-selected=true]'));
    const minimum = referenceLabel || primaryLabel || size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700) ? 3 : 4.5;
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
  test(`permission setup ${lang}/${scheme}: guidance and both recovery paths remain readable and reachable at every window size`, async ({}, testInfo) => {
    for (const size of ["default", "narrow", "minimum"] as const) {
      await host.evaluate((h, args) => {
        h.theme(args.scheme);
        h.setSize(...h.SNAPSHOT_SIZES[args.size]);
        h.pushModel({ type: "needsPermission", needsRelaunch: false }, { language: args.lang });
      }, { lang, scheme, size });
      const action = page.locator("#status-action"), secondary = page.locator("#status-secondary");
      await expect(action).toBeVisible();
      await expect(secondary).toBeVisible();
      await expect(page.locator("#status-detail")).toBeHidden();
      await expect(action).toHaveText(lang === "en" ? "Open System Settings" : "開啟系統設定");
      await expect(secondary).toHaveText(lang === "en" ? "Already allowed? Relaunch" : "已經允許了？ 重新啓動");
      await expect.poll(() => read(page, `document.documentElement.classList.contains("dark")`)).toBe(scheme === "dark");
      await expect(page.locator(".permission-icon")).toBeVisible();
      await expect(page.locator(".permission-icon")).toHaveAttribute("aria-hidden", "true");
      if (size !== "default") {
        await expect(page.locator(".tabs")).toHaveAttribute("data-variant", "line");
        const spacing = await page.evaluate(() => {
          const status = document.getElementById("status")!.getBoundingClientRect();
          const tab = document.querySelector('.tabs [aria-selected="true"]')!;
          const marker = getComputedStyle(tab, "::after");
          return {
            belowNavigation: status.top - (tab.getBoundingClientRect().bottom - parseFloat(marker.bottom)),
            belowStatus: document.querySelector(".settings-card")!.getBoundingClientRect().top - status.bottom,
          };
        });
        expect(spacing.belowNavigation).toBeGreaterThanOrEqual(20);
        // The line navigation leaves roughly 30px before the permission card.
        expect(spacing.belowNavigation).toBeLessThanOrEqual(32);
        expect(spacing.belowStatus).toBe(24);
      }
      await expect(action.locator("svg")).toHaveCount(1);
      await expect(action.locator("svg").first()).toBeVisible();
      // The permission action uses a quiet outlined surface in both themes, with ordinary readable text.
      // Its previous saturated dark fill's 3:1 surface contrast is no longer the selected design.
      const minimum = (_at: string) => 4.5;
      // Theme changes animate control colours: judge their settled contrast, not a frame in the transition.
      await expect.poll(async () => {
        const found = await read<UiMeasurement>(page, MEASURE_UI);
        return found.texts.filter(entry => entry.at.startsWith("#status-") && (entry.contrast < minimum(entry.at) || entry.clipped));
      }, { message: `${size}: permission text reads in full` }).toEqual([]);
      const found = await read<UiMeasurement>(page, MEASURE_UI);
      expect(found.texts.filter(entry => entry.at.startsWith("#status-")).length).toBeGreaterThanOrEqual(3);
      expect(found.targets.filter(entry => entry.at.startsWith("#status-") && (entry.offscreen || entry.width < 24 || entry.height < 24)), `${size}: recovery controls are reachable and have usable hit areas`).toEqual([]);
      expect(await read(page, `(() => ["status-action", "status-secondary"].every(id => {
        const control = document.getElementById(id), r = control.getBoundingClientRect(), card = document.getElementById("status").getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && r.top >= card.top && r.bottom <= card.bottom;
      }))()`), `${size}: both recovery controls are fully visible without scrolling`).toBe(true);
      const actionBackground = await action.evaluate(el => getComputedStyle(el).backgroundColor);
      const primaryColor = await page.locator('[id^="tab-"][aria-selected="true"]').evaluate(el => getComputedStyle(el, "::after").backgroundColor);
      await action.hover();
      await expect(action).toHaveCSS("background-color", actionBackground);
      await expect(action).toHaveCSS("border-top-color", primaryColor);
      await expect(action).toHaveCSS("color", primaryColor);
      await expect(action.locator("svg").first()).toHaveCSS("color", primaryColor);
      await page.waitForTimeout(170);
      const hovered = await read<UiMeasurement>(page, MEASURE_UI);
      expect(hovered.texts.find(entry => entry.at === "#status-action-label")?.contrast, `${size}: the action remains readable under the pointer`).toBeGreaterThanOrEqual(minimum("#status-action-label"));
      const secondaryStyle = () => read<{ background: string; color: string; decoration: string }>(page, `(() => {
        const style = getComputedStyle(document.getElementById("status-secondary"));
        return { background: style.backgroundColor, color: style.color, decoration: style.textDecorationLine };
      })()`);
      const resting = await secondaryStyle();
      expect(resting.decoration).toBe("none");
      const relaunchLabel = page.locator("#status-secondary-label"), hint = page.locator("#status-secondary-hint");
      await expect(relaunchLabel).toHaveCSS("text-decoration-line", "none");
      await expect(relaunchLabel).toHaveCSS("font-weight", "700");
      await expect(action).toHaveCSS("font-weight", "600");
      const hintColor = await hint.evaluate(el => getComputedStyle(el).color);
      const relaunchColor = await relaunchLabel.evaluate(el => getComputedStyle(el).color);
      const primary = await page.locator('[id^="tab-"][aria-selected="true"]').evaluate(el => getComputedStyle(el, "::after").backgroundColor);
      expect(relaunchColor).toBe(primary);
      expect(relaunchColor).not.toBe(hintColor);
      await secondary.hover();
      const fadedPrimary = await relaunchLabel.evaluate(el => {
        const probe = document.createElement("span");
        probe.style.color = "color-mix(in oklab, var(--primary) 85%, transparent)";
        el.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(relaunchLabel).toHaveCSS("color", fadedPrimary);
      await expect(relaunchLabel).toHaveCSS("text-decoration-line", "underline");
      await expect(relaunchLabel).toHaveCSS("text-decoration-color", fadedPrimary);
      await expect(hint).toHaveCSS("color", hintColor);
      await expect(hint).toHaveCSS("text-decoration-line", "none");
      await expect.poll(secondaryStyle, { message: `${size}: only the relaunch label changes on hover` }).toEqual(resting);
      await page.locator("#status").screenshot({ path: testInfo.outputPath(`permission-hover-card-${lang}-${scheme}-${size}.png`), animations: "disabled" });
      await page.mouse.move(0, 0);
      await expect(relaunchLabel).toHaveCSS("text-decoration-line", "none");
      await expect(relaunchLabel).toHaveCSS("color", relaunchColor);
      await action.focus();
      await page.keyboard.press("Tab");
      await expect(secondary).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(action).toBeFocused();
      // Capture the resting design after verifying keyboard focus, rather than its focus outline.
      await action.evaluate(element => element.blur());
      await page.screenshot({ path: testInfo.outputPath(`permission-${lang}-${scheme}-${size}.png`), animations: "disabled" });
      await page.locator("#status").screenshot({ path: testInfo.outputPath(`permission-card-${lang}-${scheme}-${size}.png`), animations: "disabled" });
      await host.evaluate((h, language) => h.pushModel({ type: "needsPermission", needsRelaunch: true }, { language }), lang);
      await expect(action).toHaveText(lang === "en" ? "Relaunch" : "重新啟動");
      await expect(secondary).toBeHidden();
      await expect(action).toBeVisible();
      await expect(action.locator("svg")).toHaveCount(0);
    }
  });

  test(`U067-1 ${lang}/${scheme}: every tab at the default size draws text of at least 12px, controls of at least 24px and text at its contrast minimum`, async () => {
    await host.evaluate((h, args) => { h.theme(args.scheme); h.setSize(...h.SNAPSHOT_SIZES.default); h.pushModel({ type: "idle" }, { language: args.lang, library: h.library().state, recordingResults: [
      { id: "disk", occurredAt: new Date(Date.now() - 1800_000).toISOString(), code: "disk_full", detail: "ENOSPC", outcome: "partial", partialPath: "/tmp/partial.mp4", acknowledged: false },
      { id: "capture", occurredAt: new Date(Date.now() - 7200_000).toISOString(), code: "capture_start_failed", detail: "timed out", outcome: "empty", acknowledged: true }] }); }, { lang, scheme });
    for (const tab of TABS) {
      await page.locator(`#tab-${tab}`).click();
      if (tab === "failures") {
        const history = await measure(page);
        expect.soft(history, `${lang}/${tab}: history also stays readable and inside its panel`).toEqual({ small: [], tiny: [], faint: [], outside: [] });
        await page.locator("#troubleshooting-tools-tab").click();
      }
      await page.waitForTimeout(120);
      const found = await measure(page);
      expect.soft(found.small, `U067-1 ${lang}/${scheme}/${tab}: no text below 12px`).toEqual([]);
      expect.soft(found.tiny, `U067-1 ${lang}/${scheme}/${tab}: no control below 24px`).toEqual([]);
      expect.soft(found.faint, `U067-1 ${lang}/${scheme}/${tab}: no text below its contrast minimum`).toEqual([]);
      if (tab === "recording") {
        const menus = page.locator('[data-slot="select-trigger"]:visible');
        expect(await menus.count(), "the full settings model includes menus to exercise").toBeGreaterThan(0);
        for (const id of await menus.evaluateAll(nodes => nodes.map(node => node.id))) {
          const trigger = page.locator(`#${id}`);
          await trigger.hover();
          await page.waitForTimeout(200);
          expect.soft((await measure(page)).faint, `${lang}/${scheme}/${id}: hovered menu stays readable`).toEqual([]);
          await trigger.click();
          await expect(trigger).toHaveAttribute("aria-expanded", "true");
          await page.mouse.move(10, 400);
          await page.waitForTimeout(200);
          expect.soft((await measure(page)).faint, `${lang}/${scheme}/${id}: open menu stays readable`).toEqual([]);
          await page.screenshot({ path: test.info().outputPath(`select-open-${lang}-${scheme}-${id}.png`), animations: "disabled" });
          await page.keyboard.press("Escape");
          await expect(trigger).toHaveAttribute("aria-expanded", "false");
        }
      }
      if (tab === "failures") {
        await page.locator("#settings-data-cleanup-heading").hover();
        await page.waitForTimeout(200);
        expect.soft((await measure(page)).faint, `U067-1 ${lang}/${scheme}: cleanup warning stays readable under the pointer`).toEqual([]);
        await page.screenshot({ path: test.info().outputPath(`cleanup-warning-${lang}-${scheme}-hover.png`), animations: "disabled" });
      }
    }
  });
}

for (const lang of ["en", "zh-TW"] as const) {
  test(`U067-2 ${lang}: at the app's last zoom step in a minimum-size window every tab and control stays inside the window and its card`, async () => {
    await host.evaluate((h, args) => { h.theme("light"); h.setSize(...h.SNAPSHOT_SIZES.minimum); h.window().webContents.setZoomFactor(args.zoom);
      h.pushModel({ type: "idle" }, { language: args.lang, library: h.library().state }); }, { lang, zoom: LAST_ZOOM });
    for (const tab of TABS) {
      await page.locator(`#tab-${tab}`).click();
      if (tab === "failures") {
        const history = await measure(page);
        expect.soft(history, `${lang}/${tab}: history also stays readable and inside its panel`).toEqual({ small: [], tiny: [], faint: [], outside: [] });
        await page.locator("#troubleshooting-tools-tab").click();
      }
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
      red: (() => { const probe = document.createElement("p"); probe.style.color = "var(--destructive-ink)"; document.body.append(probe); const colour = getComputedStyle(probe).color; probe.remove();
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

/**
 * Semantic selection and product interactions: responsive navigation, switches, readable menus,
 * and recording play affordances use production styles, without the former macOS appearance contract.
 */
test("sidebar indicators stay inside their items and align with the brand icon across themes, languages and zoom", async () => {
  for (const scheme of ["light", "dark"] as const) for (const language of ["en", "zh-TW"] as const) for (const zoom of [1, LAST_ZOOM]) {
    await host.evaluate((h, args) => {
      h.theme(args.scheme);
      h.setSize(...h.SNAPSHOT_SIZES.default);
      h.window().webContents.setZoomFactor(args.zoom);
      h.pushModel({ type: "idle" }, { language: args.language, library: h.library().state });
    }, { scheme, language, zoom });
    await expect(page.locator(".tabs")).toHaveAttribute("data-variant", "sidebar");
    const geometry = await page.evaluate(() => {
      const brand = document.querySelector(".brand-mark")!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>(".tabs [role=tab]")].map(tab => {
        const bounds = tab.getBoundingClientRect(), style = getComputedStyle(tab), marker = getComputedStyle(tab, "::after");
        const left = bounds.left + parseFloat(style.borderLeftWidth) + parseFloat(marker.left);
        const right = left + parseFloat(marker.width);
        const top = bounds.top + parseFloat(style.borderTopWidth) + parseFloat(marker.top);
        const bottom = top + parseFloat(marker.height);
        const icon = tab.querySelector(".tab-icon")!.getBoundingClientRect();
        return { id: tab.id, alignment: Math.abs(left - brand.left),
          inside: left >= bounds.left && right <= bounds.right && top >= bounds.top && bottom <= bounds.bottom,
          clearOfIcon: right < icon.left };
      });
    });
    expect(geometry).toHaveLength(TABS.length);
    for (const item of geometry) {
      const context = `${scheme}/${language}/${zoom}/${item.id}`;
      expect(item.alignment, `${context}: indicator aligns with the brand icon's left edge`).toBeLessThanOrEqual(0.5);
      expect(item.inside, `${context}: indicator is part of the item's bounds`).toBe(true);
      expect(item.clearOfIcon, `${context}: indicator has its own space before the icon`).toBe(true);
    }
  }
});

test("U070-1 the sidebar, a switch, the card menu and a card's play button use semantic tokens and preserve recording interactions", async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(...h.SNAPSHOT_SIZES.default); h.pushModel({ type: "idle" }, { language: "zh-TW", library: h.library().state }); });
  await page.locator("#tab-library").click();
  // Measure the resting selection; the component coverage checks the pointer-hover fill separately.
  await page.mouse.move(500, 20);
  await page.waitForTimeout(200);
  const chosen = await read<string>(page, `(() => { const probe = document.createElement("p"); probe.style.color = "var(--primary)"; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })()`);
  const tab = (): Promise<{ line: string; fill: string; markerColour: string; markerWidth: number }> => read(page, `(() => { const t = document.getElementById("tab-library"), marker = getComputedStyle(t, "::after");
    return { line: marker.opacity, fill: getComputedStyle(t).backgroundColor, markerColour: marker.backgroundColor, markerWidth: parseFloat(marker.width) }; })()`);
  const wide = await tab();
  expect.soft(wide.line === "1" && wide.fill === "rgba(0, 0, 0, 0)" && wide.markerColour === chosen && wide.markerWidth === 3,
    `U070-1 the sidebar uses a primary leading line on a transparent item ${JSON.stringify(wide)}`).toBe(true);
  await host.evaluate(h => h.setSize(...h.SNAPSHOT_SIZES.narrow));
  await expect.poll(async () => (await tab()).markerWidth, { message: "U070-1 the narrow strip uses a horizontal indicator" }).toBeGreaterThan(3);
  expect((await tab()).markerColour).toBe(chosen);
  const gap = await read<number>(page, `(() => { const t = document.getElementById("tab-library"), marker = getComputedStyle(t, "::after");
    return document.querySelector(".settings-content").getBoundingClientRect().top - (t.getBoundingClientRect().bottom - parseFloat(marker.bottom)); })()`);
  expect(gap, "U070-1 the tab underline leaves breathing room before its content").toBeGreaterThanOrEqual(12);
  await host.evaluate(h => h.setSize(...h.SNAPSHOT_SIZES.default));
  await expect.poll(async () => (await tab()).markerWidth, { message: "U070-1 the wide sidebar restores the leading indicator" }).toBe(3);
  // A card's play button: hidden and a little small at rest, the chosen red, and it grows in under the pointer.
  const play = (): Promise<{ opacity: string; scale: string; fill: string; transition: string }> => read(page, `(() => { const p = getComputedStyle(document.querySelector(".clip-play"));
    return { opacity: p.opacity, scale: p.transform, fill: p.backgroundColor, transition: p.transitionDuration }; })()`);
  const rest = await play();
  await page.locator(".clip-open").first().hover();
  await page.waitForTimeout(400);
  const shown = await play();
  expect.soft(rest.opacity === "0" && rest.scale !== "none" && shown.opacity === "1" && shown.scale === "none" && shown.fill === chosen && rest.transition.includes("0.15s"),
    `U070-1 a card's red play button grows in under the pointer ${JSON.stringify({ rest, shown, chosen })}`).toBe(true);
  // The card menu: every item on one line, however narrow its ⋯ button.
  await page.locator(".clip-more").first().click();
  await expect(page.locator("#clip-menu")).toBeVisible();
  const items = await read<Array<{ text: string; lines: number }>>(page, `[...document.querySelectorAll("#clip-menu [role=menuitem]")].map(item => {
    const s = getComputedStyle(item); return { text: item.textContent.trim(), lines: Math.round((item.getBoundingClientRect().height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)) / parseFloat(s.lineHeight)) }; })`);
  expect.soft(items.length === 4 && items.every(item => item.lines === 1), `U070-1 the card menu keeps every item on one line ${JSON.stringify(items)}`).toBe(true);
  await page.keyboard.press("Escape");
  // A switch that is on is the chosen red.
  await page.locator("#tab-general").click();
  await page.waitForTimeout(150);
  const on = await read<string | null>(page, `(() => { const s = document.querySelector("[data-slot=switch][data-checked]"); return s && getComputedStyle(s).backgroundColor; })()`);
  expect.soft(on, "U070-1 a switch that is on is the chosen red").toBe(chosen);
});

test("U070-2 a settings menu follows focus-visible, preserves focus after selection and Escape closes only the menu", async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(...h.SNAPSHOT_SIZES.default); h.pushModel({ type: "idle" }, { language: "en" }); });
  await page.locator("#tab-recording").click();
  const trigger = page.locator("#setting-screen");
  const ring = (): Promise<boolean> => read(page, `/0px 0px 0px 2px/.test(getComputedStyle(document.getElementById("setting-screen")).boxShadow)`);
  await trigger.click();
  await expect(page.locator('[data-slot="select-content"][data-open]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="select-content"][data-open]')).toHaveCount(0);
  expect.soft(await read<boolean>(page, `document.visibilityState === "visible" && Boolean(document.getElementById("setting-screen"))`), "U070-2 Escape closes the menu and the window stays").toBe(true);
  const value = await trigger.getAttribute("data-value");
  await trigger.click();
  await page.locator(`[data-slot="select-item"][data-value="${value}"]`).click();
  await expect(page.locator('[data-slot="select-content"][data-open]')).toHaveCount(0);
  // Focus goes back to the menu once its sheet has closed.
  await expect.poll(() => read(page, `document.activeElement?.id`)).toBe("setting-screen");
  const pointer = await ring();
  expect.soft(await read<boolean>(page, `document.activeElement?.id === "setting-screen"`) && pointer === await trigger.evaluate(node => node.matches(":focus-visible")),
    `U070-2 after pointer selection, the menu keeps focus and follows browser focus-visible ${pointer}`).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect.poll(ring, { message: "U070-2 reached by the keyboard, the menu shows its ring" }).toBe(true);
});

/** Pixels at each edge must move toward the state colour, including the edges over the thumbnail. */
async function visibleCardEdges(before: Buffer, after: Buffer, colour: string): Promise<string[]> {
  return page.evaluate(async ({ before, after, colour }) => {
    const decode = (png: string) => createImageBitmap(new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], { type: "image/png" }));
    const [plain, marked] = await Promise.all([decode(before), decode(after)]);
    try {
      const canvas = new OffscreenCanvas(marked.width, marked.height), ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1);
      const expected = ctx.getImageData(0, 0, 1, 1).data.slice(0, 3);
      ctx.drawImage(plain, 0, 0); const a = ctx.getImageData(0, 0, plain.width, plain.height).data;
      ctx.drawImage(marked, 0, 0); const b = ctx.getImageData(0, 0, marked.width, marked.height).data;
      const card = document.querySelector(".clip")!.getBoundingClientRect(), thumb = document.querySelector(".clip-thumb")!.getBoundingClientRect();
      const scale = marked.width / card.width, w = marked.width, h = marked.height;
      const x = Math.floor((thumb.left - card.left + thumb.width / 2) * scale), y = Math.floor((thumb.top - card.top + thumb.height / 2) * scale);
      const points: Array<{ edge: string; at: (i: number) => [number, number] }> = [
        { edge: "top over thumbnail", at: (i: number) => [x, i] },
        { edge: "left over thumbnail", at: (i: number) => [i, y] },
        { edge: "right", at: (i: number) => [w - 1 - i, y] },
        { edge: "bottom", at: (i: number) => [Math.floor(w / 2), h - 1 - i] },
      ];
      return points.filter(({ at }) => Array.from({ length: Math.ceil(3 * scale) }, (_, i) => {
        const [px, py] = at(i), k = (py * w + px) * 4;
        const distance = (pixels: Uint8ClampedArray) => Math.hypot(...[0, 1, 2].map(c => pixels[k + c]! - expected[c]!));
        // Allow antialiasing at fractional CSS edges, but require a clear, opaque state line over the picture.
        return distance(b) <= 20 && distance(b) + 20 < distance(a);
      }).some(Boolean)).map(({ edge }) => edge);
    } finally { plain.close(); marked.close(); }
  }, { before: before.toString("base64"), after: after.toString("base64"), colour });
}

for (const scheme of ["light", "dark"] as const) for (const layout of ["grid", "list"] as const) {
  test(`U070-3 ${scheme}/${layout}: recording card state lines cover thumbnails, touch the content and follow its corners`, async ({}, testInfo) => {
    await host.evaluate((h, args) => {
      h.theme(args.scheme); h.setSize(...h.SNAPSHOT_SIZES.default);
      h.pushModel({ type: "idle" }, { language: "en", library: h.library().state, libraryLayout: args.layout });
    }, { scheme, layout });
    await page.locator("#tab-library").click();
    const card = page.locator(".clip").first();
    await expect.poll(() => card.locator("img").evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const plain = await card.screenshot();
    await page.locator(".clip-more").first().focus();
    await page.keyboard.press("Shift+Tab");
    const edge = () => read<{ active: string; line: string; width: number; colour: string; inset: string[]; radius: number; button: string; gaps: number[] }>(page, `(() => {
      const card = document.querySelector(".clip"), button = card.querySelector(".clip-open"), thumb = card.querySelector(".clip-thumb");
      const c = getComputedStyle(card, "::after"), b = getComputedStyle(button), r = card.getBoundingClientRect(), t = thumb.getBoundingClientRect(), face = button.getBoundingClientRect();
      return { active: document.activeElement?.id, line: c.borderTopStyle, width: parseFloat(c.borderTopWidth), colour: c.borderTopColor,
        inset: [c.top, c.right, c.bottom, c.left], radius: parseFloat(c.borderTopLeftRadius),
        button: b.outlineStyle === "none" || b.outlineWidth === "0px" ? "none" : b.outlineStyle + " " + b.outlineWidth,
        // List thumbnails are vertically centered beside text; the whole button still meets the card's edges.
        gaps: [t.left - r.left, face.top - r.top, face.right - r.right,
          ...(card.closest("#library").dataset.layout === "grid" ? [t.top - r.top, t.right - r.right] : [])] }; })()`);
    const focus = await edge();
    expect.soft(focus.active?.endsWith("-open") && focus.line === "solid" && focus.width === 2 && focus.radius > 0 && focus.button === "none",
      `U070-3 ${scheme}/${layout}: one focus line follows the whole card's corners ${JSON.stringify(focus)}`).toBe(true);
    expect.soft(focus.inset, "the focus line lies against the card's inner edge").toEqual(["0px", "0px", "0px", "0px"]);
    expect.soft(focus.gaps.every(gap => Math.abs(gap) < 0.5), "the thumbnail and button meet the card edges without a transparent border").toBe(true);
    const focused = await card.screenshot({ path: testInfo.outputPath(`card-${scheme}-${layout}-focus.png`) });
    const visible = ["top over thumbnail", "left over thumbnail", "right", "bottom"];
    expect.soft(await visibleCardEdges(plain, focused, focus.colour), "focus pixels remain visible above the thumbnail on every edge").toEqual(visible);

    // A notification entry focuses the saved card after pointer input and highlights it without playing.
    await page.locator("#tab-library").click();
    await host.evaluate((h, layout) => {
      const view = h.settingsView({ type: "idle" }, { ...h.baseContext(), language: "en", library: h.library().state, libraryLayout: layout });
      h.push({ ...view, entryTab: "library", libraryFocus: view.library.items[0].id, resultFocus: Date.now() });
    }, layout);
    await expect(card).toHaveClass(/arrived/);
    // Hold the real highlight at its first frame so the picture and geometry show the same state.
    await read(page, `document.querySelector(".clip").getAnimations().forEach(a => { a.pause(); a.currentTime = 0; })`);
    const arrived = await edge();
    expect.soft(arrived.line === "solid" && arrived.width === 2 && arrived.inset.every(v => v === "0px"),
      `U070-3 ${scheme}/${layout}: the notification line also touches the content ${JSON.stringify(arrived)}`).toBe(true);
    await expect(page.locator(".player[data-open]")).toHaveCount(0);
    const highlighted = await card.screenshot({ path: testInfo.outputPath(`card-${scheme}-${layout}-arrived.png`) });
    expect.soft(await visibleCardEdges(plain, highlighted, arrived.colour), "notification pixels remain visible above the thumbnail on every edge").toEqual(visible);
    await read(page, `document.querySelector(".clip").getAnimations().forEach(a => a.finish())`);
    await expect(card).not.toHaveClass(/arrived/);

    // The visible line passes pointer input through to the picture and the card's menu.
    const hit = await read<{ x: number; y: number }>(page, `(() => { const c = document.querySelector(".clip").getBoundingClientRect(), t = document.querySelector(".clip-thumb").getBoundingClientRect();
      return { x: c.left + 1, y: t.top + t.height / 2 }; })()`);
    await page.mouse.click(hit.x, hit.y);
    await expect(page.locator(".player[data-open]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.locator(".clip-more").first().click();
    await expect(page.locator("#clip-menu")).toBeVisible();
    await page.keyboard.press("Escape");
  });
}
