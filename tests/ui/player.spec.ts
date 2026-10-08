/**
 * The former `pnpm acceptance:player` cases that a page can answer (plan 066 ledger P01–P19), on the production main
 * (hosts/app-host.ts): a checked-in decodable clip (tests/ui/media) in the output folder, listed by the real library,
 * served by the media scheme, played muted by the production player and by the production full-screen window and
 * page (`VideoFullScreen`), with the title and the time handed both ways. Input is Playwright's.
 *
 * Full screen here is a hidden window production asked to show over the display: its bounds, the full-screen request
 * and its page are evidence, the screen it would cover is not. Covering the display, Escape at the OS level and focus
 * returning to Settings stay in the desktop `pnpm acceptance:player`.
 */
import { test, expect, type Launched } from "./fixtures";
import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { read, eventually, centre } from "./helpers";
import { VIDEO_TIMING, formatDuration } from "../../src/shared/video-player";
import { TRAFFIC_LIGHT_ZONE } from "../../src/shared/window-controls";
import { phrases, translate, type PlainMessageKey } from "../../src/shared/i18n";

const MEDIA = path.join(__dirname, "media");
const language = "zh-TW";
const label = (key: PlainMessageKey): string => translate(key, language);
const two = (value: number): string => String(value).padStart(2, "0");
/** Named as the app names its recordings, so the card reads "Today" and its time. */
const recordingName = (at: Date): string => `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}.mp4`;

interface Playback { time: number; paused: boolean; muted: boolean; volume: number; src: string; duration: number }
const playback = async (page: Page, selector: string): Promise<Playback> => {
  const state = await read<Playback | null>(page, `(() => { const v = document.querySelector(${JSON.stringify(selector)});
    return v && { time: v.currentTime, paused: v.paused, muted: v.muted, volume: v.volume, src: v.getAttribute("src") ?? "", duration: v.duration }; })()`);
  if (!state) throw new Error(`no ${selector} yet`);
  return state;
};
/**
 * Whether the controls are shown (the seek slider and every ancestor neither transparent, hidden nor undisplayed) and
 * the pointer over the picture, however the controls step aside.
 */
const resting = (page: Page): Promise<{ controls: boolean; cursor: string }> => read(page, `(() => {
  let controls = true;
  for (let el = document.querySelector('[aria-label=${JSON.stringify(label("Playback position"))}]'); el; el = el.parentElement) {
    const s = getComputedStyle(el); if (s.opacity === "0" || s.visibility === "hidden" || s.display === "none") controls = false; }
  return { controls, cursor: getComputedStyle(document.querySelector("video")).cursor }; })()`);

let app: Launched, page: Page;
test.beforeEach(async ({ launchApp }) => {
  const data = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "recordstuff-ui-app-"));
  const folder = path.join(data, "videos/RecordStuff");
  fs.mkdirSync(folder, { recursive: true });
  const at = new Date(Date.now() - 60_000), portraitAt = new Date(at.getTime() - 60_000);
  const clip = path.join(folder, recordingName(at)), portrait = path.join(folder, recordingName(portraitAt));
  fs.copyFileSync(path.join(MEDIA, "landscape-8s.mp4"), clip);
  fs.copyFileSync(path.join(MEDIA, "portrait-4s.mp4"), portrait);
  fs.utimesSync(clip, at, at);
  fs.utimesSync(portrait, portraitAt, portraitAt);
  app = await launchApp({ data, settings: { language } });
  await app.evaluate(h => h.rightClickTray());
  const waiting = app.page("settings.html");
  await app.evaluate(h => h.clickTrayItem("^開啟 RecordStuff$"));
  page = await waiting;
  await expect(page.locator(".clip-open").first()).toBeVisible();
});

/** Opens card `index` once any closing dialog has gone, so the click lands on the card and not on a fading backdrop. */
async function openCard(index: number): Promise<void> {
  await eventually(() => read<boolean>(page, `!document.querySelector(".player") || Boolean(document.querySelector(".player").hidden)`));
  await page.locator(".clip-open").nth(index).click();
  await expect(page.locator(".player[data-open]")).toHaveCount(1);
}
const item = async (index: number): Promise<{ id: string; title: string; day: string; time: string; duration: string }> =>
  read(page, `window.settings.read().then(v => v.library.items[${index}])`);

test("track clicks keep the seek position through media updates before release", async () => {
  await openCard(0);
  const video = page.locator(".player .pc > video");
  await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate(el => (el as HTMLVideoElement).pause());
  const control = page.locator("#player-seek");
  const seek = page.getByRole("slider", { name: label("Playback position") });
  const duration = await video.evaluate(el => (el as HTMLVideoElement).duration);
  for (const fraction of [0.75, 0.25, 0.6]) {
    const box = (await control.boundingBox())!;
    const target = Math.round(duration * fraction * 10) / 10;
    await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2);
    await page.mouse.down();
    try {
      await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).seeking)).toBe(false);
      // The media event is a sync boundary that used to restore the pre-click slider value.
      await video.evaluate(el => el.dispatchEvent(new Event("timeupdate")));
      await expect(seek).toHaveAttribute("aria-valuenow", String(target));
    } finally {
      await page.mouse.up();
    }
    await expect(seek).toHaveAttribute("aria-valuenow", String(target));
    expect(Math.abs((await playback(page, ".player .pc > video")).time - target)).toBeLessThan(0.15);
  }
  await page.locator("#player-close").click();
});

