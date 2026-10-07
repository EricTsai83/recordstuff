/**
 * The former settings fixture's recording-failure cases (plan 066 ledger S067–S115): the production
 * `RecordingResults` model with a controlled store behind the real page, acknowledged, retried and removed with
 * Playwright mouse and keyboard input, held and delayed durable saves, the failures tab's day groups and keyboard
 * navigation, and the shadcn focus rings. View host (hosts/view-host.ts, `panel`). DOM focus here is the page's
 * own (`document.hasFocus()` holds in the background); a window made inactive by another one in front is a desktop
 * case (S103, S105: `pnpm acceptance:settings-native`).
 */
import { test, expect, type Launched } from "./fixtures";
import type { Page, TestInfo } from "@playwright/test";
import fs from "node:fs";
import { read, until, clickAt, centre, eventually } from "./helpers";

const FAILURE = { id: "fixture-failure", occurredAt: "2026-09-24T12:00:00Z", code: "disk_full", detail: "ENOSPC: controlled fixture", outcome: "pending" };
type Failure = Partial<typeof FAILURE> & { partialPath?: string; recordingPath?: string };

let host: Launched, page: Page;
test.beforeEach(async ({ launchView }) => {
  ({ launched: host, page } = await launchView());
  await expect(page.locator("#setting-hotkey")).toBeVisible();
});

const update = (patch: Failure): Promise<void> => host.evaluate((h, value) => { h.results.update(value); }, { ...FAILURE, ...patch });
const persist = (): Promise<void> => host.evaluate(h => h.results.persist());
const all = (): Promise<Array<{ id: string; acknowledged: boolean; persistenceFailed?: boolean; saving?: boolean; outcome: string }>> =>
  host.evaluate(h => h.results.all.map((r: Record<string, unknown>) => ({ id: r.id, acknowledged: r.acknowledged, persistenceFailed: r.persistenceFailed, saving: r.saving, outcome: r.outcome })));
const current = async () => (await all())[0];
const set = (values: Record<string, unknown>): Promise<void> => host.evaluate((h, next) => { Object.assign(h.state, next); }, values);
const callCount = (): Promise<number> => host.evaluate(h => h.chooseCalls.length);
/** As the former fixture's pushResult: the view with the entry token `focus`, then a moment for the page. */
async function pushResult(lang: "en" | "zh-TW", focus = 0): Promise<void> {
  await host.evaluate((h, args) => h.pushResult(args.lang, args.focus), { lang, focus });
  await page.waitForTimeout(120);
}
const lastFocus = (): Promise<number> => host.evaluate(h => h.state.lastFocus);
async function shot(testInfo: TestInfo, name: string): Promise<void> {
  fs.writeFileSync(testInfo.outputPath(name), await page.screenshot({ animations: "disabled", caret: "hide" }));
}
/** Rows start collapsed (plan 047): opens the one holding `selector` with Enter on its header. */
async function openRowWith(selector: string): Promise<void> {
  const rowId = await read<string>(page, `document.querySelector(${JSON.stringify(selector)})?.closest(".recording-result")?.id ?? ""`);
  if (!rowId || await read<boolean>(page, `document.getElementById(${JSON.stringify(rowId)})?.hasAttribute("data-open")`)) return;
  await page.locator(`#${rowId} > .result-summary`).focus();
  await page.keyboard.press("Enter");
  if (!await until(page, `document.getElementById(${JSON.stringify(rowId)})?.hasAttribute("data-open")`)) throw new Error(`Could not open ${rowId}`);
}
/** Main's rows, in order, as the DOM must show them before a click is aimed. */
async function domMatchesMain(): Promise<boolean> {
  const main = (await all()).map(r => [r.id, Boolean(r.persistenceFailed)]);
  return JSON.stringify(await read(page, `[...document.querySelectorAll(".recording-result")].map(a => [a.dataset.resultId, !a.querySelector(".result-persistence").hidden])`)) === JSON.stringify(main);
}
/** A mouse click on the first row's `action`, once the page shows main's rows, then waits for `expected`. */
async function clickAction(expected: string, action = "acknowledge"): Promise<void> {
  await expect.poll(domMatchesMain, { message: `rendered rows match main before ${action}` }).toBe(true);
  const before = await callCount();
  await openRowWith(`.recording-result [data-action="${action}"]`);
  await clickAt(page, `.recording-result [data-action="${action}"]`);
  await expect.poll(async () => await callCount() > before && Boolean(await read(page, expected)), { message: `recording-result ${action} settled: ${expected}` }).toBe(true);
}

