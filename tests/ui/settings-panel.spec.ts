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
import { read, until, centre, clickAt } from "./helpers";

let host: Launched, page: Page;
test.beforeEach(async ({ launchView }) => {
  ({ launched: host, page } = await launchView());
  await expect(page.locator("#setting-hotkey")).toBeVisible();
});
/** A picture kept in the test's output folder for inspection, as the former fixture kept its screenshots. */
const keep = async (name: string): Promise<void> => { fs.writeFileSync(test.info().outputPath(name), await page.screenshot({ animations: "disabled", caret: "hide" })); };
const calls = (): Promise<Array<[string, unknown]>> => host.evaluate(h => [...h.chooseCalls]);
const clearCalls = (): Promise<void> => host.evaluate(h => { h.chooseCalls.length = 0; });
const commitEnglish = async (): Promise<void> => {
  await page.locator("#setting-language-en").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await clearCalls();
};

test("S002–S009 the shipped page and preload: CSP, bridge, sandbox, localized first render, committed values, unavailable option, refused-shortcut note", async () => {
  const rendered = await read<{ title: string; docTitle: string; lang: string; bridge: string[]; exposed: string[]; note: string | null;
    controls: Array<{ id: string; value: string; disabled: boolean; label: string; describedBy: string | null; options: Array<{ text: string; disabled: boolean }> }> }>(page, `(() => ({
    title: document.querySelector("#title").textContent, docTitle: document.title, lang: document.documentElement.lang,
    bridge: Object.keys(window.settings ?? {}).sort(), exposed: [typeof window.require, typeof window.process, typeof window.module],
    controls: [...document.querySelectorAll("select")].map(s => ({ id: s.id, value: s.value, disabled: s.disabled,
      label: document.querySelector("label[for='" + s.id + "']").textContent, describedBy: s.getAttribute("aria-describedby"),
      options: [...s.options].map(o => ({ text: o.textContent, disabled: o.disabled })) })),
    note: document.querySelector("#setting-hotkey-note")?.textContent ?? null,
  }))()`);
  expect.soft(rendered.controls.length, "S002 the shipped page loads under the shipped CSP (page errors fail at teardown)").toBe(2);
  expect.soft(await read<boolean>(page, `!document.querySelector(".app-icon") && document.getElementById("title").classList.contains("visually-hidden") && document.getElementById("hint").hidden`),
    "S003 content starts with tabs without duplicate branding or autosave hint").toBe(true);
  expect.soft(rendered.bridge, "S004 the preload exposes only the settings and zoom APIs").toEqual(["capture", "choose", "onChanged", "onHidden", "onZoomChanged", "read", "ready", "zoom"]);
  expect.soft(rendered.exposed, "S005 no Node API reaches the sandboxed page").toEqual(["undefined", "undefined", "undefined"]);
  expect.soft([rendered.title, rendered.docTitle, rendered.lang, rendered.controls.find(control => control.id === "setting-hotkey")?.label],
    "S006 the URL language localizes the first render").toEqual(["RecordStuff", "RecordStuff", "zh-Hant", "快捷鍵"]);
  expect.soft(rendered.controls.map(control => [control.id, control.value, control.disabled]), "S007 each group renders one live control showing the committed value")
    .toEqual([["setting-frameRate", "30", false], ["setting-hotkey", "CommandOrControl+Alt+Shift+R", false]]);
  expect.soft(rendered.controls[0]?.options[1]?.disabled, "S008 an option unavailable on this platform is listed but not selectable").toBe(true);
  expect.soft([rendered.note, rendered.controls[1]?.describedBy?.includes("setting-hotkey-note")], "S009 a refused shortcut shows its note and the control points at it")
    .toEqual(["這個快捷鍵可能被其他 App 佔用。", true]);
});