test("the seek bar accepts clicks near the top and bottom edges of its pointer area in both players", async () => {
  await openCard(0);
  const checkEdges = async (target: Page): Promise<void> => {
    const video = target.locator(".pc > video");
    await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate(el => (el as HTMLVideoElement).pause());
    const bar = target.locator(".pc-seek");
    const seek = target.getByRole("slider", { name: label("Playback position") });
    const duration = await video.evaluate(el => (el as HTMLVideoElement).duration);
    for (const [fraction, edge] of [[0.75, "top"], [0.25, "bottom"]] as const) {
      // Locator hover also waits for the dialog's opening geometry to settle.
      await bar.hover();
      const box = (await bar.boundingBox())!;
      const x = box.x + box.width * fraction;
      const y = edge === "top" ? box.y + 1 : box.y + box.height - 1;
      await target.mouse.click(x, y);
      const time = Math.round(duration * fraction * 10) / 10;
      await expect(seek).toHaveAttribute("aria-valuenow", String(time));
      expect(Math.abs(await video.evaluate(el => (el as HTMLVideoElement).currentTime) - time)).toBeLessThan(0.15);
    }
  };
  await checkEdges(page);
  const waiting = app.page("video.html");
  await page.locator("#player-fullscreen").click();
  const full = await waiting;
  await checkEdges(full);
  await full.locator("#exit").click();
  await page.locator("#player-close").click();
});

/** A picture kept in the test's output folder for inspection, as the former runner kept its screenshots. */
const keep = async (target: Page, name: string): Promise<void> => {
  fs.writeFileSync(test.info().outputPath(name), await target.screenshot({ caret: "hide" }));
};

