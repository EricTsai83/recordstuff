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
  // A settings file, as an existing user has: with none the app is a new install and opens its first-launch guide.
  app = await launchApp({ data, settings: {} });
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
  // Measured once the dialog has finished opening: positions taken while it grows in are not where it settles.
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
  // And once its video's length is known: read before its metadata, it is NaN (seen on CI, 2026-10-25).
  await page.waitForFunction(() => (document.querySelector<HTMLVideoElement>("#editor .editor-stage video")?.duration ?? 0) > 0);
}

async function seek(seconds: number): Promise<void> {
  await page.locator("#editor .editor-stage video").first().evaluate(async (el, to) => {
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
  await expect(page.locator(".editor-length")).toHaveText("Export length 0:03.00");
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

  // Escape never closes the view (2026-10-26); its X does. The edit is main's, so it is there again when the view reopens.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await expect(page.locator("#editor[data-open]")).toHaveCount(1);
  await page.locator("#editor-close").click();
  await expect(page.locator("#editor[data-open]")).toHaveCount(0);
  await openEditor(2);
  await expect(page.locator(".editor-part").nth(1)).toHaveAttribute("data-removed", "true");

  // Export: progress, then the new file beside the recording, said by a toast over the view whose Play opens it in the
  // player; the toolbar keeps its Export.
  await page.locator("#editor-export").click();
  await expect(page.locator('[role="progressbar"]')).toBeVisible();
  const name = `${path.basename(clip, ".mp4")} (edited).mp4`;
  const toast = page.locator("#editor .editor-export-toast");
  await expect(toast.locator(".toast-title")).toHaveText(`Exported “${path.basename(name, ".mp4")}”`, { timeout: 5000 });
  await expect(page.locator("#editor-feedback")).toHaveText(`Exported as ${name}.`);
  await expect(page.locator("#editor-export")).toHaveAccessibleName("Export");
  expect(fs.existsSync(path.join(folder, name))).toBe(true);
  expect(fs.readdirSync(folder).filter((entry) => entry.includes("recordstuff-export"))).toEqual([]);
  await toast.getByRole("button", { name: "Play" }).click();
  await expect(page.locator("#editor[data-open]")).toHaveCount(0);
  await expect(page.locator("#player-title")).toHaveText(path.basename(name, ".mp4"));
  await page.keyboard.press("Escape");
  await expect(page.locator(".clip")).toHaveCount(2);
});

test("a click on the timeline puts the playhead there, a drag from the playhead scrubs, Split cuts where it was put, by S under any input method, and Undo takes a split back (2026-10-25)", async () => {
  await openEditor();
  const video = page.locator("#editor .editor-stage video").first();
  await video.evaluate(async (el) => {
    const v = el as HTMLVideoElement;
    v.pause();
    if (v.readyState < 1) await new Promise((done) => v.addEventListener("loadedmetadata", done, { once: true }));
  });
  await expect(page.locator("#editor-keys")).toHaveAccessibleName(`Keyboard shortcuts: Space play or pause · ← → a frame, Shift+← → a second · S split · Delete remove · ${process.platform === "darwin" ? "⌘Z undo · ⇧⌘Z redo" : "Ctrl+Z undo · Ctrl+Y redo"} · on a trim handle, ← → move its edge`);
  const box = (await page.locator(".editor-timeline").boundingBox())!;
  const y = box.y + box.height / 2;
  const time = () => video.evaluate((el) => (el as HTMLVideoElement).currentTime);
  // The 8 s recording: a quarter of the way is 2 s, not the start of the one part there.
  await page.mouse.click(box.x + box.width * 0.25, y);
  await expect.poll(time).toBeGreaterThan(1.8);
  expect(await time()).toBeLessThan(2.2);
  await expect(page.locator(".editor-position")).toHaveText(/^Playhead 0:0(1\.[89]\d|2\.[01]\d)$/);
  // Dragged from the playhead, the playhead follows; no range is chosen.
  await page.mouse.move(box.x + box.width * 0.25, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(time).toBeGreaterThan(5.8);
  expect(await time()).toBeLessThan(6.2);
  await expect(page.locator(".editor-range")).toHaveCount(0);
  await page.locator("#editor-split").click();
  await expect(page.locator(".editor-part")).toHaveCount(2);
  await expect(page.locator("#editor-feedback")).toHaveText(/^Split at 0:0(5\.[89]|6\.[01])$/);
  await expect(page.locator(".editor-position")).toHaveText(/^Playhead 0:0(5\.[89]\d|6\.[01]\d)$/);

  // Undo takes a split back and Redo makes it again, though a split is never saved.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".editor-part")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator(".editor-part")).toHaveCount(2);

  // S splits by the key's place: an input method such as Zhuyin reports another character for it.
  await page.mouse.click(box.x + box.width * 0.25, y);
  await expect.poll(time).toBeGreaterThan(1.8);
  await page.locator("#editor-split").evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ㄋ", code: "KeyS", bubbles: true, cancelable: true }));
  });
  await expect(page.locator(".editor-part")).toHaveCount(3);

  // On the timeline, ← → step a frame and Space plays and pauses, as in other editors; Space does not press the part.
  const before = await time();
  await page.locator(".editor-part").first().focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(time).toBeGreaterThan(before + 0.01);
  expect(await time()).toBeLessThan(before + 0.1);
  await page.keyboard.press("Space");
  await expect.poll(() => video.evaluate((el) => !(el as HTMLVideoElement).paused)).toBe(true);
  await page.keyboard.press("Space");
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true);

  // The Remove button leaves the removed part selected, so the same button keeps it again.
  await page.mouse.click(box.x + box.width * 0.5, y);
  await page.locator("#editor-remove").click();
  await expect(page.locator(".editor-part").nth(1)).toHaveAttribute("data-removed", "true");
  await expect(page.locator(".editor-part").nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#editor-remove")).toHaveAccessibleName("Keep part");

  // Undo from the keyboard while a part has the focus, again and again: a step that takes the focused part away (the
  // splits merging it) leaves the focus in the view, so the next ⌘Z still undoes (a hands-on round lost it).
  await page.locator(".editor-part").nth(1).focus();
  for (const parts of [3, 2, 1]) {
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator(".editor-part")).toHaveCount(parts);
    await expect(page.locator(".editor-part[data-removed]")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.getElementById("editor")?.contains(document.activeElement) ? "in" : `${document.activeElement?.tagName}#${document.activeElement?.id}`)).toBe("in");
  }
});

