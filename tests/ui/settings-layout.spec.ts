/**
 * The Settings readability, hit-target and reach rules that plan 067 fixed (its audit ledger in
 * docs/verification/history-2026-10.md#plan-067-closure--2026-10-06): the page once inherited a 13px root, so every
 * rem-sized control drew 9.75px labels in a 22.75px box, and at the app's last zoom step a long button or the tabs ran
 * past a minimum-size window. These are the plan's acceptance floors, measured on the computed page: essential text at
 * least 12px, controls at least 24px both ways (a switch or slider counts the hit area its ::after adds), and every
 * control inside the window horizontally. They are minimums, not the design: spacing, placement, colours and styling
 * are free to change.
 * View host (hosts/view-host.ts); offscreen, no desktop round.
 */
import { test, expect, type Launched } from "./fixtures";
import fs from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
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
/** A recording card's ⋯ menu button (`clip-<id>-more`). */
const MORE = '[id^="clip-"][id$="-more"]';

/**
 * The computed properties a focus indicator can draw with. Compared against the same control at rest, so a test
 * proves that keyboard focus is shown without pinning which outline, ring or fill shows it.
 */
const focusLook = (control: Locator): Promise<string> => control.evaluate(el => {
  const s = getComputedStyle(el);
  const outline = s.outlineStyle === "none" || parseFloat(s.outlineWidth) === 0 ? "none" : `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`;
  return [outline, s.boxShadow, s.borderTopColor, s.backgroundColor].join("|");
});

