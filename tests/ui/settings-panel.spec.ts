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
import { read, until, centre, clickAt, pickMenu } from "./helpers";

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
  expect.soft(rendered.bridge, "S004 the preload exposes only the settings, zoom, camera preview, level and Studio APIs").toEqual(["capture", "choose", "onChanged", "onHidden", "onLevels", "onZoomChanged", "read", "ready", "watchCameraPreview", "watchLevels", "watchStudio", "zoom"]);
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

test("S014–S015 two held saves and an older push: the pushed committed value shows with the lock kept, and the final completion unlocks", { tag: "@settings-bridge" }, async () => {
  await commitEnglish();
  await host.evaluate(h => { h.state.holdSaves = true; });
  await page.locator("#setting-language-zh-TW").click();
  await page.locator("#setting-language-en").click();
  await expect.poll(() => host.evaluate(h => h.pendingSaves())).toBe(2);
  await host.evaluate(h => { h.releaseSave(); h.push(h.fixtureView(h.state.language)); });
  const state = `({ value: document.querySelector("#setting-language button[aria-pressed=true]").id.replace("setting-language-", ""),
    locked: document.querySelector("#setting-hotkey").disabled, feedback: document.querySelector("#feedback").textContent,
    lang: document.documentElement.lang, hotkeyLabel: document.querySelector("label[for='setting-hotkey']").textContent })`;
  await expect.poll(() => read<{ value: string }>(page, state).then(value => value.value)).toBe("zh-TW");
  const pending = await read<{ value: string; locked: boolean; feedback: string }>(page, state);
  expect.soft([pending.value, pending.locked, pending.feedback], "S014 an older completion and push show the committed pushed value and retain the pending lock").toEqual(["zh-TW", true, ""]);
  await host.evaluate(h => h.releaseSave());
  await expect.poll(() => read<{ locked: boolean }>(page, state).then(value => value.locked)).toBe(false);
  const finished = await read<{ value: string; locked: boolean; lang: string; hotkeyLabel: string }>(page, state);
  expect([finished.value, finished.locked, finished.lang, finished.hotkeyLabel], "S015 the final completion unlocks controls and displays committed settings").toEqual(["en", false, "en", "Shortcut"]);
  await host.evaluate(h => { h.state.holdSaves = false; });
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
    await host.evaluate(h => h.push(h.fixtureView(h.state.language)));
    await page.waitForTimeout(100);
    const during = await read<Record<string, unknown>>(page, `({ sameSelect: beforeToggle.select === document.querySelector("#setting-notifications"),
      samePanel: beforeToggle.panel === document.querySelector("#settings-panel"), focused: document.activeElement === beforeToggle.select,
      scrollStable: window.scrollY === beforeToggle.scroll && document.querySelector("#setting-updates-row")?.getBoundingClientRect().top === beforeToggle.below,
      value: beforeToggle.select.getAttribute("aria-checked") === "true" ? "on" : "off",
      buttonLocked: beforeToggle.button.getAttribute("aria-disabled") === "true" && !beforeToggle.button.disabled })`);
    expect.soft(during, `S019 notification ${value}: pending save and push preserve controls, focus and scroll`).toEqual({ sameSelect: true, samePanel: true, focused: true,
      scrollStable: true, value: value === "on" ? "off" : "on", buttonLocked: true });
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

test("S037–S038 countdown sound: a click on the checked switch asks main for off; under countdown Off it is disabled, keeps its value and sends nothing", { tag: "@recording-settings" }, async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(560, 680); });
  await page.locator("#tab-recording").click();
  const soundSwitch = async (countdown: 0 | 3) => {
    await host.evaluate((h, value) => { h.state.soundContext = { ...h.baseContext(), countdown: value }; h.push(h.settingsView({ type: "idle" }, h.state.soundContext)); }, countdown);
    await page.waitForTimeout(80);
    await clearCalls();
    const before = await read<{ checked: boolean; disabled: boolean }>(page, `(() => { const el = document.getElementById("setting-countdownSound"); el.scrollIntoView({ block: "center" });
      return { checked: el.getAttribute("aria-checked") === "true", disabled: el.disabled }; })()`);
    await clickAt(page, "#setting-countdownSound");
    await page.waitForTimeout(150);
    return { ...before, calls: await calls(), after: await read<boolean>(page, `document.getElementById("setting-countdownSound").getAttribute("aria-checked") === "true"`) };
  };
  const enabled = await soundSwitch(3);
  expect.soft(enabled, "S037 countdown sound: a click on the checked switch asks main for off and shows the committed off").toEqual({ checked: true, disabled: false, calls: [["countdownSound", "off"]], after: false });
  const disabled = await soundSwitch(0);
  expect.soft(disabled, "S038 countdown sound: disabled while the countdown is Off, keeping its value, and a click sends nothing").toEqual({ checked: true, disabled: true, calls: [], after: true });
});

