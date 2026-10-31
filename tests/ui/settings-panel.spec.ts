/**
 * The former `pnpm acceptance:settings` cases that are not the snapshot matrix, the failures tab or the focus rings
 * (plan 066 ledger, docs/verification/playwright-migration-066.md): the shipped page under the shipped CSP, the
 * preload boundary, real IPC round trips with held replies, the notification card, countdown sound, status card,
 * ⓘ explanations, update checks, the scroll cue, the footer and the shortcut editor's keyboard paths. View host
 * (hosts/view-host.ts, `panel`); input is Playwright's. Test titles carry the ledger's IDs.
 */
import { test, expect, type Launched } from "./fixtures";
import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { read, until, eventually, centre, clickAt, pickMenu, drawn } from "./helpers";

let host: Launched, page: Page;
test.beforeEach(async ({ launchView }) => {
  ({ launched: host, page } = await launchView());
  await expect(page.locator("#setting-hotkey")).toBeVisible();
});
/** A picture kept in the test's output folder for inspection, as the former fixture kept its screenshots. */
const keep = async (name: string): Promise<void> => { fs.writeFileSync(test.info().outputPath(name), await page.screenshot({ animations: "disabled", caret: "hide" })); };
/**
 * Whether the element shows a keyboard focus indicator at all: `:focus-visible` with some outline or shadow. Its style,
 * width and colour are the design's to change; only its presence is checked.
 */
const focusShown = (selector: string): Promise<boolean> => read(page, `(el => Boolean(el?.matches(":focus-visible")) && (s => (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none")(getComputedStyle(el)))(document.querySelector(${JSON.stringify(selector)}))`);
const calls = (): Promise<Array<[string, unknown]>> => host.evaluate(h => [...h.chooseCalls]);
const clearCalls = (): Promise<void> => host.evaluate(h => { h.chooseCalls.length = 0; });
const commitEnglish = async (): Promise<void> => {
  await page.locator("#setting-language-en").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await clearCalls();
};

test("S002–S009 the shipped page and preload: CSP, bridge, sandbox, localized first render, committed values, unavailable option, refused-shortcut note", { tag: "@settings-bridge" }, async () => {
  const rendered = await read<{ title: string; docTitle: string; lang: string; bridge: string[]; exposed: string[]; note: string | null;
    controls: Array<{ id: string; value: string; disabled: boolean; label: string; describedBy: string | null }> }>(page, `(() => ({
    title: document.querySelector("#title").textContent, docTitle: document.title, lang: document.documentElement.lang,
    bridge: Object.keys(window.settings ?? {}).sort(), exposed: [typeof window.require, typeof window.process, typeof window.module],
    controls: [...document.querySelectorAll("[role=combobox]")].map(s => ({ id: s.id, value: s.dataset.value, disabled: s.disabled,
      label: document.querySelector("label[for='" + s.id + "']").textContent, describedBy: s.getAttribute("aria-describedby") })),
    note: document.querySelector("#setting-hotkey-note")?.textContent ?? null,
  }))()`);
  expect.soft(rendered.controls.length, "S002 the shipped page loads under the shipped CSP (page errors fail at teardown)").toBe(2);
  expect.soft(rendered.bridge, "S004 the preload exposes only the settings, zoom, camera preview, level, Studio and input level APIs").toEqual(["capture", "choose", "onChanged", "onHidden", "onMicrophoneLevel", "onZoomChanged", "read", "ready", "watchCameraPreview", "watchLevels", "watchMicrophoneLevel", "watchStudio", "zoom", "zoomFactor"]);
  expect.soft(rendered.exposed, "S005 no Node API reaches the sandboxed page").toEqual(["undefined", "undefined", "undefined"]);
  expect.soft([rendered.title, rendered.docTitle, rendered.lang, rendered.controls.find(control => control.id === "setting-hotkey")?.label],
    "S006 the URL language localizes the first render").toEqual(["RecordStuff", "RecordStuff", "zh-Hant", "快捷鍵"]);
  expect.soft(rendered.controls.map(control => [control.id, control.value, control.disabled]), "S007 each group renders one live control showing the committed value")
    .toEqual([["setting-frameRate", "30", false], ["setting-hotkey", "CommandOrControl+Alt+Shift+R", false]]);
  await page.locator("#tab-recording").click();
  await page.locator("#setting-frameRate").click();
  await expect(page.getByRole("listbox")).toBeVisible();
  const options = await read<Array<{ text: string; disabled: boolean }>>(page, `[...document.querySelectorAll("[role=option]")].map(o => ({ text: o.textContent, disabled: o.hasAttribute("data-disabled") || o.getAttribute("aria-disabled") === "true" }))`);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  expect.soft(options[1]?.disabled, `S008 an option unavailable on this platform is listed but not selectable ${JSON.stringify(options)}`).toBe(true);
  expect.soft([rendered.note, rendered.controls[1]?.describedBy?.includes("setting-hotkey-note")], "S009 a refused shortcut shows its note and the control points at it")
    .toEqual(["這個快捷鍵可能被其他 App 佔用。", true]);
});

test("S010–S013 a change reaches main as ids, re-renders in the committed language, and a choice main refused says so", { tag: "@settings-bridge" }, async () => {
  await page.locator("#setting-language-en").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect.soft(await calls(), "S010 a change reaches main as the group and choice ids, not an action").toEqual([["language", "en"]]);
  const applied = await read<{ title: string; hotkeyLabel: string; feedback: string }>(page, `({ title: document.querySelector("#title").textContent,
    hotkeyLabel: document.querySelector("label[for='setting-hotkey']").textContent, feedback: document.querySelector("#feedback").textContent })`);
  expect.soft([applied.title, applied.hotkeyLabel], "S011 the committed answer re-renders the whole panel in the new language").toEqual(["RecordStuff", "Shortcut"]);
  expect.soft(applied.feedback, "S012 a committed change shows no failure text").toBe("");
  // A choice main refuses to commit (this host never commits a frame rate).
  await page.locator("#tab-recording").click();
  await pickMenu(page, "setting-frameRate", "24");
  await expect(page.locator("#setting-frameRate-row").getByText("Could not apply this setting. Your current settings are shown.")).toBeVisible();
  expect(await page.locator("#setting-frameRate").getAttribute("data-value"), "S013 a choice that did not commit reports it and shows the committed value").toBe("30");
});

test("S014–S015 two held saves and an older push: the newest choice shows over them, other settings stay usable, and the final completion settles", { tag: "@settings-bridge" }, async () => {
  await commitEnglish();
  await host.evaluate(h => { h.state.holdSaves = true; });
  await page.locator("#setting-language-zh-TW").click();
  await page.locator("#setting-language-en").click();
  await expect.poll(() => host.evaluate(h => h.pendingSaves())).toBe(2);
  await host.evaluate(h => { h.releaseSave(); h.push(h.fixtureView(h.state.language)); });
  const state = `({ value: document.querySelector("#setting-language button[aria-pressed=true]").id.replace("setting-language-", ""),
    locked: document.querySelector("#setting-hotkey").disabled, feedback: document.querySelector("#feedback").textContent,
    lang: document.documentElement.lang, hotkeyLabel: document.querySelector("label[for='setting-hotkey']").textContent })`;
  await expect.poll(() => read<{ lang: string }>(page, state).then(value => value.lang)).toBe("zh-Hant");
  const pending = await read<{ value: string; locked: boolean; feedback: string }>(page, state);
  // The choice being saved shows over an older completion and push, and another setting stays usable (2026-10-22).
  expect.soft([pending.value, pending.locked, pending.feedback], "S014 an older completion and push leave the newest choice shown, the other controls usable").toEqual(["en", false, ""]);
  await host.evaluate(h => h.releaseSave());
  // The page is never locked by a save, so the final completion is waited for by what it renders.
  await expect.poll(() => read<{ value: string; locked: boolean; lang: string; hotkeyLabel: string }>(page, state)
    .then(finished => [finished.value, finished.locked, finished.lang, finished.hotkeyLabel]), { message: "S015 the final completion displays committed settings" })
    .toEqual(["en", false, "en", "Shortcut"]);
  await host.evaluate(h => { h.state.holdSaves = false; });
});

test("S014a a choice for another setting while one saves is its own: shown and sent at once, answered on its own (2026-10-22)", { tag: "@settings-bridge" }, async () => {
  await commitEnglish();
  // The fixture's language is on one tab and its notifications on another: a save in flight on one, a choice on the other.
  const notifications = page.locator("#setting-notifications");
  await host.evaluate(h => { h.state.holdSaves = true; });
  await page.locator("#setting-language-zh-TW").click();
  await expect.poll(() => host.evaluate(h => h.pendingSaves())).toBe(1);
  await page.locator("#tab-general").click();
  await expect(notifications).toHaveAttribute("aria-checked", "true");
  await expect(notifications, "S014a the other setting stays usable while one saves").toBeEnabled();
  await notifications.click();
  await expect(notifications, "S014a and shows the choice made at once").toHaveAttribute("aria-checked", "false");
  await expect.poll(calls, { message: "S014a it is sent at once, not behind the save in flight" }).toEqual([["language", "zh-TW"], ["notifications", "off"]]);
  await expect.poll(() => host.evaluate(h => h.pendingSaves())).toBe(2);
  await host.evaluate(h => { h.state.holdSaves = false; h.releaseSave(); h.releaseSave(); });
  await expect(notifications, "S014a main's answer keeps it").toHaveAttribute("aria-checked", "false");
  // Back as it was, in English, for the cases after.
  await clearCalls();
  await notifications.click();
  await expect(notifications).toHaveAttribute("aria-checked", "true");
  await page.locator("#tab-recording").click();
  await commitEnglish();
});

test("S016–S021 the notification setting: switch and pane button, ids to main, held saves keep the control, restrictions disable", { tag: "@general" }, async () => {
  await commitEnglish();
  await page.locator("#tab-general").click();
  const switches = await read<string[]>(page, `[...document.querySelectorAll("[role=switch]")].filter(s => s.checkVisibility()).map(s => s.id)`);
  expect.soft(switches.join(), "S016 the general tab renders the notification switch").toBe("setting-notifications");
  await expect.soft(page.locator("#setting-notifications-openSettings"), "S016 …and its pane button").toBeVisible();
  await expect.soft(page.locator("#setting-notifications-openSettings"), "S016 …usable").toBeEnabled();

  await page.locator("#setting-notifications-openSettings").click();
  await expect.poll(calls).toEqual([["notifications", "openSettings"]]);
  expect.soft(await page.locator("#feedback").textContent(), "S017 the pane button reaches main as ids and its own outcome counts as applied").toBe("");

  await clearCalls();
  await page.locator("#setting-notifications").click();
  await expect(page.locator("#setting-notifications")).toHaveAttribute("aria-checked", "false");
  expect.soft(await page.locator("#feedback").textContent(), "S018 turning the switch off commits").toBe("");
  await expect.soft(page.locator("#setting-notifications-openSettings"), "S018 …and leaves the pane button usable").toBeEnabled();

  // A save held across frames and a main push: a recreated control can look right after settling while it flashed or lost focus.
  for (const value of ["on", "off"] as const) {
    await host.evaluate(h => { h.state.holdSaves = true; });
    await page.locator("#setting-notifications").focus();
    await read(page, `(() => { window.beforeToggle = { select: document.querySelector("#setting-notifications"), panel: document.querySelector("#settings-panel"),
      button: document.querySelector("#setting-notifications-openSettings"), scroll: window.scrollY, below: document.querySelector("#setting-updates-row")?.getBoundingClientRect().top }; })()`);
    await page.keyboard.press("Space");
    await expect.poll(() => host.evaluate(h => h.pendingSaves())).toBe(1);
    await drawn(page, () => host.evaluate(h => h.push(h.fixtureView(h.state.language))));
    const during = await read<Record<string, unknown>>(page, `({ sameSelect: beforeToggle.select === document.querySelector("#setting-notifications"),
      samePanel: beforeToggle.panel === document.querySelector("#settings-panel"), focused: document.activeElement === beforeToggle.select,
      scrollStable: window.scrollY === beforeToggle.scroll && document.querySelector("#setting-updates-row")?.getBoundingClientRect().top === beforeToggle.below,
      value: beforeToggle.select.getAttribute("aria-checked") === "true" ? "on" : "off",
      buttonLocked: beforeToggle.button.getAttribute("aria-disabled") === "true" && !beforeToggle.button.disabled })`);
    // The choice being saved shows over main's push of the value it replaces (2026-10-22); its own pane button waits for it.
    expect.soft(during, `S019 notification ${value}: pending save and push preserve controls, focus and scroll`).toEqual({ sameSelect: true, samePanel: true, focused: true,
      scrollStable: true, value, buttonLocked: true });
    await host.evaluate(h => h.releaseSave());
    await until(page, `beforeToggle.select.getAttribute("aria-checked") === ${JSON.stringify(value === "on" ? "true" : "false")}`);
    const after = await read<Record<string, unknown>>(page, `({ sameSelect: beforeToggle.select === document.querySelector("#setting-notifications"),
      focused: document.activeElement === beforeToggle.select,
      scrollStable: window.scrollY === beforeToggle.scroll && document.querySelector("#setting-updates-row")?.getBoundingClientRect().top === beforeToggle.below,
      value: beforeToggle.select.getAttribute("aria-checked") === "true" ? "on" : "off",
      buttonLocked: beforeToggle.button.disabled || beforeToggle.button.getAttribute("aria-disabled") === "true" })`);
    expect.soft(after, `S020 notification ${value}: completion preserves the control and unlocks the pane action`).toEqual({ sameSelect: true, focused: true, scrollStable: true, value, buttonLocked: false });
  }
  await host.evaluate(h => { h.state.holdSaves = false; const locked = h.fixtureView(h.state.language); locked.groups.forEach((group: { enabled: boolean }) => { group.enabled = false; }); h.push(locked); });
  await expect(page.locator("#setting-notifications"), "S021 recording restrictions disable the controls").toBeDisabled();
});

test("S022 the Recordings folder is read by the app's library: names, dates, sizes and lengths from the files", { tag: "@library" }, async () => {
  const files = await host.evaluate(h => h.library().state.files.map((file: { name: string; recordedAt: number; size: number; duration?: number }) => [file.name, file.recordedAt, file.size, file.duration ?? null]));
  // A name without a time stamp dates from the file's creation time; only macOS lets `utimes` move it back, so
  // elsewhere the file system's own creation time is the date the library must read.
  const named = "A long product walkthrough recorded for the onboarding review.mp4";
  const stat = fs.statSync(path.join(host.data, "recordings", named));
  const created = process.platform === "darwin" ? new Date(2026, 9, 4, 9, 30).getTime() : stat.birthtimeMs || stat.mtimeMs;
  const expected: Array<[string, number, number, number | null]> = [
    ["2026-10-04 14-02-11.mp4", new Date(2026, 9, 4, 14, 2, 11).getTime(), 182e6, 83],
    [named, created, 1.24e9, 3725],
    ["2026-10-03 21-15-00.mp4", new Date(2026, 9, 3, 21, 15).getTime(), 54e6, null],
  ];
  expect(files).toEqual(expected.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
});

test("S022a a search that matches nothing keeps to the Recordings tab: another tab lays out as it does with no search (2026-10-31)", { tag: "@library" }, async () => {
  // The fixture's third recording has no picture: the scheme answers its thumbnail 404 (S028).
  host.expectedErrors.push(/Failed to load resource: the server responded with a status of 404 .*\(recordstuff-media:\/\/thumb\//);
  await host.evaluate(async h => { h.theme("light"); await h.setSize(...h.SNAPSHOT_SIZES.default); });
  await drawn(page, () => host.evaluate(h => h.push(h.settingsView({ type: "idle" }, { ...h.baseContext(), library: h.library().state, now: h.snapshotNow() }))));
  // The General tab's page as laid out: its card's flow and every section's place, read the same way twice.
  const general = async (): Promise<string> => {
    await page.locator("#tab-general").click();
    await expect(page.locator("#tab-general")).toHaveAttribute("aria-selected", "true");
    return read<string>(page, `(() => { const card = document.querySelector(".settings-card");
      return JSON.stringify([getComputedStyle(card).display, card.scrollHeight, [...card.querySelectorAll("section, .section")].filter(el => el.checkVisibility()).map(el => Math.round(el.getBoundingClientRect().top))]); })()`);
  };
  const before = await general();
  await page.locator("#tab-library").click();
  await page.locator("#library-search").fill("nothing is called this");
  await expect(page.locator("#library-no-match")).toBeVisible();
  expect.soft(await general(), "S022a the General tab lays out as before while Recordings keeps a search with no match").toBe(before);
  // Back on Recordings, the search and its empty state are still there.
  await page.locator("#tab-library").click();
  await expect(page.locator("#library-no-match")).toBeVisible();
});

test("S037–S038 countdown sound: a click on the checked switch asks main for off; under countdown Off it is disabled, keeps its value and sends nothing", { tag: "@recording-settings" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(560, 680); });
  await page.locator("#tab-recording").click();
  const soundSwitch = async (countdown: 0 | 3) => {
    await drawn(page, () => host.evaluate((h, value) => { h.state.soundContext = { ...h.baseContext(), countdown: value }; h.push(h.settingsView({ type: "idle" }, h.state.soundContext)); }, countdown));
    await clearCalls();
    const before = await read<{ checked: boolean; disabled: boolean }>(page, `(() => { const el = document.getElementById("setting-countdownSound"); el.scrollIntoView({ block: "center" });
      return { checked: el.getAttribute("aria-checked") === "true", disabled: el.disabled }; })()`);
    await clickAt(page, "#setting-countdownSound");
    // An enabled switch is read once main has the click and the switch shows its answer; a disabled one must send
    // nothing, so it is given time to.
    if (before.disabled) await page.waitForTimeout(150);
    else await eventually(async () => (await calls()).length > 0 && await read<string | null>(page, `document.getElementById("setting-countdownSound").getAttribute("aria-checked")`) !== String(before.checked));
    return { ...before, calls: await calls(), after: await read<boolean>(page, `document.getElementById("setting-countdownSound").getAttribute("aria-checked") === "true"`) };
  };
  const enabled = await soundSwitch(3);
  expect.soft(enabled, "S037 countdown sound: a click on the checked switch asks main for off and shows the committed off").toEqual({ checked: true, disabled: false, calls: [["countdownSound", "off"]], after: false });
  const disabled = await soundSwitch(0);
  expect.soft(disabled, "S038 countdown sound: disabled while the countdown is Off, keeping its value, and a click sends nothing").toEqual({ checked: true, disabled: true, calls: [], after: true });
});

test("S117–S120 microphone: the switch asks main, the input device follows it, a session locks both, and a denial offers its pane (plan 074)", { tag: "@recording-settings" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(560, 680); });
  await page.locator("#tab-recording").click();
  const devices = [{ id: "built-in", name: "MacBook Pro Microphone", default: true }, { id: "usb-mic", name: "USB Microphone", default: false }];
  await host.evaluate((h, list) => {
    h.state.microphoneContext = { ...h.baseContext(), microphone: { enabled: false, devices: list, access: "granted" } };
    h.push(h.settingsView({ type: "idle" }, h.state.microphoneContext));
  }, devices);
  const toggle = page.locator("#setting-microphone");
  const device = page.locator("#setting-microphoneDevice");
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle, "S117 off by default").toHaveAttribute("aria-checked", "false");
  await expect(device, "S117 the input device waits for the switch").toBeDisabled();
  await clearCalls();
  await clickAt(page, "#setting-microphone");
  await expect(toggle, "S117 a click asks main for on and shows the committed value").toHaveAttribute("aria-checked", "true");
  expect(await calls()).toEqual([["microphone", "on"]]);
  await expect(device).toBeEnabled();
  await expect(device, "S118 the system default is named after the device it is now").toContainText("System default (MacBook Pro Microphone)");
  await clearCalls();
  await pickMenu(page, "setting-microphoneDevice", "usb-mic");
  expect(await calls(), "S118 choosing an input asks main for it").toEqual([["microphoneDevice", "usb-mic"]]);
  await expect(device).toContainText("USB Microphone");

  await host.evaluate((h, list) => h.pushModel({ type: "recording", startedAt: "2026-10-16T00:00:00Z" },
    { microphone: { enabled: true, devices: list, access: "granted" } }), devices);
  await expect(toggle, "S119 a session locks the switch").toBeDisabled();
  await expect(device, "S119 and the input device").toBeDisabled();

  await host.evaluate((h, list) => {
    h.state.microphoneContext = { ...h.baseContext(), microphone: { enabled: true, devices: list, access: "denied" } };
    h.push(h.settingsView({ type: "idle" }, h.state.microphoneContext));
  }, devices);
  const diagnostics = page.locator("#setting-microphone-diagnostics");
  await expect(diagnostics, "S120 a denial says why recording will not start").toContainText("Microphone access is off");
  await clearCalls();
  await page.getByRole("button", { name: "Open microphone settings…" }).click();
  await expect.poll(calls, { message: "S120 the pane is main's to open" }).toEqual([["microphone", "openSettings"]]);

  await host.evaluate((h, list) => h.pushModel({ type: "idle" }, { language: "zh-TW", microphone: { enabled: true, devices: list, access: "denied" } }), devices);
  await expect(page.locator("#setting-microphone-diagnostics"), "S120 zh-TW").toContainText("未允許取用麥克風");
  await expect(page.getByRole("button", { name: "開啟麥克風設定…" })).toBeVisible();
});

