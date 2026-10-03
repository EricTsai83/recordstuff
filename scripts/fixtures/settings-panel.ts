import { RecordingResults } from "../../src/main/recording-result";
import { settingsAction } from "../../src/main/settings-model";
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
import { spawnSync } from "node:child_process";
import { activation, judgeActive, lsappinfoName, windowActive, type Activation, type FixtureFailure, type SettingsCase, type WindowState } from "../lib/settings-activation.mts";

const [outDir, root] = (() => {
  const [output, repository] = process.argv.slice(-2);
  if (!output || !repository) throw new Error("Expected output and repository directories");
  return [output, repository] as const;
})();
const out = path.join(root, "out");
// Chromium's profile and caches stay in the run's evidence, not in the shared default Electron folder.
app.setPath("userData", path.join(outDir, "user-data"));
const results: SettingsCase[] = [];
/** Each case is also logged, so electron.log shows how far a round got. */
const push = (result: SettingsCase): void => {
  results.push(result);
  console.log(`case ${results.length}: ${result.notRun ? "NOT RUN" : result.ok ? "PASS" : "FAIL"} — ${result.name}`);
};
const record = (name: string, ok: boolean, detail: string) => push({ name, ok, detail });
const writeResults = (): void => fs.writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
/** A `capturePage()` that threw, with the file it was for and the window at that moment (plan 057). */
class CaptureFailed extends Error {
  constructor(readonly failure: FixtureFailure) { super(`capturePage() failed for ${failure.screenshot}: ${failure.error}`); }
}
/** The frontmost app's name, for a case that lost its window's activation; `undefined` when it cannot be read. */
const frontmost = (): string | undefined => {
  if (process.platform !== "darwin") return undefined;
  const asn = spawnSync("lsappinfo", ["front"], { encoding: "utf8", timeout: 2000 }).stdout?.trim();
  if (!asn) return undefined;
  return lsappinfoName(spawnSync("lsappinfo", ["info", "-only", "name", asn], { encoding: "utf8", timeout: 2000 }).stdout ?? "");
};
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => Promise<boolean>, timeout = 3000): Promise<boolean> => {
  const deadline = Date.now() + timeout;
  do { if (await check()) return true; await settle(25); } while (Date.now() < deadline);
  return false;
};