test("the handles trim the start and the end, a drag across the timeline removes what it chose, each a step Undo takes back (2026-10-25)", async () => {
  await openEditor();
  const box = (await page.locator(".editor-timeline").boundingBox())!;
  const y = box.y + box.height / 2;
  const edits = path.join(path.dirname(path.dirname(folder)), "userData", "edits");
  const saved = (): number[][] => {
    const file = fs.readdirSync(edits).find((name) => name.endsWith(".json") && name !== "exports-in-flight.json");
    return file ? JSON.parse(fs.readFileSync(path.join(edits, file), "utf8")).removed : [];
  };
  const seconds = async () => read<number>(page, "document.querySelector('#editor video').duration");
  const duration = await seconds();

  // The start's handle dragged a quarter in: the first quarter is removed. Pressed just beside the handle, as a pointer
  // that does not quite land on its 12 px still takes hold of it.
  const start = (await page.locator("#editor-trim-start").boundingBox())!;
  await page.mouse.move(start.x + start.width + 4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".editor-part").first()).toHaveAttribute("data-removed", "true");
  await expect(page.locator("#editor-feedback")).toHaveText(/^The export starts at 0:0(1\.[89]|2\.[01])$/);
  await expect(page.locator("#editor-trim-start")).toHaveAttribute("aria-valuenow", /^(1\.[89]\d?|2(\.[01]\d?)?)$/);

  // The end's handle, stepped from the keyboard: Shift+← takes a second off the end each press.
  await page.locator("#editor-trim-end").focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(page.locator(".editor-part").last()).toHaveAttribute("data-removed", "true");
  await expect(page.locator("#editor-feedback")).toHaveText(/^The export ends at /);
  expect(Number(await page.locator("#editor-trim-end").getAttribute("aria-valuenow"))).toBeCloseTo(duration - 1, 0);

  const exportY = (await page.locator("#editor-export").boundingBox())!.y;
  // A drag across the middle chooses a range, the preview following its moving end; Remove selection takes it out.
  await page.mouse.move(box.x + box.width * 0.45, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 6 });
  await page.mouse.up();
  const at = () => read<number>(page, "document.querySelector('#editor video').currentTime");
  await expect.poll(at).toBeGreaterThan(duration * 0.6 - 0.2);
  expect(await at()).toBeLessThan(duration * 0.6 + 0.2);
  await expect(page.locator(".editor-range")).toHaveCount(1);
  await expect(page.locator("#editor-remove")).toHaveAccessibleName("Remove selection");
  // The range's readout has a row of its own: the buttons, Export among them, stay where they were.
  expect((await page.locator("#editor-export").boundingBox())!.y).toBeCloseTo(exportY, 0);
  await expect(page.locator(".editor-position")).toHaveText(/^Selection 0:0\d\.\d\d–0:0\d\.\d\d \(0:01\.\d\d\)$/);
  await page.locator("#editor-remove").click();
  await expect(page.locator(".editor-range")).toHaveCount(0);
  await expect(page.locator(".editor-part[data-removed]")).toHaveCount(3);
  await expect(page.locator("#editor-feedback")).toHaveText(/^Removed 0:0(3\.[4-9]|4\.[0-9]) to 0:0(4\.[5-9]|5\.[0-2])$/);
  expect(saved()).toHaveLength(3);

  // Undo takes each back in turn, the trims included.
  for (const left of [2, 1, 0]) {
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator(".editor-part[data-removed]")).toHaveCount(left);
  }
  await expect(page.locator("#editor-trim-start")).toHaveAttribute("aria-valuenow", "0");

  // The end's handle dragged by the pointer, down at the handle and up far away with no move between (as a hands-on
  // round's pointer did): the end is trimmed there.
  const end = (await page.locator("#editor-trim-end").boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: end.x + end.width / 2, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + box.width * 0.75, y, button: "left", buttons: 0, clickCount: 1 });
  await expect(page.locator(".editor-part").last()).toHaveAttribute("data-removed", "true");
  expect(Number(await page.locator("#editor-trim-end").getAttribute("aria-valuenow"))).toBeCloseTo(duration * 0.75, 0);
});

