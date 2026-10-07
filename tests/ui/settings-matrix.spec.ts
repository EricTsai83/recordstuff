/**
 * The former settings fixture's snapshot matrix (plan 066 ledger S023–S036): both languages and themes at the
 * default, narrow and minimum sizes, each of ten model states from the real `settingsView`, judged for overflow,
 * the window-controls corner, the status card, the Recordings tab with its library, thumbnails over the media
 * scheme, the player's cannot-play state and the card menu by mouse. Every picture is kept in the test's output
 * folder for inspection; the selected ones are compared with reviewed macOS baselines (settings-matrix.spec.ts-snapshots).
 */
import { test, expect, type Launched } from "./fixtures";
import type { Page, TestInfo } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { read, until, centre, underControls, frames } from "./helpers";
import { translate } from "../../src/shared/i18n";

const STATES = ["recording", "general", "listening", "error", "locked", "sound-off", "countdown-off", "library", "library-empty", "library-failed"] as const;
type State = typeof STATES[number];
/** Compared with a reviewed baseline: the three tabs' everyday faces. The rest are kept as pictures only. */
const BASELINED: readonly State[] = ["recording", "general", "library"];

/** The snapshot context the former fixture built for `state` (scripts/fixtures/settings-panel.ts, before plan 066). */
async function pushState(host: Launched, state: State, lang: "en" | "zh-TW"): Promise<void> {
  await host.evaluate((h, args) => {
    const library = h.library().state, now = h.snapshotNow();
    const view = h.settingsView(args.state === "locked" ? { type: "starting" } : { type: "idle" }, {
      // One fixed moment for every picture: the library's day groups and the file name example read it.
      ...h.baseContext(), language: args.lang, now,
      ...(args.state === "error" ? { display: { kind: "display", id: "2", label: "BenQ BL2480T" }, displayFailure: "target_removed" } : {}),
      ...(args.state === "sound-off" ? { countdownSound: false } : {}),
      ...(args.state === "countdown-off" ? { countdown: 0 } : {}),
      ...(args.state === "library" ? { library, now } : args.state === "library-empty" ? { library: { ...library, files: [] }, now }
        : args.state === "library-failed" ? { library: { ...library, failed: true, files: [] }, now } : {}),
    });
    if (args.state === "listening") view.groups.find((group: { id: string }) => group.id === "hotkey").capturing = true;
    h.push(view);
  }, { state, lang });
}

/**
 * Baselines are reviewed per runtime, the platform and its OS major version (Darwin 25 is macOS 26), since fonts and
 * text drawing change between them. Where none was reviewed (another macOS, Windows) the picture is kept and the
 * geometry above is the evidence; the test says so in its annotations instead of passing a comparison it did not make.
 */
const RUNTIME = `${process.platform}${os.release().split(".")[0]}`;
async function picture(page: Page, testInfo: TestInfo, name: string, baseline: boolean): Promise<void> {
  const image = await page.screenshot({ animations: "disabled", caret: "hide" });
  fs.writeFileSync(testInfo.outputPath(name), image);
  if (!baseline) return;
  const named = name.replace(/\.png$/, `-${RUNTIME}.png`);
  // A plain run never writes a baseline (playwright.config.ts); a missing one is said, not created or failed.
  if (testInfo.config.updateSnapshots !== "all" && testInfo.config.updateSnapshots !== "changed" && !fs.existsSync(testInfo.snapshotPath(named))) {
    testInfo.annotations.push({ type: "visual baseline", description: `none reviewed for ${RUNTIME}: ${path.basename(named)} kept as a picture; geometry only` });
    return;
  }
  expect.soft(image).toMatchSnapshot(named, { maxDiffPixelRatio: 0.002 });
}

