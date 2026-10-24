/**
 * The edit view (plan 085) on the production main (hosts/app-host.ts): a checked-in clip (tests/ui/media) in the output
 * folder, listed by the real library and played by the production player inside the edit view; the edit is saved by
 * main's edit store in the test's userData and the export published by main beside the clip. The engine is the
 * boundary's stand-in (hosts/boundary.ts `exportWorker`): the background suite's builds leave the native engine out,
 * and the cut itself is checked by the engine's own tests (native/capture/src/edit) and the plan's desktop round.
 * Input is Playwright's.
 */
import { test, expect, type Launched } from "./fixtures";
import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { read, eventually } from "./helpers";

const MEDIA = path.join(__dirname, "media");
const two = (value: number): string => String(value).padStart(2, "0");
const recordingName = (at: Date): string => `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}.mp4`;
const sha = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

let app: Launched, page: Page, folder: string, clip: string, clipHash: string;
test.beforeEach(async ({ launchApp }) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-ui-editor-"));
  folder = path.join(data, "videos/RecordStuff");
  fs.mkdirSync(folder, { recursive: true });
  const at = new Date(Date.now() - 60_000);
  clip = path.join(folder, recordingName(at));
  fs.copyFileSync(path.join(MEDIA, "landscape-8s.mp4"), clip);
  fs.utimesSync(clip, at, at);
  clipHash = sha(clip);
  app = await launchApp({ data });
  await app.evaluate(h => h.rightClickTray());
  const waiting = app.page("settings.html");
  await app.evaluate(h => h.clickTrayItem("^Open RecordStuff$"));
  page = await waiting;
  await expect(page.locator(".clip-open").first()).toBeVisible();
});
test.afterEach(() => {
  // Whatever happened, the recording is as it was.
  expect(sha(clip)).toBe(clipHash);
});

/** Opens the edit view from the first card's menu; it draws `parts` parts (one for a recording never edited). */
async function openEditor(parts = 1): Promise<void> {
  await page.locator(".clip-more").first().click();
  await page.locator("#clip-menu-edit").click();
  await expect(page.locator("#editor[data-open]")).toHaveCount(1);
  await expect(page.locator(".editor-part")).toHaveCount(parts);
}

async function seek(seconds: number): Promise<void> {
  await page.locator("#editor video").evaluate(async (el, to) => {
    const video = el as HTMLVideoElement;
    video.pause();
    if (video.readyState < 1) await new Promise((done) => video.addEventListener("loadedmetadata", done, { once: true }));
    await new Promise((done) => { video.addEventListener("seeked", done, { once: true }); video.currentTime = to; });
  }, seconds);
}

/** Removes the part from `seconds` to the end: split there, select the part after it, Remove part. */
async function removeFrom(seconds: number, parts: number): Promise<void> {
  await seek(seconds);
  await page.locator("#editor-split").click();
  await expect(page.locator(".editor-part")).toHaveCount(parts);
  await page.locator(".editor-part").nth(parts - 1).click();
  await page.locator("#editor-remove").click();
  await expect(page.locator(".editor-part").nth(parts - 1)).toHaveAttribute("data-removed", "true");
}

test("a part is split off and removed, kept by main across a reopen, and exported beside the recording", async () => {
  await openEditor();
  await removeFrom(3, 2);
  await expect(page.locator(".editor-length")).toHaveText("Export length 0:03.0");
  await expect(page.locator("#editor-feedback")).toHaveText("Removed 0:03.0 to 0:08.0");

  // The panel's controls stay inside the window, readable and large enough to hit.
  const problems = await read<string[]>(page, `(() => {
    const out = [];
    const panel = document.querySelector(".editor-panel");
    if (panel.scrollWidth > panel.clientWidth + 1) out.push("the panel overflows sideways");
    for (const el of panel.querySelectorAll("button, [role=progressbar], .editor-length")) {
      const box = el.getBoundingClientRect();
      if (box.right > innerWidth || box.bottom > innerHeight || box.left < 0) out.push(el.id || el.className + " outside the window");
      if (el.tagName === "BUTTON" && !el.classList.contains("editor-part") && (box.height < 24 || box.width < 24)) out.push(el.id + " is under 24 px");
      if (parseFloat(getComputedStyle(el).fontSize) < 12) out.push((el.id || el.className) + " text under 12 px");
    }
    const timeline = document.querySelector(".editor-timeline").getBoundingClientRect();
    if (timeline.height < 24) out.push("the timeline is under 24 px tall");
    return out; })()`);
  expect(problems).toEqual([]);

  // Escape closes the view; the edit is main's, so it is there again when the view reopens.
  await page.keyboard.press("Escape");
  await expect(page.locator("#editor[data-open]")).toHaveCount(0);
  await openEditor(2);
  await expect(page.locator(".editor-part").nth(1)).toHaveAttribute("data-removed", "true");

  // Export: progress, then the new file beside the recording, listed as a recording of its own.
  await page.locator("#editor-export").click();
  await expect(page.locator('[role="progressbar"]')).toBeVisible();
  const name = `${path.basename(clip, ".mp4")} (edited).mp4`;
  await expect(page.locator(".editor-done")).toHaveText(`Exported as ${name}.`, { timeout: 5000 });
  expect(fs.existsSync(path.join(folder, name))).toBe(true);
  expect(fs.readdirSync(folder).filter((entry) => entry.includes("recordstuff-export"))).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".clip")).toHaveCount(2);
});

test("the preview skips removed parts, Undo takes a removal back, and a cancelled export leaves nothing", async () => {
  await openEditor();
  await removeFrom(3, 2);

  // Played from 2.5 s, the preview stops where the removed tail begins instead of showing it.
  await seek(2.5);
  await page.locator("#editor video").evaluate((el) => (el as HTMLVideoElement).play());
  expect(await eventually(() => read<boolean>(page, `document.querySelector("#editor video").paused`), 5000)).toBe(true);
  const stopped = await read<number>(page, `document.querySelector("#editor video").currentTime`);
  expect(Math.abs(stopped - 3)).toBeLessThan(0.1);

  // Undo, by its key, keeps the part again.
  await page.locator(".editor-part").nth(1).focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(page.locator(".editor-part").nth(1)).not.toHaveAttribute("data-removed", "true");
  await expect(page.locator("#editor-export")).toHaveAttribute("aria-disabled", "true");

  // Removed again and exported, then cancelled while it runs: nothing is published and nothing is left.
  await page.locator(".editor-part").nth(1).click();
  await page.locator("#editor-remove").click();
  await expect(page.locator("#editor-export")).toHaveAttribute("aria-disabled", "false");
  await page.locator("#editor-export").click();
  await page.locator("#editor-cancel-export").click();
  await expect(page.locator("#editor-export")).toBeVisible();
  await expect(page.locator('[role="progressbar"]')).toHaveCount(0);
  expect(fs.readdirSync(folder)).toEqual([path.basename(clip)]);
});