test("a trim handle keeps its distance from the pointer, reaches the recording's very start and end, and steps a frame from the keyboard (2026-10-25)", async () => {
  await openEditor();
  const box = (await page.locator(".editor-timeline").boundingBox())!;
  const y = box.y + box.height / 2;
  const seconds = await read<number>(page, "document.querySelector('#editor .editor-stage video').duration");
  const value = async (edge: string) => Number(await page.locator(`#editor-trim-${edge}`).getAttribute("aria-valuenow"));
  const perPixel = seconds / box.width;
  // Each drag saves; the next waits for the save, as the timeline takes no press while one is under way.
  const saved = () => expect(page.locator("#editor-undo")).toHaveAttribute("aria-disabled", "false");

  // The handles stand outside the kept recording, as iPhone's: the start's right edge and the end's left edge are the
  // track's ends, so neither covers its pictures.
  const start = (await page.locator("#editor-trim-start").boundingBox())!;
  const last = (await page.locator("#editor-trim-end").boundingBox())!;
  expect(Math.abs(start.x + start.width - box.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(last.x - (box.x + box.width))).toBeLessThanOrEqual(1);

  // Taken hold of in the middle of the bar and let go where it was pressed: the edge stays where it was.
  await page.mouse.move(start.x + start.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 1, y);
  await page.mouse.move(start.x + start.width / 2, y);
  await page.mouse.up();
  expect(await value("start")).toBe(0);

  // Moved 100 px: the edge moves 100 px, not 100 px plus where the bar was pressed; the times' row says where it is.
  await page.mouse.move(start.x + start.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 100, y, { steps: 5 });
  await expect(page.locator(".editor-position")).toHaveText(/^The export starts at 0:0\d\.\d\d$/);
  // Its time shows above it while it moves, and goes when it is let go.
  await expect(page.locator(".editor-trim-time")).toHaveText(/^0:0\d\.\d\d$/);
  await page.mouse.up();
  await expect(page.locator(".editor-trim-time")).toHaveCount(0);
  expect(await value("start")).toBeCloseTo(100 * perPixel, 1);
  await saved();

  // Dragged past the timeline's ends, the handles stop at the recording's very start and end.
  const moved = (await page.locator("#editor-trim-start").boundingBox())!;
  await page.mouse.move(moved.x + moved.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x - 80, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => value("start")).toBe(0);
  await saved();
  const end = (await page.locator("#editor-trim-end").boundingBox())!;
  await page.mouse.move(end.x + end.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => value("end")).toBeLessThan(seconds * 0.75);
  await saved();
  const back = (await page.locator("#editor-trim-end").boundingBox())!;
  await page.mouse.move(back.x + back.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 80, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => value("end")).toBeCloseTo(seconds, 1);
  await saved();

  // From the keyboard, → moves the start a frame, Shift+→ a second; while the handle has the focus, the times' row
  // says where the export starts.
  await page.locator("#editor-trim-start").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => value("start")).toBeGreaterThan(0);
  expect(await value("start")).toBeLessThanOrEqual(0.1);
  await expect(page.locator(".editor-position")).toHaveText(/^The export starts at 0:00\.0\d$/);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => value("start")).toBeGreaterThan(1);
  await saved();

  // Let go outside the window: the timeline loses its hold with no release, and the trim is saved all the same, the
  // export length with it.
  const length = () => page.locator(".editor-length").textContent();
  const before = await length();
  const grip = (await page.locator("#editor-trim-start").boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x - 80, y, { steps: 5 });
  await page.evaluate(() => document.querySelector(".editor-trimmer")!.releasePointerCapture(1));
  // The lost hold is told at the next pointer event.
  await page.mouse.move(box.x - 90, y);
  await expect.poll(length).not.toBe(before);
  await expect(page.locator(".editor-length")).toHaveText(`Export length ${await read<string>(page, "(() => { const d = document.querySelector('#editor .editor-stage video').duration; return (Math.floor(d / 60)) + ':' + (d % 60).toFixed(2).padStart(5, '0'); })()")}`);
  await page.mouse.up();
  expect(await value("start")).toBe(0);

  // The keyboard button opens the shortcuts on a click, too.
  await page.locator("#editor-keys").click();
  await expect(page.locator("#editor-keys-popup")).toBeVisible();
  await expect(page.locator("#editor-keys-popup")).toContainText("Editing shortcuts");
  await expect(page.locator("#editor-keys-popup dd")).toHaveCount(8);
  // Shortcuts only: Skimming is in Options (2026-10-26).
  await expect(page.locator("#editor-keys-popup #editor-skim")).toHaveCount(0);
});