test("failure causes stay distinct from preservation badges, review state and neutral descriptions in both languages and themes", async ({}, testInfo) => {
  for (const failure of [
    { id: "disk", code: "disk_full", outcome: "partial", partialPath: "/tmp/partial.mp4" },
    { id: "write", code: "output_write_failed", outcome: "empty" },
    { id: "display", code: "display_unavailable", outcome: "unknown", recordingPath: "/tmp/unconfirmed.mp4" },
    { id: "permission", code: "permission_denied", outcome: "pending" },
    { id: "audio", code: "no_audio_track", outcome: "empty" },
    { id: "interrupted", code: "capture_failed", outcome: "empty" },
  ]) {
    await update({ ...failure, outcome: "pending" });
    await update(failure);
  }
  await persist();
  for (const lang of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
    await host.evaluate((h, value) => h.theme(value), scheme);
    await pushResult(lang);
    await page.locator("#tab-failures").click();
    const label = lang === "en"
      ? { empty: "Not kept", partial: "Partially kept", pending: "Processing", unknown: "Unconfirmed result" }
      : { empty: "未保留", partial: "部分保留", pending: "處理中", unknown: "結果不明" };
    for (const [id, state] of [["disk", "partial"], ["write", "empty"], ["display", "unknown"], ["permission", "pending"]] as const) {
      await expect(page.locator(`[data-result-id="${id}"] .result-badge`)).toHaveText(label[state]);
      await expect(page.locator(`[data-result-id="${id}"] .result-badge`)).toHaveAttribute("data-outcome", state);
    }
    const icons = await read<string[]>(page, `["disk", "write", "display", "permission", "audio", "interrupted"].map(id => document.querySelector('[data-result-id="' + id + '"] .result-mark svg').getAttribute("class"))`);
    expect(icons[0]).toBe(icons[1]);
    expect(new Set(icons).size).toBe(5);
    const colours = await read<string[]>(page, `[...document.querySelectorAll(".result-outcome")].map(el => getComputedStyle(el).color)`);
    expect(new Set(colours).size).toBe(1);
    expect(colours[0]).toBe(await read(page, `getComputedStyle(document.querySelector(".result-time")).color`));
    // Theme transitions finish before comparing the neutral badges with the row's final text colour.
    await expect.poll(() => read<boolean>(page, `["display", "permission"].every(id => getComputedStyle(document.querySelector('[data-result-id="' + id + '"] .result-badge')).color === getComputedStyle(document.querySelector(".result-outcome")).color)`)).toBe(true);
    const tones = await read<string[]>(page, `["disk", "write", "display", "permission"].map(id => getComputedStyle(document.querySelector('[data-result-id="' + id + '"] .result-badge')).color)`);
    expect(tones[0]).not.toBe(tones[1]);
    expect(tones[0]).not.toBe(colours[0]);
    expect(tones[2]).toBe(colours[0]);
    expect(tones[3]).toBe(colours[0]);
    for (const [size, width, height] of [["default", 960, 640], ["minimum", 380, 360]] as const) {
      await host.evaluate((h, value) => h.setSize(value.width, value.height), { width, height });
      await read(page, `document.getElementById("settings-panel").scrollTop = 0`);
      expect(await read<boolean>(page, `document.getElementById("settings-panel").scrollWidth <= document.getElementById("settings-panel").clientWidth && [...document.querySelectorAll(".result-heading")].every(el => el.scrollWidth <= el.clientWidth)`)).toBe(true);
      const tab = await read<{ inside: boolean; fullName: boolean }>(page, `(() => { const tab = document.getElementById("tab-failures"), badge = tab.querySelector(".tab-badge"), name = tab.querySelector(".tab-name"), r = tab.getBoundingClientRect(), b = badge.getBoundingClientRect(); return { inside: b.left >= r.left && b.right <= r.right && b.top >= r.top && b.bottom <= r.bottom, fullName: name.scrollWidth <= name.clientWidth }; })()`);
      expect(tab.inside, `${lang}/${scheme}/${size}: the unread count stays inside its tab tile`).toBe(true);
      if (size === "default") expect(tab.fullName, `${lang}/${scheme}: the sidebar shows the full tab name beside the unread count`).toBe(true);
      if (size === "default") {
        const aligned = await read<boolean>(page, `(() => { const tabs = [...document.querySelectorAll('.tabs [role="tab"]')], first = tabs[0]; return tabs.every(tab => [".tab-icon", ".tab-name"].every(selector => Math.abs(tab.querySelector(selector).getBoundingClientRect().left - first.querySelector(selector).getBoundingClientRect().left) < 0.5)); })()`);
        expect(aligned, `${lang}/${scheme}: every sidebar icon and name shares the same left edge`).toBe(true);
      }
      await shot(testInfo, `failure-design-${lang}-${scheme}-${size}.png`);
    }
  }
  await openRowWith('[data-result-id="disk"] [data-action="acknowledge"]');
  await clickAt(page, '[data-result-id="disk"] [data-action="acknowledge"]');
  await expect(page.locator('[data-result-id="disk"]')).not.toHaveClass(/unread/);
  await expect(page.locator('[data-result-id="disk"] .result-badge')).toHaveText("部分保留");
  await expect(page.locator('[data-result-id="disk"] .result-mark svg')).toHaveClass(/hard-drive/);
});

