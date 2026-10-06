/**
 * The view host (plan 066): the production settings page and preload in a hidden offscreen window, answered by this
 * fixture's own IPC handlers over the real `settingsView`, `RecordingResults` and `RecordingsLibrary`, with the media
 * scheme served as the app serves it. It is the background home of the former `scripts/fixtures/settings-panel.ts`
 * (`RECORDSTUFF_UI_VIEW=panel`, the default) and of the component checks' synthetic view (`components`).
 *
 * Its evidence is the shipped page under the shipped CSP, the sandboxed preload boundary, real IPC round trips and
 * the media protocol; it does not claim `SettingsWindow`'s handlers, which the app host (app-host.ts) covers.
 * Tests drive the page with Playwright input and reach this process through `globalThis.__recordstuff`.
 *
 * Test-only; compiled by tests/ui/global-setup.ts. Nothing here ships with the app.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type * as ElectronModule from "electron";
import { createBoundary } from "./boundary";
import { RecordingResults } from "../../../src/main/recording/recording-result";
import { settingsAction, settingsView } from "../../../src/main/settings/settings-model";
import { translate, type Language } from "../../../src/shared/i18n";
import type { SettingsView } from "../../../src/shared/settings-panel";
import type { RecordingState } from "../../../src/shared/state";
import { DEFAULT_QUALITY } from "../../../src/shared/quality";
import { DEFAULT_HOTKEY } from "../../../src/shared/hotkey";
import type { AppContext } from "../../../src/main/app/ui-model";
import { MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES, RecordingsLibrary } from "../../../src/main/library/recordings-library";
import { settingsWindowOptions } from "../../../src/main/settings/settings-window";
import { DEFAULT_SETTINGS_SIZE, MIN_SETTINGS_SIZE } from "../../../src/main/settings/settings-window-state";
import { prepareDataCleanup } from "../../../src/main/app/data-cleanup";
import { installQuitCoordinator } from "../../../src/main/app/quit-coordinator";

const require = createRequire(__filename);
const electron = require("electron") as typeof ElectronModule;
const root = process.env.RECORDSTUFF_UI_ROOT!;
const data = process.env.RECORDSTUFF_UI_DATA!;
const mode = process.env.RECORDSTUFF_UI_VIEW ?? "panel";
const out = path.join(root, "out");
const { app, ipcMain, nativeImage, nativeTheme, protocol, screen } = electron;
const boundary = createBoundary(electron, { trashDir: path.join(data, "trash"), violationsFile: path.join(data, "violations.jsonl") });
const { BrowserWindow } = boundary.electron;

app.setPath("userData", path.join(data, "profile"));
app.setPath("sessionData", path.join(data, "profile"));
if (process.platform === "darwin") app.dock?.hide();
// The Recordings tab's media, served as the app serves it (index.ts): only privileged before ready.
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { ...MEDIA_SCHEME_PRIVILEGES } }]);
// A window the page closed must not quit the host; the test sees the page close instead.
app.on("window-all-closed", () => undefined);

const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Window sizes of the former fixture's snapshots: the app's default and minimum, and the 560 × 680 narrow layout. */
export const SNAPSHOT_SIZES = {
  default: [DEFAULT_SETTINGS_SIZE.width, DEFAULT_SETTINGS_SIZE.height], narrow: [560, 680], minimum: [MIN_SETTINGS_SIZE.width, MIN_SETTINGS_SIZE.height],
} as const;

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
  return nativeImage.createFromBitmap(pixels, { width, height }).toJPEG(85);
};