test("P01–P10, P16–P19 the player: a card plays the clip; named controls; rest and wake; pause; keys; seek drag; volume; the corner; the title strip; Close; a portrait picture fits", async () => {
  test.setTimeout(60_000);
  const first = await item(0);
  expect.soft(first.duration, "P01 the Recordings tab lists the clip with its length").toBe("0:08");
  const card = await centre(page, ".clip-open", false);
  await page.mouse.click(card.x, card.y);
  const opened = await eventually(async () => { const p = await playback(page, ".player .pc > video"); return !p.paused && p.time > 0.3; }, 5000);
  const structure = await read<{ open: boolean; native: boolean; labels: string[]; text: string }>(page, `(() => {
    const p = document.querySelector(".player");
    return { open: p.hasAttribute("data-open"), native: p.querySelector("video").controls,
      labels: [...p.querySelectorAll("button, input")].map(el => el.getAttribute("aria-label")).sort(), text: p.textContent }; })()`);
  expect.soft(opened && structure.open, `P02 a click on a card opens the player and plays the recording (decoded, muted) ${JSON.stringify(await playback(page, ".player .pc > video"))}`).toBe(true);
  expect.soft(!structure.native && structure.labels.join() === [label("Close"), label("Playback position"), label("Pause"), label("Mute"), label("Volume"), label("Full screen")].sort().join()
    && structure.text.includes(first.title) && structure.text.includes(phrases([first.day, first.time], language)),
  `P03 the player has its own named controls, none of Chromium's, and the recording's name over the picture ${JSON.stringify(structure)}`).toBe(true);
  const bar = await centre(page, ".player .pc-bottom", false);
  await page.mouse.move(bar.x, bar.y);
  await page.waitForTimeout(250);
  await keep(page, "player-playing-light.png");
  const picture = await centre(page, ".player .pc > video", false);
  await page.mouse.move(picture.x, picture.y);
  await page.waitForTimeout(VIDEO_TIMING.idleMs + 600);
  await eventually(async () => !(await resting(page)).controls, 1500);
  const rested = await resting(page);
  await keep(page, "player-resting-light.png");
  expect.soft(rested, `P04 while it plays, the controls and the pointer step aside after ${VIDEO_TIMING.idleMs / 1000} s at rest`).toEqual({ controls: false, cursor: "none" });
  await page.mouse.move(picture.x + 12, picture.y + 6);
  await page.waitForTimeout(350);
  const woken = await resting(page);
  expect.soft(woken.controls && woken.cursor !== "none", `P05 a pointer move brings them back ${JSON.stringify(woken)}`).toBe(true);
  await page.mouse.click(picture.x, picture.y);
  const paused = await eventually(async () => (await playback(page, ".player .pc > video")).paused);
  await page.waitForTimeout(VIDEO_TIMING.idleMs + 600);
  const stayed = await resting(page);
  await keep(page, "player-paused-light.png");
  expect.soft(paused && stayed.controls, `P06 a click on the picture pauses it, and paused the controls stay ${JSON.stringify(stayed)}`).toBe(true);
  await page.keyboard.press("Space");
  const spacePlays = await eventually(async () => !(await playback(page, ".player .pc > video")).paused);
  await page.keyboard.press("k");
  const kPauses = await eventually(async () => (await playback(page, ".player .pc > video")).paused);
  await read(page, `document.querySelector(".player .pc > video").currentTime = 1`);
  await eventually(async () => Math.abs((await playback(page, ".player .pc > video")).time - 1) < 0.05);
  await page.keyboard.press("ArrowRight");
  const skipped = await eventually(async () => Math.abs((await playback(page, ".player .pc > video")).time - 6) < 0.3);
  await page.keyboard.press("m");
  const muteName = (): Promise<string> => read(page, `document.getElementById("player-mute").getAttribute("aria-label")`);
  const muted = await eventually(async () => (await playback(page, ".player .pc > video")).muted && await muteName() === label("Unmute"));
  await page.keyboard.press("m");
  const unmuted = await eventually(async () => !(await playback(page, ".player .pc > video")).muted);
  expect.soft({ spacePlays, kPauses, skipped, muted, unmuted }, "P07 Space plays, K pauses, → moves 5 s and M mutes and unmutes, from the keyboard")
    .toEqual({ spacePlays: true, kPauses: true, skipped: true, muted: true, unmuted: true });
  // A drag along the seek bar from half a second in, so only a drag that works lands at three quarters. Each move goes
  // once the last one has moved the video, never after a fixed pause.
  await read(page, `document.querySelector(".player .pc > video").currentTime = 0.5`);
  await eventually(async () => Math.abs((await playback(page, ".player .pc > video")).time - 0.5) < 0.05);
  const seek = await read<{ left: number; width: number; y: number }>(page, `(() => { const r = document.querySelector(".player .pc-seek").getBoundingClientRect(); return { left: r.left, width: r.width, y: r.y + r.height / 2 }; })()`);
  await page.mouse.move(seek.left + seek.width * 0.2, seek.y);
  await page.mouse.down();
  const { duration } = await playback(page, ".player .pc > video");
  const trace: Array<{ at: number; landed: boolean; time: number; dragging: boolean }> = [];
  for (const at of [0.35, 0.5, 0.65, 0.75]) {
    await page.mouse.move(seek.left + seek.width * at, seek.y);
    const landed = await eventually(async () => Math.abs((await playback(page, ".player .pc > video")).time - duration * at) < 0.3, 1500);
    trace.push({ at, landed, ...await read<{ time: number; dragging: boolean }>(page, `({ time: document.querySelector(".player .pc > video").currentTime, dragging: document.querySelector(".player .pc-seek").hasAttribute("data-dragging") })`) });
  }
  await page.mouse.up();
  const sought = await eventually(async () => { const p = await playback(page, ".player .pc > video"); return p.paused && Math.abs(p.time - p.duration * 0.75) < 0.6; });
  expect.soft(sought, `P08 a drag along the seek bar moves the video from 0.5 s to where it is let go ${JSON.stringify({ trace, ...await playback(page, ".player .pc > video") })}`).toBe(true);
  const mute = await centre(page, "#player-mute", false);
  await page.mouse.move(mute.x, mute.y);
  await page.waitForTimeout(350);
  const level = await read<{ width: number; height: number } | null>(page, `document.getElementById("player-volume")?.getBoundingClientRect().toJSON() ?? null`);
  expect.soft((level?.width ?? 0) > 0 && (level?.height ?? 0) > 0, `P09 with the pointer on the mute button the volume slider is there to use ${JSON.stringify(level)}`).toBe(true);
  if (await read(page, "document.documentElement.dataset.platform") === "darwin") {
    const corner = await read<{ covered: string[] }>(page, `(() => {
      const dialog = document.querySelector(".player"), found = new Set();
      for (let x = 1; x < ${TRAFFIC_LIGHT_ZONE.width}; x += 2) for (let y = 1; y < ${TRAFFIC_LIGHT_ZONE.height}; y += 2)
        for (const hit of document.elementsFromPoint(x, y)) if (hit !== dialog && dialog.contains(hit)) found.add(hit.id || hit.className || hit.tagName);
      return { covered: [...found] }; })()`);
    expect.soft(corner.covered, `P10 no part of the player lies under the window controls`).toEqual([]);
    // While the player is open the title bar strip does not drag, so a click there, on the backdrop, closes it.
    const region = `getComputedStyle(document.querySelector(".titlebar")).getPropertyValue("-webkit-app-region") || getComputedStyle(document.querySelector(".titlebar")).getPropertyValue("app-region")`;
    const strip = await read<string>(page, region);
    const width = await read<number>(page, "innerWidth");
    await page.mouse.click(width / 2, 12);
    const backdropClosed = await eventually(async () => !(await read<boolean>(page, `document.querySelector(".player")?.hasAttribute("data-open")`)));
    const dragsAgain = await read<string>(page, region);
    expect.soft({ strip, backdropClosed, dragsAgain }, "P16 while the player is open the title bar strip does not drag, a click there closes the player, and closed it drags again")
      .toEqual({ strip: "no-drag", backdropClosed: true, dragsAgain: "drag" });
    await openCard(0);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1100);
  await page.locator("#player-close").click();
  const closed = await eventually(async () => !(await read<boolean>(page, `document.querySelector(".player")?.hasAttribute("data-open")`)));
  expect.soft(closed && (await playback(page, ".player .pc > video")).src === "", "P17 Close closes the player and releases the file").toBe(true);
  // A portrait recording opens and its whole picture is shown inside the window, not cropped. Measured once the dialog's
  // opening animation has finished.
  const fitted = async (): Promise<{ inside: boolean; fit: string; source: string }> => {
    await eventually(() => read<boolean>(page, `document.querySelector(".player").getAnimations().every(animation => animation.playState !== "running")`));
    return read(page, `(() => { const v = document.querySelector(".player .pc > video"), r = v.getBoundingClientRect();
      return { inside: r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5, fit: getComputedStyle(v).objectFit, source: v.videoWidth + "×" + v.videoHeight }; })()`);
  };
  await openCard(1);
  await eventually(async () => (await read<number>(page, `document.querySelector(".player")?.hasAttribute("data-open") ? document.querySelector(".player .pc > video").readyState : 0`)) >= 1);
  await read(page, `document.querySelector(".player .pc > video").pause()`);
  const tall = await fitted();
  await keep(page, "player-portrait-light.png");
  await page.locator("#player-close").click();
  expect.soft(tall.source === "270×480" && tall.inside && (tall.fit === "contain" || tall.fit === "scale-down"),
    `P18 a portrait recording opens with its whole picture inside the window, uncropped ${JSON.stringify(tall)}`).toBe(true);
  // The dark theme's player, paused, for the pictures.
  await app.evaluate((_h, _a, electron) => { electron.nativeTheme.themeSource = "dark"; });
  await openCard(0);
  await read(page, `document.querySelector(".player .pc > video").pause()`);
  await page.waitForTimeout(300);
  await keep(page, "player-paused-dark.png");
  await page.locator("#player-close").click();
  // P19: every page's console errors fail the test at teardown (fixtures.ts).
});