test("S139–S141 Test microphone, Search for devices and the input device while recording (plan 079)", { tag: "@recording-settings" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(560, 680); h.microphoneLevelWatches.length = 0; });
  await page.locator("#tab-recording").click();
  const devices = [{ id: "built-in", name: "MacBook Pro Microphone", default: true }, { id: "usb-mic", name: "USB Microphone", default: false }];
  const show = (recording: boolean, more: Record<string, unknown> = {}): Promise<void> => host.evaluate((h, [list, recording, more]) => {
    h.state.microphoneState = recording ? { type: "recording", startedAt: "2026-10-19T00:00:00Z" } : undefined;
    h.state.microphoneContext = { ...h.baseContext(), microphone: { enabled: true, devices: list, access: "granted" },
      ...(recording ? { audioSession: { systemMuted: false, microphone: { muted: false } } } : {}), ...more };
    h.push(h.settingsView(h.state.microphoneState ?? { type: "idle" }, h.state.microphoneContext));
  }, [devices, recording, more] as const);
  await show(false);
  const test = page.locator("#setting-microphoneLevel");
  const meter = page.getByRole("meter", { name: "Input level" });
  await test.scrollIntoViewIfNeeded();
  await expect(test, "S139 Test microphone under the input device while the microphone is on").toBeVisible();
  await page.waitForTimeout(300);
  expect(await host.evaluate(h => [...h.microphoneLevelWatches]), "S139 visiting the tab opens no microphone").toEqual([]);
  await test.click();
  await expect(meter, "S139 the input's level shown at the press").toBeVisible();
  await expect.poll(() => host.evaluate(h => [...h.microphoneLevelWatches]), { message: "S139 the test asks for the input's level" }).toEqual([true]);
  await host.evaluate(h => h.pushMicrophoneLevel({ peak: 0.1, rms: 0.05 }));
  await expect(meter, "S139 its level in dB below full scale").toHaveAttribute("aria-valuetext", "-20 dB");
  await expect(page.locator(".input-meter-value"), "S139 and in words a user reads").toHaveText("Good level");
  await keep("input-level.png");
  await expect.poll(async () => Number(await meter.getAttribute("aria-valuenow")),
    { message: "S139 it falls back when the input is silent", timeout: 3000 }).toBeLessThan(-30);
  await expect(test, "S139 pressed again stops it").toHaveText("Stop test");
  await test.click();
  await expect(meter).toHaveCount(0);
  await expect.poll(() => host.evaluate(h => [...h.microphoneLevelWatches]), { message: "S139 and lets the input's level go" }).toEqual([true, false]);
  await test.click();
  await expect(meter).toBeVisible();

  await clearCalls();
  await page.getByRole("button", { name: "Search for devices" }).click();
  await expect.poll(calls, { message: "S140 Search for devices asks main" }).toEqual([["microphoneDevice", "search"]]);
  await show(false, { microphone: { enabled: true, devices, access: "granted", searching: true } });
  await expect(page.getByRole("button", { name: "Searching…" }), "S140 busy while it searches").toBeDisabled();

  await show(true);
  await expect.poll(() => host.evaluate(h => [...h.microphoneLevelWatches]), { message: "S139 a recording ends the test" }).toEqual([true, false, true, false]);
  await expect(meter, "S139 and its meter goes").toHaveCount(0);
  await expect(test).toBeDisabled();
  const device = page.locator("#setting-microphoneDevice");
  await expect(device, "S141 the input device stays open while the recording records the microphone").toBeEnabled();
  await expect(page.locator("#setting-microphoneDevice-note")).toHaveText("Switches this recording's microphone at once.");
  await expect(page.getByRole("button", { name: "Search for devices" }), "S140 no search while recording").toBeDisabled();
  await clearCalls();
  await pickMenu(page, "setting-microphoneDevice", "usb-mic");
  expect(await calls(), "S141 choosing an input while recording asks main to switch").toEqual([["microphoneDevice", "usb-mic"]]);
  await expect(device).toContainText("USB Microphone");
  await keep("input-device-while-recording.png");
  await host.evaluate(h => { h.state.microphoneState = undefined; });

  await show(false, { language: "zh-TW" });
  await expect(page.getByRole("button", { name: "測試麥克風", exact: true }), "S139 zh-TW").toBeEnabled();
  await expect(page.getByRole("button", { name: "搜尋裝置" })).toBeEnabled();
});