for (const language of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`compact content ${language}/${scheme}: fields fit and labels read in full beside the sidebar and under zoom`, async () => {
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
      const fits = await field.evaluate(input => {
        const box = input.getBoundingClientRect(), row = document.getElementById("setting-fileName-row")!.getBoundingClientRect();
        return box.left >= row.left - 1 && box.right <= row.right + 1 && box.left >= 0 && box.right <= innerWidth;
      });
      expect(fits, `${width}px at ${zoom * 100}%: the field stays inside its row and the window`).toBe(true);
      const measured = await read<UiMeasurement>(page, MEASURE_UI);
      expect(measured.overflow).toEqual({ page: false, panel: false });
      expect(measured.texts.filter(text => text.clipped && text.at.startsWith("setting-"))).toEqual([]);
      // Reflow keeps the countdown sound switch reachable.
      const countdown = page.locator("#setting-countdownSound");
      await countdown.scrollIntoViewIfNeeded();
      await expect(countdown, `${width}px at ${zoom * 100}%`).toBeInViewport();
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
    await page.locator(MORE).first().click();
    await page.locator("#clip-menu-rename").click();
    const dialog = page.locator("#clip-rename");
    await expect(page.locator("#clip-rename-input")).toBeFocused();
    expect(await dialog.evaluate(el => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && el.scrollWidth <= el.clientWidth;
    }), "the dialog stays inside the window without horizontal overflow").toBe(true);
    const measured = await read<UiMeasurement>(page, MEASURE_UI);
    expect(measured.texts.filter(text => text.at === "#clip-rename-label" && text.clipped), "the long title reads in full").toEqual([]);
    const picture = async (name: string): Promise<void> => {
      // Chromium's page screenshot crops at unscaled coordinates under Electron zoom; capture the hidden frame.
      const frame = await host.evaluate(async h => (await h.window().webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString("base64"));
      await fs.writeFile(testInfo.outputPath(name), Buffer.from(frame, "base64"));
    };
    await page.waitForTimeout(150);
    await picture("long-rename-title.png");
    for (const id of ["#clip-rename-confirm", "#clip-rename-cancel"]) {
      await page.locator(id).scrollIntoViewIfNeeded();
      await expect(page.locator(id), `${id} can be scrolled into view`).toBeInViewport();
    }
    await picture("long-rename-actions.png");
    await page.locator("#clip-rename-cancel").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(MORE).first()).toBeFocused();
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
        return {
          hit: [0.25, 0.5, 0.9].every(x => document.elementFromPoint(innerWidth * x, r.height / 2) === strip), covered };
      })()`);
      expect(geometry, `${size}, zoom ${zoom}, ${tab}: drag anywhere along the top, leaving controls reachable`)
        .toEqual({ hit: true, covered: [] });
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
  // Dragging the window from the top strip does not start a text selection.
  await expect(page.locator(".titlebar")).toHaveCSS("user-select", "none");
  // Somewhere in the sidebar a pointer lands on nothing interactive and nothing that opts out of dragging.
  expect(await read<boolean>(page, `(() => {
    const box = document.querySelector(".sidebar-background").getBoundingClientRect(), x = box.left + box.width / 2;
    const interactive = "button, a, input, select, textarea, [role=tab], [role=button], [role=switch], [role=menuitem]";
    for (let y = box.top + 1; y < box.bottom - 1; y += 4) {
      const chain = [];
      for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) chain.push(el);
      if (chain.length && !chain.some(el => el.matches(interactive) || getComputedStyle(el).getPropertyValue("-webkit-app-region") === "no-drag")) return true;
    }
    return false;
  })()`), "the sidebar keeps blank space that drags the window").toBe(true);
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
  await page.locator(MORE).first().click();
  await page.locator("#clip-menu-rename").click();
  await expect(page.locator("#clip-rename-input")).toBeFocused();
  await expect(backdrop).toHaveCSS(region, "no-drag");
  await page.locator("#clip-rename-cancel").click();
  await expect(backdrop).toHaveCSS(region, "drag");
});

test("wheel and keyboard scrolling in settings keep controls below the macOS drag strip", async ({}, testInfo) => {
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
    const geometry = await read<{ stripBottom: number; panelTop: number; controlTop: number; hit: boolean; scrolled: number }>(page, `(() => {
      const strip = document.querySelector(".titlebar").getBoundingClientRect(),
        panel = document.querySelector("#settings-panel"), p = panel.getBoundingClientRect(),
        control = document.querySelector("#setting-notifications"), c = control.getBoundingClientRect();
      return { stripBottom: strip.bottom, panelTop: p.top, controlTop: c.top,
        hit: control.contains(document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)), scrolled: panel.scrollTop };
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
  test(`Window actions ${language}/${scheme}: the label reads in full in both placements, with mouse and keyboard access`, async ({}, testInfo) => {
    for (const size of ["default", "minimum"] as const) {
      await host.evaluate((h, args) => {
        h.theme(args.scheme);
        h.setSize(...h.SNAPSHOT_SIZES[args.size]);
        h.pushModel({ type: "idle" }, { language: args.language });
      }, { language, scheme, size });
      await page.locator("#tab-general").click();
      // Whichever place this window size shows the window actions in, use the visible ones.
      const hide = page.getByRole("group", { name: language === "en" ? "RecordStuff window actions" : "RecordStuff 視窗操作", exact: true })
        .filter({ visible: true }).first().getByRole("button", { name: language === "en" ? "Hide interface" : "隱藏介面", exact: true });
      const id = (await hide.getAttribute("id"))!;
      await hide.scrollIntoViewIfNeeded();
      await expect(hide).toBeInViewport();
      const measured = await read<UiMeasurement>(page, MEASURE_UI);
      expect(measured.texts.filter(text => text.at.startsWith(`#${id}`) && text.clipped), `${size}: the complete label reads in full`).toEqual([]);
      expect(measured.targets.filter(target => target.at.startsWith(`#${id}`) && (target.offscreen || target.width < 24 || target.height < 24)),
        `${size}: the action and its menu have usable hit areas inside the window`).toEqual([]);
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
      await page.mouse.move(0, 0);
      await hide.evaluate(node => (node as HTMLElement).blur());
      const resting = await focusLook(hide);
      await hide.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(hide).toBeFocused();
      await expect.poll(async () => await hide.evaluate(node => node.matches(":focus-visible")) && await focusLook(hide) !== resting,
        { message: `${size}: keyboard focus is visible` }).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`window-actions-${size}-focus.png`), animations: "disabled" });
      await page.keyboard.press("Enter");
      await expect.poll(() => host.evaluate((h, offset) => h.chooseCalls.slice(offset), before)).toEqual([["about", "hide"], ["about", "hide"]]);
      await host.evaluate((h, language) => h.pushModel({ type: "idle" }, { language }), language);
      const trigger = page.locator(`#${id}-menu`), menu = page.locator(`#${id}-menu-content`);
      await trigger.click();
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem")).toHaveText(language === "en"
        ? ["Quit RecordStuff"] : ["結束 RecordStuff"]);
      // Measure the settled popup, after any entrance animation: it stays wholly inside the window.
      await expect.poll(async () => {
        const bounds = await menu.boundingBox(), viewport = await read<{ width: number; height: number }>(page, `({ width: innerWidth, height: innerHeight })`);
        return Boolean(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
      }, { message: `${size}: the menu opens inside the window` }).toBe(true);
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

/** What the page draws now: text smaller than 12px, controls under 24px, controls outside the window. */
const measure = (page: Page): Promise<{ small: string[]; tiny: string[]; outside: string[] }> => read(page, `(() => {
  const shown = el => !el.closest("[hidden], .sr-only, [aria-hidden='true']") && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden";
  const name = el => (el.id ? "#" + el.id : el.className.baseVal ?? el.className) + " " + (el.getAttribute("aria-label") ?? el.textContent).trim().slice(0, 30);
  const small = [], tiny = [], outside = [];
  for (const el of document.querySelectorAll("main *, [role=dialog] *")) {
    if (el instanceof SVGElement || !shown(el) || el.closest(":disabled, [data-disabled]")) continue;
    // A field's value or placeholder and a menu's selected option are text too.
    const field = el.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), select");
    const value = el.matches("select") ? el.selectedOptions[0]?.textContent ?? "" : field ? el.value || el.placeholder : "";
    if (field ? !value.trim() : ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el), size = parseFloat(s.fontSize);
    if (size < 12) small.push(name(el) + " " + size + "px");
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
  return { small, tiny, outside };
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
      await expect(action).toHaveText(lang === "en" ? "Open Settings" : "開啟系統設定");
      await expect(secondary).toHaveText(lang === "en" ? "Already allowed? Relaunch" : "已經允許了？ 重新啓動");
      // Any decorative icon in the card stays out of the accessible text.
      expect(await page.locator("#status svg").evaluateAll(icons => icons.every(icon => icon.closest("[aria-hidden='true']"))),
        `${size}: decorative icons are hidden from assistive technology`).toBe(true);
      await expect.poll(async () => {
        const found = await read<UiMeasurement>(page, MEASURE_UI);
        return found.texts.filter(entry => entry.at.startsWith("#status-") && entry.clipped);
      }, { message: `${size}: permission text reads in full` }).toEqual([]);
      const found = await read<UiMeasurement>(page, MEASURE_UI);
      expect(found.texts.filter(entry => entry.at.startsWith("#status-")).length, "the measurement finds the permission text").toBeGreaterThan(0);
      expect(found.targets.filter(entry => entry.at.startsWith("#status-") && (entry.offscreen || entry.width < 24 || entry.height < 24)), `${size}: recovery controls are reachable and have usable hit areas`).toEqual([]);
      for (const control of [action, secondary]) {
        await control.scrollIntoViewIfNeeded();
        await expect(control, `${size}: each recovery control can be brought into view`).toBeInViewport();
      }
      await secondary.hover();
      await page.locator("#status").screenshot({ path: testInfo.outputPath(`permission-hover-card-${lang}-${scheme}-${size}.png`), animations: "disabled" });
      await page.mouse.move(0, 0);
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
    }
  });

  test(`U067-1 ${lang}/${scheme}: every tab at the default size draws text of at least 12px, controls of at least 24px`, async () => {
    await host.evaluate((h, args) => { h.theme(args.scheme); h.setSize(...h.SNAPSHOT_SIZES.default); h.pushModel({ type: "idle" }, { language: args.lang, library: h.library().state, recordingResults: [
      { id: "disk", occurredAt: new Date(Date.now() - 1800_000).toISOString(), code: "disk_full", detail: "ENOSPC", outcome: "partial", partialPath: "/tmp/partial.mp4", acknowledged: false },
      { id: "capture", occurredAt: new Date(Date.now() - 7200_000).toISOString(), code: "capture_start_failed", detail: "timed out", outcome: "empty", acknowledged: true }] }); }, { lang, scheme });
    for (const tab of TABS) {
      await page.locator(`#tab-${tab}`).click();
      if (tab === "failures") {
        const history = await measure(page);
        expect.soft(history, `${lang}/${tab}: history also stays readable and inside its panel`).toEqual({ small: [], tiny: [], outside: [] });
        await page.locator("#troubleshooting-tools-tab").click();
      }
      await page.waitForTimeout(120);
      const found = await measure(page);
      expect.soft(found.small, `U067-1 ${lang}/${scheme}/${tab}: no text below 12px`).toEqual([]);
      expect.soft(found.tiny, `U067-1 ${lang}/${scheme}/${tab}: no control below 24px`).toEqual([]);
      if (tab === "recording") {
        const menus = page.locator("#settings-panel").getByRole("combobox");
        expect(await menus.count(), "the full settings model includes menus to exercise").toBeGreaterThan(0);
        for (const id of await menus.evaluateAll(nodes => nodes.filter(node => (node as HTMLElement).checkVisibility()).map(node => node.id))) {
          const trigger = page.locator(`#${id}`);
          await trigger.hover();
          await page.waitForTimeout(200);
          await trigger.click();
          await expect(trigger).toHaveAttribute("aria-expanded", "true");
          await page.mouse.move(10, 400);
          await page.waitForTimeout(200);
          await page.screenshot({ path: test.info().outputPath(`select-open-${lang}-${scheme}-${id}.png`), animations: "disabled" });
          await page.keyboard.press("Escape");
          await expect(trigger).toHaveAttribute("aria-expanded", "false");
        }
      }
      if (tab === "failures") {
        await page.locator("#settings-data-cleanup-heading").hover();
        await page.waitForTimeout(200);
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
        expect.soft(history, `${lang}/${tab}: history also stays readable and inside its panel`).toEqual({ small: [], tiny: [], outside: [] });
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

test("U067-3 a file name format the app would refuse marks the field invalid and says why; Escape restores the saved one", async () => {
  await host.evaluate(h => { h.theme("light"); h.pushModel({ type: "idle" }, { language: "en" }); });
  await page.locator("#tab-recording").click();
  const field = page.locator("#setting-fileName");
  await field.fill("{date} {nonsense}");
  await expect.soft(field, "U067-3 the refused format is marked invalid").toHaveAttribute("aria-invalid", "true");
  await expect.soft(page.locator("#setting-fileName-note"), "U067-3 the note shows the reason").toBeVisible();
  await expect.soft(page.locator("#setting-fileName-note")).toHaveText(/\{date\}/);
  await field.press("Escape");
  const restored = await read<{ invalid: string | null; value: string }>(page, `({ invalid: document.getElementById("setting-fileName").getAttribute("aria-invalid"), value: document.getElementById("setting-fileName").value })`);
  expect.soft(restored, "U067-3 Escape restores the saved format and clears the mark").toEqual({ invalid: null, value: "{date} {time}" });
});

test("U067-0 both measurements detect a field's small value", async () => {
  await host.evaluate(h => { h.theme("light"); h.pushModel({ type: "idle" }, { language: "en" }); });
  await page.locator("#tab-recording").click();
  await read(page, `(() => { const field = document.createElement("input"); field.id = "probe-field"; field.value = "probe value";
    field.style.fontSize = "10px"; document.getElementById("settings-panel").prepend(field); })()`);
  expect((await measure(page)).small.some(entry => entry.startsWith("#probe-field"))).toBe(true);
  const gallery = await read<UiMeasurement>(page, MEASURE_UI);
  expect(gallery.texts.find(entry => entry.at === "#probe-field")?.size).toBe(10);
});

test("U070-1 a card's menu lists every action readably inside the window and Escape closes it", async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(...h.SNAPSHOT_SIZES.default); h.pushModel({ type: "idle" }, { language: "zh-TW", library: h.library().state }); });
  await page.locator("#tab-library").click();
  await page.locator(MORE).first().click();
  const menu = page.locator("#clip-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(4);
  for (const item of await menu.getByRole("menuitem").all()) await expect(item).toBeInViewport({ ratio: 1 });
  const measured = await read<UiMeasurement>(page, MEASURE_UI);
  expect.soft(measured.texts.filter(text => (text.at.startsWith("#clip-menu") || text.at.startsWith("clip-menu>")) && text.clipped),
    "U070-1 every menu item reads in full").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("U070-2 a settings menu follows focus-visible, preserves focus after selection and Escape closes only the menu", async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(...h.SNAPSHOT_SIZES.default); h.pushModel({ type: "idle" }, { language: "en" }); });
  await page.locator("#tab-recording").click();
  const trigger = page.locator("#setting-resolutionCap");
  await page.mouse.move(0, 0);
  const resting = await focusLook(trigger);
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect.soft(await read<boolean>(page, `document.visibilityState === "visible" && Boolean(document.getElementById("setting-resolutionCap"))`), "U070-2 Escape closes the menu and the window stays").toBe(true);
  await trigger.click();
  await page.getByRole("option", { selected: true }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  // Focus goes back to the menu once its sheet has closed.
  await expect.poll(() => read(page, `document.activeElement?.id`), { message: "U070-2 after pointer selection, the menu keeps focus" }).toBe("setting-resolutionCap");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();
  await expect.poll(async () => await trigger.evaluate(node => node.matches(":focus-visible")) && await focusLook(trigger) !== resting,
    { message: "U070-2 reached by the keyboard, the menu shows that it has focus" }).toBe(true);
});

for (const scheme of ["light", "dark"] as const) for (const layout of ["grid", "list"] as const) {
  test(`U070-3 ${scheme}/${layout}: recording card focus is visible, an arrival focuses the card, and pointer input still reaches it`, async ({}, testInfo) => {
    await host.evaluate((h, args) => {
      h.theme(args.scheme); h.setSize(...h.SNAPSHOT_SIZES.default);
      h.pushModel({ type: "idle" }, { language: "en", library: h.library().state, libraryLayout: args.layout });
    }, { scheme, layout });
    await page.locator("#tab-library").click();
    const card = page.locator('#library [id^="clip-"][data-id]').first(), open = card.locator('[id$="-open"]');
    await expect.poll(() => card.locator("img").evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.mouse.move(0, 0);
    const plain = await card.screenshot();
    await page.locator(MORE).first().focus();
    await page.keyboard.press("Shift+Tab");
    await expect(open, `U070-3 ${scheme}/${layout}: Shift+Tab from the menu button reaches the card`).toBeFocused();
    expect.soft(await open.evaluate(node => node.matches(":focus-visible"))).toBe(true);
    const focused = await card.screenshot({ path: testInfo.outputPath(`card-${scheme}-${layout}-focus.png`) });
    expect.soft(focused.equals(plain), "keyboard focus visibly changes the card").toBe(false);

    // A notification entry focuses the saved card after pointer input without playing it.
    await page.locator("#tab-library").click();
    await host.evaluate((h, layout) => {
      const view = h.settingsView({ type: "idle" }, { ...h.baseContext(), language: "en", library: h.library().state, libraryLayout: layout });
      h.push({ ...view, entryTab: "library", libraryFocus: view.library.items[0].id, resultFocus: Date.now() });
    }, layout);
    await expect(open).toBeFocused();
    await expect(page.locator("#player-close")).toBeHidden();
    await card.screenshot({ path: testInfo.outputPath(`card-${scheme}-${layout}-arrived.png`) });

    // Pointer input at the card's edge reaches the picture, and the card's menu still opens.
    const face = (await open.boundingBox())!;
    await page.mouse.click(face.x + 1, face.y + face.height / 2);
    await expect(page.locator("#player-close")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#player-close")).toBeHidden();
    await page.locator(MORE).first().click();
    await expect(page.locator("#clip-menu")).toBeVisible();
    await page.keyboard.press("Escape");
  });
}