test("P20 a key seek, a volume key and a click on the picture each give feedback, and after a click the seek bar's arrows mark keyboard input", async () => {
  await openCard(0);
  await eventually(async () => !(await playback(page, ".player .pc > video")).paused, 5000);
  await read(page, `document.querySelector(".player .pc > video").pause()`);
  // From the keyboard: the picture has focus and → seeks, with a seek hint shown.
  await read(page, `document.querySelector(".player .pc > video").focus({ focusVisible: true })`);
  const before = (await playback(page, ".player .pc > video")).time;
  await page.keyboard.press("ArrowRight");
  const hint = await read<boolean>(page, `!document.querySelector(".player .pc-seek-forward").hidden`);
  const seek = { hint, moved: await eventually(async () => (await playback(page, ".player .pc > video")).time > before + 1) };
  expect.soft(seek, "P20 a key seek moves the video and shows its hint").toEqual({ hint: true, moved: true });
  await page.keyboard.press("ArrowUp");
  const volume = await read<{ bezel: boolean; text: string }>(page, `({ bezel: !document.querySelector(".player .pc-bezel").hidden, text: document.querySelector(".player .pc-bezel-text").hidden ? "" : document.querySelector(".player .pc-bezel-text").textContent })`);
  expect.soft(volume.bezel && volume.text.length > 0, `P20 a volume key shows its feedback and level ${JSON.stringify(volume)}`).toBe(true);
  await page.waitForTimeout(900);
  await page.locator(".player .pc > video").click();
  const clicked = await read<{ kind: string | undefined; hidden: boolean }>(page, `(() => { const b = document.querySelector(".player .pc-bezel");
    return { kind: b.dataset.kind, hidden: b.hidden }; })()`);
  expect.soft(clicked, "P20 a click on the picture shows play feedback").toEqual({ kind: "play", hidden: false });
  // A click on the seek bar, then its arrows: the thumb stops their propagation, yet the page learns the keyboard came
  // last (review of 2026-10-07), so a focus line the browser then draws is not hidden.
  await page.locator(".player .pc-seek").click();
  await page.keyboard.press("ArrowRight");
  expect.soft(await read<string | undefined>(page, "document.documentElement.dataset.input"), "P20 after a click, the seek bar's arrows mark keyboard input").toBe("keyboard");
  await page.locator("#player-close").click();
});