test("S010–S013 a change reaches main as ids, re-renders in the committed language, and a choice main refused says so", async () => {
  await page.locator("#setting-language-en").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect.soft(await calls(), "S010 a change reaches main as the group and choice ids, not an action").toEqual([["language", "en"]]);
  const applied = await read<{ title: string; hotkeyLabel: string; feedback: string }>(page, `({ title: document.querySelector("#title").textContent,
    hotkeyLabel: document.querySelector("label[for='setting-hotkey']").textContent, feedback: document.querySelector("#feedback").textContent })`);
  expect.soft([applied.title, applied.hotkeyLabel], "S011 the committed answer re-renders the whole panel in the new language").toEqual(["RecordStuff", "Shortcut"]);
  expect.soft(applied.feedback, "S012 a committed change shows no failure text").toBe("");
  // A choice the page does not offer (the disabled 60 fps), sent as a stale page would: main does not commit it.
  await read(page, `(() => { const select = document.querySelector("#setting-frameRate"); select.value = "60"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await expect(page.locator("#setting-frameRate-row .save-error p")).toHaveText("Could not apply this setting. Your current settings are shown.");
  expect(await page.locator("#setting-frameRate").inputValue(), "S013 a choice that did not commit reports it and shows the committed value").toBe("30");
});

test("S014–S015 two held saves and an older push: the pushed committed value shows with the lock kept, and the final completion unlocks", async () => {
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

test("S016–S021 the notification card: switch and pane button in one card, ids to main, held saves keep the control, restrictions dim", async () => {
  await commitEnglish();
  await page.locator("#tab-general").click();
  const general = await read<{ controls: string[]; buttons: Array<{ id: string; disabled: boolean }>; order: string[] }>(page, `(() => {
    const row = document.querySelector("#setting-notifications")?.closest(".row");
    return { controls: [...document.querySelectorAll("[role=switch]")].map(s => s.id),
      buttons: [...document.querySelectorAll(".row button:not([data-slot=popover-trigger]):not([role=switch])")].filter(b => !b.closest("[hidden]")).map(b => ({ id: b.id, disabled: b.disabled })),
      order: row ? [...row.children].map(el => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "." + el.className)) : [] }; })()`);
  expect.soft(general.controls.join(), "S016 the general tab renders the notification switch").toBe("setting-notifications");
  expect.soft(general.buttons, "S016 …with its pane button in one card").toEqual([{ id: "setting-notifications-openSettings", disabled: false }]);
  expect.soft(general.order, "S016 …in the same card").toContain("button#setting-notifications-openSettings");

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
      buttonLocked: beforeToggle.button.getAttribute("aria-disabled") === "true" && !beforeToggle.button.disabled, buttonOpacity: getComputedStyle(beforeToggle.button).opacity })`);
    expect.soft(during, `S019 notification ${value}: pending save and push preserve controls, focus, scroll and brightness`).toEqual({ sameSelect: true, samePanel: true, focused: true,
      scrollStable: true, value: value === "on" ? "off" : "on", buttonLocked: true, buttonOpacity: "1" });
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
  await expect.poll(() => read(page, `getComputedStyle(document.querySelector("#setting-notifications")).opacity`)).toBe("0.5");
  await expect(page.locator("#setting-notifications"), "S021 recording restrictions still disable and dim the controls").toBeDisabled();
});

test("S022 the Recordings folder is read by the app's library: names, dates, sizes and lengths from the files", async () => {
  const files = await host.evaluate(h => h.library().state.files.map((file: { name: string; recordedAt: number; size: number; duration?: number }) => [file.name, file.recordedAt, file.size, file.duration ?? null]));
  expect(files).toEqual([
    ["2026-10-04 14-02-11.mp4", new Date(2026, 9, 4, 14, 2, 11).getTime(), 182e6, 83],
    ["A long product walkthrough recorded for the onboarding review.mp4", new Date(2026, 9, 4, 9, 30).getTime(), 1.24e9, 3725],
    ["2026-10-03 21-15-00.mp4", new Date(2026, 9, 3, 21, 15).getTime(), 54e6, null],
  ]);
});

