/**
 * Component interactions on the production settings page and preload against the view host's synthetic view
 * (hosts/view-host.ts, `components` mode): input, geometry and DOM focus. Formerly tests/ui/fixture.cjs.
 */
import { test, expect, type Launched } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import type { SettingsBridge, SettingsView } from "../../src/shared/settings-panel";
import fs from "node:fs/promises";
import path from "node:path";

let host: Launched, page: Page;
test.beforeEach(async ({ launchView }) => {
  ({ launched: host, page } = await launchView({ mode: "components" }));
  await expect(page.getByRole("tab", { name: "Recordings", exact: true })).toBeVisible();
});
const setView = (view: SettingsView): Promise<void> => host.evaluate((h, next) => h.setView(next), view);
/** The live zoom notice: Sonner's current toast holding the zoom control group (a leaving copy is inert). */
const zoomNotice = (): Locator =>
  page.locator('[data-sonner-toast]:not([data-removed="true"]):not([inert])').filter({ has: page.getByRole("group") });
/** Waits until an entering element stops moving, whatever its entrance animation. */
const settled = (target: Locator): Promise<void> => expect.poll(async () => {
  const before = await target.boundingBox();
  await new Promise(resolve => setTimeout(resolve, 50));
  const after = await target.boundingBox();
  return Boolean(before && after && before.x === after.x && before.y === after.y);
}).toBe(true);
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Focus is visible in some form (an outline or shadow on the control or a close wrapper), whatever its style. */
const showsFocus = (control: Locator): Promise<boolean> => control.evaluate((node) => {
  for (let element: Element | null = node, depth = 0; element && depth < 3; element = element.parentElement, depth++) {
    const style = getComputedStyle(element);
    if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) return true;
    if (style.boxShadow !== "none") return true;
  }
  return false;
});
test("zoom notification reflects applied zoom and dismisses automatically without stealing entry focus", async ({}, testInfo) => {
  // Install before reloading so every page timer uses the same clock. Keep assertion/CI time out of
  // the notice's 1.5 s lifetime; CSS transitions and Playwright pointer/keyboard input remain real.
  await page.clock.install({ time: new Date("2026-10-08T12:00:00Z") });
  await page.reload();
  const tab = page.getByRole("tab", { name: "Recordings", exact: true });
  await expect(tab).toBeVisible();
  await page.clock.pauseAt(new Date("2026-10-08T12:01:00Z"));
  const advance = async (ms: number) => {
    await page.clock.runFor(ms);
    // Sonner publishes the hook's presence changes with a zero-delay timer.
    await page.clock.runFor(1);
  };
  await tab.focus();
  await host.evaluate(h => h.zoom("in"));
  await advance(50);
  const notice = zoomNotice();
  await expect(notice).toContainText("110%");
  await expect(tab).toBeFocused();
  // Mounted starts Sonner's entrance; wait for the toast to stop moving before hovering.
  // During entrance the toast can still be above the window, over the macOS drag strip.
  await expect(notice).toHaveAttribute("data-mounted", "true");
  await settled(notice);
  await notice.hover();
  await advance(1700);
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Reset", exact: true }).focus();
  await page.mouse.move(10, 400);
  await advance(1700);
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Zoom In", exact: true }).click();
  await advance(50);
  await expect(notice).toContainText("125%");
  expect(await host.evaluate(h => h.window().webContents.getZoomFactor())).toBe(1.25);
  await notice.getByRole("button", { name: "Zoom In", exact: true }).click();
  await advance(50);
  await expect(notice).toContainText("150%");
  await expect(notice.getByRole("button", { name: "Zoom In", exact: true })).toBeDisabled();
  await notice.getByRole("button", { name: "Reset", exact: true }).click();
  await advance(50);
  await expect(notice).toContainText("100%");
  await notice.getByRole("button", { name: "Zoom Out", exact: true }).click();
  await advance(50);
  await expect(notice).toContainText("90%");
  await notice.getByRole("button", { name: "Zoom Out", exact: true }).click();
  await advance(50);
  await expect(notice).toContainText("80%");
  await expect(notice.getByRole("button", { name: "Zoom Out", exact: true })).toBeDisabled();
  await notice.getByRole("button", { name: "Reset", exact: true }).click();
  await advance(50);
  await expect(notice).toContainText("100%");
  await notice.screenshot({ path: testInfo.outputPath("zoom-toast.png") });
  const reset = notice.getByRole("button", { name: "Reset", exact: true });
  await reset.hover();
  await expect(reset).toBeFocused();
  await advance(1700);
  await expect(notice).toBeVisible();
  // Leave both pointer and focus on the clicked button, just as a person waiting would.
  await advance(3200);
  await expect(notice).toBeVisible();
  await advance(100);
  await expect(notice).toHaveCount(0);
  await expect(tab).toBeFocused();
  await page.mouse.move(10, 400);
  await host.evaluate(h => h.zoom("in"));
  await advance(50);
  await expect(notice).toContainText("110%");
  await notice.getByRole("button", { name: "Reset", exact: true }).focus();
  await page.keyboard.press("Escape");
  await advance(1);
  await expect(notice).toHaveCount(0);
  await expect(tab).toBeFocused();
  await page.mouse.move(10, 400);
  await host.evaluate(h => h.zoom("in"));
  await advance(50);
  await expect(notice).toContainText("125%");
  await advance(1400);
  await expect(notice).toBeVisible();
  await advance(50);
  await expect(notice).toHaveCount(0);
  await expect(tab).toBeFocused();
});
for (const language of ["en", "zh-TW"] as const) {
  test(`zoom notification ${language} fits the minimum window at every zoom limit with its controls unclipped and uncovered`, async ({}, testInfo) => {
    const view = await page.evaluate(() => (window as unknown as { settings: SettingsBridge }).settings.read());
    await host.evaluate((h, args) => {
      h.setSize(...h.SNAPSHOT_SIZES.minimum);
      h.setView({ ...args.view, language: args.language });
    }, { language, view });
    const notice = zoomNotice();
    for (const factor of [0.8, 1, 1.5]) {
      await host.evaluate((h, target) => {
        h.zoom("reset");
        if (target === 0.8) { h.zoom("out"); h.zoom("out"); }
        if (target === 1.5) { h.zoom("in"); h.zoom("in"); h.zoom("in"); }
      }, factor);
      await expect(notice).toContainText(`${Math.round(factor * 100)}%`);
      await notice.hover();
      const geometry = await notice.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const elements = [...node.querySelectorAll('[role="status"], button')].map((element) => {
          const box = element.getBoundingClientRect();
          return { x: box.left, y: box.top, width: box.width, height: box.height };
        });
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewport: innerWidth, elements };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
      for (const [index, box] of geometry.elements.entries()) {
        expect(box.x).toBeGreaterThanOrEqual(geometry.left);
        expect(box.x + box.width).toBeLessThanOrEqual(geometry.right);
        expect(box.y).toBeGreaterThanOrEqual(geometry.top);
        expect(box.y + box.height).toBeLessThanOrEqual(geometry.bottom);
        for (const other of geometry.elements.slice(index + 1)) expect(overlaps(box, other)).toBe(false);
      }
      await expect(notice.getByRole("button", { name: language === "en" ? "Reset" : "重設", exact: true })).toBeVisible();
      const screenshotPath = testInfo.outputPath(`zoom-${language}-${Math.round(factor * 100)}.png`);
      if (factor === 1) await notice.screenshot({ path: screenshotPath });
      else {
        // Chromium's locator clip uses unscaled coordinates at Electron zoom; retain the complete rendered frame instead.
        const frame = await host.evaluate(async h => (await h.window().webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString("base64"));
        await fs.writeFile(screenshotPath, Buffer.from(frame, "base64"));
      }
    }
  });
}
test("tabs, switch and icon segments retain their names, keyboard navigation and committed values", async () => {
  await page.getByRole("tab", { name: "Recording settings" }).click();
  const sound = page.getByRole("switch", { name: "Countdown sound" });
  await expect(sound).toBeChecked();
  await sound.click();
  await expect(sound).not.toBeChecked();
  await page.getByRole("tab", { name: "General", exact: true }).click();
  const dark = page.getByRole("button", { name: "Dark", exact: true });
  await dark.click();
  await expect(dark).toHaveAttribute("aria-pressed", "true");
  const general = page.getByRole("tab", { name: "General", exact: true });
  await general.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("tab", { name: "Troubleshooting (1)" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
test("failure rows open independently and acknowledgement collapses with focus returned", async () => {
  await page.getByRole("tab", { name: "Troubleshooting (1)" }).click();
  const headers = page.locator('[id^="recording-result-"][id$="-summary"]');
  const header = headers.first();
  await headers.nth(1).click();
  await expect(headers.nth(1)).toHaveAttribute("aria-expanded", "true");
  await header.focus();
  await page.keyboard.press("Enter");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(header).toBeFocused();
  await expect(headers.nth(1)).toHaveAttribute("aria-expanded", "true");
});
test("menu keyboard selection opens Rename and a committed rename returns focus to its card", async () => {
  const trigger = page.getByRole("button", {
    name: "More actions for a",
    exact: true,
  });
  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("r");
  await expect(page.getByRole("menuitem", { name: "Rename…" })).toBeFocused();
  await page.keyboard.press("Enter");
  const field = page.getByRole("textbox", { name: "Rename", exact: true });
  await expect(field).toBeFocused();
  await field.fill("Demo");
  await field.press("Enter");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator("#clip-a-renamed-open")).toBeFocused();
  await expect(page.locator("#feedback")).toContainText("Renamed to Demo.mp4");
});
async function explanationAt(left: number, top: number, height = 30) {
  await host.evaluate(h => h.setContentSize(560, 340));
  await page.getByRole("tab", { name: "Recording settings" }).click();
  const button = page.locator("#setting-countdownSound-info-button");
  await button.evaluate(
    (element, at) =>
      Object.assign(element.style, {
        position: "fixed",
        left: `${at.left}px`,
        top: `${at.top}px`,
        width: "20px",
        height: "20px",
        zIndex: "100",
      }),
    { left, top },
  );
  await button.hover();
  const popup = page.locator("#setting-countdownSound-info-popup");
  await expect(popup).toBeVisible();
  await popup.evaluate(
    (element, h) =>
      Object.assign(element.style, {
        width: "180px",
        height: `${h}px`,
        maxHeight: "calc(100vh - 16px)",
      }),
    height,
  );
  const rect = async () => {
    const box = await popup.boundingBox();
    if (!box) throw new Error("Explanation is missing");
    return box;
  };
  /** Inside the 560 × 340 window and, when there is room for it, clear of the button it explains. */
  const placed = async (clearOfButton = true): Promise<boolean> => {
    const r = await rect(), b = await button.boundingBox();
    if (!b) throw new Error("Explanation trigger is missing");
    const inside = r.x >= 0 && r.y >= 0 && r.x + r.width <= 560 && r.y + r.height <= 340;
    return inside && (!clearOfButton || !overlaps(r, b));
  };
  return { button, popup, rect, placed };
}
test.describe("an ⓘ explanation's placement (ported from the former placement unit tests)", () => {
  test("near the bottom of the window it stays inside the window without covering its button", async () => {
    const { placed } = await explanationAt(96, 278);
    await expect.poll(() => placed()).toBe(true);
  });
  test("near the top it stays clear of its button, and inside the window when it cannot avoid it", async () => {
    const { popup, placed } = await explanationAt(96, 12);
    await expect.poll(() => placed()).toBe(true);
    await popup.evaluate((element) => (element.style.height = "320px"));
    await expect.poll(() => placed(false)).toBe(true);
  });
  test("stays inside the window's side edges, the pointer path from the button still keeping it open", async () => {
    const { button, rect, placed } = await explanationAt(500, 278);
    await expect.poll(() => placed()).toBe(true);
    // The original geometry case also asserted the bridge over the trigger.
    // Exercise that behavior at each clamped edge, with a pause longer than the leave delay.
    const pauseInGap = async () => {
      const b = await button.boundingBox();
      if (!b) throw new Error("Explanation trigger is missing");
      await button.hover();
      const r = await rect();
      // Step off the button towards the explanation, whichever side it opened on.
      await page.mouse.move(b.x + b.width / 2, r.y + r.height <= b.y ? b.y - 1 : b.y + b.height + 1);
      await page.waitForTimeout(180);
      await expect(page.locator("#setting-countdownSound-info-popup")).toBeVisible();
    };
    await pauseInGap();
    await button.evaluate((element) => (element.style.left = "2px"));
    // Moving the trigger leaves the pointer behind; open it at its new position before measuring the popup.
    await button.hover();
    await expect(page.locator("#setting-countdownSound-info-popup")).toBeVisible();
    await expect.poll(() => placed()).toBe(true);
    await pauseInGap();
  });
});
test("player slider drag, fixed seek keys and volume controls keep their accessible value text", async () => {
  await page.locator("#clip-a-open").click();
  await page.getByRole("dialog").locator("video").evaluate((element) => {
    const video = element as HTMLVideoElement;
    Object.defineProperties(video, {
      duration: { value: 60, configurable: true },
      paused: { value: true, configurable: true },
    });
    video.currentTime = 0;
    video.volume = 0.5;
    video.dispatchEvent(new Event("durationchange"));
  });
  const seek = page.getByRole("slider", { name: "Playback position" });
  await seek.focus();
  await seek.press("ArrowRight");
  await expect(seek).toHaveAttribute("aria-valuetext", "0:05 / 1:00");
  await seek.press("PageUp");
  await expect(seek).toHaveAttribute("aria-valuetext", "0:15 / 1:00");
  const track = await page.locator('#player-seek [data-slot="slider-track"]').boundingBox();
  if (!track) throw new Error("Seek bar is missing");
  await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    track.x + track.width * 0.75,
    track.y + track.height / 2,
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      page
        .getByRole("dialog")
        .locator("video")
        .evaluate((element) => (element as HTMLVideoElement).currentTime),
    )
    .toBeCloseTo(45, 0);
  await page.getByRole("button", { name: "Mute", exact: true }).focus();
  const volume = page.getByRole("slider", { name: "Volume" });
  await volume.focus();
  await volume.press("ArrowDown");
  await expect(volume).toHaveAttribute("aria-valuetext", "45%");
  await seek.press("ArrowUp");
  await expect(volume).toHaveAttribute("aria-valuetext", "50%");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#player-seek")).toBeHidden();
  await expect(page.locator("#clip-a-open")).toBeFocused();
  await page.getByRole("button", { name: "More actions for a", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
});
test("a menu on a partly clipped card stays inside the window and pointer hover takes the keyboard highlight", async () => {
  const trigger = page.locator("#clip-a-more");
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const open = page.getByRole("menuitem", { name: "Open", exact: true });
  await open.hover();
  await expect(open).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.evaluate((element) =>
    Object.assign(element.style, {
      position: "fixed",
      top: "-10px",
      left: "2px",
      opacity: "1",
    }),
  );
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu).toBeVisible();
  await expect
    .poll(async () => {
      const r = await menu.boundingBox(),
        viewport =
          page.viewportSize() ??
          (await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
          })));
      return Boolean(
        r &&
        r.x >= 0 &&
        r.y >= 0 &&
        r.x + r.width <= viewport.width &&
        r.y + r.height <= viewport.height,
      );
    })
    .toBe(true);
});