test("P11–P15 full screen: the full-screen page gets the name, the controls and the time; rests and wakes; F and Escape hand the time back", async () => {
  const first = await item(0);
  const card = await centre(page, ".clip-open", false);
  await page.mouse.click(card.x, card.y);
  await eventually(async () => !(await playback(page, ".player .pc > video")).paused, 5000);
  await read(page, `document.querySelector(".player .pc > video").currentTime = 2`);
  await page.waitForTimeout(150);
  // Where the player was when full screen was asked for: the full-screen page must start there.
  const handed = (await playback(page, ".player .pc > video")).time;
  const fullWaiting = app.page("video.html");
  await page.locator("#player-fullscreen").click();
  const full = await fullWaiting;
  const shown = await eventually(() => app.evaluate(h => h.videoShown()), 6000);
  const fullPlayback = await playback(full, "#video");
  const fullState = await read<{ title: boolean; labels: string[]; native: boolean }>(full, `(() => ({ title: document.body.textContent.includes(${JSON.stringify(first.title)}),
    labels: [...document.querySelectorAll("button")].map(b => b.getAttribute("aria-label")).sort(), native: document.getElementById("video").controls }))()`);
  const geometry = await app.evaluate((h, _a, electron) => {
    const settings = h.settingsWindow(), video = h.videoWindow();
    // What production asked for when it made the window: a hidden window is fitted to the work area by the OS (Windows'
    // taskbar), so its own bounds are not the request.
    const created = h.boundary.calls.filter((call: { kind: string }) => call.kind === "window:create").at(-1)!.detail as { bounds: unknown; fullscreen: boolean };
    return { requested: created.bounds, fullscreenOption: created.fullscreen, display: electron.screen.getDisplayMatching(settings.getBounds()).bounds,
      state: h.boundary.windowState(video) as { simpleFullScreen: boolean; fullScreen: boolean; visible: boolean } };
  });
  const handedOver = fullPlayback.time >= handed - 0.3 && fullPlayback.time <= handed + 1.5;
  expect.soft(shown && fullState.title && !fullState.native
    && fullState.labels.join() === [label("Pause"), label("Mute"), label("Exit full screen")].sort().join() && !fullPlayback.paused && handedOver
    && JSON.stringify(geometry.requested) === JSON.stringify(geometry.display)
    && (process.platform === "darwin" ? geometry.state.simpleFullScreen : geometry.fullscreenOption === true && geometry.state.fullScreen) && geometry.state.visible,
  `P11 the full-screen window is asked to cover the display, its page has the recording's name, the same controls and the time handed over, still playing ${JSON.stringify({ ...fullState, handed, ...fullPlayback, ...geometry })}`).toBe(true);
  const viewport = await read<{ width: number; height: number }>(full, "({ width: innerWidth, height: innerHeight })");
  await full.mouse.move(viewport.width / 2, viewport.height - 40);
  await full.waitForTimeout(250);
  await keep(full, "fullscreen-playing.png");
  await full.mouse.move(viewport.width / 2, viewport.height / 2);
  await full.waitForTimeout(VIDEO_TIMING.idleMs + 600);
  const fullRest = await resting(full);
  expect.soft(fullRest, "P12 in full screen the controls and the pointer step aside at rest too").toEqual({ controls: false, cursor: "none" });
  await full.mouse.move(viewport.width / 2 + 10, viewport.height / 2 + 4);
  await full.waitForTimeout(350);
  const fullWake = await resting(full);
  expect.soft(fullWake.controls && fullWake.cursor !== "none", `P13 …and come back on a move ${JSON.stringify(fullWake)}`).toBe(true);
  const before = (await playback(full, "#video")).time;
  // F leaves: the window fades and closes on the keydown, so the keyup may find no page.
  await full.keyboard.press("f").catch((error: unknown) => { if (!full.isClosed()) throw error; });
  const left = await eventually(() => full.isClosed(), 3000);
  const resumed = await eventually(async () => { const p = await playback(page, ".player .pc > video"); return !p.paused && p.time >= before - 0.3 && p.time <= before + 1.5; }, 3000);
  expect.soft(left && resumed, `P14 F leaves full screen, and the player carries on from where it was, playing ${JSON.stringify({ before, after: await playback(page, ".player .pc > video") })}`).toBe(true);
  // A double-click on the picture plays full screen; Escape on its page leaves.
  await page.waitForTimeout(1100);
  const again = await centre(page, ".player .pc > video", false);
  const secondWaiting = app.page("video.html");
  await page.mouse.dblclick(again.x, again.y);
  const second = await secondWaiting;
  const reopened = await eventually(() => app.evaluate(h => h.videoShown()), 6000);
  await second.keyboard.press("Escape").catch((error: unknown) => { if (!second.isClosed()) throw error; });
  const escaped = await eventually(() => second.isClosed(), 3000);
  const stillOpen = await read<boolean>(page, `document.querySelector(".player")?.hasAttribute("data-open")`);
  expect.soft({ reopened, escaped, stillOpen }, "P15 a double-click on the picture plays full screen, and Escape leaves it with the player still open").toEqual({ reopened: true, escaped: true, stillOpen: true });
  const calls = (await app.calls()).map(call => call.kind);
  expect.soft(calls.filter(kind => kind === "window:setSimpleFullScreen" || kind === "window:create").length > 0, "P11 production's full-screen requests are recorded adapter calls, not screen changes").toBe(true);
});