test("S117–S120 microphone: the switch asks main, the input device follows it, a session locks both, and a denial offers its pane (plan 074)", { tag: "@recording-settings" }, async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(560, 680); });
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

test("S121–S123 camera: the switch asks main, a session locks it, and a denial offers its pane (plan 075)", { tag: "@recording-settings" }, async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(560, 680); });
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

  await host.evaluate(h => h.pushModel({ type: "idle" }, { language: "zh-TW", camera: { enabled: true, available: true, access: "denied" } }));
  await expect(page.locator("#setting-camera-diagnostics"), "S123 zh-TW").toContainText("未允許取用相機");
  await expect(page.getByRole("button", { name: "開啟相機設定…" })).toBeVisible();
});

test("S124–S126 camera rows: a slider names its percent and commits once, a recording with the camera keeps the shape editable (plan 075, step 7)", { tag: "@recording-settings" }, async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(560, 680); });
  const devices = [{ id: "built-in", name: "FaceTime HD Camera", default: true }, { id: "iphone", name: "iPhone Camera", default: false }];
  await host.evaluate((h, list) => {
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.baseContext(), camera: { enabled: true, available: true, access: "granted", devices: list } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  }, devices);
  await page.locator("#tab-studio").click();
  const width = page.getByRole("slider", { name: "Width" });
  await width.scrollIntoViewIfNeeded();
  await expect(width, "S124 a slider is named by its row and reads as a percent").toHaveAttribute("aria-valuetext", "20%");
  await clearCalls();
  await width.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(calls, { message: "S124 a step commits the whole percent to main" }).toEqual([["cameraWidth", "21"]]);
  await expect(width, "S124 the committed value shows").toHaveAttribute("aria-valuetext", "21%");
  await host.evaluate(h => { h.state.holdSaves = true; });
  await clearCalls();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(calls, { message: "S124 a key held while saving goes on from the value let go of" }).toEqual([["cameraWidth", "22"], ["cameraWidth", "23"]]);
  await expect(width, "S124 and shows it while it saves").toHaveAttribute("aria-valuetext", "23%");
  await host.evaluate(h => { h.state.holdSaves = false; h.releaseSave(); h.releaseSave(); });
  await expect(width).toHaveAttribute("aria-valuetext", "23%");
  await clearCalls();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(calls).toEqual([["cameraWidth", "22"], ["cameraWidth", "21"]]);
  await expect(width).toHaveAttribute("aria-valuetext", "21%");

  await clearCalls();
  await page.locator("#setting-cameraRatio-16\\:9").click();
  await expect.poll(calls, { message: "S125 a shape asks main" }).toEqual([["cameraRatio", "16:9"]]);
  await expect(page.locator("#setting-cameraRatio-16\\:9"), "S125 and is the shape then").toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Height" })).toHaveAttribute("aria-valuetext", "12%");
  // Out to 4:3 and back to the saved 16:9 while the first still saves: the step back is sent too.
  await host.evaluate(h => { h.state.holdSaves = true; });
  await clearCalls();
  await page.locator("#setting-cameraRatio-4\\:3").click();
  await page.locator("#setting-cameraRatio-16\\:9").click();
  await expect.poll(calls, { message: "S125 a step back while saving is sent" }).toEqual([["cameraRatio", "4:3"], ["cameraRatio", "16:9"]]);
  await host.evaluate(h => { h.state.holdSaves = false; h.releaseSave(); h.releaseSave(); });
  await expect(page.locator("#setting-cameraRatio-16\\:9")).toHaveAttribute("aria-pressed", "true");
  // However narrow the Camera panel, each shape is a whole target, none covering another.
  for (const [width, height] of [[600, 680], [760, 680], [1000, 680]] as const) {
    await host.evaluate((h, size) => h.setSize(size[0], size[1]), [width, height]);
    const boxes = await page.locator("#setting-cameraRatio [aria-pressed]").evaluateAll(els => els.map(el => el.getBoundingClientRect()).map(r => [r.left, r.right, r.width]));
    expect(boxes.every(([, , w]) => w! >= 24), `S125 ${width}px: ${JSON.stringify(boxes)}`).toBe(true);
    expect(boxes.every((box, i) => i === 0 || box[0]! >= boxes[i - 1]![1]! - 0.5), `S125 ${width}px no overlap`).toBe(true);
  }
  await host.evaluate(h => h.setSize(560, 680));

  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: "2026-10-17T00:00:00Z" };
    h.state.cameraContext = { ...h.state.cameraContext!, camera: { ...h.state.cameraContext!.camera!, session: { hidden: false } } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  });
  await expect(page.locator("#setting-studioCamera"), "S126 the switch is locked while recording").toBeDisabled();
  await expect(width, "S126 the shape is not (D7)").toBeEnabled();
  await clearCalls();
  await width.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(calls, { message: "S126 a change while recording reaches main" }).toEqual([["cameraWidth", "20"]]);

  await host.evaluate(h => { h.state.cameraState = undefined; h.pushModel({ type: "idle" }, { language: "zh-TW", camera: { enabled: true, available: true, access: "granted" } }); });
  await expect(page.getByRole("slider", { name: "寬度" }), "S124 zh-TW").toHaveAttribute("aria-valuetext", "20%");
});

