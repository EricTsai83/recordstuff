/**
 * Electron main for `pnpm preview:ui` (2026-10-05): a gallery of the built Settings window and full-screen page,
 * drawn offscreen, so it needs no desktop round: no window appears, nothing takes focus, and no input reaches the
 * system. It renders `out/renderer/settings.html` and `out/renderer/video.html` with their real preloads, the real
 * `settingsView` over the app's own `RecordingsLibrary`, in both languages and themes at the default and a narrow
 * size, each tab, a recording state, a permission problem, the player and the full-screen page, and writes the
 * pictures with an index.html beside them. It judges nothing: it is for looking. Never shipped.
 */
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, protocol, screen } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { settingsView } from "../../src/main/settings-model";
import { DEFAULT_QUALITY } from "../../src/shared/quality";
import { DEFAULT_HOTKEY } from "../../src/shared/hotkey";
import type { AppContext } from "../../src/main/ui-model";
import type { RecordingState } from "../../src/shared/state";
import type { SettingsTab } from "../../src/shared/settings-panel";
import type { LibraryLayout } from "../../src/shared/appearance";
import type { RecordingResult } from "../../src/shared/recording-result";
import { MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES, RecordingsLibrary } from "../../src/main/recordings-library";
import { settingsWindowOptions } from "../../src/main/settings-window";
import { DEFAULT_SETTINGS_SIZE } from "../../src/main/settings-window-state";
import { VIDEO_CHANNELS, VIDEO_QUERY } from "../../src/shared/video-player";
import { phrases, type Language } from "../../src/shared/i18n";

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
  const context = (): AppContext => ({ platform: process.platform, language, outputDir: clips, homeDir: os.homedir(), version: "1.5.0",
    quality: DEFAULT_QUALITY, countdown: 3, countdownSound: true, hotkey: { ...DEFAULT_HOTKEY, registered: true }, notifications: true,
    updates: { enabled: true, state: { kind: "idle" } }, display: { kind: "primary" }, displays: [], library: library.state, libraryLayout, recordingResults });
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

  const shots: Array<{ file: string; caption: string }> = [];
  const shoot = async (window: BrowserWindow, file: string, caption: string): Promise<void> => {
    await settle(250);
    fs.writeFileSync(path.join(outDir, file), (await window.webContents.capturePage()).toPNG());
    shots.push({ file, caption });
    console.log(`shot ${file}`);
  };
  const open = async (size: { width: number; height: number }): Promise<BrowserWindow> => {
    const options = settingsWindowOptions({ platform: process.platform, preloadPath: path.join(out, "preload/settings.js"),
      title: "RecordStuff", size, workArea: screen.getPrimaryDisplay().workArea });
    // Offscreen: drawn into memory at the window's size, never shown.
    const window = new BrowserWindow({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    window.setContentSize(size.width, size.height);
    // Offscreen is not silent: the clip's tone must not sound over the desk or into someone's recording (review: audio).
    window.webContents.setAudioMuted(true);
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

  const sizes = { default: DEFAULT_SETTINGS_SIZE, narrow: { width: 440, height: 760 } } as const;
  for (const lang of ["zh-TW", "en"] as const) for (const scheme of ["light", "dark"] as const) for (const [sizeName, size] of Object.entries(sizes)) {
    language = lang; state = { type: "idle" };
    nativeTheme.themeSource = scheme;
    const window = await open(size);
    for (const each of ["library", "recording", "general", "failures"] as const) {
      await show(window, each);
      await shoot(window, `${each}-${lang}-${scheme}-${sizeName}.png`, `${each} · ${lang} · ${scheme} · ${sizeName}`);
    }
    if (lang === "zh-TW" && sizeName === "default") {
      state = { type: "recording", startedAt: new Date().toISOString() };
      await show(window, "recording");
      await shoot(window, `recording-state-${lang}-${scheme}.png`, `recording in progress · ${lang} · ${scheme}`);
      state = { type: "needsPermission", needsRelaunch: false };
      await show(window, "library");
      await shoot(window, `permission-${lang}-${scheme}.png`, `screen recording permission missing · ${lang} · ${scheme}`);
      state = { type: "idle" };
      // The Recordings list (2026-10-05), then the grid again for the player below.
      libraryLayout = "list";
      await show(window, "library");
      await shoot(window, `library-list-${lang}-${scheme}.png`, `recordings as a list · ${lang} · ${scheme}`);
      libraryLayout = "grid";
      // Failures with the newest open (2026-10-05): an open row reads apart from the closed ones.
      const at = (hours: number): string => new Date(Date.now() - hours * 3600_000).toISOString();
      recordingResults = [
        { id: "disk", occurredAt: at(0.5), code: "disk_full", detail: "ENOSPC: no space left on device", outcome: "partial", partialPath: path.join(clips, "partial.recording.mp4"), acknowledged: false },
        { id: "capture", occurredAt: at(2), code: "capture_start_failed", detail: "screen/audio capture request timed out", outcome: "empty", acknowledged: true },
        { id: "folder", occurredAt: at(3), code: "output_open_failed", detail: "EACCES: permission denied", outcome: "empty", acknowledged: true },
      ];
      await show(window, "failures");
      await window.webContents.executeJavaScript(`(() => { const row = document.querySelector("#recording-results .recording-result"); row.open = true; row.dispatchEvent(new Event("toggle")); })()`);
      await shoot(window, `failures-open-${lang}-${scheme}.png`, `failures, newest open · ${lang} · ${scheme}`);
      recordingResults = [];
      await show(window, "library");
      // The player on the decodable clip, if FFmpeg made one: playing with its controls, then paused.
      const playable = view().library?.items.find(item => item.name.startsWith("preview-"));
      if (playable) {
        await window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(`clip-${playable.id}-open`)}).click()`);
        await until(() => window.webContents.executeJavaScript(`(() => { const v = document.querySelector("dialog.player video"); return v && !v.paused && v.currentTime > 0.5; })()`));
        await shoot(window, `player-playing-${lang}-${scheme}.png`, `player playing · ${lang} · ${scheme}`);
        await window.webContents.executeJavaScript(`(() => { const v = document.querySelector("dialog.player video"); v.pause(); v.currentTime = 3; })()`);
        await shoot(window, `player-paused-${lang}-${scheme}.png`, `player paused · ${lang} · ${scheme}`);
        await window.webContents.executeJavaScript(`document.querySelector("dialog.player").close()`);
      }
    }
    // The toast after Move to Trash, in Traditional Chinese at both sizes, then undone so the folder is listed whole again.
    if (lang === "zh-TW") {
      state = { type: "idle" };
      await show(window, "library");
      await window.webContents.executeJavaScript(`(() => { document.querySelector(".clip-more").click(); document.getElementById("clip-menu-trash").click(); })()`);
      await settle(700);
      await shoot(window, `toast-${lang}-${scheme}-${sizeName}.png`, `toast after Move to Trash · ${lang} · ${scheme} · ${sizeName}`);
      await library.undoTrash();
    }
    window.destroy();
  }

  // The full-screen page, at a display's size, paused at 3 s with its controls showing.
  const playable = view().library?.items.find(item => item.name.startsWith("preview-"));
  if (playable) {
    for (const scheme of ["light", "dark"] as const) {
      nativeTheme.themeSource = scheme;
      const full = new BrowserWindow({ width: 1440, height: 900, show: false, frame: false, backgroundColor: "#000000",
        webPreferences: { preload: path.join(out, "preload/video.js"), sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
      full.setContentSize(1440, 900);
      full.webContents.setAudioMuted(true);
      await full.loadFile(path.join(out, "renderer/video.html"), { query: { [VIDEO_QUERY.src]: playable.video, [VIDEO_QUERY.time]: "3", [VIDEO_QUERY.playing]: "0",
        [VIDEO_QUERY.volume]: "1", [VIDEO_QUERY.muted]: "0", [VIDEO_QUERY.language]: language, [VIDEO_QUERY.title]: phrases([playable.day, playable.title], language) } });
      await until(() => full.webContents.executeJavaScript(`document.getElementById("video").readyState >= 2`));
      await shoot(full, `fullscreen-${scheme}.png`, `full screen · paused · ${scheme}`);
      full.destroy();
    }
  }
  nativeTheme.themeSource = "system";
  const html = `<!doctype html><meta charset="utf-8"><title>RecordStuff UI preview</title>
<style>body{font:13px -apple-system,sans-serif;margin:24px;background:#f4f4f5}figure{display:inline-block;margin:0 16px 24px 0;vertical-align:top}
img{max-width:480px;border:1px solid #ddd;border-radius:8px;display:block}figcaption{margin-top:6px;color:#555}</style>
<h1>RecordStuff UI preview</h1><p>${new Date().toISOString()} · built out/ · offscreen</p>
${shots.map(shot => `<figure><a href="${shot.file}"><img src="${shot.file}" loading="lazy"></a><figcaption>${shot.caption}</figcaption></figure>`).join("\n")}`;
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  fs.writeFileSync(path.join(outDir, "shots.json"), `${JSON.stringify(shots, null, 2)}\n`);
}

app.on("window-all-closed", () => undefined);
app.whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch(error => {
    fs.writeFileSync(path.join(outDir, "error.txt"), String(error?.stack ?? error));
    app.exit(1);
  });