test("S067–S086 the failure history: pending, partial, acknowledgement, entries, a stale press, persistence failures, retries and removal by mouse and keyboard", async ({}, testInfo) => {
  await host.evaluate(h => h.setSize(380, 360));
  await update({});
  await pushResult("zh-TW", 1);
  expect.soft(await read<boolean>(page, `document.querySelector(".recording-result")?.hasAttribute("data-open") && document.querySelector('.recording-result [data-action="acknowledge"]').disabled && document.querySelector(".result-outcome").textContent.includes("正在處理錄影") && document.activeElement === document.querySelector(".recording-result > .result-summary")`),
    "S067 recording failure visible immediately with notifications off; pending result cannot be acknowledged").toBe(true);
  await update({ outcome: "partial", partialPath: "/tmp/錄影資料夾/2026-09-24 20-00-00.recording.mp4" });
  for (const lang of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
    await host.evaluate((h, value) => h.theme(value), scheme);
    await pushResult(lang, 2);
    expect.soft(await read<boolean>(page, `(() => { const a = document.querySelector(".recording-result"); return a.scrollWidth <= a.clientWidth && [...a.querySelectorAll("button")].every(b => b.scrollWidth <= b.clientWidth); })()`),
      `S068 result ${lang}/${scheme} at minimum size fits`).toBe(true);
    await shot(testInfo, `result-${lang}-${scheme}.png`);
  }
  const collapsedFocused = `!document.querySelector(".recording-result")?.hasAttribute("data-open") && document.activeElement === document.querySelector(".recording-result > .result-summary")`;
  await clickAt(page, '.recording-result [data-action="acknowledge"]');
  expect.soft(await eventually(async () => (await current())?.acknowledged === true && Boolean(await read(page, collapsedFocused))),
    "S069 a mouse Got it acknowledges only the offered result and collapses it").toBe(true);
  await page.keyboard.press("Enter");
  expect.soft(await until(page, `document.querySelector(".recording-result")?.hasAttribute("data-open")`), "S070 acknowledged result can be reopened with keyboard").toBe(true);
  // Explicit entry reopens an acknowledged result even after the user collapses it.
  await pushResult("zh-TW", 3);
  expect.soft(await read<boolean>(page, `document.querySelector(".recording-result")?.hasAttribute("data-open") && document.activeElement === document.querySelector(".recording-result > .result-summary")`),
    "S071 explicit result entry expands and focuses an acknowledged result").toBe(true);
  await update({ id: "new-failure" });
  await pushResult("en", 3);
  expect.soft(!(await current())!.acknowledged && await read<boolean>(page, `(() => { const row = document.querySelector(".recording-result"); return row.classList.contains("unread") && !row.hasAttribute("data-open") && row.querySelector('[data-action="acknowledge"]').disabled && document.getElementById("tab-failures").textContent === "Troubleshooting (1)"; })()`),
    "S072 a new failure becomes unread while notifications are disabled").toBe(true);

  // A press on the previous result's button, released after a new result replaced it.
  await update({ id: "new-failure", outcome: "empty" });
  await pushResult("en", 3);
  await openRowWith('.recording-result [data-action="acknowledge"]');
  const stale = await centre(page, '.recording-result [data-action="acknowledge"]');
  await page.mouse.move(stale.x, stale.y);
  await page.mouse.down();
  await page.waitForTimeout(50);
  await update({ id: "replacement-failure" });
  await update({ id: "replacement-failure", outcome: "empty" });
  await pushResult("en", 3);
  await page.mouse.up();
  await page.waitForTimeout(100);
  const replaced = await current();
  expect.soft(replaced?.id === "replacement-failure" && !replaced.acknowledged, "S073 mouse press on previous result cannot acknowledge its replacement").toBe(true);

  await set({ resultSaveFails: true });
  await update({ id: "persistence-failure" });
  await update({ id: "persistence-failure", outcome: "empty" });
  await persist();
  for (const lang of ["en", "zh-TW"] as const) {
    await pushResult(lang, 4);
    expect.soft(await read<boolean>(page, `(() => { const el = document.querySelector(".result-persistence"); return !el.hidden && el.textContent.length > 0 && el.scrollWidth <= el.clientWidth; })()`),
      `S074 persistence failure ${lang} stays readable at minimum size`).toBe(true);
    await shot(testInfo, `result-persistence-${lang}.png`);
  }
  await clickAction(`!document.querySelector(".result-error").hidden`);
  expect.soft(!(await current())?.acknowledged && await read<boolean>(page, `document.querySelector(".recording-result")?.hasAttribute("data-open") && !document.querySelector(".result-persistence").hidden && !document.querySelector(".result-error").hidden`),
    "S075 failed durable acknowledgement stays unread and expanded").toBe(true);
  await set({ resultSaveFails: false });
  await clickAction(`document.querySelector(".result-persistence").hidden && document.querySelector(".recording-result")?.hasAttribute("data-open")`, "retry");
  expect.soft(!(await current())?.acknowledged && !(await current())?.persistenceFailed, "S076 retry saving an unread failure does not acknowledge or collapse it").toBe(true);
  await clickAction(`document.querySelector(".result-persistence").hidden && !document.querySelector(".recording-result")?.hasAttribute("data-open")`);
  expect.soft((await current())?.acknowledged === true && await read<boolean>(page, `!document.querySelector(".recording-result")?.hasAttribute("data-open") && document.querySelector(".result-persistence").hidden`),
    "S077 retry durably acknowledges and clears the persistence warning").toBe(true);
  await set({ resultSaveFails: true });
  await update({ id: "persistence-failure", outcome: "unknown", detail: "recheck changed an acknowledged result" });
  await persist();
  for (const lang of ["en", "zh-TW"] as const) {
    await pushResult(lang, 5);
    if (!await read<boolean>(page, `document.querySelector(".recording-result")?.hasAttribute("data-open")`)) {
      await page.locator(".recording-result > .result-summary").first().focus();
      await page.keyboard.press("Enter");
      if (!await until(page, `document.querySelector(".recording-result")?.hasAttribute("data-open")`)) throw new Error("History summary did not open");
    }
    expect.soft(await read<boolean>(page, `(() => { const b = document.querySelector('.recording-result [data-action="retry"]'); return !b.disabled && b.scrollWidth <= b.clientWidth && b.textContent.includes(${JSON.stringify(lang === "en" ? "Retry saving the record" : "重試儲存紀錄")}); })()`),
      `S078 acknowledged ${lang} result offers a readable save retry`).toBe(true);
    await shot(testInfo, `result-retry-${lang}.png`);
  }
  await clickAction(`!document.querySelector(".result-error").hidden`, "retry");
  expect.soft((await current())?.acknowledged === true && await read<boolean>(page, `document.querySelector(".result-error").textContent === "無法完成此操作，請重試。" && !document.querySelector(".result-persistence").hidden`),
    "S079 failed acknowledged retry does not claim an unread record").toBe(true);
  await set({ resultSaveFails: false });
  await clickAction(`document.querySelector(".result-persistence").hidden && document.querySelector(".result-error").hidden`, "retry");
  expect.soft((await current())?.acknowledged === true && !(await current())?.persistenceFailed, "S080 acknowledged result save retry removes warning without making it unread").toBe(true);
  expect.soft(await read<boolean>(page, `document.querySelectorAll(".recording-result").length === 4 && new Set([...document.querySelectorAll(".result-actions button")].map(b => b.id)).size === document.querySelectorAll(".result-actions button").length`),
    "S081 consecutive failures remain individually visible").toBe(true);
  for (const lang of ["en", "zh-TW"] as const) {
    await host.evaluate(h => h.setSize(560, 680));
    await pushResult(lang, 6);
    await read(page, `document.getElementById("settings-panel").scrollTop = 0`);
    await shot(testInfo, `history-${lang}.png`);
  }
  await clickAction(`document.querySelectorAll(".recording-result").length === 3`, "remove");
  const remaining = await all();
  expect.soft(remaining.length === 3 && remaining.some(r => !r.acknowledged), "S082 removing reviewed metadata preserves other unread failures").toBe(true);
  await read(page, `document.getElementById("feedback").textContent = ""`);
  await pushResult("en", 6);
  expect.soft(await read<boolean>(page, `!document.getElementById("feedback").textContent.includes("The disk is full")`), "S083 language changes do not announce the entire failure history").toBe(true);
  await host.evaluate(async h => { for (const result of [...h.results.all]) await h.results.acknowledge(result.id); });
  await pushResult("en", 7);
  // Removing the lowest row by keyboard keeps focus on the row above it, in view (plan 035 D3).
  const count = (await all()).length;
  const lowest = `document.querySelectorAll(".recording-result")[${count - 1}]`;
  await page.locator(".recording-result > .result-summary").nth(count - 1).focus();
  if (!await read<boolean>(page, `${lowest}.hasAttribute("data-open")`)) {
    await page.keyboard.press("Enter");
    if (!await until(page, `${lowest}.hasAttribute("data-open")`)) throw new Error("Could not open the lowest reviewed row");
  }
  await page.locator(".recording-result").nth(count - 1).locator('[data-action="remove"]').focus();
  await page.keyboard.press("Space");
  const removed = await until(page, `document.querySelectorAll(".recording-result").length === ${count - 1}`);
  expect.soft(removed && await until(page, `(() => { const rows = document.querySelectorAll(".recording-result > .result-summary"); const target = rows[rows.length - 1];
      const box = target?.getBoundingClientRect(), panel = document.getElementById("settings-panel").getBoundingClientRect();
      return document.activeElement === target && box.top >= panel.top && box.bottom <= panel.bottom; })()`),
    "S084 removing the lowest row by keyboard moves focus to the row above it and keeps it in view").toBe(true);
  while ((await all()).length) {
    if (!await read<boolean>(page, `document.querySelector(".recording-result")?.hasAttribute("data-open")`)) {
      await page.locator(".recording-result > .result-summary").first().focus();
      await page.keyboard.press("Enter");
      if (!await until(page, `document.querySelector(".recording-result")?.hasAttribute("data-open")`)) throw new Error("Could not open reviewed row");
    }
    const before = (await all()).length;
    await clickAction(`document.querySelectorAll(".recording-result").length === ${before - 1}`, "remove");
  }
  expect.soft(await read<boolean>(page, `document.activeElement.id === "tab-failures" && !document.querySelector(".recording-result") && !document.querySelector(".result-empty").hidden`),
    "S085 removing the final reviewed row returns keyboard focus to the failures tab and shows the empty state").toBe(true);
  await pushResult("en", 8);
  await update({ id: "after-empty-history" });
  await pushResult("en", 8);
  expect.soft(await read<boolean>(page, `document.activeElement.id === "tab-failures"`), "S086 an empty-history entry request cannot make a later failure steal focus").toBe(true);
});