/** Shaped like what settings-model produces, including a refused shortcut. */
const view = (language: Language): SettingsView => {
  const zh = language === "zh-TW";
  return {
    language,
    title: zh ? "RecordStuff - 設定" : "RecordStuff - Settings",
    hint: "",
    failure: zh
      ? "無法套用此設定，已顯示目前的設定。"
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
        note: zh ? "這個快捷鍵可能被其他 App 佔用。" : "Another app may be using this shortcut.",
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
        info: zh ? "macOS 另外還要在「系統設定 → 通知」中允許 RecordStuff。" : "macOS must also allow RecordStuff in System Settings → Notifications.",
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
let resultContext: AppContext | undefined;
/** Set by the countdown sound case (plan 046): main answers its switch from the real model. */
let soundContext: AppContext | undefined;
/** Set by the update focus case (plan 053): a check answers at once and pushes its progress, as main does. */
let updateContext: AppContext | undefined;
let resultSaveFails = false;
/** Every durable result save waits, so replies arrive after Chromium's focus fixup (plan 036). */
let saveDelayMs = 120;
/** Mutated only by the automatic-retry case; otherwise no background retry can race scripted steps. */
const retryDelays = [3_600_000];
let panel: BrowserWindow | undefined;
let lastFocus = 0;
/** Like SettingsWindow: every projection carries the current entry token. */
const resultView = (): SettingsView => ({ ...settingsView({ type: "idle" }, { ...resultContext!, recordingResults: recordingResults.all,
  historyLoading: recordingResults.loading }), resultFocus: lastFocus });
/** Production refreshes push the committed view before an action's reply arrives. */
const pushCurrent = (): void => { if (resultContext && panel && !panel.isDestroyed()) panel.webContents.send("settings:changed", resultView()); };
const recordingResults = new RecordingResults({ load: async () => [], save: async () => {
  await settle(saveDelayMs);
  if (resultSaveFails) throw new Error("controlled storage failure");
} }, () => {}, pushCurrent, retryDelays);
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
ipcMain.handle("settings:choose", async (_event, group: string, choice: string) => {
  chooseCalls.push([group, choice]);
  if (group.startsWith("recordingResult:") && resultContext) {
    const ctx = { ...resultContext, recordingResults: recordingResults.all };
    const action = settingsAction({ type: "idle" }, ctx, group, choice);
    const applied = typeof action === "object" && "recordingResult" in action
      && await recordingResults.act(action.recordingResult.id, action.recordingResult.action, {
        stat: async () => ({ isFile: () => true, size: 1 }), refresh: pushCurrent, settled: () => true,
        platform: "darwin", reveal: () => {}, folder: async () => {}, permission: async () => {}, relaunch: async () => {},
      });
    return { applied, view: resultView() };
  }
  if (group === "countdownSound" && soundContext) {
    const action = settingsAction({ type: "idle" }, soundContext, group, choice);
    if (typeof action === "object" && "setCountdownSound" in action) soundContext = { ...soundContext, countdownSound: action.setCountdownSound };
    return { view: settingsView({ type: "idle" }, soundContext), applied: action !== undefined };
  }
  if (group === "updates" && updateContext) {
    const action = settingsAction({ type: "idle" }, updateContext, group, choice);
    if (action === "checkUpdates") {
      updateContext = { ...updateContext, updates: { ...updateContext.updates, state: { kind: "checking", previous: { kind: "current", checkedAt: 1000 } } } };
      panel?.webContents.send("settings:changed", settingsView({ type: "idle" }, updateContext));
    }
    return { view: settingsView({ type: "idle" }, updateContext), applied: action !== undefined };
  }
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

/** A page-side failure names its script, so a crashed fixture says which step threw. */
const read = <T = unknown>(window: BrowserWindow, script: string): Promise<T> =>
  (window.webContents.executeJavaScript(script) as Promise<T>).catch((error: unknown) => {
    throw new Error(`${String(error)} in: ${script.trim().split("\n")[0]!.slice(0, 160)}`);
  });

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
  // Plan 057: a case that needs an active window is judged only if its window stayed active.
  let blurs = 0;
  let shown = false;
  window.on("blur", () => { blurs += 1; });
  const windowState = async (): Promise<WindowState> => ({ focused: window.isFocused(), visible: window.isVisible(),
    page: await read<string>(window, `document.documentElement.dataset.window ?? ""`).catch(() => "unreadable") });
  /** Asks for activation the way SettingsWindow does when the window is not active, then waits for it to hold. */
  const activate = async (): Promise<WindowState> => {
    shown = true;
    let state = await windowState();
    if (windowActive(state)) return state;
    if (process.platform === "darwin") app.focus({ steal: true });
    window.show(); window.focus();
    await until(async () => windowActive(state = await windowState()), 2000);
    return state;
  };
  type Span = { before: WindowState; blurs: number };
  /** Starts one interaction whose activation-dependent cases `recordActive` judges against it. */
  const activeSpan = async (): Promise<Span> => {
    const before = await activate();
    return { before, blurs };
  };
  /** Activation from the span's start until now; taken when the measurement ends for a case recorded later. */
  const spanActivation = async (span: Span): Promise<Activation> => activation(span.before, await windowState(), blurs - span.blurs, frontmost);
  const recordActive = async (span: Span | Activation, name: string, ok: boolean, detail: string): Promise<void> => {
    push(judgeActive(name, "held" in span ? span : await spanActivation(span), ok, detail));
  };
  const shot = async (file: string): Promise<void> => {
    let image: Electron.NativeImage;
    try { image = await window.webContents.capturePage(); }
    catch (error) {
      throw new CaptureFailed({ error: String(error), screenshot: file, window: await windowState().catch(() => undefined), shown, frontmost: frontmost() });
    }
    fs.writeFileSync(path.join(outDir, file), image.toPNG());
  };
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
    rendered.title === "RecordStuff - 設定" && rendered.docTitle === "RecordStuff - 設定" && rendered.lang === "zh-Hant",
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
    rendered.note === "這個快捷鍵可能被其他 App 佔用。" &&
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
      // The ⓘ beside the label has its own cases.
      buttons: [...document.querySelectorAll(".row button:not(.info-button)")].filter(b => !b.closest("[hidden]")).map(b => ({ id: b.id, text: b.textContent, disabled: b.disabled })),
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
      // Busy, not disabled (plan 053): the pane button stays focusable and ignores activation.
      buttonLocked: beforeToggle.button.getAttribute("aria-disabled") === "true" && !beforeToggle.button.disabled,
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
      buttonLocked: beforeToggle.button.disabled || beforeToggle.button.getAttribute("aria-disabled") === "true",
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
    quality: DEFAULT_QUALITY, countdown: 3, countdownSound: true, hotkey: { ...DEFAULT_HOTKEY, registered: true }, notifications: true,
    updates: { enabled: true, state: { kind: "idle" } }, display: { kind: "primary" },
    displays: [{ id: "1", label: "Built-in Display", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: true, primary: true }] };
  for (const lang of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
    nativeTheme.themeSource = scheme;
    for (const size of ["default", "minimum"] as const) {
      window.setSize(size === "default" ? 560 : 380, size === "default" ? 680 : 360);
      for (const state of ["recording", "general", "listening", "error", "locked", "sound-off", "countdown-off"] as const) {
        const snapshot = settingsView(state === "locked" ? { type: "starting" } : { type: "idle" }, {
          ...ctx, language: lang,
          ...(state === "error" ? { display: { kind: "display", id: "2", label: "BenQ BL2480T" }, displayFailure: "target_removed" } : {}),
          // Plan 046: the switch off, and disabled with its value kept while the countdown is Off.
          ...(state === "sound-off" ? { countdownSound: false } : {}),
          ...(state === "countdown-off" ? { countdown: 0 as const } : {}),
        });
        if (state === "listening") snapshot.groups.find(g => g.id === "hotkey")!.capturing = true;
        await read(window, `document.getElementById("tab-${state === "general" || state === "listening" ? "general" : "recording"}").click()`);
        await settle(60);
        window.webContents.send("settings:changed", snapshot);
        await settle(60);
        await read(window, `document.getElementById("settings-panel").scrollTop = 0`);
        if (state === "listening") await read(window, `document.getElementById("shortcut-capture").focus()`);
        else if (state === "sound-off") await read(window, `document.getElementById("setting-countdownSound").focus()`);
        else await read(window, `document.querySelector("#settings-panel select, #settings-panel input")?.focus()`);
        if (state === "sound-off" || state === "countdown-off") await read(window, `document.getElementById("setting-countdownSound-row").scrollIntoView({ block: "nearest" })`);
        await settle(60);
        const fits = await read<boolean>(window, `document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth && document.getElementById("settings-panel").scrollWidth <= document.getElementById("settings-panel").clientWidth`);
        const geometry = await read(window, `({root: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], viewport: [innerWidth, innerHeight], main: document.querySelector("main").getBoundingClientRect().toJSON(), form: document.querySelector("form").getBoundingClientRect().toJSON(), panel: document.getElementById("settings-panel").getBoundingClientRect().toJSON()})`);
        record(`${lang}/${scheme}/${size}/${state}: no horizontal or outer-page overflow`, fits, JSON.stringify(geometry));
        await shot(`panel-${lang}-${scheme}-${size}-${state}.png`);
      }
    }
  }
  // Countdown sound (plan 046): a real click reaches main with the switch's id; under Off it is disabled and sends nothing.
  nativeTheme.themeSource = "light";
  window.setSize(560, 680);
  await read(window, `document.getElementById("tab-recording").click()`);
  const soundSwitch = async (countdown: 0 | 3): Promise<{ x: number; y: number; checked: boolean; disabled: boolean; calls: string; after: boolean }> => {
    soundContext = { ...ctx, countdown };
    window.webContents.send("settings:changed", settingsView({ type: "idle" }, soundContext));
    await settle(80);
    chooseCalls.length = 0;
    const target = await read<{ x: number; y: number; checked: boolean; disabled: boolean }>(window, `(() => {
      const el = document.getElementById("setting-countdownSound"); el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), checked: el.checked, disabled: el.disabled };
    })()`);
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: target.x, y: target.y });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: target.x, y: target.y });
    await settle(150);
    return { ...target, calls: JSON.stringify(chooseCalls), after: await read<boolean>(window, `document.getElementById("setting-countdownSound").checked`) };
  };
  const enabledSound = await soundSwitch(3);
  record("countdown sound: a real click on the checked switch asks main for off and shows the committed off",
    enabledSound.checked && !enabledSound.disabled && enabledSound.calls === '[["countdownSound","off"]]' && !enabledSound.after, JSON.stringify(enabledSound));
  const disabledSound = await soundSwitch(0);
  record("countdown sound: disabled while the countdown is Off, keeping its value, and a click sends nothing",
    disabledSound.checked && disabledSound.disabled && disabledSound.calls === "[]" && disabledSound.after, JSON.stringify(disabledSound));
  soundContext = undefined;
  // The ⓘ beside a label: real hover and real Tab show its explanation in the top layer, inside the window; Escape closes it before the window.
  const infoState = (id: string) => read<{ open: boolean; expanded: string | null; text: string; inside: boolean; describes: boolean }>(window, `(() => {
    const id = ${JSON.stringify(`setting-${id}`)}, popover = document.getElementById(id + "-info"), r = popover.getBoundingClientRect();
    const control = document.querySelector("#" + id + "-row .switch, #" + id + "-row select, #" + id + "-row .segments input");
    return { open: popover.matches(":popover-open"), expanded: document.getElementById(id + "-info-button").getAttribute("aria-expanded"), text: popover.textContent,
      inside: r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      describes: (control?.getAttribute("aria-describedby") ?? "").split(" ").includes(popover.id) }; })()`);
  for (const [lang, size] of [["en", "minimum"], ["zh-TW", "default"]] as const) {
    window.setSize(size === "default" ? 560 : 380, size === "default" ? 680 : 360);
    window.webContents.send("settings:changed", settingsView({ type: "idle" }, { ...ctx, language: lang }));
    await settle(80);
    await read(window, `document.getElementById("tab-recording").click()`); await settle(60);
    const hoverSpan = await activeSpan();
    const at = await read<{ x: number; y: number }>(window, `(() => { const el = document.getElementById("setting-countdownSound-info-button"); el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    window.webContents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y }); await settle(120);
    const hovered = await infoState("countdownSound");
    await shot(`info-hover-${lang}-light-${size}.png`);
    // It sits above the row it explains. The pointer may pause in the gap on the way, here just off the
    // button, longer than the leave grace, and stay on the explanation itself; leaving both hides it.
    const geometry = await read<{ above: boolean; gap: { x: number; y: number }; onto: { x: number; y: number } }>(window, `(() => {
      const b = document.getElementById("setting-countdownSound-info-button").getBoundingClientRect(), r = document.getElementById("setting-countdownSound-info").getBoundingClientRect();
      return { above: r.bottom <= b.top, gap: { x: Math.round(b.x + b.width / 2), y: Math.floor(b.top) - 1 }, onto: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }; })()`);
    window.webContents.sendInputEvent({ type: "mouseMove", x: geometry.gap.x, y: geometry.gap.y }); await settle(300);
    const inGap = await infoState("countdownSound");
    window.webContents.sendInputEvent({ type: "mouseMove", x: geometry.onto.x, y: geometry.onto.y }); await settle(300);
    const kept = await infoState("countdownSound");
    window.webContents.sendInputEvent({ type: "mouseMove", x: 4, y: 4 }); await settle(300);
    const left = await infoState("countdownSound");
    await recordActive(hoverSpan, `${lang}/${size}: hovering the ⓘ shows its explanation above it inside the window, it stays through a pause in the gap and while the pointer is on it, and leaving both hides it`,
      hovered.open && hovered.expanded === "true" && hovered.inside && hovered.describes && hovered.text === (lang === "en" ? "The tick is not recorded." : "提示音不會被錄進影片。")
      && geometry.above && inGap.open && kept.open && !left.open && left.expanded === "false", JSON.stringify({ hovered, geometry, inGap, kept, left }));
    const keySpan = await activeSpan();
    await read(window, `document.querySelector("#setting-videoQuality input:checked").focus()`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" }); await settle(150);
    const tabbed = { active: await read<string>(window, `document.activeElement.id`), ...await infoState("resolutionCap") };
    await shot(`info-focus-${lang}-light-${size}.png`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await settle(120);
    const escaped = { windowOpen: !window.isDestroyed(), ...await infoState("resolutionCap") };
    await recordActive(keySpan, `${lang}/${size}: a real Tab reaches the next ⓘ and shows its explanation; Escape closes it and leaves the window open`,
      tabbed.active === "setting-resolutionCap-info-button" && tabbed.open && tabbed.inside && escaped.windowOpen && !escaped.open, JSON.stringify({ tabbed, escaped }));
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
  // Plan 053: a real Tab and Enter on Check for updates… keep focus on the button through the check.
  updateContext = { ...ctx, updates: { enabled: true, state: updatePrevious } };
  panel = window;
  window.webContents.send("settings:changed", settingsView({ type: "idle" }, updateContext));
  await settle(60);
  chooseCalls.length = 0;
  const updateSpan = await activeSpan();
  await read(window, `document.getElementById("setting-updates-check").scrollIntoView({ block: "center" }); document.getElementById("setting-updateChecks").focus()`);
  // Chromium activates a button on Enter's character event, so Return sends one.
  const key = (keyCode: string) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    if (keyCode === "Return") window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  };
  key("Tab");
  await settle(60);
  const tabbed = await read<string>(window, `document.activeElement.id`);
  key("Return");
  await settle(150);
  const busyCheck = await read<{ active: string; disabled: boolean; ariaDisabled: string | null; label: string; ring: string; windowFocused: boolean }>(window, `(() => {
    const el = document.getElementById("setting-updates-check");
    return { active: document.activeElement.id, disabled: el.disabled, ariaDisabled: el.getAttribute("aria-disabled"), label: el.textContent, ring: getComputedStyle(el).outlineStyle, windowFocused: document.hasFocus() };
  })()`);
  await shot("update-check-busy.png");
  key("Return");
  await settle(100);
  const busyCalls = JSON.stringify(chooseCalls);
  record("real Tab reaches Check for updates… and Enter starts one check", tabbed === "setting-updates-check" && busyCalls === '[["updates","check"]]', JSON.stringify({ tabbed, busyCalls }));
  await recordActive(updateSpan, "a running check keeps keyboard focus and its ring on the busy, focusable button",
    busyCheck.active === "setting-updates-check" && !busyCheck.disabled && busyCheck.ariaDisabled === "true" && busyCheck.label === "Checking for updates…" && busyCheck.ring === "solid",
    JSON.stringify(busyCheck));
  updateContext = { ...updateContext, updates: { enabled: true, state: { kind: "current", checkedAt: 2000 } } };
  window.webContents.send("settings:changed", settingsView({ type: "idle" }, updateContext));
  await settle(80);
  key("Tab");
  await settle(60);
  const afterCheck = await read<{ ariaDisabled: string | null; next: string }>(window, `({ ariaDisabled: document.getElementById("setting-updates-check").getAttribute("aria-disabled"), next: document.activeElement.id })`);
  await shot("update-check-done.png");
  record("after the check, the next Tab continues past the button instead of restarting at the tabs",
    afterCheck.ariaDisabled === "false" && afterCheck.next !== "" && !afterCheck.next.startsWith("tab-") && afterCheck.next !== "setting-updates-check", JSON.stringify(afterCheck));
  updateContext = undefined;
  window.setSize(380, 360);
  await settle(100);
  await read(window, `document.getElementById("settings-panel").scrollTop = 0`);
  await settle(60);
  const scrollTopHint = await read<boolean>(window, `!document.getElementById("scroll-hint").hidden && getComputedStyle(document.getElementById("scroll-hint")).pointerEvents === "none"`);
  record("overflow shows non-interactive glass scroll cue", scrollTopHint, String(scrollTopHint));
  await shot("panel-scroll-cue.png");
  // Real Tabs down the overflowing panel: the scroll padding keeps each focused control above the cue, never under it.
  await read(window, `document.querySelector('[role="tab"][aria-selected="true"]').focus()`);
  const tabbedUnderCue: string[] = [];
  let tabbedScroll = 0;
  for (let step = 0; step < 24; step += 1) {
    key("Tab");
    await settle(60);
    const focus = await read<{ id: string; covered: boolean; scrollTop: number }>(window, `(() => {
      const cue = document.getElementById("scroll-hint"), active = document.activeElement, panel = document.getElementById("settings-panel");
      const hint = cue.getBoundingClientRect(), box = active.getBoundingClientRect();
      return { id: active.id || active.tagName, covered: panel.contains(active) && !cue.hidden && box.bottom > hint.top + 1 && box.top < hint.bottom, scrollTop: panel.scrollTop };
    })()`);
    if (focus.covered) tabbedUnderCue.push(focus.id);
    tabbedScroll = Math.max(tabbedScroll, focus.scrollTop);
  }
  record("a real Tab never leaves the focused control under the scroll cue", tabbedScroll > 0 && tabbedUnderCue.length === 0, JSON.stringify({ tabbedScroll, tabbedUnderCue }));
  await read(window, `document.getElementById("settings-panel").scrollTop = document.getElementById("settings-panel").scrollHeight`);
  await settle(60);
  const bottomHint = await read<boolean>(window, `document.getElementById("scroll-hint").hidden`);
  record("scroll cue disappears at the bottom", bottomHint, String(bottomHint));
  // Tall enough for the Recording tab, which since plan 048's Output folder row scrolls slightly at the 560 × 680 default.
  window.setSize(560, 760);
  await read(window, `document.getElementById("tab-recording").click()`);
  await settle(100);
  const fitting = await read<{ hidden: boolean; scrollHeight: number; clientHeight: number; tab: string }>(window, `({ hidden: document.getElementById("scroll-hint").hidden,
    scrollHeight: document.getElementById("settings-panel").scrollHeight, clientHeight: document.getElementById("settings-panel").clientHeight,
    tab: document.querySelector('[role="tab"][aria-selected="true"]').id })`);
  record("fitting content needs no scroll cue", fitting.hidden && fitting.scrollHeight <= fitting.clientHeight + 2, JSON.stringify(fitting));
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
  // Each interaction below starts its own span, so a blur in one does not decide the next (review of 057).
  const retrySpan = await activeSpan();
  // A retried action disables its buttons while it runs, so its hidden Retry cannot keep focus: focus must come back, not fall to the page.
  await read(window, `document.getElementById("setting-about-retry").focus()`);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
  await settle(150);
  const retryFocus = await read<{ active: string; retryShown: boolean }>(window, `({ active: document.activeElement.id, retryShown: !document.getElementById("setting-about-retry").hidden })`);
  // Focus comes back only to a focused document (settings.ts), so this needs an active window.
  await recordActive(retrySpan, "real key on a failed link's Retry keeps focus in its row, not on the page", retryFocus.retryShown && retryFocus.active.startsWith("setting-about-"), JSON.stringify(retryFocus));
  const tabSpan = await activeSpan();
  await read(window, `(() => { const s = document.getElementById("setting-hotkey"); s.value = "custom"; s.dispatchEvent(new Event("change")); })()`);
  await settle(100);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await settle(100);
  const tabExit = await read<string>(window, `document.activeElement.id`);
  // Notifications' ⓘ comes first, then its switch.
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await settle(100);
  const tabNext = await read<string>(window, `document.activeElement.id`);
  await recordActive(tabSpan, "real Tab exits capture to the next visible preference, its ⓘ and then its switch",
    tabExit === "setting-notifications-info-button" && tabNext === "setting-notifications", JSON.stringify({ tabExit, tabNext }));
  const backSpan = await activeSpan();
  await read(window, `(() => { const s = document.getElementById("setting-hotkey"); s.value = "custom"; s.dispatchEvent(new Event("change")); })()`);
  await settle(100);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers: ["shift"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers: ["shift"] });
  await settle(100);
  const backExit = await read<string>(window, `document.activeElement.id`);
  // Recorded after the capture cases below, but judged on this interaction.
  const backActivation = await spanActivation(backSpan);
  const keyboardRing = await read<boolean>(window, `getComputedStyle(document.getElementById("setting-hotkey")).outlineStyle === "solid"`);
  await recordActive(backSpan, "keyboard navigation retains a visible focus ring", keyboardRing, String(keyboardRing));
  await read(window, `document.getElementById("setting-hotkey").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  const pointerRing = await read<boolean>(window, `getComputedStyle(document.getElementById("setting-hotkey")).outlineStyle === "none"`);
  await recordActive(backSpan, "pointer interaction removes the ring without discarding DOM focus", pointerRing && backExit === "setting-hotkey", String(pointerRing));
  // One capture session: a blur cancels it, so its three cases share a span.
  const listenSpan = await activeSpan();
  await read(window, `(() => { const s = document.getElementById("setting-hotkey"); s.value = "custom"; s.dispatchEvent(new Event("change")); })()`);
  await settle(100);
  const listening = await read<boolean>(window, `document.querySelectorAll("#shortcut-capture .listening-indicator span").length === 3 && !document.querySelector(".capture-area").hidden`);
  await recordActive(listenSpan, "acknowledged capture displays a listening indicator", listening, String(listening));
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "F12", modifiers: ["control"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "F12", modifiers: ["control"] });
  await settle(80);
  const keycaps = await read<string[]>(window, `[...document.querySelectorAll("#shortcut-capture kbd")].map(k => k.textContent)`);
  await recordActive(listenSpan, "real Control+F12 keeps the named key in one keycap", JSON.stringify(keycaps) === '["⌃","F12"]', JSON.stringify(keycaps));
  await shot("shortcut-f12.png");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await settle(100);
  const tabToConfirm = await read<{ active: string; open: boolean; enabled: boolean }>(window, `({ active: document.activeElement.id,
    open: !document.querySelector(".capture-area").hidden, enabled: !document.getElementById("shortcut-confirm").disabled })`);
  await recordActive(listenSpan, "real Tab with a candidate reaches Confirm and keeps the editor open", tabToConfirm.active === "shortcut-confirm" && tabToConfirm.open && tabToConfirm.enabled, JSON.stringify(tabToConfirm));
  await read(window, `document.getElementById("shortcut-cancel").click()`);
  await settle(100);
  await recordActive(backActivation, "real Shift+Tab exits capture to its preceding edit action", backExit === "setting-hotkey", backExit);
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
  window.setSize(560, 680);
  await settle(100);
  const forced = await read<boolean>(window, `matchMedia("(forced-colors: active)").matches && getComputedStyle(document.getElementById("setting-notifications")).appearance === "auto" && getComputedStyle(document.getElementById("setting-language-en")).appearance === "auto"`);
  record("forced colors restore native checkbox and radio appearance", forced, String(forced));
  await shot("panel-forced-colors.png");
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reduced = await read<boolean>(window, `getComputedStyle(document.querySelector(".listening-indicator span")).animationName === "none"`);
  record("reduced motion disables the listening animation", reduced, String(reduced));
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
  window.webContents.debugger.detach();
  await shot("panel.png");
  // Real mouse/keyboard on the built panel; production result model and acknowledgement.
  await activate(); window.setSize(380, 360);
  const failure = { id: "fixture-failure", occurredAt: "2026-09-24T12:00:00Z", code: "disk_full" as const,
    detail: "ENOSPC: controlled fixture", outcome: "pending" as const };
  recordingResults.update(failure);
  panel = window;
  const pushResult = async (lang: Language, focus = 0) => {
    resultContext = { ...ctx, language: lang, notifications: false, recordingResults: recordingResults.all };
    lastFocus = focus;
    window.webContents.send("settings:changed", resultView());
    await settle(120);
  };
  /** Rows start collapsed (plan 047): open the one holding `selector` with a real Return on its header. */
  const openRowWith = async (selector: string): Promise<void> => {
    const rowId = await read<string>(window, `document.querySelector(${JSON.stringify(selector)})?.closest(".recording-result")?.id ?? ""`);
    if (!rowId || await read<boolean>(window, `document.getElementById(${JSON.stringify(rowId)}).open`)) return;
    await read(window, `document.getElementById(${JSON.stringify(rowId)}).querySelector(":scope > summary").focus()`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    if (!await until(() => read<boolean>(window, `document.getElementById(${JSON.stringify(rowId)}).open`))) throw new Error(`Could not open ${rowId}`);
  };
  await pushResult("zh-TW", 1);
  record("recording failure visible immediately with notifications off; pending result cannot be acknowledged",
    await read<boolean>(window, `document.querySelector(".recording-result").open && document.querySelector('.recording-result [data-action="acknowledge"]').disabled && document.querySelector(".result-outcome").textContent.includes("正在處理錄影") && document.activeElement === document.querySelector(".recording-result > summary")`), "pending and focus");
  recordingResults.update({ ...failure, outcome: "partial", partialPath: "/tmp/錄影資料夾/2026-09-24 20-00-00.recording.mp4" });
  for (const lang of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
    nativeTheme.themeSource = scheme;
    await pushResult(lang, 2);
    const fits = await read<boolean>(window, `(() => { const a = document.querySelector(".recording-result"); return a.scrollWidth <= a.clientWidth && [...a.querySelectorAll("button")].every(b => b.scrollWidth <= b.clientWidth); })()`);
    record(`result ${lang}/${scheme} at minimum size fits`, fits, "partial warning and actions");
    await shot(`result-${lang}-${scheme}.png`);
  }
  // Focus after a result action returns only to a focused document (restoreResultFocus), so these need an active window.
  const ackSpan = await activeSpan();
  await read(window, `document.querySelector('.recording-result [data-action="acknowledge"]').scrollIntoView({block:"center"})`);
  const click = await read<{ x: number; y: number }>(window, `(() => { const r = document.querySelector('.recording-result [data-action="acknowledge"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...click });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...click });
  await until(async () => recordingResults.current?.acknowledged === true && await read<boolean>(window, `!document.querySelector(".recording-result").open && document.activeElement === document.querySelector(".recording-result > summary")`));
  await recordActive(ackSpan, "real mouse Got it acknowledges only the offered result and collapses it",
    recordingResults.current?.acknowledged === true && await read<boolean>(window, `!document.querySelector(".recording-result").open && document.activeElement === document.querySelector(".recording-result > summary")`),
    JSON.stringify({ call: chooseCalls.at(-1), result: recordingResults.current, ui: await read(window, `({open: document.querySelector(".recording-result").open, active: document.activeElement.id, tag: document.activeElement.tagName, documentFocused: document.hasFocus(), windowFocused: ${window.isFocused()}})`) }));
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await recordActive(ackSpan, "acknowledged result can be reopened with keyboard", await until(() => read<boolean>(window, `document.querySelector(".recording-result").open`)), "Return on summary");
  // Explicit entry reopens an acknowledged result even after the user collapses it.
  await pushResult("zh-TW", 3);
  record("explicit result entry expands and focuses an acknowledged result",
    await read<boolean>(window, `document.querySelector(".recording-result").open && document.activeElement === document.querySelector(".recording-result > summary")`), "focus token");
  recordingResults.update({ ...failure, id: "new-failure" });
  await pushResult("en", 3);
  // Without an entry the new row stays collapsed; it is unread, counted on the tab and still pending (plan 047).
  record("a new failure becomes unread while notifications are disabled",
    !recordingResults.current!.acknowledged && await read<boolean>(window, `(() => { const row = document.querySelector(".recording-result"); return row.classList.contains("unread") && !row.open && row.querySelector('[data-action="acknowledge"]').disabled && document.getElementById("tab-failures").textContent === "Failures (1)"; })()`), "new identity");
  recordingResults.update({ ...failure, id: "new-failure", outcome: "empty" });
  await pushResult("en", 3);
  await openRowWith('.recording-result [data-action="acknowledge"]');
  await read(window, `document.querySelector('.recording-result [data-action="acknowledge"]').scrollIntoView({block:"center"})`);
  const staleClick = await read<{ x: number; y: number }>(window, `(() => { const r = document.querySelector('.recording-result [data-action="acknowledge"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...staleClick });
  await settle(50);
  recordingResults.update({ ...failure, id: "replacement-failure" });
  recordingResults.update({ ...failure, id: "replacement-failure", outcome: "empty" });
  await pushResult("en", 3);
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...staleClick });
  await settle(100);
  record("mouse press on previous result cannot acknowledge its replacement",
    recordingResults.current?.id === "replacement-failure" && !recordingResults.current.acknowledged, "new buttons retain exact result identity");
  resultSaveFails = true;
  recordingResults.update({ ...failure, id: "persistence-failure" });
  recordingResults.update({ ...failure, id: "persistence-failure", outcome: "empty" });
  await recordingResults.persist();
  for (const lang of ["en", "zh-TW"] as const) {
    await pushResult(lang, 4);
    const warning = await read<boolean>(window, `(() => { const el = document.querySelector(".result-persistence"); return !el.hidden && el.textContent.length > 0 && el.scrollWidth <= el.clientWidth; })()`);
    record(`persistence failure ${lang} stays readable at minimum size`, warning, warning ? "retention warning" : JSON.stringify({
      main: recordingResults.all.map(r => [r.id, r.acknowledged, r.saving, r.persistenceFailed]),
      dom: await read(window, `[...document.querySelectorAll(".recording-result")].map(a => [a.dataset.resultId, a.open, !a.querySelector(".result-persistence").hidden, a.getAttribute("aria-busy")])`) }));
    await shot(`result-persistence-${lang}.png`);
  }
  /** Main's rows, in order, as the DOM must show them before a real click is aimed. */
  const domMatchesMain = () => read<boolean>(window, `JSON.stringify([...document.querySelectorAll(".recording-result")].map(a => [a.dataset.resultId, !a.querySelector(".result-persistence").hidden]))
    === ${JSON.stringify(JSON.stringify(recordingResults.all.map(r => [r.id, Boolean(r.persistenceFailed)])))}`);
  const clickAck = async (expected: () => Promise<boolean>, action = "acknowledge") => {
    if (!await until(domMatchesMain)) throw new Error(`Rendered rows differ from main before ${action}: ${JSON.stringify({
      main: recordingResults.all.map(r => [r.id, Boolean(r.persistenceFailed)]),
      dom: await read(window, `[...document.querySelectorAll(".recording-result")].map(a => [a.dataset.resultId, !a.querySelector(".result-persistence").hidden])`) })}`);
    const callsBefore = chooseCalls.length;
    await openRowWith(`.recording-result [data-action="${action}"]`);
    await read(window, `document.querySelector('.recording-result [data-action="${action}"]').scrollIntoView({block:"center"})`);
    const point = await read<{ x: number; y: number }>(window, `(() => { const r = document.querySelector('.recording-result [data-action="${action}"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    if (!await until(async () => chooseCalls.length > callsBefore && await expected()))
      throw new Error(`Timed out waiting for recording-result ${action} UI: ${JSON.stringify({ point, calls: chooseCalls.slice(callsBefore),
        main: recordingResults.all.map(r => [r.id, r.acknowledged, r.saving, r.persistenceFailed]),
        dom: await read(window, `[...document.querySelectorAll(".recording-result")].map(a => ({ id: a.dataset.resultId, open: a.open, error: !a.querySelector(".result-error").hidden,
          top: Math.round(a.getBoundingClientRect().top), actions: [...a.querySelectorAll(".result-actions button")].map(b => [b.dataset.action, b.getAttribute("aria-disabled"), Math.round(b.getBoundingClientRect().y)]) }))`),
        hit: await read(window, `(() => { const el = document.elementFromPoint(${point.x}, ${point.y}); return el ? (el.id || el.tagName) : null; })()`) })}`);
  };
  await clickAck(() => read<boolean>(window, `!document.querySelector(".result-error").hidden`));
  record("failed durable acknowledgement stays unread and expanded", !recordingResults.current?.acknowledged &&
    await read<boolean>(window, `document.querySelector(".recording-result").open && !document.querySelector(".result-persistence").hidden && !document.querySelector(".result-error").hidden`), "failed save");
  resultSaveFails = false;
  await clickAck(() => read<boolean>(window, `document.querySelector(".result-persistence").hidden && document.querySelector(".recording-result").open`), "retry");
  record("retry saving an unread failure does not acknowledge or collapse it", !recordingResults.current?.acknowledged && !recordingResults.current?.persistenceFailed, "independent persistence retry");
  await clickAck(() => read<boolean>(window, `document.querySelector(".result-persistence").hidden && !document.querySelector(".recording-result").open`));
  record("retry durably acknowledges and clears the persistence warning", recordingResults.current?.acknowledged === true &&
    await read<boolean>(window, `!document.querySelector(".recording-result").open && document.querySelector(".result-persistence").hidden`), "save recovered");
  resultSaveFails = true;
  recordingResults.update({ ...failure, id: "persistence-failure", outcome: "unknown", detail: "recheck changed an acknowledged result" });
  await recordingResults.persist();
  for (const lang of ["en", "zh-TW"] as const) {
    await pushResult(lang, 5);
    if (!await read<boolean>(window, `document.querySelector(".recording-result").open`)) {
      await read(window, `document.querySelector(".recording-result > summary").focus()`);
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      if (!await until(() => read<boolean>(window, `document.querySelector(".recording-result").open`))) throw new Error("History summary did not open");
    }
    record(`acknowledged ${lang} result offers a readable save retry`, await read<boolean>(window, `(() => { const b = document.querySelector('.recording-result [data-action="retry"]'); return !b.disabled && b.scrollWidth <= b.clientWidth && b.textContent.includes(${JSON.stringify(lang === "en" ? "Retry saving the record" : "重試儲存紀錄")}); })()`), "acknowledged persistence failure");
    await shot(`result-retry-${lang}.png`);
  }
  await clickAck(() => read<boolean>(window, `!document.querySelector(".result-error").hidden`), "retry");
  record("failed acknowledged retry does not claim an unread record", recordingResults.current?.acknowledged === true &&
    await read<boolean>(window, `document.querySelector(".result-error").textContent === "無法完成此操作，請重試。" && !document.querySelector(".result-persistence").hidden`), "acknowledged failure copy");
  resultSaveFails = false;
  await clickAck(() => read<boolean>(window, `document.querySelector(".result-persistence").hidden && document.querySelector(".result-error").hidden`), "retry");
  record("acknowledged result save retry removes warning without making it unread", recordingResults.current?.acknowledged === true && !recordingResults.current.persistenceFailed, "retry acknowledged state");
  record("consecutive failures remain individually visible", await read<boolean>(window, `document.querySelectorAll(".recording-result").length === 4 && new Set([...document.querySelectorAll(".result-actions button")].map(b => b.id)).size === document.querySelectorAll(".result-actions button").length`), "four identities with unique action IDs");
  for (const lang of ["en", "zh-TW"] as const) {
    window.setSize(560, 680); await pushResult(lang, 6);
    await read(window, `document.getElementById("settings-panel").scrollTop = 0`);
    await shot(`history-${lang}.png`);
  }
  await clickAck(() => read<boolean>(window, `document.querySelectorAll(".recording-result").length === 3`), "remove");
  record("removing reviewed metadata preserves other unread failures", recordingResults.all.length === 3 && recordingResults.all.some(r => !r.acknowledged), "remove one reviewed record");
  await read(window, `document.getElementById("feedback").textContent = ""`);
  await pushResult("en", 6);
  record("language changes do not announce the entire failure history", await read<boolean>(window, `!document.getElementById("feedback").textContent.includes("The disk is full")`), "localized outcomes are not new events");
  for (const result of [...recordingResults.all]) await recordingResults.acknowledge(result.id);
  await pushResult("en", 7);
  // Removing the lowest row by keyboard keeps focus on the row above it, in view (plan 035 D3).
  if (recordingResults.all.length >= 2) {
    const count = recordingResults.all.length;
    const key = (keyCode: string): void => {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    };
    const lowest = `document.querySelectorAll(".recording-result")[${count - 1}]`;
    const lowestSpan = await activeSpan();
    await read(window, `${lowest}.querySelector("summary").focus()`);
    if (!await read<boolean>(window, `${lowest}.open`)) {
      key("Return");
      if (!await until(() => read<boolean>(window, `${lowest}.open`))) throw new Error("Could not open the lowest reviewed row");
    }
    await read(window, `${lowest}.querySelector('[data-action="remove"]').focus()`);
    key("Space");
    const removed = await until(() => read<boolean>(window, `document.querySelectorAll(".recording-result").length === ${count - 1}`));
    await recordActive(lowestSpan, "removing the lowest row by keyboard moves focus to the row above it and keeps it in view",
      removed && await until(() => read<boolean>(window, `(() => {
        const rows = document.querySelectorAll(".recording-result > summary");
        const target = rows[rows.length - 1];
        const box = target?.getBoundingClientRect(), panel = document.getElementById("settings-panel").getBoundingClientRect();
        return document.activeElement === target && box.top >= panel.top && box.bottom <= panel.bottom;
      })()`)), JSON.stringify(await read(window, `({ active: document.activeElement?.id, rows: document.querySelectorAll(".recording-result").length })`)));
  }
  const emptySpan = await activeSpan();
  while (recordingResults.all.length) {
    if (!await read<boolean>(window, `document.querySelector(".recording-result").open`)) {
      await read(window, `document.querySelector(".recording-result > summary").focus()`);
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      if (!await until(() => read<boolean>(window, `document.querySelector(".recording-result").open`))) throw new Error("Could not open reviewed row");
    }
    const before = recordingResults.all.length;
    await clickAck(() => read<boolean>(window, `document.querySelectorAll(".recording-result").length === ${before - 1}`), "remove");
  }
  await recordActive(emptySpan, "removing the final reviewed row returns keyboard focus to the failures tab and shows the empty state", await read<boolean>(window, `document.activeElement.id === "tab-failures" && !document.querySelector(".recording-result") && !document.querySelector(".result-empty").hidden`), "empty history focus");
  await pushResult("en", 8);
  recordingResults.update({ ...failure, id: "after-empty-history" });
  await pushResult("en", 8);
  record("an empty-history entry request cannot make a later failure steal focus", await read<boolean>(window, `document.activeElement.id === "tab-failures"`), "focus request consumed while empty");
  const clear = async () => {
    for (const result of [...recordingResults.all]) {
      if (result.outcome === "pending") recordingResults.update({ ...result, outcome: "empty" });
      await recordingResults.acknowledge(result.id); await recordingResults.remove(result.id);
    }
    await pushResult("en", lastFocus);
  };
  await clear();
  // Plan 036: loading, automatic retry and durable replies slower than one frame, with real input.
  const saving = { en: "Saving this change…", "zh-TW": "正在儲存這項變更…" } as const;
  for (const lang of ["en", "zh-TW"] as const) {
    window.webContents.send("settings:changed", { ...settingsView({ type: "idle" }, { ...ctx, language: lang, historyLoading: true, recordingResults: [] }), resultFocus: lastFocus });
    await settle(120);
    record(`history loading status ${lang} is readable without rows`, await read<boolean>(window, `(() => { const el = document.querySelector(".result-history-status"); return !el.hidden && el.textContent === ${JSON.stringify(lang === "en" ? "Loading failure history…" : "正在載入失敗紀錄…")} && el.scrollWidth <= el.clientWidth && !document.querySelector(".recording-result"); })()`), "loading projection");
    await shot(`history-loading-${lang}.png`);
  }
  await pushResult("en", lastFocus);
  retryDelays[0] = 300; resultSaveFails = true;
  recordingResults.update({ ...failure, id: "auto-retry" }); recordingResults.update({ ...failure, id: "auto-retry", outcome: "empty" });
  await recordingResults.persist();
  await pushResult("en", ++lastFocus);
  const autoWarning = await read<boolean>(window, `!document.querySelector(".result-persistence").hidden && document.querySelector(".result-persistence").textContent.includes("keeps retrying")`);
  resultSaveFails = false;
  record("automatic retry clears the persistence warning without acknowledging", autoWarning && await until(async () => !recordingResults.current?.persistenceFailed
    && await read<boolean>(window, `document.querySelector(".result-persistence").hidden && document.querySelector(".recording-result").open`)) && !recordingResults.current?.acknowledged, "300 ms controlled backoff");
  retryDelays[0] = 3_600_000;
  await clear();
  const point = async (selector: string) => {
    await read(window, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"center"})`);
    return read<{ x: number; y: number }>(window, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
  };
  const mouse = async (selector: string) => {
    const at = await point(selector);
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...at });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...at });
  };
  const press = (keyCode: string) => { window.webContents.sendInputEvent({ type: "keyDown", keyCode }); window.webContents.sendInputEvent({ type: "keyUp", keyCode }); };
  const focusState = () => read(window, `({ active: document.activeElement.id || document.activeElement.tagName, documentFocused: document.hasFocus(), windowFocused: ${window.isFocused()} })`);
  for (const [delay, lang] of [[150, "en"], [2000, "zh-TW"]] as const) {
    saveDelayMs = delay;
    const row = (id: string) => `#recording-result-${id}`;
    const acked = `delayed-${delay}`, moved = `moved-${delay}`;
    recordingResults.update({ ...failure, id: acked }); recordingResults.update({ ...failure, id: acked, outcome: "empty" });
    await recordingResults.persist();
    await pushResult(lang, ++lastFocus);
    const delayedSpan = await activeSpan();
    await mouse(`${row(acked)} [data-action="acknowledge"]`);
    await settle(60);
    const waiting = await read<{ busy: boolean; focused: boolean; text: string; unread: boolean }>(window, `(() => { const b = document.querySelector('${row(acked)} [data-action="acknowledge"]'); return { busy: b?.getAttribute("aria-disabled") === "true" && !b.disabled, focused: document.activeElement === b, text: document.querySelector('${row(acked)} .result-saving').textContent, unread: document.querySelector('${row(acked)}').open }; })()`);
    record(`${delay} ms save keeps the busy Got it focusable, unread and labelled (${lang})`, waiting.busy && waiting.focused && waiting.unread && waiting.text === saving[lang], JSON.stringify(waiting));
    if (delay === 2000) for (const scheme of ["light", "dark"] as const) {
      nativeTheme.themeSource = scheme; await settle(150);
      await shot(`result-saving-${lang}-${scheme}.png`);
    }
    const collapsed = () => read<boolean>(window, `!document.querySelector('${row(acked)}').open && document.activeElement === document.querySelector('${row(acked)} > summary')`);
    await recordActive(delayedSpan, `${delay} ms delayed real mouse Got it acknowledges only the offered result and collapses it`,
      await until(async () => recordingResults.all.find(r => r.id === acked)?.acknowledged === true && await collapsed(), delay + 3000),
      JSON.stringify({ result: recordingResults.all.find(r => r.id === acked), ui: await focusState() }));
    press("Return");
    await recordActive(delayedSpan, `${delay} ms delayed acknowledged result can be reopened with keyboard`, await until(() => read<boolean>(window, `document.querySelector('${row(acked)}').open`)), "Return on summary");
    recordingResults.update({ ...failure, id: moved }); recordingResults.update({ ...failure, id: moved, outcome: "empty" });
    await recordingResults.persist();
    await pushResult(lang, ++lastFocus);
    const tab = await read<string>(window, `document.querySelector('[role="tab"][aria-selected="true"]').id`);
    const movedSpan = await activeSpan();
    await mouse(`${row(moved)} [data-action="acknowledge"]`);
    await settle(40);
    await mouse(`#${tab}`);
    await until(async () => recordingResults.all.find(r => r.id === moved)?.acknowledged === true, delay + 3000);
    await settle(200);
    await recordActive(movedSpan, `${delay} ms focus moved during the wait is not stolen back`, await read<boolean>(window, `document.activeElement.id === ${JSON.stringify(tab)} && !document.querySelector('${row(moved)}').open`), JSON.stringify(await focusState()));
    const removalSpan = await activeSpan();
    for (const id of [moved, acked]) {
      if (!await read<boolean>(window, `document.querySelector('${row(id)}').open`)) {
        await read(window, `document.querySelector('${row(id)} > summary').focus()`); press("Return");
        if (!await until(() => read<boolean>(window, `document.querySelector('${row(id)}').open`))) throw new Error(`Could not open ${id}`);
      }
      await mouse(`${row(id)} [data-action="remove"]`);
      if (!await until(() => read<boolean>(window, `!document.querySelector('${row(id)}')`), delay + 3000)) throw new Error(`Could not remove ${id}`);
    }
    await recordActive(removalSpan, `${delay} ms delayed removal of the final reviewed row returns keyboard focus to the active tab`,
      await until(() => read<boolean>(window, `document.activeElement.id === ${JSON.stringify(tab)} && !document.querySelector(".recording-result")`)), JSON.stringify(await focusState()));
  }
  saveDelayMs = 120;
  // Plan 047: the failures tab with real mouse and keyboard input on the production model and panel.
  await clear();
  window.setSize(380, 360);
  const day = (daysAgo: number, hour: number): string => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 5, 0, 0); return d.toISOString(); };
  // Oldest first, so the newest ends up first; the only unread row is the oldest, at the bottom.
  const seed: Array<[string, number, number, boolean]> = [["t-old-unread", 6, 12, false], ["t-old", 5, 12, true], ["t-y1", 1, 9, true], ["t-y2", 1, 18, true],
    ["t-d1", 0, 1, true], ["t-d2", 0, 2, true], ["t-d3", 0, 3, true]];
  for (const [id, daysAgo, hour, reviewed] of seed) {
    // A new record arrives pending, as production publishes it, then settles.
    recordingResults.update({ ...failure, id, occurredAt: day(daysAgo, hour) });
    recordingResults.update({ ...failure, id, occurredAt: day(daysAgo, hour), outcome: "empty" });
    if (reviewed) await recordingResults.acknowledge(id);
  }
  await recordingResults.persist();
  const selected = () => read<string>(window, `document.querySelector('[role="tab"][aria-selected="true"]').id`);
  const tabFailuresLabel = () => read<string>(window, `document.getElementById("tab-failures").textContent`);
  for (const lang of ["en", "zh-TW"] as const) {
    await pushResult(lang, lastFocus);
    await mouse("#tab-recording");
    await settle(80);
    const recordingTab = await read<boolean>(window, `!document.getElementById("recording-results") && !document.querySelector(".recording-result")`);
    await mouse("#tab-general");
    await settle(80);
    const generalTab = await read<boolean>(window, `!document.getElementById("recording-results") && !document.querySelector(".recording-result")`);
    record(`${lang}: a normal open shows no history in the Recording and General tabs`, recordingTab && generalTab, JSON.stringify({ recordingTab, generalTab }));
    // Lines are counted from the rendered text, since stretched buttons share a height even when one wraps.
    const strip = await read<{ fits: boolean; lines: number[]; labels: string[] }>(window, `(() => { const tabs = [...document.querySelectorAll('[role="tab"]')];
      const lines = tabs.map(t => { const range = document.createRange(); range.selectNodeContents(t); return new Set([...range.getClientRects()].map(r => Math.round(r.top))).size; });
      return { fits: tabs.every(t => t.scrollWidth <= t.clientWidth), lines, labels: tabs.map(t => t.textContent) }; })()`);
    record(`${lang}: the three tab labels fit the 380 pt window without wrapping or truncation`, strip.fits && strip.lines.every(n => n === 1)
      && strip.labels[2] === (lang === "en" ? "Failures (1)" : "失敗紀錄（1）"), JSON.stringify(strip));
    for (const scheme of ["light", "dark"] as const) {
      nativeTheme.themeSource = scheme; await settle(120);
      await mouse("#tab-recording"); await settle(60);
      await shot(`tabs-${lang}-${scheme}-minimum.png`);
    }
    nativeTheme.themeSource = "light";
  }
  // Arrow keys, Home and End cover all three tabs.
  await mouse("#tab-recording"); await settle(60);
  const tabKeys: string[] = [];
  for (const keyCode of ["Right", "Right", "Right", "End", "Home", "Left"]) { press(keyCode); await settle(60); tabKeys.push(await selected()); }
  record("keyboard navigation covers the three tabs", JSON.stringify(tabKeys) === JSON.stringify(["tab-general", "tab-failures", "tab-recording", "tab-failures", "tab-recording", "tab-failures"])
    && await read<boolean>(window, `document.activeElement.id === "tab-failures"`), JSON.stringify(tabKeys));
  // Day groups, collapsed rows, header navigation and one open row, all in English at the minimum size.
  await pushResult("en", lastFocus);
  const layout = await read<{ days: string[]; open: boolean[] }>(window, `({ days: [...document.querySelectorAll(".result-day-heading")].map(h => h.textContent),
    open: [...document.querySelectorAll(".recording-result")].map(r => r.open) })`);
  record("rows are grouped by day and all collapsed on a normal open", layout.days.length === 4 && layout.days[0] === "Today" && layout.days[1] === "Yesterday"
    && layout.days.slice(2).every(d => !/\d{4}/.test(d)) && layout.open.length === 7 && layout.open.every(open => !open), JSON.stringify(layout));
  const headerIndex = () => read<number>(window, `[...document.querySelectorAll(".recording-result > summary")].indexOf(document.activeElement)`);
  await read(window, `document.querySelector(".recording-result > summary").focus()`);
  const moves: number[] = [];
  for (const keyCode of ["Down", "Down", "Down", "Down", "End", "Up", "Home", "Up"]) { press(keyCode); await settle(40); moves.push(await headerIndex()); }
  record("Up, Down, Home and End move between row headers across day groups", JSON.stringify(moves) === JSON.stringify([1, 2, 3, 4, 6, 5, 0, 0]), JSON.stringify(moves));
  press("Return"); await settle(60);
  press("Down"); press("Return"); await settle(80);
  const openRows = await read<boolean[]>(window, `[...document.querySelectorAll(".recording-result")].map(r => r.open)`);
  press("Space"); await settle(60);
  const closed = await read<boolean[]>(window, `[...document.querySelectorAll(".recording-result")].map(r => r.open)`);
  record("Enter and Space open and close a row, and opening another closes the first", JSON.stringify(openRows) === JSON.stringify([false, true, false, false, false, false, false])
    && closed.every(open => !open), JSON.stringify({ openRows, closed }));
  // The focus border: accent around the focused record, hairlines beside it hidden; neutral with a focused control inside.
  const colours = await read<{ accent: string; border: string }>(window, `(() => { const probe = document.createElement("div"); document.body.append(probe);
    probe.style.color = "var(--accent)"; const accent = getComputedStyle(probe).color; probe.style.color = "var(--border)"; const border = getComputedStyle(probe).color; probe.remove(); return { accent, border }; })()`);
  const rowFocus = (index: number) => read<{ colour: string; width: string; own: string; next: string; input: string | undefined }>(window, `(() => { const rows = document.querySelectorAll(".recording-result"); const r = rows[${index}];
    const style = getComputedStyle(r); return { colour: style.borderTopColor, width: style.borderTopWidth, own: getComputedStyle(r, "::before").opacity, next: rows[${index + 1}] ? getComputedStyle(rows[${index + 1}], "::before").opacity : "none", input: document.documentElement.dataset.input }; })()`);
  // A middle row of a day, so both hairlines beside it exist.
  const headerSpan = await activeSpan();
  await read(window, `document.querySelectorAll(".recording-result > summary")[1].focus()`); press("Down"); press("Up"); await settle(60);
  const headerFocus = await rowFocus(1);
  const dpr = await read<number>(window, "devicePixelRatio");
  const expectedWidth = dpr >= 2 ? "1.5px" : "1px";
  for (const scheme of ["light", "dark"] as const) {
    nativeTheme.themeSource = scheme; await settle(150);
    await shot(`result-focus-header-en-${scheme}.png`);
  }
  // Judged after its screenshots, so an activation lost while they were taken also counts.
  await recordActive(headerSpan, `keyboard focus on a header draws a ${expectedWidth} accent border around the record and hides the hairlines beside it (devicePixelRatio ${dpr})`,
    headerFocus.colour === colours.accent && headerFocus.width === expectedWidth && headerFocus.own === "0" && headerFocus.next === "0", JSON.stringify({ headerFocus, colours }));
  nativeTheme.themeSource = "light"; await settle(100);
  const insideSpan = await activeSpan();
  press("Return"); await settle(80); press("Tab"); await settle(80);
  const inside = await read<{ row: string; width: string; control: string; outline: string; style: string; tag: string }>(window, `(() => { const r = document.querySelectorAll(".recording-result")[1];
    const active = document.activeElement; const style = getComputedStyle(active); return { row: getComputedStyle(r).borderTopColor, width: getComputedStyle(r).borderTopWidth, control: active.dataset.action ?? active.tagName,
      outline: style.outlineColor, style: style.outlineStyle, tag: active.closest(".recording-result")?.id ?? "" }; })()`);
  await shot("result-focus-inside-en-light.png");
  await recordActive(insideSpan, "with focus on a control inside an open row, the row's border turns neutral at 1 px and the control's own border turns accent",
    inside.tag.endsWith("t-d2") && inside.row === colours.border && inside.width === "1px" && inside.outline === colours.accent && inside.style === "solid", JSON.stringify(inside));
  const pointerSpan = await activeSpan();
  await mouse(".recording-result:nth-child(1) > summary"); await settle(80);
  const clicked = await rowFocus(0);
  await recordActive(pointerSpan, "a pointer click shows no focus border", clicked.colour === "rgba(0, 0, 0, 0)" && clicked.input === "pointer", JSON.stringify(clicked));
  await read(window, `document.querySelector(".recording-result > summary").focus()`); press("Down"); press("Up"); await settle(60);
  const other = new BrowserWindow({ width: 240, height: 160, show: true });
  other.focus(); await settle(300);
  const inactive = await read<{ colour: string; window: string | undefined }>(window, `({ colour: getComputedStyle(document.querySelector(".recording-result")).borderTopColor, window: document.documentElement.dataset.window })`);
  // Destroying the front window can hand activation to another app, which `window.focus()` alone does not take back.
  other.destroy();
  const back = await activeSpan(); await settle(300);
  const reactivated = await read<string>(window, `getComputedStyle(document.querySelector(".recording-result")).borderTopColor`);
  await recordActive(back, "an inactive window shows no focus border, and it returns with the window", inactive.colour === "rgba(0, 0, 0, 0)" && inactive.window === "inactive" && reactivated === colours.accent,
    JSON.stringify({ inactive, reactivated }));
  // Review of 047: a day rollover moves rows between groups without dropping focus, and Technical details shows the focus line.
  const rollover = async (days: number) => {
    resultContext = { ...ctx, language: "en", notifications: false, recordingResults: recordingResults.all, now: new Date(Date.now() + days * 86_400_000) };
    window.webContents.send("settings:changed", resultView());
    await settle(150);
  };
  const where = () => read<{ active: string; day: string }>(window, `({ active: document.activeElement.id || document.activeElement.dataset.action || document.activeElement.tagName,
    day: document.activeElement.closest(".result-day")?.dataset.day ?? "" })`);
  await read(window, `document.querySelectorAll(".recording-result > summary")[1].focus()`); press("Down"); press("Up"); await settle(60);
  const beforeRollover = await where();
  await rollover(1);
  const headerAfter = await where();
  press("Return"); await settle(80); press("Tab"); await settle(80);
  const actionBefore = await where();
  await rollover(2);
  const actionAfter = await where();
  record("a day rollover that moves rows to another day group keeps the focused header and the focused action",
    beforeRollover.day === "Today" && headerAfter.active === beforeRollover.active && headerAfter.day === "Yesterday"
    && actionAfter.active === actionBefore.active && actionAfter.day !== actionBefore.day && actionAfter.active !== "BODY",
    JSON.stringify({ beforeRollover, headerAfter, actionBefore, actionAfter }));
  // Review pass 2: the same while another window is in front; returning finds the action, not the row's header.
  const inFront = new BrowserWindow({ width: 240, height: 160, show: true });
  inFront.focus(); await settle(300);
  await rollover(3);
  inFront.destroy();
  const returned = await activeSpan(); await settle(300);
  const inactiveRollover = await where();
  await recordActive(returned, "a day rollover while the window is inactive keeps the focused action for when it returns",
    inactiveRollover.active === actionBefore.active, JSON.stringify({ actionBefore, inactiveRollover }));
  await rollover(0);
  let technical = await read<boolean>(window, `document.activeElement.matches(".result-technical > summary")`);
  for (let i = 0; i < 4 && !technical; i += 1) { press("Tab"); await settle(60); technical = await read<boolean>(window, `document.activeElement.matches(".result-technical > summary")`); }
  const disclosure = await read<{ style: string; colour: string; width: string }>(window, `(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, colour: s.outlineColor, width: s.outlineWidth }; })()`);
  await recordActive(returned, "keyboard focus on Technical details shows the shared focus line", technical && disclosure.style === "solid" && disclosure.colour === colours.accent && disclosure.width === expectedWidth,
    JSON.stringify({ technical, ...disclosure }));
  // Each tab keeps its own scroll position through real wheel scrolling; an entry scrolls to its row.
  const scrollTop = () => read<number>(window, `document.getElementById("settings-panel").scrollTop`);
  const extent = () => read<string>(window, `(() => { const p = document.getElementById("settings-panel"); return p.scrollHeight + "/" + p.clientHeight; })()`);
  const wheel = async () => {
    const at = await read<{ x: number; y: number }>(window, `(() => { const r = document.getElementById("settings-panel").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    for (let i = 0; i < 4; i += 1) window.webContents.sendInputEvent({ type: "mouseWheel", ...at, deltaX: 0, deltaY: -60 });
    await settle(250);
  };
  // A reloaded page is a new window: every tab starts at the top.
  window.webContents.reload();
  if (!await until(() => read<boolean>(window, `Boolean(document.getElementById("tab-general"))`), 5000)) throw new Error("the panel did not reload");
  await pushResult("en", lastFocus);
  await mouse("#tab-recording"); await settle(80);
  const recordingFirst = await scrollTop();
  await wheel();
  const recordingAt = await scrollTop();
  await mouse("#tab-general"); await settle(80);
  const generalFirst = await scrollTop();
  await wheel();
  const generalAt = await scrollTop();
  await mouse("#tab-recording"); await settle(80);
  const recordingBack = await scrollTop();
  const recordingExtent = await extent();
  await mouse("#tab-general"); await settle(80);
  const generalBack = await scrollTop();
  const generalExtent = await extent();
  record("each tab keeps its own scroll position when switching away and back, and a new window starts each tab at the top",
    recordingFirst === 0 && generalFirst === 0 && recordingAt > 0 && generalAt > 0 && recordingBack === recordingAt && generalBack === generalAt,
    JSON.stringify({ recordingFirst, recordingAt, generalFirst, generalAt, recordingBack, generalBack, recordingExtent, generalExtent }));
  await pushResult("en", ++lastFocus);
  const entry = await read<{ tab: string; open: string[]; active: string; visible: boolean }>(window, `(() => { const rows = [...document.querySelectorAll(".recording-result")];
    const target = document.getElementById("recording-result-t-old-unread"); const box = target.getBoundingClientRect(), panel = document.getElementById("settings-panel").getBoundingClientRect();
    return { tab: document.querySelector('[role="tab"][aria-selected="true"]').id, open: rows.filter(r => r.open).map(r => r.dataset.resultId), active: document.activeElement.id,
      visible: box.top >= panel.top - 1 && box.top < panel.bottom }; })()`);
  record("an entry selects the failures tab, opens only the newest unread row, focuses its header and scrolls it into view, without acknowledging it",
    entry.tab === "tab-failures" && JSON.stringify(entry.open) === '["t-old-unread"]' && entry.active === "recording-result-t-old-unread-summary" && entry.visible
    && recordingResults.all.find(r => r.id === "t-old-unread")?.acknowledged === false, JSON.stringify(entry));
  // The count follows acknowledgement.
  const before = await tabFailuresLabel();
  await clickAck(() => read<boolean>(window, `!document.getElementById("recording-result-t-old-unread").classList.contains("unread")`));
  const after = await tabFailuresLabel();
  record("the tab count appears for unread failures and clears once they are acknowledged", before === "Failures (1)" && after === "Failures", JSON.stringify({ before, after }));
  // The shared focus border on every kind of control: on the control's border, or 2 px off an accent fill.
  window.setSize(380, 360);
  /** Arrives at `selector` by real Tab and Shift+Tab, so the focus is keyboard focus. */
  const keyboardFocus = async (selector: string): Promise<boolean> => {
    await read(window, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" }); document.querySelector(${JSON.stringify(selector)}).focus()`);
    press("Tab"); await settle(40);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers: ["shift"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers: ["shift"] });
    await settle(80);
    return read<boolean>(window, `document.activeElement === document.querySelector(${JSON.stringify(selector)})`);
  };
  for (const lang of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
    nativeTheme.themeSource = scheme;
    await pushResult(lang, lastFocus);
    await mouse("#tab-recording"); await settle(80);
    for (const [name, selector, offset] of [["tab", "#tab-recording", "-"], ["menu", "#setting-screen", "-"], ["segment", "#setting-countdown input:checked", "gap"],
      ["switch", "#setting-countdownSound", "gap"]] as const) {
      const span = await activeSpan();
      const reached = await keyboardFocus(selector);
      const ring = await read<{ style: string; width: string; offset: string }>(window, `(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset }; })()`);
      const want = offset === "gap" ? "2px" : `-${expectedWidth}`;
      await shot(`focus-${name}-${lang}-${scheme}-minimum.png`);
      await recordActive(span, `${lang}/${scheme}: the ${name} shows the ${expectedWidth} focus line ${offset === "gap" ? "2 px off its accent fill" : "on its own border"}`,
        reached && ring.style === "solid" && ring.width === expectedWidth && ring.offset === want, JSON.stringify({ reached, ...ring }));
    }
    await mouse("#tab-general"); await settle(80);
    const buttonSpan = await activeSpan();
    const buttonReached = await keyboardFocus("#setting-notifications-openSettings");
    const buttonRing = await read<{ style: string; width: string; offset: string }>(window, `(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset }; })()`);
    await shot(`focus-button-${lang}-${scheme}-minimum.png`);
    await recordActive(buttonSpan, `${lang}/${scheme}: a button shows the focus line on its own border`, buttonReached && buttonRing.style === "solid" && buttonRing.width === expectedWidth && buttonRing.offset === `-${expectedWidth}`, JSON.stringify({ buttonReached, ...buttonRing }));
    await mouse("#tab-failures"); await settle(80);
    await shot(`failures-${lang}-${scheme}-minimum.png`);
  }
  nativeTheme.themeSource = "light";
  resultContext = undefined;
  writeResults();
  return results.every((result) => result.ok);
}

app.whenReady()
  .then(run)
  .then((ok) => app.exit(ok ? 0 : 1))
  .catch((error) => {
    fs.writeFileSync(path.join(outDir, "error.txt"), String(error?.stack ?? error));
    // The cases recorded before the stop still count (plan 057).
    const failure: FixtureFailure = error instanceof CaptureFailed ? error.failure : { error: String(error?.message ?? error) };
    fs.writeFileSync(path.join(outDir, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`);
    writeResults();
    app.exit(2);
  });
