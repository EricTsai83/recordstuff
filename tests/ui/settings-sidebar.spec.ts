/**
 * The Settings sidebar at every window size (2026-10-21): full or collapsed, with and without a status card and an
 * unread troubleshooting item, nothing in it is cut off, overlaps or runs past the window; its icons keep one spacing
 * and one column; a notice dot sits on its icon's corner inside the tile; and the toggle opens and closes it from one
 * place clear of the macOS window controls. Design-agnostic: no sizes or colours, only what the user could reach and see.
 */
import { test, expect, type Launched } from "./fixtures";
import type { Page } from "@playwright/test";
import { read } from "./helpers";
import { TRAFFIC_LIGHT_ZONE } from "../../src/shared/window-controls";

let host: Launched, page: Page;
test.beforeEach(async ({ launchView }) => {
  ({ launched: host, page } = await launchView());
  await expect(page.locator("#setting-hotkey")).toBeVisible();
});

/** Window content sizes and zoom steps: the default, a wide but short window, the last zoom step, narrow and minimum. */
const SIZES = [
  { name: "default", width: 960, height: 640, zoom: 1 },
  { name: "wide-short", width: 800, height: 360, zoom: 1 },
  { name: "wide-zoomed", width: 960, height: 640, zoom: 1.5 },
  { name: "narrow", width: 560, height: 680, zoom: 1 },
  { name: "minimum", width: 380, height: 360, zoom: 1 },
  { name: "minimum-zoomed", width: 380, height: 360, zoom: 1.5 },
] as const;

/** One unread troubleshooting item, so Troubleshooting carries its count (full) or dot (collapsed). */
const unread = [{ id: "disk", occurredAt: new Date(Date.now() - 1800_000).toISOString(), code: "disk_full", detail: "ENOSPC",
  outcome: "partial", partialPath: "/tmp/partial.mp4", acknowledged: false }];

/** What is wrong with the sidebar as drawn now; an empty list when nothing is. */
const PROBLEMS = `(() => {
  const problems = [], box = el => el.getBoundingClientRect(), shown = el => el && el.checkVisibility() && box(el).width > 0;
  const inside = (b, o, slack = 0.5) => b.left >= o.left - slack && b.right <= o.right + slack && b.top >= o.top - slack && b.bottom <= o.bottom + slack;
  const view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const hit = el => { const b = box(el); return el.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); };
  if (document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight) problems.push("the page runs past the window");
  const list = document.getElementById("settings-tabs"), tabs = [...list.querySelectorAll('[role="tab"]')], listBox = box(list);
  if (!inside(listBox, view)) problems.push("the tabs run past the window " + JSON.stringify(listBox));
  // One spacing and one size for every tab, wherever a count or dot is shown, and every icon in one column.
  const steps = tabs.slice(1).map((tab, i) => tab.offsetTop - tabs[i].offsetTop);
  if (new Set(steps).size > 1) problems.push("the tabs' spacing differs: " + steps.join(","));
  if (new Set(tabs.map(tab => tab.offsetHeight)).size > 1) problems.push("the tabs' heights differ");
  if (new Set(tabs.map(tab => Math.round(box(tab.querySelector(".tab-icon")).left))).size > 1) problems.push("the icons are not in one column");
  // A notice dot sits on its icon's top-right corner, inside the control's tile; a count stays inside its tab.
  for (const dot of document.querySelectorAll("main .notice-dot")) {
    if (!shown(dot)) continue;
    const d = box(dot), icon = box(dot.parentElement.querySelector("svg")), tile = box(dot.closest("button"));
    if (Math.abs((d.left + d.right) / 2 - icon.right) > 4 || Math.abs((d.top + d.bottom) / 2 - icon.top) > 4) problems.push("a dot is off its icon's corner: " + dot.closest("button").id);
    if (!inside(d, tile)) problems.push("a dot runs past its tile: " + dot.closest("button").id);
  }
  for (const badge of document.querySelectorAll("main .tab-badge")) if (shown(badge) && !inside(box(badge), box(badge.closest('[role="tab"]')))) problems.push("a count runs past its tab");
  // The sidebar's foot and the status card are whole, inside the window, apart from the tabs and each other.
  const foot = document.getElementById("sidebar-about"), footBox = box(foot);
  if (!inside(footBox, view)) problems.push("the window actions run past the window " + JSON.stringify(footBox));
  if (footBox.top < listBox.bottom - 0.5) problems.push("the window actions overlap the tabs");
  for (const control of foot.querySelectorAll("button")) if (shown(control) && !hit(control)) problems.push("a window action is covered: " + control.id);
  const status = document.getElementById("status");
  if (shown(status)) {
    const card = box(status);
    if (!inside(card, view)) problems.push("the status card runs past the window " + JSON.stringify(card));
    if (!status.hasAttribute("data-popover") && (card.top < listBox.bottom - 0.5 || card.bottom > footBox.top + 0.5)) problems.push("the status card overlaps the tabs or the window actions");
    for (const control of status.querySelectorAll("button")) if (shown(control) && !hit(control)) problems.push("a status control is covered: " + control.id);
  }
  // Every tab can be reached: brought into view (the tabs scroll in a window too short for them), it takes the click.
  for (const tab of tabs) { tab.scrollIntoView({ block: "nearest" }); if (!inside(box(tab), listBox, 1) || !hit(tab)) problems.push("a tab cannot be reached: " + tab.id); }
  list.scrollTop = 0;
  return problems;
})()`;