test("long settings content scrolls inside its panel without overflowing the window", async () => {
  const view = await page.evaluate(() => (window as unknown as { settings: SettingsBridge }).settings.read());
  view.groups = Array.from({ length: 20 }, (_, index) => ({
    ...view.groups[0]!,
    id: `long-${index}`,
    label: `Setting ${index}`,
  }));
  await setView(view);
  await page.getByRole("tab", { name: "Recording settings" }).click();
  const size = await page.evaluate(() => {
    const panel = document.getElementById("settings-panel")!;
    return {
      outer: document.documentElement.scrollHeight,
      window: innerHeight,
      scroll: panel.scrollHeight,
      panel: panel.clientHeight,
    };
  });
  expect(size.scroll).toBeGreaterThan(size.panel);
  expect(size.outer).toBeLessThanOrEqual(size.window);
});

for (const language of ["en", "zh-TW"] as const) {
  test(`local data cleanup shows its scope in ${language}, stays disabled during capture and sends one offered choice`, async () => {
    const current = await page.evaluate(() => (window as unknown as { settings: SettingsBridge }).settings.read());
    const group = {
      id: "localData", tab: "failures" as const, section: "cleanup", kind: "actions" as const, enabled: false,
      label: language === "en" ? "Local app data" : "本機 App 資料",
      note: language === "en" ? "Clears settings, failure history, cache, logs and old backups. Recordings are kept." : "清除設定、失敗紀錄、快取、log 與舊備份，錄影檔會保留。",
      choices: [{ id: "clear", label: language === "en" ? "Clear and quit…" : "清除並結束…", enabled: false, checked: false }],
    };
    const view = { ...current, language, groups: [...current.groups, group] };
    await setView(view as SettingsView);
    await page.locator("#tab-failures").click();
    await page.locator("#troubleshooting-tools-tab").click();
    const control = page.getByRole("button", { name: group.choices[0]!.label, exact: true });
    await expect(control).toBeDisabled();
    await expect(page.locator("#setting-localData-note")).toContainText(language === "en" ? "Recordings are kept" : "錄影檔會保留");
    group.enabled = true; group.choices[0]!.enabled = true;
    await setView(view as SettingsView);
    await control.click();
    expect(await host.evaluate(h => h.chooseCalls.filter(([group, value]: [string, unknown]) => group === "localData" && value === "clear").length)).toBe(1);
    await expect(page.locator("#feedback")).not.toContainText("Could not");
  });
}