test("S087–S088 the history loading status in both languages, and an automatic retry that clears the warning without acknowledging", async ({}, testInfo) => {
  await host.evaluate(h => h.setSize(560, 680));
  // An entry opens the failures tab, where the former sequence already was.
  await pushResult("en", 1);
  for (const lang of ["en", "zh-TW"] as const) {
    await host.evaluate((h, value) => h.push({ ...h.settingsView({ type: "idle" }, { ...h.baseContext(), language: value, historyLoading: true, recordingResults: [] }), resultFocus: h.state.lastFocus }), lang);
    await page.waitForTimeout(120);
    expect.soft(await read<boolean>(page, `(() => { const el = document.querySelector(".result-history-status"); return !el.hidden && el.textContent === ${JSON.stringify(lang === "en" ? "Loading failure history…" : "正在載入失敗紀錄…")} && el.scrollWidth <= el.clientWidth && !document.querySelector(".recording-result"); })()`),
      `S087 history loading status ${lang} is readable without rows`).toBe(true);
    await shot(testInfo, `history-loading-${lang}.png`);
  }
  await pushResult("en", await lastFocus());
  await host.evaluate(h => { h.retryDelays[0] = 300; h.state.resultSaveFails = true; });
  await update({ id: "auto-retry" });
  await update({ id: "auto-retry", outcome: "empty" });
  await persist();
  await pushResult("en", await lastFocus() + 1);
  const warned = await read<boolean>(page, `!document.querySelector(".result-persistence").hidden && document.querySelector(".result-persistence").textContent.includes("keeps retrying")`);
  await set({ resultSaveFails: false });
  const cleared = await eventually(async () => !(await current())?.persistenceFailed && Boolean(await read(page, `document.querySelector(".result-persistence").hidden && document.querySelector(".recording-result")?.hasAttribute("data-open")`)));
  expect.soft(warned && cleared && !(await current())?.acknowledged, "S088 automatic retry clears the persistence warning without acknowledging (300 ms controlled backoff)").toBe(true);
});