test("S127–S130 camera preview: the camera in the bubble while in sight, dragged and moved with keys to a saved place, the recording's picture while recording (plan 075, step 7)", { tag: "@recording-settings" }, async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(560, 680); });
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
    h.state.cameraContext = { ...h.baseContext(),
      displays: [{ id: "1", label: "Built-in Display", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: true, primary: true, x: 0, y: 0, menuBar: 33 }],
      camera: { enabled: true, available: true, access: "granted", devices: list, device: { id: "iphone", label: "iPhone Camera" } } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  }, devices);
  await page.locator("#tab-studio").click();
  const bubble = page.getByRole("application", { name: "Preview" });
  await bubble.scrollIntoViewIfNeeded();
  await expect(bubble, "S127 the bubble says where it is").toHaveAccessibleDescription(/97% from the left, 95% from the top/);
  await expect.poll(async () => (await cameraCalls()).opened, { message: "S127 the chosen camera, matched by its name, opens while in sight" })
    .toEqual([expect.stringContaining("web-iphone")]);
  await expect(page.locator(".camera-preview-camera"), "S127 and shows in the bubble").toBeVisible();
  await expect(page.locator(".camera-preview-menubar"), "S127 under the menu bar's band").toBeVisible();

  await clearCalls();
  const box = (await bubble.boundingBox())!;
  const stage = (await page.locator(".camera-preview-stage").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2, { steps: 4 });
  await page.mouse.move(stage.x - 40, stage.y - 40, { steps: 4 });
  await page.mouse.up();
  await expect.poll(calls, { message: "S128 one drag is one save, where it was let go of, snapped inside the display" }).toEqual([["cameraPreview", "0,0"]]);
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
  await expect.poll(async () => (await cameraCalls()).stopped, { message: "S129 leaving the tab stops the camera" }).toBeGreaterThan(0);
  // Leaving while the cameras are still being listed opens none afterwards.
  await page.evaluate(() => {
    const listed = navigator.mediaDevices.enumerateDevices;
    const win = window as unknown as { finishListing?: () => void };
    navigator.mediaDevices.enumerateDevices = () => new Promise(resolve => { win.finishListing = () => { void listed().then(resolve); }; });
  });
  const opened = (await cameraCalls()).opened.length;
  await page.locator("#tab-studio").click();
  await page.getByRole("application", { name: "Preview" }).scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { finishListing?: () => void }).finishListing)).toBe("function");
  await page.locator("#tab-general").click();
  await page.evaluate(() => (window as unknown as { finishListing: () => void }).finishListing());
  await page.waitForTimeout(200);
  expect((await cameraCalls()).opened.length, "S129 no camera opened once the preview was left").toBe(opened);
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
  await expect(page.locator(".camera-preview-camera"), "S130 and the page's own camera is closed").toBeHidden();
  await clearCalls();
  await page.getByRole("application", { name: "Preview" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(calls, { message: "S130 the bubble still moves while recording (D7)" }).toEqual([["cameraPreview", "0.96,0.95"]]);

  await host.evaluate(h => { h.state.cameraState = undefined; h.pushModel({ type: "idle" }, { language: "zh-TW",
    displays: h.state.cameraContext!.displays, camera: { enabled: false, available: true, access: "granted" } }); });
  await expect.poll(() => host.evaluate(h => [...h.previewWatches]), { message: "S130 and let go of once the recording is over" }).toEqual([true, false]);
  await expect(page.getByRole("application", { name: "預覽" }), "S127 zh-TW").toHaveAccessibleDescription(/距左側 97%，距上方 95%/);
  await expect(page.locator(".camera-preview-status")).toHaveText("開啟「相機」後即可在此預覽。");
});