test("S037–S038 countdown sound: a click on the checked switch asks main for off; under countdown Off it is disabled, keeps its value and sends nothing", async () => {
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

test("S039–S041 the status card: no Start when ready; Change output folder… and Relaunch ask main for the card's own action", async () => {
  await host.evaluate(h => { h.theme("light"); h.setSize(h.SNAPSHOT_SIZES.default[0], h.SNAPSHOT_SIZES.default[1]); h.pushModel({ type: "idle" }); });
  await expect.poll(() => read(page, `document.getElementById("status-action").hidden`), { message: "S039 status card: a ready card offers no Start button" }).toBe(true);
  await host.evaluate(h => h.pushModel({ type: "idle", outputDirUnavailable: true }));
  await expect(page.locator("#status-action")).toHaveText("Change output folder…");
  await clearCalls();
  const fix = await read<{ inSidebar: boolean }>(page, `(() => { const r = document.getElementById("status-action").getBoundingClientRect(), panel = document.querySelector(".settings-viewport").getBoundingClientRect(); return { inSidebar: r.right <= panel.left }; })()`);
  await clickAt(page, "#status-action", { scroll: false });
  await expect.poll(calls, { message: "S040 status card: Change output folder… sits in the sidebar and a click asks main for status/folder" }).toEqual([["status", "folder"]]);
  expect.soft(fix.inSidebar, "S040 …in the sidebar").toBe(true);
  // A missing permission: Open System Settings is the button and Relaunch a text link under the card's words.
  for (const [lang, scheme, size] of [["en", "light", "default"], ["en", "dark", "narrow"], ["zh-TW", "light", "minimum"]] as const) {
    await host.evaluate((h, args) => { h.theme(args.scheme); h.setSize(...h.SNAPSHOT_SIZES[args.size]); h.pushModel({ type: "needsPermission", needsRelaunch: false }, { language: args.lang }); }, { lang, scheme, size });
    await page.waitForTimeout(150);
    await keep(`status-permission-${lang}-${scheme}-${size}.png`);
  }
  await host.evaluate(h => { h.theme("light"); h.setSize(h.SNAPSHOT_SIZES.default[0], h.SNAPSHOT_SIZES.default[1]); });
  await host.evaluate(h => h.pushModel({ type: "needsPermission", needsRelaunch: false }));
  await expect(page.locator("#status-secondary")).toBeVisible();
  await clearCalls();
  const link = await read<{ x: number; y: number; label: string; button: string; below: boolean; inside: boolean }>(page, `(() => {
    const el = document.getElementById("status-secondary"), r = el.getBoundingClientRect(), card = document.getElementById("status").getBoundingClientRect();
    const detail = document.getElementById("status-detail").getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(r.width / 2, 40)), y: Math.round(r.y + r.height / 2), label: el.hidden ? "" : el.textContent, button: document.getElementById("status-action").textContent,
      below: r.top >= detail.bottom - 1, inside: Boolean(r.width > 0 && r.left >= card.left && r.right <= card.right && r.bottom <= card.bottom) }; })()`);
  await page.mouse.click(link.x, link.y);
  await expect.poll(calls).toEqual([["status", "relaunch"]]);
  expect.soft({ label: link.label, button: link.button, below: link.below, inside: link.inside },
    "S041 status card: a missing permission offers Open System Settings and, under the words, Relaunch; a click on the link asks main for status/relaunch")
    .toEqual({ label: "Already allowed? Relaunch RecordStuff", button: "Open System Settings", below: true, inside: true });
});

for (const [lang, size] of [["en", "minimum"], ["zh-TW", "default"]] as const) {
  test(`S042–S043 ${lang}/${size}: the ⓘ explanation by hover (above it, kept through the gap and on itself) and by Tab, closed by Escape with the window open`, async () => {
    await host.evaluate((h, args) => { h.setSize(...h.SNAPSHOT_SIZES[args.size]); h.pushModel({ type: "idle" }, { language: args.lang }); }, { lang, size });
    await page.locator("#tab-recording").click();
    const infoState = (id: string) => read<{ open: boolean; expanded: string | null; text: string; inside: boolean; describes: boolean }>(page, `(() => {
      const id = ${JSON.stringify(`setting-${id}`)}, popover = document.getElementById(id + "-info-popup"), r = popover?.getBoundingClientRect();
      const control = document.querySelector("#" + id + "-row [role=switch], #" + id + "-row select, #" + id + "-row .segments button");
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
    const geometry = await read<{ above: boolean; gap: { x: number; y: number }; onto: { x: number; y: number } }>(page, `(() => {
      const b = document.getElementById("setting-countdownSound-info-button").getBoundingClientRect(), r = document.getElementById("setting-countdownSound-info-popup").getBoundingClientRect();
      return { above: r.bottom <= b.top, gap: { x: Math.round(b.x + b.width / 2), y: Math.floor(b.top) - 1 }, onto: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }; })()`);
    await page.mouse.move(geometry.gap.x, geometry.gap.y); await page.waitForTimeout(300);
    const inGap = await infoState("countdownSound");
    await page.mouse.move(geometry.onto.x, geometry.onto.y); await page.waitForTimeout(300);
    const kept = await infoState("countdownSound");
    await page.mouse.move(4, 4); await page.waitForTimeout(300);
    const left = await infoState("countdownSound");
    expect.soft({ open: hovered.open, expanded: hovered.expanded, inside: hovered.inside, describes: hovered.describes, text: hovered.text, above: geometry.above,
      inGap: inGap.open, kept: kept.open, left: left.open, leftExpanded: left.expanded },
    `S042 ${lang}/${size}: hovering the ⓘ shows its explanation above it inside the window, it stays through a pause in the gap and while the pointer is on it, and leaving both hides it`)
      .toEqual({ open: true, expanded: "true", inside: true, describes: true, text: lang === "en" ? "The tick is not recorded." : "提示音不會被錄進影片。", above: true,
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

test("S044–S048 update checks: repeated states keep nodes and geometry; Tab and Enter start one check and keep focus through it", async () => {
  await host.evaluate(h => { h.setSize(560, 680); h.pushModel({ type: "idle" }, { updates: { enabled: true, state: { kind: "current", checkedAt: 1000 } } }); });
  await page.locator("#tab-general").click();
  await read(page, `window.updateBefore = { row: document.getElementById("setting-updates-row"), button: document.getElementById("setting-updates-check"), note: document.querySelector("#setting-updates-row .note"), below: document.getElementById("setting-language-row").getBoundingClientRect().top };`);
  for (const [id, updateState] of [["S044", { kind: "checking", previous: { kind: "current", checkedAt: 1000 } }], ["S045", { kind: "current", checkedAt: 2000 }]] as const) {
    await host.evaluate((h, value) => h.pushModel({ type: "idle" }, { updates: { enabled: true, state: value } }), updateState);
    await page.waitForTimeout(60);
    expect.soft(await read<boolean>(page, `updateBefore.row === document.getElementById("setting-updates-row") && updateBefore.button === document.getElementById("setting-updates-check") && updateBefore.note === document.querySelector("#setting-updates-row .note") && !updateBefore.note.hidden && updateBefore.below === document.getElementById("setting-language-row").getBoundingClientRect().top`),
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
  await page.waitForTimeout(150);
  const busy = await read<{ active: string; disabled: boolean; ariaDisabled: string | null; ring: string }>(page, `(() => { const el = document.getElementById("setting-updates-check");
    return { active: document.activeElement.id, disabled: el.disabled, ariaDisabled: el.getAttribute("aria-disabled"), ring: getComputedStyle(el).boxShadow }; })()`);
  await keep("update-check-busy.png");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  expect.soft({ tabbed, calls: await calls() }, "S046 Tab reaches Check for updates… and Enter starts one check").toEqual({ tabbed: "setting-updates-check", calls: [["updates", "check"]] });
  expect.soft({ active: busy.active, disabled: busy.disabled, ariaDisabled: busy.ariaDisabled, ring: /0px 0px 0px 2px/.test(busy.ring) },
    "S047 a running check keeps keyboard focus and its ring on the busy, focusable button").toEqual({ active: "setting-updates-check", disabled: false, ariaDisabled: "true", ring: true });
  await host.evaluate(h => { h.state.updateContext = { ...h.state.updateContext, updates: { enabled: true, state: { kind: "current", checkedAt: 2000 } } }; h.push(h.settingsView({ type: "idle" }, h.state.updateContext)); });
  await expect(page.locator("#setting-updates-check")).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("Tab");
  const next = await read<string>(page, "document.activeElement.id");
  await keep("update-check-done.png");
  expect.soft(next !== "" && !next.startsWith("tab-") && next !== "setting-updates-check", `S048 after the check, the next Tab continues past the button instead of restarting at the tabs (${next})`).toBe(true);
});

test("S049–S052 the scroll cue: shown non-interactive on overflow, never over a Tab-focused control, gone at the bottom and when content fits", async () => {
  await host.evaluate(h => { h.pushModel({ type: "idle" }); h.setSize(380, 360); });
  await page.waitForTimeout(100);
  await read(page, `document.getElementById("settings-panel").scrollTop = 0`);
  await expect.poll(() => read(page, `!document.getElementById("scroll-hint").hidden && getComputedStyle(document.getElementById("scroll-hint")).pointerEvents === "none"`),
    { message: "S049 overflow shows non-interactive glass scroll cue" }).toBe(true);
  await keep("panel-scroll-cue.png");
  await page.locator('[role="tab"][aria-selected="true"]').focus();
  const covered: string[] = [];
  let scrolled = 0;
  for (let step = 0; step < 24; step += 1) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(60);
    const focus = await read<{ id: string; covered: boolean; scrollTop: number }>(page, `(() => {
      const cue = document.getElementById("scroll-hint"), active = document.activeElement, panel = document.getElementById("settings-panel");
      const hint = cue.getBoundingClientRect(), box = active.getBoundingClientRect();
      return { id: active.id || active.tagName, covered: panel.contains(active) && !cue.hidden && box.bottom > hint.top + 1 && box.top < hint.bottom, scrollTop: panel.scrollTop }; })()`);
    if (focus.covered) covered.push(focus.id);
    scrolled = Math.max(scrolled, focus.scrollTop);
  }
  expect.soft({ scrolled: scrolled > 0, covered }, "S050 a Tab never leaves the focused control under the scroll cue").toEqual({ scrolled: true, covered: [] });
  await read(page, `document.getElementById("settings-panel").scrollTop = document.getElementById("settings-panel").scrollHeight`);
  await expect.poll(() => read(page, `document.getElementById("scroll-hint").hidden`), { message: "S051 scroll cue disappears at the bottom" }).toBe(true);
  await host.evaluate(h => h.setSize(720, 900));
  await page.locator("#tab-recording").click();
  await page.waitForTimeout(100);
  const fitting = await read<{ hidden: boolean; scrollHeight: number; clientHeight: number }>(page, `({ hidden: document.getElementById("scroll-hint").hidden,
    scrollHeight: document.getElementById("settings-panel").scrollHeight, clientHeight: document.getElementById("settings-panel").clientHeight })`);
  expect.soft(fitting.hidden && fitting.scrollHeight <= fitting.clientHeight + 2, `S052 fitting content needs no scroll cue ${JSON.stringify(fitting)}`).toBe(true);
});

test("S053–S057 General's footer and Show log: wide and narrow layouts, a failed link's Retry keeps focus in its row", async () => {
  await host.evaluate(h => { h.setSize(720, 900); h.state.captureView = h.settingsView({ type: "idle" }, h.baseContext()); h.push(h.state.captureView); });
  await page.locator("#tab-general").click();
  await page.waitForTimeout(100);
  const wide = await read<{ credit: boolean; shown: string[] }>(page, `(() => { const row = document.getElementById("setting-about-row");
    return { credit: row.querySelector(".group-label").getBoundingClientRect().height > 0, shown: [...row.querySelectorAll(".controls button")].filter(b => b.getBoundingClientRect().height > 0).map(b => b.dataset.action) }; })()`);
  expect.soft(wide, "S053 beside the sidebar, General's footer shows the credit with the website and source links, and its Quit gives way to the sidebar's").toEqual({ credit: true, shown: ["website", "source"] });
  await host.evaluate(h => h.setSize(560, 760));
  await page.waitForTimeout(100);
  expect.soft(await read<boolean>(page, `(() => { const row = document.getElementById("setting-about-row"); const buttons = [...row.querySelectorAll(".controls button")]; const credit = row.querySelector(".group-label"); return credit.textContent.includes("Eric Tsai") && buttons.map(b => b.dataset.action).join() === "website,source,quit" && buttons.every(b => b.querySelector("svg") && b.getAttribute("aria-label") && b.title === b.getAttribute("aria-label")) && credit.getBoundingClientRect().right <= buttons[0].getBoundingClientRect().left; })()`),
    "S054 narrow footer credits Eric Tsai on the left with the website, source and Quit RecordStuff as labeled icons on the right").toBe(true);
  expect.soft(await read<boolean>(page, `(() => { const row = document.getElementById("setting-log-row"); const show = document.getElementById("setting-log-show"); return Boolean(row?.querySelector(".row-icon")) && row.querySelector(".group-label").textContent === "Log file" && show?.textContent === "Show log" && !show.disabled; })()`),
    "S055 Show log is a labelled row of its own, with an icon and a text button").toBe(true);
  await page.locator("#setting-about-website").click();
  await expect.poll(() => read(page, `(() => { const retry = document.getElementById("setting-about-retry"); return !retry.hidden && retry.getBoundingClientRect().width > 32 && retry.scrollWidth <= retry.clientWidth && document.querySelector("#setting-about-website svg") !== null; })()`),
    { message: "S056 failed footer link retains readable text retry and icon" }).toBe(true);
  await page.locator("#setting-about-retry").focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  const retry = await read<{ active: string; retryShown: boolean }>(page, `({ active: document.activeElement.id, retryShown: !document.getElementById("setting-about-retry").hidden })`);
  expect.soft(retry.retryShown && retry.active.startsWith("setting-about-"), `S057 a key on a failed link's Retry keeps focus in its row, not on the page ${JSON.stringify(retry)}`).toBe(true);
});

test("S058–S066 the shortcut editor by keyboard: Tab and Shift+Tab leave capture, focus rings, listening indicator, Control+F12, Confirm, forced colors and reduced motion", async () => {
  await host.evaluate(h => { h.setSize(560, 760); h.state.captureView = h.settingsView({ type: "idle" }, h.baseContext()); h.push(h.state.captureView); });
  await page.locator("#tab-general").click();
  const arm = (): Promise<unknown> => read(page, `(() => { const s = document.getElementById("setting-hotkey"); s.value = "custom"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
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
  expect.soft(await read<boolean>(page, `(() => { const el = document.getElementById("setting-hotkey"); return el.matches(":focus-visible") && getComputedStyle(el).boxShadow.includes("0px 0px 0px 2px"); })()`),
    "S059 keyboard navigation retains a visible focus ring").toBe(true);
  await read(page, `document.getElementById("setting-hotkey").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  expect.soft(await read<boolean>(page, `getComputedStyle(document.getElementById("setting-hotkey")).outlineStyle === "none"`) && back === "setting-hotkey",
    "S060 pointer interaction removes the ring without discarding DOM focus").toBe(true);
  await arm();
  await page.waitForTimeout(100);
  expect.soft(await read<boolean>(page, `document.querySelectorAll("#shortcut-capture .listening-indicator span").length === 3 && !document.querySelector(".capture-area").hidden`),
    "S061 acknowledged capture displays a listening indicator").toBe(true);
  await page.keyboard.press("Control+F12");
  await expect.soft(page.locator("#shortcut-capture kbd"), "S062 Control+F12 keeps the named key in one keycap").toHaveText(["⌃", "F12"]);
  await keep("shortcut-f12.png");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(100);
  expect.soft(await read(page, `({ active: document.activeElement.id, open: !document.querySelector(".capture-area").hidden, enabled: !document.getElementById("shortcut-confirm").disabled })`),
    "S063 Tab with a candidate reaches Confirm and keeps the editor open").toEqual({ active: "shortcut-confirm", open: true, enabled: true });
  await page.locator("#shortcut-cancel").click();
  expect.soft(back, "S064 Shift+Tab exits capture to its preceding edit action").toBe("setting-hotkey");
  await host.evaluate(h => h.setSize(560, 680));
  await page.emulateMedia({ forcedColors: "active" });
  await page.waitForTimeout(100);
  expect.soft(await read<boolean>(page, `matchMedia("(forced-colors: active)").matches && getComputedStyle(document.getElementById("setting-notifications")).borderTopStyle === "solid" && getComputedStyle(document.querySelector("#setting-language button[aria-pressed=true]")).outlineStyle === "solid"`),
    "S065 forced colors distinguish the switch and the selected segment").toBe(true);
  await keep("panel-forced-colors.png");
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
  expect.soft(await read<string>(page, `getComputedStyle(document.querySelector(".listening-indicator span")).animationName`), "S066 reduced motion disables the listening animation").toBe("none");
  await page.emulateMedia({ reducedMotion: null });
  await keep("panel.png");
});
