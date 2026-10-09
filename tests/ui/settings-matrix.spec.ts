/**
 * The former settings fixture's snapshot matrix (plan 066 ledger S023–S036): both languages and themes at the
 * default, narrow and minimum sizes, each of ten model states from the real `settingsView`, judged for overflow,
 * the window-controls corner, the status card, the Recordings tab with its library, thumbnails over the media
 * scheme, the player's cannot-play state and the card menu by mouse. Every picture is kept in the test's output
 * folder for inspection only: nothing here compares pixels, so the design stays free to change.
 *
 * One case per language, theme, size and tab (plan 070), tagged with the tab's scope (`pnpm test:scope`), so a change
 * to one tab runs that tab's states in every combination without the others; the player and card menu over
 * Recordings are cases of their own at the minimum size. Every combination and state still runs in a full suite.
 */
import { test, expect, type Launched } from "./fixtures";
import type { Page, TestInfo } from "@playwright/test";
import fs from "node:fs";
import { read, until, centre, underControls, frames } from "./helpers";
import { translate } from "../../src/shared/i18n";

const STATES = ["recording", "general", "listening", "error", "locked", "sound-off", "countdown-off", "library", "library-empty", "library-failed"] as const;
type State = typeof STATES[number];

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

/** A picture kept in the test's output folder for inspection; it is never compared. */
async function picture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  fs.writeFileSync(testInfo.outputPath(name), await page.screenshot({ animations: "disabled", caret: "hide" }));
}

/** Clip buttons by their stable ids: `clip-<id>-open` plays a recording, `clip-<id>-more` opens its actions. */
const OPEN = 'button[id^="clip-"][id$="-open"]', MORE = 'button[id^="clip-"][id$="-more"]';

type Size = "default" | "narrow" | "minimum";
/** The tab each state is drawn on, and the scope tag of that tab's cases. */
const TABS = {
  recording: { states: ["recording", "error", "locked", "sound-off", "countdown-off"], tag: "@recording-settings" },
  general: { states: ["general", "listening"], tag: "@general" },
  library: { states: ["library", "library-empty", "library-failed"], tag: "@library" },
} as const satisfies Record<string, { states: readonly State[]; tag: string }>;