test("a grid card previews on hover: one muted preview, its bar shows a frame where the pointer is and moves only on a press, a click plays on from there, leaving unloads it", async () => {
  const previews = page.locator(".clip-preview > video");
  const thumbs = page.locator(".clip-thumb");
  await thumbs.nth(0).hover();
  await expect(previews).toHaveCount(1);
  await expect(page.locator(".clip").nth(0).locator(".clip-preview > video")).toHaveCount(1);
  await expect.poll(() => playback(page, ".clip-preview video").then(state => !state.paused && state.muted && state.time > 0)).toBe(true);
  // Another card's picture: the first preview unloads, and only one preview exists at a time.
  await thumbs.nth(1).hover();
  await expect(page.locator(".clip").nth(0).locator(".clip-preview")).toHaveCount(0);
  await expect(page.locator(".clip").nth(1).locator(".clip-preview > video")).toHaveCount(1);
  expect(await previews.count()).toBe(1);
  await thumbs.nth(0).hover();
  await expect(page.locator(".clip").nth(0).locator(".clip-preview > video")).toHaveCount(1);
  await expect.poll(() => playback(page, ".clip-preview video").then(state => state.duration > 0)).toBe(true);
  // Along the bar's strip: the bar rises, leaving room beneath it, and a small picture shows the frame under the pointer
  // with its time, while the preview plays on where it was.
  const card = page.locator(".clip").nth(0), strip = card.locator(".clip-scrub");
  const box = (await strip.boundingBox())!;
  const duration = (await playback(page, ".clip-preview > video")).duration, target = duration * 0.7;
  // Seeks of the preview itself, its loop's return to the start aside.
  await page.evaluate(() => {
    const seeks: number[] = (window as unknown as { previewSeeks: number[] }).previewSeeks = [];
    document.querySelector(".clip-preview > video")!.addEventListener("seeking", event => {
      const time = (event.target as HTMLVideoElement).currentTime;
      if (time > 0.5) seeks.push(time);
    });
  });
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height - 3, { steps: 4 });
  await expect(card.locator(".frame-peek video")).toHaveCount(1);
  await expect.poll(() => playback(page, ".frame-peek video").then(state => Math.abs(state.time - target) < 0.3)).toBe(true);
  await expect(card.locator(".frame-peek-time")).toHaveText(formatDuration(target));
  await keep(page, "clip-preview-scrub.png");
  expect((await playback(page, ".clip-preview > video")).paused, "pointing at the bar does not stop the preview").toBe(false);
  expect(await read<number[]>(page, "window.previewSeeks"), "pointing at the bar moves the preview nowhere").toEqual([]);
  // A click on the strip, beneath the bar, moves the preview there; it does not open the player.
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height - 3);
  await expect.poll(() => read<number[]>(page, "window.previewSeeks").then(seeks => seeks.some(time => Math.abs(time - target) < 0.3))).toBe(true);
  await expect(page.locator(".player[data-open]")).toHaveCount(0);
  const shown = (await playback(page, ".clip-preview > video")).time;
  // A click elsewhere on the picture plays the recording in the player from what the preview showed; the preview ends.
  const picture = (await card.locator(".clip-thumb").boundingBox())!;
  await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 3);
  await expect(page.locator(".player[data-open]")).toHaveCount(1);
  await expect(previews).toHaveCount(0);
  await expect.poll(() => playback(page, ".player .pc > video").then(state => state.time)).toBeGreaterThanOrEqual(shown - 0.3);
  await page.locator("#player-close").click();
  // Leaving the picture before the preview starts starts none.
  await eventually(() => read<boolean>(page, `!document.querySelector(".player") || Boolean(document.querySelector(".player").hidden)`));
  await page.mouse.move(0, 0);
  await thumbs.nth(1).hover();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await expect(previews).toHaveCount(0);
  // The list layout's rows never preview.
  await page.locator("#library-layout-list").click();
  await expect(page.locator("#library-layout-list")).toHaveAttribute("aria-pressed", "true");
  await thumbs.nth(0).hover();
  await page.waitForTimeout(600);
  await expect(previews).toHaveCount(0);
  await page.locator("#library-layout-grid").click();
  await expect(page.locator("#library-layout-grid")).toHaveAttribute("aria-pressed", "true");
  // Another tab chosen from the keyboard while the pointer stays on the picture: the Recordings tab stays mounted, only
  // hidden, yet a playing preview ends there, and one waiting to start never does (review P2-3, 2026-10-08).
  await page.mouse.move(0, 0);
  await thumbs.nth(0).hover();
  await expect(previews).toHaveCount(1);
  await page.locator("#tab-recording").press("Enter");
  await expect(page.locator("#tab-recording")).toHaveAttribute("aria-selected", "true");
  await expect(previews).toHaveCount(0);
  await page.locator("#tab-library").press("Enter");
  await page.mouse.move(0, 0);
  await thumbs.nth(1).hover();
  await page.locator("#tab-recording").press("Enter");
  await page.waitForTimeout(600);
  await expect(previews).toHaveCount(0);
  await page.locator("#tab-library").press("Enter");
  await expect(page.locator("#tab-library")).toHaveAttribute("aria-selected", "true");
  await expect(previews).toHaveCount(0);
  await page.mouse.move(0, 0);
});

test("a press on a preview's bar moves it, drags no file out and opens no player, and a preview never starts in a hidden window", async () => {
  const thumbs = page.locator(".clip-thumb"), previews = page.locator(".clip-preview > video");
  // The pointer already on the bar as the preview starts, pressed there: the preview moves to that moment.
  const thumb = (await thumbs.nth(0).boundingBox())!;
  const barY = thumb.y + thumb.height - 4;
  await page.mouse.move(thumb.x + thumb.width * 0.2, barY);
  await expect(previews).toHaveCount(1);
  await page.mouse.move(thumb.x + thumb.width * 0.6, barY, { steps: 3 });
  await expect.poll(() => playback(page, ".clip-preview > video").then(state => state.duration > 0)).toBe(true);
  const duration = (await playback(page, ".clip-preview > video")).duration;
  await page.mouse.down();
  await expect.poll(() => playback(page, ".clip-preview > video").then(state => state.time >= duration * 0.6 - 0.3)).toBe(true);
  await expect(page.locator(".clip-preview[data-shown]")).toHaveCount(1);
  // The press moves the preview and drags no file out of the card; a press elsewhere on the card still does.
  await app.evaluate(h => {
    const contents = h.settingsWindow()!.webContents as unknown as { startDrag: (...args: unknown[]) => void };
    (globalThis as unknown as { drags: number }).drags = 0;
    contents.startDrag = () => { (globalThis as unknown as { drags: number }).drags++; };
  });
  const drags = (): Promise<number> => app.evaluate(() => (globalThis as unknown as { drags: number }).drags);
  const dragCard = (): Promise<void> => page.locator(".clip").nth(0).evaluate(card => { card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true })); });
  await dragCard();
  await page.mouse.up();
  await expect(page.locator(".player[data-open]"), "a click on the bar opens no player").toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await drags(), "a press on the seek bar drags nothing").toBe(0);
  await dragCard();
  await expect.poll(drags, { message: "a press elsewhere drags the file" }).toBe(1);
  // The window hides while the pointer rests on a card: the preview waiting to start never starts.
  await eventually(() => read<boolean>(page, `!document.querySelector(".player") || Boolean(document.querySelector(".player").hidden)`));
  await page.mouse.move(0, 0);
  await expect(previews).toHaveCount(0);
  await thumbs.nth(1).hover();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(600);
  await expect(previews).toHaveCount(0);
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
});

