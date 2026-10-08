/**
 * Electron main for `pnpm preview:ui` (2026-10-05): a gallery of the built Settings window and full-screen page,
 * drawn offscreen, so it needs no desktop round: no window appears, nothing takes focus, and no input reaches the
 * system. It renders `out/renderer/settings.html` and `out/renderer/video.html` with their real preloads, the real
 * `settingsView` over the app's own `RecordingsLibrary`: the matrix scripts/preview-ui.mts lists, and writes the
 * pictures with an index.html, the shots.json manifest and the page's own measurements.json beside them. It judges
 * nothing: it is for looking and comparing. Never shipped.
 */
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, protocol } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { settingsView } from "../../src/main/settings/settings-model";
import { DEFAULT_QUALITY } from "../../src/shared/quality";
import { DEFAULT_HOTKEY } from "../../src/shared/hotkey";
import type { AppContext } from "../../src/main/app/ui-model";
import type { RecordingState } from "../../src/shared/state";
import type { SettingsTab } from "../../src/shared/settings-panel";
import type { LibraryState } from "../../src/main/library/recordings-library";
import type { LibraryLayout } from "../../src/shared/appearance";
import type { RecordingResult } from "../../src/shared/recording-result";
import { MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES, RecordingsLibrary } from "../../src/main/library/recordings-library";
import { settingsWindowOptions, ZOOM_STEPS } from "../../src/main/settings/settings-window";
import { DEFAULT_SETTINGS_SIZE, MIN_SETTINGS_SIZE } from "../../src/main/settings/settings-window-state";
import { SETTINGS_CHANNELS } from "../../src/shared/settings-panel";
import { MEASURE_UI, type UiMeasurement } from "./ui-measure";
import { VIDEO_CHANNELS, VIDEO_QUERY } from "../../src/shared/video-player";
import type { Language } from "../../src/shared/i18n";

const [outDir, root, clips] = (() => {
  const [output, repository, folder] = process.argv.slice(-3);
  if (!output || !repository || !folder) throw new Error("Expected output, repository and clip folder");
  return [output, repository, folder] as const;
})();
const out = path.join(root, "out");
app.setPath("userData", path.join(outDir, "user-data"));
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { ...MEDIA_SCHEME_PRIVILEGES } }]);
// Nothing of this run belongs in the Dock or the menu bar.
if (process.platform === "darwin") app.dock?.hide();
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/**
 * Polls until `check` holds. A check that throws, such as one reading an element the page has not made yet, counts
 * as not yet: the case then passes or fails on its own record, never by stopping the round. Giving up says the last
 * error thrown, and whether the checks after it still answered no.
 */
const until = async (check: () => Promise<boolean>, timeout = 4000): Promise<boolean> => {
  const deadline = Date.now() + timeout;
  let failure: unknown;
  let answered = false;
  do {
    try { if (await check()) return true; answered = true; } catch (error) { failure = error; answered = false; }
    await settle(40);
  } while (Date.now() < deadline);
  if (failure !== undefined) {
    console.log(`until: gave up after ${timeout} ms; a check threw ${String(failure)}${answered ? ", and the later checks answered no" : ""}`);
  }
  return false;
};

/** A thumbnail like a screen recording's: a window-ish panel on a tinted desktop, so cards read as pictures. */
const pictureOf = (red: number, green: number, blue: number): Buffer => {
  const width = 480, height = 270, pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const panel = x > 60 && x < 420 && y > 40 && y < 230, bar = panel && y < 62;
    const shade = panel ? (bar ? 0.92 : 0.98) : 1 - (y / height) * 0.45, at = (y * width + x) * 4;
    const [r, g, b] = panel ? [245, 245, 247] : [red, green, blue];
    pixels[at] = Math.round(b * shade); pixels[at + 1] = Math.round(g * shade); pixels[at + 2] = Math.round(r * shade); pixels[at + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, { width, height }).toJPEG(85);
};
const TINTS: Array<[number, number, number]> = [[64, 112, 196], [196, 120, 64], [72, 150, 110], [150, 80, 160], [200, 70, 70], [60, 150, 170]];

