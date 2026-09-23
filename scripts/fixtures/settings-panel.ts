/**
 * Electron main for `pnpm acceptance:settings`. Loads the built settings
 * preload and page in a real window, drives it, and writes the outcome.
 * Never a production entry; nothing here ships with the app.
 *
 * It supplies its own view and IPC handlers on purpose: `settings-model` and
 * `SettingsWindow` have unit tests, and what no mock can answer is whether
 * the shipped bundle loads under the shipped CSP, whether the preload exposes
 * what it should, and whether a real change event survives the round trip.
 *
 * Compiled automatically by acceptance-settings.mts before Electron loads it.
 */
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import type { Language } from "../../src/shared/i18n";
import type { SettingsView } from "../../src/shared/settings-panel";
import fs from "node:fs";
import { settingsView } from "../../src/main/settings-model";
import { DEFAULT_QUALITY } from "../../src/shared/quality";
import { DEFAULT_HOTKEY } from "../../src/shared/hotkey";
import type { AppContext } from "../../src/main/ui-model";
import path from "node:path";

const [outDir, root] = (() => {
  const [output, repository] = process.argv.slice(-2);
  if (!output || !repository) throw new Error("Expected output and repository directories");
  return [output, repository] as const;
})();
const out = path.join(root, "out");
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shaped like what settings-model produces, including a refused shortcut. */
const view = (language: Language): SettingsView => {
  const zh = language === "zh-TW";
  return {
    language,
    title: zh ? "RecordStuff - 設置" : "RecordStuff - Settings",
    hint: "",
    failure: zh
      ? "無法套用這項設定，目前顯示的是實際使用的設定。"
      : "Could not apply this setting. Your current settings are shown.",
    tabs: [
      { id: "recording", label: zh ? "錄影" : "Recording settings" },
      { id: "general", label: zh ? "一般" : "General" },
    ],
    groups: [
      {
        id: "frameRate",
        tab: "recording",
        label: zh ? "幀率" : "Frame rate",
        enabled: true,
        choices: [
          { id: "30", label: "30 fps", enabled: true, checked: true },
          {
            id: "60",
            label: zh ? "60 fps（此平台尚未驗證，暫不開放）" : "60 fps (unverified on this platform)",
            enabled: false,
            checked: false,
          },
        ],
      },
      {
        id: "hotkey",
        tab: "recording",
        label: zh ? "快捷鍵" : "Shortcut",
        note: zh ? "無法使用：這個快捷鍵被其他 App 佔用。" : "Unavailable: another app is using this shortcut.",
        enabled: true,
        choices: [
          { id: "CommandOrControl+Alt+Shift+R", label: "⌘⌥⇧R", enabled: true, checked: true },
          { id: "off", label: zh ? "關閉" : "Off", enabled: true, checked: false },
        ],
      },
      {
        id: "notifications",
        control: "switch", section: "notifications",
        tab: "general",
        label: zh ? "通知" : "Notifications",
        note: zh ? "錄影儲存完成或發生錯誤時顯示通知。" : "Shows a notification when a recording is saved or an error occurs.",
        enabled: true,
        choices: [
          { id: "on", label: zh ? "開啟" : "On", enabled: true, checked: notifications },
          { id: "off", label: zh ? "關閉" : "Off", enabled: true, checked: !notifications },
        ],
        actions: [
          { id: "openSettings", label: zh ? "開啟通知設定…" : "Open notification settings…", enabled: true, checked: false },
        ],
      },
      {
        id: "language",
        control: "segmented", section: "language",
        tab: "recording",
        label: zh ? "語言" : "Language",
        enabled: true,
        choices: [
          { id: "en", label: "English", enabled: true, checked: language === "en" },
          { id: "zh-TW", label: "繁體中文", enabled: true, checked: language === "zh-TW" },
        ],
      },
    ],
  };
};