test("switching tabs from the keyboard ends a preview, or one waiting to start, while the pointer stays on the picture", async () => {
  const previews = page.locator(".clip-preview > video"), thumbs = page.locator(".clip-thumb");
  await thumbs.nth(0).hover();
  await expect(previews).toHaveCount(1);
  await page.locator("#tab-library").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#tab-library")).toHaveAttribute("aria-selected", "false");
  await expect(previews).toHaveCount(0);
  // Back on the tab, a rest that is interrupted by a switch within its 400 ms starts nothing on the hidden tab.
  await page.locator("#tab-library").click();
  await thumbs.nth(1).hover();
  await page.locator("#tab-library").focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(600);
  await expect(previews).toHaveCount(0);
});

test("with reduced motion a preview plays nothing by itself, and shows the frame a press on its bar moves to", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    const card = page.locator(".clip").nth(0), preview = card.locator(".clip-preview");
    await card.locator(".clip-thumb").hover();
    await expect(preview.locator("> video")).toHaveCount(1);
    await expect.poll(() => playback(page, ".clip-preview > video").then(state => state.duration > 0)).toBe(true);
    await page.waitForTimeout(500);
    expect((await playback(page, ".clip-preview > video")).paused, "nothing plays by itself").toBe(true);
    await expect(preview, "the picture stays until a frame is chosen").not.toHaveAttribute("data-shown");
    // Pointing at the bar shows a frame above it and moves nothing; a press moves the preview and shows that frame.
    const strip = (await card.locator(".clip-scrub").boundingBox())!;
    await page.mouse.move(strip.x + strip.width * 0.6, strip.y + strip.height - 3, { steps: 3 });
    await expect(card.locator(".frame-peek video")).toHaveCount(1);
    await expect(preview).not.toHaveAttribute("data-shown");
    const duration = (await playback(page, ".clip-preview > video")).duration;
    await page.mouse.down();
    await page.mouse.up();
    await expect(preview).toHaveAttribute("data-shown", "true");
    const state = await playback(page, ".clip-preview > video");
    expect(Math.abs(state.time - duration * 0.6), "the preview moved to the pressed moment").toBeLessThan(0.3);
    expect(state.paused, "and still plays nothing by itself").toBe(true);
    await expect(page.locator(".player[data-open]")).toHaveCount(0);
  } finally {
    await page.emulateMedia({ reducedMotion: null });
    await page.mouse.move(0, 0);
  }
});