for (const size of SIZES) {
  test(`the sidebar at ${size.name} (${size.width}×${size.height}, ${size.zoom * 100}%): full and collapsed, with a status card and an unread item, nothing is cut off or overlaps, the icons keep one spacing`, { tag: "@layout" }, async () => {
    for (const state of [{ type: "idle" }, { type: "needsPermission", needsRelaunch: false }] as const) {
      await host.evaluate((h, args) => {
        h.theme("light");
        h.window().webContents.setZoomFactor(args.size.zoom);
        h.setContentSize(args.size.width, args.size.height);
        h.pushModel(args.state, { recordingResults: args.unread });
      }, { size, state, unread });
      const toggle = page.locator("#sidebar-toggle"), main = page.locator("main");
      await page.waitForTimeout(150);
      const wide = await toggle.isVisible();
      // Under 600 px wide or at 420 px tall or less there is no room for the full sidebar: it stays collapsed, without the
      // toggle.
      const roomy = size.width / size.zoom >= 600 && size.height / size.zoom > 420;
      expect(wide, `${size.name}: the toggle is offered only where the full sidebar has room`).toBe(roomy);
      if (!wide) await expect(main, `${size.name}: a narrow or short window keeps the collapsed sidebar`).toHaveAttribute("data-sidebar", "collapsed");
      for (const mode of wide ? ["full", "collapsed"] as const : ["collapsed"] as const) {
        const key = `${size.name}/${state.type}/${mode}`;
        if (wide && (await toggle.getAttribute("aria-expanded") === "true") !== (mode === "full")) await toggle.click();
        if (mode === "collapsed") await expect(main).toHaveAttribute("data-sidebar", "collapsed");
        else await expect(main).not.toHaveAttribute("data-sidebar", "collapsed");
        await page.mouse.move(1, innerHeightOf(size) - 1);
        await page.waitForTimeout(120);
        expect.soft(await read<string[]>(page, PROBLEMS), `${key}: the sidebar is whole`).toEqual([]);
        if (mode === "collapsed" && state.type !== "idle") {
          // The bell opens the card beside it, whole and inside the window, and Escape gives the focus back.
          const bell = page.locator("#status-bell");
          await expect(bell, `${key}: the status card is a bell`).toBeVisible();
          await bell.click();
          await expect(page.locator("#status")).toBeVisible();
          expect.soft(await read<string[]>(page, PROBLEMS), `${key}: the bell's card is whole`).toEqual([]);
          await page.keyboard.press("Escape");
          await expect(page.locator("#status")).toBeHidden();
          await expect(bell).toBeFocused();
        }
        if (wide) {
          // The toggle takes the click where it is drawn, in the same place in either state, clear of the macOS window
          // controls' corner at any zoom.
          const at = await read<{ hit: boolean; left: number; top: number; bottom: number }>(page, `(el => { const b = el.getBoundingClientRect();
            return { hit: el.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)), left: b.left, top: b.top, bottom: b.bottom }; })(document.getElementById("sidebar-toggle"))`);
          expect.soft(at.hit, `${key}: the toggle takes the click`).toBe(true);
          if (process.platform === "darwin") expect.soft(at.left * size.zoom, `${key}: the toggle clears the window controls' corner`).toBeGreaterThanOrEqual(TRAFFIC_LIGHT_ZONE.width);
        }
      }
    }
  });
}

