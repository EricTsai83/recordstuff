/**
 * The former `pnpm acceptance:shortcut` normal, restart and settings phases (plan 066 ledger K-N, K-R, K-S): the
 * production main, SettingsWindow, actions, AppShortcuts, AppTray's notification policy, settings.json and the page,
 * with only the OS boundary replaced (hosts/app-host.ts). Registration is the boundary's adapter: a registration it
 * refuses stands for one another app holds, and a callback it calls stands for the key the OS delivered. Neither is OS
 * evidence; real registration, key delivery and window activation are `pnpm acceptance:shortcut-native`'s.
 * Notification.show and tray menus are observed, not delivered or clicked on screen. Window show, focus, minimize and
 * restore are adapter calls answered from a virtual window state.
 */
import { test, expect, type Launched } from "./fixtures";
import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { read, cdpKey, eventually } from "./helpers";
import { describeAccelerator, settingsShortcut } from "../../src/shared/hotkey";

/** The Settings shortcut of this platform (hotkey.ts): ⌥⌘, on macOS, Ctrl+Shift+, elsewhere. */
const SETTINGS_KEY = settingsShortcut(process.platform);
/** The same combination as a stored recording shortcut written another way: the legacy collision K-S02 starts from. */
const LEGACY_KEY = process.platform === "darwin" ? "Alt+CommandOrControl+," : "Shift+Control+,";
const ACCELERATOR = "Control+Shift+F20";
const F20 = { key: "F20", code: "F20", keyCode: 131 };
/** The Settings shortcut editor's limit in src/main/settings/settings-window.ts. */
const SHORTCUT_EDITOR_LIMIT_MS = 15_000;

interface Group { capturing?: boolean; captureTimedOut?: boolean; choices: Array<{ id: string; checked: boolean }>; diagnostics?: Array<{ reason?: string; heading?: string }>; actions?: Array<{ id: string }> }