test("a card's frame picture stays inside the picture at any card width, and the player's seek bar shows one without moving playback", async () => {
  const card = page.locator(".clip").nth(0);
  /** Whether the frame picture at `fraction` along the card's bar lies inside the card's picture. */
  const peekAt = async (fraction: number): Promise<{ inside: boolean }> => {
    await page.mouse.move(0, 0);
    await expect(page.locator(".clip-preview")).toHaveCount(0);
    await card.locator(".clip-thumb").hover();
    await expect(card.locator(".clip-preview > video")).toHaveCount(1);
    await expect.poll(() => playback(page, ".clip-preview > video").then(state => state.duration > 0)).toBe(true);
    const strip = (await card.locator(".clip-scrub").boundingBox())!;
    await page.mouse.move(strip.x + strip.width * fraction, strip.y + strip.height - 3, { steps: 3 });
    await expect(card.locator(".frame-peek-time")).not.toBeEmpty();
    const picture = (await card.locator(".clip-thumb").boundingBox())!, peek = (await card.locator(".frame-peek").boundingBox())!;
    return {
      inside: peek.x >= picture.x - 0.5 && peek.y >= picture.y - 0.5 && peek.x + peek.width <= picture.x + picture.width + 0.5 &&
        peek.y + peek.height <= picture.y + picture.height + 0.5,
    };
  };
  // Down to the narrowest window under the last zoom step, the frame picture stays inside the card's picture.
  for (const [width, zoom] of [[1800, 1], [1000, 1], [380, 1], [380, 1.5]] as const) {
    await app.evaluate((h, args) => {
      h.settingsWindow()!.setSize(args.width, 800);
      h.settingsWindow()!.webContents.setZoomFactor(args.zoom);
    }, { width, zoom });
    await expect.poll(() => app.evaluate(h => h.settingsWindow()!.getSize()[0])).toBe(width);
    for (const fraction of [0.02, 0.5, 0.98]) {
      const result = await peekAt(fraction);
      expect(result.inside, `${width}px window at ${zoom * 100}%, ${fraction} along the bar: the frame picture stays inside the picture`).toBe(true);
    }
    await keep(page, `frame-peek-card-${width}-${zoom * 100}.png`);
  }
  // In the player: pointing at the seek bar shows the frame there without moving playback.
  await page.mouse.move(0, 0);
  await openCard(0);
  const video = page.locator(".player .pc > video").first();
  await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate(el => (el as HTMLVideoElement).pause());
  const before = (await playback(page, ".player .pc > video")).time;
  const bar = (await page.locator(".player .pc-seek-area").boundingBox())!;
  const duration = (await playback(page, ".player .pc > video")).duration;
  await page.mouse.move(bar.x + bar.width * 0.55, bar.y + bar.height / 2, { steps: 3 });
  await expect(page.locator(".player .frame-peek video")).toHaveCount(1);
  await expect(page.locator(".player .frame-peek-time")).toHaveText(formatDuration(duration * 0.55));
  // Still the narrowest window under the last zoom step: the frame picture stays inside the player's stage.
  const stage = (await page.locator(".player .pc").boundingBox())!, framed = (await page.locator(".player .frame-peek").boundingBox())!;
  expect(framed.x >= stage.x - 0.5 && framed.y >= stage.y - 0.5 && framed.x + framed.width <= stage.x + stage.width + 0.5 &&
    framed.y + framed.height <= stage.y + stage.height + 0.5, "the player's frame picture stays inside its stage").toBe(true);
  await keep(page, "frame-peek-player.png");
  await expect.poll(() => playback(page, ".player .frame-peek video").then(state => Math.abs(state.time - duration * 0.55) < 0.3)).toBe(true);
  expect((await playback(page, ".player .pc > video")).time, "pointing moves no playback").toBe(before);
  await page.mouse.move(bar.x + bar.width * 0.55, bar.y - 120);
  await expect(page.locator(".player .frame-peek")).toHaveCount(0);
  // A player this small lays its bottom controls over the close button; it closes at the usual zoom.
  await app.evaluate(h => h.settingsWindow()!.webContents.setZoomFactor(1));
  await page.locator("#player-close").click();
});

test("a frame picture pointed at before the recording's length is known is placed once it is, without another move", async () => {
  const card = page.locator(".clip").nth(0);
  await card.locator(".clip-thumb").hover();
  await expect(card.locator(".clip-preview > video")).toHaveCount(1);
  await expect.poll(() => playback(page, ".clip-preview > video").then(state => state.duration > 0)).toBe(true);
  // The length reads as unknown, as before the metadata arrives, while the pointer comes onto the bar and rests there.
  await page.evaluate(() => {
    const own = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "duration")!;
    const flags = window as unknown as { lengthUnknown: boolean; ownDuration: PropertyDescriptor };
    flags.lengthUnknown = true;
    flags.ownDuration = own;
    Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get() { return flags.lengthUnknown ? NaN : own.get!.call(this); } });
  });
  const strip = (await card.locator(".clip-scrub").boundingBox())!;
  await page.mouse.move(strip.x + strip.width * 0.3, strip.y + strip.height - 3, { steps: 3 });
  await expect(card.locator(".frame-peek")).toHaveCount(1);
  await expect(card.locator(".frame-peek-time")).toBeEmpty();
  // The metadata arrives: the picture is placed and shows the moment under the resting pointer.
  const duration = await page.evaluate(() => {
    (window as unknown as { lengthUnknown: boolean }).lengthUnknown = false;
    const video = document.querySelector<HTMLVideoElement>(".clip-preview > video")!;
    video.dispatchEvent(new Event("loadedmetadata"));
    return video.duration;
  });
  await expect(card.locator(".frame-peek-time")).toHaveText(formatDuration(duration * 0.3));
  await expect.poll(() => playback(page, ".frame-peek video").then(state => Math.abs(state.time - duration * 0.3) < 0.3)).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "duration", (window as unknown as { ownDuration: PropertyDescriptor }).ownDuration);
  });
  await page.mouse.move(0, 0);
});

test("a frame picture already shown stays inside its picture when the bar narrows under a resting pointer", async () => {
  const card = page.locator(".clip").nth(0);
  await card.locator(".clip-thumb").hover();
  await expect(card.locator(".clip-preview > video")).toHaveCount(1);
  await expect.poll(() => playback(page, ".clip-preview > video").then(state => state.duration > 0)).toBe(true);
  const strip = (await card.locator(".clip-scrub").boundingBox())!;
  await page.mouse.move(strip.x + strip.width * 0.97, strip.y + strip.height - 3, { steps: 3 });
  await expect(card.locator(".frame-peek-time")).not.toBeEmpty();
  // The grid narrows (as a smaller window or a zoom step narrows it) and is measured in the same task, before any pointer
  // event could move or end the frame picture: it is re-placed by layout alone.
  const inside = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".library-grid")!;
    grid.style.width = "300px";
    const picture = document.querySelector(".clip .clip-thumb")!.getBoundingClientRect(),
      peek = document.querySelector(".clip .frame-peek")!.getBoundingClientRect();
    grid.style.removeProperty("width");
    return peek.left >= picture.left - 0.5 && peek.right <= picture.right + 0.5;
  });
  expect(inside, "the frame picture stays inside the narrowed picture").toBe(true);
  await page.mouse.move(0, 0);
});
