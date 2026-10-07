/**
 * Component interactions on the production settings page and preload against the view host's synthetic view
 * (hosts/view-host.ts, `components` mode): input, geometry and DOM focus. Formerly tests/ui/fixture.cjs.
 */
import { test, expect, type Launched } from "./fixtures";
import type { Page } from "@playwright/test";
import type { SettingsBridge, SettingsView } from "../../src/shared/settings-panel";
import fs from "node:fs/promises";
import path from "node:path";

let host: Launched, page: Page;
test.beforeEach(async ({ launchView }) => {
  ({ launched: host, page } = await launchView({ mode: "components" }));
  await expect(page.getByRole("tab", { name: "Recordings", exact: true })).toBeVisible();
});
const setView = (view: SettingsView): Promise<void> => host.evaluate((h, next) => h.setView(next), view);
test("zoom notification reflects applied zoom, has no close button, and dismisses automatically without stealing entry focus", async ({}, testInfo) => {
  const tab = page.getByRole("tab", { name: "Recordings", exact: true });
  await tab.focus();
  await host.evaluate(h => h.zoom("in"));
  const notice = page.locator('.zoom-notice:not([data-removed="true"]):not([inert]) .zoom-toast');
  await expect(notice).toContainText("110%");
  await expect(notice.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
  await expect(tab).toBeFocused();
  // Sonner renders the text before sliding the toast into the viewport. Hover only its settled position.
  const notification = page.locator('.zoom-notice:not([data-removed="true"]):not([inert])');
  await expect(notification).toHaveAttribute("data-mounted", "true");
  await expect(notification).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await notice.hover();
  await page.waitForTimeout(1700);
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Reset", exact: true }).focus();
  await page.mouse.move(10, 400);
  await page.waitForTimeout(1700);
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Zoom In", exact: true }).click();
  await expect(notice).toContainText("125%");
  expect(await host.evaluate(h => h.window().webContents.getZoomFactor())).toBe(1.25);
  await notice.getByRole("button", { name: "Zoom In", exact: true }).click();
  await expect(notice).toContainText("150%");
  await expect(notice.getByRole("button", { name: "Zoom In", exact: true })).toBeDisabled();
  await notice.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(notice).toContainText("100%");
  await notice.getByRole("button", { name: "Zoom Out", exact: true }).click();
  await expect(notice).toContainText("90%");
  await notice.getByRole("button", { name: "Zoom Out", exact: true }).click();
  await expect(notice).toContainText("80%");
  await expect(notice.getByRole("button", { name: "Zoom Out", exact: true })).toBeDisabled();
  await notice.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(notice).toContainText("100%");
  await notice.screenshot({ path: testInfo.outputPath("zoom-toast.png") });
  const reset = notice.getByRole("button", { name: "Reset", exact: true });
  await reset.hover();
  await expect(reset).toBeFocused();
  await page.waitForTimeout(1700);
  await expect(notice).toBeVisible();
  // Leave both pointer and focus on the clicked button, just as a person waiting would.
  await expect(notice).toHaveCount(0, { timeout: 4000 });
  await expect(tab).toBeFocused();
  await page.mouse.move(10, 400);
  await host.evaluate(h => h.zoom("in"));
  await expect(notice).toContainText("110%");
  await notice.getByRole("button", { name: "Reset", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(notice).toHaveCount(0);
  await expect(tab).toBeFocused();
  await page.mouse.move(10, 400);
  await host.evaluate(h => h.zoom("in"));
  await expect(notice).toContainText("125%");
  await expect(notice).toHaveCount(0, { timeout: 2500 });
  await expect(tab).toBeFocused();
});
for (const language of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`zoom notification horizontal layout ${language}/${scheme} fits the minimum window at every zoom limit`, async ({}, testInfo) => {
    const view = await page.evaluate(() => (window as unknown as { settings: SettingsBridge }).settings.read());
    await host.evaluate((h, args) => {
      h.theme(args.scheme);
      h.setSize(...h.SNAPSHOT_SIZES.minimum);
      h.setView({ ...args.view, language: args.language });
    }, { language, scheme, view });
    await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
    const notice = page.locator('.zoom-notice:not([data-removed="true"]):not([inert]) .zoom-toast');
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
        const elements = [...node.querySelectorAll(".zoom-toast-value, button")].map((element) => {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, center: (box.top + box.bottom) / 2 };
        });
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width,
          height: rect.height, viewport: innerWidth, elements };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.width / geometry.height).toBeGreaterThan(4);
      for (const [index, box] of geometry.elements.entries()) {
        expect(Math.abs(box.center - geometry.elements[0]!.center)).toBeLessThan(1);
        expect(box.left).toBeGreaterThanOrEqual(geometry.left);
        expect(box.right).toBeLessThanOrEqual(geometry.right);
        expect(box.top).toBeGreaterThanOrEqual(geometry.top);
        expect(box.bottom).toBeLessThanOrEqual(geometry.bottom);
        if (index) expect(box.left).toBeGreaterThanOrEqual(geometry.elements[index - 1]!.right);
      }
      await expect(notice.getByRole("button", { name: language === "en" ? "Reset" : "重設", exact: true })).toBeVisible();
      const screenshotPath = testInfo.outputPath(`zoom-${language}-${scheme}-${Math.round(factor * 100)}.png`);
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
  const headers = page.locator(".result-summary");
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
  return { button, popup, rect };
}
test.describe("an ⓘ explanation's placement (ported from the former placement unit tests)", () => {
  test("sits above its button, left-aligned to it, so the row it explains stays in view", async () => {
    const { rect } = await explanationAt(96, 278);
    await expect
      .poll(async () => {
        const r = await rect();
        return r.y + r.height <= 278 && Math.abs(r.x - 96) < 1;
      })
      .toBe(true);
  });
  test("goes below a button too close to the top, and against the top when neither side has room", async () => {
    const { popup, rect } = await explanationAt(96, 12);
    await expect.poll(async () => (await rect()).y >= 32).toBe(true);
    await popup.evaluate((element) => (element.style.height = "320px"));
    await expect
      .poll(async () => {
        const r = await rect();
        return r.y >= 8 && r.y + r.height <= 332;
      })
      .toBe(true);
  });
  test("stays inside the window's side edges, its gap bridge still over the button", async () => {
    const { button, rect } = await explanationAt(500, 278);
    await expect
      .poll(async () => {
        const r = await rect();
        return r.x >= 8 && r.x + r.width <= 552;
      })
      .toBe(true);
    // The original geometry case also asserted the bridge over the trigger.
    // Exercise that behavior at each clamped edge, with a pause longer than the leave delay.
    const pauseInGap = async () => {
      const b = await button.boundingBox();
      if (!b) throw new Error("Explanation trigger is missing");
      await button.hover();
      await page.mouse.move(b.x + b.width / 2, b.y - 1);
      await page.waitForTimeout(180);
      await expect(page.locator("#setting-countdownSound-info-popup")).toBeVisible();
    };
    await pauseInGap();
    await button.evaluate((element) => (element.style.left = "2px"));
    // Moving the trigger leaves the pointer behind; open it at its new position before measuring the popup.
    await button.hover();
    await expect(page.locator("#setting-countdownSound-info-popup")).toBeVisible();
    await expect.poll(async () => (await rect()).x >= 8).toBe(true);
    await pauseInGap();
  });
});
test("player slider drag, fixed seek keys and volume controls keep their accessible value text", async () => {
  await page.locator("#clip-a-open").click();
  await page.locator(".player video").evaluate((element) => {
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
  const track = await page.locator(".pc-seek > div").boundingBox();
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
        .locator(".player video")
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
  await expect(page.locator(".player[data-open]")).toHaveCount(0);
  await expect(page.locator(".player")).toBeHidden();
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
      note: language === "en" ? "Clears settings, failure history, cache and logs. Recordings are kept." : "清除設定、失敗紀錄、快取與 log，錄影檔會保留。",
      choices: [{ id: "clear", label: language === "en" ? "Clear local app data and quit…" : "清除本機 App 資料並結束…", enabled: false, checked: false }],
    };
    const view = { ...current, language, groups: [...current.groups, group] };
    await setView(view as SettingsView);
    await page.locator("#tab-failures").click();
    await page.locator("#troubleshooting-tools-tab").click();
    await page.locator("#settings-data-cleanup-toggle").click();
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
  const clip = page.locator("#clip-a-open"), title = clip.locator(".clip-title");
  await clip.hover();
  await page.waitForTimeout(1700);
  await expect(tip).toHaveCount(0);
  await clip.focus();
  await expect(clip).toBeFocused();
  await expect(tip).toHaveCount(0);
  // Force actual two-line grid overflow; only a clipped name gets a tooltip.
  const longTitle = "Recording with a very long descriptive title ".repeat(8);
  const library = current.library!;
  await setView({ ...current, library: { ...library, items: library.items.map(item => item.id === "a" ? { ...item, title: longTitle } : item) } });
  await page.mouse.move(10, 400);
  await title.hover();
  await expect.poll(() => title.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await expect(tip).toHaveText(longTitle.trim());
  await page.locator("#library-layout-list").click();
  await title.hover();
  await expect.poll(() => title.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await expect(tip).toHaveText(longTitle.trim());
  // A resize under the pointer is remeasured on movement, without another pointer entry.
  await title.evaluate(node => { node.style.width = "6000px"; node.style.maxWidth = "none"; });
  const box = await clip.boundingBox();
  if (!box) throw new Error("Recording control is missing");
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await expect(tip).toHaveCount(0);
  await title.evaluate(node => { node.style.width = ""; node.style.maxWidth = ""; });
  // With no hint for a complete name, start a fresh hover after it is clipped again.
  await page.mouse.move(10, 400);
  await title.hover();
  await expect(tip).toHaveText(longTitle.trim());
  await page.screenshot({ path: testInfo.outputPath("recording-tooltip.png"), animations: "disabled" });
  const unbroken = "Recording".repeat(30);
  await setView({ ...current, library: { ...library, layout: "list", items: library.items.map(item => item.id === "a" ? { ...item, title: unbroken } : item) } });
  await title.hover();
  await expect(tip).toHaveText(unbroken);
  expect(await tip.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test("a new zoom notice keeps focus ownership when the previous notice finishes leaving", async () => {
  const tab = page.locator("#tab-library");
  const notice = page.locator('.zoom-notice:not([data-removed="true"]):not([inert]) .zoom-toast');
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
  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toBeHidden();
});

test("context menu opens at the pointer, shares file actions, and restores focus after Escape and rename", async ({}, testInfo) => {
  const card = page.locator("#clip-a");
  await card.click({ button: "right", position: { x: 30, y: 40 } });
  const menu = page.locator("#clip-context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["Show in Finder", "Open", "Rename…", "Move to Trash"]);
  await expect(page.locator("#clip-a-more")).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: testInfo.outputPath("recording-context-menu.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.locator("#clip-a-more")).toBeFocused();
  await card.click({ button: "right", position: { x: 30, y: 40 } });
  await menu.getByRole("menuitem", { name: "Rename…", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Rename", exact: true });
  await expect(field).toBeFocused();
  await expect(page.locator(".clip-rename-extension")).toHaveText(".mp4");
  expect(await field.evaluate(node => ({
    group: getComputedStyle(node.closest('[data-slot="input-group"]')!).outlineStyle,
    input: getComputedStyle(node).outlineStyle,
  }))).toEqual({ group: "solid", input: "none" });
  await page.screenshot({ path: testInfo.outputPath("rename-input-group.png"), animations: "disabled" });
  await field.fill("Context menu recording");
  await field.press("Enter");
  await expect(page.locator("#clip-a-renamed-open")).toBeFocused();
  await expect(page.locator("#feedback")).toContainText("Renamed to Context menu recording.mp4");
});

for (const scheme of ["light", "dark"] as const) {
  test(`rose actions keep readable labels in ${scheme} at rest and under the pointer`, async ({}, testInfo) => {
    await host.evaluate((h, theme) => h.theme(theme), scheme);
    await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
    // Read the actual painted foreground/background, including translucent ancestor fills.
    const contrast = async (selector: string): Promise<number> => page.locator(selector).evaluate(element => {
      const context = new OffscreenCanvas(1, 1).getContext("2d")!;
      const rgba = (value: string): number[] => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        return [pixel[0]!, pixel[1]!, pixel[2]!, pixel[3]! / 255];
      };
      const over = (top: number[], under: number[]): number[] => top.slice(0, 3).map((value, i) => value * top[3]! + under[i]! * (1 - top[3]!)).concat(1);
      const ancestors: Element[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
      const background = ancestors.reduce((under, node) => over(rgba(getComputedStyle(node).backgroundColor), under), [255, 255, 255, 1]);
      const foreground = over(rgba(getComputedStyle(element).color), background);
      const luminance = (color: number[]): number => color.slice(0, 3).map(c => {
        c /= 255;
        return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
      }).reduce((total, value, i) => total + value * [.2126, .7152, .0722][i]!, 0);
      const [low, high] = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
      return (high! + .05) / (low! + .05);
    });
    const check = async (selector: string, minimum = 4.5): Promise<void> => {
      expect(await contrast(selector), `${selector} at rest`).toBeGreaterThanOrEqual(minimum);
      await page.locator(selector).hover();
      await page.waitForTimeout(200);
      expect(await contrast(selector), `${selector} hovered`).toBeGreaterThanOrEqual(minimum);
    };
    // Light labels and filled actions use the requested primary without a darker companion.
    const accentMinimum = scheme === "light" ? 3 : 4.5;
    const tabAccent = await page.locator("#tab-library").evaluate(node => getComputedStyle(node).color);
    const primary = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--primary)";
      probe.style.color = "var(--primary-foreground)";
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const colors = { fill: style.backgroundColor, foreground: style.color };
      probe.remove();
      return colors;
    });
    expect(tabAccent).toBe(primary.fill);
    expect(await page.locator("#tab-library .tab-icon").evaluate(node => getComputedStyle(node).color)).toBe(primary.fill);
    await check("#tab-library", accentMinimum);
    for (const layout of ["grid", "list"] as const) {
      await page.locator(`#library-layout-${layout}`).click();
      const clip = page.locator("#clip-a-open"), play = clip.locator(".clip-play");
      await clip.hover();
      await expect(play).toHaveCSS("opacity", "1");
      await expect(play).toHaveCSS("background-color", primary.fill);
      await expect(play).toHaveCSS("color", primary.foreground);
      await check("#clip-a-open .clip-play", accentMinimum);
      await page.screenshot({ path: testInfo.outputPath(`primary-play-${scheme}-${layout}.png`), animations: "disabled" });
    }
    await page.locator("#tab-recording").click();
    const on = page.getByRole("switch", { name: "Countdown sound" });
    await expect(on).toHaveCSS("background-color", primary.fill);
    await expect(on.locator('[data-slot="switch-thumb"]')).toHaveCSS("background-color", primary.foreground);
    await on.evaluate(node => { node.focus(); });
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus-visible").first();
    await expect(focused).toHaveCSS("outline-color", primary.fill);
    await page.screenshot({ path: testInfo.outputPath(`primary-controls-${scheme}.png`), animations: "disabled" });
    await page.locator("#tab-failures").click();
    await page.locator('[data-result-id="failure"] .result-summary').click();
    await check('[data-result-id="failure"] [data-action="acknowledge"]', accentMinimum);
    await page.locator("#tab-library").click();
    await page.locator("#clip-a").click({ button: "right", position: { x: 30, y: 40 } });
    await page.locator("#clip-context-menu").getByRole("menuitem", { name: "Rename…", exact: true }).click();
    await page.locator("#clip-rename-input").fill("Readable rose action");
    await expect(page.locator("#clip-rename-confirm")).toBeEnabled();
    await expect(page.locator("#clip-rename-confirm")).toHaveCSS("background-color", primary.fill);
    await check("#clip-rename-confirm", accentMinimum);
    await page.screenshot({ path: testInfo.outputPath(`rose-actions-${scheme}.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
  });
}