test("S131–S132 the Recording Studio: its own tab with Start, then Stop beside the elapsed time; Recording settings keeps the camera's switch and device with the way there (plan 075, D19)", { tag: "@recording-settings" }, async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(560, 680); });
  await host.evaluate(h => {
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.baseContext(), camera: { enabled: true, available: true, access: "granted" } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-studio").click();
  await expect(page.locator("#tab-studio"), "S131 a tab of its own").toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#setting-cameraWidth"), "S131 the bubble's shape is the Studio's").toHaveCount(1);
  await expect(page.getByRole("slider", { name: "Width" }), "S131 its explanation as in Recording settings").toHaveAccessibleDescription(/shorter side/);
  await expect(page.getByRole("button", { name: "Mirror in recording", exact: true })).toHaveAccessibleDescription(/Flips the camera/);
  await clearCalls();
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect.poll(calls, { message: "S131 Start asks main" }).toEqual([["studioControls", "start"]]);
  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: new Date(Date.now() - 65_000).toISOString() };
    h.state.cameraContext = { ...h.state.cameraContext!, camera: { ...h.state.cameraContext!.camera!, session: { hidden: false } } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  });
  await expect(page.getByRole("timer"), "S131 the elapsed time while recording").toHaveText(/^1:0[5-9]$/);
  await expect(page.getByRole("button", { name: "Show camera in recording" }), "S131 the camera's hiding while recording (D13)").toHaveAttribute("aria-pressed", "true");
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

test("S133–S134 the Recording Studio's meters: levels while recording and in sight, a mute per input, said to assistive technology (plan 075, D19)", { tag: "@recording-settings" }, async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(560, 680); });
  await host.evaluate(h => {
    h.levelWatches.length = 0;
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.baseContext(), microphone: { enabled: true } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-studio").click();
  const system = page.getByRole("button", { name: "Mute System audio" });
  await system.scrollIntoViewIfNeeded();
  await expect(system, "S133 between recordings there is nothing to mute").toBeDisabled();
  await expect(page.getByRole("meter", { name: "Microphone" }), "S133 the microphone's meter while its switch is on").toBeVisible();
  await page.waitForTimeout(200);
  expect(await host.evaluate(h => [...h.levelWatches]), "S133 no levels are asked for between recordings").toEqual([]);

  await host.evaluate(h => {
    h.state.cameraState = { type: "recording", startedAt: new Date().toISOString() };
    h.state.cameraContext = { ...h.state.cameraContext!, audioSession: { systemMuted: false, microphone: { muted: false } } };
    h.push(h.settingsView(h.state.cameraState, h.state.cameraContext));
  });
  await expect.poll(() => host.evaluate(h => [...h.levelWatches]), { message: "S133 a recording's meter in sight asks for levels" }).toEqual([true]);
  await host.evaluate(h => h.pushLevels({ system: 0.5, microphone: 0.1 }));
  await expect(page.getByRole("meter", { name: "System audio" }), "S133 a level in dB below full scale").toHaveAttribute("aria-valuetext", "-6 dB");
  await expect(page.getByRole("meter", { name: "Microphone" })).toHaveAttribute("aria-valuetext", "-20 dB");
  // No level comes in silence (WASAPI's loopback sends none): the meter falls back with time all the same.
  await expect.poll(async () => Number(await page.getByRole("meter", { name: "System audio" }).getAttribute("aria-valuenow")),
    { message: "S133 it falls back without new levels", timeout: 3000 }).toBeLessThan(-20);
  // Past full scale (a sum before the limiter) it reads full scale, within its range.
  await host.evaluate(h => h.pushLevels({ system: 2 }));
  // Seen once it arrives, before it falls back far (a step every fifteenth of a second): full scale, never past it.
  const valueNow = async (): Promise<number> => Number(await page.getByRole("meter", { name: "System audio" }).getAttribute("aria-valuenow"));
  await expect.poll(valueNow, { message: "S133 a level past full scale arrives" }).toBeGreaterThanOrEqual(-5);
  expect(await valueNow(), "S133 and reads full scale at most").toBeLessThanOrEqual(0);
  await clearCalls();
  await page.getByRole("button", { name: "Mute Microphone" }).click();
  await expect.poll(calls, { message: "S134 a mute asks main" }).toEqual([["microphoneAudio", "mute"]]);
  await expect(page.getByRole("button", { name: "Unmute Microphone" }), "S134 and shows it").toHaveAttribute("aria-pressed", "true");

  await page.locator("#tab-general").click();
  await expect.poll(() => host.evaluate(h => [...h.levelWatches]), { message: "S133 leaving the tab lets the levels go" }).toEqual([true, false]);
  await page.locator("#tab-studio").click();
  // The recording ends and the next one starts with the Studio open: its meters start from silence.
  await host.evaluate(h => h.pushLevels({ system: 1 }));
  await host.evaluate(h => { h.state.cameraState = undefined; h.push(h.settingsView({ type: "idle" }, { ...h.state.cameraContext!, audioSession: undefined })); });
  await host.evaluate(h => h.push(h.settingsView({ type: "countdown", remaining: 3 }, h.state.cameraContext!)));
  await expect(page.getByRole("meter", { name: "System audio" }), "S133 a next recording's meter starts from silence").toHaveAttribute("aria-valuenow", "-60");
  await host.evaluate(h => { h.state.cameraState = undefined; h.pushModel({ type: "idle" }, { language: "zh-TW", microphone: { enabled: true } }); });
  await expect(page.getByRole("button", { name: "將系統聲音靜音" }), "S133 zh-TW").toBeVisible();
});