/** A launched Settings view at `scheme` and `size`, with the third recording's missing thumbnail expected. */
async function open(launchView: () => Promise<{ launched: Launched; page: Page }>, lang: "en" | "zh-TW", scheme: "light" | "dark", size: Size): Promise<{ host: Launched; page: Page }> {
  const { launched: host, page } = await launchView();
  // The third recording has no picture: the scheme answers its thumbnail 404 and the card shows the fallback (S028).
  host.expectedErrors.push(/Failed to load resource: the server responded with a status of 404 .*\(recordstuff-media:\/\/thumb\//);
  await expect(page.locator("#setting-hotkey")).toBeVisible();
  await host.evaluate((h, args) => { h.theme(args.scheme); h.setSize(...h.SNAPSHOT_SIZES[args.size]); }, { scheme, size });
  // The launch view has no Recordings tab yet; the snapshot context's first push brings it, as the first of the ten
  // states did when they ran in one case.
  await pushState(host, "recording", lang);
  return { host, page };
}

/** S023–S028, S035, S036: one state drawn on its tab, judged and kept as a picture. */
async function checkState(host: Launched, page: Page, testInfo: TestInfo, lang: "en" | "zh-TW", scheme: "light" | "dark", size: Size, state: State): Promise<void> {
  const key = `${lang}/${scheme}/${size}/${state}`;
  const tab = state.startsWith("library") ? "library" : state === "general" || state === "listening" ? "general" : "recording";
  await page.locator(`#tab-${tab}`).click();
  await pushState(host, state, lang);
  await page.waitForTimeout(80);
  await read(page, `document.getElementById("settings-panel").scrollTop = 0`);
  if (state === "listening") await page.locator("#shortcut-capture").focus();
  else if (state === "sound-off") await page.locator("#setting-countdownSound").focus();
  else await read(page, `document.querySelector("#settings-panel [role=combobox], #settings-panel input")?.focus()`);
  if (state === "sound-off" || state === "countdown-off") await read(page, `document.getElementById("setting-countdownSound-row").scrollIntoView({ block: "nearest" })`);
  await frames(page);
  const fits = await read<boolean>(page, `document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth && document.getElementById("settings-panel").scrollWidth <= document.getElementById("settings-panel").clientWidth`);
  expect.soft(fits, `S023 ${key}: no horizontal or outer-page overflow`).toBe(true);
  expect.soft(await underControls(page) ?? [], `S024 ${key}: nothing clickable lies under the window controls`).toEqual([]);
  if (tab === "library") {
    const unreadable = translate("Could not read the output folder. Check the folder and its drive, or choose another folder.", lang);
    // Read by headings, the cards' ids and visible text, so the tab's layout and class names stay free to change.
    const shown = await read<{ days: number; cards: number; empty: boolean; status: boolean }>(page, `(() => {
      const library = document.getElementById("library");
      const visible = text => [...library.querySelectorAll("*")].some(el => el.childElementCount === 0 && el.textContent.trim() === text && el.checkVisibility());
      return { days: [...library.querySelectorAll("h2")].filter(h => h.checkVisibility()).length,
        cards: [...library.querySelectorAll(${JSON.stringify(OPEN)})].filter(b => b.checkVisibility()).length,
        empty: visible(${JSON.stringify(translate("No recordings yet", lang))}), status: visible(${JSON.stringify(unreadable)}) }; })()`);
    // Two days on macOS; elsewhere the user-named recording dates from its creation, today, so three (settings-panel S022).
    const days = await host.evaluate(h => new Set(h.library().state.files.map((file: { recordedAt: number }) => new Date(file.recordedAt).toDateString())).size);
    if (state === "library") expect.soft(shown.days === days && days === (process.platform === "darwin" ? 2 : 3) && shown.cards === 3 && !shown.empty && !shown.status, `S027 ${key}: Recordings shows its cards by day ${JSON.stringify(shown)}`).toBe(true);
    else if (state === "library-empty") expect.soft(shown.cards === 0 && shown.empty && !shown.status, `S035 ${key}: Recordings shows the empty folder ${JSON.stringify(shown)}`).toBe(true);
    else expect.soft(shown.cards === 0 && !shown.empty && shown.status, `S036 ${key}: Recordings shows why the folder cannot be read ${JSON.stringify(shown)}`).toBe(true);
    if (state === "library" && size === "default") {
      // Windows has three day groups, so the last card can sit below the viewport even at the default size.
      // Bring each thumbnail into view to trigger its production lazy loading, then restore the snapshot's scroll.
      for (const clip of await page.locator(OPEN).all()) await clip.scrollIntoViewIfNeeded();
      // Served pictures load; the missing one fails to load (404), which is what leaves its card on the fallback.
      const thumbs = `(() => { const images = [...document.querySelectorAll(${JSON.stringify(`${OPEN} img`)})];
        return { pictures: images.filter(i => i.complete && i.naturalWidth > 0).length, fallback: images.filter(i => i.complete && i.naturalWidth === 0).length, pending: images.filter(i => !i.complete).length }; })()`;
      await until(page, `(t => t.pending === 0 && t.pictures + t.fallback === 3)(${thumbs})`);
      expect.soft(await read(page, thumbs), `S028 ${key}: thumbnails arrive over recordstuff-media: under the shipped CSP, and a recording without one shows the fallback`)
        .toEqual({ pictures: 2, fallback: 1, pending: 0 });
      await read(page, `document.getElementById("settings-panel").scrollTop = 0`);
      await frames(page);
    }
  }
  if (state === "recording" || state === "locked") {
    // The status card speaks only when needed: a busy recorder shows it, a ready one does not.
    const card = await read<{ shown: boolean; text: string }>(page, `(el => ({ shown: el.checkVisibility() && el.getBoundingClientRect().height > 0, text: el.textContent.trim() }))(document.getElementById("status"))`);
    expect.soft(state === "locked" ? card.shown && card.text !== "" : !card.shown, `S025 ${key}: the status card speaks only when needed ${JSON.stringify(card)}`).toBe(true);
    if (size === "default" && state === "recording") {
      // From the top of the page the first Tab reaches the tabs, never the window actions (Hide interface).
      await read(page, `(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex"); })()`);
      await page.keyboard.press("Tab");
      const first = await read<string>(page, `document.activeElement?.id ?? ""`);
      expect.soft(first.startsWith("tab-"), `S026 ${key}: the first Tab from the top reaches the tabs, not Hide interface (${first})`).toBe(true);
    }
  }
  if (state === "general") {
    // Wherever the design puts it, Hide interface stays reachable on General at every size.
    const hide = await read<boolean>(page, `[...document.querySelectorAll("button[aria-label]")].some(b => b.getAttribute("aria-label") === ${JSON.stringify(translate("Hide interface", lang))} && b.checkVisibility() && !b.disabled)`);
    expect.soft(hide, `S025 ${key}: Hide interface is visible and enabled`).toBe(true);
  }
  await picture(page, testInfo, `panel-${lang}-${scheme}-${size}-${state}.png`);
}

/** S029–S034: the player and the card's menu over Recordings, the tab already showing the library state. */
async function checkOverlays(page: Page, testInfo: TestInfo, lang: "en" | "zh-TW", scheme: "light" | "dark", size: Size): Promise<void> {
  // The player over the tab. The file is served, byte ranges and all, but holds no media: what a recording that cannot be played gets.
  await page.locator(OPEN).first().click();
  const cannotPlay = translate("This recording cannot be played here. Choose Open from its ⋯ menu to play it in another app.", lang);
  const opened = await until(page, `(() => { const p = document.getElementById("player-close")?.closest('[role="dialog"]');
    return Boolean(p?.checkVisibility() && [...p.querySelectorAll("*")].some(el => el.childElementCount === 0 && el.textContent === ${JSON.stringify(cannotPlay)} && el.checkVisibility())); })()`);
  const player = await read<{ open: boolean; spoken: string; fits: boolean; buttons: string[]; named: boolean; reachable: boolean }>(page, `(() => { const p = document.getElementById("player-close").closest('[role="dialog"]'), r = p.getBoundingClientRect();
    const buttons = [...p.querySelectorAll("button")], own = ["player-close", "player-play", "player-mute", "player-fullscreen"].map(id => document.getElementById(id));
    return { open: p.checkVisibility(), spoken: document.getElementById("player-feedback").textContent, buttons: buttons.map(b => b.id).filter(Boolean),
      named: buttons.every(b => b.getAttribute("aria-label")),
      reachable: own.every(b => b && p.contains(b) && b.checkVisibility() && (c => c.width > 0 && c.left >= r.left - 0.5 && c.right <= r.right + 0.5 && c.top >= r.top - 0.5 && c.bottom <= r.bottom + 0.5)(b.getBoundingClientRect())),
      fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && p.scrollWidth <= p.clientWidth }; })()`);
  expect.soft(opened && player.open && player.spoken === cannotPlay
    && ["player-close", "player-fullscreen", "player-mute", "player-play"].every(id => player.buttons.includes(id)) && player.named && player.reachable && player.fits,
  `S029 ${lang}/${scheme}/${size}/player: opens over Recordings with its named controls inside it, fits the window and says a recording it cannot play cannot be played here ${JSON.stringify(player)}`).toBe(true);
  expect.soft(await underControls(page) ?? [], `S030 ${lang}/${scheme}/${size}/player: nothing clickable lies under the window controls`).toEqual([]);
  await picture(page, testInfo, `player-${lang}-${scheme}-${size}.png`);
  await page.locator("#player-close").click();
  const closed = await until(page, `!document.getElementById("player-close")?.checkVisibility()`);
  expect.soft(closed, `S031 ${lang}/${scheme}/${size}/player: Close closes it`).toBe(true);
  if (!closed) await page.locator("#player-close").click();
  // The card's file actions: a click on its ⋯ button, then a right-click on the card.
  const menuState = (id = "clip-menu"): Promise<{ open: boolean; items: string[]; fits: boolean; focused: string; expanded: string | null }> => read(page, `(() => {
    const m = document.getElementById("${id}"), r = m?.getBoundingClientRect();
    return { open: Boolean(m?.hasAttribute("data-open")), items: m ? [...m.querySelectorAll("[role=menuitem]")].map(i => i.textContent) : [],
      fits: Boolean(r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight), focused: document.activeElement?.id ?? "",
      expanded: document.querySelector(${JSON.stringify(MORE)}).getAttribute("aria-expanded") }; })()`);
  await read(page, `document.querySelector(${JSON.stringify(OPEN)}).scrollIntoView({ block: "nearest" })`);
  const card = await centre(page, OPEN, false), more = await centre(page, MORE, false);
  await page.mouse.move(card.x, card.y);
  await page.mouse.move(more.x, more.y);
  await page.mouse.click(more.x, more.y);
  await until(page, `document.getElementById("clip-menu")?.hasAttribute("data-open")`, 2000);
  const fromButton = await menuState();
  await frames(page);
  expect.soft(await underControls(page) ?? [], `S032 ${lang}/${scheme}/${size}/card menu: nothing clickable lies under the window controls`).toEqual([]);
  await picture(page, testInfo, `clip-menu-${lang}-${scheme}-${size}.png`);
  // A hover on the last item moves focus to it from the first, so the keyboard continues where the pointer is.
  const last = await centre(page, "#clip-menu-trash", false);
  await page.mouse.move(last.x, last.y);
  await page.waitForTimeout(150);
  const hovered = await read<string>(page, `document.activeElement?.id ?? ""`);
  await picture(page, testInfo, `clip-menu-hover-${lang}-${scheme}-${size}.png`);
  expect.soft(hovered, `S033 ${lang}/${scheme}/${size}/card menu: hovering an item focuses it`).toBe("clip-menu-trash");
  // An Escape with no menu open would close the window: only one that opened is answered.
  if ((await menuState()).open) await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  const escaped = await menuState();
  await page.mouse.click(card.x, card.y, { button: "right" });
  await expect(page.locator("#clip-context-menu")).toBeVisible();
  const fromRightClick = await menuState("clip-context-menu");
  await page.keyboard.press("Escape");
  await expect(page.locator("#clip-context-menu")).toBeHidden();
  const expectedItems = [translate("Show in Finder", lang), translate("Open", lang), translate("Rename…", lang),
    // The fixture holds a folder (plan 071), so the card can move there.
    translate("Move to", lang), translate("Move to Trash", lang)];
  expect.soft(fromButton.open && JSON.stringify(fromButton.items) === JSON.stringify(expectedItems) && fromButton.fits
    && (fromButton.focused === "clip-menu" || fromButton.focused.startsWith("clip-menu-") || fromButton.focused.endsWith("-more")) && fromButton.expanded === "true"
    && !escaped.open && escaped.expanded === "false" && escaped.focused.endsWith("-more") && !page.isClosed() && fromRightClick.open && fromRightClick.fits,
  `S034 ${lang}/${scheme}/${size}/card menu: ⋯ and a right-click open the file's actions inside the window; Escape closes it and gives focus back ${JSON.stringify({ fromButton, escaped, fromRightClick })}`).toBe(true);
}

for (const lang of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) for (const size of ["default", "narrow", "minimum"] as const) {
  for (const [tab, { states, tag }] of Object.entries(TABS)) {
    test(`S023–S036 ${lang}/${scheme}/${size}/${tab}: ${states.length} states for overflow, the window controls' corner, the status card, Recordings and thumbnails`, { tag: ["@layout", tag] }, async ({ launchView }, testInfo) => {
      const { host, page } = await open(launchView, lang, scheme, size);
      for (const state of states) await checkState(host, page, testInfo, lang, scheme, size, state);
    });
  }
}
// Input behavior is independent of width: the overlays run at the tightest size, in both languages and palettes.
for (const lang of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`S029–S034 ${lang}/${scheme}/minimum: the player that cannot play and the card's menu over Recordings`, { tag: ["@layout", "@library"] }, async ({ launchView }, testInfo) => {
    const { host, page } = await open(launchView, lang, scheme, "minimum");
    await checkState(host, page, testInfo, lang, scheme, "minimum", "library");
    await checkOverlays(page, testInfo, lang, scheme, "minimum");
  });
}