/**
 * The Recordings tab's folder, read by the app's own `RecordingsLibrary` and served under the app's scheme: real ids,
 * lengths read from the files' boxes, sizes and dates from the file system. The files are movie headers made sparse
 * to their sizes, dated with `utimes`, and two have pictures while the third shows the fallback.
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

/** The former fixture's own view: shaped like what settings-model produces, including a refused shortcut. */
function fixtureView(language: Language, notifications: boolean): SettingsView {
  const zh = language === "zh-TW";
  return {
    language,
    title: "RecordStuff",
    hint: "",
    failure: zh ? "無法套用此設定，已顯示目前的設定。" : "Could not apply this setting. Your current settings are shown.",
    tabs: [
      { id: "recording", label: zh ? "錄影設定" : "Recording settings" },
      { id: "general", label: zh ? "一般" : "General" },
    ],
    groups: [
      {
        id: "frameRate", tab: "recording", label: zh ? "幀率" : "Frame rate", enabled: true,
        choices: [
          { id: "30", label: "30 fps", enabled: true, checked: true },
          { id: "60", label: zh ? "60 fps（此平台尚未驗證，暫不開放）" : "60 fps (unverified on this platform)", enabled: false, checked: false },
          // Offered, but this host's main never commits a frame rate: a choice it refuses (S013).
          { id: "24", label: "24 fps", enabled: true, checked: false },
        ],
      },
      {
        id: "hotkey", tab: "recording", label: zh ? "快捷鍵" : "Shortcut",
        note: zh ? "這個快捷鍵可能被其他 App 佔用。" : "Another app may be using this shortcut.", enabled: true,
        choices: [
          { id: "CommandOrControl+Alt+Shift+R", label: "⌥⇧⌘R", enabled: true, checked: true },
          { id: "off", label: zh ? "關閉" : "Off", enabled: true, checked: false },
        ],
      },
      {
        id: "notifications", control: "switch", section: "notifications", tab: "general", label: zh ? "通知" : "Notifications",
        info: zh ? "macOS 另外還要在「系統設定 → 通知」中允許 RecordStuff。" : "macOS must also allow RecordStuff in System Settings → Notifications.",
        enabled: true,
        choices: [
          { id: "on", label: zh ? "開啟" : "On", enabled: true, checked: notifications },
          { id: "off", label: zh ? "關閉" : "Off", enabled: true, checked: !notifications },
        ],
        actions: [{ id: "openSettings", label: zh ? "開啟通知設定…" : "Open notification settings…", enabled: true, checked: false }],
      },
      {
        id: "language", control: "segmented", section: "language", tab: "recording", label: zh ? "語言" : "Language", enabled: true,
        choices: [
          { id: "en", label: "English", enabled: true, checked: language === "en" },
          { id: "zh-TW", label: "繁體中文", enabled: true, checked: language === "zh-TW" },
        ],
      },
    ],
  };
}

/** The panel mode's state; tests change it through `host.state`. */
const state = {
  language: "zh-TW" as Language,
  notifications: true,
  captureView: undefined as SettingsView | undefined,
  resultContext: undefined as AppContext | undefined,
  soundContext: undefined as AppContext | undefined,
  updateContext: undefined as AppContext | undefined,
  resultSaveFails: false,
  /** Every durable result save waits, so replies arrive after Chromium's focus fixup (plan 036). */
  saveDelayMs: 120,
  holdSaves: false,
  lastFocus: 0,
};
/** Mutated only by the automatic-retry case; otherwise no background retry can race scripted steps. */
const retryDelays = [3_600_000];
const heldSaves: Array<() => void> = [];
const chooseCalls: Array<[string, unknown]> = [];
let panel: ElectronModule.BrowserWindow | undefined;
let library: RecordingsLibrary | undefined;

