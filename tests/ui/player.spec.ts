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
import { VIDEO_TIMING } from "../../src/shared/video-player";
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
/** Whether the controls have stepped aside: the resting class, the shade faded out and the pointer hidden. */
const resting = (page: Page): Promise<{ idle: boolean; opacity: string; cursor: string }> => read(page, `(() => { const root = document.querySelector(".pc");
  return { idle: root.classList.contains("pc-idle"), opacity: getComputedStyle(root.querySelector(".pc-bottom")).opacity, cursor: getComputedStyle(root).cursor }; })()`);

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

test("the seek bar's pointer area accepts clicks above and below the visible track in both players", async () => {
  await openCard(0);
  const checkEdges = async (target: Page): Promise<void> => {
    const video = target.locator(".pc video");
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
      await target.mouse.move(x, y);
      expect(await target.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, { x, y })).toBe("pointer");
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

test("P01–P10, P16–P19 the player: a card plays the clip; named controls; rest and wake; pause; keys; seek drag; volume; the corner; the title strip; Close; the 16:9 stage", async () => {
  test.setTimeout(60_000);
  const first = await item(0);
  expect.soft(first.duration, "P01 the Recordings tab lists the clip with its length").toBe("0:08");
  const card = await centre(page, ".clip-open", false);
  await page.mouse.click(card.x, card.y);
  const opened = await eventually(async () => { const p = await playback(page, ".player video"); return !p.paused && p.time > 0.3; }, 5000);
  const structure = await read<{ open: boolean; native: boolean; buttons: string[]; labels: string[]; title: string; meta: string }>(page, `(() => {
    const p = document.querySelector(".player");
    return { open: p.hasAttribute("data-open"), native: p.querySelector("video").controls, buttons: [...p.querySelectorAll("button")].map(b => b.id),
      labels: [...p.querySelectorAll("button, input")].map(el => el.getAttribute("aria-label")), title: p.querySelector(".pc-title").textContent, meta: p.querySelector(".pc-meta").textContent }; })()`);
  expect.soft(opened && structure.open, `P02 a click on a card opens the player and plays the recording (decoded, muted) ${JSON.stringify(await playback(page, ".player video"))}`).toBe(true);
  expect.soft(!structure.native && structure.buttons.join() === "player-close,player-play,player-mute,player-fullscreen"
    && structure.labels.join() === [label("Close"), label("Playback position"), label("Pause"), label("Mute"), label("Volume"), label("Full screen")].join()
    && structure.title === first.title && structure.meta.includes(phrases([first.day, first.time], language)),
  `P03 the player has its own named controls, none of Chromium's, and the recording's name over the picture ${JSON.stringify(structure)}`).toBe(true);
  const bar = await centre(page, ".player .pc-bottom", false);
  await page.mouse.move(bar.x, bar.y);
  await page.waitForTimeout(250);
  await keep(page, "player-playing-light.png");
  const picture = await centre(page, ".player video", false);
  await page.mouse.move(picture.x, picture.y);
  await page.waitForTimeout(VIDEO_TIMING.idleMs + 600);
  await eventually(async () => (await resting(page)).idle, 1500);
  const rested = await resting(page);
  await keep(page, "player-resting-light.png");
  expect.soft(rested, `P04 while it plays, the controls and the pointer step aside after ${VIDEO_TIMING.idleMs / 1000} s at rest`).toEqual({ idle: true, opacity: "0", cursor: "none" });
  await page.mouse.move(picture.x + 12, picture.y + 6);
  await page.waitForTimeout(350);
  const woken = await resting(page);
  expect.soft(!woken.idle && woken.opacity === "1", `P05 a pointer move brings them back ${JSON.stringify(woken)}`).toBe(true);
  await page.mouse.click(picture.x, picture.y);
  const paused = await eventually(async () => (await playback(page, ".player video")).paused);
  await page.waitForTimeout(VIDEO_TIMING.idleMs + 600);
  const stayed = await resting(page);
  await keep(page, "player-paused-light.png");
  expect.soft(paused && !stayed.idle && stayed.opacity === "1", `P06 a click on the picture pauses it, and paused the controls stay ${JSON.stringify(stayed)}`).toBe(true);
  await page.keyboard.press("Space");
  const spacePlays = await eventually(async () => !(await playback(page, ".player video")).paused);
  await page.keyboard.press("k");
  const kPauses = await eventually(async () => (await playback(page, ".player video")).paused);
  await read(page, `document.querySelector(".player video").currentTime = 1`);
  await eventually(async () => Math.abs((await playback(page, ".player video")).time - 1) < 0.05);
  await page.keyboard.press("ArrowRight");
  const skipped = await eventually(async () => Math.abs((await playback(page, ".player video")).time - 6) < 0.3);
  await page.keyboard.press("m");
  const muteName = (): Promise<string> => read(page, `document.getElementById("player-mute").getAttribute("aria-label")`);
  const muted = await eventually(async () => (await playback(page, ".player video")).muted && await muteName() === label("Unmute"));
  await page.keyboard.press("m");
  const unmuted = await eventually(async () => !(await playback(page, ".player video")).muted);
  expect.soft({ spacePlays, kPauses, skipped, muted, unmuted }, "P07 Space plays, K pauses, → moves 5 s and M mutes and unmutes, from the keyboard")
    .toEqual({ spacePlays: true, kPauses: true, skipped: true, muted: true, unmuted: true });
  // A drag along the seek bar from half a second in, so only a drag that works lands at three quarters. Each move goes
  // once the last one has moved the video, never after a fixed pause.
  await read(page, `document.querySelector(".player video").currentTime = 0.5`);
  await eventually(async () => Math.abs((await playback(page, ".player video")).time - 0.5) < 0.05);
  const seek = await read<{ left: number; width: number; y: number }>(page, `(() => { const r = document.querySelector(".player .pc-seek").getBoundingClientRect(); return { left: r.left, width: r.width, y: r.y + r.height / 2 }; })()`);
  await page.mouse.move(seek.left + seek.width * 0.2, seek.y);
  await page.mouse.down();
  const { duration } = await playback(page, ".player video");
  const trace: Array<{ at: number; landed: boolean; time: number; dragging: boolean }> = [];
  for (const at of [0.35, 0.5, 0.65, 0.75]) {
    await page.mouse.move(seek.left + seek.width * at, seek.y);
    const landed = await eventually(async () => Math.abs((await playback(page, ".player video")).time - duration * at) < 0.3, 1500);
    trace.push({ at, landed, ...await read<{ time: number; dragging: boolean }>(page, `({ time: document.querySelector(".player video").currentTime, dragging: document.querySelector(".player .pc-seek").hasAttribute("data-dragging") })`) });
  }
  await page.mouse.up();
  const sought = await eventually(async () => { const p = await playback(page, ".player video"); return p.paused && Math.abs(p.time - p.duration * 0.75) < 0.6; });
  expect.soft(sought, `P08 a drag along the seek bar moves the video from 0.5 s to where it is let go ${JSON.stringify({ trace, ...await playback(page, ".player video") })}`).toBe(true);
  const mute = await centre(page, "#player-mute", false);
  await page.mouse.move(mute.x, mute.y);
  await page.waitForTimeout(350);
  const level = await read<{ width: number } | null>(page, `document.querySelector(".player .pc-level")?.getBoundingClientRect().toJSON() ?? null`);
  expect.soft((level?.width ?? 0) > 40, `P09 the volume slider slides out beside its button under the pointer ${JSON.stringify(level)}`).toBe(true);
  if (await read(page, "document.documentElement.dataset.platform") === "darwin") {
    const corner = await read<{ top: number; covered: string[] }>(page, `(() => {
      const dialog = document.querySelector(".player"), found = new Set();
      for (let x = 1; x < ${TRAFFIC_LIGHT_ZONE.width}; x += 2) for (let y = 1; y < ${TRAFFIC_LIGHT_ZONE.height}; y += 2)
        for (const hit of document.elementsFromPoint(x, y)) if (hit !== dialog && dialog.contains(hit)) found.add(hit.id || hit.className || hit.tagName);
      return { top: dialog.getBoundingClientRect().top, covered: [...found] }; })()`);
    expect.soft(corner.covered.length === 0 && corner.top >= TRAFFIC_LIGHT_ZONE.height, `P10 no part of the player lies under the window controls ${JSON.stringify(corner)}`).toBe(true);
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
  expect.soft(closed && (await playback(page, ".player video")).src === "", "P17 Close closes the player and releases the file").toBe(true);
  // The stage: 16:9 and sized by the window alone, so a portrait recording opens in the same box, black beside it. Measured
  // once the dialog's opening animation has finished.
  const stage = async (): Promise<{ width: number; height: number; bars: number; source: string }> => {
    await eventually(() => read<boolean>(page, `document.querySelector(".player").getAnimations().every(animation => animation.playState !== "running")`));
    return read(page, `(() => { const d = document.querySelector(".player").getBoundingClientRect(), v = document.querySelector(".player video");
      const r = v.getBoundingClientRect(), scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      return { width: d.width, height: d.height, bars: r.width - v.videoWidth * scale, source: v.videoWidth + "×" + v.videoHeight }; })()`);
  };
  await openCard(0);
  await eventually(async () => (await read<number>(page, `document.querySelector(".player video").readyState`)) >= 1);
  const wide = await stage();
  await page.locator("#player-close").click();
  await openCard(1);
  await eventually(async () => (await read<number>(page, `document.querySelector(".player")?.hasAttribute("data-open") ? document.querySelector(".player video").readyState : 0`)) >= 1);
  await read(page, `document.querySelector(".player video").pause()`);
  const tall = await stage();
  await keep(page, "player-portrait-light.png");
  await page.locator("#player-close").click();
  expect.soft(Math.abs(wide.width / wide.height - 16 / 9) < 0.02 && Math.abs(tall.width - wide.width) < 1 && Math.abs(tall.height - wide.height) < 1
    && tall.source === "270×480" && tall.bars > wide.width * 0.5 && wide.bars < 1,
  `P18 the player is a 16:9 stage sized by the window: a portrait recording opens in the same box, with black beside it ${JSON.stringify({ wide, tall })}`).toBe(true);
  // The dark theme's player, paused, for the pictures.
  await app.evaluate((_h, _a, electron) => { electron.nativeTheme.themeSource = "dark"; });
  await openCard(0);
  await read(page, `document.querySelector(".player video").pause()`);
  await page.waitForTimeout(300);
  await keep(page, "player-paused-dark.png");
  await page.locator("#player-close").click();
  // P19: every page's console errors fail the test at teardown (fixtures.ts).
});

test("P20 the player's pointer, focus and flashes, as before shadcn (2026-10-07): a pointing hand on the picture and the seek bar, no ring around the picture, its thumb only under the pointer, and a flash for what a click or key did", async () => {
  await openCard(0);
  await eventually(async () => !(await playback(page, ".player video")).paused, 5000);
  await read(page, `document.querySelector(".player video").pause()`);
  const look = (): Promise<{ cursor: string; seekCursor: string; outline: string; thumb: string; track: number; top: number; bottom: number }> => read(page, `(() => {
    const v = document.querySelector(".player video"), seek = document.querySelector(".player .pc-seek");
    const track = seek.querySelector("[data-slot=slider-track]").getBoundingClientRect();
    return { cursor: getComputedStyle(v).cursor, seekCursor: getComputedStyle(seek).cursor, outline: getComputedStyle(v).outlineStyle,
      thumb: getComputedStyle(seek.querySelector("[data-slot=slider-thumb]")).scale, track: track.height, top: track.top, bottom: track.bottom }; })()`);
  await page.locator(".player video").hover();
  await expect.poll(async () => (await look()).thumb, { message: "P20 the seek thumb settles hidden away from the pointer" }).toBe("0");
  const atRest = await look();
  // The opening dialog can still move the bar; locator hover waits for its current geometry to settle.
  await page.locator(".player .pc-seek").hover();
  await expect.poll(async () => {
    const lookNow = await look();
    return lookNow.thumb === "1" && Math.abs(lookNow.track - 6) < 0.05;
  }, { message: "P20 hovering reveals the thumb and thickens the seek track" }).toBe(true);
  const overSeek = await look();
  expect(overSeek.top).toBeCloseTo(atRest.top - 1.5, 1);
  expect(overSeek.bottom).toBeCloseTo(atRest.bottom + 1.5, 1);
  await keep(page, "player-seek-hover.png");
  expect.soft(atRest.cursor === "pointer" && atRest.seekCursor === "pointer" && atRest.thumb === "0" && overSeek.thumb === "1" && overSeek.track > atRest.track,
    `P20 a pointing hand on the picture and the seek bar; the thumb grows in and the track thickens under the pointer ${JSON.stringify({ atRest, overSeek })}`).toBe(true);
  // From the keyboard: the picture has focus and → seeks, yet no ring is drawn around it; the seek flashes at its side.
  await read(page, `document.querySelector(".player video").focus({ focusVisible: true })`);
  await page.keyboard.press("ArrowRight");
  const seek = await read<{ outline: string; hint: string; arrow: string; hidden: boolean }>(page, `(() => { const hint = document.querySelector(".player .pc-seek-forward");
    return { outline: getComputedStyle(document.querySelector(".player video")).outlineStyle, hint: getComputedStyle(hint).animationName,
      arrow: getComputedStyle(hint.querySelector("svg")).animationName, hidden: hint.hidden }; })()`);
  expect.soft(seek, "P20 a key seek flashes three arrows in an arc at its side, with no ring around the picture").toEqual({ outline: "none", hint: "media-hold-seek", arrow: "pc-seek-arrow", hidden: false });
  await page.keyboard.press("ArrowUp");
  const volume = await read<{ bezel: string; text: string }>(page, `({ bezel: getComputedStyle(document.querySelector(".player .pc-bezel")).animationName, text: getComputedStyle(document.querySelector(".player .pc-bezel-text")).animationName })`);
  expect.soft(volume, "P20 a volume key grows a circle at the centre and holds its level, both fading").toEqual({ bezel: "media-bezel", text: "media-hold" });
  await page.waitForTimeout(900);
  await page.locator(".player video").click();
  const clicked = await read<{ kind: string | undefined; hidden: boolean; animation: string }>(page, `(() => { const b = document.querySelector(".player .pc-bezel");
    return { kind: b.dataset.kind, hidden: b.hidden, animation: getComputedStyle(b).animationName }; })()`);
  expect.soft(clicked, "P20 a click on the picture flashes play at the centre").toEqual({ kind: "play", hidden: false, animation: "media-bezel" });
  // A click on the seek bar, then its arrows: the thumb stops their propagation, yet the page learns the keyboard came
  // last (review of 2026-10-07), so a focus line the browser then draws is not hidden. Chromium itself does not count a
  // range clicked with the pointer as focus-visible after its arrows, so no line is expected here.
  await page.locator(".player .pc-seek").click();
  await page.keyboard.press("ArrowRight");
  expect.soft(await read<string | undefined>(page, "document.documentElement.dataset.input"), "P20 after a click, the seek bar's arrows mark keyboard input").toBe("keyboard");
  await page.locator("#player-close").click();
});

test("P11–P15 full screen: the full-screen page gets the name, the controls and the time; rests and wakes; F and Escape hand the time back", async () => {
  const first = await item(0);
  const card = await centre(page, ".clip-open", false);
  await page.mouse.click(card.x, card.y);
  await eventually(async () => !(await playback(page, ".player video")).paused, 5000);
  await read(page, `document.querySelector(".player video").currentTime = 2`);
  await page.waitForTimeout(150);
  // Where the player was when full screen was asked for: the full-screen page must start there.
  const handed = (await playback(page, ".player video")).time;
  const fullWaiting = app.page("video.html");
  await page.locator("#player-fullscreen").click();
  const full = await fullWaiting;
  const shown = await eventually(() => app.evaluate(h => h.videoShown()), 6000);
  const fullPlayback = await playback(full, "#video");
  const fullState = await read<{ title: string; last: string; labels: string[]; native: boolean }>(full, `(() => ({ title: document.querySelector(".pc-title").textContent,
    last: document.querySelector(".pc-row").lastElementChild.id, labels: [...document.querySelectorAll(".pc button")].map(b => b.getAttribute("aria-label")), native: document.getElementById("video").controls }))()`);
  const geometry = await app.evaluate((h, _a, electron) => {
    const settings = h.settingsWindow(), video = h.videoWindow();
    // What production asked for when it made the window: a hidden window is fitted to the work area by the OS (Windows'
    // taskbar), so its own bounds are not the request.
    const created = h.boundary.calls.filter((call: { kind: string }) => call.kind === "window:create").at(-1)!.detail as { bounds: unknown; fullscreen: boolean };
    return { requested: created.bounds, fullscreenOption: created.fullscreen, display: electron.screen.getDisplayMatching(settings.getBounds()).bounds,
      state: h.boundary.windowState(video) as { simpleFullScreen: boolean; fullScreen: boolean; visible: boolean } };
  });
  const handedOver = fullPlayback.time >= handed - 0.3 && fullPlayback.time <= handed + 1.5;
  expect.soft(shown && fullState.title === first.title && fullState.last === "exit" && !fullState.native
    && fullState.labels.join() === [label("Pause"), label("Mute"), label("Exit full screen")].join() && !fullPlayback.paused && handedOver
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
  expect.soft(fullRest, "P12 in full screen the controls and the pointer step aside at rest too").toEqual({ idle: true, opacity: "0", cursor: "none" });
  await full.mouse.move(viewport.width / 2 + 10, viewport.height / 2 + 4);
  await full.waitForTimeout(350);
  const fullWake = await resting(full);
  expect.soft(!fullWake.idle && fullWake.opacity === "1", `P13 …and come back on a move ${JSON.stringify(fullWake)}`).toBe(true);
  const before = (await playback(full, "#video")).time;
  // F leaves: the window fades and closes on the keydown, so the keyup may find no page.
  await full.keyboard.press("f").catch((error: unknown) => { if (!full.isClosed()) throw error; });
  const left = await eventually(() => full.isClosed(), 3000);
  const resumed = await eventually(async () => { const p = await playback(page, ".player video"); return !p.paused && p.time >= before - 0.3 && p.time <= before + 1.5; }, 3000);
  expect.soft(left && resumed, `P14 F leaves full screen, and the player carries on from where it was, playing ${JSON.stringify({ before, after: await playback(page, ".player video") })}`).toBe(true);
  // A double-click on the picture plays full screen; Escape on its page leaves.
  await page.waitForTimeout(1100);
  const again = await centre(page, ".player video", false);
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