/** One launched app and its Settings page, with the steps the former fixture took. */
class Session {
  page!: Page;
  constructor(readonly app: Launched) {}
  get settingsFile(): string { return path.join(this.app.data, "userData/settings.json"); }
  saved(): Record<string, any> { return JSON.parse(fs.readFileSync(this.settingsFile, "utf8")); } // eslint-disable-line @typescript-eslint/no-explicit-any
  savedKey(): string { return this.saved().hotkey.accelerator; }
  owned(): Promise<string[]> { return this.app.evaluate(h => [...h.boundary.shortcuts.owned.keys()]); }
  attempts(): Promise<Array<{ accelerator: string; registered: boolean; forced: boolean }>> { return this.app.evaluate(h => [...h.boundary.shortcuts.attempts]); }
  async recordingAttempts(): Promise<Array<{ accelerator: string; registered: boolean; forced: boolean }>> { return (await this.attempts()).filter(a => a.accelerator === ACCELERATOR); }
  notifications(): Promise<Array<{ title: string | undefined; body: string | undefined }>> { return this.app.evaluate(h => h.boundary.notifications.map(n => ({ title: n.title, body: n.body }))); }
  async failureNotifications(): Promise<Array<{ body: string | undefined }>> { return (await this.notifications()).filter(n => n.body?.startsWith("Could not register ")); }
  failing(accelerators: string[]): Promise<void> { return this.app.evaluate((h, list) => { h.boundary.shortcuts.failing = new Set(list); }, accelerators); }
  settingsWindows(): Promise<number[]> { return this.app.evaluate(h => h.settingsWindows()); }
  /** The tray icon right-clicked: production pops its menu up; returns its labels. */
  async trayMenu(): Promise<string[]> { return (await this.app.evaluate(h => h.rightClickTray())).map((item: { label: string }) => item.label); }
  /** Opens Settings as a person does from the menu bar: a right click, then Open RecordStuff. */
  async openFromTray(): Promise<Page> {
    await this.trayMenu();
    const waiting = this.app.page("settings.html");
    await this.app.evaluate(h => h.clickTrayItem("^(Open RecordStuff|開啟 RecordStuff)$"));
    return this.adopt(await waiting);
  }
  /** The registered Settings shortcut's callback, as the OS calls it on the key. */
  async pressSettingsKey(): Promise<void> { await this.app.evaluate((h, key) => h.boundary.shortcuts.press(key), SETTINGS_KEY); }
  /** Waits for the one Settings page after an entry and makes it current. */
  async adopt(page?: Page): Promise<Page> {
    this.page = page ?? await this.app.page("settings.html");
    await expect(this.page.locator("#tab-general")).toBeVisible();
    // SettingsWindow shows and focuses a new window once its page reports its first content (`settings:ready`).
    await expect.poll(() => this.app.evaluate(h => { const state = h.settingsState(); return Boolean(state?.visible && state.focused); }),
      { message: "the entry shows and focuses the Settings window (adapter)" }).toBe(true);
    return this.page;
  }
  async reopenWithKey(): Promise<Page> {
    const waiting = this.app.application.waitForEvent("window", { predicate: page => page.url().includes("settings.html") });
    await this.pressSettingsKey();
    return this.adopt(await waiting);
  }
  group(): Promise<Group> { return this.page.evaluate(() => (window as unknown as { settings: { read: () => Promise<{ groups: Array<{ id: string }> }> } }).settings.read().then(v => v.groups.find(g => g.id === "hotkey"))) as Promise<Group>; }
  async checked(id: string): Promise<boolean> { return (await this.group()).choices.some(c => c.id === id && c.checked); }
  async arm(): Promise<void> {
    await this.page.locator("#setting-hotkey").selectOption("custom");
    await expect.poll(async () => (await this.group()).capturing, { message: "capture armed" }).toBe(true);
  }
  async commit(onPreview?: () => Promise<void>): Promise<void> {
    await this.arm();
    await cdpKey(this.page, F20, ["control", "shift"]);
    await expect(this.page.locator("#shortcut-confirm")).toBeEnabled();
    await onPreview?.();
    await this.page.locator("#shortcut-confirm").click();
    await expect.poll(async () => (await this.group()).capturing, { message: "capture committed" }).toBe(false);
  }
  async escape(): Promise<void> {
    await this.page.keyboard.press("Escape");
    await expect.poll(async () => (await this.group()).capturing, { message: "capture cancelled" }).toBe(false);
  }
  /** A preference through its control: a segment, a switch or the native select. */
  async choose(id: string, value: string): Promise<void> {
    const segment = this.page.locator(`#setting-${id}-${value}`);
    if (await segment.count() && await segment.getAttribute("aria-pressed") !== null) {
      if (await segment.getAttribute("aria-pressed") !== "true") await segment.click();
    } else {
      const control = this.page.locator(`#setting-${id}`);
      if (await control.getAttribute("role") === "switch") { if ((await control.getAttribute("aria-checked") === "true") !== (value === "on")) await control.click(); }
      else await control.selectOption(value);
    }
    await expect.poll(() => read(this.page, `!document.querySelector('.row[aria-busy="true"]')`), { message: "save settled" }).toBe(true);
  }
  /** The platform's close chord on the page, which closes the window (core.ts); waits until no Settings window is left. */
  async closeWithKey(): Promise<void> {
    // The window closes on the keydown, so the keyup has no page left to reach.
    const page = this.page;
    await page.keyboard.press(process.platform === "darwin" ? "Meta+w" : "Control+w").catch((error: unknown) => { if (!page.isClosed()) throw error; });
    await expect.poll(() => this.settingsWindows(), { message: "the close chord closes Settings" }).toEqual([]);
  }
}

