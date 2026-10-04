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
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, protocol, screen } from "electron";
import { translate, type Language } from "../../src/shared/i18n";
import type { SettingsView } from "../../src/shared/settings-panel";
import fs from "node:fs";
import { settingsView } from "../../src/main/settings-model";
import { DEFAULT_QUALITY } from "../../src/shared/quality";
import { DEFAULT_HOTKEY } from "../../src/shared/hotkey";
import type { AppContext } from "../../src/main/ui-model";
import { MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES, RecordingsLibrary } from "../../src/main/recordings-library";
import { settingsWindowOptions } from "../../src/main/settings-window";
import { TRAFFIC_LIGHT_ZONE } from "../../src/shared/window-controls";
import { DEFAULT_SETTINGS_SIZE, MIN_SETTINGS_SIZE } from "../../src/main/settings-window-state";
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
// The Recordings tab's media, served as the app serves it (index.ts): only privileged before ready.
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { ...MEDIA_SCHEME_PRIVILEGES } }]);
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
    // The window is the app's own, named "RecordStuff" in both languages (2026-10-04).
    title: "RecordStuff",
    hint: "",
    failure: zh
      ? "無法套用此設定，已顯示目前的設定。"
      : "Could not apply this setting. Your current settings are shown.",
    tabs: [
      { id: "recording", label: zh ? "錄影設定" : "Recording settings" },
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
// The fixture shows its window itself, when a case needs it active.
ipcMain.handle("settings:ready", () => {});
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

/** A movie header stating `seconds`, all mp4Duration reads; the rest of the file stays sparse. */
const movieOf = (seconds: number): Buffer => {
  const u32 = (value: number): Buffer => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  const mvhd = Buffer.concat([u32(108), Buffer.from("mvhd"), Buffer.alloc(12), u32(1000), u32(seconds * 1000), Buffer.alloc(80)]);
  return Buffer.concat([u32(mvhd.length + 8), Buffer.from("moov"), mvhd]);
};
/** A 16:9 picture in one hue, darker towards the bottom, deterministic for screenshots. */
const pictureOf = (red: number, green: number, blue: number): Buffer => {
  const width = 480, height = 270, pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const shade = 1 - (y / height) * 0.45, at = (y * width + x) * 4;
    pixels[at] = Math.round(blue * shade); pixels[at + 1] = Math.round(green * shade); pixels[at + 2] = Math.round(red * shade); pixels[at + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, { width, height }).toPNG();
};
/**
 * The Recordings tab's folder, read by the app's own `RecordingsLibrary` and served by its handler under the app's
 * scheme: real ids, lengths read from the files' boxes, sizes and dates from the file system, and thumbnails over
 * `recordstuff-media:` under the shipped CSP. The files are movie headers made sparse to their sizes, dated with
 * `utimes` (which on macOS also moves the birth time back), and two have pictures while the third shows the fallback.
 */
async function recordingsFolder(dir: string): Promise<RecordingsLibrary> {
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    { name: "2026-10-04 14-02-11.mp4", at: new Date(2026, 9, 4, 14, 2, 11), size: 182e6, seconds: 83, picture: pictureOf(64, 112, 196) },
    { name: "A long product walkthrough recorded for the onboarding review.mp4", at: new Date(2026, 9, 4, 9, 30), size: 1.24e9, seconds: 3725, picture: pictureOf(196, 120, 64) },
    { name: "2026-10-03 21-15-00.mp4", at: new Date(2026, 9, 3, 21, 15), size: 54e6, seconds: 0, picture: undefined },
  ];
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    fs.writeFileSync(filePath, file.seconds ? movieOf(file.seconds) : Buffer.alloc(0));
    fs.truncateSync(filePath, file.size);
    fs.utimesSync(filePath, file.at, file.at);
  }
  const pictures = new Map(files.map(file => [path.join(dir, file.name), file.picture]));
  const library = new RecordingsLibrary({ dir: () => dir, changed: () => {}, thumbnail: async file => pictures.get(file),
    trash: async () => {}, open: async () => "", reveal: () => {}, log: message => console.log(message) });
  protocol.handle(MEDIA_SCHEME, request => library.handle(request));
  await library.refresh();
  await library.lengths;
  return library;
}