test("the Electron cleanup helper waits for normal quit and removes the final profile files while retaining recordings", async () => {
  const data = host.data, profile = path.join(data, "profile"), output = path.join(data, "videos");
  await fs.mkdir(output); await fs.writeFile(path.join(output, "kept.mp4"), "user recording");
  await fs.writeFile(path.join(profile, "recording-result.json"), "old history");
  await fs.writeFile(path.join(profile, "settings.json.migration-backup"), "old settings");
  await host.evaluate((h, paths) => { void h.cleanup(paths); }, { profile, output, logs: path.join(data, "logs") });
  await expect.poll(async () => {
    try { await fs.access(profile); return false; } catch { return true; }
  }, { timeout: 10_000 }).toBe(true);
  await expect.poll(() => host.child.exitCode, { timeout: 10_000 }).toBe(0);
  await new Promise(resolve => setTimeout(resolve, 500));
  await expect(fs.access(profile)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(output, "kept.mp4"), "utf8")).toBe("user recording");
});


test("shadcn tooltips name icon controls on hover and focus, update language, and reveal clipped recording titles", async ({}, testInfo) => {
  await page.getByRole("tab", { name: "General", exact: true }).click();
  const dark = page.locator("#setting-appearance-dark");
  await dark.hover();
  // Base UI 1.8 treats Tooltip as a visual label; controls own their accessible names.
  const tip = page.locator('[data-slot="tooltip-content"][data-open]');
  await expect(tip).toHaveText("Dark");
  await dark.focus();
  await expect(dark).toBeFocused();
  await expect(tip).toHaveText("Dark");
  await page.screenshot({ path: testInfo.outputPath("appearance-tooltip.png"), animations: "disabled" });
  const current = await page.evaluate(() => (window as unknown as { settings: SettingsBridge }).settings.read());
  const appearance = current.groups.find(group => group.id === "appearance")!;
  await setView({ ...current, language: "zh-TW", groups: current.groups.map(group => group === appearance ? {
    ...group, choices: group.choices.map(choice => ({ ...choice, label: { system: "跟隨系統", light: "淺色", dark: "深色" }[choice.id] ?? choice.label })),
  } : group) });
  await expect(tip).toHaveText("深色");
  await expect(dark).toHaveAccessibleName("深色");
  await page.mouse.move(10, 400);
  await page.locator("#tab-library").click();
  await expect(tip).toBeHidden();
  const clip = page.locator("#clip-a-open"), titleOf = (text: string): Locator => clip.getByText(text.trim(), { exact: true });
  await clip.hover();
  await page.waitForTimeout(1700);
  await expect(tip).toHaveCount(0);
  await clip.focus();
  await expect(clip).toBeFocused();
  await expect(tip).toHaveCount(0);
  const longTitle = "Recording with a very long descriptive title ".repeat(8);
  const library = current.library!;
  await setView({ ...current, library: { ...library, items: library.items.map(item => item.id === "a" ? { ...item, title: longTitle } : item) } });
  let title = titleOf(longTitle);
  await expect(title).toBeVisible();
  await page.mouse.move(10, 400);
  // Pointing at the card away from its title does not name it.
  await clip.hover({ position: { x: 24, y: 24 } });
  await page.waitForTimeout(800);
  await expect(tip).toHaveCount(0);
  await title.hover();
  await page.waitForTimeout(800);
  await expect(tip).toHaveCount(0);
  // However the card shows a title this long, it cannot show all of it; the tooltip gives the complete name.
  const clipped = (node: Element): boolean => node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight;
  await expect.poll(() => title.evaluate(clipped)).toBe(true);
  await expect(tip).toHaveText(longTitle.trim());
  const expectInsideWindow = async (): Promise<void> => {
    // Text appears before the tooltip's entrance has settled.
    await expect.poll(async () => {
      const box = await tip.boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      return Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
    }, { message: "The tooltip settles inside the window" }).toBe(true);
  };
  await expectInsideWindow();
  await page.screenshot({ path: testInfo.outputPath("recording-grid-tooltip.png"), animations: "disabled" });
  await page.locator("#library-layout-list").click();
  await title.hover();
  await expect.poll(() => title.evaluate(clipped)).toBe(true);
  await expect(tip).toHaveText(longTitle.trim());
  await expectInsideWindow();
  // A resize under the pointer is remeasured on movement, without another pointer entry.
  const resizeTitle = "Recording title that fits in a wider list row";
  await host.evaluate(h => h.setSize(...h.SNAPSHOT_SIZES.minimum));
  await setView({ ...current, library: { ...library, layout: "list", items: library.items.map(item => item.id === "a" ? { ...item, title: resizeTitle } : item) } });
  title = titleOf(resizeTitle);
  await page.mouse.move(10, 20);
  await title.hover({ position: { x: 10, y: 8 } });
  await expect(tip).toHaveText(resizeTitle);
  await host.evaluate(h => h.setSize(1200, 600));
  await expect.poll(() => title.evaluate(node => !(node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight))).toBe(true);
  const box = await title.boundingBox();
  if (!box) throw new Error("Recording title is missing");
  await page.mouse.move(box.x + 12, box.y + 8);
  await expect(tip).toHaveCount(0);
  await host.evaluate(h => h.setSize(...h.SNAPSHOT_SIZES.minimum));
  // With no hint for a complete name, start a fresh hover after it is clipped again.
  await page.mouse.move(10, 400);
  await title.hover();
  await expect(tip).toHaveText(resizeTitle);
  await page.screenshot({ path: testInfo.outputPath("recording-tooltip.png"), animations: "disabled" });
  const unbroken = "Recording".repeat(30);
  await setView({ ...current, library: { ...library, layout: "list", items: library.items.map(item => item.id === "a" ? { ...item, title: unbroken } : item) } });
  title = titleOf(unbroken);
  await title.hover();
  await expect(tip).toHaveText(unbroken);
  expect(await tip.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test("a new zoom notice keeps focus ownership when the previous notice finishes leaving", async () => {
  const tab = page.locator("#tab-library");
  const notice = zoomNotice();
  await tab.focus();
  await host.evaluate(h => h.zoom("in"));
  await notice.getByRole("button", { name: "Reset", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(tab).toBeFocused();
  await host.evaluate(h => h.zoom("in"));
  await expect(notice).toContainText("125%");
  const reset = notice.getByRole("button", { name: "Reset", exact: true });
  await reset.focus();
  await expect(reset).toBeFocused();
  // The old toast has left by now; focus on the new one still pauses its 1.5 s deadline.
  await page.waitForTimeout(1700);
  await expect(reset).toBeFocused();
  await expect(notice).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tab).toBeFocused();
  await expect(notice).toBeHidden();
});

test("narrow tab tooltips keep the same focused control when the window widens", async () => {
  await host.evaluate(h => h.setSize(380, 360));
  const tab = page.locator("#tab-general");
  await tab.hover();
  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText("General");
  await tab.focus();
  await expect(tab).toBeFocused();
  await host.evaluate(h => h.setSize(960, 640));
  await expect(tab).toBeFocused();
});

test("context menu opens at the pointer, shares file actions, and restores focus after Escape and rename", async ({}, testInfo) => {
  const card = page.locator("#clip-a");
  await card.click({ button: "right", position: { x: 30, y: 40 } });
  const menu = page.locator("#clip-context-menu");
  await expect(menu).toBeVisible();
  const mac = process.platform === "darwin";
  const actions = [mac ? "Show in Finder" : "Open folder", "Open", "Rename…", mac ? "Move to Trash" : "Move to Recycle Bin"];
  await expect(menu.getByRole("menuitem")).toHaveCount(actions.length);
  expect((await menu.getByRole("menuitem").allTextContents()).map(text => text.trim()).sort()).toEqual([...actions].sort());
  await expect(page.locator("#clip-a-more")).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: testInfo.outputPath("recording-context-menu.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.locator("#clip-a-more")).toBeFocused();
  await card.click({ button: "right", position: { x: 30, y: 40 } });
  await menu.getByRole("menuitem", { name: "Rename…", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Rename", exact: true });
  await expect(field).toBeFocused();
  await expect(page.getByRole("dialog").getByText(".mp4", { exact: true })).toBeVisible();
  expect(await showsFocus(field), "the focused rename field shows focus").toBe(true);
  await page.screenshot({ path: testInfo.outputPath("rename-input-group.png"), animations: "disabled" });
  await field.fill("Context menu recording");
  await field.press("Enter");
  await expect(page.locator("#clip-a-renamed-open")).toBeFocused();
  await expect(page.locator("#feedback")).toContainText("Renamed to Context menu recording.mp4");
});

test("sidebar tabs, library layout and primary actions keep their selection semantics, keyboard operation and visible focus", async ({}, testInfo) => {
  const tab = page.locator("#tab-library"), general = page.locator("#tab-general");
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await general.click();
  await expect(general).toHaveAttribute("aria-selected", "true");
  await expect(tab).toHaveAttribute("aria-selected", "false");
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await tab.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(tab).toBeFocused();
  expect(await showsFocus(tab), "the keyboard-focused tab shows focus").toBe(true);
  await page.screenshot({ path: testInfo.outputPath("sidebar-selected.png"), animations: "disabled" });
  await host.evaluate(h => h.setSize(...h.SNAPSHOT_SIZES.narrow));
  await page.mouse.move(10, 400);
  await general.click();
  await expect(general).toHaveAttribute("aria-selected", "true");
  await general.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#tab-recording")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: testInfo.outputPath("narrow-selected.png"), animations: "disabled" });
  await host.evaluate(h => h.setSize(...h.SNAPSHOT_SIZES.default));
  for (const layout of ["grid", "list"] as const) {
    const layoutButton = page.locator(`#library-layout-${layout}`);
    if (layout === "list") {
      await layoutButton.focus();
      await page.keyboard.press("Space");
    } else await layoutButton.click();
    await expect(layoutButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(`#library-layout-${layout === "grid" ? "list" : "grid"}`)).toHaveAttribute("aria-pressed", "false");
  }
  await page.locator("#tab-recording").click();
  const on = page.getByRole("switch", { name: "Countdown sound" });
  await expect(on).toBeChecked();
  await on.evaluate(node => { node.focus(); });
  await page.keyboard.press("Tab");
  expect(await showsFocus(page.locator(":focus")), "the next control reached by Tab shows focus").toBe(true);
  await page.locator("#tab-library").click();
  await page.locator("#clip-a").click({ button: "right", position: { x: 30, y: 40 } });
  await page.locator("#clip-context-menu").getByRole("menuitem", { name: "Rename…", exact: true }).click();
  await page.locator("#clip-rename-input").fill("Readable primary action");
  await expect(page.locator("#clip-rename-confirm")).toBeEnabled();
  await page.keyboard.press("Escape");
});
