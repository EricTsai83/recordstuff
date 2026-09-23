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
 * Usage: electron scripts/fixtures/settings-panel.mjs <outDir> <repoRoot>
 */
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";

const [outDir, root] = process.argv.slice(2).slice(-2);
const out = path.join(root, "out");
const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shaped like what settings-model produces, including a refused shortcut. */
const view = (language) => {
  const zh = language === "zh-TW";
  return {
    language,
    title: zh ? "設定" : "Settings",
    hint: zh ? "變更會自動儲存。" : "Changes are saved automatically.",
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

let language = "zh-TW";
let notifications = true;
const chooseCalls = [];
let holdSaves = false;
const heldSaves = [];
ipcMain.handle("settings:read", () => view(language));
ipcMain.handle("settings:choose", (_event, group, choice) => {
  chooseCalls.push([group, choice]);
  const commit = () => {
    if (group === "language") language = choice;
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

const read = (window, script) => window.webContents.executeJavaScript(script);

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
  const consoleErrors = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") consoleErrors.push(event.message);
  });

  // Main puts the language in the URL so a failed first read is localized.
  await window.loadFile(path.join(out, "renderer/settings.html"), { query: { lang: "zh-TW" } });
  await settle(700);

  const rendered = await read(window, `(() => ({
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
    consoleErrors.length === 0 && rendered.controls.length === 3,
    JSON.stringify({ consoleErrors, controls: rendered.controls.length }),
  );
  record(
    "the preload exposes read/choose/onChanged and nothing else",
    JSON.stringify(rendered.bridge) === '["choose","onChanged","read"]',
    JSON.stringify(rendered.bridge),
  );
  record(
    "no Node API reaches the sandboxed page",
    JSON.stringify(rendered.exposed) === '["undefined","undefined","undefined"]',
    JSON.stringify(rendered.exposed),
  );
  record(
    "the URL language localizes the first render",
    rendered.title === "設定" && rendered.docTitle === "設定" && rendered.lang === "zh-Hant",
    JSON.stringify([rendered.title, rendered.docTitle, rendered.lang]),
  );
  record(
    "each group renders one live control showing the committed value",
    rendered.controls.every((c) => !c.disabled) &&
      rendered.controls.map((c) => [c.id, c.value].join("=")).join(",") ===
        "setting-frameRate=30,setting-hotkey=CommandOrControl+Alt+Shift+R,setting-language=zh-TW",
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
      rendered.controls[1]?.describedBy === "setting-hotkey-note",
    JSON.stringify([rendered.note, rendered.controls[1]?.describedBy]),
  );

  // A real change event, through the real preload, to main and back.
  await read(window, `(() => {
    const select = document.querySelector("#setting-language");
    select.value = "en";
    select.dispatchEvent(new Event("change"));
  })()`);
  await settle(700);
  const applied = await read(window, `(() => ({
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
    applied.title === "Settings" && applied.lang === "en" && applied.hotkeyLabel === "Shortcut",
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
  const refused = await read(window, `(() => ({
    feedback: document.querySelector("#feedback").textContent,
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
  const selectLanguage = (value) => read(window, `(() => {
    const select = document.querySelector("#setting-language");
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event("change"));
  })()`);
  await selectLanguage("zh-TW");
  await selectLanguage("en");
  await settle(100);
  if (heldSaves.length !== 2) throw new Error("Expected two pending saves");
  heldSaves.shift()();
  window.webContents.send("settings:changed", view(language));
  await settle(100);
  const pending = await read(window, `({
    value: document.querySelector("#setting-language").value,
    locked: document.querySelector("#setting-hotkey").disabled,
    feedback: document.querySelector("#feedback").textContent,
  })`);
  record("an older completion and push retain the latest pending choice and lock",
    pending.value === "en" && pending.locked && pending.feedback === "", JSON.stringify(pending));
  heldSaves.shift()();
  await settle(100);
  const finished = await read(window, `({
    value: document.querySelector("#setting-language").value,
    locked: document.querySelector("#setting-hotkey").disabled,
    title: document.title,
  })`);
  record("the final completion unlocks controls and displays committed settings",
    finished.value === "en" && !finished.locked && finished.title === "Settings", JSON.stringify(finished));

  // Stop holding saves: the cases below judge settled state, and a still-pending
  // save keeps `saving` set, which renders every button disabled.
  holdSaves = false;
  if (heldSaves.length !== 0) throw new Error("Held saves were left pending");

  // A preference and the system pane that can override it, in one card.
  await read(window, `document.querySelector("#tab-general").click()`);
  await settle(200);
  const general = await read(window, `(() => {
    const row = document.querySelector("#setting-notifications")?.closest(".row");
    const kids = row ? [...row.children].map(el => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "." + el.className)) : [];
    return {
      controls: [...document.querySelectorAll("select")].map(s => s.id),
      buttons: [...document.querySelectorAll(".row button")].map(b => ({ id: b.id, text: b.textContent, disabled: b.disabled })),
      value: document.querySelector("#setting-notifications")?.value ?? null,
      order: kids,
    };
  })()`);
  record(
    "the general tab renders the notification switch with its pane button in one card",
    general.controls.join(",") === "setting-notifications" &&
      general.buttons.length === 1 &&
      general.buttons[0].id === "setting-notifications-openSettings" &&
      general.buttons[0].disabled === false &&
      general.order.at(-1) === "button#setting-notifications-openSettings",
    JSON.stringify(general),
  );

  chooseCalls.length = 0;
  await read(window, `document.querySelector("#setting-notifications-openSettings").click()`);
  await settle(700);
  const pane = await read(window, `({
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
    select.value = "off";
    select.dispatchEvent(new Event("change"));
  })()`);
  await settle(700);
  const off = await read(window, `(() => {
    const row = document.querySelector("#setting-notifications").closest(".row");
    return {
      value: document.querySelector("#setting-notifications").value,
      feedback: document.querySelector("#feedback").textContent,
      buttons: [...row.querySelectorAll("button")].map(b => ({ id: b.id, disabled: b.disabled })),
    };
  })()`);
  record(
    "turning the switch off commits and leaves the pane button usable",
    off.value === "off" && off.feedback === "" &&
      off.buttons.length === 1 && off.buttons[0].id === "setting-notifications-openSettings" &&
      off.buttons[0].disabled === false,
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
      };
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event("change"));
    })()`);
    await settle(100);
    window.webContents.send("settings:changed", view(language));
    await settle(100);
    const during = await read(window, `({
      sameSelect: beforeToggle.select === document.querySelector("#setting-notifications"),
      samePanel: beforeToggle.panel === document.querySelector("#settings-panel"),
      focused: document.activeElement === beforeToggle.select,
      scrollStable: window.scrollY === beforeToggle.scroll,
      value: beforeToggle.select.value,
      buttonLocked: beforeToggle.button.disabled,
      buttonOpacity: getComputedStyle(beforeToggle.button).opacity,
    })`);
    record(`notification ${value}: pending save and push preserve controls, focus, scroll and brightness`,
      during.sameSelect && during.samePanel && during.focused && during.scrollStable &&
      during.value === value && during.buttonLocked && during.buttonOpacity === "1", JSON.stringify(during));
    if (heldSaves.length !== 1) throw new Error("Expected one pending notification save");
    heldSaves.shift()();
    await settle(100);
    const after = await read(window, `({
      sameSelect: beforeToggle.select === document.querySelector("#setting-notifications"),
      focused: document.activeElement === beforeToggle.select,
      scrollStable: window.scrollY === beforeToggle.scroll,
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
  const restricted = await read(window, `({
    disabled: document.querySelector("#setting-notifications").disabled,
    opacity: getComputedStyle(document.querySelector("#setting-notifications")).opacity,
  })`);
  record("recording restrictions still disable and dim the controls",
    restricted.disabled && restricted.opacity === "0.5", JSON.stringify(restricted));
  window.webContents.send("settings:changed", view(language));
  await settle(100);

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