test("S121–S123 camera: the switch asks main, a session locks it, and a denial offers its pane (plan 075)", { tag: "@recording-settings" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(560, 680); });
  await page.locator("#tab-recording").click();
  await host.evaluate(h => {
    h.state.cameraContext = { ...h.baseContext(), camera: { enabled: false, available: true, access: "granted" } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  const toggle = page.locator("#setting-camera");
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle, "S121 off by default").toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("heading", { name: "Camera" }), "S121 in a section of its own").toBeVisible();
  await expect(page.getByRole("heading", { name: "Camera" }).locator(".section-icon"), "S121 named by its icon, as the other sections are").toBeVisible();
  await clearCalls();
  await clickAt(page, "#setting-camera");
  await expect(toggle, "S121 a click asks main for on and shows the committed value").toHaveAttribute("aria-checked", "true");
  expect(await calls()).toEqual([["camera", "on"]]);

  await host.evaluate(h => h.pushModel({ type: "recording", startedAt: "2026-10-17T00:00:00Z" },
    { camera: { enabled: true, available: true, access: "granted" } }));
  await expect(toggle, "S122 a session locks the switch").toBeDisabled();

  await host.evaluate(h => {
    h.state.cameraContext = { ...h.baseContext(), camera: { enabled: true, available: true, access: "denied" } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await expect(page.locator("#setting-camera-diagnostics"), "S123 a denial says why recording will not start").toContainText("Camera access is off");
  await clearCalls();
  await page.getByRole("button", { name: "Open camera settings…" }).click();
  await expect.poll(calls, { message: "S123 the pane is main's to open" }).toEqual([["camera", "openSettings"]]);
  await clearCalls();
  await page.getByRole("button", { name: "Already allowed? Relaunch RecordStuff" }).click();
  await expect.poll(calls, { message: "S123 access allowed meanwhile shows after a relaunch, main's to do" }).toEqual([["camera", "relaunch"]]);

  await host.evaluate(h => h.pushModel({ type: "idle" }, { language: "zh-TW", camera: { enabled: true, available: true, access: "denied" } }));
  await expect(page.locator("#setting-camera-diagnostics"), "S123 zh-TW").toContainText("未允許取用相機");
  await expect(page.getByRole("button", { name: "開啟相機設定…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "已經允許了？重新啟動 RecordStuff" })).toBeVisible();
});

test("S124–S126 camera rows: number fields in the Camera picker in pixels and percent, typed, stepped or dragged by their names, each commits once; locked with the picker while recording (plan 075, step 7; 2026-10-21; plan 097)", { tag: "@studio" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(560, 680); });
  const devices = [{ id: "built-in", name: "FaceTime HD Camera", default: true }, { id: "iphone", name: "iPhone Camera", default: false }];
  await host.evaluate((h, list) => {
    h.state.cameraState = undefined;
    // A square a fifth of the shorter side: 432 pixels of the host display's 3840 × 2160 recording.
    const layout = { width: 0.2, height: 0.2, rounding: 1, mirror: false, positions: [] };
    h.state.cameraContext = { ...h.baseContext(), camera: { enabled: true, available: true, access: "granted", devices: list, layout } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  }, devices);
  await page.locator("#tab-studio").click();
  // The bubble's shape is chosen in the Camera picker's menu, with its switch and devices (plan 097).
  const picker = page.locator("#setting-studioCameraDevice");
  await expect(picker, "S124 the Camera picker names the camera").toHaveAccessibleName("Camera: FaceTime HD Camera");
  await picker.click();
  const width = page.getByRole("spinbutton", { name: "Width" });
  const rounding = page.getByRole("spinbutton", { name: "Rounding" });
  await expect(width, "S124 a field is named by its row and reads in pixels").toHaveAttribute("aria-valuetext", "432 px");
  await expect(page.locator("#setting-studioCameraDevice-pixels"), "S124 and says what they are counted on").toHaveText("Pixels in a 3840 × 2160 recording.");
  await expect(width, "S124 to assistive technology too").toHaveAccessibleDescription("Pixels in a 3840 × 2160 recording.");
  await expect(rounding, "S124 the rounding in percent").toHaveAttribute("aria-valuetext", "100%");
  await expect(page.getByRole("spinbutton"), "S125 no shape buttons: the width and height make the shape").toHaveCount(3);
  await clearCalls();
  await width.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(calls, { message: "S124 a step commits the whole pixels to main" }).toEqual([["cameraWidth", "433"]]);
  await expect(width, "S124 the committed value shows").toHaveAttribute("aria-valuetext", "433 px");
  await host.evaluate(h => { h.state.holdSaves = true; });
  await clearCalls();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect.poll(calls, { message: "S124 a key held while saving goes on from the value stepped to" }).toEqual([["cameraWidth", "434"], ["cameraWidth", "435"]]);
  await expect(width, "S124 and shows it while it saves").toHaveValue("435");
  await host.evaluate(h => { h.state.holdSaves = false; h.releaseSave(); h.releaseSave(); });
  await expect(width).toHaveAttribute("aria-valuetext", "435 px");
  await clearCalls();
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(calls, { message: "S124 Shift steps ten" }).toEqual([["cameraWidth", "425"]]);
  // Typed: sent once on Enter, kept within the range, and Escape gives the typing up.
  await clearCalls();
  await width.fill("300");
  await expect.poll(calls, { message: "S124 typing alone sends nothing" }).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(calls, { message: "S124 Enter sends the pixels typed" }).toEqual([["cameraWidth", "300"]]);
  await expect(width).toHaveAttribute("aria-valuetext", "300 px");
  await clearCalls();
  await width.fill("9999");
  await page.keyboard.press("Enter");
  await expect.poll(calls, { message: "S124 past the top is the top" }).toEqual([["cameraWidth", "1296"]]);
  await clearCalls();
  await width.fill("80");
  await page.keyboard.press("Escape");
  await expect(width, "S124 Escape restores the saved value").toHaveValue("1296");
  await rounding.fill("37");
  await rounding.blur();
  await expect.poll(calls, { message: "S124 leaving the field sends it" }).toEqual([["cameraRounding", "37"]]);
  await expect(rounding).toHaveAttribute("aria-valuetext", "37%");
  // Dragged sideways by its name, as a slider: one save, where it was let go of.
  await clearCalls();
  const name = page.locator(".number-setting", { has: rounding }).locator(".number-setting-name");
  const box = (await name.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2, { steps: 3 });
  await page.mouse.up();
  await expect.poll(calls, { message: "S124 one drag is one save" }).toEqual([["cameraRounding", "47"]]);
  await expect(rounding).toHaveAttribute("aria-valuetext", "47%");
  // At any window size, each field in the picker's menu shows its whole name, value and unit, none covering another.
  for (const [w, h] of [[600, 680], [760, 680], [1000, 680]] as const) {
    await host.evaluate((host, size) => host.setSize(size[0], size[1]), [w, h]);
    const fields = await page.locator(".studio-fields .number-setting").evaluateAll(els => els.map(el => {
      const r = el.getBoundingClientRect();
      const input = el.querySelector("input")!;
      const clipped = el.scrollWidth > el.clientWidth + 0.5 || input.scrollWidth > input.clientWidth + 0.5;
      return { clipped, box: [r.left, r.top, r.right, r.bottom] };
    }));
    expect(fields.every((f) => !f.clipped), `S125 ${w}px nothing cut off: ${JSON.stringify(fields)}`).toBe(true);
    const meet = (a: number[], b: number[]) => a[0]! < b[2]! - 0.5 && b[0]! < a[2]! - 0.5 && a[1]! < b[3]! - 0.5 && b[1]! < a[3]! - 0.5;
    expect(fields.every((f, i) => fields.every((g, j) => i === j || !meet(f.box, g.box))), `S125 ${w}px no overlap`).toBe(true);
  }
  await host.evaluate(h => h.setSize(560, 680));

  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: "2026-10-17T00:00:00Z" };
    h.state.cameraContext = { ...h.state.cameraContext!, camera: { ...h.state.cameraContext!.camera!, session: { hidden: false } } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  });
  // Chosen before recording (plan 097): the switch and the shape lock with the picker, which shows a lock.
  await expect(page.locator("#setting-studioCamera"), "S126 the switch is locked while recording").toBeDisabled();
  await expect(width, "S126 and the shape").toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(picker, "S126 the picker does not open while recording").toBeDisabled();
  await expect(picker.locator(".studio-picker-lock"), "S126 its lock").toBeVisible();

  await host.evaluate(h => { h.state.cameraState = undefined; h.pushModel({ type: "idle" }, { language: "zh-TW", camera: { enabled: true, available: true, access: "granted" } }); });
  await picker.click();
  await expect(page.getByRole("spinbutton", { name: "寬度" }), "S124 zh-TW, at the default's").toHaveAttribute("aria-valuetext", "454 px");
  await page.keyboard.press("Escape");
});

test("S127–S130 camera preview: no camera of the page's own before Live preview, the bubble dragged and moved with keys to a saved place, the recording's picture while recording (plan 075, step 7; 2026-10-25)", { tag: "@studio" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(560, 680); });
  // No real camera in a background run: the page's own camera calls are answered by a drawn picture.
  await page.evaluate(() => {
    const record = { opened: [] as string[], stopped: 0 };
    (window as unknown as { cameraCalls: typeof record }).cameraCalls = record;
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: "videoinput", label: "FaceTime HD Camera", deviceId: "web-facetime" },
      { kind: "videoinput", label: "iPhone Camera", deviceId: "web-iphone" }] as MediaDeviceInfo[];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      record.opened.push(JSON.stringify(constraints));
      const canvas = document.createElement("canvas");
      canvas.width = 64; canvas.height = 36;
      canvas.getContext("2d")!.fillRect(0, 0, 64, 36);
      const stream = canvas.captureStream(5);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { record.stopped += 1; stop(); };
      }
      return stream;
    };
  });
  const cameraCalls = (): Promise<{ opened: string[]; stopped: number }> =>
    page.evaluate(() => ({ ...(window as unknown as { cameraCalls: { opened: string[]; stopped: number } }).cameraCalls }));
  const devices = [{ id: "built-in", name: "FaceTime HD Camera", default: true }, { id: "iphone", name: "iPhone Camera", default: false }];
  await host.evaluate((h, list) => {
    h.state.cameraState = undefined;
    h.previewWatches.length = 0;
    // Live preview off: since 2026-10-25 the Studio opens no camera of its own before it is on.
    h.state.cameraContext = { ...h.baseContext(), studioPreview: { rate: "power", view: "composed" },
      displays: [{ id: "1", label: "Built-in Display", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: true, primary: true, x: 0, y: 0 }],
      camera: { enabled: true, available: true, access: "granted", devices: list, device: { id: "iphone", label: "iPhone Camera" } } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  }, devices);
  await page.locator("#tab-studio").click();
  const bubble = page.getByRole("application", { name: "Preview" });
  await bubble.scrollIntoViewIfNeeded();
  await expect(bubble, "S127 the bubble says where it is").toHaveAccessibleDescription(/97% from the left, 5% from the top/);
  await page.waitForTimeout(500);
  expect((await cameraCalls()).opened, "S127 no camera opens before Live preview").toEqual([]);
  await expect(page.locator(".camera-preview-bubble video"), "S127 the bubble is an outline").toHaveCount(0);
  await expect(page.locator(".camera-preview-figure"), "S127 a figure marks where the camera will be").toBeVisible();

  // Let go of just inside an edge, the bubble stays there: nothing pulls it onto the edge (2026-10-22).
  await clearCalls();
  {
    const from = (await bubble.boundingBox())!, area = (await page.locator(".camera-preview-stage").boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // 2% of the free width from the left edge, and the middle of the free height off the centre.
    await page.mouse.move(area.x + 0.02 * (area.width - from.width) + from.width / 2, area.y + 0.4 * (area.height - from.height) + from.height / 2, { steps: 4 });
    await page.mouse.up();
  }
  await expect.poll(async () => (await calls()).map(([group, choice]) => [group, ...String(choice).split(",").map(Number)]), { message: "S128 let go of near an edge, it stays where it was let go of" })
    .toEqual([["cameraPreview", expect.closeTo(0.02, 1), expect.closeTo(0.4, 1)]]);
  await clearCalls();
  const box = (await bubble.boundingBox())!;
  const stage = (await page.locator(".camera-preview-stage").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2, { steps: 4 });
  await page.mouse.move(stage.x - 40, stage.y - 40, { steps: 4 });
  await page.mouse.up();
  await expect.poll(calls, { message: "S128 one drag is one save, where it was let go of, kept inside the display" }).toEqual([["cameraPreview", "0,0"]]);
  await expect(bubble).toHaveAccessibleDescription(/0% from the left, 0% from the top/);
  await clearCalls();
  await bubble.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(calls, { message: "S128 the arrow keys move it a step, Shift ten" }).toEqual([["cameraPreview", "0.01,0"], ["cameraPreview", "0.01,0.1"]]);
  await expect(bubble).toHaveAccessibleDescription(/1% from the left, 10% from the top/);
  // A step back to the saved place while the step out still saves is the newer intent, not nothing.
  await host.evaluate(h => { h.state.holdSaves = true; });
  await clearCalls();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(calls, { message: "S128 a step back while saving is sent" }).toEqual([["cameraPreview", "0.02,0.1"], ["cameraPreview", "0.01,0.1"]]);
  await host.evaluate(h => { h.state.holdSaves = false; h.releaseSave(); h.releaseSave(); });
  await expect(bubble).toHaveAccessibleDescription(/1% from the left, 10% from the top/);
  // Out, back and out again: the first save's end, for the same place as the last, does not undo the last's.
  await host.evaluate(h => { h.state.holdSaves = true; });
  await clearCalls();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await expect.poll(calls).toEqual([["cameraPreview", "0.02,0.1"], ["cameraPreview", "0.01,0.1"], ["cameraPreview", "0.02,0.1"]]);
  await host.evaluate(h => { h.releaseSave(); h.releaseSave(); });
  await expect(bubble, "S128 the last intent stays shown while it saves").toHaveAccessibleDescription(/2% from the left, 10% from the top/);
  await host.evaluate(h => { h.state.holdSaves = false; h.releaseSave(); });
  await expect(bubble).toHaveAccessibleDescription(/2% from the left, 10% from the top/);

  await page.locator("#tab-general").click();
  await page.waitForTimeout(200);
  expect((await cameraCalls()).opened, "S129 nor once the tab is left").toEqual([]);
  await page.locator("#tab-studio").click();

  // However small the bubble is drawn, what is dragged is at least 24px across.
  await host.evaluate(h => {
    const ctx = h.state.cameraContext!;
    h.state.cameraContext = { ...ctx, camera: { ...ctx.camera!, layout: { width: 0.05, height: 0.05, rounding: 1, mirror: false, positions: [] } } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  const small = (await page.getByRole("application", { name: "Preview" }).boundingBox())!;
  expect(Math.min(small.width, small.height), "S128 a 5% bubble's target").toBeGreaterThanOrEqual(24);
  expect((await page.locator(".camera-preview-bubble").boundingBox())!.width, "S128 the bubble itself stays to scale").toBeLessThan(24);
  // In a corner too, the whole target is inside the stage, which would clip it.
  await host.evaluate(h => {
    const ctx = h.state.cameraContext!;
    h.state.cameraContext = { ...ctx, camera: { ...ctx.camera!, layout: { width: 0.05, height: 0.05, rounding: 1, mirror: false, positions: [{ display: "1", x: 0, y: 0 }] } } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await expect.poll(async () => {
    const target = (await page.getByRole("application", { name: "Preview" }).boundingBox())!;
    const inner = await page.locator(".camera-preview-stage").evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left + el.clientLeft, y: r.top + el.clientTop }; });
    return [Math.round(target.x - inner.x), Math.round(target.y - inner.y), target.width >= 24 && target.height >= 24];
  }, { message: "S128 a cornered 5% bubble's target is inside the stage" }).toEqual([0, 0, true]);
  await host.evaluate(h => {
    const ctx = h.state.cameraContext!;
    h.state.cameraContext = { ...ctx, camera: { ...ctx.camera!, layout: { width: 0.05, height: 0.05, rounding: 1, mirror: false, positions: [] } } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });

  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: "2026-10-17T00:00:00Z" };
    h.state.cameraContext = { ...h.state.cameraContext!, camera: { ...h.state.cameraContext!.camera!, session: { hidden: false } } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  });
  await page.getByRole("application", { name: "Preview" }).scrollIntoViewIfNeeded();
  await expect.poll(() => host.evaluate(h => [...h.previewWatches]), { message: "S130 a recording's preview is asked for while in sight" }).toEqual([true]);
  await expect(page.locator(".camera-preview-picture"), "S130 its picture takes the stage").toBeVisible();
  await clearCalls();
  await page.getByRole("application", { name: "Preview" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(calls, { message: "S130 the bubble still moves while recording (D7)" }).toEqual([["cameraPreview", "0.96,0.05"]]);

  await host.evaluate(h => { h.state.cameraState = undefined; h.pushModel({ type: "idle" }, { language: "zh-TW", studioPreview: h.state.cameraContext!.studioPreview,
    displays: h.state.cameraContext!.displays, camera: { enabled: false, available: true, access: "granted" } }); });
  await expect.poll(() => host.evaluate(h => [...h.previewWatches]), { message: "S130 and let go of once the recording is over" }).toEqual([true, false]);
  // The camera off, there is no bubble to place (2026-10-26); on again, it is placed where it was.
  await expect(page.getByRole("application", { name: "預覽" }), "S127 no bubble with the camera off").toHaveCount(0);
  await expect(page.locator(".camera-preview-bubble"), "S127 nor its placeholder").toHaveCount(0);
  await expect(page.locator(".camera-preview-status"), "S127 nothing said over a stage that shows no camera").toHaveCount(0);
  await host.evaluate(h => { h.pushModel({ type: "idle" }, { language: "zh-TW", studioPreview: h.state.cameraContext!.studioPreview,
    displays: h.state.cameraContext!.displays, camera: { enabled: true, available: true, access: "granted" } }); });
  await expect(page.getByRole("application", { name: "預覽" }), "S127 zh-TW").toHaveAccessibleDescription(/距左側 97%，距上方 5%/);
});

test("S131–S132 the Recording Studio: its own tab with Start, then Stop beside the elapsed time; Recording settings keeps the camera's switch and device with the way there (plan 075, D19)", { tag: ["@recording-settings", "@studio"] }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(560, 680); });
  await host.evaluate(h => {
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.baseContext(), camera: { enabled: true, available: true, access: "granted" } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-studio").click();
  await expect(page.locator("#tab-studio"), "S131 a tab of its own").toHaveAttribute("aria-selected", "true");
  await page.locator("#setting-studioCameraDevice").click();
  await expect(page.locator("#setting-cameraWidth"), "S131 the bubble's shape is the Studio's, in its Camera picker").toHaveCount(1);
  await expect(page.getByRole("spinbutton", { name: "Width" }), "S131 said with what its pixels are counted on").toHaveAccessibleDescription(/Pixels in a \d+ × \d+ recording/);
  await expect(page.getByRole("switch", { name: "Mirror in recording", exact: true }), "S131 the mirror beside it").toBeVisible();
  await page.keyboard.press("Escape");
  await clearCalls();
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect.poll(calls, { message: "S131 Start asks main" }).toEqual([["studioControls", "start"]]);
  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: new Date(Date.now() - 65_000).toISOString() };
    h.state.cameraContext = { ...h.state.cameraContext!, camera: { ...h.state.cameraContext!.camera!, session: { hidden: false } } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  });
  await expect(page.getByRole("timer"), "S131 the elapsed time while recording").toHaveText(/^1:0[5-9]$/);
  // Showing the camera is under the preview, a plain recording's live control (plan 097, D6): the one switch for it.
  const shown = page.locator(".studio-live-row").getByRole("switch", { name: "Show camera" });
  await expect(shown, "S131 the camera's showing while recording (D13)").toHaveAttribute("aria-checked", "true");
  await expect(shown).toBeEnabled();
  await clearCalls();
  await shown.click();
  await expect.poll(calls, { message: "S131 hiding asks main" }).toEqual([["cameraShown", "off"]]);
  await host.evaluate(h => {
    h.state.cameraContext = { ...h.state.cameraContext!, camera: { ...h.state.cameraContext!.camera!, session: { hidden: true } } };
    h.push(h.settingsView(h.state.cameraState!, h.state.cameraContext));
  });
  await expect(shown, "S131 hidden: the same switch, off").toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".camera-preview-handle"), "S131 hidden from the recording: no bubble to drag").toHaveCount(0);
  await clearCalls();
  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect.poll(calls, { message: "S131 Stop asks main" }).toEqual([["studioControls", "stop"]]);

  await host.evaluate(h => { h.state.cameraState = undefined; h.push(h.settingsView({ type: "idle" }, h.state.cameraContext!)); });
  await page.locator("#tab-recording").click();
  await expect(page.locator("#setting-cameraWidth"), "S132 Recording settings keeps no shape row").toHaveCount(0);
  await page.locator("#setting-cameraDevice").scrollIntoViewIfNeeded();
  await clearCalls();
  await page.getByRole("button", { name: "Arrange in Recording Studio…" }).click();
  await expect.poll(calls, { message: "S132 the way to the Studio is main's to open" }).toEqual([["cameraStudio", "openStudio"]]);

  await host.evaluate(h => h.pushModel({ type: "idle" }, { language: "zh-TW", camera: { enabled: true, available: true, access: "granted" } }));
  await expect(page.locator("#tab-studio"), "S131 zh-TW").toHaveAccessibleName("錄影工作室");
});

test("S133–S134 the Recording Studio's meters: levels while recording and in sight, Don't record per input with its not-recorded look, said to assistive technology (plan 075, D19; plan 097, D6)", { tag: "@studio" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(560, 680); });
  await host.evaluate(h => {
    h.levelWatches.length = 0;
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.baseContext(), microphone: { enabled: true } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-studio").click();
  const system = page.getByRole("button", { name: "Don't record System audio" });
  await page.getByRole("slider", { name: "Microphone volume" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("slider", { name: "Microphone volume" }), "S133 the microphone's fader while its switch is on").toBeVisible();
  // Between recordings there is no level to show and nothing to mute, but each input's meter and mute keep their place
  // in the Audio panel, at silence and unavailable, so nothing moves as a recording starts (2026-10-24).
  await expect(system, "S133 between recordings there is nothing to mute").toBeDisabled();
  await expect(page.locator(".studio-live-row").getByRole("meter"), "S133 each meter in its place under the preview, at silence").toHaveCount(2);
  await expect(page.getByRole("meter", { name: "System audio" }), "S133 at the floor").toHaveAttribute("aria-valuenow", "-60");
  await page.waitForTimeout(200);
  expect(await host.evaluate(h => [...h.levelWatches]), "S133 no levels are asked for between recordings").toEqual([]);

  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: new Date().toISOString() };
    h.state.cameraContext = { ...h.state.cameraContext!, audioSession: { systemMuted: false, microphone: { muted: false } } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  });
  await expect(system, "S133 a recording's mute, under its input's name").toBeEnabled();
  await expect(page.locator(".studio-live-row").getByRole("button", { name: "Don't record System audio" }), "S133 under the preview").toBeVisible();
  await expect(page.getByRole("meter", { name: "Microphone" }), "S133 and each input's meter").toBeVisible();
  await expect.poll(() => host.evaluate(h => [...h.levelWatches]), { message: "S133 a recording's meter in sight asks for levels" }).toEqual([true]);
  await host.evaluate(h => h.pushLevels({ system: 0.5, microphone: 0.1 }));
  await expect(page.getByRole("meter", { name: "System audio" }), "S133 a level in dB below full scale").toHaveAttribute("aria-valuetext", "-6 dB");
  await expect(page.getByRole("meter", { name: "Microphone" })).toHaveAttribute("aria-valuetext", "-20 dB");
  // No level comes in silence (WASAPI's loopback sends none): the meter falls back with time all the same.
  await expect.poll(async () => Number(await page.getByRole("meter", { name: "System audio" }).getAttribute("aria-valuenow")),
    { message: "S133 it falls back without new levels", timeout: 3000 }).toBeLessThan(-20);
  // Past full scale (a sum before the limiter) it reads full scale, within its range.
  await host.evaluate(h => h.pushLevels({ system: 2 }));
  // Seen once it arrives, before it falls back far (a step every tenth of a second): full scale, never past it.
  const valueNow = async (): Promise<number> => Number(await page.getByRole("meter", { name: "System audio" }).getAttribute("aria-valuenow"));
  await expect.poll(valueNow, { message: "S133 a level past full scale arrives" }).toBeGreaterThanOrEqual(-5);
  expect(await valueNow(), "S133 and reads full scale at most").toBeLessThanOrEqual(0);
  await clearCalls();
  await page.getByRole("button", { name: "Don't record Microphone" }).click();
  await expect.poll(calls, { message: "S134 Don't record asks main" }).toEqual([["microphoneAudio", "mute"]]);
  await expect(page.getByRole("button", { name: "Record Microphone" }), "S134 and shows it").toHaveAttribute("aria-pressed", "true");
  // Not recorded, the whole input says so in the warning look, not only a greyed meter (plan 097, D6).
  const left = page.locator(".studio-channel[data-problem]");
  await expect(left, "S134 the input left out").toHaveCount(1);
  await expect(left, "S134 says it is not recorded").toContainText("Microphone not recorded");
  await page.getByRole("button", { name: "Record Microphone" }).click();
  await expect(left, "S134 recorded again: quiet").toHaveCount(0);

  await page.locator("#tab-general").click();
  await expect.poll(() => host.evaluate(h => [...h.levelWatches]), { message: "S133 leaving the tab lets the levels go" }).toEqual([true, false]);
  await page.locator("#tab-studio").click();
  // The recording ends and the next one starts with the Studio open: its meters start from silence.
  await host.evaluate(h => h.pushLevels({ system: 1 }));
  await host.evaluate(h => { h.state.cameraState = undefined; h.push(h.settingsView({ type: "idle" }, { ...h.state.cameraContext!, audioSession: undefined })); });
  await host.evaluate(h => h.push(h.settingsView({ type: "countdown", remaining: 3 }, h.state.cameraContext!)));
  await expect(page.getByRole("meter", { name: "System audio" }), "S133 a next recording's meter starts from silence").toHaveAttribute("aria-valuenow", "-60");
  await host.evaluate(h => { h.state.cameraState = undefined; h.pushModel({ type: "idle" }, { language: "zh-TW", microphone: { enabled: true } }); });
  await expect(page.getByRole("slider", { name: "系統聲音音量" }), "S133 zh-TW, between recordings its fader alone").toBeVisible();
});