/** The fixture's window content height at a size, in page pixels. */
function innerHeightOf(size: (typeof SIZES)[number]): number {
  return Math.floor(size.height / size.zoom);
}

test("the sidebar toggle opens and closes it by pointer and keyboard from one place, and only a wide window offers it", { tag: "@layout" }, async () => {
  await host.evaluate(h => { h.theme("light"); h.setContentSize(960, 640); h.pushModel({ type: "idle" }); });
  const toggle = page.locator("#sidebar-toggle"), main = page.locator("main");
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  const place = await toggle.boundingBox();
  await toggle.click();
  await expect(main).toHaveAttribute("data-sidebar", "collapsed");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await toggle.boundingBox(), "the toggle stays in place").toEqual(place);
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(main).not.toHaveAttribute("data-sidebar", "collapsed");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Space");
  await expect(main).toHaveAttribute("data-sidebar", "collapsed");
  // Every tab still opens its page from the collapsed sidebar.
  for (const id of ["studio", "recording", "general", "shortcuts", "failures", "library"]) {
    await page.locator(`#tab-${id}`).click();
    await expect(page.locator(`#tab-${id}`)).toHaveAttribute("aria-selected", "true");
  }
  await host.evaluate(h => h.setContentSize(560, 680));
  await expect(toggle, "a narrow window has no toggle").toBeHidden();
  await expect(main).toHaveAttribute("data-sidebar", "collapsed");
  await host.evaluate(h => h.setContentSize(960, 400));
  await expect(toggle, "a short window has no toggle").toBeHidden();
  await expect(main).toHaveAttribute("data-sidebar", "collapsed");
  await host.evaluate(h => h.setContentSize(960, 640));
  await expect(toggle).toBeVisible();
});

test("the sidebar toggle stays in place while the window's width changes, at any zoom", { tag: "@layout" }, async () => {
  for (const zoom of [1, 1.5]) {
    await host.evaluate((h, factor) => { h.window().webContents.setZoomFactor(factor); h.setContentSize(960, 640); h.pushModel({ type: "idle" }); }, zoom);
    const toggle = page.locator("#sidebar-toggle");
    await expect(toggle).toBeVisible();
    // The zoom reaches the page a moment after it is set: the place is read once the page lays out at it.
    await expect.poll(() => read<number>(page, `Number(document.documentElement.style.getPropertyValue("--page-zoom"))`)).toBeCloseTo(zoom, 3);
    const place = await toggle.boundingBox();
    // Each width is read straight after the resize, before it settles, as a live resize draws it.
    for (const width of [940, 900, 1000, 920, 1040, 960]) {
      const left = await host.evaluate(async (h, w) => {
        h.setContentSize(w, 640);
        return h.window().webContents.executeJavaScript(`new Promise(done => requestAnimationFrame(() => done(document.getElementById("sidebar-toggle").getBoundingClientRect().left)))`) as Promise<number>;
      }, width);
      expect.soft(left, `${zoom * 100}%, ${width} wide: the toggle stays in place`).toBe(place!.x);
    }
  }
});