async function run(): Promise<void> {
  const files = fs.readdirSync(clips).filter(name => name.endsWith(".mp4")).sort();
  const pictures = new Map(files.map((name, index) => [path.join(clips, name), pictureOf(...TINTS[index % TINTS.length]!)]));
  const library = new RecordingsLibrary({ dir: () => clips, changed: () => {}, thumbnail: async file => pictures.get(file),
    trash: async () => {}, open: async () => "", reveal: () => {}, log: () => {} });
  protocol.handle(MEDIA_SCHEME, request => library.handle(request));
  await library.refresh();
  await library.lengths;
  let language: Language = "zh-TW";
  let state: RecordingState = { type: "idle" };
  let libraryLayout: LibraryLayout = "grid";
  let recordingResults: RecordingResult[] = [];
  /** A folder state drawn in place of the real one: empty, or unreadable (plan 067). */
  let libraryOverride: LibraryState | undefined;
  // A portrait screen beside a landscape primary, so the Screen row draws an arrangement (2026-10-08).
  const PREVIEW_DISPLAYS: AppContext["displays"] = [
    { id: "1", label: "BenQ BL2480T", logicalWidth: 1080, logicalHeight: 1920, scaleFactor: 1, internal: false, primary: false, x: -1080, y: -620 },
    { id: "2", label: "BenQ GW2785TC", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 1, internal: false, primary: true, x: 0, y: 0 },
  ];
  const context = (): AppContext => ({ platform: process.platform, language, outputDir: clips, homeDir: os.homedir(), version: "1.5.0",
    quality: DEFAULT_QUALITY, countdown: 3, countdownSound: true, hotkey: { ...DEFAULT_HOTKEY, registered: true }, notifications: true,
    updates: { enabled: true, state: { kind: "idle" } }, display: { kind: "primary" }, displays: PREVIEW_DISPLAYS, library: libraryOverride ?? library.state, libraryLayout, recordingResults });
  let entry = 0;
  let tab: SettingsTab = "library";
  const view = () => ({ ...settingsView(state, context()), resultFocus: entry, entryTab: tab });
  ipcMain.handle("settings:read", () => view());
  ipcMain.handle("settings:ready", () => {});
  ipcMain.handle("settings:capture", () => view());
  // Move to Trash and Undo run for real, so the toast can be drawn (2026-10-06): the library's Trash is a no-op here and
  // its delayed move is undone before the window closes; every other choice changes nothing.
  ipcMain.handle("settings:choose", async (_event, group: unknown, choice: unknown) => {
    if (typeof group === "string" && group.startsWith("recordingFile:") && choice === "trash") {
      // The answer's view is made after the action, as the app's is (settings-window.ts applyFile).
      const applied = await library.act(group.slice("recordingFile:".length), "trash");
      return { view: view(), applied };
    }
    if (group === "library" && choice === "undoTrash") { const applied = await library.undoTrash(); return { view: view(), applied }; }
    return { view: view(), applied: false };
  });
  ipcMain.handle(VIDEO_CHANNELS.ready, () => {});
  ipcMain.handle(VIDEO_CHANNELS.exit, () => {});

  /** One picture: what it shows (manifest) and what the page measured when it was taken (plan 067). */
  interface Shot { file: string; caption: string; group: string; tab: string; state: string; lang: Language; scheme: string; size: string; width: number; height: number; zoom: number; scroll: string }
  const shots: Shot[] = [];
  const measurements: Record<string, UiMeasurement> = {};
  let current: Omit<Shot, "file" | "caption" | "tab" | "state" | "scroll" | "zoom"> = { group: "", lang: language, scheme: "light", size: "default", width: 0, height: 0 };
  const shoot = async (window: BrowserWindow, file: string, caption: string, detail: { tab?: string; state?: string; scroll?: string } = {}): Promise<void> => {
    await settle(250);
    await window.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
    fs.writeFileSync(path.join(outDir, file), (await window.webContents.capturePage()).toPNG());
    shots.push({ file, caption, ...current, tab: detail.tab ?? tab, state: detail.state ?? "idle", scroll: detail.scroll ?? "top", zoom: window.webContents.getZoomFactor() });
    measurements[file] = await window.webContents.executeJavaScript(MEASURE_UI) as UiMeasurement;
    console.log(`shot ${file}`);
  };
  const open = async (size: { width: number; height: number }): Promise<BrowserWindow> => {
    const options = settingsWindowOptions({ platform: process.platform, preloadPath: path.join(out, "preload/settings.js"),
      title: "RecordStuff", size, workArea: { x: 0, y: 0, width: 4000, height: 3000 } });
    // Offscreen: drawn into memory at the window's size, never shown; at twice the pixels, as a Retina display draws it,
    // so small text can be read in the pictures (plan 067).
    const window = new BrowserWindow({ ...options, minWidth: 0, minHeight: 0, show: false,
      webPreferences: { ...options.webPreferences, offscreen: { deviceScaleFactor: 2 }, backgroundThrottling: false } });
    window.setContentSize(size.width, size.height);
    // Offscreen is not silent: the clip's tone must not sound over the desk or into someone's recording (review: audio).
    window.webContents.setAudioMuted(true);
    // The app's own zoom mode: this window's zoom is its own (settings-window.ts).
    window.webContents.setZoomMode("isolated");
    await window.loadFile(path.join(out, "renderer/settings.html"), { query: { lang: language } });
    await settle(500);
    return window;
  };
  /** Moves the page to a tab the way an entry does, and draws it. */
  const show = async (window: BrowserWindow, next: SettingsTab): Promise<void> => {
    tab = next; entry += 1;
    window.webContents.send("settings:changed", view());
    await settle(300);
  };
  const run = (window: BrowserWindow, script: string): Promise<unknown> => window.webContents.executeJavaScript(script);
  const scrollable = async (window: BrowserWindow): Promise<boolean> =>
    await run(window, `(p => p.scrollHeight > p.clientHeight + 2)(document.getElementById("settings-panel"))`) as boolean;
  const toBottom = (window: BrowserWindow): Promise<unknown> => run(window, `(p => { p.scrollTop = p.scrollHeight; })(document.getElementById("settings-panel"))`);
  const toTop = (window: BrowserWindow): Promise<unknown> => run(window, `document.getElementById("settings-panel").scrollTop = 0`);
  const begin = async (group: string, lang: Language, scheme: "light" | "dark", sizeName: string, size: { width: number; height: number }): Promise<BrowserWindow> => {
    language = lang; state = { type: "idle" }; libraryOverride = undefined;
    nativeTheme.themeSource = scheme;
    current = { group, lang, scheme, size: sizeName, width: size.width, height: size.height };
    return open(size);
  };
  const TABS = ["library", "recording", "general", "failures"] as const;

  // 1. The baseline matrix: every tab, both languages and themes, the default, narrow and minimum sizes, and the
  //    bottom of every page that scrolls (plan 067 step 2).
  const sizes = { default: DEFAULT_SETTINGS_SIZE, narrow: { width: 440, height: 760 }, minimum: MIN_SETTINGS_SIZE } as const;
  for (const lang of ["zh-TW", "en"] as const) for (const scheme of ["light", "dark"] as const) for (const [sizeName, size] of Object.entries(sizes)) {
    const window = await begin("baseline", lang, scheme, sizeName, size);
    for (const each of TABS) {
      await show(window, each);
      await shoot(window, `${each}-${lang}-${scheme}-${sizeName}.png`, `${each} · ${lang} · ${scheme} · ${sizeName}`);
      if (await scrollable(window)) {
        await toBottom(window);
        await shoot(window, `${each}-bottom-${lang}-${scheme}-${sizeName}.png`, `${each}, scrolled to the bottom · ${lang} · ${scheme} · ${sizeName}`, { scroll: "bottom" });
        await toTop(window);
      }
    }
    if (sizeName === "default") {
      current.group = "states";
      state = { type: "recording", startedAt: new Date().toISOString() };
      await show(window, "recording");
      await shoot(window, `recording-state-${lang}-${scheme}.png`, `recording in progress · ${lang} · ${scheme}`, { state: "recording" });
      state = { type: "needsPermission", needsRelaunch: false };
      await show(window, "library");
      await shoot(window, `permission-${lang}-${scheme}.png`, `screen recording permission missing · ${lang} · ${scheme}`, { state: "needsPermission" });
      state = { type: "idle" };
      // The Recordings list (2026-10-05), then the grid again for the player below.
      libraryLayout = "list";
      await show(window, "library");
      await shoot(window, `library-list-${lang}-${scheme}.png`, `recordings as a list · ${lang} · ${scheme}`, { state: "list" });
      libraryLayout = "grid";
      // Failures with the newest open (2026-10-05): an open row reads apart from the closed ones.
      const at = (hours: number): string => new Date(Date.now() - hours * 3600_000).toISOString();
      recordingResults = [
        { id: "disk", occurredAt: at(0.5), code: "disk_full", detail: "ENOSPC: no space left on device", outcome: "partial", partialPath: path.join(clips, "partial.recording.mp4"), acknowledged: false },
        { id: "capture", occurredAt: at(2), code: "capture_start_failed", detail: "screen/audio capture request timed out", outcome: "empty", acknowledged: true },
        { id: "folder", occurredAt: at(3), code: "output_open_failed", detail: "EACCES: permission denied", outcome: "empty", acknowledged: true },
      ];
      // Entering the tab opens the unread row by itself (controller/results.ts reconcileResults); a click would close it.
      await show(window, "failures");
      await shoot(window, `failures-open-${lang}-${scheme}.png`, `failures, newest open · ${lang} · ${scheme}`, { state: "failures-open" });
      await run(window, `document.querySelectorAll("#recording-results .result-summary")[1]?.click()`);
      await shoot(window, `failures-two-open-${lang}-${scheme}.png`, `failures, two open · ${lang} · ${scheme}`, { state: "failures-two-open" });
      recordingResults = [];
      await show(window, "library");
      // The player on the decodable clip, if FFmpeg made one: playing with its controls, then paused.
      const playable = view().library?.items.find(item => item.name.startsWith("preview-"));
      if (playable && lang === "zh-TW") {
        await run(window, `document.getElementById(${JSON.stringify(`clip-${playable.id}-open`)}).click()`);
        await until(() => run(window, `(() => { const v = document.querySelector(".player video"); return v && !v.paused && v.currentTime > 0.5; })()`) as Promise<boolean>);
        await shoot(window, `player-playing-${lang}-${scheme}.png`, `player playing · ${lang} · ${scheme}`, { state: "player-playing" });
        await run(window, `(() => { const v = document.querySelector(".player video"); v.pause(); v.currentTime = 3; })()`);
        await shoot(window, `player-paused-${lang}-${scheme}.png`, `player paused · ${lang} · ${scheme}`, { state: "player-paused" });
        // What → and ↑ flash over the picture (2026-10-06), caught a quarter of a second in.
        await run(window, `(() => { const v = document.querySelector(".player video"); v.volume = 0.5; v.muted = false;
          for (const key of ["ArrowRight", "ArrowUp"]) v.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); })()`);
        await shoot(window, `player-flash-${lang}-${scheme}.png`, `player after → and ↑ · ${lang} · ${scheme}`, { state: "player-flash" });
        await run(window, `document.getElementById("player-close").click()`);
        await settle(300);
      }
    }
    // The toast after Move to Trash, in Traditional Chinese at every size, then undone so the folder is listed whole again.
    if (lang === "zh-TW") {
      current.group = "states";
      state = { type: "idle" };
      await show(window, "library");
      await run(window, `(() => { document.querySelector(".clip-more").click(); document.getElementById("clip-menu-trash").click(); })()`);
      await settle(700);
      await shoot(window, `toast-${lang}-${scheme}-${sizeName}.png`, `toast after Move to Trash · ${lang} · ${scheme} · ${sizeName}`, { state: "toast" });
      await library.undoTrash();
    }
    window.destroy();
  }

  // 2. Transient and edge states on representative combinations (plan 067 step 2): help, an invalid file name, the
  //    card menu, renaming, an empty and an unreadable folder, keyboard focus and the zoom notice.
  for (const lang of ["zh-TW", "en"] as const) for (const [sizeName, size] of [["default", DEFAULT_SETTINGS_SIZE], ["minimum", MIN_SETTINGS_SIZE]] as const) {
    const scheme = sizeName === "default" ? "light" : "dark";
    const window = await begin("states", lang, scheme, sizeName, size);
    const suffix = `${lang}-${scheme}-${sizeName}`;
    await show(window, "recording");
    await run(window, `document.getElementById("setting-countdown-row").scrollIntoView({ block: "center" })`);
    await run(window, `document.getElementById("setting-countdown-info-button").click()`);
    await settle(300);
    await shoot(window, `help-${suffix}.png`, `help popover · ${lang} · ${scheme} · ${sizeName}`, { state: "help" });
    await run(window, `document.getElementById("setting-countdown-info-button").click()`);
    await run(window, `(f => { f.scrollIntoView({ block: "center" }); f.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(f, "{date} {nonsense}"); f.dispatchEvent(new Event("input", { bubbles: true })); })(document.getElementById("setting-fileName"))`);
    await shoot(window, `file-name-invalid-${suffix}.png`, `file name template refused · ${lang} · ${scheme} · ${sizeName}`, { state: "file-name-invalid" });
    await run(window, `(f => { f.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); f.blur(); })(document.getElementById("setting-fileName"))`);
    await show(window, "library");
    // An entry keeps the page's scroll; the file name above left it partway down the taller Recording page.
    await toTop(window);
    await run(window, `document.querySelector(".clip-more").click()`);
    await settle(300);
    await shoot(window, `clip-menu-${suffix}.png`, `card menu · ${lang} · ${scheme} · ${sizeName}`, { state: "clip-menu" });
    await run(window, `document.getElementById("clip-menu-rename").click()`);
    await settle(400);
    await shoot(window, `rename-${suffix}.png`, `rename dialog · ${lang} · ${scheme} · ${sizeName}`, { state: "rename" });
    await run(window, `(f => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(f, "bad/name"); f.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("clip-rename-confirm").click(); })(document.getElementById("clip-rename-input"))`);
    await settle(300);
    await shoot(window, `rename-invalid-${suffix}.png`, `rename refused · ${lang} · ${scheme} · ${sizeName}`, { state: "rename-invalid" });
    await run(window, `document.getElementById("clip-rename-cancel").click()`);
    libraryOverride = { ...library.state, files: [] };
    await show(window, "library");
    await shoot(window, `library-empty-${suffix}.png`, `empty folder · ${lang} · ${scheme} · ${sizeName}`, { state: "library-empty" });
    libraryOverride = { ...library.state, failed: true, files: [] };
    await show(window, "library");
    await shoot(window, `library-failed-${suffix}.png`, `unreadable folder · ${lang} · ${scheme} · ${sizeName}`, { state: "library-failed" });
    libraryOverride = undefined;
    await show(window, "general");
    // Keyboard focus as Tab draws it, on the selected tab.
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await run(window, `document.getElementById("tab-general").focus()`);
    await shoot(window, `focus-tab-${suffix}.png`, `keyboard focus on a tab · ${lang} · ${scheme} · ${sizeName}`, { state: "focus" });
    window.destroy();
  }

  // 3. Breakpoints and a large window (plan 067 step 2): either side of 600 px (sidebar) and 420 px (rows), at 640 px high.
  for (const lang of ["en", "zh-TW"] as const) {
    for (const width of [599, 600, 601, 419, 420, 421, 1440]) {
      const size = { width, height: width === 1440 ? 900 : 640 };
      const window = await begin(width === 1440 ? "large" : "breakpoints", lang, "light", `${width}x${size.height}`, size);
      for (const each of ["recording", "library"] as const) {
        await show(window, each);
        await shoot(window, `${each}-${lang}-light-${width}x${size.height}.png`, `${each} · ${lang} · light · ${width}×${size.height}`);
      }
      window.destroy();
    }
  }

  // 4. Zoom (plan 067 step 2) through the app's own steps (settings-window.ts ZOOM_STEPS) at the default and minimum
  //    sizes. 200% lies beyond the app's last step: it is drawn as a reflow probe and named so.
  for (const lang of ["en", "zh-TW"] as const) for (const [sizeName, size] of [["default", DEFAULT_SETTINGS_SIZE], ["minimum", MIN_SETTINGS_SIZE]] as const) {
    const window = await begin("zoom", lang, "light", sizeName, size);
    for (const factor of [ZOOM_STEPS.at(-2)!, ZOOM_STEPS.at(-1)!, 2]) {
      window.webContents.setZoomFactor(factor);
      await settle(300);
      const label = `${Math.round(factor * 100)}`;
      for (const each of ["recording", "general", "library"] as const) {
        await show(window, each);
        await shoot(window, `zoom${label}-${each}-${lang}-${sizeName}.png`, `${each} at ${label}%${factor > ZOOM_STEPS.at(-1)! ? " (probe beyond the app's steps)" : ""} · ${lang} · ${sizeName}`);
        if (await scrollable(window)) {
          await toBottom(window);
          await shoot(window, `zoom${label}-${each}-bottom-${lang}-${sizeName}.png`, `${each} at ${label}%, bottom · ${lang} · ${sizeName}`, { scroll: "bottom" });
          await toTop(window);
        }
      }
    }
    if (sizeName === "default") {
      // The notice ⌘+ draws, as main reports a step.
      window.webContents.setZoomFactor(ZOOM_STEPS.at(-2)!);
      window.webContents.send(SETTINGS_CHANNELS.zoomChanged, { factor: ZOOM_STEPS.at(-2)!, canZoomIn: true, canZoomOut: true });
      await settle(400);
      await shoot(window, `zoom-notice-${lang}.png`, `zoom notice at ${Math.round(ZOOM_STEPS.at(-2)! * 100)}% · ${lang}`, { state: "zoom-notice" });
    }
    window.destroy();
  }

  // The full-screen page, at a display's size, paused at 3 s with its controls showing.
  const playable = view().library?.items.find(item => item.name.startsWith("preview-"));
  if (playable) {
    for (const scheme of ["light", "dark"] as const) {
      nativeTheme.themeSource = scheme;
      current = { group: "fullscreen", lang: language, scheme, size: "1440x900", width: 1440, height: 900 };
      const full = new BrowserWindow({ width: 1440, height: 900, show: false, frame: false, backgroundColor: "#000000",
        webPreferences: { preload: path.join(out, "preload/video.js"), sandbox: true, contextIsolation: true, offscreen: { deviceScaleFactor: 2 }, backgroundThrottling: false } });
      full.setContentSize(1440, 900);
      full.webContents.setAudioMuted(true);
      await full.loadFile(path.join(out, "renderer/video.html"), { query: { [VIDEO_QUERY.src]: playable.video, [VIDEO_QUERY.time]: "3", [VIDEO_QUERY.playing]: "0",
        [VIDEO_QUERY.volume]: "1", [VIDEO_QUERY.muted]: "0", [VIDEO_QUERY.language]: language, [VIDEO_QUERY.title]: playable.title } });
      await until(() => full.webContents.executeJavaScript(`document.getElementById("video").readyState >= 2`));
      await shoot(full, `fullscreen-${scheme}.png`, `full screen · paused · ${scheme}`, { tab: "video", state: "paused" });
      full.destroy();
    }
  }
  nativeTheme.themeSource = "system";
  const html = `<!doctype html><meta charset="utf-8"><title>RecordStuff UI preview</title>
<style>body{font:13px -apple-system,sans-serif;margin:24px;background:#f4f4f5}figure{display:inline-block;margin:0 16px 24px 0;vertical-align:top}
img{max-width:480px;width:100%;border:1px solid #ddd;border-radius:8px;display:block}figcaption{margin-top:6px;color:#555}</style>
<h1>RecordStuff UI preview</h1><p>${new Date().toISOString()} · built out/ · offscreen</p>
${shots.map(shot => `<figure><a href="${shot.file}"><img src="${shot.file}" loading="lazy"></a><figcaption>${shot.caption}</figcaption></figure>`).join("\n")}`;
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  fs.writeFileSync(path.join(outDir, "shots.json"), `${JSON.stringify(shots, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "measurements.json"), `${JSON.stringify(measurements)}\n`);
}

app.on("window-all-closed", () => undefined);
app.whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch(error => {
    fs.writeFileSync(path.join(outDir, "error.txt"), String(error?.stack ?? error));
    app.exit(1);
  });
