/**
 * The undo toast drawn by Sonner (2026-10-07), on the production main and page (hosts/app-host.ts) with Playwright's
 * keyboard and pointer: moving a recording to the Trash shows Sonner's toast with Undo and its shortcut, a Tab from
 * the page reaches it, Escape inside it closes it and gives focus to the tab (not back to where focus came from, which
 * Sonner alone would do), there is no close button, and a toast sliding out under a newer one cannot be reached.
 * An untouched toast disappears after its countdown.
 */
import { test, expect, type Launched } from "./fixtures";
import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { read } from "./helpers";

const MEDIA = path.join(__dirname, "media");
const two = (value: number): string => String(value).padStart(2, "0");
const recordingName = (at: Date): string => `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}.mp4`;

let app: Launched, page: Page;
test.beforeEach(async ({ launchApp }) => {
  const data = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "recordstuff-ui-toast-"));
  const folder = path.join(data, "videos/RecordStuff");
  fs.mkdirSync(folder, { recursive: true });
  for (const minutes of [1, 2, 3]) {
    const at = new Date(Date.now() - minutes * 60_000), file = path.join(folder, recordingName(at));
    fs.copyFileSync(path.join(MEDIA, "portrait-4s.mp4"), file);
    fs.utimesSync(file, at, at);
  }
  app = await launchApp({ data, settings: { language: "zh-TW" } });
  await app.evaluate(h => h.rightClickTray());
  const waiting = app.page("settings.html");
  await app.evaluate(h => h.clickTrayItem("^開啟 RecordStuff$"));
  page = await waiting;
  await expect(page.locator(".clip-open")).toHaveCount(3);
});

const trashFirst = async (): Promise<void> => {
  await page.locator(".clip").first().hover();
  await page.locator(".clip-more").first().click();
  await page.locator("#clip-menu-trash").click();
};
const live = '.undo-toast:not([data-removed="true"])';

test("T01–T03 the undo toast: no close button, automatic dismissal, Escape returns focus to the tab, and a leaving toast cannot be reached", async ({}, testInfo) => {
  await trashFirst();
  await expect(page.locator(live)).toHaveCount(1);
  const drawn = await read<{ title: string; action: string; shortcut: string | null; close: string | null; styled: string | null }>(page, `(() => { const t = document.querySelector(${JSON.stringify(live)});
    return { title: t.querySelector(".toast-title").textContent, action: t.querySelector(".toast-action").textContent, shortcut: t.querySelector(".toast-action").getAttribute("aria-keyshortcuts"),
      close: t.querySelector('[data-close-button="true"]')?.getAttribute("aria-label") ?? null, styled: t.getAttribute("data-styled") }; })()`);
  const mac = process.platform === "darwin";
  expect.soft(drawn, "T01 Sonner draws the toast: its platform-specific title and Undo shortcut, without a close button").toEqual({
    title: mac ? "已丟到垃圾桶" : "已移到資源回收筒", action: mac ? "還原⌘Z" : "還原Ctrl+Z",
    shortcut: mac ? "Meta+Z" : "Control+Z", close: null, styled: "true",
  });
  await page.locator(live).screenshot({ path: testInfo.outputPath("undo-toast.png") });
  // From the selected tab, the keyboard reaches the toast's buttons; Escape there closes it and focus goes to the tab.
  await page.locator("#tab-library").focus();
  await page.locator(`${live} .toast-action`).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(live)).toHaveCount(0);
  await page.waitForTimeout(400);
  expect.soft(await read<string>(page, "document.activeElement?.id"), "T02 Escape inside the toast closes it and gives focus to the tab").toBe("tab-library");
  // A newer trash while the last toast slides out: the leaving one is inert.
  await trashFirst();
  await expect(page.locator(live)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await trashFirst();
  const leaving = await read<boolean[]>(page, `[...document.querySelectorAll('.undo-toast[data-removed="true"]')].map(t => t.inert)`);
  expect.soft(leaving.every(Boolean), `T03 a toast sliding out under a newer one cannot be reached ${JSON.stringify(leaving)}`).toBe(true);
  await page.locator("#tab-library").focus();
  await page.mouse.move(10, 400);
  await expect(page.locator(live)).toHaveCount(0, { timeout: 9500 });
});