test("S138 each input's fader under its meter: saved between and during recordings, said in percent, 100% in the middle, silent at its bottom (plan 075, D21, 2026-10-21; 2026-10-25)", { tag: "@studio" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(560, 680); });
  await host.evaluate(h => {
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.baseContext(), microphone: { enabled: true }, audioVolume: { system: 100, microphone: 50 } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-studio").click();
  const system = page.getByRole("slider", { name: "System audio volume" });
  const microphone = page.getByRole("slider", { name: "Microphone volume" });
  await system.scrollIntoViewIfNeeded();
  await expect(system, "S138 between recordings a fader may move").toBeEnabled();
  await expect(system, "S138 as it comes is 100%").toHaveAttribute("aria-valuetext", "100%");
  await expect(microphone, "S138 each input its own").toHaveAttribute("aria-valuetext", "50%");
  await clearCalls();
  await system.focus();
  // 100% in the middle (2026-10-25): a step down is 5%, a step up 25%.
  await page.keyboard.press("ArrowLeft");
  await expect.poll(calls, { message: "S138 a step down of 5% asks main to save it" }).toEqual([["systemGain", "95"]]);
  await expect(system, "S138 and shows it").toHaveAttribute("aria-valuetext", "95%");
  await clearCalls();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(calls, { message: "S138 past the middle a step is 25%" }).toEqual([["systemGain", "100"], ["systemGain", "125"]]);
  await expect(system, "S138 and shows it").toHaveAttribute("aria-valuetext", "125%");
  await clearCalls();
  await page.keyboard.press("End");
  await expect.poll(calls, { message: "S138 the top is 600%" }).toEqual([["systemGain", "600"]]);

  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: new Date().toISOString() };
    h.state.cameraContext = { ...h.state.cameraContext!, audioSession: { systemMuted: false, microphone: { muted: false } } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  });
  await expect(microphone, "S138 while recording too").toBeEnabled();
  await clearCalls();
  await microphone.focus();
  await page.keyboard.press("Home");
  await expect.poll(calls, { message: "S138 the bottom is a choice main takes" }).toEqual([["microphoneGain", "0"]]);
  await expect(microphone, "S138 and is silence").toHaveAttribute("aria-valuetext", "0%");
  await host.evaluate(h => { h.state.cameraState = undefined; h.pushModel({ type: "idle" }, { language: "zh-TW", microphone: { enabled: true } }); });
  await expect(page.getByRole("slider", { name: "麥克風音量" }), "S138 zh-TW").toBeVisible();
});

test("S135 the sidebar collapses to toolbars of icons named by their tooltips, its status a bell that opens the card beside it, and is remembered; a narrow window keeps it collapsed (2026-10-17, 2026-10-20, 2026-10-21)", { tag: "@layout" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(1000, 680); h.pushModel({ type: "idle" }); });
  const toggle = page.locator("#sidebar-toggle");
  await expect(toggle).toHaveAttribute("aria-label", "Collapse sidebar");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("main"), "S135 collapsed").toHaveAttribute("data-sidebar", "collapsed");
  await expect(toggle, "S135 the keyboard's focus stays on the toggle").toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#tab-library .tab-name"), "S135 the tabs' names give way to their icons").toBeHidden();
  await expect(page.locator("#tab-library"), "S135 and stay their names").toHaveAccessibleName("Recordings");
  await page.locator("#tab-studio").hover();
  await expect(page.locator('[data-slot="tooltip-content"][data-open]'), "S135 a tooltip names the tab").toHaveText("Recording Studio");
  // The toggle stays where it was, so the same click opens the sidebar again.
  const collapsedAt = await toggle.boundingBox();
  await toggle.click();
  expect(await toggle.boundingBox(), "S135 the toggle does not move").toEqual(collapsedAt);
  await toggle.click();
  // A problem's card gives way to a bell named by it, which opens the card beside it; the sidebar stays collapsed.
  await host.evaluate(h => h.pushModel({ type: "idle", outputDirUnavailable: true }));
  const bell = page.locator("#status-bell"), card = page.locator("#status");
  await expect(bell).toBeVisible();
  await expect(card).toBeHidden();
  await bell.click();
  await expect(card, "S135 the card beside the bell").toBeVisible();
  await expect(bell).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("main")).toHaveAttribute("data-sidebar", "collapsed");
  await expect(page.locator("#status-action")).toBeVisible();
  // Escape closes the card, not the window, and gives the focus back to the bell.
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(bell).toBeFocused();
  await bell.click();
  await expect(card).toBeVisible();
  await page.locator(".settings-head").click({ position: { x: 300, y: 60 } });
  await expect(card, "S135 a press elsewhere closes it").toBeHidden();
  await host.evaluate(h => h.pushModel({ type: "idle" }));
  await expect(bell, "S135 no problem, no bell").toBeHidden();
  // The window's actions are one button whose menu holds Hide and Quit.
  await page.locator("#sidebar-about-hide-menu").click();
  await expect(page.getByRole("menuitem", { name: "Hide interface" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Quit RecordStuff" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Hide interface" })).toBeHidden();
  // Either way, it is remembered by the page.
  await toggle.click();
  expect(await page.evaluate(() => localStorage.getItem("recordstuff.sidebarCollapsed"))).toBe("0");
  await toggle.click();
  expect(await page.evaluate(() => localStorage.getItem("recordstuff.sidebarCollapsed"))).toBe("1");
  await toggle.click();
  // Troubleshooting's unread items are a dot on the collapsed sidebar, the count still in the tab's name.
  await host.evaluate(h => { const view = h.settingsView({ type: "idle" }, h.baseContext());
    h.push({ ...view, tabs: view.tabs.map((tab: { id: string; label: string }) => tab.id === "failures" ? { ...tab, label: "Troubleshooting (2)" } : tab) }); });
  await expect(page.locator("#tab-failures .tab-badge")).toBeVisible();
  await expect(page.locator("#tab-failures .tab-dot")).toBeHidden();
  await toggle.click();
  await expect(page.locator("#tab-failures .tab-dot")).toBeVisible();
  await expect(page.locator("#tab-failures .tab-badge")).toBeHidden();
  await expect(page.locator("#tab-failures")).toHaveAccessibleName(/2/);
  // Each icon stays where it was in the full sidebar.
  const collapsedIcon = await page.locator("#tab-recording .tab-icon").boundingBox();
  await toggle.click();
  expect(await page.locator("#tab-recording .tab-icon").boundingBox(), "S135 the icons do not move").toEqual(collapsedIcon);
  // A narrow window has no room for the full sidebar: it keeps the collapsed toolbars, with no toggle, and the choice
  // saved for a wide window stays (2026-10-21).
  await host.evaluate(async h => { await h.setSize(560, 680); h.pushModel({ type: "idle" }); });
  await expect(page.locator("main"), "S135 a narrow window's sidebar is collapsed").toHaveAttribute("data-sidebar", "collapsed");
  await expect(toggle).toBeHidden();
  await expect(page.locator("#sidebar-about-hide-menu"), "S135 …its window actions one button").toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("recordstuff.sidebarCollapsed"))).toBe("0");
  await host.evaluate(h => h.setSize(1000, 680));
  await expect(page.locator("main"), "S135 widened, the saved full sidebar returns").not.toHaveAttribute("data-sidebar", "collapsed");
  await expect(toggle).toBeVisible();
});

test("S136–S137 Live preview: a switch of the preview's own, apart from Start, asks main; the engine's picture shows with no bubble to place when the camera is off, can be hidden while recording, and leaving the Studio lets it go (plan 075, D20, 2026-10-21)", { tag: "@studio" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(1000, 720); });
  await host.evaluate(h => {
    h.studioWatches.length = 0;
    h.previewWatches.length = 0;
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.baseContext(), studioPreview: { rate: "power", view: "composed" }, camera: { enabled: false, available: true, access: "granted" } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-studio").click();
  await expect.poll(() => host.evaluate(h => [...h.studioWatches]), { message: "S136 the Studio says it is open" }).toEqual([true]);
  const live = page.getByRole("switch", { name: "Live preview" });
  await expect(live, "S136 a switch, off").toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".studio-record").getByRole("button"), "S136 the recording's control holds Start alone").toHaveText(["Start recording"]);
  await expect(page.locator(".studio-choices"), "S136 the choices are drawn in the recording's phase").toHaveAttribute("data-phase", "idle");
  await clearCalls();
  await live.click();
  await expect.poll(calls, { message: "S136 Live preview asks main" }).toEqual([["studioLive", "on"]]);
  await host.evaluate(h => {
    h.state.cameraContext = { ...h.state.cameraContext!, studio: { preview: { live: true }, showing: true } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await expect(live).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#setting-studioControls-label"), "S136 the recording's state, not the preview's").toHaveText("Ready");
  await expect(page.locator(".camera-preview-picture"), "S136 the engine's picture").toBeVisible();
  await expect(page.locator(".camera-preview-handle"), "S136 no bubble to place without the camera").toHaveCount(0);
  await expect.poll(() => host.evaluate(h => [...h.previewWatches]), { message: "S136 its picture is asked for" }).toEqual([true]);
  // While recording: Stop with the elapsed time, and the picture switched off, which lets the engine's preview go.
  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: new Date().toISOString() };
    h.state.cameraContext = { ...h.state.cameraContext!, studio: { showing: true } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  });
  await expect(page.locator(".studio-choices"), "S136 recording").toHaveAttribute("data-phase", "recording");
  await expect(page.getByRole("button", { name: "Stop recording" }), "S136 Stop says a recording is under way, with its time").toContainText(/\d:\d\d/);
  await expect(live, "S136 the recording's picture shows").toHaveAttribute("aria-checked", "true");
  await clearCalls();
  await live.click();
  await expect.poll(calls, { message: "S136 hiding the picture asks main" }).toEqual([["studioLive", "off"]]);
  await host.evaluate(h => {
    h.state.cameraContext = { ...h.state.cameraContext!, studio: { showing: false, pictureHidden: true } };
    h.push(h.settingsView(h.state.cameraState!, h.state.cameraContext));
  });
  await expect(live).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".camera-preview-picture"), "S136 no picture").toBeHidden();
  await expect.poll(() => host.evaluate(h => [...h.previewWatches]), { message: "S136 the picture is let go" }).toEqual([true, false]);
  // A preview that could not start says why, under the picture and to its switch, until the next.
  await host.evaluate(h => {
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.state.cameraContext!, studio: { showing: false, previewFailure: "camera_unavailable" } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await expect(page.locator(".studio-stage [role=status]"), "S136 why").toContainText("Live preview could not start:");
  await expect(live, "S136 its switch is described by why").toHaveAccessibleDescription(/Live preview could not start:/);
  await page.locator("#tab-general").click();
  await expect.poll(() => host.evaluate(h => [...h.studioWatches]), { message: "S137 leaving the Studio lets the preview go" }).toEqual([true, false]);
  await host.evaluate(h => h.setSize(560, 680));
});

test("S142 the Studio's choices over the preview and the toolbar's end: Live preview on the record control's line, nothing laid over the picture to press; what the camera is doing while a recording gives no picture of it is said by its picker, so nothing moves (plan 090; plan 097, D2)", { tag: "@studio" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(1000, 720); });
  const recording = (state?: "waiting" | "notReady" | "lost") => host.evaluate((h, state) => {
    h.state.cameraState = { type: "recording", startedAt: new Date().toISOString() };
    h.state.cameraContext = { ...h.baseContext(), studio: { showing: true },
      camera: { enabled: true, available: true, access: "granted", devices: [{ id: "facetime", name: "FaceTime HD Camera", default: true }],
        session: { hidden: false, ...(state ? { state } : {}) } } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  }, state);
  await recording("waiting");
  await page.locator("#tab-studio").click();
  const head = page.locator(".studio-head");
  await expect(head.getByRole("switch", { name: "Live preview" }), "S142 Live preview is on the record control's line").toBeVisible();
  await expect(head.getByRole("combobox", { name: "Preview view" }), "S142 with the view").toBeVisible();
  // On the record control's line since 2026-10-28, out of the page's head, which drags the window on macOS.
  await expect(page.locator(".settings-head .studio-head"), "S142 not in the page's head").toHaveCount(0);
  await expect(page.locator(".studio-toolbar-row").locator(".studio-choices + .studio-head"), "S142 on the record control's line").toHaveCount(1);
  await expect(page.locator(".camera-preview-stage").getByRole("switch"), "S142 nothing laid over the picture").toHaveCount(0);
  // Said once, by the Camera picker (plan 097, D2): not over the stage, and with no status dot.
  const picker = page.locator("#setting-studioCameraDevice");
  await expect(page.locator(".studio-sources #setting-studioCameraDevice"), "S142 the picker among the sources under the preview (2026-10-31)").toHaveCount(1);
  await expect(picker, "S142 waiting for its first frame").toHaveAccessibleName("Camera: Waiting for the camera…");
  await expect(picker, "S142 the camera starting is no warning").not.toHaveAttribute("data-problem", /.*/);
  // One short line (2026-10-31): the input and its state in sight, the whole name in its accessible name and tooltip.
  const state = picker.locator(".studio-source-state > [data-shown]");
  await expect(state, "S142 starting, the camera is on").toHaveText("On");
  await expect(page.locator(".studio-stage").getByRole("status"), "S142 nothing said over the stage").toHaveCount(0);
  await expect(page.locator(".camera-preview-stage .camera-preview-status"), "S142 nor in the picture").toHaveCount(0);
  await recording("notReady");
  await expect(picker, "S142 not ready").toHaveAccessibleName("Camera: The camera is not ready");
  await expect(picker, "S142 in the warning look").toHaveAttribute("data-problem", "true");
  await expect(state, "S142 a problem said in sight, not only in its tooltip").toHaveText("Problem");
  await recording("lost");
  await expect(picker, "S142 lost").toHaveAccessibleName("Camera: The camera dropped out");
  await recording();
  await expect(picker, "S142 the camera's name while it delivers").toHaveAccessibleName("Camera: FaceTime HD Camera");
  await expect(picker).not.toHaveAttribute("data-problem", /.*/);
  await expect(state, "S142 delivering, On again").toHaveText("On");
  // A portrait screen's narrow window: the choices and the picture keep their places as it is said and goes.
  // setSize resolves once the page has the new size (hosts/settle.ts).
  await host.evaluate(h => h.setSize(541, 900));
  // The narrow window's own layout first: its sidebar collapses, which can come later than the size on a busy machine
  // (2026-10-26, CI: the places were taken with the sidebar still wide, then it collapsed and everything "moved").
  await expect(page.locator('main[data-sidebar="collapsed"]'), "S142 the narrow window's sidebar").toHaveCount(1);
  const places = () => page.evaluate(() => [".studio-choices", ".studio-stage .camera-preview-stage", ".studio-sources", ".studio-live-row"].map((selector) => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height].map(Math.round).join(",");
  }));
  await expect.poll(async () => { const a = await places(); await page.waitForTimeout(100); return a.join("|") === (await places()).join("|"); },
    { message: "S142 the narrow layout settles" }).toBe(true);
  const delivering = await places();
  await recording("lost");
  await expect(picker, "S142 said in the narrow window").toHaveAccessibleName("Camera: The camera dropped out");
  expect(await places(), "S142 nothing moves as it is said").toEqual(delivering);
  await recording();
  await expect(picker).toHaveAccessibleName("Camera: FaceTime HD Camera");
  expect(await places(), "S142 nothing moves as it goes").toEqual(delivering);
  await host.evaluate(async h => { h.state.cameraState = undefined; await h.setSize(560, 680); });
});

