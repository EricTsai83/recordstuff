/**
 * Electron main for a one-off design comparison (2026-10-13, commit d02f1e59 "align selected tab cap with tile edge"):
 * the selected sidebar tab's cap drawn in several candidate shapes over the built Settings window, offscreen, in light
 * and dark, each cropped to the tab and listed in shots.json beside its caption. Adapted from ui-preview.ts. No pnpm
 * command or runner builds it; it judges nothing and is kept only to redraw the comparison. Never shipped.
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
import { settingsWindowOptions } from "../../src/main/settings/settings-window";
import { DEFAULT_SETTINGS_SIZE } from "../../src/main/settings/settings-window-state";
import { VIDEO_CHANNELS } from "../../src/shared/video-player";
import type { Language } from "../../src/shared/i18n";

const [outDir, root, clips] = (() => {
  const [output, repository, folder] = process.argv.slice(-3);
  if (!output || !repository || !folder) throw new Error("Expected output, repository and clip folder");
  return [output, repository, folder] as const;
})();
const out = path.join(root, "out");
app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.setPath("userData", path.join(outDir, "user-data"));
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { ...MEDIA_SCHEME_PRIVILEGES } }]);
// Nothing of this run belongs in the Dock or the menu bar.
if (process.platform === "darwin") app.dock?.hide();
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
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
  const BASE = `[data-variant="sidebar"] [role="tab"][aria-selected="true"]::before { content: ""; position: absolute; inset: 0 auto 0 0; width: auto; border: 0; border-radius: 0; box-shadow: none; background: none; pointer-events: none; }`;
  const S = `[data-variant="sidebar"] [role="tab"][aria-selected="true"]::before`;
  const variants: Array<[string, string, string]> = [
    ["old", "old", `${S}{inset:-4px auto -4px -4px;width:20px;border-left:8px solid var(--sidebar-primary);border-radius:18px 0 0 18px / 50% 0 0 50%}`],
    ["t1", "t1", `${S}{inset:0 0 0 4px;border-radius:10px 0 0 10px / 50% 0 0 50%;box-shadow:0 0 0 40px var(--sidebar-primary)}`],
    ["t2", "t2", `${S}{inset:0 0 0 4px;border-radius:11px 0 0 11px / 50% 0 0 50%;box-shadow:0 0 0 40px var(--sidebar-primary)}`],
    ["t3", "t3", `${S}{inset:-1px 0 -1px 4px;border-radius:10px 0 0 10px / 50% 0 0 50%;box-shadow:0 0 0 40px var(--sidebar-primary)}`],
  ];
  const shotsOut: Array<[string, string]> = [];
  for (const scheme of ["light", "dark"] as const) {
    nativeTheme.themeSource = scheme;
    const window = await open({ width: DEFAULT_SETTINGS_SIZE.width * 2, height: DEFAULT_SETTINGS_SIZE.height * 2 });
    window.webContents.setZoomFactor(2);
    await settle(400);
    let key: string | undefined;
    for (const [id, caption, css] of variants) {
      if (key) await window.webContents.removeInsertedCSS(key);
      key = await window.webContents.insertCSS(`${BASE}\n${css}`);
      await settle(250);
      await window.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
      const r = await window.webContents.executeJavaScript(`(() => { const l = document.querySelector('[data-variant="sidebar"] [aria-selected="true"]').getBoundingClientRect(); return { x: Math.max(0, Math.floor(l.x) - 8), y: Math.max(0, Math.floor(l.y) - 8), width: 150, height: Math.ceil(l.height) + 16 }; })()`) as Electron.Rectangle;
      const file = `${id}-${scheme}.png`;
      const page = await window.webContents.capturePage(), scale = page.getSize().width / window.getContentSize()[0]! * window.webContents.getZoomFactor();
      fs.writeFileSync(path.join(outDir, file), page.crop({ x: Math.round(r.x * scale), y: Math.round(r.y * scale), width: Math.round(r.width * scale), height: Math.round(r.height * scale) }).toPNG());
      shotsOut.push([file, `${caption} · ${scheme}`]);
    }
    window.destroy();
  }
  nativeTheme.themeSource = "system";
  fs.writeFileSync(path.join(outDir, "shots.json"), JSON.stringify(shotsOut));
}

app.on("window-all-closed", () => undefined);
app.whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch(error => {
    fs.writeFileSync(path.join(outDir, "error.txt"), String(error?.stack ?? error));
    app.exit(1);
  });