test("S135 the sidebar collapses to a rail of icons named by their tooltips, its status a light that opens it, and is remembered (2026-10-17)", { tag: "@layout" }, async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(1000, 680); h.pushModel({ type: "idle" }); });
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
  // A problem's card gives way to a light in its tone, which opens the sidebar to show it.
  await host.evaluate(h => h.pushModel({ type: "idle", outputDirUnavailable: true }));
  const light = page.locator("#status-light");
  await expect(light).toBeVisible();
  await light.click();
  await expect(page.locator("main")).not.toHaveAttribute("data-sidebar", "collapsed");
  await expect(page.locator("#status"), "S135 the card again").toBeVisible();
  // Collapsed again, it is remembered by the page.
  await toggle.click();
  expect(await page.evaluate(() => localStorage.getItem("recordstuff.sidebarCollapsed"))).toBe("1");
  await toggle.click();
  expect(await page.evaluate(() => localStorage.getItem("recordstuff.sidebarCollapsed"))).toBe("0");
  // Troubleshooting's unread count stays readable on the rail.
  await toggle.click();
  await host.evaluate(h => { const view = h.settingsView({ type: "idle" }, h.baseContext());
    h.push({ ...view, tabs: view.tabs.map((tab: { id: string; label: string }) => tab.id === "failures" ? { ...tab, label: "Troubleshooting (2)" } : tab) }); });
  await expect(page.locator("#tab-failures .tab-badge")).toBeVisible();
  expect(await page.locator("#tab-failures .tab-badge").evaluate(el => parseFloat(getComputedStyle(el).fontSize)), "S135 at least 12px").toBeGreaterThanOrEqual(12);
  await toggle.click();
  // A narrow window's tabs are a line already: nothing collapses.
  await host.evaluate(h => { h.setSize(560, 680); h.pushModel({ type: "idle" }); });
  await expect(toggle).toBeHidden();
});