for (const lang of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) for (const size of ["default", "narrow", "minimum"] as const) {
  test(`S023–S036 ${lang}/${scheme}/${size}: ten states for overflow, the window controls' corner, the status card, Recordings, thumbnails, the player and the card menu`, async ({ launchView }, testInfo) => {
    const { launched: host, page } = await launchView();
    // The third recording has no picture: the scheme answers its thumbnail 404 and the card shows the fallback (S028).
    host.expectedErrors.push(/Failed to load resource: the server responded with a status of 404 .*\(recordstuff-media:\/\/thumb\//);
    await expect(page.locator("#setting-hotkey")).toBeVisible();
    await host.evaluate((h, args) => { h.theme(args.scheme); h.setSize(...h.SNAPSHOT_SIZES[args.size]); }, { scheme, size });
    for (const state of STATES) {
      const key = `${lang}/${scheme}/${size}/${state}`;
      const tab = state.startsWith("library") ? "library" : state === "general" || state === "listening" ? "general" : "recording";
      await page.locator(`#tab-${tab}`).click();
      await pushState(host, state, lang);
      await page.waitForTimeout(80);
      await read(page, `document.getElementById("settings-panel").scrollTop = 0`);
      if (state === "listening") await page.locator("#shortcut-capture").focus();
      else if (state === "sound-off") await page.locator("#setting-countdownSound").focus();
      else await read(page, `document.querySelector("#settings-panel [data-slot=select-trigger], #settings-panel input")?.focus()`);
      if (state === "sound-off" || state === "countdown-off") await read(page, `document.getElementById("setting-countdownSound-row").scrollIntoView({ block: "nearest" })`);
      await frames(page);
      const fits = await read<boolean>(page, `document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth && document.getElementById("settings-panel").scrollWidth <= document.getElementById("settings-panel").clientWidth`);
      expect.soft(fits, `S023 ${key}: no horizontal or outer-page overflow`).toBe(true);
      expect.soft(await underControls(page) ?? [], `S024 ${key}: nothing clickable lies under the window controls`).toEqual([]);
      if (tab === "library") {
        const shown = await read<{ days: number; cards: number; empty: boolean; summary: string; status: string }>(page, `({
          days: document.querySelectorAll(".library-day").length, cards: document.querySelectorAll(".clip").length,
          empty: !document.querySelector(".library-empty").hidden, summary: document.querySelector(".library-summary").textContent,
          status: (el => el.hidden ? "" : el.textContent)(document.querySelector(".library-status")) })`);
        const unreadable = translate("Could not read the output folder. Check the folder and its drive, or choose another folder.", lang);
        // Two days on macOS; elsewhere the user-named recording dates from its creation, today, so three (settings-panel S022).
        const days = await host.evaluate(h => new Set(h.library().state.files.map((file: { recordedAt: number }) => new Date(file.recordedAt).toDateString())).size);
        if (state === "library") expect.soft(shown.days === days && days === (process.platform === "darwin" ? 2 : 3) && shown.cards === 3 && !shown.empty && shown.summary !== "" && shown.status === "", `S027 ${key}: Recordings shows its cards by day ${JSON.stringify(shown)}`).toBe(true);
        else if (state === "library-empty") expect.soft(shown.cards === 0 && shown.empty && shown.status === "", `S035 ${key}: Recordings shows the empty folder ${JSON.stringify(shown)}`).toBe(true);
        else expect.soft(shown.cards === 0 && !shown.empty && shown.status === unreadable, `S036 ${key}: Recordings shows why the folder cannot be read ${JSON.stringify(shown)}`).toBe(true);
        if (state === "library" && size === "default") {
          // Windows has three day groups, so the last card can sit below the viewport even at the default size.
          // Bring each thumbnail into view to trigger its production lazy loading, then restore the snapshot's scroll.
          for (const thumb of await page.locator(".clip-thumb").all()) await thumb.scrollIntoViewIfNeeded();
          const thumbs = `(() => { const images = [...document.querySelectorAll(".clip-thumb img")];
            return { pictures: images.filter(i => i.complete && i.naturalWidth === 480).length, fallback: document.querySelectorAll(".clip-thumb.no-thumb").length, pending: images.filter(i => !i.complete).length }; })()`;
          await until(page, `(t => t.pending === 0 && t.pictures + t.fallback === 3)(${thumbs})`);
          expect.soft(await read(page, thumbs), `S028 ${key}: thumbnails arrive over recordstuff-media: under the shipped CSP, and a recording without one shows the fallback`)
            .toEqual({ pictures: 2, fallback: 1, pending: 0 });
          await read(page, `document.getElementById("settings-panel").scrollTop = 0`);
          await frames(page);
        }
      }
      if (state === "recording" || state === "locked") {
        // The status card speaks only when needed; a split Hide/Quit control sits in the sidebar's foot when wide.
        const card = await read<{ shown: boolean; tone: string; foot: boolean; buttons: number; hide: string }>(page, `(() => { const el = document.getElementById("status"), foot = document.getElementById("sidebar-about");
          return { shown: el.getBoundingClientRect().height > 0, tone: el.dataset.tone ?? "", foot: foot.getBoundingClientRect().height > 0, buttons: foot.querySelectorAll("button").length,
            hide: foot.querySelector("#sidebar-about-hide")?.getAttribute("aria-label") ?? "" }; })()`);
        const expected = (state === "locked" ? card.shown && card.tone === "busy" : !card.shown && card.tone === "ready")
          && (size === "default" ? card.foot && card.buttons === 2 && card.hide === translate("Hide interface", lang) : !card.foot);
        expect.soft(expected, `S025 ${key}: the status card speaks only when needed; Hide/Quit sits in the sidebar's foot when wide ${JSON.stringify(card)}`).toBe(true);
        if (size === "default" && state === "recording") {
          // From the top of the page the first Tab reaches the tabs, never Hide interface at the sidebar's foot.
          await read(page, `(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex"); })()`);
          await page.keyboard.press("Tab");
          const first = await read<string>(page, `document.activeElement?.id ?? ""`);
          expect.soft(card.foot && first.startsWith("tab-"), `S026 ${key}: the first Tab from the top reaches the tabs, not Hide interface in the sidebar's foot (${first})`).toBe(true);
        }
      }
      await picture(page, testInfo, `panel-${lang}-${scheme}-${size}-${state}.png`, BASELINED.includes(state));
      // Geometry and reviewed pictures above retain the full matrix. Input behavior is independent of
      // width; exercise overlays at the tightest size, in both languages and palettes (four runs, not twelve).
      if (state !== "library" || size !== "minimum") continue;
      // The player over the tab. The file is served, byte ranges and all, but holds no media: what a recording that cannot be played gets.
      await page.locator(".clip-open").first().click();
      const opened = await until(page, `(() => { const p = document.querySelector(".player"); return Boolean(p?.hasAttribute("data-open") && !p.querySelector(".player-error").hidden); })()`);
      const player = await read<{ open: boolean; error: string; spoken: string; fits: boolean; buttons: string[]; named: boolean; native: boolean; barInside: boolean }>(page, `(() => { const p = document.querySelector(".player"), r = p.getBoundingClientRect();
        const buttons = [...p.querySelectorAll("button")], bar = p.querySelector(".pc-bottom").getBoundingClientRect();
        return { open: p.hasAttribute("data-open"), error: p.querySelector(".player-error").hidden ? "" : p.querySelector(".player-error").textContent,
          spoken: p.querySelector('[role="status"]').textContent, buttons: buttons.map(b => b.id), named: buttons.every(b => b.getAttribute("aria-label") && b.querySelector("svg")),
          native: p.querySelector("video").controls, barInside: bar.bottom <= r.bottom + 0.5 && bar.top >= r.top,
          fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && p.scrollWidth <= p.clientWidth }; })()`);
      expect.soft(opened && player.open && player.error !== "" && player.spoken === player.error && player.buttons.join() === "player-close,player-play,player-mute,player-fullscreen"
        && player.named && !player.native && player.barInside && player.fits,
      `S029 ${lang}/${scheme}/${size}/player: opens over Recordings with its own named controls over the picture, fits the window and says a recording it cannot play cannot be played here ${JSON.stringify(player)}`).toBe(true);
      expect.soft(await underControls(page) ?? [], `S030 ${lang}/${scheme}/${size}/player: nothing clickable lies under the window controls`).toEqual([]);
      await picture(page, testInfo, `player-${lang}-${scheme}-${size}.png`, false);
      await page.locator("#player-close").click();
      const closed = await until(page, `!document.querySelector(".player")?.hasAttribute("data-open") && Boolean(document.querySelector(".player")?.hidden)`);
      expect.soft(closed, `S031 ${lang}/${scheme}/${size}/player: Close closes it`).toBe(true);
      if (!closed) await page.locator("#player-close").click();
      // The card's file actions: a click on its ⋯ button, then a right-click on the card.
      const menuState = (id = "clip-menu"): Promise<{ open: boolean; items: string[]; fits: boolean; focused: string; expanded: string | null }> => read(page, `(() => {
        const m = document.getElementById("${id}"), r = m?.getBoundingClientRect();
        return { open: Boolean(m?.hasAttribute("data-open")), items: m ? [...m.querySelectorAll("[role=menuitem]")].map(i => i.textContent) : [],
          fits: Boolean(r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight), focused: document.activeElement?.id ?? "",
          expanded: document.querySelector(".clip-more").getAttribute("aria-expanded") }; })()`);
      await read(page, `document.querySelector(".clip").scrollIntoView({ block: "nearest" })`);
      const card = await centre(page, ".clip .clip-thumb", false), more = await centre(page, ".clip .clip-more", false);
      await page.mouse.move(card.x, card.y);
      await page.mouse.move(more.x, more.y);
      await page.mouse.click(more.x, more.y);
      await until(page, `document.getElementById("clip-menu")?.hasAttribute("data-open")`, 2000);
      const fromButton = await menuState();
      await frames(page);
      expect.soft(await underControls(page) ?? [], `S032 ${lang}/${scheme}/${size}/card menu: nothing clickable lies under the window controls`).toEqual([]);
      await picture(page, testInfo, `clip-menu-${lang}-${scheme}-${size}.png`, false);
      // A hover on the last item: it alone is lit, it takes focus from the first, and its words stay legible on the fill.
      const last = await centre(page, "#clip-menu-trash", false);
      await page.mouse.move(last.x, last.y);
      await page.waitForTimeout(150);
      const hovered = await read<{ lit: string[]; focused: string }>(page, `(() => {
        const rgba = value => { const ctx = new OffscreenCanvas(1, 1).getContext("2d"); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
        const items = [...document.querySelectorAll("#clip-menu [role=menuitem]")];
        if (!document.getElementById("clip-menu")) return { lit: [], focused: document.activeElement?.id ?? "" };
        const lit = items.filter(i => rgba(getComputedStyle(i).backgroundColor)[3] > 0);
        return { lit: lit.map(i => i.id), focused: document.activeElement?.id ?? "" }; })()`);
      await picture(page, testInfo, `clip-menu-hover-${lang}-${scheme}-${size}.png`, false);
      expect.soft(hovered.lit.join() === "clip-menu-trash" && hovered.focused === "clip-menu-trash",
        `S033 ${lang}/${scheme}/${size}/card menu: hovering an item lights it alone and focuses it ${JSON.stringify(hovered)}`).toBe(true);
      // An Escape with no menu open would close the window: only one that opened is answered.
      if ((await menuState()).open) await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      const escaped = await menuState();
      await page.mouse.click(card.x, card.y, { button: "right" });
      await expect(page.locator("#clip-context-menu")).toBeVisible();
      const fromRightClick = await menuState("clip-context-menu");
      await page.keyboard.press("Escape");
      await expect(page.locator("#clip-context-menu")).toBeHidden();
      const expectedItems = [translate("Show in Finder", lang), translate("Open", lang), translate("Rename…", lang), translate("Move to Trash", lang)];
      expect.soft(fromButton.open && JSON.stringify(fromButton.items) === JSON.stringify(expectedItems) && fromButton.fits
        && (fromButton.focused === "clip-menu" || fromButton.focused.startsWith("clip-menu-") || fromButton.focused.endsWith("-more")) && fromButton.expanded === "true"
        && !escaped.open && escaped.expanded === "false" && escaped.focused.endsWith("-more") && !page.isClosed() && fromRightClick.open && fromRightClick.fits,
      `S034 ${lang}/${scheme}/${size}/card menu: ⋯ and a right-click open the file's actions inside the window; Escape closes it and gives focus back ${JSON.stringify({ fromButton, escaped, fromRightClick })}`).toBe(true);
    }
  });
}
