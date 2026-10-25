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

test("a press on the timeline puts the playhead there, a drag scrubs, Split cuts where it was put, by S under any input method, and Undo takes a split back (2026-10-25)", async () => {
  await openEditor();
  const video = page.locator("#editor video");
  await video.evaluate(async (el) => {
    const v = el as HTMLVideoElement;
    v.pause();
    if (v.readyState < 1) await new Promise((done) => v.addEventListener("loadedmetadata", done, { once: true }));
  });
  const box = (await page.locator(".editor-timeline").boundingBox())!;
  const y = box.y + box.height / 2;
  const time = () => video.evaluate((el) => (el as HTMLVideoElement).currentTime);
  // The 8 s recording: a quarter of the way is 2 s, not the start of the one part there.
  await page.mouse.click(box.x + box.width * 0.25, y);
  await expect.poll(time).toBeGreaterThan(1.8);
  expect(await time()).toBeLessThan(2.2);
  await page.mouse.move(box.x + box.width * 0.25, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(time).toBeGreaterThan(5.8);
  expect(await time()).toBeLessThan(6.2);
  await page.locator("#editor-split").click();
  await expect(page.locator(".editor-part")).toHaveCount(2);
  await expect(page.locator("#editor-feedback")).toHaveText(/^Split at 0:0(5\.[89]|6\.[01])$/);
  await expect(page.locator(".editor-position")).toHaveText(/^Playhead 0:0(5\.[89]|6\.[01])$/);

  // Undo takes a split back and Redo makes it again, though a split is never saved.
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".editor-part")).toHaveCount(1);
  await page.keyboard.press("Meta+Shift+z");
  await expect(page.locator(".editor-part")).toHaveCount(2);

  // S splits by the key's place: an input method such as Zhuyin reports another character for it.
  await page.mouse.click(box.x + box.width * 0.25, y);
  await expect.poll(time).toBeGreaterThan(1.8);
  await page.locator("#editor-split").evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ㄋ", code: "KeyS", bubbles: true, cancelable: true }));
  });
  await expect(page.locator(".editor-part")).toHaveCount(3);

  // The Remove button leaves the removed part selected, so the same button keeps it again.
  await page.mouse.click(box.x + box.width * 0.5, y);
  await page.locator("#editor-remove").click();
  await expect(page.locator(".editor-part").nth(1)).toHaveAttribute("data-removed", "true");
  await expect(page.locator(".editor-part").nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#editor-remove")).toHaveText("Keep part");
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

/**
 * An editable recording (plan 087): the camera's bubble over the production player, holding the camera's preview
 * track and placed where the recording left it; dragged to the opposite corner and its microphone turned down, saved by
 * main as a version-2 edit; the recording itself and the preview still play through the CORS-enabled scheme; and the
 * export is asked for rendered, with the camera where it was dragged and the volumes in dB.
 */
test("an editable recording's camera is dragged into place, its microphone turned down, and its export asked rendered; then dragged again, resized by its handle, a sound muted, everything reset, undone and redone", async () => {
  const description = { version: 1, sounds: ["system", "microphone"], camera: { width: 0.2, height: 0.3, rounding: 0.15, x: 0.97, y: 0.05, mirror: false } };
  fs.writeFileSync(`${clip}.editable.json`, JSON.stringify(description));
  await openEditor();
  const bubble = page.locator("#editor-camera");
  await expect(bubble).toBeVisible();
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

  // The microphone a step down with the keyboard.
  const microphone = page.getByRole("slider", { name: "Microphone", exact: true });
  await expect(microphone).toHaveAttribute("aria-valuetext", "100%");
  await microphone.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(microphone).toHaveAttribute("aria-valuetext", "95%");
  expect(await eventually(() => record().scene?.volumes?.microphone === 95)).toBe(true);

  // The scene's row stays inside the window, each control readable and large enough to hit.
  const problems = await read<string[]>(page, `(() => {
    const out = [];
    const panel = document.querySelector(".editor-panel");
    if (panel.scrollWidth > panel.clientWidth + 1) out.push("the panel overflows sideways");
    for (const el of panel.querySelectorAll(".editor-scene [role=switch], .editor-scene [data-slot=slider-thumb], .editor-scene-value, .editor-scene label")) {
      const box = el.getBoundingClientRect();
      if (box.right > innerWidth || box.bottom > innerHeight || box.left < 0) out.push((el.id || el.className) + " outside the window");
      if (getComputedStyle(el).visibility === "hidden") out.push((el.id || el.className) + " hidden");
      if (parseFloat(getComputedStyle(el).fontSize) < 12) out.push((el.id || el.className) + " text under 12 px");
    }
    return out; })()`);
  expect(problems).toEqual([]);

  // Export: rendered, with no cut, the camera where it was dragged in the recording's shape.
  await page.locator("#editor-export").click();
  await expect(page.locator(".editor-done")).toBeVisible({ timeout: 5000 });
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

  // The handle on the corner facing the middle grows it from the opposite corner, its shape kept.
  const handle = page.locator(".editor-camera-handle");
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 40, grip.y + grip.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  expect(await eventually(() => (record().scene?.camera?.width ?? 0) > 0.2)).toBe(true);
  const grown = record().scene.camera;
  expect(grown.height / grown.width).toBeCloseTo(0.3 / 0.2, 2);
  await expect(page.locator("#editor-camera-size")).toBeAttached();
  await expect(page.locator(".editor-scene-group").first().locator(".editor-scene-value")).toHaveText(`${Math.round(grown.height * 100)}%`);

  // A sound muted by its button and back to where it was.
  await page.locator("#editor-volume-system-mute").click();
  expect(await eventually(() => record().scene?.volumes?.system === 0)).toBe(true);
  await page.locator("#editor-volume-system-mute").click();
  expect(await eventually(() => record().scene?.volumes?.system === 100)).toBe(true);

  // Reset puts the camera and the volumes back as recorded; Undo takes it back, Redo makes it again.
  await page.locator("#editor-scene-reset").click();
  const recorded = { camera: { x: 0.97, y: 0.05, width: 0.2, height: 0.3, shown: true }, volumes: { system: 100, microphone: 100 } };
  expect(await eventually(() => JSON.stringify(record().scene) === JSON.stringify(recorded))).toBe(true);
  await expect(page.locator("#editor-scene-reset")).toBeDisabled();
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