let language: Language = "zh-TW";
let notifications = true;
let captureView: SettingsView | undefined;
const chooseCalls: Array<[string, string]> = [];
let holdSaves = false;
const heldSaves: Array<() => void> = [];
const pendingSaveCount = (): number => heldSaves.length;
ipcMain.handle("settings:read", () => view(language));
ipcMain.handle("settings:capture", (_event, armed: boolean) => {
  if (!captureView) return view(language);
  captureView = structuredClone(captureView);
  captureView.groups.find(g => g.id === "hotkey")!.capturing = armed;
  return captureView;
});
ipcMain.handle("settings:choose", (_event, group: string, choice: string) => {
  chooseCalls.push([group, choice]);
  if (group === "about" && captureView) return { view: captureView, applied: false, failure: "Could not open the link. Try again." };
  const commit = () => {
    if (group === "language" && (choice === "en" || choice === "zh-TW")) language = choice;
    if (group === "notifications" && choice !== "openSettings") notifications = choice === "on";
    // The pane has no committed value; main uses the handler's own boolean.
    const applied = group === "language"
      || (group === "notifications" && choice === "openSettings")
      || (group === "notifications" && (choice === "on") === notifications);
    return { view: view(language), applied };
  };
  if (holdSaves) return new Promise(resolve => heldSaves.push(() => resolve(commit())));
  return commit();
});

const read = <T = unknown>(window: BrowserWindow, script: string): Promise<T> =>
  window.webContents.executeJavaScript(script) as Promise<T>;

