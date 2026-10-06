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
test("zoom notification reflects applied zoom and its buttons change and reset it without stealing entry focus", async () => {
  const tab = page.getByRole("tab", { name: "Recordings", exact: true });
  await tab.focus();
  await host.evaluate(h => h.zoom("in"));
  const notice = page.locator("#zoom-toast");
  await expect(notice).toContainText("110%");
  await expect(tab).toBeFocused();
  await notice.hover();
  await page.waitForTimeout(5100);
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Reset", exact: true }).focus();
  await page.mouse.move(10, 400);
  await page.waitForTimeout(5100);
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
  await notice.getByRole("button", { name: "Close", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(tab).toBeFocused();
});
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
  await expect(page.getByRole("tab", { name: "Failures (1)" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
test("failure rows open independently and acknowledgement collapses with focus returned", async () => {
  await page.getByRole("tab", { name: "Failures (1)" }).click();
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
      id: "localData", tab: "general" as const, kind: "actions" as const, enabled: false,
      label: language === "en" ? "Local app data" : "本機 App 資料",
      note: language === "en" ? "Clears settings, failure history, cache and logs. Recordings are kept." : "清除設定、失敗紀錄、快取與 log，錄影檔會保留。",
      choices: [{ id: "clear", label: language === "en" ? "Clear local app data and quit…" : "清除本機 App 資料並結束…", enabled: false, checked: false }],
    };
    const view = { ...current, language, groups: [...current.groups, group] };
    await setView(view as SettingsView);
    await page.getByRole("tab", { name: "General", exact: true }).click();
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