for (const [delay, lang] of [[150, "en"], [2000, "zh-TW"]] as const) {
  test(`S089–S093 a ${delay} ms durable save (${lang}): busy Got it stays focusable, acknowledges only its result, focus moved meanwhile is not taken back, removal returns focus to the tab`, async ({}, testInfo) => {
    await host.evaluate(h => h.setSize(380, 360));
    await set({ saveDelayMs: delay });
    const row = (id: string): string => `#recording-result-${id}`;
    const acked = `delayed-${delay}`, moved = `moved-${delay}`;
    await update({ id: acked });
    await update({ id: acked, outcome: "empty" });
    await persist();
    await pushResult(lang, await lastFocus() + 1);
    await clickAt(page, `${row(acked)} [data-action="acknowledge"]`);
    await page.waitForTimeout(60);
    const waiting = await read<{ busy: boolean; focused: boolean; text: string; unread: boolean }>(page, `(() => { const b = document.querySelector('${row(acked)} [data-action="acknowledge"]'); return { busy: b?.getAttribute("aria-disabled") === "true" && !b.disabled, focused: document.activeElement === b, text: document.querySelector('${row(acked)} .result-saving').textContent, unread: document.querySelector('${row(acked)}')?.hasAttribute("data-open") }; })()`);
    expect.soft(waiting, `S089 ${delay} ms save keeps the busy Got it focusable, unread and labelled (${lang})`).toEqual({ busy: true, focused: true, unread: true, text: lang === "en" ? "Saving this change…" : "正在儲存這項變更…" });
    if (delay === 2000) for (const scheme of ["light", "dark"] as const) {
      await host.evaluate((h, value) => h.theme(value), scheme);
      await page.waitForTimeout(150);
      await shot(testInfo, `result-saving-${lang}-${scheme}.png`);
    }
    const collapsed = `!document.querySelector('${row(acked)}')?.hasAttribute("data-open") && document.activeElement === document.querySelector('${row(acked)} > .result-summary')`;
    expect.soft(await eventually(async () => (await all()).find(r => r.id === acked)?.acknowledged === true && Boolean(await read(page, collapsed)), delay + 3000),
      `S090 ${delay} ms delayed mouse Got it acknowledges only the offered result and collapses it`).toBe(true);
    await page.keyboard.press("Enter");
    expect.soft(await until(page, `document.querySelector('${row(acked)}')?.hasAttribute("data-open")`), `S091 ${delay} ms delayed acknowledged result can be reopened with keyboard`).toBe(true);
    await update({ id: moved });
    await update({ id: moved, outcome: "empty" });
    await persist();
    await pushResult(lang, await lastFocus() + 1);
    const tab = await read<string>(page, `document.querySelector('.tabs [role="tab"][aria-selected="true"]').id`);
    await clickAt(page, `${row(moved)} [data-action="acknowledge"]`);
    await page.waitForTimeout(40);
    await clickAt(page, `#${tab}`);
    await expect.poll(async () => (await all()).find(r => r.id === moved)?.acknowledged, { timeout: delay + 3000 }).toBe(true);
    await page.waitForTimeout(200);
    expect.soft(await read<boolean>(page, `document.activeElement.id === ${JSON.stringify(tab)} && !document.querySelector('${row(moved)}')?.hasAttribute("data-open")`),
      `S092 ${delay} ms focus moved during the wait is not stolen back`).toBe(true);
    for (const id of [moved, acked]) {
      if (!await read<boolean>(page, `document.querySelector('${row(id)}')?.hasAttribute("data-open")`)) {
        await page.locator(`${row(id)} > .result-summary`).focus();
        await page.keyboard.press("Enter");
        if (!await until(page, `document.querySelector('${row(id)}')?.hasAttribute("data-open")`)) throw new Error(`Could not open ${id}`);
      }
      await clickAt(page, `${row(id)} [data-action="remove"]`);
      if (!await until(page, `!document.querySelector('${row(id)}')`, delay + 3000)) throw new Error(`Could not remove ${id}`);
    }
    expect.soft(await until(page, `document.activeElement.id === ${JSON.stringify(tab)} && !document.querySelector(".recording-result")`),
      `S093 ${delay} ms delayed removal of the final reviewed row returns keyboard focus to the active tab`).toBe(true);
  });
}

/** Seven settled failures over four days, oldest first so the newest ends up first; the only unread one is the oldest. */
async function seedHistory(): Promise<void> {
  await host.evaluate(async h => {
    const day = (daysAgo: number, hour: number): string => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 5, 0, 0); return d.toISOString(); };
    const failure = { id: "", occurredAt: "", code: "disk_full", detail: "ENOSPC: controlled fixture", outcome: "pending" };
    for (const [id, daysAgo, hour, reviewed] of [["t-old-unread", 6, 12, false], ["t-old", 5, 12, true], ["t-y1", 1, 9, true], ["t-y2", 1, 18, true],
      ["t-d1", 0, 1, true], ["t-d2", 0, 2, true], ["t-d3", 0, 3, true]] as Array<[string, number, number, boolean]>) {
      // A new record arrives pending, as production publishes it, then settles.
      h.results.update({ ...failure, id, occurredAt: day(daysAgo, hour) });
      h.results.update({ ...failure, id, occurredAt: day(daysAgo, hour), outcome: "empty" });
      if (reviewed) await h.results.acknowledge(id);
    }
    await h.results.persist();
  });
}