test("K-N01–K-N14 normal: a refused registration is saved, explained, notified once per request, retried, and other preferences stay usable", async ({ launchApp }) => {
  const s = new Session(await launchApp({ settings: { appearance: "dark", hotkey: { enabled: false, accelerator: ACCELERATOR } }, failingShortcuts: ["*"] }));
  await s.openFromTray();
  await s.page.locator("#tab-general").click();
  const before = fs.readFileSync(s.settingsFile, "utf8");
  await s.commit(async () => {
    expect.soft(fs.readFileSync(s.settingsFile, "utf8") === before && (await s.group()).capturing, "K-N01 shortcut preview leaves saved preferences unchanged until Confirm").toBe(true);
  });
  await until(s.page, `document.querySelector('#setting-hotkey-diagnostics .diagnostic p')`, 3000);
  const failed = await s.group();
  const last = (await s.recordingAttempts()).at(-1);
  expect.soft(last?.registered === false && last.forced && s.saved().hotkey.enabled && s.savedKey() === ACCELERATOR,
    `K-N02 a refused registration (adapter) is saved as chosen ${JSON.stringify({ last, hotkey: s.saved().hotkey })}`).toBe(true);
  expect.soft(failed.diagnostics?.[0]?.reason === "Another app may be using this shortcut." && await read(s.page, `document.querySelector('#setting-hotkey-diagnostics .diagnostic p').textContent === 'Another app may be using this shortcut.'`),
    "K-N03 failure note rendered by production page").toBe(true);
  const first = await s.failureNotifications();
  expect.soft(first.length === 1 && first[0]?.body?.includes("F20") && first[0]?.body?.includes("Open RecordStuff"), `K-N04 notification requested with shortcut and recovery direction ${JSON.stringify(first)}`).toBe(true);
  await s.arm();
  await s.escape();
  expect.soft((await s.failureNotifications()).length === 1 && (await s.recordingAttempts()).at(-1)?.registered === false, "K-N05 cancel does not repeat notification").toBe(true);
  await s.commit();
  expect.soft((await s.failureNotifications()).length, "K-N06 explicit resave repeats failure notification").toBe(2);
  await s.choose("hotkey", "off");
  const off = await s.group();
  // Every registration fails here, ⌥⌘, too: Off removes only the recording shortcut's note.
  expect.soft(!off.diagnostics?.some(d => d.reason === "Another app may be using this shortcut.") && s.saved().hotkey.enabled === false && s.savedKey() === ACCELERATOR
    && !(await s.owned()).includes(ACCELERATOR), "K-N07 Off retains value and removes failure note").toBe(true);
  expect.soft(off.diagnostics?.length === 1 && off.diagnostics[0]?.heading === "The shortcut for RecordStuff is unavailable" && off.actions?.some(a => a.id === "retryRegistration") === true
    && await read(s.page, `(h => h.textContent === 'The shortcut for RecordStuff is unavailable' && h.querySelector('svg[aria-hidden="true"]') !== null)(document.querySelector('#setting-hotkey-diagnostics .diagnostic strong'))`),
  `K-N08 a failed Settings shortcut is explained in the card, not only by a retry button ${JSON.stringify(off.diagnostics)}`).toBe(true);
  await s.choose("notifications", "off");
  await s.commit();
  expect.soft((await s.failureNotifications()).length === 2 && Boolean((await s.group()).diagnostics?.length), "K-N09 notification preference respected on failure").toBe(true);
  await s.failing([]);
  await expect(s.page.locator("#setting-hotkey-retryRegistration")).toBeEnabled();
  await s.page.locator("#setting-hotkey-retryRegistration").click();
  expect.soft(await eventually(async () => (await s.owned()).includes(ACCELERATOR) && !(await s.group()).diagnostics?.length, 5000)
    && await s.checked(ACCELERATOR), "K-N10 retry button registration recovery clears error and retains selection").toBe(true);
  await s.arm();
  await s.page.keyboard.press("r");
  await expect(s.page.locator("#feedback")).toContainText(process.platform === "darwin" ? "Command or Control" : "Ctrl");
  expect.soft(s.savedKey(), "K-N11 invalid candidate does not change saved shortcut").toBe(ACCELERATOR);
  await s.escape();
  await s.choose("language", "zh-TW");
  expect.soft(s.saved().language, "K-N12 other preferences remain usable after failure/recovery").toBe("zh-TW");
  await s.choose("language", "en");
  await s.choose("notifications", "on");
  await s.failing(["*"]);
  await s.commit();
  expect.soft(Boolean((await s.group()).diagnostics?.length) && (await s.recordingAttempts()).at(-1)?.registered === false && s.saved().hotkey.enabled,
    "K-N13 leave failed selection for a fresh process").toBe(true);
  // Sizes every runner's display holds: a reopened window is fitted to the work area (CI's is about 1024 × 681).
  await s.app.evaluate(h => h.settingsWindow().setSize(640, 560));
  const geometry = path.join(s.app.data, "userData/settings-window.json");
  expect.soft(await eventually(() => fs.existsSync(geometry) && JSON.parse(fs.readFileSync(geometry, "utf8")).width === 640 && JSON.parse(fs.readFileSync(geometry, "utf8")).height === 560 && s.savedKey() === ACCELERATOR, 5000),
    "K-N14 window resize persists independently of shortcut preferences").toBe(true);

  // Restart: the same data in a fresh process, with every registration still refused.
  await s.app.close();
  const r = new Session(await launchApp({ data: s.app.data, failingShortcuts: ["*"] }));
  await r.openFromTray();
  await r.page.locator("#tab-general").click();
  expect.soft(await r.app.evaluate(h => h.settingsWindow().getSize()), "K-R01 window size survives a fresh app process").toEqual([640, 560]);
  await until(r.page, `document.querySelector('#setting-hotkey-diagnostics .diagnostic p')`, 3000);
  const restored = await r.group();
  expect.soft(r.saved().hotkey.enabled && r.savedKey() === ACCELERATOR && restored.choices.some(c => c.id === ACCELERATOR && c.checked),
    "K-R02 restart loads failed custom selection without reseeding").toBe(true);
  const attempts = await r.recordingAttempts();
  expect.soft(attempts.length === 1 && attempts[0]?.registered === false && restored.diagnostics?.[0]?.reason === "Another app may be using this shortcut."
    && await read(r.page, `document.querySelector('#setting-hotkey-diagnostics .diagnostic p').textContent === 'Another app may be using this shortcut.'`),
  `K-R03 restart retries registration and renders failure ${JSON.stringify(attempts)}`).toBe(true);
  const restartNotices = await r.failureNotifications();
  expect.soft(restartNotices.length === 1 && restartNotices[0]?.body?.includes("F20"), "K-R04 restart requests failure notification").toBe(true);
});