test("S143–S145 the Studio's preview: Power saving by default, no camera opened before Live preview with the bubble still placed, a rate behind ⋯ whose every choice says what it does, and two views (plan 092; no Off since 2026-10-25; plan 097)", { tag: "@studio" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(1000, 720); });
  await page.evaluate(() => {
    const record = { opened: 0 };
    (window as unknown as { cameraCalls: typeof record }).cameraCalls = record;
    navigator.mediaDevices.enumerateDevices = async () => [] as MediaDeviceInfo[];
    navigator.mediaDevices.getUserMedia = async () => {
      record.opened += 1;
      const canvas = document.createElement("canvas");
      canvas.getContext("2d")!.fillRect(0, 0, 8, 8);
      return canvas.captureStream(5);
    };
  });
  const opened = (): Promise<number> => page.evaluate(() => (window as unknown as { cameraCalls: { opened: number } }).cameraCalls.opened);
  await host.evaluate(h => {
    h.state.cameraState = undefined;
    h.previewWatches.length = 0;
    // No `studioPreview`: the default a new install has.
    h.state.cameraContext = { ...h.baseContext(),
      displays: [{ id: "1", label: "Built-in Display", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: true, primary: true, x: 0, y: 0 }],
      camera: { enabled: true, available: true, access: "granted" } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-studio").click();
  const stage = page.locator(".studio-stage .camera-preview-stage");
  // The rate, set now and then, behind ⋯ at the toolbar's end (plan 097).
  const more = page.locator(".studio-head").getByRole("button", { name: "Preview rate" });
  const rateChoice = (name: string) => page.getByRole("radiogroup", { name: "Preview rate" }).getByRole("radio", { name: new RegExp(`^${name}`) });
  await more.click();
  await expect(rateChoice("Power saving"), "S143 Power saving by default").toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(stage.getByRole("button").filter({ hasNotText: "Turn on preview" }), "S143 nothing over the empty stage to press but Turn on preview").toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await opened(), "S143 opening the Studio opens no camera before Live preview").toBe(0);
  const bubble = page.getByRole("application", { name: "Preview" });
  await expect(bubble, "S143 the bubble is still placed over the empty stage").toBeVisible();
  await clearCalls();
  await bubble.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(calls, { message: "S143 and moves" }).toEqual([["cameraPreview", expect.stringMatching(/^0\.\d+,0\.\d+$/)]]);
  // During a recording with its picture hidden by Live preview's switch, no picture is asked for.
  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: new Date().toISOString() };
    h.state.cameraContext = { ...h.state.cameraContext!, studio: { showing: false, pictureHidden: true }, camera: { ...h.state.cameraContext!.camera!, session: { hidden: false } } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  });
  await expect(page.locator(".camera-preview-picture"), "S143 no picture while hidden during a recording").toBeHidden();
  await page.waitForTimeout(500);
  expect(await host.evaluate(h => [...h.previewWatches]), "S143 no picture asked for while hidden").toEqual([]);

  // S144 the rate: behind ⋯ at the toolbar's end, every choice saying what it does.
  await expect(page.locator(".studio-stage").getByRole("button", { name: "Preview rate" }), "S144 nothing over the stage").toHaveCount(0);
  await more.click();
  await expect(page.getByRole("radiogroup", { name: "Preview rate" }).getByRole("radio"), "S144 three rates, no Off: Live preview is the picture's switch").toHaveCount(3);
  for (const [name, line] of [["Power saving", "5 fps while you only watch"],
    ["Standard", "10 fps all the time."], ["Smooth", "15 fps all the time; uses the most power."]] as const) {
    await expect(rateChoice(name), `S144 ${name} with its line`).toContainText(line);
  }
  await clearCalls();
  await rateChoice("Smooth").click();
  await expect.poll(calls, { message: "S144 a rate is chosen during a recording" }).toEqual([["studioPreviewRate", "smooth"]]);
  await expect(rateChoice("Smooth")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  // Shown again by Live preview's switch, the recording's picture is asked for.
  await host.evaluate(h => {
    h.state.cameraContext = { ...h.state.cameraContext!, studio: { showing: true } };
    h.push(h.settingsView(h.state.cameraState!, h.state.cameraContext));
  });
  await expect.poll(() => host.evaluate(h => [...h.previewWatches]), { message: "S144 the recording's picture is asked for once shown" }).toEqual([true]);
  await expect(page.locator(".camera-preview-picture"), "S144 and takes the stage").toBeVisible();
  // Until the recording's camera gives a picture, its place is marked over the picture; then the camera is the picture's.
  const withCamera = (state?: "waiting") => host.evaluate((h, state) => {
    h.state.cameraContext = { ...h.state.cameraContext!, camera: { ...h.state.cameraContext!.camera!, session: { hidden: false, ...(state ? { state } : {}) } } };
    h.push(h.settingsView(h.state.cameraState!, h.state.cameraContext));
  }, state);
  await withCamera("waiting");
  await expect(page.locator(".studio-stage .camera-preview-figure"), "S144 the camera's place marked while it gives no picture").toBeVisible();
  await withCamera();
  await expect(page.locator(".studio-stage .camera-preview-bubble"), "S144 the bubble still placed over the recording's camera").toHaveCount(1);
  await expect(page.locator(".studio-stage .camera-preview-figure"), "S144 no figure over the recording's own camera").toBeHidden();
  await host.evaluate(h => {
    const { session: _session, ...camera } = h.state.cameraContext!.camera!;
    h.state.cameraContext = { ...h.state.cameraContext!, camera };
    h.push(h.settingsView(h.state.cameraState!, h.state.cameraContext));
  });

  // S145 the view: a menu at the toolbar's end (plan 097), named by the picture it shows, every choice saying what it
  // shows; switched while watching. Two views: Screen only was removed (plan 097).
  const view = page.locator(".studio-head").getByRole("combobox", { name: "Preview view" });
  const chooseView = async (name: string): Promise<void> => { await view.click(); await page.getByRole("option", { name: new RegExp(`^${name}`) }).click(); };
  await expect(view, "S145 at the toolbar's end").toBeVisible();
  await expect(view, "S145 named by the picture it shows").toHaveText(/As recorded/);
  await expect(view, "S145 described by what it shows").toHaveAccessibleDescription("The screen and the camera, as the recording has them.");
  await view.click();
  await expect(page.getByRole("option"), "S145 two views").toHaveCount(2);
  for (const [name, line] of [["As recorded", "The screen and the camera, as the recording has them."],
    ["Check camera", "The camera enlarged, to check framing, light and focus."]] as const) {
    await expect(page.getByRole("option", { name: new RegExp(`^${name}`) }), `S145 ${name} with its line`).toContainText(line);
  }
  await page.keyboard.press("Escape");
  await host.evaluate(h => {
    h.state.cameraState = undefined;
    const { studio: _studio, ...ctx } = h.state.cameraContext!;
    h.state.cameraContext = { ...ctx, camera: { enabled: true, available: true, access: "granted" } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.waitForTimeout(500);
  expect(await opened(), "S145 the composed view before Live preview opens no camera").toBe(0);

  // S145 the Check camera view (plan 094, renamed by plan 097): the camera alone, at the bubble's shape and rounding,
  // enlarged and centred, with nothing to place; shown by a session (the page opens no camera of its own); without a
  // camera, why.
  await clearCalls();
  await chooseView("Check camera");
  await expect.poll(calls, { message: "S145 Camera asks main" }).toEqual([["studioPreviewView", "camera"]]);
  await host.evaluate(h => {
    h.state.cameraContext = { ...h.state.cameraContext!, studio: { preview: { live: true }, showing: true }, camera: { ...h.state.cameraContext!.camera!, session: { hidden: false } } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await expect(page.getByRole("application", { name: "Preview" }), "S145 nothing to drag in the Camera view").toHaveCount(0);
  // The engine's picture, clipped to the camera it draws enlarged at the bubble's shape (cameraViewRect's own cases
  // are in camera-layout.test.ts), with no bubble of the page's own over it.
  await expect(page.locator(".camera-preview-picture"), "S145 the engine's camera").toBeVisible();
  await expect.poll(() => page.locator(".camera-preview-picture").evaluate((canvas) => getComputedStyle(canvas).clipPath), { message: "S145 clipped to the enlarged camera" })
    .toMatch(/^inset\(/);
  await expect(page.locator(".studio-stage .camera-preview-bubble"), "S145 no bubble over the engine's camera").toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await opened(), "S145 the Camera view opens no camera of the page's own").toBe(0);
  const said = page.locator(".studio-stage .camera-preview-status");
  for (const [session, text] of [[{ hidden: true }, "The camera is hidden from the recording."], [{ hidden: false, state: "lost" }, "The camera dropped out. Reconnecting…"],
    [undefined, "The camera joins from the next recording."]] as const) {
    await host.evaluate((h, session) => {
      h.state.cameraState = { type: "recording", startedAt: new Date().toISOString() };
      const { session: _session, ...camera } = h.state.cameraContext!.camera!;
      h.state.cameraContext = { ...h.state.cameraContext!, studio: { showing: true }, camera: { ...camera, ...(session ? { session } : {}) } };
      h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
    }, session);
    await expect(page.getByRole("application", { name: "Preview" }), `S145 nothing to drag in a session's Camera view: ${text}`).toHaveCount(0);
    await expect(page.locator(".studio-stage .camera-preview-bubble"), `S145 the engine's picture is the camera: ${text}`).toHaveCount(0);
    await expect(said, `S145 the Camera view says why it has no camera: ${text}`).toHaveText(text);
    if (session?.state === "lost") {
      await expect(page.locator(".studio-stage .studio-stage-note"), "S145 no second line over its own picture").toHaveCount(0);
      await expect(page.locator("#setting-studioCameraDevice"), "S145 the Camera picker says it too").toHaveAccessibleName("Camera: The camera dropped out");
    }
  }
  await host.evaluate(h => {
    h.state.cameraState = undefined;
    const { studio: _studio, ...ctx } = h.state.cameraContext!;
    h.state.cameraContext = { ...ctx, camera: { enabled: false, available: true, access: "granted" } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await expect(said, "S145 before Live preview the Camera view says nothing over a stage that shows no camera").toHaveCount(0);
  await clearCalls();
  await chooseView("As recorded");
  await expect.poll(calls, { message: "S145 Composed again" }).toEqual([["studioPreviewView", "composed"]]);
  await host.evaluate(async h => { h.state.cameraState = undefined; await h.setSize(560, 680); });
});

test("S147 Turn on preview over the stage while Live preview is off: one button, always in sight (2026-10-31), what it means said to assistive technology; it asks main as the switch does and moves nothing; none while the switch cannot act or once the preview is on (2026-10-25)", { tag: "@studio" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(1000, 720); });
  await host.evaluate(h => {
    h.state.cameraState = undefined;
    // The bubble in the middle of the display, under where the button shows: the camera on, so there is one to place.
    h.state.cameraContext = { ...h.baseContext(),
      displays: [{ id: "1", label: "Built-in Display", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: true, primary: true, x: 0, y: 0 }],
      camera: { enabled: true, available: true, access: "granted",
        layout: { width: 0.21, height: 0.28, rounding: 0.15, mirror: false, positions: [{ display: "1", x: 0.5, y: 0.5 }] } } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-studio").click();
  const start = page.locator(".studio-stage").getByRole("button", { name: "Turn on preview" });
  const shown = (): Promise<boolean> => start.evaluate((button) => getComputedStyle(button).opacity !== "0");
  await expect(start, "S147 there while Live preview is off").toHaveCount(1);
  await page.mouse.move(5, 5);
  // In sight without the pointer on the stage (2026-10-31, the maintainer's request): its own words say the preview is
  // off, so no panel or line is drawn around it; assistive technology still hears why the stage is empty.
  await expect.poll(shown, { message: "S147 in sight with the pointer away" }).toBe(true);
  await expect(start, "S147 visible").toBeVisible();
  await expect.poll(() => page.locator(".studio-stage-start").getByText("Live preview is off.").evaluate((said) => said.getBoundingClientRect().width <= 1),
    { message: "S147 no line drawn beside it, said to assistive technology only" }).toBe(true);
  await expect(page.locator(".studio-stage-start").getByRole("button"), "S147 one button, nothing else to press").toHaveCount(1);
  await expect(start, "S147 described by why the stage is empty").toHaveAccessibleDescription("Live preview is off.");
  const places = () => page.evaluate(() => [".studio-choices", ".studio-stage .camera-preview-stage", ".studio-live-row"].map((selector) => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)];
  }));
  const before = await places();
  await page.locator(".studio-stage .camera-preview-stage").hover({ position: { x: 12, y: 12 } });
  await expect.poll(shown, { message: "S147 shown with the pointer anywhere on the stage" }).toBe(true);
  expect(await places(), "S147 it moves nothing").toEqual(before);
  // However narrow the picture, it stays inside it (a portrait display in a short window: the stage's floor).
  await host.evaluate(async h => {
    h.state.cameraContext = { ...h.state.cameraContext!,
      displays: [{ id: "1", label: "Studio", logicalWidth: 1080, logicalHeight: 1920, scaleFactor: 1, internal: false, primary: true, x: 0, y: 0 }] };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
    await h.setSize(1000, 480);
  });
  await expect.poll(() => page.evaluate(() => {
    const picture = document.querySelector(".studio-stage .camera-preview-stage")!.getBoundingClientRect();
    const button = document.querySelector(".studio-stage-start > button")!.getBoundingClientRect();
    return picture.width < 160 && button.left >= picture.left && button.right <= picture.right && button.top >= picture.top && button.bottom <= picture.bottom;
  }), { message: "S147 inside a narrow portrait picture" }).toBe(true);
  await host.evaluate(async h => {
    h.state.cameraContext = { ...h.state.cameraContext!,
      displays: [{ id: "1", label: "Built-in Display", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: true, primary: true, x: 0, y: 0 }] };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
    await h.setSize(1000, 720);
  });
  // A bubble placed under it is still what the pointer takes there, so it drags from its middle too.
  await expect.poll(() => page.evaluate(() => {
    const handle = document.querySelector(".studio-stage [role=application]")!.getBoundingClientRect();
    return document.elementFromPoint(handle.left + handle.width / 2, handle.top + handle.height / 2)?.getAttribute("role");
  }), { message: "S147 the bubble stays over it" }).toBe("application");
  await page.mouse.move(5, 5);
  await start.focus();
  await expect.poll(shown, { message: "S147 shown with keyboard focus" }).toBe(true);
  await clearCalls();
  // The bubble covers its middle here, so it is pressed by the keyboard, as it has focus.
  await page.keyboard.press("Enter");
  await expect.poll(calls, { message: "S147 it turns Live preview on as the switch does" }).toEqual([["studioLive", "on"]]);
  await host.evaluate(h => {
    h.state.cameraContext = { ...h.state.cameraContext!, studio: { preview: { live: true }, showing: true } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await expect(start, "S147 gone once the preview is on").toHaveCount(0);
  await expect(page.locator(".camera-preview-picture"), "S147 the engine's picture").toBeVisible();
  // A countdown: the switch cannot act, so neither does the stage.
  await host.evaluate(h => {
    h.state.cameraState = { type: "countdown", remaining: 3 };
    h.state.cameraContext = { ...h.state.cameraContext!, studio: { showing: false } };
    h.push(h.settingsView(h.state.cameraState!, h.state.cameraContext));
  });
  await expect(start, "S147 none while the switch cannot act").toHaveCount(0);
  await host.evaluate(h => h.setSize(560, 680));
});

test("S146 the Studio's stage: the largest picture at the display's shape that fits, landscape and portrait, at each size and zoom, the bubble placed by the same fractions, and what is pressed often over it (plan 095)", { tag: "@studio" }, async () => {
  await host.evaluate(h => h.theme("light"));
  const DISPLAYS = { landscape: [1920, 1080], portrait: [1080, 1920] } as const;
  const show = (shape: keyof typeof DISPLAYS, recording = false) => host.evaluate((h, [width, height, recording]) => {
    h.state.cameraState = recording ? { type: "recording", startedAt: new Date().toISOString() } : undefined;
    h.state.cameraContext = { ...h.baseContext(), microphone: { enabled: true },
      displays: [{ id: "1", label: "Display", logicalWidth: width, logicalHeight: height, scaleFactor: 2, internal: true, primary: true, x: 0, y: 0 }],
      camera: { enabled: true, available: true, access: "granted", layout: { width: 0.2, height: 0.2, rounding: 0.5, mirror: false, positions: [{ display: "1", x: 0.25, y: 0.75 }] },
        ...(recording ? { session: { hidden: false } } : {}) },
      ...(recording ? { studio: { showing: true }, audioSession: { systemMuted: false, microphone: { muted: false } } } : {}) };
    h.push(h.settingsView(h.state.cameraState ?? { type: "idle" }, h.state.cameraContext));
  }, [DISPLAYS[shape][0], DISPLAYS[shape][1], recording] as const);
  /** The stage in its letterbox and the bubble in the picture, as fractions the recording composes by. */
  const measure = () => page.locator(".studio-stage .camera-preview").evaluate((box) => {
    const stage = box.querySelector<HTMLElement>(".camera-preview-stage")!, bubble = box.querySelector<HTMLElement>(".camera-preview-bubble")!;
    const outer = box.getBoundingClientRect(), picture = stage.getBoundingClientRect(), drawn = bubble.getBoundingClientRect();
    const inner = { x: picture.left + stage.clientLeft, y: picture.top + stage.clientTop, width: stage.clientWidth, height: stage.clientHeight };
    const panel = document.getElementById("settings-panel")!;
    return { box: { width: outer.width, height: outer.height }, picture: { width: picture.width, height: picture.height }, inner,
      inside: picture.left >= outer.left - 0.5 && picture.right <= outer.right + 0.5 && picture.top >= outer.top - 0.5 && picture.bottom <= outer.bottom + 0.5,
      x: (drawn.left - inner.x) / (inner.width - drawn.width), y: (drawn.top - inner.y) / (inner.height - drawn.height), scale: drawn.width / Math.min(inner.width, inner.height),
      overflow: panel.scrollWidth > panel.clientWidth + 1 };
  });
  const SIZES = [[960, 640], [440, 760], [1043, 758], [1440, 900], [380, 360]] as const;
  const zoomTo = (factor: number) => host.evaluate((h, factor) => h.setZoom(factor), factor);
  await show("landscape");
  await page.locator("#tab-studio").click();
  for (const shape of ["landscape", "portrait"] as const) {
    await show(shape);
    const ratio = DISPLAYS[shape][0] / DISPLAYS[shape][1];
    // The app's largest zoom step (settings-window.ts ZOOM_STEPS) at two sizes, beside 100% at every size.
    for (const [zoom, sizes] of [[1, SIZES], [1.5, [[960, 640], [1440, 900]]]] as const) {
      await zoomTo(zoom);
      for (const [width, height] of sizes) {
        await host.evaluate((h, [width, height]) => h.setSize(width, height), [width, height] as const);
        const at = `${shape} · ${width}×${height} · ${zoom * 100}%`;
        // The bubble follows the stage's size a frame after it changes (useSize): what both settle to is judged.
        await expect.poll(async () => {
          const m = await measure();
          return { shape: Math.abs(m.inner.width / m.inner.height - ratio) / ratio < 0.01, inside: m.inside,
            meets: Math.min(Math.abs(m.picture.width - m.box.width), Math.abs(m.picture.height - m.box.height)) <= 1,
            overflow: m.overflow, x: m.x, y: m.y, scale: m.scale };
        }, { message: `S146 the picture keeps the display's shape, never exceeds its stage and meets it on one axis, nothing overflows sideways, and the bubble is at its fractions and to scale (a fifth of the shorter side) · ${at}` })
          .toEqual({ shape: true, inside: true, meets: true, overflow: false, x: expect.closeTo(0.25, 1), y: expect.closeTo(0.75, 1), scale: expect.closeTo(0.2, 1) });
      }
    }
  }
  await zoomTo(1);
  // A tall, narrow window (a portrait screen's) keeps no grey above and under a landscape picture: the stage is the
  // picture's height and the panels follow it, the height left over below them (2026-10-25, maintainer's choice).
  await show("landscape");
  await host.evaluate(h => h.setSize(900, 1600));
  await expect.poll(async () => {
    const m = await measure();
    // Next to it: the space between them is only the Studio's own gap between its parts, whatever that is.
    // The sources first under it since 2026-10-31.
    const [gap, rowGap] = await page.evaluate(() => [document.querySelector(".studio-sources")!.getBoundingClientRect().top - document.querySelector(".studio-stage")!.getBoundingClientRect().bottom,
      parseFloat(getComputedStyle(document.querySelector(".studio")!).rowGap) || 0]);
    return { fills: Math.abs(m.picture.height - m.box.height) <= 1 && Math.abs(m.picture.width - m.box.width) <= 1, follows: Math.abs(gap - rowGap) <= 1 };
  }, { message: "S146 a tall, narrow window: the stage is the picture's height and the sources follow it" }).toEqual({ fills: true, follows: true });
  // Dragged on a large stage, the bubble is let go of where the recording composes it.
  await show("landscape");
  // Measured once the window's new size has been laid out (setSize waits for it, hosts/settle.ts) and the stage has
  // followed: a stage read mid-resize sent the drag to a stale middle.
  await host.evaluate(h => h.setSize(1440, 900));
  let lastBox = "";
  await expect.poll(async () => {
    const now = JSON.stringify([await page.locator(".camera-preview-stage").boundingBox(), await page.getByRole("application", { name: "Preview" }).boundingBox()]);
    const still = now === lastBox;
    lastBox = now;
    return still;
  }, { message: "S146 the large stage is laid out", intervals: [100] }).toBe(true);
  const bubble = page.getByRole("application", { name: "Preview" });
  const stage = (await page.locator(".camera-preview-stage").boundingBox())!, from = (await bubble.boundingBox())!;
  await clearCalls();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await calls()).map(([group, choice]) => [group, ...String(choice).split(",").map(Number)]), { message: "S146 dragged to the middle of a large stage" })
    .toEqual([["cameraPreview", expect.closeTo(0.5, 1), expect.closeTo(0.5, 1)]]);
  // The view and Live preview at the toolbar's end, the sources and the live controls under the stage (plan 097, D1;
  // 2026-10-31), all in sight without scrolling at the default size.
  await show("landscape", true);
  await host.evaluate(h => h.setSize(h.SNAPSHOT_SIZES.default[0], h.SNAPSHOT_SIZES.default[1]));
  const head = page.locator(".studio-head"), choices = page.locator(".studio-choices"), sources = page.locator(".studio-sources"), live = page.locator(".studio-live-row");
  for (const control of [head.getByRole("combobox", { name: "Preview view" }), head.getByRole("switch", { name: "Live preview" }),
    sources.getByRole("button", { name: /^Screen:/ }), sources.getByRole("button", { name: /^Camera:/ }), sources.getByRole("button", { name: /^Microphone:/ }),
    sources.getByRole("combobox", { name: "Recording type" }),
    live.getByRole("button", { name: "Don't record System audio" }), live.getByRole("button", { name: "Don't record Microphone" }),
    live.getByRole("meter", { name: "Microphone" }), live.getByRole("switch", { name: "Show camera" })]) {
    await expect(control, "S146 in sight").toBeInViewport();
  }
  await expect(choices.getByRole("button", { name: /Don't record/ }), "S146 nothing live joins the choices as a recording starts").toHaveCount(0);
  await expect(sources.getByRole("button", { name: /Don't record/ }), "S146 nor the sources").toHaveCount(0);
  await keep("studio-live-controls.png");
  // Nothing moves as a recording starts or a Live preview is said to be starting (2026-10-24, at the maintainer's
  // request): the choices, the picture, the sources and the live controls keep their places and sizes.
  const places = () => page.evaluate(() => [".studio-choices", ".studio-stage .camera-preview-stage", ".studio-sources", ".studio-live-row"].map((selector) => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height].map(Math.round).join(",");
  }));
  const during = await places();
  await show("landscape", false);
  await expect.poll(places, { message: "S146 between recordings everything is where it is during one" }).toEqual(during);
  await host.evaluate(h => {
    h.state.cameraContext = { ...h.state.cameraContext!, studio: { showing: false, preview: { live: false } } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await expect(page.locator(".studio-stage-note"), "S146 a Live preview starting is said over the stage").toHaveText("Starting preview…");
  expect(await places(), "S146 over the stage, which keeps its size").toEqual(during);
  await host.evaluate(async h => { h.state.cameraState = undefined; await h.setSize(560, 680); });
});

test("S149–S151 the recording type in the Studio, its live controls following it, unavailable with why on Windows; the Recording tab's Test camera and device problems (plan 097, D4, D6)", { tag: ["@studio", "@recording-settings"] }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(1000, 720); });
  await host.evaluate(h => {
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.baseContext(), platform: "darwin", microphone: { enabled: true },
      camera: { enabled: true, available: true, access: "granted", devices: [{ id: "facetime", name: "FaceTime HD Camera", default: true }] } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-studio").click();
  const type = page.locator(".studio-sources").getByRole("combobox", { name: "Recording type" });
  await expect(type, "S149 a plain recording by default").toHaveText(/Plain recording/);
  await expect(type, "S149 described by what it gives").toHaveAccessibleDescription("Ready to share as soon as it stops.");
  const live = page.locator(".studio-live-row");
  await expect(live.getByRole("button", { name: "Don't record Microphone" }), "S149 a plain recording's live controls").toHaveCount(1);
  await expect(live.getByRole("slider", { name: "Microphone volume" })).toHaveCount(1);
  await type.click();
  await expect(page.getByRole("option", { name: /^Editable recording/ }), "S149 each type says what it gives").toContainText("Share… gives the finished video");
  await clearCalls();
  await page.getByRole("option", { name: /^Editable recording/ }).click();
  await expect.poll(calls, { message: "S149 the type is the Editable recordings setting" }).toEqual([["studioType", "editable"]]);
  await expect(type).toHaveText(/Editable recording/);
  // S150 an editable recording records every input as it comes: its meters alone, with no line under them (2026-10-28).
  await expect(live.getByRole("meter"), "S150 its meters stay").toHaveCount(2);
  await expect(live.getByRole("button", { name: /Don't record/ }), "S150 no Don't record").toHaveCount(0);
  await expect(live.getByRole("slider"), "S150 no fader").toHaveCount(0);
  await expect(live.getByRole("switch", { name: "Camera" }), "S150 no Show / Hide").toHaveCount(0);
  await expect(live.locator(".studio-note"), "S150 no line under them").toHaveCount(0);
  // Locked while recording, the type the recording has.
  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: new Date().toISOString() };
    h.state.cameraContext = { ...h.state.cameraContext!, editableSession: true, audioSession: { systemMuted: false, microphone: { muted: false }, editable: true } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  });
  await expect(type, "S150 locked while recording").toBeDisabled();
  await expect(type).toHaveText(/Editable recording/);
  // S150 Windows: listed, unavailable, with why, never hidden.
  await host.evaluate(h => {
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.baseContext(), platform: "win32", editableRecording: false };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await type.click();
  const unavailable = page.getByRole("option", { name: /^Editable recording/ });
  await expect(unavailable, "S150 listed on Windows").toBeVisible();
  await expect(unavailable, "S150 unavailable").toHaveAttribute("aria-disabled", "true");
  await expect(unavailable, "S150 with why").toContainText("Editable recordings are available on macOS only.");
  // Closed before the next tab is clicked: an Escape that arrives before the list has focus is lost, and the list's
  // backdrop would take the click.
  await expect(async () => {
    if (await unavailable.isVisible()) await page.keyboard.press("Escape");
    await expect(unavailable).toBeHidden({ timeout: 1000 });
  }).toPass();

  // S151 the Recording tab's Test camera (D4): opened only by its press; pressed again, or the tab left, it stops.
  await page.evaluate(() => {
    const record = { opened: [] as string[], stopped: 0 };
    (window as unknown as { cameraCalls: typeof record }).cameraCalls = record;
    navigator.mediaDevices.enumerateDevices = async () => [{ kind: "videoinput", label: "iPhone Camera", deviceId: "web-iphone" }] as MediaDeviceInfo[];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      record.opened.push(JSON.stringify(constraints));
      const canvas = document.createElement("canvas");
      canvas.getContext("2d")!.fillRect(0, 0, 8, 8);
      const stream = canvas.captureStream(5);
      for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { record.stopped += 1; stop(); }; }
      return stream;
    };
  });
  const cameraCalls = (): Promise<{ opened: string[]; stopped: number }> =>
    page.evaluate(() => ({ ...(window as unknown as { cameraCalls: { opened: string[]; stopped: number } }).cameraCalls }));
  await host.evaluate(h => {
    h.state.cameraContext = { ...h.baseContext(), platform: "darwin",
      camera: { enabled: true, available: true, access: "granted", device: { id: "iphone", label: "iPhone Camera" },
        devices: [{ id: "iphone", name: "iPhone Camera", default: false }, { id: "facetime", name: "FaceTime HD Camera", default: true }] } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-recording").click();
  const test = page.locator("#setting-cameraTest");
  await test.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  expect((await cameraCalls()).opened, "S151 visiting the tab opens no camera").toEqual([]);
  await test.click();
  await expect(page.locator(".device-stage-frame video"), "S151 the camera shown at the press").toBeVisible();
  await expect.poll(async () => (await cameraCalls()).opened, { message: "S151 the chosen camera, matched by name" }).toEqual([expect.stringContaining("web-iphone")]);
  await expect(test, "S151 pressed again stops it").toHaveText("Stop test");
  await test.click();
  await expect(page.locator(".device-stage-frame video")).toHaveCount(0);
  await expect.poll(async () => (await cameraCalls()).stopped, { message: "S151 every track stopped" }).toBeGreaterThan(0);
  await test.click();
  await expect(page.locator(".device-stage-frame video")).toBeVisible();
  const stopped = (await cameraCalls()).stopped;
  await page.locator("#tab-general").click();
  await expect.poll(async () => (await cameraCalls()).stopped, { message: "S151 leaving the tab stops it" }).toBeGreaterThan(stopped);
  await page.locator("#tab-recording").click();
  await expect(page.locator(".device-stage-frame video"), "S151 and it stays off on return").toHaveCount(0);
  // A device problem in the Studio picker's words (D2).
  await host.evaluate(h => {
    h.state.cameraContext = { ...h.state.cameraContext!, camera: { ...h.state.cameraContext!.camera!, device: { id: "usb", label: "USB Camera" } } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await expect(page.locator("#setting-cameraDevice-problem"), "S151 said by its row").toHaveText("USB Camera not found");
  await page.locator("#tab-studio").click();
  await expect(page.locator("#setting-studioCameraDevice"), "S151 and by the Studio's picker, in the same words").toHaveAccessibleName("Camera: USB Camera not found");
  await expect(page.locator("#setting-studioCameraDevice .studio-source-state > [data-shown]"), "S151 a problem in sight on its one line").toHaveText("Problem");
  await page.locator("#setting-studioCameraDevice").click();
  await expect(page.locator(".studio-picker-problem"), "S151 and in full atop its menu").toHaveText("USB Camera not found");
  await page.keyboard.press("Escape");
  // Recording locks changes, not diagnosis: the full reason remains available to pointer and keyboard users.
  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: new Date().toISOString() };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext!));
  });
  const lockedCamera = page.locator("#setting-studioCameraDevice");
  await expect(lockedCamera).toBeDisabled();
  const diagnosis = page.locator('[data-locked-source="setting-studioCameraDevice"]');
  await page.mouse.move(2, 2);
  await diagnosis.hover();

  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText("Camera: USB Camera not found");
  await page.mouse.move(2, 2);
  await diagnosis.focus();
  await expect(diagnosis).toBeFocused();
  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText("Camera: USB Camera not found");
  await page.keyboard.press("Enter");
  await expect(page.locator(".studio-picker-menu"), "S151 locked diagnosis never opens the change menu").toHaveCount(0);

  await host.evaluate(async h => { h.state.cameraState = undefined; await h.setSize(560, 680); });
});

test("S152 the System audio picker in the Studio: On or Off in its menu, its meter and fader gone while off, locked while recording (plan 101)", { tag: "@studio" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(1000, 720); });
  await host.evaluate(h => {
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.baseContext(), platform: "darwin", microphone: { enabled: true } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-studio").click();
  const picker = page.locator("#setting-studioSystemAudio");
  const live = page.locator(".studio-live-row");
  await expect(picker, "S152 named by the input and On").toHaveAccessibleName("System audio: On");
  await expect(live.getByRole("slider", { name: "System audio volume" }), "S152 its fader while on").toHaveCount(1);
  await picker.click();
  await clearCalls();
  await page.getByRole("radio", { name: "Off" }).click();
  await expect.poll(calls, { message: "S152 Off is the same setting as Recording settings'" }).toEqual([["studioSystemAudio", "off"]]);
  await page.keyboard.press("Escape");
  await expect(picker, "S152 the picker says Off").toHaveAccessibleName("System audio: Off");
  await expect(live.getByRole("slider", { name: "System audio volume" }), "S152 no fader for a sound not recorded").toHaveCount(0);
  await expect(live.getByRole("slider", { name: "Microphone volume" }), "S152 the microphone's stays").toHaveCount(1);
  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: "2026-10-30T00:00:00Z" };
    h.state.cameraContext = { ...h.state.cameraContext!, audioSession: { systemMuted: false, system: false, microphone: { muted: false } } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  });
  await expect(picker, "S152 locked while recording").toBeDisabled();
  await expect(live.getByRole("meter", { name: "System audio" }), "S152 a recording without it has no meter for it").toHaveCount(0);
  await expect(live.getByRole("meter", { name: "Microphone" })).toHaveCount(1);
});

test("S153 the Studio at any width: the toolbar's controls never laid over one another or past its edge, Record at its own width, the view named in words; the sources under the preview, one short line each, each named, never laid over one another or cut off, reached by keyboard; in either language and zoomed, and nothing moving as a recording counts down, starts and lasts (2026-10-31)", { tag: "@studio" }, async () => {
  // Two languages at eight widths, five phases at four and three zooms, each laid out and settled.
  test.setTimeout(120_000);
  await host.evaluate(async h => { h.theme("light"); await h.setSize(1000, 720); });
  await host.evaluate(h => {
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.baseContext(), platform: "darwin", microphone: { enabled: true },
      camera: { enabled: true, available: true, access: "granted", devices: [{ id: "facetime", name: "FaceTime HD Camera", default: true }] } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-studio").click();
  const toolbar = page.locator(".studio-toolbar");
  const layout = () => page.evaluate(() => {
    const bar = document.querySelector(".studio-toolbar")!, edge = bar.getBoundingClientRect();
    const studio = document.querySelector(".studio")!.getBoundingClientRect(), stage = document.querySelector(".studio-stage")!.getBoundingClientRect();
    const inFlow = (selector: string): DOMRect[] => [...document.querySelectorAll(selector)]
      .filter((control) => !["absolute", "fixed"].includes(getComputedStyle(control).position))
      .map((control) => control.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
    const apart = (a: DOMRect, b: DOMRect): boolean =>
      a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
    const overlaps = (boxes: DOMRect[]): number => boxes.reduce((count, box, i) => count + boxes.slice(i + 1).filter((other) => !apart(box, other)).length, 0);
    // Record and its phase's place, and the view's controls.
    const controls = inFlow(".studio-record > *, .studio-head > *");
    const sources = inFlow(".studio-sources-grid > *");
    const live = inFlow(".studio-live-controls > *");
    const liveParts = inFlow(".studio-live-controls button, .studio-live-controls [role='switch'], .studio-live-controls [role='slider'], .studio-live-controls .slider-setting-value, .studio-live-controls .studio-channel-head, .studio-live-controls .studio-switch-note");
    const cut = (element: Element): boolean => element.scrollWidth > element.clientWidth + 0.5 || element.scrollHeight > element.clientHeight + 0.5;
    return { controls: controls.length, outside: controls.filter((box) => box.left < edge.left - 0.5 || box.right > edge.right + 0.5).length,
      overlaps: overlaps(controls),
      recordAcross: bar.querySelector(".studio-record-slot > button")!.getBoundingClientRect().width >= edge.width - 0.5,
      viewNamed: (() => { const name = bar.querySelector(".studio-view-name"); return name !== null && name.getBoundingClientRect().width > 0 && !cut(name); })(),
      sources: sources.length, sourcesOverlap: overlaps(sources),
      sourcesOutside: sources.filter((box) => box.left < studio.left - 0.5 || box.right > studio.right + 0.5).length,
      sourcesUnderStage: sources.every((box) => box.top >= stage.bottom - 0.5),
      liveOverlap: overlaps(live),
      liveOutside: liveParts.filter((box) => box.left < studio.left - 0.5 || box.right > studio.right + 0.5).length,
      // A source's name is never cut short; what it is set to may be, said whole in its name and its tooltip.
      namesCut: [...document.querySelectorAll(".studio-sources-grid .studio-source-label")].filter(cut).length };
  });
  const fits = { outside: 0, overlaps: 0, recordAcross: false, viewNamed: true, sources: 5, sourcesOverlap: 0, sourcesOutside: 0, sourcesUnderStage: true, liveOverlap: 0, liveOutside: 0, namesCut: 0 };
  const sweep = async (label: string): Promise<void> => {
    for (const width of [380, 440, 520, 549, 620, 760, 1000, 1240]) {
      await host.evaluate((h, width) => h.setSize(width, 720), width);
      await expect.poll(layout, { message: `S153 ${label} at ${width} px` }).toMatchObject(fits);
      expect((await layout()).controls, `S153 ${label} at ${width} px: every toolbar control laid out`).toBeGreaterThanOrEqual(5);
      await expect(page.locator("#setting-studioControls-start"), `S153 ${label} at ${width} px: Record`).toBeVisible();
    }
  };
  // Ready, counting down, recording for a minute and for an hour, saving: the same arrangement, nothing moved.
  const places = () => page.evaluate(() => JSON.stringify([document.querySelector(".studio-toolbar")!.getAttribute("data-density"),
    ...[...document.querySelectorAll(".studio-record-slot > button, .studio-head > *, .studio-sources-grid > *")]
      .filter((control) => !["absolute", "fixed"].includes(getComputedStyle(control).position))
      .map((control) => { const box = control.getBoundingClientRect(); return [box.x, box.y, box.width, box.height].map(Math.round); })]));
  const phases = async (label: string): Promise<void> => {
    for (const width of [380, 549, 760, 1000]) {
      await host.evaluate((h, width) => h.setSize(width, 720), width);
      await host.evaluate(h => h.push(h.settingsView({ type: "idle" }, h.state.cameraContext!)));
      await expect.poll(layout, { message: `S153 ${label} at ${width} px, ready` }).toMatchObject(fits);
      const ready = await places();
      for (const state of [{ type: "countdown", remaining: 10 }, { type: "recording", startedAt: new Date(Date.now() - 61_000).toISOString() },
        { type: "recording", startedAt: new Date(Date.now() - 3_600_000).toISOString() }, { type: "stopping" }] as const) {
        await host.evaluate((h, state) => h.push(h.settingsView(state, h.state.cameraContext!)), state);
        await expect(page.locator(".studio-choices"), `S153 ${label} ${state.type}`).toHaveAttribute("data-phase", state.type === "stopping" ? "saving" : state.type);
        await expect.poll(places, { message: `S153 ${label} at ${width} px: nothing moves while ${state.type}` }).toBe(ready);
        await expect.poll(layout, { message: `S153 ${label} at ${width} px, ${state.type}` }).toMatchObject(fits);
        if (state.type === "recording") {
          // Locked while recording, still in sight with a lock; the microphone's input can still be chosen (plan 079, D3).
          for (const id of ["studioType", "studioScreen", "studioCameraDevice", "studioSystemAudio"]) {
            await expect(page.locator(`#setting-${id}`), `S153 ${label} ${id} locked`).toBeDisabled();
            await expect(page.locator(`#setting-${id} .studio-picker-lock`), `S153 ${label} ${id} its lock`).toBeVisible();
          }
          await expect(page.locator("#setting-studioMicrophoneDevice"), `S153 ${label} the microphone's picker`).toBeEnabled();
        }
      }
      await host.evaluate(h => h.push(h.settingsView({ type: "idle" }, h.state.cameraContext!)));
    }
  };
  // The sources under the preview (2026-10-31): one short control each, the type chosen and each input named with its
  // state in sight, the whole of it in its accessible name; their heading said to assistive technology alone.
  const sources = page.getByRole("region", { name: "Recording sources" });
  await expect(sources, "S153 the sources' region, named by its heading").toBeVisible();
  await expect(sources.locator(".studio-source-label"), "S153 each source named").toHaveText(["Plain recording", "Screen", "Camera", "System audio", "Microphone"]);
  await expect(sources.locator(".studio-source-state > [data-shown]"), "S153 each input's state in sight").toHaveText(["On", "On", "On", "On"]);
  await expect(sources.getByRole("combobox", { name: "Recording type" }), "S153 the type's menu").toHaveCount(1);
  await expect(sources.locator("#setting-studioScreen"), "S153 the device's whole name in its accessible name").toHaveAccessibleName(/^Screen: .+/);
  // Reached in order by keyboard, each opening its menu.
  await sources.getByRole("combobox", { name: "Recording type" }).focus();
  for (const id of ["studioScreen", "studioCameraDevice", "studioSystemAudio", "studioMicrophoneDevice"]) {
    await page.keyboard.press("Tab");
    await expect(page.locator(`#setting-${id}`), `S153 ${id} reached by Tab`).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(page.locator(".studio-picker-menu"), "S153 its menu opened by keyboard").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".studio-picker-menu"), "S153 and closed").toHaveCount(0);
  // The view in words, its name and accessible name the same, what it shows its value and in its menu.
  const view = page.locator(".studio-head").getByRole("combobox", { name: "Preview view" });
  await host.evaluate(h => h.setSize(549, 720));
  await expect(view.locator(".studio-view-name"), "S153 the view named in words at 549 px").toHaveText("Preview view");
  await expect(view, "S153 what it shows said as its value").toContainText("As recorded");
  await sweep("English");
  await phases("English");
  // The same content at the same width must settle to the same arrangement after a long state label goes away.
  await host.evaluate(h => h.setSize(1000, 720));
  await expect.poll(layout).toMatchObject(fits);
  const originalDensity = await toolbar.getAttribute("data-density");
  await host.evaluate(h => {
    const view = h.settingsView({ type: "idle" }, h.state.cameraContext!);
    const controls = view.groups.find((group: { id: string }) => group.id === "studioControls")!;
    controls.choices[0]!.label = "Preparing a recording with a much longer status message than any real one";
    h.push(view);
  });
  await expect.poll(() => toolbar.getAttribute("data-density")).not.toBe(originalDensity);
  await expect.poll(layout).toMatchObject(fits);
  await host.evaluate(h => h.push(h.settingsView({ type: "idle" }, h.state.cameraContext!)));
  await expect.poll(() => toolbar.getAttribute("data-density"), { message: "S153 restored content unfolds without resizing" }).toBe(originalDensity);
  for (const [factor, width] of [[1.5, 549], [2, 760], [2, 380]] as const) {
    await host.evaluate(async (h, [factor, width]) => { await h.setSize(width, 720); await h.setZoom(factor); }, [factor, width] as const);
    // Zoomed into the narrowest window Record may take the toolbar's width, its words wrapping.
    await expect.poll(layout, { message: `S153 at ${width} px zoomed ${factor * 100}%` }).toMatchObject({ ...fits, recordAcross: expect.any(Boolean) });
    await host.evaluate(h => h.setZoom(1));
  }
  await page.locator("#tab-general").click();
  await page.locator("#setting-language-zh-TW").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  // The language's answer is the plain fixture; the Studio's view again, now in Traditional Chinese.
  await host.evaluate(h => h.push(h.settingsView({ type: "idle" }, { ...h.state.cameraContext!, language: "zh-TW" })));
  await page.locator("#tab-studio").click();
  await expect(page.locator("#setting-studioControls-start"), "S153 the Studio in Traditional Chinese").toHaveText("開始錄影");
  await expect(page.getByRole("region", { name: "錄製來源" }), "S153 the sources' heading in Traditional Chinese").toBeVisible();
  await expect(page.locator(".studio-view-name"), "S153 the view named in Traditional Chinese").toHaveText("預覽畫面");
  await sweep("Traditional Chinese");
  await phases("Traditional Chinese");
  await page.locator("#tab-general").click();
  await commitEnglish();
  await host.evaluate(async h => { h.state.cameraState = undefined; await h.setSize(560, 680); });
});

test("S039–S041 the status card: no Start when ready; Change output folder… and Relaunch ask main for the card's own action", { tag: "@recording-settings" }, async () => {
  await host.evaluate(async h => { h.theme("light"); await h.setSize(h.SNAPSHOT_SIZES.default[0], h.SNAPSHOT_SIZES.default[1]); h.pushModel({ type: "idle" }); });
  await expect.poll(() => read(page, `document.getElementById("status-action").hidden`), { message: "S039 status card: a ready card offers no Start button" }).toBe(true);
  await host.evaluate(h => h.pushModel({ type: "idle", outputDirUnavailable: true }));
  await expect(page.locator("#status-action")).toHaveText("Change output folder…");
  await clearCalls();
  await clickAt(page, "#status-action", { scroll: false });
  await expect.poll(calls, { message: "S040 status card: a click on Change output folder… asks main for status/folder" }).toEqual([["status", "folder"]]);
  // A missing permission: Open System Settings is the primary action, followed by the optional Relaunch link.
  for (const [lang, scheme, size] of [["en", "light", "default"], ["en", "dark", "narrow"], ["zh-TW", "light", "minimum"]] as const) {
    await host.evaluate(async (h, args) => { h.theme(args.scheme); await h.setSize(...h.SNAPSHOT_SIZES[args.size]); h.pushModel({ type: "needsPermission", needsRelaunch: false }, { language: args.lang }); }, { lang, scheme, size });
    await page.waitForTimeout(150);
    await keep(`status-permission-${lang}-${scheme}-${size}.png`);
  }
  await host.evaluate(async h => { h.theme("light"); await h.setSize(h.SNAPSHOT_SIZES.default[0], h.SNAPSHOT_SIZES.default[1]); });
  await host.evaluate(h => h.pushModel({ type: "needsPermission", needsRelaunch: false }));
  await expect(page.locator("#status-secondary")).toBeVisible();
  await expect(page.locator("#status-secondary")).toHaveText("Already allowed? Relaunch");
  await expect(page.locator("#status-action")).toHaveText("Open Settings");
  await clearCalls();
  await page.locator("#status-secondary").click();
  await expect.poll(calls, { message: "S041 status card: a missing permission offers Open System Settings and Relaunch; a click on the link asks main for status/relaunch" })
    .toEqual([["status", "relaunch"]]);
});

for (const [lang, size] of [["en", "minimum"], ["zh-TW", "default"]] as const) {
  test(`S042–S043 ${lang}/${size}: the ⓘ explanation by hover (kept through the gap and on itself) and by Tab, closed by Escape with the window open`, { tag: "@layout" }, async () => {
    await host.evaluate(async (h, args) => { await h.setSize(...h.SNAPSHOT_SIZES[args.size]); h.pushModel({ type: "idle" }, { language: args.lang }); }, { lang, size });
    await page.locator("#tab-recording").click();
    const infoState = (id: string) => read<{ open: boolean; expanded: string | null; text: string; inside: boolean; describes: boolean }>(page, `(() => {
      const id = ${JSON.stringify(`setting-${id}`)}, popover = document.getElementById(id + "-info-popup"), r = popover?.getBoundingClientRect();
      const control = document.querySelector("#" + id + "-row [role=switch], #" + id + "-row [role=combobox], #" + id + "-row button[aria-pressed]");
      return { open: Boolean(popover?.hasAttribute("data-open")), expanded: document.getElementById(id + "-info-button").getAttribute("aria-expanded"), text: document.getElementById(id + "-info").textContent,
        inside: Boolean(r && r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight),
        describes: (control?.getAttribute("aria-describedby") ?? "").split(" ").includes(id + "-info") }; })()`);
    const at = await centre(page, "#setting-editableRecording-info-button");
    await page.mouse.move(at.x, at.y);
    await until(page, `document.getElementById("setting-editableRecording-info-popup")?.hasAttribute("data-open")`);
    // Measured once the explanation's opening transition has finished, as the former fixture's pause allowed.
    await until(page, `document.getElementById("setting-editableRecording-info-popup").getAnimations({ subtree: true }).every(a => a.playState !== "running")`);
    const hovered = await infoState("editableRecording");
    await keep(`info-hover-${lang}-light-${size}.png`);
    // A point between the button and its explanation, wherever the design places it.
    const geometry = await read<{ gap: { x: number; y: number }; onto: { x: number; y: number } }>(page, `(() => {
      const b = document.getElementById("setting-editableRecording-info-button").getBoundingClientRect(), r = document.getElementById("setting-editableRecording-info-popup").getBoundingClientRect();
      const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
      const gap = r.bottom <= b.top ? { x, y: Math.floor((r.bottom + b.top) / 2) } : r.top >= b.bottom ? { x, y: Math.ceil((b.bottom + r.top) / 2) }
        : r.right <= b.left ? { x: Math.floor((r.right + b.left) / 2), y } : r.left >= b.right ? { x: Math.ceil((b.right + r.left) / 2), y } : { x, y };
      return { gap, onto: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }; })()`);
    await page.mouse.move(geometry.gap.x, geometry.gap.y); await page.waitForTimeout(300);
    const inGap = await infoState("editableRecording");
    await page.mouse.move(geometry.onto.x, geometry.onto.y); await page.waitForTimeout(300);
    const kept = await infoState("editableRecording");
    await page.mouse.move(4, 4);
    await until(page, `!document.getElementById("setting-editableRecording-info-popup")?.hasAttribute("data-open")`);
    const left = await infoState("editableRecording");
    expect.soft({ open: hovered.open, expanded: hovered.expanded, inside: hovered.inside, describes: hovered.describes, text: hovered.text,
      inGap: inGap.open, kept: kept.open, left: left.open, leftExpanded: left.expanded },
    `S042 ${lang}/${size}: hovering the ⓘ shows its explanation inside the window, it stays through a pause in the gap and while the pointer is on it, and leaving both hides it`)
      .toEqual({ open: true, expanded: "true", inside: true, describes: true, text: lang === "en" ? "Keeps the screen, the camera and each sound apart, so Edit… can place the camera and set the volumes after recording. Files are about twice as large, and other apps opening the file itself show only the screen with system audio; Share… gives the finished video."
          : "把螢幕、相機與各個聲音分開保存，錄完後可在「編輯…」中擺放相機、調整音量。檔案約大一倍；其他 App 直接開啟檔案時只會顯示螢幕與系統聲音，用「分享…」才會給出完成的影片。",
        inGap: true, kept: true, left: false, leftExpanded: "false" });
    await page.locator("#setting-videoQuality button[aria-pressed=true]").focus();
    await page.keyboard.press("Tab");
    await until(page, `document.getElementById("setting-resolutionCap-info-popup")?.hasAttribute("data-open")`);
    const tabbed = { active: await read<string>(page, "document.activeElement.id"), ...await infoState("resolutionCap") };
    await keep(`info-focus-${lang}-light-${size}.png`);
    // An Escape with no explanation open would close the window: only one that opened is answered.
    if (tabbed.open) await page.keyboard.press("Escape");
    await until(page, `!document.getElementById("setting-resolutionCap-info-popup")?.hasAttribute("data-open")`);
    const escaped = await infoState("resolutionCap");
    expect.soft({ active: tabbed.active, open: tabbed.open, inside: tabbed.inside, windowOpen: !page.isClosed(), escaped: escaped.open },
      `S043 ${lang}/${size}: a Tab reaches the next ⓘ and shows its explanation; Escape closes it and leaves the window open`)
      .toEqual({ active: "setting-resolutionCap-info-button", open: true, inside: true, windowOpen: true, escaped: false });
  });
}

test("S044–S048 update checks: repeated states keep nodes and geometry; Tab and Enter start one check and keep focus through it", { tag: "@general" }, async () => {
  await host.evaluate(async h => { await h.setSize(560, 680); h.pushModel({ type: "idle" }, { updates: { enabled: true, state: { kind: "current", checkedAt: 1000 } } }); });
  await page.locator("#tab-general").click();
  await read(page, `window.updateBefore = { row: document.getElementById("setting-updates-row"), button: document.getElementById("setting-updates-check"), note: document.getElementById("setting-updates-note"), below: document.getElementById("setting-language-row").getBoundingClientRect().top };`);
  for (const [id, updateState] of [["S044", { kind: "checking", previous: { kind: "current", checkedAt: 1000 } }], ["S045", { kind: "current", checkedAt: 2000 }]] as const) {
    await drawn(page, () => host.evaluate((h, value) => h.pushModel({ type: "idle" }, { updates: { enabled: true, state: value } }), updateState));
    expect.soft(await read<boolean>(page, `updateBefore.row === document.getElementById("setting-updates-row") && updateBefore.button === document.getElementById("setting-updates-check") && updateBefore.note === document.getElementById("setting-updates-note") && !updateBefore.note.hidden && updateBefore.below === document.getElementById("setting-language-row").getBoundingClientRect().top`),
      `${id} repeated update ${updateState.kind} preserves nodes and lower-row geometry`).toBe(true);
  }
  await drawn(page, () => host.evaluate(h => { h.state.updateContext = { ...h.baseContext(), updates: { enabled: true, state: { kind: "current", checkedAt: 1000 } } }; h.push(h.settingsView({ type: "idle" }, h.state.updateContext)); }));
  await clearCalls();
  await read(page, `document.getElementById("setting-updates-check").scrollIntoView({ block: "center" }); document.getElementById("setting-updateChecks").focus()`);
  await page.keyboard.press("Tab");
  const tabbed = await read<string>(page, "document.activeElement.id");
  await page.keyboard.press("Enter");
  await expect(page.locator("#setting-updates-check")).toHaveText("Checking for updates…");
  // The indicator may transition in; wait for it instead of sampling at a fixed moment.
  await expect.poll(() => focusShown("#setting-updates-check"), { message: "S047 the busy button keeps a visible keyboard focus indicator" }).toBe(true);
  const busy = await read<{ active: string; disabled: boolean; ariaDisabled: string | null }>(page, `(() => { const el = document.getElementById("setting-updates-check");
    return { active: document.activeElement.id, disabled: el.disabled, ariaDisabled: el.getAttribute("aria-disabled") }; })()`);
  await keep("update-check-busy.png");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  expect.soft({ tabbed, calls: await calls() }, "S046 Tab reaches Check for updates… and Enter starts one check").toEqual({ tabbed: "setting-updates-check", calls: [["updates", "check"]] });
  expect.soft(busy, "S047 a running check keeps keyboard focus on the busy, focusable button").toEqual({ active: "setting-updates-check", disabled: false, ariaDisabled: "true" });
  await host.evaluate(h => { h.state.updateContext = { ...h.state.updateContext, updates: { enabled: true, state: { kind: "current", checkedAt: 2000 } } }; h.push(h.settingsView({ type: "idle" }, h.state.updateContext)); });
  await expect(page.locator("#setting-updates-check")).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("Tab");
  const next = await read<string>(page, "document.activeElement.id");
  await keep("update-check-done.png");
  expect.soft(next !== "" && !next.startsWith("tab-") && next !== "setting-updates-check", `S048 after the check, the next Tab continues past the button instead of restarting at the tabs (${next})`).toBe(true);
});

test("S050 a Tab-focused control in an overflowing panel is scrolled into view and uncovered", { tag: "@layout" }, async () => {
  await drawn(page, () => host.evaluate(async h => { h.pushModel({ type: "idle" }); await h.setSize(380, 360); }));
  await read(page, `document.getElementById("settings-panel").scrollTop = 0`);
  expect(await read<boolean>(page, `(p => p.scrollHeight > p.clientHeight)(document.getElementById("settings-panel"))`), "the content overflows the panel at this size").toBe(true);
  await page.locator('[role="tab"][aria-selected="true"]').first().focus();
  const covered: string[] = [];
  let scrolled = 0;
  for (let step = 0; step < 24; step += 1) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(60);
    const focus = await read<{ id: string; covered: boolean; scrollTop: number; seen: string }>(page, `(() => {
      const active = document.activeElement, panel = document.getElementById("settings-panel");
      const box = active.getBoundingClientRect(), view = panel.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const name = el => el ? (el.id ? "#" + el.id : el.tagName.toLowerCase()) + (el.getAttribute("data-slot") ? "[" + el.getAttribute("data-slot") + "]" : "") +
        (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "") : "nothing";
      // What a failure says: the element at the control's centre, and where the control sat against the panel.
      const seen = name(hit) + " in " + name(hit && hit.parentElement) + "; control " + Math.round(box.top) + "–" + Math.round(box.bottom) +
        ", panel " + Math.round(view.top) + "–" + Math.round(view.bottom);
      return { id: active.id || active.tagName, scrollTop: panel.scrollTop, seen,
        covered: panel.contains(active) && (box.top < view.top - 1 || box.bottom > view.bottom + 1 || !hit || !(active.contains(hit) || hit.contains(active))) }; })()`);
    if (focus.covered) covered.push(`${focus.id} (covered by ${focus.seen})`);
    scrolled = Math.max(scrolled, focus.scrollTop);
  }
  expect.soft({ scrolled: scrolled > 0, covered }, "S050 a Tab never leaves the focused control out of view or under something else").toEqual({ scrolled: true, covered: [] });
});

test("S053–S057 General's footer and the log link: wide and narrow windows, a failed link's Retry keeps focus in its row", { tag: "@general" }, async () => {
  await host.evaluate(async h => { await h.setSize(720, 900); h.state.captureView = h.settingsView({ type: "idle" }, h.baseContext()); h.push(h.state.captureView); });
  await page.locator("#tab-general").click();
  await page.waitForTimeout(100);
  // The credit and the named website/source links are shown and do not overlap, whatever their arrangement.
  const footer = `(() => { const credit = [...document.querySelectorAll("#setting-about-row *")].find(el => el.childElementCount === 0 && el.textContent.includes("Eric Tsai")), c = credit.getBoundingClientRect();
    const links = ["setting-about-website", "setting-about-source"].map(id => document.getElementById(id));
    const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
    return { credit: credit.checkVisibility() && c.height > 0, links: links.map(b => Boolean(b?.checkVisibility() && b.getAttribute("aria-label"))),
      apart: links.every(b => b && apart(c, b.getBoundingClientRect())),
      // Hide interface itself, or the collapsed sidebar's (a narrow window's) window-actions menu that holds it.
      hide: [...document.querySelectorAll("button[aria-label]")].some(b => ["Hide interface", "RecordStuff window actions"].includes(b.getAttribute("aria-label")) && b.checkVisibility()) }; })()`;
  expect.soft(await read(page, footer), "S053 General's footer shows the credit and named website/source links without overlap; Hide interface stays reachable")
    .toEqual({ credit: true, links: [true, true], apart: true, hide: true });
  await host.evaluate(h => h.setSize(560, 760));
  await until(page, `(f => f.credit && f.links.every(Boolean) && f.apart && f.hide)(${footer})`);
  expect.soft(await read(page, footer), "S054 a narrow window keeps the credit and named links without overlap, and Hide interface reachable")
    .toEqual({ credit: true, links: [true, true], apart: true, hide: true });
  await expect(page.locator("#setting-log-show")).toBeHidden();
  await page.locator("#tab-failures").click();
  await page.locator("#troubleshooting-tools-tab").click();
  await expect.soft(page.locator("#setting-log-show"), "S055 the log file link is named Log file").toHaveAccessibleName("Log file");
  await expect.soft(page.locator("#setting-log-show"), "S055 …and usable").toBeEnabled();
  await page.locator("#tab-general").click();
  await page.locator("#setting-about-website").click();
  await expect.poll(() => read(page, `(() => { const retry = document.getElementById("setting-about-retry"); return retry.checkVisibility() && retry.textContent.trim() !== "" && retry.scrollWidth <= retry.clientWidth; })()`),
    { message: "S056 a failed footer link offers a Retry whose text is not cut off" }).toBe(true);
  await page.locator("#setting-about-retry").focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  const retry = await read<{ active: string; retryShown: boolean }>(page, `({ active: document.activeElement.id, retryShown: !document.getElementById("setting-about-retry").hidden })`);
  expect.soft(retry.retryShown && retry.active.startsWith("setting-about-"), `S057 a key on a failed link's Retry keeps focus in its row, not on the page ${JSON.stringify(retry)}`).toBe(true);
});

for (const language of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`Troubleshooting sections, always-visible cleanup warning and General footer: ${language}/${scheme}, mouse and keyboard`, { tag: "@general" }, async () => {
    await host.evaluate(async (h, args) => {
      h.theme(args.scheme);
      await h.setSize(720, 900);
      h.state.captureView = h.settingsView({ type: "idle" }, { ...h.baseContext(), language: args.language });
      h.push(h.state.captureView);
    }, { language, scheme });
    await page.locator("#tab-general").click();
    await expect(page.locator("#setting-log-show")).toBeHidden();
    await expect(page.locator("#setting-about-label")).toHaveText("RecordStuff");
    await expect(page.locator("#setting-about-note")).toBeVisible();
    await keep(`general-${language}-${scheme}.png`);
    await page.locator("#tab-failures").click();
    const historyTab = page.locator("#troubleshooting-history-tab"), toolsTab = page.locator("#troubleshooting-tools-tab");
    await expect(historyTab).toHaveText(language === "en" ? "Failure history" : "失敗紀錄");
    await expect(toolsTab).toHaveText(language === "en" ? "Diagnostics and cleanup" : "診斷與清理");
    expect(await read<boolean>(page, `['troubleshooting-history-tab', 'troubleshooting-tools-tab'].every(id => { const el = document.getElementById(id); return el.scrollWidth <= el.clientWidth; })`), "content tab labels are not cut off at the default width").toBe(true);
    await expect(historyTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#recording-results")).toBeVisible();
    await expect(page.locator("#setting-log-show")).toBeHidden();
    await keep(`troubleshooting-${language}-${scheme}-history.png`);
    await historyTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(toolsTab).toBeFocused();
    await expect(toolsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#recording-results")).toBeHidden();
    await expect(page.locator("#tab-failures")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(historyTab).toBeFocused();
    await expect(page.locator("#recording-results")).toBeVisible();
    await toolsTab.click();
    const cleanup = page.locator("#settings-data-cleanup");
    await expect(cleanup).toHaveAccessibleName(language === "en" ? "Reset and cleanup" : "重設與清理");
    await expect(page.locator("#settings-data-cleanup-warning")).toHaveText(language === "en"
      ? "This cannot be undone, and RecordStuff will quit."
      : "此動作無法復原，完成後 App 會結束。");
    await expect(page.locator("#setting-localData-label")).toHaveText(language === "en" ? "Clear local app data" : "清除本機 App 資料");
    await expect(page.locator("#settings-data-cleanup-warning")).toBeVisible();
    await expect(page.locator("#setting-localData-clear")).toHaveAccessibleDescription(/cannot be undone|無法復原/);
    await expect(page.locator("#recording-results-heading")).toHaveText(language === "en" ? "Recording failures" : "失敗紀錄");
    await expect(page.locator("#setting-log-section-heading")).toHaveText(language === "en" ? "Diagnostic tools" : "診斷工具");
    const logLink = page.locator("#setting-log-show");
    await expect(logLink).toHaveText(language === "en" ? "Log file" : "記錄檔（log）");
    await expect(page.locator("#setting-localData-clear")).toBeVisible();
    await logLink.click();
    await expect.poll(calls).toContainEqual(["log", "show"]);
    await expect(page.locator("#tab-failures")).toHaveAttribute("aria-selected", "true");
    await keep(`troubleshooting-${language}-${scheme}-cleanup.png`);
    await historyTab.click();
    await expect(page.locator("#setting-localData-clear")).toBeHidden();
    await toolsTab.click();
    await expect(page.locator("#setting-localData-clear")).toBeVisible();
    await logLink.focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#setting-localData-clear")).toBeFocused();
    // Model updates keep the cleanup action visible and retain keyboard focus.
    await host.evaluate(h => h.push(h.state.captureView));
    await expect(page.locator("#setting-localData-clear")).toBeVisible();
    await expect(page.locator("#setting-localData-clear")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(logLink).toBeFocused();
    await clearCalls();
    await page.keyboard.press("Enter");
    await expect.poll(calls).toContainEqual(["log", "show"]);
    await host.evaluate(h => h.setSize(360, 480));
    await page.locator("#setting-localData-row").scrollIntoViewIfNeeded();
    await keep(`troubleshooting-${language}-${scheme}-minimum.png`);
    expect(await read<boolean>(page, `document.getElementById("settings-panel").scrollWidth <= document.getElementById("settings-panel").clientWidth`)).toBe(true);
  });
}

test("S058–S066 the shortcut editor by keyboard: Tab and Shift+Tab leave capture, focus rings, listening indicator, Control+F12, Confirm, forced colors and reduced motion", { tag: "@shortcut" }, async () => {
  await host.evaluate(async h => { await h.setSize(560, 760); h.state.captureView = h.settingsView({ type: "idle" }, h.baseContext()); h.push(h.state.captureView); });
  await page.locator("#tab-general").click();
  const arm = (): Promise<unknown> => pickMenu(page, "setting-hotkey", "custom");
  // Armed once main has answered: the page then focuses the listening editor.
  const capturing = `document.activeElement?.id === "shortcut-capture"`;
  await arm();
  await until(page, capturing);
  await page.keyboard.press("Tab");
  const exit = await read<string>(page, "document.activeElement.id");
  await page.keyboard.press("Tab");
  const next = await read<string>(page, "document.activeElement.id");
  expect.soft({ exit, next }, "S058 Tab exits capture to the next visible preference, its ⓘ and then its switch").toEqual({ exit: "setting-notifications-info-button", next: "setting-notifications" });
  await arm();
  await until(page, capturing);
  await page.keyboard.press("Shift+Tab");
  const back = await read<string>(page, "document.activeElement.id");
  await expect.poll(() => focusShown("#setting-hotkey"), { message: "S059 keyboard navigation retains a visible focus indicator" }).toBe(true);
  await read(page, `document.getElementById("setting-hotkey").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  expect.soft(await read<boolean>(page, `document.activeElement === document.getElementById("setting-hotkey")`) && back === "setting-hotkey",
    "S060 pointer bookkeeping preserves DOM focus").toBe(true);
  await arm();
  await until(page, capturing);
  await expect.soft(page.locator("#shortcut-capture"), "S061 acknowledged capture shows the listening editor").toBeVisible();
  await page.keyboard.press("Control+F12");
  await expect.soft(page.locator("#shortcut-capture"), "S062 Control+F12 is shown as ⌃ with the named key F12").toHaveText(/⌃\s*F12/);
  await keep("shortcut-f12.png");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(100);
  expect.soft(await read(page, `({ active: document.activeElement.id, open: document.getElementById("shortcut-capture").checkVisibility(), enabled: !document.getElementById("shortcut-confirm").disabled })`),
    "S063 Tab with a candidate reaches Confirm and keeps the editor open").toEqual({ active: "shortcut-confirm", open: true, enabled: true });
  await page.locator("#shortcut-cancel").click();
  expect.soft(back, "S064 Shift+Tab exits capture to its preceding edit action").toBe("setting-hotkey");
  await host.evaluate(h => h.setSize(560, 680));
  await page.emulateMedia({ forcedColors: "active" });
  await until(page, `matchMedia("(forced-colors: active)").matches`);
  // Whatever the style, under forced colors the switch keeps an edge and the selected segment differs from the others.
  expect.soft(await read<boolean>(page, `(() => {
    const edge = s => (s.borderTopStyle !== "none" && parseFloat(s.borderTopWidth) > 0) || (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0);
    const look = el => (s => [s.borderTopStyle, s.borderTopWidth, s.borderTopColor, s.outlineStyle, s.outlineWidth, s.outlineColor, s.backgroundColor, s.color].join())(getComputedStyle(el));
    const selected = document.querySelector("#setting-language button[aria-pressed=true]"), other = document.querySelector("#setting-language button[aria-pressed=false]");
    return matchMedia("(forced-colors: active)").matches && edge(getComputedStyle(document.getElementById("setting-notifications"))) && look(selected) !== look(other); })()`),
    "S065 forced colors distinguish the switch and the selected segment").toBe(true);
  await keep("panel-forced-colors.png");
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
  await arm();
  await until(page, capturing);
  expect.soft(await read<number>(page, `document.getElementById("shortcut-capture").getAnimations({ subtree: true }).filter(a => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity).length`),
    "S066 reduced motion stops the listening animation").toBe(0);
  await page.locator("#shortcut-cancel").click();
  await page.emulateMedia({ reducedMotion: null });
  await keep("panel.png");
});

for (const platform of ["darwin", "win32"] as const) {
  test(`S116 ${platform}: the top of a narrow window is clickable: nothing, the window-drag strip included, covers a tab`, { tag: "@layout" }, async () => {
    // Plan 066 found the strip over the tabs on Windows CI; the page lays out by the platform its view names.
    await host.evaluate(async (h, value) => { await h.setSize(560, 680); h.pushModel({ type: "idle" }, { platform: value }); }, platform);
    await expect(page.locator("html")).toHaveAttribute("data-platform", platform);
    const covered = await read<string[]>(page, `[...document.querySelectorAll('[role="tab"]')].filter(tab => { const r = tab.getBoundingClientRect();
      return r.width > 0 && !tab.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }).map(tab => tab.id)`);
    expect.soft(covered, `S116 ${platform}: no tab is covered at its centre`).toEqual([]);
    await page.getByRole("tab", { name: "General" }).click({ timeout: 3000 });
    await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  });
}

test("S148 the first-launch guide: the screen's step, then Allow asks for each input, a refusal turns it off, Escape sets it aside, and General opens it again (2026-10-26)", { tag: "@general" }, async () => {
  await host.evaluate(async h => {
    h.theme("light"); await h.setSize(h.SNAPSHOT_SIZES.default[0], h.SNAPSHOT_SIZES.default[1]);
    h.state.onboardingState = { type: "needsPermission", needsRelaunch: false };
    h.state.onboardingAllows = true;
    h.state.onboardingContext = { ...h.baseContext(), onboarding: { open: true }, microphone: { enabled: true, access: "not-determined" },
      camera: { enabled: true, available: true, access: "not-determined", layout: { width: 0.2, height: 0.3, rounding: 0.15, mirror: false, positions: [] } } };
    h.push(h.settingsView(h.state.onboardingState, h.state.onboardingContext));
  });
  const guide = page.getByRole("dialog", { name: "Welcome to RecordStuff" });
  await expect(guide, "S148 the guide opens over the window").toBeVisible();
  await expect(page.locator("#onboarding-done"), "S148 nothing to finish before the screen is allowed").toHaveCount(0);
  await expect(page.locator("#onboarding-microphone-allow"), "S148 the inputs wait for the screen").toBeDisabled();
  await expect(page.getByRole("switch", { name: "Camera" }), "S148 their switches too").toBeDisabled();
  await clearCalls();
  await clickAt(page, "#onboarding-screen-open", { scroll: false });
  await expect.poll(calls, { message: "S148 the screen's step opens System Settings through main" }).toEqual([["onboarding", "screen:open"]]);
  // The screen allowed: its step reads Allowed, and the way to begin recording is said.
  await host.evaluate(h => { h.state.onboardingState = { type: "idle" }; h.push(h.settingsView(h.state.onboardingState, h.state.onboardingContext!)); });
  await expect(guide.getByText("Not allowed ones turn off when you finish."), "S148 said while an input is still to allow").toBeVisible();
  await clearCalls();
  await clickAt(page, "#onboarding-microphone-allow", { scroll: false });
  await expect.poll(calls, { message: "S148 Allow asks main, which asks macOS" }).toEqual([["onboarding", "microphone:allow"]]);
  await expect(page.locator("#onboarding-microphone-allow"), "S148 an allowed input offers no Allow").toHaveCount(0);
  await host.evaluate(h => { h.state.onboardingAllows = false; });
  await clearCalls();
  await clickAt(page, "#onboarding-camera-allow", { scroll: false });
  await expect.poll(calls).toEqual([["onboarding", "camera:allow"]]);
  await expect(page.getByRole("switch", { name: "Camera" }), "S148 a refused input is turned off").not.toBeChecked();
  await expect(page.locator("#onboarding-camera-settings"), "S148 and offers System Settings").toBeVisible();
  await expect(guide.getByText("Press ⇧⌘1 to start recording."), "S148 where recording begins, once nothing is left to allow").toBeVisible();
  await clearCalls();
  await page.getByRole("switch", { name: "Microphone" }).click();
  await expect.poll(calls, { message: "S148 a switch is the same setting as Recording settings'" }).toEqual([["onboarding", "microphone:off"]]);
  await expect(page.getByRole("switch", { name: "Microphone" })).not.toBeChecked();
  // A guide that could not be saved as done stays open and says so inside it (review pass 2).
  await host.evaluate(h => { h.state.onboardingFinishFails = true; });
  await page.locator("#onboarding-done").click();
  await expect(guide.getByRole("alert"), "S148 a failed Done is said in the guide").toHaveText("Could not apply this setting. Your current settings are shown.");
  await expect(guide, "S148 and the guide stays").toBeVisible();
  await host.evaluate(h => { h.state.onboardingFinishFails = false; });
  await clearCalls();
  await page.keyboard.press("Escape");
  await expect.poll(calls, { message: "S148 Escape sets the guide aside" }).toEqual([["onboarding", "finish"]]);
  await expect(guide, "S148 and it closes").toHaveCount(0);
  // General's way back: a request main answers by opening the guide.
  await host.evaluate(h => h.pushModel({ type: "idle" }));
  await page.locator("#tab-general").click();
  await clearCalls();
  await page.getByRole("button", { name: "Open setup guide…" }).click();
  await expect.poll(calls, { message: "S148 General opens the guide again" }).toEqual([["setupGuide", "open"]]);
  await host.evaluate(h => { h.state.onboardingContext = undefined; });
});