test("S094–S102, S104, S106–S109 the failures tab: day groups, tab strip, keyboard navigation, independent rows, focus borders, rollover, per-tab scroll, entry and count", async ({}, testInfo) => {
  await host.evaluate(h => h.setSize(380, 360));
  await seedHistory();
  const selected = (): Promise<string> => read(page, `document.querySelector('.tabs [role="tab"][aria-selected="true"]').id`);
  for (const lang of ["en", "zh-TW"] as const) {
    await pushResult(lang, await lastFocus());
    await clickAt(page, "#tab-recording");
    await page.waitForTimeout(80);
    const recordingTab = await read<boolean>(page, `!document.getElementById("recording-results") && !document.querySelector(".recording-result")`);
    await clickAt(page, "#tab-general");
    await page.waitForTimeout(80);
    const generalTab = await read<boolean>(page, `!document.getElementById("recording-results") && !document.querySelector(".recording-result")`);
    expect.soft(recordingTab && generalTab, `S094 ${lang}: a normal open shows no history in the Recording and General tabs`).toBe(true);
    const strip = await read<{ fits: boolean; lines: number[]; labels: string[] }>(page, `(() => { const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
      const shown = tabs.map(t => t.querySelector(".tab-name")).filter(name => name && name.getBoundingClientRect().width > 0 && getComputedStyle(name).clipPath === "none");
      const lines = shown.map(t => { const range = document.createRange(); range.selectNodeContents(t); return new Set([...range.getClientRects()].map(r => Math.round(r.top))).size; });
      return { fits: tabs.every(t => t.scrollWidth <= t.clientWidth), lines, labels: tabs.map(t => t.textContent) }; })()`);
    expect.soft(strip.fits && strip.lines.length >= 1 && strip.lines.every(n => n === 1) && strip.labels[3] === (lang === "en" ? "Troubleshooting (1)" : "疑難排解（1）"),
      `S095 ${lang}: the four tabs fit the 380 pt window without wrapping or truncation, the open one by name ${JSON.stringify(strip)}`).toBe(true);
    for (const scheme of ["light", "dark"] as const) {
      await host.evaluate((h, value) => h.theme(value), scheme);
      await page.waitForTimeout(120);
      await clickAt(page, "#tab-recording");
      await page.waitForTimeout(60);
      await shot(testInfo, `tabs-${lang}-${scheme}-minimum.png`);
    }
    await host.evaluate(h => h.theme("light"));
  }
  // Arrow keys, Home and End cover all four tabs, wrapping from Failures to Recordings.
  await clickAt(page, "#tab-recording");
  await page.waitForTimeout(60);
  const tabKeys: string[] = [];
  for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "End", "Home", "ArrowLeft"]) { await page.keyboard.press(key); await page.waitForTimeout(60); tabKeys.push(await selected()); }
  expect.soft([...tabKeys, await read<string>(page, "document.activeElement.id")], "S096 keyboard navigation covers the four tabs")
    .toEqual(["tab-general", "tab-failures", "tab-library", "tab-failures", "tab-library", "tab-failures", "tab-failures"]);
  await pushResult("en", await lastFocus());
  const layout = await read<{ days: string[]; open: boolean[] }>(page, `({ days: [...document.querySelectorAll(".result-day-heading")].map(h => h.textContent),
    open: [...document.querySelectorAll(".recording-result")].map(r => r.hasAttribute("data-open")) })`);
  expect.soft(layout.days.length === 4 && layout.days[0] === "Today" && layout.days[1] === "Yesterday" && layout.days.slice(2).every(d => !/\d{4}/.test(d)) && layout.open.length === 7 && layout.open.every(open => !open),
    `S097 rows are grouped by day and all collapsed on a normal open ${JSON.stringify(layout)}`).toBe(true);
  const headerIndex = (): Promise<number> => read(page, `[...document.querySelectorAll(".recording-result > .result-summary")].indexOf(document.activeElement)`);
  await page.locator(".recording-result > .result-summary").first().focus();
  const moves: number[] = [];
  for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "End", "ArrowUp", "Home", "ArrowUp"]) { await page.keyboard.press(key); await page.waitForTimeout(40); moves.push(await headerIndex()); }
  expect.soft(moves, "S098 Up, Down, Home and End move between row headers across day groups").toEqual([1, 2, 3, 4, 6, 5, 0, 0]);
  const openRows = (): Promise<boolean[]> => read(page, `[...document.querySelectorAll(".recording-result")].map(r => r.hasAttribute("data-open"))`);
  await page.keyboard.press("Enter"); await page.waitForTimeout(60);
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await page.waitForTimeout(80);
  const opened = await openRows();
  await page.keyboard.press("Space"); await page.waitForTimeout(60);
  const closed = await openRows();
  expect.soft({ opened, closed }, "S099 Enter and Space open and close a row, and opening another leaves the first open").toEqual({
    opened: [true, true, false, false, false, false, false], closed: [true, false, false, false, false, false, false] });
  await page.keyboard.press("ArrowUp"); await page.keyboard.press("Space"); await page.waitForTimeout(60); await page.keyboard.press("ArrowDown"); await page.waitForTimeout(60);
  // Each focused control owns its standard ring; row separators and neutral borders remain independent.
  const colours = await read<{ accent: string; border: string }>(page, `(() => { const probe = document.createElement("div"); document.body.append(probe);
    probe.style.color = "var(--ring)"; const accent = getComputedStyle(probe).color; probe.style.color = "var(--border)"; const border = getComputedStyle(probe).color; probe.remove(); return { accent, border }; })()`);
  const rowFocus = (index: number) => read<{ colour: string; width: string; own: string; next: string; input: string | undefined; ring: string }>(page, `(() => { const rows = document.querySelectorAll(".recording-result"); const r = rows[${index}];
    const style = getComputedStyle(r); return { colour: style.borderTopColor, width: style.borderTopWidth, own: getComputedStyle(r, "::before").opacity, next: rows[${index + 1}] ? getComputedStyle(rows[${index + 1}], "::before").opacity : "none", input: document.documentElement.dataset.input, ring: getComputedStyle(r.querySelector(".result-summary")).boxShadow }; })()`);
  await page.locator(".recording-result > .result-summary").nth(1).focus();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp"); await page.waitForTimeout(60);
  const headerFocus = await rowFocus(1);
  const dpr = await read<number>(page, "devicePixelRatio");
  const expectedWidth = "1px";
  for (const scheme of ["light", "dark"] as const) {
    await host.evaluate((h, value) => h.theme(value), scheme);
    await page.waitForTimeout(150);
    await shot(testInfo, `result-focus-header-en-${scheme}.png`);
  }
  expect.soft(/0px 0px 0px 2px/.test(headerFocus.ring) && headerFocus.width === expectedWidth && headerFocus.own === "1" && headerFocus.next === "1",
    `S100 keyboard focus on a header draws the standard ring on its control and keeps the hairlines beside it (devicePixelRatio ${dpr}) ${JSON.stringify({ headerFocus, colours })}`).toBe(true);
  await host.evaluate(h => h.theme("light"));
  await page.waitForTimeout(100);
  await page.keyboard.press("Enter"); await page.waitForTimeout(80); await page.keyboard.press("Tab"); await page.waitForTimeout(240);
  const inside = await read<{ row: string; width: string; outline: string; style: string; tag: string }>(page, `(() => { const r = document.querySelectorAll(".recording-result")[1];
    const active = document.activeElement; const style = getComputedStyle(active); return { row: getComputedStyle(r).borderTopColor, width: getComputedStyle(r).borderTopWidth,
    outline: style.borderColor, style: style.boxShadow, tag: active.closest(".recording-result")?.id ?? "" }; })()`);
  await shot(testInfo, "result-focus-inside-en-light.png");
  expect.soft(inside.tag.endsWith("t-d2") && inside.row === "rgba(0, 0, 0, 0)" && inside.width === "1px" && inside.outline === colours.accent && /0px 0px 0px 2px/.test(inside.style),
    `S101 with focus on a control inside an open row, the row stays neutral and the focused control shows the standard ring ${JSON.stringify(inside)}`).toBe(true);
  await clickAt(page, ".recording-result:nth-child(1) > .result-summary");
  await page.waitForTimeout(80);
  const clicked = await rowFocus(0);
  expect.soft(clicked.colour === "rgba(0, 0, 0, 0)" && clicked.input === "pointer", `S102 a pointer click shows no focus border ${JSON.stringify(clicked)}`).toBe(true);
  // S103 (an inactive window) is a desktop case: pnpm acceptance:settings-native.
  // A day rollover moves rows between groups without dropping focus, and Technical details shows the focus line.
  const where = (): Promise<{ active: string; day: string }> => read(page, `({ active: document.activeElement.id || document.activeElement.dataset.action || document.activeElement.tagName,
    day: document.activeElement.closest(".result-day")?.dataset.day ?? "" })`);
  const rollover = async (days: number): Promise<void> => { await host.evaluate((h, value) => h.rollover(value), days); await page.waitForTimeout(150); };
  await read(page, `document.querySelectorAll(".recording-result[data-open]").forEach(row => { row.querySelector(".result-summary").click(); })`);
  await page.waitForTimeout(80);
  await page.locator(".recording-result > .result-summary").nth(1).focus();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp"); await page.waitForTimeout(60);
  const beforeRollover = await where();
  await rollover(1);
  const headerAfter = await where();
  await page.keyboard.press("Enter"); await page.waitForTimeout(80); await page.keyboard.press("Tab"); await page.waitForTimeout(240);
  const actionBefore = await where();
  await rollover(2);
  const actionAfter = await where();
  expect.soft(beforeRollover.day === "Today" && headerAfter.active === beforeRollover.active && headerAfter.day === "Yesterday"
    && actionAfter.active === actionBefore.active && actionAfter.day !== actionBefore.day && actionAfter.active !== "BODY",
  `S104 a day rollover that moves rows to another day group keeps the focused header and the focused action ${JSON.stringify({ beforeRollover, headerAfter, actionBefore, actionAfter })}`).toBe(true);
  // S105 (a rollover while another window is in front) is a desktop case: pnpm acceptance:settings-native.
  await rollover(0);
  let technical = await read<boolean>(page, `document.activeElement.matches(".result-technical > .technical-summary")`);
  for (let i = 0; i < 4 && !technical; i += 1) { await page.keyboard.press("Tab"); await page.waitForTimeout(60); technical = await read<boolean>(page, `document.activeElement.matches(".result-technical > .technical-summary")`); }
  const disclosure = await read<{ style: string; colour: string; width: string }>(page, `(() => { const s = getComputedStyle(document.activeElement); return { style: s.boxShadow, colour: s.borderColor, width: s.borderWidth }; })()`);
  expect.soft(technical && /0px 0px 0px 2px/.test(disclosure.style),
    `S106 keyboard focus on Technical details shows the standard focus ring ${JSON.stringify({ technical, ...disclosure })}`).toBe(true);
  // Each tab keeps its own scroll position through wheel scrolling; an entry scrolls to its row.
  const scrollTop = (): Promise<number> => read(page, `document.getElementById("settings-panel").scrollTop`);
  const wheel = async (): Promise<void> => {
    const at = await centre(page, "#settings-panel", false);
    await page.mouse.move(at.x, at.y);
    // Downwards: Electron's `sendInputEvent` wheel, which the former fixture sent, counts down as negative; DOM wheel deltas count it positive.
    for (let i = 0; i < 4; i += 1) await page.mouse.wheel(0, 60);
    await page.waitForTimeout(250);
  };
  // A reloaded page is a new window: every tab starts at the top.
  await page.reload();
  await expect(page.locator("#tab-general")).toBeVisible();
  await pushResult("en", await lastFocus());
  await clickAt(page, "#tab-recording"); await page.waitForTimeout(80);
  const recordingFirst = await scrollTop();
  await wheel();
  const recordingAt = await scrollTop();
  await clickAt(page, "#tab-general"); await page.waitForTimeout(80);
  const generalFirst = await scrollTop();
  await wheel();
  const generalAt = await scrollTop();
  await clickAt(page, "#tab-recording"); await page.waitForTimeout(80);
  const recordingBack = await scrollTop();
  await clickAt(page, "#tab-general"); await page.waitForTimeout(80);
  const generalBack = await scrollTop();
  const scroll = { recordingFirst, recordingAt, generalFirst, generalAt, recordingBack, generalBack };
  expect.soft(recordingFirst === 0 && generalFirst === 0 && recordingAt > 0 && generalAt > 0 && recordingBack === recordingAt && generalBack === generalAt,
    `S107 each tab keeps its own scroll position when switching away and back, and a new window starts each tab at the top ${JSON.stringify(scroll)}`).toBe(true);
  await pushResult("en", await lastFocus() + 1);
  const entry = await read<{ tab: string; open: string[]; active: string; visible: boolean }>(page, `(() => { const rows = [...document.querySelectorAll(".recording-result")];
    const target = document.getElementById("recording-result-t-old-unread"); const box = target.getBoundingClientRect(), panel = document.getElementById("settings-panel").getBoundingClientRect();
    return { tab: document.querySelector('.tabs [role="tab"][aria-selected="true"]').id, open: rows.filter(r => r.hasAttribute("data-open")).map(r => r.dataset.resultId), active: document.activeElement.id,
      visible: box.top >= panel.top - 1 && box.top < panel.bottom }; })()`);
  expect.soft({ ...entry, acknowledged: (await all()).find(r => r.id === "t-old-unread")?.acknowledged },
    "S108 an entry selects the failures tab, opens only the newest unread row, focuses its header and scrolls it into view, without acknowledging it")
    .toEqual({ tab: "tab-failures", open: ["t-old-unread"], active: "recording-result-t-old-unread-summary", visible: true, acknowledged: false });
  // An explicit failure entry returns from tools to history before focusing its row.
  await page.locator("#troubleshooting-tools-tab").click();
  await expect(page.locator("#recording-results")).toBeHidden();
  await pushResult("en", await lastFocus() + 1);
  await expect(page.locator("#troubleshooting-history-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#recording-result-t-old-unread-summary")).toBeFocused();
  const before = await read<string>(page, `document.getElementById("tab-failures").textContent`);
  await clickAction(`!document.getElementById("recording-result-t-old-unread").classList.contains("unread")`);
  const after = await read<string>(page, `document.getElementById("tab-failures").textContent`);
  expect.soft({ before, after }, "S109 the tab count appears for unread failures and clears once they are acknowledged").toEqual({ before: "Troubleshooting (1)", after: "Troubleshooting" });
});