test("K-S01–K-S39 settings: legacy key, appearance, entry and restore, reserved key, failed registrations in the tray, crash, editor limit, held saves, entry rounds", async ({ launchApp }) => {
  test.setTimeout(150_000);
  const s = new Session(await launchApp({ settings: { appearance: "dark", hotkey: { enabled: true, accelerator: LEGACY_KEY } } }));
  const firstMenu = await s.trayMenu();
  const waiting = s.app.page("settings.html");
  await s.app.evaluate(h => h.clickTrayItem("^Open RecordStuff$"));
  await s.adopt(await waiting);
  await s.page.locator("#tab-general").click();
  expect.soft(await s.app.evaluate((_h, _a, electron) => electron.nativeTheme.themeSource) === "dark" && await read(s.page, `matchMedia('(prefers-color-scheme: dark)').matches`),
    "K-S01 saved dark appearance is applied at startup").toBe(true);
  const attempts = await s.attempts();
  expect.soft(attempts.length === 1 && (await s.owned()).includes(SETTINGS_KEY) && await s.checked(SETTINGS_KEY) && s.saved().hotkey.accelerator === LEGACY_KEY,
    `K-S02 legacy equivalent key retains recording ownership and value ${JSON.stringify(attempts)}`).toBe(true);
  expect.soft(firstMenu.some(label => label.includes("open RecordStuff above to change it.")), `K-S03 legacy collision keeps tray access with recovery explanation: ${firstMenu.join(" | ")}`).toBe(true);
  const before = fs.readFileSync(s.settingsFile, "utf8");
  await s.commit(async () => {
    expect.soft(fs.readFileSync(s.settingsFile, "utf8") === before && (await s.group()).capturing, "K-S04 shortcut preview leaves saved preferences unchanged until Confirm").toBe(true);
  });
  expect.soft(await eventually(async () => (await s.owned()).includes(SETTINGS_KEY) && (await s.owned()).includes(ACCELERATOR)) && (await s.owned()).length === 2,
    "K-S05 changing legacy key recovers Settings independently").toBe(true);
  for (const [id, appearance] of [["K-S06", "light"], ["K-S07", "dark"], ["K-S08", "system"]] as const) {
    await s.choose("appearance", appearance);
    const applied = await eventually(async () => await s.app.evaluate((_h, _a, electron) => electron.nativeTheme.themeSource) === appearance
      && await read(s.page, `matchMedia('(prefers-color-scheme: dark)').matches`) === await s.app.evaluate((_h, _a, electron) => electron.nativeTheme.shouldUseDarkColors));
    expect.soft(applied && s.saved().appearance === appearance && await s.page.locator(`#setting-appearance-${appearance}`).getAttribute("aria-pressed") === "true",
      `${id} ${appearance} appearance updates native theme, renderer and saved preference`).toBe(true);
  }
  // Minimize, then the Settings shortcut: production asks to restore, show and focus the same window (adapter calls; the real ones are native).
  const count = (await s.settingsWindows()).length;
  const callsBefore = (await s.app.calls()).length;
  await s.app.evaluate(h => h.settingsWindow().minimize());
  await s.pressSettingsKey();
  await s.pressSettingsKey();
  const restore = (await s.app.calls()).slice(callsBefore).map(call => call.kind);
  const state = await s.app.evaluate(h => h.settingsState());
  expect.soft(restore.includes("window:restore") && restore.includes("window:show") && restore.includes("window:focus") && !state.minimized && state.visible && state.focused
    && (await s.settingsWindows()).length === count, `K-S09a the Settings callback asks to restore, show and focus the minimized window without duplication ${JSON.stringify({ restore, state })}`).toBe(true);
  await s.arm();
  expect.soft(await s.owned(), "K-S10 capture suspends both registrations").toEqual([]);
  await s.page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+Comma" : "Control+Shift+Comma");
  // The page refuses the reserved key itself and leaves Confirm disabled; a click on it, as the former fixture's, ends the capture.
  await expect(s.page.locator("#shortcut-confirm")).toBeDisabled();
  await s.page.locator("#shortcut-confirm").click({ force: true });
  await expect.poll(async () => (await s.group()).capturing).toBe(false);
  expect.soft(await eventually(async () => (await s.owned()).length === 2) && s.savedKey() === ACCELERATOR
    && await read(s.page, `document.getElementById('feedback').textContent.includes('reserved for opening RecordStuff')`), "K-S11 reserved commit rejected and ownership restored").toBe(true);
  await s.failing(["*"]);
  await s.arm();
  await s.escape();
  for (const [id, language] of [["K-S12", "en"], ["K-S13", "zh-TW"]] as const) {
    await s.page.evaluate(value => (window as unknown as { settings: { choose: (g: string, c: string) => Promise<unknown> } }).settings.choose("language", value), language);
    const menu = await s.trayMenu();
    expect.soft(menu.some(label => label.includes(language === "en" ? "The shortcut for RecordStuff is unavailable:" : "開啟 RecordStuff 的快捷鍵無法使用，")) && !menu.some(label => label.includes(describeAccelerator(SETTINGS_KEY, process.platform))),
      `${id} ${language} Settings registration failure is explained without working label: ${menu.join(" | ")}`).toBe(true);
  }
  const beforeRefresh = (await s.attempts()).length;
  await s.trayMenu(); await s.trayMenu();
  expect.soft((await s.attempts()).length, "K-S14 tray refresh does not retry failed registrations").toBe(beforeRefresh);
  await s.failing([]);
  await s.arm();
  await s.escape();
  await expect.poll(async () => (await s.owned()).length, { message: "cancel recovery" }).toBe(2);

  // A renderer crash while capturing.
  await s.arm();
  const crashed = s.page;
  await s.app.evaluate(h => h.settingsWindow().webContents.forcefullyCrashRenderer());
  expect.soft(await eventually(async () => crashed.isClosed() && (await s.settingsWindows()).length === 0 && (await s.owned()).length === 2, 5000),
    "K-S15 renderer crash disposes the window and restores shortcut ownership").toBe(true);
  await s.reopenWithKey();
  expect.soft(s.page !== crashed && (await s.settingsWindows()).length === count, "K-S16 the next open after a crash loads a replacement panel").toBe(true);
  await s.page.locator("#tab-general").click();
  for (const [ids, language] of [[["K-S17", "K-S18", "K-S19"], "en"], [["K-S20", "K-S21", "K-S22"], "zh-TW"]] as const) {
    await s.page.locator(`#setting-language-${language}`).click();
    await expect(s.page.locator("html")).toHaveAttribute("lang", language === "en" ? "en" : "zh-Hant");
    await expect.poll(() => read(s.page, `!document.querySelector('.row[aria-busy="true"]')`)).toBe(true);
    // Main starts the limit while `arm` runs, so time measured from before it never runs ahead of main's timer.
    const armedAt = Date.now();
    await s.arm();
    await s.page.keyboard.press("Control+k");
    await expect(s.page.locator("#shortcut-confirm")).toBeEnabled();
    await s.page.waitForTimeout(armedAt + SHORTCUT_EDITOR_LIMIT_MS - 1000 - Date.now());
    expect.soft((await s.group()).capturing && await read(s.page, `document.querySelector('.capture-timeout').hidden`), `${ids[0]} shortcut editor stays open until its limit (${language})`).toBe(true);
    await s.page.waitForTimeout(Math.max(0, armedAt + SHORTCUT_EDITOR_LIMIT_MS - Date.now()));
    await until(s.page, `!document.querySelector('.capture-timeout').hidden`, 5000);
    const expired = await s.group();
    const message = await read<string>(s.page, `document.querySelector('.capture-timeout').textContent`);
    expect.soft(expired.captureTimedOut === true && !expired.capturing && await read(s.page, `!document.querySelector('.capture-timeout').hidden && document.activeElement.id === 'setting-hotkey'`)
      && message.includes(language === "en" ? "15 seconds" : "15 秒") && s.savedKey() === ACCELERATOR && (await s.owned()).length === 2,
    `${ids[1]} shortcut timeout explains the unchanged value (${language}): ${message}`).toBe(true);
    await s.arm();
    expect.soft(!(await s.group()).captureTimedOut && await read(s.page, `document.querySelector('.capture-timeout').hidden`), `${ids[2]} new edit clears shortcut timeout (${language})`).toBe(true);
    await s.escape();
  }
  await s.page.locator("#setting-language-en").click();
  await expect(s.page.locator("html")).toHaveAttribute("lang", "en");

  if (process.platform === "darwin") {
    await s.arm();
    await s.page.keyboard.press("Control+w");
    await expect(s.page.locator("#shortcut-confirm")).toBeEnabled();
    expect.soft(!s.page.isClosed() && await read<string>(s.page, `document.getElementById('shortcut-capture').textContent`), "K-S23 the panel captures macOS Control+W instead of closing").toContain("⌃W");
    await s.page.locator("#shortcut-confirm").click();
    expect.soft(await eventually(async () => (await s.owned()).includes("Control+W") && (await s.owned()).includes(SETTINGS_KEY)) && s.savedKey() === "Control+W"
      && !(await s.owned()).includes(ACCELERATOR) && await s.checked("Control+W"), "K-S24 Confirm saves and registers Control+W").toBe(true);
    // A confirmed save held at settings.json's rename (a test gate, not a disk stall).
    await s.app.evaluate(h => h.holdSettingsWrite());
    await s.arm();
    await cdpKey(s.page, F20, ["control", "shift"]);
    await s.page.locator("#shortcut-confirm").click();
    await expect.poll(() => s.app.evaluate(h => h.writeHeld()), { message: "the confirmed save reaches the held write" }).toBe(true);
    expect.soft((await s.owned()).length === 0 && (await s.group()).capturing, "K-S25 a held confirmed save keeps capture and both keys suspended").toBe(true);
    await s.closeWithKey();
    await expect.poll(async () => (await s.owned()).sort()).toEqual(["CommandOrControl+Alt+,", "Control+W"]);
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect.soft(s.savedKey() === "Control+W" && (await s.owned()).length === 2, "K-S26 the close chord during a held save restores the committed keys before the save settles").toBe(true);
    await s.app.evaluate(h => h.releaseSettingsWrite(false));
    expect.soft(await eventually(async () => { const owned = await s.owned(); return owned.includes(ACCELERATOR) && !owned.includes("Control+W") && owned.includes(SETTINGS_KEY); }, 5000),
      "K-S26b the held save registers after persistence").toBe(true);
    await s.reopenWithKey();
    await s.page.locator("#tab-general").click();
    expect.soft(s.savedKey() === ACCELERATOR && await s.checked(ACCELERATOR), "K-S27 after the held save a reopened panel shows the persisted key").toBe(true);
    // Reopen during the held save, then capture again while it finishes.
    await s.app.evaluate(h => h.holdSettingsWrite());
    await s.arm();
    await s.page.keyboard.press("Control+w");
    await s.page.locator("#shortcut-confirm").click();
    await expect.poll(() => s.app.evaluate(h => h.writeHeld())).toBe(true);
    await s.closeWithKey();
    await expect.poll(async () => (await s.owned()).sort()).toEqual(["CommandOrControl+Alt+,", ACCELERATOR].sort());
    await s.reopenWithKey();
    await s.page.locator("#tab-general").click();
    expect.soft(await s.checked(ACCELERATOR), "K-S28 a panel reopened during a held save shows the committed key").toBe(true);
    await s.arm();
    await s.app.evaluate(h => h.releaseSettingsWrite(false));
    await expect.poll(async () => s.savedKey() === "Control+W" && await s.checked("Control+W")).toBe(true);
    await s.page.waitForTimeout(300);
    expect.soft((await s.owned()).length === 0 && (await s.group()).capturing, "K-S29 an old save finishing during a new capture keeps both keys suspended").toBe(true);
    await s.escape();
    expect.soft(await eventually(async () => (await s.owned()).includes("Control+W") && (await s.owned()).includes(SETTINGS_KEY)) && (await s.owned()).length === 2 && !(await s.owned()).includes(ACCELERATOR),
      "K-S30 cancelling the new capture registers the key the old save persisted").toBe(true);
    // A crash while a failing save is held.
    await s.app.evaluate(h => h.holdSettingsWrite());
    const noticesBefore = (await s.notifications()).length;
    await s.arm();
    await cdpKey(s.page, F20, ["control", "shift"]);
    await s.page.locator("#shortcut-confirm").click();
    await expect.poll(() => s.app.evaluate(h => h.writeHeld())).toBe(true);
    const crashing = s.page;
    await s.app.evaluate(h => h.settingsWindow().webContents.forcefullyCrashRenderer());
    await expect.poll(async () => crashing.isClosed() && (await s.owned()).includes("Control+W") && (await s.owned()).includes(SETTINGS_KEY)).toBe(true);
    await s.app.evaluate(h => h.releaseSettingsWrite(true));
    await expect.poll(async () => (await s.notifications()).length > noticesBefore).toBe(true);
    const failureNotice = (await s.notifications()).slice(noticesBefore).map(n => n.body ?? "");
    expect.soft(s.savedKey() === "Control+W" && (await s.owned()).length === 2 && (await s.owned()).includes("Control+W") && failureNotice.length === 1
      && /Could not save the shortcut|無法儲存快捷鍵設定/.test(failureNotice[0] ?? ""), `K-S31 a failing held save after a crash keeps the prior setting and registration and says so ${JSON.stringify(failureNotice)}`).toBe(true);
    await s.reopenWithKey();
    await s.page.locator("#tab-general").click();
    expect.soft(await s.checked("Control+W"), "K-S32 the panel reopened after that crash shows the retained key").toBe(true);
    await s.commit();
    await expect.poll(async () => (await s.owned()).includes(ACCELERATOR) && (await s.owned()).includes(SETTINGS_KEY)).toBe(true);
  }
  // The maintainer's entry smoke test against the production page; the callbacks and the tray are the boundary's.
  const savedBeforeEntry = fs.readFileSync(s.settingsFile, "utf8");
  const logPath = path.join(s.app.data, "logs/recordstuff.log");
  const logBeforeEntry = fs.readFileSync(logPath, "utf8").length;
  const settingsWindow = (): Promise<number[]> => s.app.evaluate(h => h.settingsWindow().getSize());
  await s.app.evaluate(h => h.settingsWindow().setSize(620, 540));
  await expect.poll(settingsWindow).toEqual([620, 540]);
  for (const round of [1, 2]) {
    await s.closeWithKey();
    await s.reopenWithKey();
    expect.soft(await settingsWindow(), `K-S${30 + round * 3} entry round ${round}: resized dimensions survive close and reopen`).toEqual([620, 540]);
    const fromShortcut = s.page;
    const ids = await s.settingsWindows();
    await s.pressSettingsKey();
    const state = await s.app.evaluate(h => h.settingsState());
    expect.soft(JSON.stringify(await s.settingsWindows()) === JSON.stringify(ids) && ids.length === 1 && state.visible && state.focused && !fromShortcut.isClosed(),
      `K-S${31 + round * 3} entry round ${round}: the shortcut reuses one Settings window and asks to show and focus it ${JSON.stringify(state)}`).toBe(true);
    await s.closeWithKey();
    await s.openFromTray();
    const trayAlive = !await s.app.evaluate(h => h.trayDestroyed());
    expect.soft(s.page !== fromShortcut && (await s.settingsWindows()).length === 1 && trayAlive && (await s.owned()).includes(SETTINGS_KEY) && (await s.owned()).includes(ACCELERATOR),
      `K-S${32 + round * 3} entry round ${round}: the close chord keeps the app and the tray reopens Settings`).toBe(true);
  }
  const entryLog = fs.readFileSync(logPath, "utf8").slice(logBeforeEntry);
  expect.soft(!/state → (starting|countdown|recording)/.test(entryLog) && fs.readdirSync(path.join(s.app.data, "videos/RecordStuff")).length === 0
    && fs.readFileSync(s.settingsFile, "utf8") === savedBeforeEntry, "K-S39 Settings entry cycles never start capture or change preferences").toBe(true);
});

async function until(page: Page, expression: string, timeout: number): Promise<boolean> {
  return eventually(async () => Boolean(await read(page, expression)), timeout);
}