test("S136–S137 Live preview: the Studio's button asks main, the engine's picture shows with no bubble to place when the camera is off, and leaving the Studio lets it go (plan 075, D20)", { tag: "@recording-settings" }, async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(1000, 720); });
  await host.evaluate(h => {
    h.studioWatches.length = 0;
    h.previewWatches.length = 0;
    h.state.cameraState = undefined;
    h.state.cameraContext = { ...h.baseContext(), camera: { enabled: false, available: true, access: "granted" } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await page.locator("#tab-studio").click();
  await expect.poll(() => host.evaluate(h => [...h.studioWatches]), { message: "S136 the Studio says it is open" }).toEqual([true]);
  await clearCalls();
  await page.getByRole("button", { name: "Live preview" }).click();
  await expect.poll(calls, { message: "S136 Live preview asks main" }).toEqual([["studioControls", "preview"]]);
  await host.evaluate(h => {
    h.state.cameraContext = { ...h.state.cameraContext!, studio: { preview: { live: true }, showing: true } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await expect(page.locator("#setting-studioControls-label"), "S136 the state").toHaveText("Previewing");
  await expect(page.getByRole("button", { name: "Stop preview" })).toBeVisible();
  await expect(page.locator(".camera-preview-picture"), "S136 the engine's picture").toBeVisible();
  await expect(page.locator(".camera-preview-handle"), "S136 no bubble to place without the camera").toHaveCount(0);
  await expect.poll(() => host.evaluate(h => [...h.previewWatches]), { message: "S136 its picture is asked for" }).toEqual([true]);
  // A preview that could not start says why, until the next.
  await host.evaluate(h => {
    h.state.cameraContext = { ...h.state.cameraContext!, studio: { showing: false, previewFailure: "camera_unavailable" } };
    h.push(h.settingsView({ type: "idle" }, h.state.cameraContext));
  });
  await expect(page.locator(".studio-controls [role=status]"), "S136 why").toContainText("Live preview could not start:");
  await page.locator("#tab-general").click();
  await expect.poll(() => host.evaluate(h => [...h.studioWatches]), { message: "S137 leaving the Studio lets the preview go" }).toEqual([true, false]);
  await host.evaluate(h => h.setSize(560, 680));
});

test("S039–S041 the status card: no Start when ready; Change output folder… and Relaunch ask main for the card's own action", { tag: "@recording-settings" }, async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(h.SNAPSHOT_SIZES.default[0], h.SNAPSHOT_SIZES.default[1]); h.pushModel({ type: "idle" }); });
  await expect.poll(() => read(page, `document.getElementById("status-action").hidden`), { message: "S039 status card: a ready card offers no Start button" }).toBe(true);
  await host.evaluate(h => h.pushModel({ type: "idle", outputDirUnavailable: true }));
  await expect(page.locator("#status-action")).toHaveText("Change output folder…");
  await clearCalls();
  await clickAt(page, "#status-action", { scroll: false });
  await expect.poll(calls, { message: "S040 status card: a click on Change output folder… asks main for status/folder" }).toEqual([["status", "folder"]]);
  // A missing permission: Open System Settings is the primary action, followed by the optional Relaunch link.
  for (const [lang, scheme, size] of [["en", "light", "default"], ["en", "dark", "narrow"], ["zh-TW", "light", "minimum"]] as const) {
    await host.evaluate((h, args) => { h.theme(args.scheme); h.setSize(...h.SNAPSHOT_SIZES[args.size]); h.pushModel({ type: "needsPermission", needsRelaunch: false }, { language: args.lang }); }, { lang, scheme, size });
    await page.waitForTimeout(150);
    await keep(`status-permission-${lang}-${scheme}-${size}.png`);
  }
  await host.evaluate(h => { h.theme("light"); h.setSize(h.SNAPSHOT_SIZES.default[0], h.SNAPSHOT_SIZES.default[1]); });
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
    await host.evaluate((h, args) => { h.setSize(...h.SNAPSHOT_SIZES[args.size]); h.pushModel({ type: "idle" }, { language: args.lang }); }, { lang, size });
    await page.locator("#tab-recording").click();
    const infoState = (id: string) => read<{ open: boolean; expanded: string | null; text: string; inside: boolean; describes: boolean }>(page, `(() => {
      const id = ${JSON.stringify(`setting-${id}`)}, popover = document.getElementById(id + "-info-popup"), r = popover?.getBoundingClientRect();
      const control = document.querySelector("#" + id + "-row [role=switch], #" + id + "-row [role=combobox], #" + id + "-row button[aria-pressed]");
      return { open: Boolean(popover?.hasAttribute("data-open")), expanded: document.getElementById(id + "-info-button").getAttribute("aria-expanded"), text: document.getElementById(id + "-info").textContent,
        inside: Boolean(r && r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight),
        describes: (control?.getAttribute("aria-describedby") ?? "").split(" ").includes(id + "-info") }; })()`);
    const at = await centre(page, "#setting-countdownSound-info-button");
    await page.mouse.move(at.x, at.y);
    await until(page, `document.getElementById("setting-countdownSound-info-popup")?.hasAttribute("data-open")`);
    // Measured once the explanation's opening transition has finished, as the former fixture's pause allowed.
    await until(page, `document.getElementById("setting-countdownSound-info-popup").getAnimations({ subtree: true }).every(a => a.playState !== "running")`);
    const hovered = await infoState("countdownSound");
    await keep(`info-hover-${lang}-light-${size}.png`);
    // A point between the button and its explanation, wherever the design places it.
    const geometry = await read<{ gap: { x: number; y: number }; onto: { x: number; y: number } }>(page, `(() => {
      const b = document.getElementById("setting-countdownSound-info-button").getBoundingClientRect(), r = document.getElementById("setting-countdownSound-info-popup").getBoundingClientRect();
      const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
      const gap = r.bottom <= b.top ? { x, y: Math.floor((r.bottom + b.top) / 2) } : r.top >= b.bottom ? { x, y: Math.ceil((b.bottom + r.top) / 2) }
        : r.right <= b.left ? { x: Math.floor((r.right + b.left) / 2), y } : r.left >= b.right ? { x: Math.ceil((b.right + r.left) / 2), y } : { x, y };
      return { gap, onto: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }; })()`);
    await page.mouse.move(geometry.gap.x, geometry.gap.y); await page.waitForTimeout(300);
    const inGap = await infoState("countdownSound");
    await page.mouse.move(geometry.onto.x, geometry.onto.y); await page.waitForTimeout(300);
    const kept = await infoState("countdownSound");
    await page.mouse.move(4, 4); await page.waitForTimeout(300);
    const left = await infoState("countdownSound");
    expect.soft({ open: hovered.open, expanded: hovered.expanded, inside: hovered.inside, describes: hovered.describes, text: hovered.text,
      inGap: inGap.open, kept: kept.open, left: left.open, leftExpanded: left.expanded },
    `S042 ${lang}/${size}: hovering the ⓘ shows its explanation inside the window, it stays through a pause in the gap and while the pointer is on it, and leaving both hides it`)
      .toEqual({ open: true, expanded: "true", inside: true, describes: true, text: lang === "en" ? "The tick is not recorded." : "提示音不會被錄進影片。",
        inGap: true, kept: true, left: false, leftExpanded: "false" });
    await page.locator("#setting-videoQuality button[aria-pressed=true]").focus();
    await page.keyboard.press("Tab");
    await until(page, `document.getElementById("setting-resolutionCap-info-popup")?.hasAttribute("data-open")`);
    const tabbed = { active: await read<string>(page, "document.activeElement.id"), ...await infoState("resolutionCap") };
    await keep(`info-focus-${lang}-light-${size}.png`);
    // An Escape with no explanation open would close the window: only one that opened is answered.
    if (tabbed.open) await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const escaped = await infoState("resolutionCap");
    expect.soft({ active: tabbed.active, open: tabbed.open, inside: tabbed.inside, windowOpen: !page.isClosed(), escaped: escaped.open },
      `S043 ${lang}/${size}: a Tab reaches the next ⓘ and shows its explanation; Escape closes it and leaves the window open`)
      .toEqual({ active: "setting-resolutionCap-info-button", open: true, inside: true, windowOpen: true, escaped: false });
  });
}