for (const lang of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`S110–S115 ${lang}/${scheme}: tab, menu, segment, switch, button and row action show the design system keyboard focus rings at the minimum size`, async ({}, testInfo) => {
    await host.evaluate((h, value) => { h.setSize(380, 360); h.theme(value); }, scheme);
    await seedHistory();
    await pushResult(lang, 0);
    const keyboardFocus = async (selector: string): Promise<boolean> => {
      await read(page, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" }); document.querySelector(${JSON.stringify(selector)}).focus()`);
      await page.keyboard.press("Tab"); await page.waitForTimeout(40);
      await page.keyboard.press("Shift+Tab");
      // The shadcn focus shadow transitions; judge its settled width, not an intermediate frame (a slow runner needs longer).
      await until(page, `document.activeElement.getAnimations().every(animation => animation.playState !== "running")`, 2000);
      await page.waitForTimeout(40);
      return read<boolean>(page, `document.activeElement === document.querySelector(${JSON.stringify(selector)})`);
    };
    // Primitive-specific shadcn rings replace the former thin-outline-only contract.
    const ring = (): Promise<{ keyboard: boolean; line: boolean; halo: string }> => read(page, `(() => { const el = document.activeElement, s = getComputedStyle(el);
      const probe = document.createElement("p"); probe.style.color = "var(--ring)"; document.body.append(probe); const red = getComputedStyle(probe).color; probe.remove();
      return { keyboard: el.matches(":focus-visible"), line: /0px 0px 0px [23]px/.test(s.boxShadow),
        halo: s.boxShadow.match(/0px 0px 0px [23]px/)?.[0] ?? "" }; })()`);
    await clickAt(page, "#tab-recording"); await page.waitForTimeout(80);
    for (const [id, name, selector] of [["S110", "tab", "#tab-recording"], ["S111", "menu", "#setting-screen"], ["S112", "segment", "#setting-countdown button[aria-pressed=true]"],
      ["S113", "switch", "#setting-countdownSound"]] as const) {
      const reached = await keyboardFocus(selector), shown = await ring();
      await shot(testInfo, `focus-${name}-${lang}-${scheme}-minimum.png`);
      expect.soft(reached && shown.keyboard && shown.line && Boolean(shown.halo), `${id} ${lang}/${scheme}: the ${name} shows the design system focus ring ${JSON.stringify({ reached, ...shown })}`).toBe(true);
    }
    await clickAt(page, "#tab-general"); await page.waitForTimeout(80);
    for (const [id, name, selector] of [["S114", "button", "#setting-updates-check"], ["S115", "link", "#setting-notifications-openSettings"]] as const) {
      const reached = await keyboardFocus(selector), shown = await ring();
      await shot(testInfo, `focus-${name}-${lang}-${scheme}-minimum.png`);
      expect.soft(reached && shown.keyboard && shown.line && Boolean(shown.halo), `${id} ${lang}/${scheme}: a ${name === "link" ? "row action" : name} shows the design system focus ring ${JSON.stringify({ reached, ...shown })}`).toBe(true);
    }
    await clickAt(page, "#tab-failures"); await page.waitForTimeout(80);
    await shot(testInfo, `failures-${lang}-${scheme}-minimum.png`);
  });
}