test("Skimming, off by default (2026-10-26), leaves the preview alone; switched on in Options, it shows the picture under the pointer and goes back to the playhead when it leaves; switched off again, a move does nothing (2026-10-25)", async () => {
  await openEditor();
  const skim = async (on: boolean) => {
    await page.locator("#editor-options").click();
    await expect(page.locator("#editor-skim")).toHaveAttribute("aria-checked", String(!on));
    await page.locator("#editor-skim").click();
    await expect(page.locator("#editor-skim")).toHaveAttribute("aria-checked", String(on));
    await page.keyboard.press("Escape");
    await expect(page.locator("#editor-options-popup")).toHaveCount(0);
    await expect(page.locator("#editor[data-open]")).toHaveCount(1);
  };
  const video = page.locator("#editor .editor-stage video").first();
  await video.evaluate(async (el) => {
    const v = el as HTMLVideoElement;
    v.pause();
    if (v.readyState < 1) await new Promise((done) => v.addEventListener("loadedmetadata", done, { once: true }));
  });
  const time = () => video.evaluate((el) => (el as HTMLVideoElement).currentTime);
  const box = (await page.locator(".editor-timeline").boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.click(box.x + box.width * 0.25, y);
  await page.mouse.move(box.x + box.width * 0.25, box.y - 60, { steps: 2 });
  await expect.poll(time).toBeGreaterThan(1.8);

  // Off by default: a pointer passing over the timeline leaves the preview at 2 s.
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 4 });
  await page.waitForTimeout(200);
  expect(await time()).toBeLessThan(2.2);
  await expect(page.locator(".editor-skimmer")).toHaveCount(0);
  await page.mouse.move(box.x + box.width * 0.75, box.y - 60, { steps: 2 });
  await skim(true);

  // On: the preview follows the pointer, with a skimmer line, and comes back to 2 s when the pointer leaves.
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 4 });
  await expect.poll(time).toBeGreaterThan(5.8);
  await expect(page.locator(".editor-skimmer")).toHaveCount(1);
  await page.mouse.move(box.x + box.width * 0.75, box.y - 60, { steps: 2 });
  await expect.poll(time).toBeLessThan(2.2);
  expect(await time()).toBeGreaterThan(1.8);
  await expect(page.locator(".editor-skimmer")).toHaveCount(0);

  // A click while skimming puts the playhead there, and it stays when the pointer leaves.
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 3 });
  await page.mouse.click(box.x + box.width * 0.5, y);
  await page.mouse.move(box.x + box.width * 0.5, box.y - 60, { steps: 2 });
  await page.waitForTimeout(200);
  expect(await time()).toBeGreaterThan(3.8);
  expect(await time()).toBeLessThan(4.2);

  // Off again, by its switch in Options (2026-10-26): a pointer passing over the timeline leaves the preview where it is.
  await skim(false);
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 4 });
  await page.waitForTimeout(200);
  expect(await time()).toBeLessThan(4.2);
  await expect(page.locator(".editor-skimmer")).toHaveCount(0);
});