const version = (): string => (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
/** The context the former fixture's model snapshots start from. */
const baseContext = (): AppContext => ({ platform: "darwin", language: "en", outputDir: "/tmp", homeDir: "/tmp", version: version(),
  quality: DEFAULT_QUALITY, countdown: 3, countdownSound: true, hotkey: { ...DEFAULT_HOTKEY, registered: true }, notifications: true,
  updates: { enabled: true, state: { kind: "idle" } }, display: { kind: "primary" },
  displays: [{ id: "1", label: "Built-in Display", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: true, primary: true }] });
/** Like SettingsWindow: every projection carries the current entry token. */
const resultView = (): SettingsView => ({ ...settingsView({ type: "idle" }, { ...state.resultContext!, recordingResults: recordingResults.all,
  historyLoading: recordingResults.loading }), resultFocus: state.lastFocus });
/** Production refreshes push the committed view before an action's reply arrives. */
const pushCurrent = (): void => { if (state.resultContext && panel && !panel.isDestroyed()) panel.webContents.send("settings:changed", resultView()); };
const recordingResults = new RecordingResults({ load: async () => [], save: async () => {
  await settle(state.saveDelayMs);
  if (state.resultSaveFails) throw new Error("controlled storage failure");
} }, () => {}, pushCurrent, retryDelays);

function installPanelHandlers(): void {
  ipcMain.handle("settings:read", () => fixtureView(state.language, state.notifications));
  ipcMain.handle("settings:ready", () => {});
  ipcMain.handle("settings:zoom", () => {});
  ipcMain.handle("settings:capture", (_event, armed: boolean) => {
    if (!state.captureView) return fixtureView(state.language, state.notifications);
    state.captureView = structuredClone(state.captureView);
    state.captureView.groups.find(group => group.id === "hotkey")!.capturing = armed;
    return state.captureView;
  });
  ipcMain.handle("settings:choose", async (_event, group: string, choice: string) => {
    chooseCalls.push([group, choice]);
    if (group.startsWith("recordingResult:") && state.resultContext) {
      const action = settingsAction({ type: "idle" }, { ...state.resultContext, recordingResults: recordingResults.all }, group, choice);
      const applied = typeof action === "object" && "recordingResult" in action
        && await recordingResults.act(action.recordingResult.id, action.recordingResult.action, {
          stat: async () => ({ isFile: () => true, size: 1 }), refresh: pushCurrent, settled: () => true,
          platform: "darwin", reveal: () => {}, folder: async () => {}, permission: async () => {}, relaunch: async () => {},
        });
      return { applied, view: resultView() };
    }
    if (group === "countdownSound" && state.soundContext) {
      const action = settingsAction({ type: "idle" }, state.soundContext, group, choice);
      if (typeof action === "object" && "setCountdownSound" in action) state.soundContext = { ...state.soundContext, countdownSound: action.setCountdownSound };
      return { view: settingsView({ type: "idle" }, state.soundContext), applied: action !== undefined };
    }
    if (group === "updates" && state.updateContext) {
      const action = settingsAction({ type: "idle" }, state.updateContext, group, choice);
      if (action === "checkUpdates") {
        state.updateContext = { ...state.updateContext, updates: { ...state.updateContext.updates, state: { kind: "checking", previous: { kind: "current", checkedAt: 1000 } } } };
        panel?.webContents.send("settings:changed", settingsView({ type: "idle" }, state.updateContext));
      }
      return { view: settingsView({ type: "idle" }, state.updateContext), applied: action !== undefined };
    }
    if (group === "about" && state.captureView) return { view: state.captureView, applied: false, failure: "Could not open the link. Try again." };
    // Diagnostic UI input keeps the production projection; the background host does not open Finder.
    if (group === "log" && state.captureView) return { view: state.captureView, applied: choice === "show" };
    const commit = () => {
      if (group === "language" && (choice === "en" || choice === "zh-TW")) state.language = choice;
      if (group === "notifications" && choice !== "openSettings") state.notifications = choice === "on";
      // The pane has no committed value; main uses the handler's own boolean.
      const applied = group === "language"
        || (group === "notifications" && choice === "openSettings")
        || (group === "notifications" && (choice === "on") === state.notifications);
      return { view: fixtureView(state.language, state.notifications), applied };
    };
    if (state.holdSaves) return new Promise(resolve => heldSaves.push(() => resolve(commit())));
    return commit();
  });
}

/** The component checks' synthetic view and handlers (formerly tests/ui/fixture.cjs). */
function installComponentHandlers(): { view: () => SettingsView } {
  const choice = (id: string, label: string, checked = false) => ({ id, label, checked, enabled: true });
  let view: SettingsView = {
    language: "en", title: "RecordStuff", hint: "", failure: "Could not apply this setting.", revision: 1,
    tabs: [{ id: "library", label: "Recordings" }, { id: "recording", label: "Recording settings" }, { id: "general", label: "General" }, { id: "failures", label: "Troubleshooting (1)" }],
    groups: [
      { id: "countdownSound", tab: "recording", label: "Countdown sound", enabled: true, control: "switch", info: "The tick is not recorded.", choices: [choice("on", "On", true), choice("off", "Off")] },
      { id: "fileName", tab: "recording", label: "File name format", enabled: true, control: "text", choices: [choice("{date} {time}", "Default", true)] },
      { id: "language", tab: "general", label: "Language", enabled: true, control: "segmented", choices: [choice("en", "English", true), choice("zh-TW", "繁體中文")] },
      { id: "appearance", tab: "general", label: "Appearance", enabled: true, control: "segmented", iconChoices: true,
        choices: [choice("system", "System default", true), choice("light", "Light"), choice("dark", "Dark")] },
    ],
    recordingResults: [
      { id: "failure", code: "disk_full", outcomeState: "empty", reason: "The disk is full.", day: "Today", time: "2:05 PM", outcome: "No recording was kept.", guidance: "Free disk space.", detail: "ENOSPC",
        acknowledged: false, actions: [choice("acknowledge", "Got it")] },
      { id: "earlier", code: "capture_start_failed", outcomeState: "empty", reason: "The recording could not start.", day: "Yesterday", time: "1:00 PM", outcome: "No recording was kept.", guidance: "Try again.",
        acknowledged: true, actions: [choice("remove", "Remove from history")] },
    ],
    library: {
      folder: "~/Movies",
      items: ["a", "b"].map(id => ({ id, day: "Today", name: `${id}.mp4`, title: id, time: "2:02 PM", duration: "1:23", size: "1 MB", thumbnail: "", video: "" })),
    },
  } as unknown as SettingsView;
  let zoom = 1;
  const changeZoom = (request: string): void => {
    const steps = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
    zoom = request === "reset" ? 1 : request === "in" ? steps.find(step => step > zoom + 0.001) ?? 1.5 : [...steps].reverse().find(step => step < zoom - 0.001) ?? 0.8;
    panel!.webContents.setZoomFactor(zoom);
    panel!.webContents.send("settings:zoom-changed", { factor: zoom, canZoomIn: zoom < 1.5, canZoomOut: zoom > 0.8 });
  };
  hostControls.zoom = changeZoom;
  hostControls.setView = (next: SettingsView): void => { view = { ...next, revision: (view.revision ?? 0) + 1 }; panel!.webContents.send("settings:changed", view); };
  ipcMain.handle("settings:zoom", (_event, request: string) => changeZoom(request));
  ipcMain.handle("settings:read", () => view);
  ipcMain.handle("settings:ready", () => {});
  ipcMain.handle("settings:capture", () => view);
  ipcMain.handle("settings:choose", (_event, group: string, value: unknown) => {
    chooseCalls.push([group, value]);
    let renamed: string | undefined;
    const v = view as unknown as { library: { layout?: unknown; items: Array<{ id: string; title: string; name: string }> }; recordingResults: Array<{ acknowledged: boolean; actions: unknown[] }>; groups: SettingsView["groups"]; language: Language };
    // Controlled cancellation; native consent has its own production tests.
    if (group === "localData" && value === "clear") return { view, applied: true };
    if (group === "library") v.library.layout = value;
    else if (group.startsWith("recordingFile:")) {
      const id = group.slice("recordingFile:".length), item = v.library.items.find(entry => entry.id === id);
      if (item && value && typeof value === "object" && (value as { action?: string }).action === "rename") {
        renamed = `${id}-renamed`;
        item.id = renamed;
        item.title = (value as { name: string }).name;
        item.name = `${(value as { name: string }).name}.mp4`;
      }
    } else if (group.startsWith("recordingResult:")) {
      v.recordingResults[0]!.acknowledged = true;
      v.recordingResults[0]!.actions = [choice("remove", "Remove from history")];
    } else {
      const setting = v.groups.find(entry => entry.id === group)!;
      setting.choices = setting.control === "text" ? [choice(String(value), String(value), true)] : setting.choices.map(item => ({ ...item, checked: item.id === value }));
      if (group === "language") v.language = value as Language;
    }
    view = { ...view, revision: (view.revision ?? 0) + 1 };
    return { view, applied: true, ...(renamed ? { renamed } : {}) };
  });
  return { view: () => view };
}

/** What the Playwright fixture reaches with `application.evaluate`. */
const hostControls: Record<string, unknown> = {
  kind: "view",
  mode,
  boundary,
  state,
  retryDelays,
  chooseCalls,
  results: recordingResults,
  translate,
  settingsView,
  SNAPSHOT_SIZES,
  baseContext,
  fixtureView: (language: Language) => fixtureView(language, state.notifications),
  window: () => panel,
  library: () => library,
  /** Pushes a view to the page, as main's refresh does. */
  push: (view: SettingsView): void => { panel!.webContents.send("settings:changed", view); },
  /** Pushes `settingsView(recordingState, base context + overrides)`. */
  pushModel: (recordingState: RecordingState, overrides: Partial<AppContext> = {}): SettingsView => {
    const view = settingsView(recordingState, { ...baseContext(), ...overrides });
    panel!.webContents.send("settings:changed", view);
    return view;
  },
  pushResult: (language: Language, focus = 0): void => {
    state.resultContext = { ...baseContext(), language, notifications: false, recordingResults: recordingResults.all };
    state.lastFocus = focus;
    panel!.webContents.send("settings:changed", resultView());
  },
  /** The failures view after a day rollover of `days`, as main's clock moving on would push it. */
  rollover: (days: number): void => {
    state.resultContext = { ...baseContext(), language: "en", notifications: false, recordingResults: recordingResults.all, now: new Date(Date.now() + days * 86_400_000) };
    panel!.webContents.send("settings:changed", resultView());
  },
  pendingSaves: (): number => heldSaves.length,
  releaseSave: (): void => { const next = heldSaves.shift(); if (!next) throw new Error("No held save"); next(); },
  setSize: (width: number, height: number): void => { panel!.setSize(width, height); },
  setContentSize: (width: number, height: number): void => { panel!.setContentSize(width, height); },
  theme: (scheme: "light" | "dark" | "system"): void => { nativeTheme.themeSource = scheme; },
  /** The library the Recordings tab reads, with a reference `now` for the former fixture's snapshots. */
  snapshotNow: (): Date => new Date(2026, 9, 4, 18, 0, 0),
};
(globalThis as Record<string, unknown>).__recordstuff = hostControls;

void app.whenReady().then(async () => {
  if (mode === "components") {
    installComponentHandlers();
    panel = new BrowserWindow({ width: 800, height: 700, show: false,
      webPreferences: { preload: path.join(out, "preload/settings.js"), contextIsolation: true, sandbox: true } });
    panel.webContents.setZoomMode("isolated");
    hostControls.cleanup = async ({ profile, output, logs }: { profile: string; output: string; logs: string }) => {
      await fs.promises.mkdir(logs, { recursive: true });
      await fs.promises.writeFile(path.join(logs, "recordstuff.log"), "log");
      // Exercise real Electron shutdown and the production admission hook; the Chromium profile stays in use until app.quit completes.
      const quit = installQuitCoordinator(app, {
        shutdown: async () => { await panel!.webContents.session.cookies.set({ url: "https://fixture.local", name: "test", value: "private" }); return true; },
        pending() {}, error: error => { console.error(error); },
        beforeExit: () => prepareDataCleanup({ userData: profile, sessionData: app.getPath("sessionData"), logs, outputDir: output, media: [], parentPid: process.pid }),
      });
      quit.quit();
    };
    await panel.loadFile(path.join(out, "renderer/settings.html"));
    return;
  }
  installPanelHandlers();
  // Before any page loads, as in the app (index.ts): a frame takes the custom schemes registered when it navigates.
  library = await recordingsFolder(path.join(data, "recordings"));
  // The app's own window description (settings-window.ts): the same size rules; offscreen, so without the native frame.
  panel = new BrowserWindow(settingsWindowOptions({ platform: process.platform, preloadPath: path.join(out, "preload/settings.js"),
    title: "RecordStuff", size: { width: 460, height: 560 }, workArea: screen.getPrimaryDisplay().workArea }));
  // Main puts the language in the URL so a failed first read is localized.
  await panel.loadFile(path.join(out, "renderer/settings.html"), { query: { lang: "zh-TW" } });
});