test("S044–S048 update checks: repeated states keep nodes and geometry; Tab and Enter start one check and keep focus through it", { tag: "@general" }, async () => {
  await host.evaluate(h => { h.setSize(560, 680); h.pushModel({ type: "idle" }, { updates: { enabled: true, state: { kind: "current", checkedAt: 1000 } } }); });
  await page.locator("#tab-general").click();
  await read(page, `window.updateBefore = { row: document.getElementById("setting-updates-row"), button: document.getElementById("setting-updates-check"), note: document.getElementById("setting-updates-note"), below: document.getElementById("setting-language-row").getBoundingClientRect().top };`);
  for (const [id, updateState] of [["S044", { kind: "checking", previous: { kind: "current", checkedAt: 1000 } }], ["S045", { kind: "current", checkedAt: 2000 }]] as const) {
    await host.evaluate((h, value) => h.pushModel({ type: "idle" }, { updates: { enabled: true, state: value } }), updateState);
    await page.waitForTimeout(60);
    expect.soft(await read<boolean>(page, `updateBefore.row === document.getElementById("setting-updates-row") && updateBefore.button === document.getElementById("setting-updates-check") && updateBefore.note === document.getElementById("setting-updates-note") && !updateBefore.note.hidden && updateBefore.below === document.getElementById("setting-language-row").getBoundingClientRect().top`),
      `${id} repeated update ${updateState.kind} preserves nodes and lower-row geometry`).toBe(true);
  }
  await host.evaluate(h => { h.state.updateContext = { ...h.baseContext(), updates: { enabled: true, state: { kind: "current", checkedAt: 1000 } } }; h.push(h.settingsView({ type: "idle" }, h.state.updateContext)); });
  await page.waitForTimeout(60);
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
  await host.evaluate(h => { h.pushModel({ type: "idle" }); h.setSize(380, 360); });
  await page.waitForTimeout(100);
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
  await host.evaluate(h => { h.setSize(720, 900); h.state.captureView = h.settingsView({ type: "idle" }, h.baseContext()); h.push(h.state.captureView); });
  await page.locator("#tab-general").click();
  await page.waitForTimeout(100);
  // The credit and the named website/source links are shown and do not overlap, whatever their arrangement.
  const footer = `(() => { const credit = [...document.querySelectorAll("#setting-about-row *")].find(el => el.childElementCount === 0 && el.textContent.includes("Eric Tsai")), c = credit.getBoundingClientRect();
    const links = ["setting-about-website", "setting-about-source"].map(id => document.getElementById(id));
    const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
    return { credit: credit.checkVisibility() && c.height > 0, links: links.map(b => Boolean(b?.checkVisibility() && b.getAttribute("aria-label"))),
      apart: links.every(b => b && apart(c, b.getBoundingClientRect())),
      hide: [...document.querySelectorAll("button[aria-label]")].some(b => b.getAttribute("aria-label") === "Hide interface" && b.checkVisibility()) }; })()`;
  expect.soft(await read(page, footer), "S053 General's footer shows the credit and named website/source links without overlap; Hide interface stays reachable")
    .toEqual({ credit: true, links: [true, true], apart: true, hide: true });
  await host.evaluate(h => h.setSize(560, 760));
  await page.waitForTimeout(100);
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
    await host.evaluate((h, args) => {
      h.theme(args.scheme);
      h.setSize(720, 900);
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
  await host.evaluate(h => { h.setSize(560, 760); h.state.captureView = h.settingsView({ type: "idle" }, h.baseContext()); h.push(h.state.captureView); });
  await page.locator("#tab-general").click();
  const arm = (): Promise<unknown> => pickMenu(page, "setting-hotkey", "custom");
  await arm();
  await page.waitForTimeout(100);
  await page.keyboard.press("Tab");
  const exit = await read<string>(page, "document.activeElement.id");
  await page.keyboard.press("Tab");
  const next = await read<string>(page, "document.activeElement.id");
  expect.soft({ exit, next }, "S058 Tab exits capture to the next visible preference, its ⓘ and then its switch").toEqual({ exit: "setting-notifications-info-button", next: "setting-notifications" });
  await arm();
  await page.waitForTimeout(100);
  await page.keyboard.press("Shift+Tab");
  const back = await read<string>(page, "document.activeElement.id");
  await expect.poll(() => focusShown("#setting-hotkey"), { message: "S059 keyboard navigation retains a visible focus indicator" }).toBe(true);
  await read(page, `document.getElementById("setting-hotkey").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  expect.soft(await read<boolean>(page, `document.activeElement === document.getElementById("setting-hotkey")`) && back === "setting-hotkey",
    "S060 pointer bookkeeping preserves DOM focus").toBe(true);
  await arm();
  await page.waitForTimeout(100);
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
  await page.waitForTimeout(100);
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
  await page.waitForTimeout(100);
  expect.soft(await read<number>(page, `document.getElementById("shortcut-capture").getAnimations({ subtree: true }).filter(a => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity).length`),
    "S066 reduced motion stops the listening animation").toBe(0);
  await page.locator("#shortcut-cancel").click();
  await page.emulateMedia({ reducedMotion: null });
  await keep("panel.png");
});

for (const platform of ["darwin", "win32"] as const) {
  test(`S116 ${platform}: the top of a narrow window is clickable: nothing, the window-drag strip included, covers a tab`, { tag: "@layout" }, async () => {
    // Plan 066 found the strip over the tabs on Windows CI; the page lays out by the platform its view names.
    await host.evaluate((h, value) => { h.setSize(560, 680); h.pushModel({ type: "idle" }, { platform: value }); }, platform);
    await expect(page.locator("html")).toHaveAttribute("data-platform", platform);
    const covered = await read<string[]>(page, `[...document.querySelectorAll('[role="tab"]')].filter(tab => { const r = tab.getBoundingClientRect();
      return r.width > 0 && !tab.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }).map(tab => tab.id)`);
    expect.soft(covered, `S116 ${platform}: no tab is covered at its centre`).toEqual([]);
    await page.getByRole("tab", { name: "General" }).click({ timeout: 3000 });
    await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  });
}