async function run() {
  const window = new BrowserWindow({
    width: 460,
    height: 560,
    show: false,
    webPreferences: {
      preload: path.join(out, "preload/settings.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const consoleErrors: string[] = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") consoleErrors.push(event.message);
  });

  // Main puts the language in the URL so a failed first read is localized.
  await window.loadFile(path.join(out, "renderer/settings.html"), { query: { lang: "zh-TW" } });
  await settle(700);

  const rendered = await read<{ title: string; docTitle: string; lang: string; hint: string; feedback: string;
    bridge: string[]; exposed: string[]; note: string | null;
    controls: Array<{ id: string; value: string; disabled: boolean; label: string;
      describedBy: string | null; options: Array<{ text: string; disabled: boolean }> }> }>(window, `(() => ({
    title: document.querySelector("#title").textContent,
    docTitle: document.title,
    lang: document.documentElement.lang,
    hint: document.querySelector("#hint").textContent,
    feedback: document.querySelector("#feedback").textContent,
    bridge: Object.keys(window.settings ?? {}).sort(),
    exposed: [typeof window.require, typeof window.process, typeof window.module],
    controls: [...document.querySelectorAll("select")].map(s => ({
      id: s.id,
      value: s.value,
      disabled: s.disabled,
      label: document.querySelector("label[for='" + s.id + "']").textContent,
      describedBy: s.getAttribute("aria-describedby"),
      options: [...s.options].map(o => ({ text: o.textContent, disabled: o.disabled })),
    })),
    note: document.querySelector("#setting-hotkey-note")?.textContent ?? null,
  }))()`);

  record(
    "the shipped page loads under the shipped CSP with no console errors",
    consoleErrors.length === 0 && rendered.controls.length === 2,
    JSON.stringify({ consoleErrors, controls: rendered.controls.length }),
  );
  const compactHeader = await read<boolean>(window, `!document.querySelector(".app-icon") && document.getElementById("title").classList.contains("visually-hidden") && document.getElementById("hint").hidden`);
  record("content starts with tabs without duplicate branding or autosave hint", compactHeader, String(compactHeader));
  record(
    "the preload exposes capture/read/choose/onChanged and nothing else",
    JSON.stringify(rendered.bridge) === '["capture","choose","onChanged","read"]',
    JSON.stringify(rendered.bridge),
  );
  record(
    "no Node API reaches the sandboxed page",
    JSON.stringify(rendered.exposed) === '["undefined","undefined","undefined"]',
    JSON.stringify(rendered.exposed),
  );
  record(
    "the URL language localizes the first render",
    rendered.title === "RecordStuff - 設置" && rendered.docTitle === "RecordStuff - 設置" && rendered.lang === "zh-Hant",
    JSON.stringify([rendered.title, rendered.docTitle, rendered.lang]),
  );
  record(
    "each group renders one live control showing the committed value",
    rendered.controls.every((c) => !c.disabled) &&
      rendered.controls.map((c) => [c.id, c.value].join("=")).join(",") ===
        "setting-frameRate=30,setting-hotkey=CommandOrControl+Alt+Shift+R",
    JSON.stringify(rendered.controls.map((c) => [c.id, c.value])),
  );
  record(
    "an option unavailable on this platform is listed but not selectable",
    rendered.controls[0]?.options[1]?.disabled === true,
    JSON.stringify(rendered.controls[0]?.options),
  );
  record(
    "a refused shortcut shows its note and the control points at it",
    rendered.note === "無法使用：這個快捷鍵被其他 App 佔用。" &&
      rendered.controls[1]?.describedBy?.includes("setting-hotkey-note") === true,
    JSON.stringify([rendered.note, rendered.controls[1]?.describedBy]),
  );

  // A real change event, through the real preload, to main and back.
  await read(window, `(() => {
    document.querySelector("#setting-language-en").click();
  })()`);
  await settle(700);
  const applied = await read<{ title: string; lang: string; hotkeyLabel: string; feedback: string }>(window, `(() => ({
    title: document.querySelector("#title").textContent,
    lang: document.documentElement.lang,
    hotkeyLabel: document.querySelector("label[for='setting-hotkey']").textContent,
    feedback: document.querySelector("#feedback").textContent,
  }))()`);
  record(
    "a change reaches main as the group and choice ids, not an action",
    JSON.stringify(chooseCalls) === '[["language","en"]]',
    JSON.stringify(chooseCalls),
  );
  record(
    "the committed answer re-renders the whole panel in the new language",
    applied.title === "RecordStuff - Settings" && applied.lang === "en" && applied.hotkeyLabel === "Shortcut",
    JSON.stringify(applied),
  );
  record("a committed change shows no failure text", applied.feedback === "", JSON.stringify(applied.feedback));

  // A choice main did not commit must say so, in the panel's language.
  await read(window, `(() => {
    const select = document.querySelector("#setting-frameRate");
    select.value = "60";
    select.dispatchEvent(new Event("change"));
  })()`);
  await settle(700);
  const refused = await read<{ feedback: string; frameRate: string }>(window, `(() => ({
    feedback: document.querySelector("#setting-frameRate-row .save-error p").textContent,
    frameRate: document.querySelector("#setting-frameRate").value,
  }))()`);
  record(
    "a choice that did not commit reports it and shows the committed value",
    refused.feedback === "Could not apply this setting. Your current settings are shown." &&
      refused.frameRate === "30",
    JSON.stringify(refused),
  );

  // Keep two real IPC requests pending and interleave an older main push.
  holdSaves = true;
  const selectLanguage = (value: Language) => read(window, `(() => {
    const select = document.querySelector("#setting-language-" + ${JSON.stringify(value)});
    select.checked = true;
    select.dispatchEvent(new Event("change"));
  })()`);
  await selectLanguage("zh-TW");
  await selectLanguage("en");
  await settle(100);
  if (pendingSaveCount() !== 2) throw new Error("Expected two pending saves");
  heldSaves.shift()!();
  window.webContents.send("settings:changed", view(language));
  await settle(100);
  const pending = await read<{ value: string; locked: boolean; feedback: string }>(window, `({
    value: document.querySelector("#setting-language input:checked").value,
    locked: document.querySelector("#setting-hotkey").disabled,
    feedback: document.querySelector("#feedback").textContent,
  })`);
  record("an older completion and push show the committed pushed value and retain the pending lock",
    pending.value === "zh-TW" && pending.locked && pending.feedback === "", JSON.stringify(pending));
  heldSaves.shift()!();
  await settle(100);
  const finished = await read<{ value: string; locked: boolean; title: string }>(window, `({
    value: document.querySelector("#setting-language input:checked").value,
    locked: document.querySelector("#setting-hotkey").disabled,
    title: document.title,
  })`);
  record("the final completion unlocks controls and displays committed settings",
    finished.value === "en" && !finished.locked && finished.title === "RecordStuff - Settings", JSON.stringify(finished));

  // Stop holding saves: the cases below judge settled state, and a still-pending
  // save keeps `saving` set, which renders every button disabled.
  holdSaves = false;
  if (pendingSaveCount() !== 0) throw new Error("Held saves were left pending");

  // A preference and the system pane that can override it, in one card.
  await read(window, `document.querySelector("#tab-general").click()`);
  await settle(200);
  const general = await read<{ controls: string[]; buttons: Array<{ id: string; text: string; disabled: boolean }>; value: string | null; order: string[] }>(window, `(() => {
    const row = document.querySelector("#setting-notifications")?.closest(".row");
    const kids = row ? [...row.children].map(el => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "." + el.className)) : [];
    return {
      controls: [...document.querySelectorAll("input[role=switch]")].map(s => s.id),
      buttons: [...document.querySelectorAll(".row button")].filter(b => !b.closest("[hidden]")).map(b => ({ id: b.id, text: b.textContent, disabled: b.disabled })),
      value: document.querySelector("#setting-notifications")?.value ?? null,
      order: kids,
    };
  })()`);
  record(
    "the general tab renders the notification switch with its pane button in one card",
    general.controls.join(",") === "setting-notifications" &&
      general.buttons.length === 1 &&
      general.buttons[0]?.id === "setting-notifications-openSettings" &&
      general.buttons[0]?.disabled === false &&
      general.order.includes("button#setting-notifications-openSettings"),
    JSON.stringify(general),
  );

  chooseCalls.length = 0;
  await read(window, `document.querySelector("#setting-notifications-openSettings").click()`);
  await settle(700);
  const pane = await read<{ feedback: string; value: string }>(window, `({
    feedback: document.querySelector("#feedback").textContent,
    value: document.querySelector("#setting-notifications").value,
  })`);
  record(
    "the pane button reaches main as ids and its own outcome counts as applied",
    JSON.stringify(chooseCalls) === '[["notifications","openSettings"]]' && pane.feedback === "",
    JSON.stringify({ chooseCalls, ...pane }),
  );

  chooseCalls.length = 0;
  await read(window, `(() => {
    const select = document.querySelector("#setting-notifications");
    select.checked = false;
    select.dispatchEvent(new Event("change"));
  })()`);
  await settle(700);
  const off = await read<{ value: string; feedback: string; buttons: Array<{ id: string; disabled: boolean }> }>(window, `(() => {
    const row = document.querySelector("#setting-notifications").closest(".row");
    return {
      value: document.querySelector("#setting-notifications").value,
      feedback: document.querySelector("#feedback").textContent,
      buttons: [...row.querySelectorAll("button:not([hidden])")].filter(b => !b.closest("[hidden]")).map(b => ({ id: b.id, disabled: b.disabled })),
    };
  })()`);
  record(
    "turning the switch off commits and leaves the pane button usable",
    off.value === "off" && off.feedback === "" &&
      off.buttons.some(b => b.id === "setting-notifications-openSettings" && !b.disabled),
    JSON.stringify(off),
  );

  // Keep a save pending across frames and a real main push. A recreated
  // control can look correct after settling while still flashing or losing focus.
  for (const value of ["on", "off"]) {
    holdSaves = true;
    await read(window, `(() => {
      const select = document.querySelector("#setting-notifications");
      select.focus();
      window.beforeToggle = {
        select, panel: document.querySelector("#settings-panel"),
        button: document.querySelector("#setting-notifications-openSettings"),
        scroll: window.scrollY,
        below: document.querySelector("#setting-updates-row")?.getBoundingClientRect().top,
      };
      select.checked = ${JSON.stringify(value)} === "on";
      select.dispatchEvent(new Event("change"));
    })()`);
    await settle(100);
    window.webContents.send("settings:changed", view(language));
    await settle(100);
    const during = await read<{ sameSelect: boolean; samePanel: boolean; focused: boolean; scrollStable: boolean; value: string; buttonLocked: boolean; buttonOpacity: string }>(window, `({
      sameSelect: beforeToggle.select === document.querySelector("#setting-notifications"),
      samePanel: beforeToggle.panel === document.querySelector("#settings-panel"),
      focused: document.activeElement === beforeToggle.select,
      scrollStable: window.scrollY === beforeToggle.scroll && document.querySelector("#setting-updates-row")?.getBoundingClientRect().top === beforeToggle.below,
      value: beforeToggle.select.value,
      buttonLocked: beforeToggle.button.disabled,
      buttonOpacity: getComputedStyle(beforeToggle.button).opacity,
    })`);
    record(`notification ${value}: pending save and push preserve controls, focus, scroll and brightness`,
      during.sameSelect && during.samePanel && during.focused && during.scrollStable &&
      during.value === (value === "on" ? "off" : "on") && during.buttonLocked && during.buttonOpacity === "1", JSON.stringify(during));
    if (pendingSaveCount() !== 1) throw new Error("Expected one pending notification save");
    heldSaves.shift()!();
    await settle(100);
    const after = await read<{ sameSelect: boolean; focused: boolean; scrollStable: boolean; value: string; buttonLocked: boolean }>(window, `({
      sameSelect: beforeToggle.select === document.querySelector("#setting-notifications"),
      focused: document.activeElement === beforeToggle.select,
      scrollStable: window.scrollY === beforeToggle.scroll && document.querySelector("#setting-updates-row")?.getBoundingClientRect().top === beforeToggle.below,
      value: beforeToggle.select.value,
      buttonLocked: beforeToggle.button.disabled,
    })`);
    record(`notification ${value}: completion preserves the control and unlocks the pane action`,
      after.sameSelect && after.focused && after.scrollStable && after.value === value && !after.buttonLocked,
      JSON.stringify(after));
  }
  holdSaves = false;
  const lockedView = view(language);
  lockedView.groups.forEach(group => { group.enabled = false; });
  window.webContents.send("settings:changed", lockedView);
  await settle(100);
  const restricted = await read<{ disabled: boolean; opacity: string }>(window, `({
    disabled: document.querySelector("#setting-notifications").disabled,
    opacity: getComputedStyle(document.querySelector("#setting-notifications")).opacity,
  })`);
  record("recording restrictions still disable and dim the controls",
    restricted.disabled && restricted.opacity === "0.5", JSON.stringify(restricted));
  window.webContents.send("settings:changed", view(language));
  await settle(100);

  // Real model snapshots cover visual states without touching user preferences.
  const ctx: AppContext = { platform: "darwin", language: "en", outputDir: "/tmp", homeDir: "/tmp",
    quality: DEFAULT_QUALITY, hotkey: { ...DEFAULT_HOTKEY, registered: true }, notifications: true,
    updates: { enabled: true, state: { kind: "idle" } }, display: { kind: "primary" },
    displays: [{ id: "1", label: "Built-in Display", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: true, primary: true }] };
  for (const lang of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
    nativeTheme.themeSource = scheme;
    for (const size of ["default", "minimum"] as const) {
      window.setSize(size === "default" ? 560 : 380, size === "default" ? 680 : 360);
      for (const state of ["recording", "general", "listening", "error", "locked"] as const) {
        const snapshot = settingsView(state === "locked" ? { type: "starting" } : { type: "idle" }, {
          ...ctx, language: lang,
          ...(state === "error" ? { display: { kind: "display", id: "2", label: "BenQ BL2480T" }, displayFailure: "target_removed" } : {}),
        });
        if (state === "listening") snapshot.groups.find(g => g.id === "hotkey")!.capturing = true;
        await read(window, `document.getElementById("tab-${state === "general" || state === "listening" ? "general" : "recording"}").click()`);
        await settle(60);
        window.webContents.send("settings:changed", snapshot);
        await settle(60);
        await read(window, `document.getElementById("settings-panel").scrollTop = 0`);
        if (state === "listening") await read(window, `document.getElementById("shortcut-capture").focus()`);
        else await read(window, `document.querySelector("#settings-panel select, #settings-panel input")?.focus()`);
        await settle(60);
        const fits = await read<boolean>(window, `document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth && document.getElementById("settings-panel").scrollWidth <= document.getElementById("settings-panel").clientWidth`);
        const geometry = await read(window, `({root: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], viewport: [innerWidth, innerHeight], main: document.querySelector("main").getBoundingClientRect().toJSON(), form: document.querySelector("form").getBoundingClientRect().toJSON(), panel: document.getElementById("settings-panel").getBoundingClientRect().toJSON()})`);
        record(`${lang}/${scheme}/${size}/${state}: no horizontal or outer-page overflow`, fits, JSON.stringify(geometry));
        fs.writeFileSync(path.join(outDir, `panel-${lang}-${scheme}-${size}-${state}.png`), (await window.webContents.capturePage()).toPNG());
      }
    }
  }
  // Repeated checks preserve the row, button, result text and lower-row position.
  window.setSize(560, 680);
  const updatePrevious = { kind: "current" as const, checkedAt: 1000 };
  window.webContents.send("settings:changed", settingsView({ type: "idle" }, { ...ctx, updates: { enabled: true, state: updatePrevious } }));
  await settle(60);
  await read(window, `document.getElementById("tab-general").click()`);
  await read(window, `window.updateBefore = { row: document.getElementById("setting-updates-row"), button: document.getElementById("setting-updates-check"), note: document.querySelector("#setting-updates-row .note"), below: document.getElementById("setting-language-row").getBoundingClientRect().top };`);
  for (const state of [{ kind: "checking" as const, previous: updatePrevious }, { kind: "current" as const, checkedAt: 2000 }]) {
    window.webContents.send("settings:changed", settingsView({ type: "idle" }, { ...ctx, updates: { enabled: true, state } }));
    await settle(60);
    const stable = await read<boolean>(window, `updateBefore.row === document.getElementById("setting-updates-row") && updateBefore.button === document.getElementById("setting-updates-check") && updateBefore.note === document.querySelector("#setting-updates-row .note") && !updateBefore.note.hidden && updateBefore.below === document.getElementById("setting-language-row").getBoundingClientRect().top`);
    record(`repeated update ${state.kind} preserves nodes and lower-row geometry`, stable, String(stable));
  }
  window.setSize(380, 360);
  await settle(100);
  await read(window, `document.getElementById("settings-panel").scrollTop = 0`);
  await settle(60);
  const scrollTopHint = await read<boolean>(window, `!document.getElementById("scroll-hint").hidden && getComputedStyle(document.getElementById("scroll-hint")).pointerEvents === "none"`);
  record("overflow shows non-interactive glass scroll cue", scrollTopHint, String(scrollTopHint));
  fs.writeFileSync(path.join(outDir, "panel-scroll-cue.png"), (await window.webContents.capturePage()).toPNG());
  await read(window, `document.getElementById("settings-panel").scrollTop = document.getElementById("settings-panel").scrollHeight`);
  await settle(60);
  const bottomHint = await read<boolean>(window, `document.getElementById("scroll-hint").hidden`);
  record("scroll cue disappears at the bottom", bottomHint, String(bottomHint));
  window.setSize(560, 680);
  await read(window, `document.getElementById("tab-recording").click()`);
  await settle(100);
  const noOverflow = await read<boolean>(window, `document.getElementById("scroll-hint").hidden && document.getElementById("settings-panel").scrollHeight <= document.getElementById("settings-panel").clientHeight + 2`);
  record("fitting content needs no scroll cue", noOverflow, String(noOverflow));
  captureView = settingsView({ type: "idle" }, ctx);
  window.webContents.send("settings:changed", captureView);
  await settle(60);
  await read(window, `document.getElementById("tab-general").click()`);
  const footer = await read<boolean>(window, `(() => { const row = document.getElementById("setting-about-row"); const buttons = [...row.querySelectorAll(".controls button")]; const credit = row.querySelector(".group-label"); return credit.textContent.includes("Eric Tsai") && buttons.length === 2 && buttons.every(b => b.querySelector("svg") && b.getAttribute("aria-label") && b.title === b.getAttribute("aria-label")) && credit.getBoundingClientRect().right <= buttons[0].getBoundingClientRect().left; })()`);
  record("footer credits Eric Tsai on the left with two labeled icon links on the right", footer, String(footer));
  await read(window, `document.getElementById("setting-about-website").click()`);
  await settle(100);
  const retryFits = await read<boolean>(window, `(() => { const retry = document.getElementById("setting-about-retry"); return !retry.hidden && retry.getBoundingClientRect().width > 32 && retry.scrollWidth <= retry.clientWidth && document.querySelector("#setting-about-website svg") !== null; })()`);
  record("failed footer link retains readable text retry and icon", retryFits, String(retryFits));
  window.show(); window.focus();
  await read(window, `(() => { const s = document.getElementById("setting-hotkey"); s.value = "custom"; s.dispatchEvent(new Event("change")); })()`);
  await settle(100);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await settle(100);
  const tabExit = await read<string>(window, `document.activeElement.id`);
  record("real Tab exits capture to the next visible preference", tabExit === "setting-notifications", tabExit);
  await read(window, `(() => { const s = document.getElementById("setting-hotkey"); s.value = "custom"; s.dispatchEvent(new Event("change")); })()`);
  await settle(100);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers: ["shift"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers: ["shift"] });
  await settle(100);
  const backExit = await read<string>(window, `document.activeElement.id`);
  const keyboardRing = await read<boolean>(window, `getComputedStyle(document.getElementById("setting-hotkey")).outlineStyle === "solid"`);
  record("keyboard navigation retains a visible focus ring", keyboardRing, String(keyboardRing));
  await read(window, `document.getElementById("setting-hotkey").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  const pointerRing = await read<boolean>(window, `getComputedStyle(document.getElementById("setting-hotkey")).outlineStyle === "none"`);
  record("pointer interaction removes the ring without discarding DOM focus", pointerRing && backExit === "setting-hotkey", String(pointerRing));
  await read(window, `(() => { const s = document.getElementById("setting-hotkey"); s.value = "custom"; s.dispatchEvent(new Event("change")); })()`);
  await settle(100);
  const listening = await read<boolean>(window, `document.querySelectorAll("#shortcut-capture .listening-indicator span").length === 3 && !document.querySelector(".capture-area").hidden`);
  record("acknowledged capture displays a listening indicator", listening, String(listening));
  await read(window, `document.getElementById("shortcut-cancel").click()`);
  await settle(100);
  record("real Shift+Tab exits capture to its preceding edit action", backExit === "setting-hotkey", backExit);
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
  window.setSize(560, 680);
  await settle(100);
  const forced = await read<boolean>(window, `matchMedia("(forced-colors: active)").matches && getComputedStyle(document.getElementById("setting-notifications")).appearance === "auto" && getComputedStyle(document.getElementById("setting-language-en")).appearance === "auto"`);
  record("forced colors restore native checkbox and radio appearance", forced, String(forced));
  fs.writeFileSync(path.join(outDir, "panel-forced-colors.png"), (await window.webContents.capturePage()).toPNG());
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reduced = await read<boolean>(window, `getComputedStyle(document.querySelector(".listening-indicator span")).animationName === "none"`);
  record("reduced motion disables the listening animation", reduced, String(reduced));
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
  window.webContents.debugger.detach();
  fs.writeFileSync(path.join(outDir, "panel.png"), (await window.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  return results.every((result) => result.ok);
}

app.whenReady()
  .then(run)
  .then((ok) => app.exit(ok ? 0 : 1))
  .catch((error) => {
    fs.writeFileSync(path.join(outDir, "error.txt"), String(error?.stack ?? error));
    app.exit(2);
  });