test("the preview skips removed parts, Undo takes a removal back, and a cancelled export leaves nothing", async () => {
  await openEditor();
  await removeFrom(3, 2);

  // Played from 2.5 s, the preview stops where the removed tail begins instead of showing it.
  await seek(2.5);
  await page.locator("#editor .editor-stage video").first().evaluate((el) => (el as HTMLVideoElement).play());
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

/**
 * An editable recording (plan 087): the camera's bubble over the production player, holding the camera's preview
 * track and placed where the recording left it; dragged to the opposite corner and its microphone turned down, saved by
 * main as a version-2 edit; the recording itself and the preview still play through the CORS-enabled scheme; and the
 * export is asked for rendered, with the camera where it was dragged and the volumes in dB.
 */
test("an editable recording's camera is dragged into place, its microphone turned down, and its export asked rendered; then dragged again, selected and resized by a corner's handle, a sound muted, everything reset, undone and redone", async () => {
  const description = { version: 1, sounds: ["system", "microphone"], camera: { width: 0.2, height: 0.3, rounding: 0.15, x: 0.97, y: 0.05, mirror: false } };
  fs.writeFileSync(`${clip}.editable.json`, JSON.stringify(description));
  await openEditor();
  const bubble = page.locator("#editor-camera");
  await expect(bubble).toBeVisible();
  // Not selected, nothing is drawn over the picture beside the bubble: no handles.
  await expect(page.locator(".editor-camera-handle")).toHaveCount(0);
  await expect(bubble.locator("video")).toHaveAttribute("src", /^recordstuff-media:\/\/preview\/\d+\/camera$/);
  await expect(page.locator(".editor-overlay audio")).toHaveAttribute("src", /\/secondSound$/);

  // The picture as drawn, and the bubble near its top-right corner, as the recording left it.
  const measure = () => read<{ left: number; top: number; width: number; height: number }>(page, `(() => {
    const video = document.querySelector("#editor .pc video");
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const width = video.videoWidth * scale, height = video.videoHeight * scale;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height }; })()`);
  const picture = await measure();
  const before = (await bubble.boundingBox())!;
  expect(before.x + before.width).toBeGreaterThan(picture.left + picture.width * 0.95);
  expect(before.y).toBeLessThan(picture.top + picture.height * 0.1);

  // The recording plays, its sound fetched with CORS for the volumes, and the camera's track follows it.
  expect(await read<string>(page, `document.querySelector("#editor .pc video").crossOrigin`)).toBe("anonymous");
  await page.locator("#editor .pc video").evaluate(async (el) => { (el as HTMLVideoElement).muted = true; await (el as HTMLVideoElement).play(); });
  expect(await eventually(async () => (await read<number>(page, `document.querySelector("#editor-camera video").currentTime`)) > 0.3)).toBe(true);
  await page.locator("#editor .pc video").evaluate((el) => (el as HTMLVideoElement).pause());

  // Dragged to the bottom-left corner: main saves the scene with it there.
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(picture.left + 2, picture.top + picture.height - 2, { steps: 8 });
  await page.mouse.up();
  const edits = path.join(path.dirname(path.dirname(folder)), "userData", "edits");
  const record = (): Record<string, any> => {
    const file = fs.readdirSync(edits).find((name) => name.endsWith(".json") && name !== "exports-in-flight.json");
    return file ? JSON.parse(fs.readFileSync(path.join(edits, file), "utf8")) : {};
  };
  expect(await eventually(() => record().scene?.camera?.x === 0 && record().scene?.camera?.y === 1)).toBe(true);
  expect(record()).toMatchObject({ version: 2, scene: { camera: { width: 0.2, height: 0.3, shown: true }, volumes: { system: 100, microphone: 100 } } });
  const after = (await bubble.boundingBox())!;
  expect(after.x).toBeLessThan(picture.left + 2);
  expect(after.y + after.height).toBeGreaterThan(picture.top + picture.height - 2);

  // The microphone a step down with the keyboard, in the popup the Options button opens.
  await page.locator("#editor-options").click();
  const microphone = page.getByRole("slider", { name: "Microphone", exact: true });
  await expect(microphone).toHaveAttribute("aria-valuetext", "100%");
  await microphone.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(microphone).toHaveAttribute("aria-valuetext", "95%");
  expect(await eventually(() => record().scene?.volumes?.microphone === 95)).toBe(true);
  // The save redraws the view; the slider, in a popup outside the dialog, keeps the keyboard's focus.
  await expect(microphone).toBeFocused();

  // The popup stays inside the window, readable; the toolbar does not overflow.
  const problems = await read<string[]>(page, `(() => {
    const out = [];
    const panel = document.querySelector(".editor-panel");
    if (panel.scrollWidth > panel.clientWidth + 1) out.push("the panel overflows sideways");
    for (const el of document.querySelectorAll("#editor-options-popup [role=switch], #editor-options-popup [data-slot=slider-thumb], #editor-options-popup .editor-scene-value, #editor-options-popup label, #editor-options-popup button")) {
      const box = el.getBoundingClientRect();
      if (box.right > innerWidth || box.bottom > innerHeight || box.left < 0) out.push((el.id || el.className) + " outside the window");
      if (getComputedStyle(el).visibility === "hidden") out.push((el.id || el.className) + " hidden");
      if (parseFloat(getComputedStyle(el).fontSize) < 12) out.push((el.id || el.className) + " text under 12 px");
    }
    return out; })()`);
  expect(problems).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.locator("#editor-options-popup")).toHaveCount(0);

  // Export: rendered, with no cut, the camera where it was dragged in the recording's shape. Nothing in the toolbar moves
  // as it starts and ends: its outcome is a toast.
  const rows = async () => [(await page.locator("#editor-options").boundingBox())!.x, (await page.locator("#editor-redo").boundingBox())!.x, (await page.locator("#editor-keys").boundingBox())!.x];
  const rowsBefore = await rows();
  await page.locator("#editor-export").click();
  await expect(page.locator("#editor .editor-export-toast")).toBeVisible({ timeout: 5000 });
  // Within a pixel: the centred dialog may settle a fraction of one, which no one sees.
  const rowsAfter = await rows();
  rowsAfter.forEach((value, index) => expect(Math.abs(value - rowsBefore[index]!)).toBeLessThanOrEqual(1));
  await expect(page.locator("#editor-export")).toHaveAccessibleName("Export");
  const render = (await app.calls()).find((call) => call.kind === "exportWorker:render")?.detail as { camera: Record<string, number | boolean>; volumesDb: number[] };
  expect(render.camera).toEqual({ width: 0.2, height: 0.3, rounding: 0.15, x: 0, y: 1, mirror: false });
  expect(render.volumesDb[0]).toBe(0);
  expect(render.volumesDb[1]).toBeCloseTo(20 * Math.log10(0.95), 6);

  // A drop beside the middle stays where it is dropped: the bubble does not snap. The bubble sits over the player's
  // seek bar here, which gives the press to the bubble. Measured again: the export's message moved the dialog.
  const placed = (await bubble.boundingBox())!;
  const now = await measure();
  await page.mouse.move(placed.x + placed.width / 2, placed.y + placed.height / 2);
  await page.mouse.down();
  await page.mouse.move(now.left + now.width / 2 + 3, now.top + now.height / 2 - 2, { steps: 8 });
  await page.mouse.up();
  expect(await eventually(() => Math.abs((record().scene?.camera?.x ?? 0) - 0.5) < 0.03 && Math.abs((record().scene?.camera?.y ?? 0) - 0.5) < 0.03), JSON.stringify(record().scene)).toBe(true);
  expect(record().scene.camera.x).not.toBe(0.5);
  expect(record().scene.camera.y).not.toBe(0.5);

  // A click elsewhere leaves it unselected; a click on it selects it, a handle on each corner.
  await page.locator("#editor-split").focus();
  await expect(page.locator(".editor-camera-handle")).toHaveCount(0);
  await bubble.click();
  await expect(page.locator(".editor-camera-handle")).toHaveCount(4);
  // The bottom-right corner's handle grows it from the top-left corner, its shape kept.
  const handle = page.locator('.editor-camera-handle[data-corner="bottom-right"]');
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 40, grip.y + grip.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  expect(await eventually(() => (record().scene?.camera?.width ?? 0) > 0.2)).toBe(true);
  const grown = record().scene.camera;
  expect(grown.height / grown.width).toBeCloseTo(0.3 / 0.2, 2);
  await expect(bubble).toHaveAccessibleName(new RegExp(`, ${Math.round(grown.height * 100)}% in size\\.`));
  // Escape lets go of the bubble and leaves the view open (2026-10-26).
  await expect(page.locator(".editor-camera-handle")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(page.locator(".editor-camera-handle")).toHaveCount(0);
  await expect(page.locator("#editor[data-open]")).toHaveCount(1);

  // A sound muted by its slider's left end (the popup holds only the slider), its toolbar button struck through; Undo
  // brings it back.
  await page.locator("#editor-options").click();
  await page.getByRole("slider", { name: "System audio", exact: true }).focus();
  await page.keyboard.press("Home");
  expect(await eventually(() => record().scene?.volumes?.system === 0)).toBe(true);
  await expect(page.getByRole("slider", { name: "System audio", exact: true })).toHaveAttribute("aria-valuetext", "0%");
  await page.keyboard.press("Escape");
  await page.locator("#editor-undo").click();
  expect(await eventually(() => record().scene?.volumes?.system === 100)).toBe(true);

  // Reset, in the popup, puts the camera and the volumes back as recorded; Undo takes it back, Redo makes it again.
  await page.locator("#editor-options").click();
  await page.locator("#editor-scene-reset").click();
  const recorded = { camera: { x: 0.97, y: 0.05, width: 0.2, height: 0.3, shown: true }, volumes: { system: 100, microphone: 100 } };
  expect(await eventually(() => JSON.stringify(record().scene) === JSON.stringify(recorded))).toBe(true);
  await expect(page.locator("#editor-scene-reset")).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.locator("#editor-undo").click();
  expect(await eventually(() => record().scene?.volumes?.microphone === 95)).toBe(true);
  await page.locator("#editor-redo").click();
  expect(await eventually(() => JSON.stringify(record().scene) === JSON.stringify(recorded))).toBe(true);
  await expect(page.locator("#editor-redo")).toBeDisabled();
  // And by the keyboard: ⌘Z / Ctrl+Z, then ⇧⌘Z / Ctrl+Shift+Z.
  await page.locator("#editor-undo").focus();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await eventually(() => record().scene?.volumes?.microphone === 95)).toBe(true);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect(await eventually(() => JSON.stringify(record().scene) === JSON.stringify(recorded))).toBe(true);
  await page.keyboard.press("Escape");
});