/**
 * Window sizes for the visual snapshots: the app's default and minimum, and a 560 × 680 window (the default before the
 * sidebar). With the app's own frame (`settingsWindowOptions`) each is also the content size, as in the app.
 */
const SNAPSHOT_SIZES = {
  default: [DEFAULT_SETTINGS_SIZE.width, DEFAULT_SETTINGS_SIZE.height], narrow: [560, 680], minimum: [MIN_SETTINGS_SIZE.width, MIN_SETTINGS_SIZE.height],
} as const satisfies Record<string, readonly [number, number]>;
async function run() {
  // Before any page loads, as in the app (index.ts): a frame takes the custom schemes registered when it navigates,
  // so a handler added after the page loaded would never answer it.
  const recordings = await recordingsFolder(path.join(outDir, "recordings"));
  // The app's own window description (settings-window.ts): the same frame, so a size here is the content size the app shows.
  const window = new BrowserWindow(settingsWindowOptions({ platform: process.platform, preloadPath: path.join(out, "preload/settings.js"),
    title: "RecordStuff", size: { width: 460, height: 560 }, workArea: screen.getPrimaryDisplay().workArea }));
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
  /**
   * The window controls sit over the page's top-left corner (TRAFFIC_LIGHT_ZONE): nothing a person can click may lie
   * under them. The page's own hit testing decides what lies there, every 2 px across the zone and through every layer
   * (`elementsFromPoint`), so clipping, scrolling, fixed placement and the top layer count as they draw; while a modal
   * dialog is open only what it holds can be clicked (review pass 1, F1-1).
   */
  const underControls = async (label: string): Promise<void> => {
    if (process.platform !== "darwin") return;
    const covered = await read<string[]>(window, `(() => {
      const clickable = 'button, select, input, a[href], summary, [tabindex]:not([tabindex="-1"])';
      const modal = document.querySelector("dialog:modal");
      const found = new Set();
      for (let x = 1; x < ${TRAFFIC_LIGHT_ZONE.width}; x += 2) for (let y = 1; y < ${TRAFFIC_LIGHT_ZONE.height}; y += 2) {
        for (const hit of document.elementsFromPoint(x, y)) {
          const control = hit.closest(clickable);
          if (control && (!modal || modal.contains(control))) found.add(control.id || control.className || control.tagName);
        }
      }
      return [...found];
    })()`);
    record(`${label}: nothing clickable lies under the window controls`, covered.length === 0, JSON.stringify(covered));
  };
  const consoleErrors: string[] = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") consoleErrors.push(event.message);
  });

  // Main puts the language in the URL so a failed first read is localized.
  await window.loadFile(path.join(out, "renderer/settings.html"), { query: { lang: "zh-TW" } });
  await settle(700);
  // Plan: the fixture's window is the app's (settings-window.ts), so its screenshots show the frame the app opens.
  const frame = window.getBounds(), content = window.getContentBounds();
  record(process.platform === "darwin" ? "the window has the app's frame: no title bar, the page fills it under the inset window controls"
    : "the window has the app's frame: the native title bar above the page",
  process.platform === "darwin" ? content.y === frame.y && content.height === frame.height : content.height < frame.height,
  JSON.stringify({ frame, content }));

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
    "the preload exposes capture/read/choose/onChanged/ready and nothing else",
    JSON.stringify(rendered.bridge) === '["capture","choose","onChanged","read","ready"]',
    JSON.stringify(rendered.bridge),
  );
  record(
    "no Node API reaches the sandboxed page",
    JSON.stringify(rendered.exposed) === '["undefined","undefined","undefined"]',
    JSON.stringify(rendered.exposed),
  );
  record(
    "the URL language localizes the first render",
    rendered.title === "RecordStuff" && rendered.docTitle === "RecordStuff" && rendered.lang === "zh-Hant"
      && rendered.controls.find(control => control.id === "setting-hotkey")?.label === "快捷鍵",
    JSON.stringify([rendered.title, rendered.docTitle, rendered.lang, rendered.controls.map(control => control.label)]),
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
    applied.title === "RecordStuff" && applied.lang === "en" && applied.hotkeyLabel === "Shortcut",
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
  const finished = await read<{ value: string; locked: boolean; lang: string; hotkeyLabel: string }>(window, `({
    value: document.querySelector("#setting-language input:checked").value,
    locked: document.querySelector("#setting-hotkey").disabled,
    lang: document.documentElement.lang,
    hotkeyLabel: document.querySelector("label[for='setting-hotkey']").textContent,
  })`);
  record("the final completion unlocks controls and displays committed settings",
    finished.value === "en" && !finished.locked && finished.lang === "en" && finished.hotkeyLabel === "Shortcut", JSON.stringify(finished));

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
  // The running version, as the app shows it beside the credit (the fixture's own Electron reports its version, not the app's).
  const version = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
  const ctx: AppContext = { platform: "darwin", language: "en", outputDir: "/tmp", homeDir: "/tmp", version,
    quality: DEFAULT_QUALITY, countdown: 3, countdownSound: true, hotkey: { ...DEFAULT_HOTKEY, registered: true }, notifications: true,
    updates: { enabled: true, state: { kind: "idle" } }, display: { kind: "primary" },
    displays: [{ id: "1", label: "Built-in Display", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: true, primary: true }] };
  // The Recordings tab, the window's home (2026-10-04): two days of cards, one named by its user at length, and an empty folder,
  // read from a real folder by the app's own library and served under its scheme (`recordingsFolder`).
  const now = new Date(2026, 9, 4, 18, 0, 0);
  const library = recordings.state;
  record("the Recordings folder is read by the app's library: names, dates, sizes and lengths from the files",
    JSON.stringify(library.files.map(file => [file.name, file.recordedAt, file.size, file.duration ?? null])) === JSON.stringify([
      ["2026-10-04 14-02-11.mp4", new Date(2026, 9, 4, 14, 2, 11).getTime(), 182e6, 83],
      ["A long product walkthrough recorded for the onboarding review.mp4", new Date(2026, 9, 4, 9, 30).getTime(), 1.24e9, 3725],
      ["2026-10-03 21-15-00.mp4", new Date(2026, 9, 3, 21, 15).getTime(), 54e6, null],
    ]), JSON.stringify(library.files.map(file => ({ name: file.name, recordedAt: new Date(file.recordedAt).toISOString(), size: file.size, duration: file.duration }))));
  for (const lang of ["en", "zh-TW"] as const) for (const scheme of ["light", "dark"] as const) {
    nativeTheme.themeSource = scheme;
    // The sidebar layout at the default size, the tabs-on-top layout of a narrower window, and the minimum.
    for (const size of ["default", "narrow", "minimum"] as const) {
      window.setSize(SNAPSHOT_SIZES[size][0], SNAPSHOT_SIZES[size][1]);
      for (const state of ["recording", "general", "listening", "error", "locked", "sound-off", "countdown-off", "library", "library-empty", "library-failed"] as const) {
        const snapshot = settingsView(state === "locked" ? { type: "starting" } : { type: "idle" }, {
          ...ctx, language: lang,
          ...(state === "error" ? { display: { kind: "display", id: "2", label: "BenQ BL2480T" }, displayFailure: "target_removed" } : {}),
          // Plan 046: the switch off, and disabled with its value kept while the countdown is Off.
          ...(state === "sound-off" ? { countdownSound: false } : {}),
          ...(state === "countdown-off" ? { countdown: 0 as const } : {}),
          ...(state === "library" ? { library, now } : state === "library-empty" ? { library: { ...library, files: [] }, now }
            : state === "library-failed" ? { library: { ...library, failed: true, files: [] }, now } : {}),
        });
        if (state === "listening") snapshot.groups.find(g => g.id === "hotkey")!.capturing = true;
        const tab = state === "library" || state === "library-empty" || state === "library-failed" ? "library" : state === "general" || state === "listening" ? "general" : "recording";
        await read(window, `document.getElementById("tab-${tab}").click()`);
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
        await underControls(`${lang}/${scheme}/${size}/${state}`);
        if (tab === "library") {
          const shown = await read<{ days: number; cards: number; empty: boolean; summary: string }>(window, `({
            days: document.querySelectorAll(".library-day").length, cards: document.querySelectorAll(".clip").length,
            empty: !document.querySelector(".library-empty").hidden, summary: document.querySelector(".library-summary").textContent })`);
          const status = await read<string>(window, `(() => { const el = document.querySelector(".library-status"); return el.hidden ? "" : el.textContent; })()`);
          // The failed folder shows its own message, with the next step, in this language (review pass 1, F1); the others show none.
          const unreadable = translate("Could not read the output folder. Check the folder and its drive, or choose another folder.", lang);
          const expected = state === "library" ? shown.days === 2 && shown.cards === 3 && !shown.empty && shown.summary !== "" && status === ""
            : state === "library-empty" ? shown.cards === 0 && shown.empty && status === "" : shown.cards === 0 && !shown.empty && status === unreadable;
          record(`${lang}/${scheme}/${size}/${state}: Recordings shows ${state === "library" ? "its cards by day" : state === "library-empty" ? "the empty folder" : "why the folder cannot be read"}`,
            expected, JSON.stringify({ ...shown, status }));
          if (state === "library" && size === "default") {
            // Every card is in view at the default size, so each lazy image loads: two pictures over the scheme, one fallback.
            const thumbs = async () => read<{ pictures: number; fallback: number; pending: number }>(window, `(() => { const images = [...document.querySelectorAll(".clip-thumb img")];
              return { pictures: images.filter(i => i.complete && i.naturalWidth === 480).length, fallback: document.querySelectorAll(".clip-thumb.no-thumb").length,
                pending: images.filter(i => !i.complete).length }; })()`);
            await until(async () => { const t = await thumbs(); return t.pending === 0 && t.pictures + t.fallback === 3; });
            const seen = await thumbs();
            record(`${lang}/${scheme}/${size}/${state}: thumbnails arrive over ${MEDIA_SCHEME}: under the shipped CSP, and a recording without one shows the fallback`,
              seen.pictures === 2 && seen.fallback === 1, JSON.stringify(seen));
          }
        }
        if (state === "recording" || state === "locked") {
          // The status card speaks only when there is something to say (2026-10-04): never while ready, and a busy
          // app keeps its title in view at every size. The sidebar's foot carries the credit and links when wide.
          const card = await read<{ shown: boolean; tone: string; foot: boolean; links: number }>(window, `(() => { const el = document.getElementById("status"), foot = document.getElementById("sidebar-about");
            return { shown: el.getBoundingClientRect().height > 0, tone: el.dataset.tone ?? "", foot: foot.getBoundingClientRect().height > 0, links: foot.querySelectorAll(".sidebar-link").length }; })()`);
          const expected = (state === "locked" ? card.shown && card.tone === "busy" : !card.shown && card.tone === "ready")
            && (size === "default" ? card.foot && card.links === 2 : !card.foot);
          record(`${lang}/${scheme}/${size}/${state}: the status card speaks only when needed; the credit sits in the sidebar when wide`, expected, JSON.stringify(card));
        }
        await shot(`panel-${lang}-${scheme}-${size}-${state}.png`);
        if (state === "library") {
          // The player over the tab. The file is served, byte ranges and all, but holds no media, so it shows what a recording that cannot be played gets.
          await read(window, `document.querySelector(".clip-open").click()`);
          const opened = await until(() => read<boolean>(window, `(() => { const p = document.querySelector("dialog.player"); return Boolean(p?.open && !p.querySelector(".player-error").hidden); })()`));
          const player = await read<{ open: boolean; error: string; spoken: string; fits: boolean; buttons: string[] }>(window, `(() => { const p = document.querySelector("dialog.player"), r = p.getBoundingClientRect();
            return { open: p.open, error: p.querySelector(".player-error").hidden ? "" : p.querySelector(".player-error").textContent,
              spoken: p.querySelector('[role="status"]').textContent, buttons: [...p.querySelectorAll("button")].map(b => b.id),
              fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && p.scrollWidth <= p.clientWidth }; })()`);
          record(`${lang}/${scheme}/${size}/player: opens over Recordings with Close alone, fits the window and says a recording it cannot play cannot be played here`,
            opened && player.open && player.error !== "" && player.spoken === player.error && player.buttons.join() === "player-close" && player.fits, JSON.stringify(player));
          await underControls(`${lang}/${scheme}/${size}/player`);
          await shot(`player-${lang}-${scheme}-${size}.png`);
          await read(window, `document.getElementById("player-close").click()`);
          const closed = await until(() => read<boolean>(window, `!document.querySelector("dialog.player").open`));
          record(`${lang}/${scheme}/${size}/player: Close closes it`, closed, JSON.stringify({ closed }));
          // A Close that failed is recorded above; the next states must still start without a modal over them (review pass 1, F1).
          if (!closed) await read(window, `document.querySelector("dialog.player").close()`);
          // The card's file actions (2026-10-04), with real input: a click on its ⋯ button, then a right-click on the card.
          const menuState = (): Promise<{ open: boolean; items: string[]; fits: boolean; focused: string; expanded: string | null }> => read(window, `(() => {
            const m = document.getElementById("clip-menu"), r = m?.getBoundingClientRect();
            return { open: Boolean(m?.matches(":popover-open")), items: m ? [...m.querySelectorAll("[role=menuitem]")].map(i => i.textContent) : [],
              fits: Boolean(r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight), focused: document.activeElement?.id ?? "",
              expanded: document.querySelector(".clip-more").getAttribute("aria-expanded") }; })()`);
          const target = await read<{ more: { x: number; y: number }; card: { x: number; y: number } }>(window, `(() => {
            const card = document.querySelector(".clip"); card.scrollIntoView({ block: "nearest" });
            const centre = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
            return { more: centre(card.querySelector(".clip-more")), card: centre(card.querySelector(".clip-thumb")) }; })()`);
          window.webContents.sendInputEvent({ type: "mouseMove", x: target.card.x, y: target.card.y });
          for (const type of ["mouseDown", "mouseUp"] as const) window.webContents.sendInputEvent({ type, button: "left", clickCount: 1, x: target.more.x, y: target.more.y });
          await until(async () => (await menuState()).open, 2000);
          const fromButton = await menuState();
          // The frame holding the menu, not the one before it.
          await read(window, `new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`);
          await underControls(`${lang}/${scheme}/${size}/card menu`);
          await shot(`clip-menu-${lang}-${scheme}-${size}.png`);
          // A real hover on the last item: it alone is lit, it takes focus from the first, and its words stay legible on the fill.
          const last = await read<{ x: number; y: number }>(window, `(() => { const r = document.querySelector("#clip-menu [role=menuitem]:last-child").getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
          window.webContents.sendInputEvent({ type: "mouseMove", x: last.x, y: last.y }); await settle(150);
          const hovered = await read<{ lit: string[]; focused: string; contrast: number }>(window, `(() => {
            const rgba = value => { const [r, g, b, a = 1] = value.match(/[\\d.]+/g).map(Number); return [r, g, b, a]; };
            // The tint and the sheet are translucent: each is laid over what is under it, down to the window's own background.
            const over = (top, under) => top.slice(0, 3).map((c, i) => c * top[3] + under[i] * (1 - top[3])).concat(1);
            const luminance = ([r, g, b]) => [r, g, b].map(c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
            const items = [...document.querySelectorAll("#clip-menu [role=menuitem]")];
            const lit = items.filter(i => rgba(getComputedStyle(i).backgroundColor)[3] > 0);
            const sheet = over(rgba(getComputedStyle(document.getElementById("clip-menu")).backgroundColor), rgba(getComputedStyle(document.documentElement).backgroundColor));
            const style = lit[0] && getComputedStyle(lit[0]);
            const [a, b] = style ? [luminance(rgba(style.color)), luminance(over(rgba(style.backgroundColor), sheet))] : [0, 0];
            return { lit: lit.map(i => i.id), focused: document.activeElement?.id ?? "", contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }; })()`);
          await shot(`clip-menu-hover-${lang}-${scheme}-${size}.png`);
          record(`${lang}/${scheme}/${size}/card menu: hovering an item lights it alone, focuses it and keeps its words legible`,
            hovered.lit.join() === "clip-menu-trash" && hovered.focused === "clip-menu-trash" && hovered.contrast >= 4.5, JSON.stringify({ last, hovered }));
          // An Escape with no menu open would close the window, ending every case after this one: only one that opened is answered.
          if ((await menuState()).open) window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
          await settle(100);
          const escaped = await menuState();
          for (const type of ["mouseDown", "mouseUp"] as const) window.webContents.sendInputEvent({ type, button: "right", clickCount: 1, x: target.card.x, y: target.card.y });
          await until(async () => (await menuState()).open, 2000);
          const fromRightClick = await menuState();
          await read(window, `document.getElementById("clip-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
          const mac = ctx.platform === "darwin";
          const expectedItems = [translate(mac ? "Show in Finder" : "Open folder", lang), translate("Open", lang), translate(mac ? "Move to Trash" : "Move to Recycle Bin", lang)].join("|");
          record(`${lang}/${scheme}/${size}/card menu: ⋯ and a right-click open the file's actions inside the window; Escape closes it and gives focus back`,
            fromButton.open && fromButton.items.join("|") === expectedItems && fromButton.fits && fromButton.focused.startsWith("clip-menu-") && fromButton.expanded === "true"
              && !escaped.open && escaped.expanded === "false" && escaped.focused.endsWith("-more") && !window.isDestroyed()
              && fromRightClick.open && fromRightClick.fits, JSON.stringify({ target, fromButton, escaped, fromRightClick }));
        }
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
  // The status card's fix (2026-10-04): a real click in the sidebar asks main for the card's own action, and nothing else.
  // A ready card offers no button: recording starts from the menu bar icon, its menu or the shortcut.
  window.setSize(SNAPSHOT_SIZES.default[0], SNAPSHOT_SIZES.default[1]);
  window.webContents.send("settings:changed", settingsView({ type: "idle" }, ctx));
  await settle(80);
  const readyButton = await read<boolean>(window, `document.getElementById("status-action").hidden`);
  record("status card: a ready card offers no Start button", readyButton, String(readyButton));
  window.webContents.send("settings:changed", settingsView({ type: "idle", outputDirUnavailable: true }, ctx));
  await settle(80);
  chooseCalls.length = 0;
  const fixButton = await read<{ x: number; y: number; label: string; inSidebar: boolean }>(window, `(() => {
    const el = document.getElementById("status-action"), r = el.getBoundingClientRect(), panel = document.querySelector(".settings-viewport").getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: el.textContent, inSidebar: r.right <= panel.left }; })()`);
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: fixButton.x, y: fixButton.y });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: fixButton.x, y: fixButton.y });
  await settle(150);
  record("status card: Change output folder… sits in the sidebar and a real click asks main for status/folder",
    fixButton.label === "Change output folder…" && fixButton.inSidebar && JSON.stringify(chooseCalls) === '[["status","folder"]]', JSON.stringify({ fixButton, chooseCalls }));
  // A missing permission (2026-10-04): Open System Settings is the button, and the tray's second step, Relaunch for access
  // already granted, is a text link under the card's words; a real click on it asks main for status/relaunch only.
  const permission = { type: "needsPermission", needsRelaunch: false } as const;
  for (const [lang, scheme, size] of [["en", "light", "default"], ["en", "dark", "narrow"], ["zh-TW", "light", "minimum"]] as const) {
    nativeTheme.themeSource = scheme;
    window.setSize(SNAPSHOT_SIZES[size][0], SNAPSHOT_SIZES[size][1]);
    window.webContents.send("settings:changed", settingsView(permission, { ...ctx, language: lang }));
    await settle(150);
    await shot(`status-permission-${lang}-${scheme}-${size}.png`);
  }
  nativeTheme.themeSource = "light";
  window.setSize(SNAPSHOT_SIZES.default[0], SNAPSHOT_SIZES.default[1]);
  window.webContents.send("settings:changed", settingsView(permission, ctx));
  await settle(150);
  chooseCalls.length = 0;
  const relaunchLink = await read<{ x: number; y: number; label: string; button: string; below: boolean; inside: boolean }>(window, `(() => {
    const el = document.getElementById("status-secondary"), r = el.getBoundingClientRect(), card = document.getElementById("status").getBoundingClientRect();
    const detail = document.getElementById("status-detail").getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(r.width / 2, 40)), y: Math.round(r.y + r.height / 2), label: el.hidden ? "" : el.textContent, button: document.getElementById("status-action").textContent,
      below: r.top >= detail.bottom - 1, inside: r.width > 0 && r.left >= card.left && r.right <= card.right && r.bottom <= card.bottom }; })()`);
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: relaunchLink.x, y: relaunchLink.y });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: relaunchLink.x, y: relaunchLink.y });
  await settle(150);
  record("status card: a missing permission offers Open System Settings and, under the words, Relaunch; a real click on the link asks main for status/relaunch",
    relaunchLink.label === "Already allowed? Relaunch RecordStuff" && relaunchLink.button === "Open System Settings" && relaunchLink.below && relaunchLink.inside
      && JSON.stringify(chooseCalls) === '[["status","relaunch"]]', JSON.stringify({ relaunchLink, chooseCalls }));
  // The ⓘ beside a label: real hover and real Tab show its explanation in the top layer, inside the window; Escape closes it before the window.
  const infoState = (id: string) => read<{ open: boolean; expanded: string | null; text: string; inside: boolean; describes: boolean }>(window, `(() => {
    const id = ${JSON.stringify(`setting-${id}`)}, popover = document.getElementById(id + "-info"), r = popover.getBoundingClientRect();
    const control = document.querySelector("#" + id + "-row .switch, #" + id + "-row select, #" + id + "-row .segments input");
    return { open: popover.matches(":popover-open"), expanded: document.getElementById(id + "-info-button").getAttribute("aria-expanded"), text: popover.textContent,
      inside: r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      describes: (control?.getAttribute("aria-describedby") ?? "").split(" ").includes(popover.id) }; })()`);
  for (const [lang, size] of [["en", "minimum"], ["zh-TW", "default"]] as const) {
    window.setSize(SNAPSHOT_SIZES[size][0], SNAPSHOT_SIZES[size][1]);
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
    // An Escape with no explanation open would close the window, ending every case after this one; the case then fails on `tabbed`.
    if (tabbed.open) { window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); }
    await settle(120);
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
  // Tall enough for the whole Recording tab, which may scroll at the 960 × 640 default in Traditional Chinese.
  window.setSize(720, 800);
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
  // General's own footer is the narrow layout's; the sidebar carries it when wide (2026-10-04).
  window.setSize(560, 760);
  await settle(100);
  const footer = await read<boolean>(window, `(() => { const row = document.getElementById("setting-about-row"); const buttons = [...row.querySelectorAll(".controls button")]; const credit = row.querySelector(".group-label"); return credit.textContent.includes("Eric Tsai") && buttons.length === 2 && buttons.every(b => b.querySelector("svg") && b.getAttribute("aria-label") && b.title === b.getAttribute("aria-label")) && credit.getBoundingClientRect().right <= buttons[0].getBoundingClientRect().left; })()`);
  record("narrow footer credits Eric Tsai on the left with two labeled icon links on the right", footer, String(footer));
  const logRow = await read<boolean>(window, `(() => { const row = document.getElementById("setting-log-row"); const show = document.getElementById("setting-log-show"); return Boolean(row?.querySelector(".row-icon")) && row.querySelector(".group-label").textContent === "Log file" && show?.textContent === "Show log" && !show.disabled; })()`);
  record("Show log is a labelled row of its own, with an icon and a text button", logRow, String(logRow));
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
      // A narrow strip names only the open tab; the others show their icon and keep their name for assistive technology.
      const shown = tabs.map(t => t.querySelector(".tab-name")).filter(name => name && getComputedStyle(name).clipPath === "none");
      const lines = shown.map(t => { const range = document.createRange(); range.selectNodeContents(t); return new Set([...range.getClientRects()].map(r => Math.round(r.top))).size; });
      return { fits: tabs.every(t => t.scrollWidth <= t.clientWidth), lines, labels: tabs.map(t => t.textContent) }; })()`);
    record(`${lang}: the four tabs fit the 380 pt window without wrapping or truncation, the open one by name`, strip.fits && strip.lines.length >= 1 && strip.lines.every(n => n === 1)
      && strip.labels[3] === (lang === "en" ? "Failures (1)" : "失敗紀錄（1）"), JSON.stringify(strip));
    for (const scheme of ["light", "dark"] as const) {
      nativeTheme.themeSource = scheme; await settle(120);
      await mouse("#tab-recording"); await settle(60);
      await shot(`tabs-${lang}-${scheme}-minimum.png`);
    }
    nativeTheme.themeSource = "light";
  }
  // Arrow keys, Home and End cover all four tabs, wrapping from Failures to Recordings.
  await mouse("#tab-recording"); await settle(60);
  const tabKeys: string[] = [];
  for (const keyCode of ["Right", "Right", "Right", "End", "Home", "Left"]) { press(keyCode); await settle(60); tabKeys.push(await selected()); }
  record("keyboard navigation covers the four tabs", JSON.stringify(tabKeys) === JSON.stringify(["tab-general", "tab-failures", "tab-library", "tab-failures", "tab-library", "tab-failures"])
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
    for (const [name, selector, offset] of [["tab", "#tab-recording", "-"], ["menu", "#setting-screen", "-"], ["segment", "#setting-countdown input:checked", "-"],
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
    const buttonReached = await keyboardFocus("#setting-updates-check");
    const buttonRing = await read<{ style: string; width: string; offset: string }>(window, `(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset }; })()`);
    await shot(`focus-button-${lang}-${scheme}-minimum.png`);
    await recordActive(buttonSpan, `${lang}/${scheme}: a button shows the focus line on its own border`, buttonReached && buttonRing.style === "solid" && buttonRing.width === expectedWidth && buttonRing.offset === `-${expectedWidth}`, JSON.stringify({ buttonReached, ...buttonRing }));
    // A row's extra action is a borderless text link, so its line sits just off the text.
    const linkSpan = await activeSpan();
    const linkReached = await keyboardFocus("#setting-notifications-openSettings");
    const linkRing = await read<{ style: string; width: string; offset: string }>(window, `(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset }; })()`);
    await shot(`focus-link-${lang}-${scheme}-minimum.png`);
    await recordActive(linkSpan, `${lang}/${scheme}: a row's text-link action shows the focus line 2 px off its text`, linkReached && linkRing.style === "solid" && linkRing.width === expectedWidth && linkRing.offset === "2px", JSON.stringify({ linkReached, ...linkRing }));
    await mouse("#tab-failures"); await settle(80);
    await shot(`failures-${lang}-${scheme}-minimum.png`);
  }
  nativeTheme.themeSource = "light";
  resultContext = undefined;
  writeResults();
  return results.every((result) => result.ok);
}

// A window the page closed must not quit the fixture before it writes its results; the next case fails instead.
app.on("window-all-closed", () => undefined);
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
