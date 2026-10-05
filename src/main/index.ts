/**
 * App lifecycle (docs/system-design/recording.md): hide the Dock icon, create the tray, register
 * the display-media handler (the chosen display + system audio loopback), detect
 * permission, and make quitting wait for recording work, metadata writes and failure history.
 * Settings use a separate sandboxed window; capture keeps its hidden host.
 */
import { createPreferenceActions } from "./preferences";
import { createHistoryQuit, createQuitFeedback, type QuitDeferral } from "./quit-feedback";
import { installQuitCoordinator } from "./quit-coordinator";
import { RecordingResultStore } from "./recording-result-store";
import { RecordingResults } from "./recording-result";
import { SettingsWindowState } from "./settings-window-state";
import { DisplayMedia } from "./display-media";
import { isDisplayInfo, type DisplayInfo } from "../shared/display";
import {
  app,
  desktopCapturer,
  dialog,
  globalShortcut,
  nativeImage,
  net,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  shell,
  type DesktopCapturerSource,
} from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CaptureHost } from "./capture-host";
import { CountdownOverlay } from "./countdown-overlay";
import { FileWriter, ensureWritableDir } from "./file-writer";
import { KeepAwake } from "./keep-awake";
import { createOutputFolderOpener, isSameFolder } from "./output-folder";
import { createUncaughtExceptionHandler } from "./fault-dialog";
import { createFileLogger, flushBeforeExit } from "./log";
import { stackOf } from "./errors";
import { createRunId, logSessionEvent } from "./session-log";
import { PermissionWatcher, openNotificationSettings, openScreenCaptureSettings } from "./permission";
import { Recorder } from "./recorder";
import { SessionSentinels, reportInterruptions } from "./session-sentinel";
import { SavedNotification } from "./saved-notification";
import { CaptureNotices } from "./capture-notices";
import { PermissionNotices } from "./permission-notices";
import { watchReopen, type ReopenWatcher } from "./reopen";
import { holdSessionEnd } from "./session-end";
import { SettingsStore } from "./settings";
import { parseAutoRecord, runAutoRecord } from "./autorecord";
import { UpdateChecker, fetchVersion, DOWNLOAD_URL, RELEASES_URL, SOURCE_URL, WEBSITE_URL } from "./updates";
import { AppTray } from "./tray";
import { AppMenu } from "./app-menu";
import { VideoFullScreen } from "./video-fullscreen";
import { SettingsWindow } from "./settings-window";
import { MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES, RecordingsLibrary } from "./recordings-library";
import { APP_NAME, preferencesUnlocked, type AppAction, type AppContext } from "./ui-model";
import { effectiveQuality, frameRateDowngrade, type QualitySettings } from "../shared/quality";
import { AppShortcuts } from "./shortcuts";
import { physicalHotkeyFeatures } from "./hotkey";
import type { RecordingState } from "../shared/state";
import type { CountdownSeconds } from "../shared/countdown";

import { DEFAULT_LANGUAGE, translate, type Language } from "../shared/i18n";

/** The saved language, read where it is needed; the default until the settings are loaded. One source, nothing to copy. */
let appLanguage: () => Language = () => DEFAULT_LANGUAGE;
/** Reverse-DNS of the maintainer's domain (docs/system-design/signing.md#bundle-identifier). */
const APP_ID = "com.ericts.record";
/** How long quit waits for the settings, window-size and log writes once media has settled. */
const QUIT_METADATA_WAIT_MS = 5000;

/**
 * stdout plus a rotated file (docs/system-design/desktop.md). `app.getPath("logs")` is
 * `~/Library/Logs/<app name>` on macOS (where Console.app looks) and
 * `<userData>/logs` on Windows.
 */
const logPath = path.join(app.getPath("logs"), "recordstuff.log");
const log = createFileLogger({ filePath: logPath });
/** Printed in the `start:` line and carried in every session record (plan 029). */
const runId = createRunId(new Date(), process.pid);

/** Filled in once main has a recorder and a tray; before that no media exists and the box shows at once. */
const faultWiring: { recorder?: Recorder; refresh?: () => void } = {};
/** The uncaught-exception box is waiting for recording work to settle; the tray says so meanwhile (plan 056). */
let errorBoxHeld = false;
process.on("uncaughtException", createUncaughtExceptionHandler({
  log,
  showErrorBox: () => dialog.showErrorBox(APP_NAME, translate("An unexpected error occurred. See the log for details.", appLanguage())),
  mediaPending: () => faultWiring.recorder?.mediaPending ?? false,
  whenMediaSettled: () => faultWiring.recorder?.whenMediaSettled() ?? Promise.resolve(),
  held: (waiting) => { errorBoxHeld = waiting; faultWiring.refresh?.(); },
}));
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${stackOf(reason)}`);
});

/**
 * Bring the app forward before a dialog or window: a menu-bar app has no Dock
 * icon, so on macOS its dialogs would otherwise open behind the frontmost app.
 */
function focusApp(): void {
  if (process.platform === "darwin") app.focus({ steal: true });
}

/** `~/Movies/RecordStuff` on macOS, `~/Videos/RecordStuff` on Windows. */
function defaultOutputDir(): string {
  return path.join(app.getPath("videos"), APP_NAME);
}

/** macOS 13 (Darwin 22) is the floor for ScreenCaptureKit audio loopback. */
function osSupported(): boolean {
  if (process.platform !== "darwin") return true;
  const major = Number.parseInt(os.release().split(".")[0] ?? "0", 10);
  return major >= 22;
}

/**
 * The first launch shows where the icon lives (docs/system-design/desktop.md): a menu-bar
 * icon is easy to miss, and Windows may tuck it into the tray overflow. A marker file in
 * userData records that it was shown; settings.json stores user preferences independently.
 * Call it only when the hint can be shown: it spends the marker.
 */
async function isFirstRun(userDataDir: string): Promise<boolean> {
  try {
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(path.join(userDataDir, "tray-hint-shown"), "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "resources");
}

// Global shortcuts register by physical key; this must precede app ready and every registration.
const disabledFeatures = physicalHotkeyFeatures(app.commandLine.getSwitchValue("disable-features"), process.platform);
if (disabledFeatures) app.commandLine.appendSwitch("disable-features", disabledFeatures);

// File logging is asynchronous: both exits below first let the line they explain reach the log.
if (!app.requestSingleInstanceLock()) {
  // The running instance owns the file and its rotation (log.ts counts its own size): this one only appends its line.
  const loser = createFileLogger({ filePath: logPath, maxBytes: Number.POSITIVE_INFINITY });
  loser(`start: another instance already holds the userData lock; run ${runId}; exiting`);
  void flushBeforeExit(loser).then(() => app.quit());
} else {
  // A menu-bar app that fails to wire up has no window and no tray to quit
  // from: it would sit invisible until Activity Monitor found it.
  main().catch(async (cause: unknown) => {
    log(`start: failed: ${stackOf(cause)}; exiting`);
    await flushBeforeExit(log);
    dialog.showErrorBox(APP_NAME, translate("An unexpected error occurred. See the log for details.", appLanguage()));
    app.exit(1);
  });
}

async function main(): Promise<void> {
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
  // Closing Settings must leave the menu-bar recorder running.
  app.on("window-all-closed", () => undefined);
  // A menu-bar app from its first moment: the bundle declares no LSUIElement (app-menu.ts), so the Dock icon is
  // hidden as the app finishes launching, where macOS reads the policy, and again once ready.
  if (process.platform === "darwin") app.once("will-finish-launching", () => app.dock?.hide());

  // The Recordings tab's videos and thumbnails (recordings-library.ts): a standard, streaming scheme, so
  // <video> can fetch byte ranges. Only privileged before ready.
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { ...MEDIA_SCHEME_PRIVILEGES } }]);
  await app.whenReady();
  if (process.platform === "darwin") app.dock?.hide();

  const settings = new SettingsStore({
    filePath: path.join(app.getPath("userData"), "settings.json"),
    defaultOutputDir: defaultOutputDir(),
    log,
  });
  nativeTheme.themeSource = settings.appearance;
  // Without a menu Electron installs its default one, whose Reload and Developer Tools shortcuts work in Settings
  // even in a release build. It is installed before any window, in the saved language; while the window is open
  // the menu bar shows it with a Record menu.
  const appMenu = new AppMenu({
    state: () => recorder.state, context: () => appContext(), language: () => settings.language,
    onAction: action => runAction(action, "app menu"), log,
    trayMenuOpen: () => tray.menuOpen,
    // Hiding leaves only the menu bar's icon, as closing does; Quit alone ends RecordStuff. The folder is not
    // followed out of sight either: showing the window again watches and lists it afresh (`activated`).
    hide: () => { settingsWindow.hide(); library.unwatch(); appMenu.windowClosed(); },
    zoom: request => settingsWindow.zoom(request),
  });
  const library = new RecordingsLibrary({
    dir: () => settings.outputDir,
    // Only Settings shows the listing; the tray has nothing to redraw.
    changed: () => settingsWindow.refresh(),
    thumbnail: async file => {
      const image = await nativeImage.createThumbnailFromPath(file, { width: 480, height: 270 });
      // A video frame: as JPEG it is several times smaller than as PNG, in the cache and on the way to the page.
      return image.isEmpty() ? undefined : image.toJPEG(85);
    },
    trash: file => shell.trashItem(file),
    open: file => shell.openPath(file),
    reveal: file => shell.showItemInFolder(file),
    log,
  });
  protocol.handle(MEDIA_SCHEME, request => library.handle(request));
  appLanguage = () => settings.language;
  log(
    `start: ${APP_NAME} ${app.getVersion()}; run ${runId}; electron ${process.versions.electron}; ` +
      `${process.platform} ${os.release()}; outputDir ${settings.outputDir}; ` +
      `quality ${JSON.stringify(settings.quality)}; log ${logPath}; ` +
      `packaged ${app.isPackaged}; executable ${process.execPath}`,
  );
  // Autorecord: a development-only unattended run driven by an environment
  // variable; its quality and folder overrides live in memory only. Packaged builds
  // never read it (`parseAutoRecord` returns undefined).
  const autoRecord = parseAutoRecord(process.env["RECORDSTUFF_AUTORECORD"], app.isPackaged);
  if (autoRecord && !autoRecord.ok) log(`autorecord: ignoring RECORDSTUFF_AUTORECORD: ${autoRecord.error}`);
  const qualityOverride = autoRecord?.ok ? autoRecord.config.quality : undefined;
  /** A stored 60 fps on a platform where it is not yet verified records at 30. */
  const quality = (): QualitySettings => effectiveQuality(qualityOverride ?? settings.quality, process.platform);
  /** Autorecord counts down only when its configuration names a countdown. */
  const countdownSeconds = (): CountdownSeconds => autoRecord?.ok ? autoRecord.config.countdown : settings.countdown;
  /** Autorecord never ticks, so the matrix and audio-quality recordings cannot hear it (plan 046). */
  const countdownSound = (): boolean => autoRecord?.ok ? autoRecord.config.countdownSound : settings.countdownSound;
  /** An autorecord folder, like its quality, lives in memory only. */
  const outputDirOverride = autoRecord?.ok ? autoRecord.config.outputDir : undefined;

  const displays = (): DisplayInfo[] => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({ id: String(d.id), label: d.label,
      logicalWidth: d.size.width, logicalHeight: d.size.height, scaleFactor: d.scaleFactor,
      internal: d.internal, primary: d.id === primary })).filter(isDisplayInfo);
  };
  const displayMedia = new DisplayMedia<DesktopCapturerSource>({
    platform: process.platform,
    preference: () => settings.display,
    displays,
    primaryDisplayId: () => String(screen.getPrimaryDisplay().id),
    getSources: () => desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }),
    changed: () => refreshUi(),
    log,
  });
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    displayMedia.answer(
      // Only preparation asks for a display; a counting-down session already holds its stream.
      (sessionId) => recorder.state.type === "starting" && host.ownsDisplayRequest(request.frame, sessionId),
      (source) => {
        if (source) callback({ video: source, audio: "loopback" });
        else (callback as () => void)();
      },
    );
  }, { useSystemPicker: false });

  const host = new CaptureHost({
    preloadPath: path.join(__dirname, "../preload/index.js"),
    devUrl: app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"],
    htmlPath: path.join(__dirname, "../renderer/index.html"),
    log,
  });

  const overlay = new CountdownOverlay({
    preloadPath: path.join(__dirname, "../preload/countdown.js"),
    devUrl: !app.isPackaged && process.env["ELECTRON_RENDERER_URL"]
      ? new URL("countdown.html", process.env["ELECTRON_RENDERER_URL"]).href : undefined,
    htmlPath: path.join(__dirname, "../renderer/countdown.html"),
    display: () => {
      const id = displayMedia.activeDisplay;
      const display = id ? screen.getAllDisplays().find((d) => String(d.id) === id) : undefined;
      return display ? { id: String(display.id), bounds: display.bounds, workArea: display.workArea } : undefined;
    },
    primaryDisplay: () => {
      const display = screen.getPrimaryDisplay();
      return { id: String(display.id), bounds: display.bounds, workArea: display.workArea };
    },
    platform: process.platform,
    log,
  });

  // One file per in-flight session; any left at launch belongs to a process that ended while recording.
  const sentinels = new SessionSentinels(path.join(app.getPath("userData"), "recording-sessions"), log);
  const recorder = new Recorder({
    host,
    outputDir: () => outputDirOverride ?? settings.outputDir,
    quality,
    countdownSeconds,
    countdownSound,
    countdown: overlay,
    // Only RecordStuff's own folders are created; a chosen one that is missing may be an offline drive.
    ensureWritableDir: dir => ensureWritableDir(dir, undefined,
      isSameFolder(dir, settings.defaultOutputDir) || dir === outputDirOverride),
    openWriter: (recordingPath, finalPath) => FileWriter.open(recordingPath, finalPath),
    freeSpace: async (dir) => { const volume = await fs.statfs(dir); return volume.bavail * volume.bsize; },
    sentinels,
    publishFailure: result => recordingResults.receive(result, {
      stat: file => fs.stat(file), refresh: refreshUi,
      // Requested as the display stops being shared, which macOS may mute: held like the other capture notices.
      notify: code => permissionNotices.failed(code),
    }),
    preflight: () => (osSupported() ? undefined : "unsupported_os_version"),
    onSessionStart: (sessionId) => displayMedia.begin(sessionId),
    mapHostError: (code) => displayMedia.explain(code),
    log,
  });

  const permission =
    process.platform === "darwin"
      ? new PermissionWatcher((status) => recorder.setPermission(status), { log })
      : undefined;

  // One toggle for both entry points (plan 016): the global shortcut and the tray icon's left click, when it is
  // set to record, call the same `toggle`, whose state guards decide.
  /** A quit is running: every action but quit is ignored until it exits or is declined. */
  let quitRequested = false;
  const toggle = (): void => { if (!quitRequested) recorder.toggle(); };
  /** Settings that touch a session (quality, shortcut) change only here. */
  const settled = (): boolean => !quitRequested && preferencesUnlocked(recorder.state);
  const shortcuts = new AppShortcuts({
    globalShortcut, platform: process.platform, toggle, settled, store: settings, log,
    openSettings: () => runAction("openSettings", "settings shortcut"),
    notifyRegistrationFailed: accelerator => tray.notifyHotkeyRegistrationFailed(accelerator),
    notifyWriteFailed: () => tray.notifyHotkeyWriteFailed(),
    refresh: () => refreshUi(),
  });
  const updates = new UpdateChecker({
    localVersion: app.getVersion(), settled,
    preference: () => settings.updates,
    saveAttempt: (lastAttempt) => settings.setUpdates({ lastAttempt }),
    saveNotified: (notifiedVersion) => settings.setUpdates({ notifiedVersion }),
    // The download page the banner promises, not `openUpdate`, whose destination follows a later check's
    // state; but under the same lock, so a click after a recording starts opens nothing over the capture.
    // With notifications off nothing is shown, so the version is not counted as told (updates.ts `told`).
    announce: (version) => {
      if (!settings.notifications) return false;
      tray.notifyUpdateAvailable(version, () => {
        if (!settled()) { log("updates: notification click ignored while recording or quitting"); return; }
        shell.openExternal(DOWNLOAD_URL).catch((error: unknown) => log(`updates: download link failed: ${String(error)}`));
      });
      return true;
    },
    fetch: (signal) => fetchVersion(process.platform, process.arch, signal, (url, init) => net.fetch(url, init), log),
    // The checker holds results back during a session itself; every change it reports is current.
    changed: () => refreshUi(), log,
  });
  // Loads asynchronously; background save outcomes refresh both projections.
  const recordingResults = new RecordingResults(
    new RecordingResultStore(path.join(app.getPath("userData"), "recording-history.json"), log,
      path.join(app.getPath("userData"), "recording-result.json")), log, () => refreshUi());
  /** A quit waits for recording work or a history save; set shortly after it starts so a quick exit shows nothing. */
  let quitting = false;
  /** What that quit waits on, so the tray and the window name it (`AppContext.quitStep`). */
  let quitStep: QuitDeferral = "media";
  let quitFeedback: ReturnType<typeof setTimeout> | undefined;
  /** What held the last deferred quit, while the tray still says so (plan 056). */
  let quitDeferred: QuitDeferral | undefined;
  /** Each deferral clears only its own line: a later quit may have replaced it. */
  let deferralToken = 0;
  const clearQuitDeferred = (refresh = true): void => {
    deferralToken += 1;
    if (quitDeferred === undefined) return;
    quitDeferred = undefined;
    if (refresh) refreshUi();
  };
  /** Everything a quit holds back; `endQuitting` releases exactly these when the app stays open. */
  const beginQuitting = (): void => {
    quitRequested = true;
    savedNotification.setQuitting(true);
    captureNotices.setQuitting(true);
    // Pending cleanup can hold quit for the stop deadline, and a history save for its wait; the tray says so meanwhile.
    clearTimeout(quitFeedback);
    quitFeedback = setTimeout(() => { quitting = true; refreshUi(); }, 300);
  };
  const endQuitting = (): void => {
    quitRequested = false;
    recorder.resumeAdmission();
    savedNotification.setQuitting(false);
    captureNotices.setQuitting(false);
    clearTimeout(quitFeedback);
    quitFeedback = undefined;
    if (quitting) { quitting = false; refreshUi(); }
    // Work held back while the quit made the app unsettled applies now, not at the next recording.
    updates.flush();
    shortcuts.flush();
  };
  let captureDegraded = false;
  const captureWarning = () => translate("Could not confirm the resolution cap. The recording may be larger.", settings.language);
  const appContext = (): AppContext => ({
    ...(captureDegraded ? { captureWarning: captureWarning() } : {}),
    recordingResults: recordingResults.all,
    historyLoading: recordingResults.loading,
    historyFailed: recordingResults.historyFailed,
    displays: displays(), display: settings.display, ...(displayMedia.failure ? { displayFailure: displayMedia.failure } : {}),
    platform: process.platform,
    outputDir: settings.outputDir,
    homeDir: os.homedir(),
    version: app.getVersion(),
    library: library.state,
    quality: quality(),
    countdown: countdownSeconds(),
    countdownSound: countdownSound(),
    language: settings.language,
    appearance: settings.appearance,
    trayClick: settings.trayClick,
    libraryLayout: settings.libraryLayout,
    updates: { state: updates.state, enabled: settings.updates.enabled },
    notifications: settings.notifications,
    settingsShortcut: shortcuts.settingsStatus,
    hotkey: { ...settings.hotkey, registered: shortcuts.registered },
    ...(quitting ? { quitting, quitStep } : {}),
    ...(quitDeferred ? { quitDeferred } : {}),
    ...(errorBoxHeld ? { errorBoxHeld } : {}),
  });
  const settingsWindow = new SettingsWindow({
    geometry: new SettingsWindowState(path.join(app.getPath("userData"), "settings-window.json"), log),
    state: () => recorder.state,
    context: appContext,
    act: handleAction,
    capture: armed => shortcuts.capture(armed),
    // While the window is open the Recordings tab follows the folder: a video deleted in Finder leaves at once.
    activated: () => { library.watch(); void library.refresh(); },
    quitRequested: () => quitRequested,
    opened: () => appMenu.windowOpened(),
    closed: () => { library.unwatch(); appMenu.windowClosed(); },
    drag: async (contents, id) => {
      const file = library.find(id);
      if (!file) return false;
      // macOS refuses a drag without an image: the thumbnail, else the file's own icon.
      const jpeg = await library.thumbnail(file);
      const icon = jpeg ? nativeImage.createFromBuffer(jpeg).resize({ width: 160 }) : await app.getFileIcon(file.path, { size: "normal" });
      contents.startDrag({ file: file.path, icon });
      return true;
    },
    fullScreen: new VideoFullScreen({
      preloadPath: path.join(__dirname, "../preload/video.js"),
      htmlPath: path.join(__dirname, "../renderer/video.html"),
      devUrl: !app.isPackaged && process.env["ELECTRON_RENDERER_URL"] ? new URL("video.html", process.env["ELECTRON_RENDERER_URL"]).href : undefined,
      platform: process.platform,
      log,
    }),
    log,
  });
  /** Set once every listener is wired, near the end of startup; a click before then has no reopen to explain. */
  let reopen: ReopenWatcher | undefined;
  const tray = new AppTray({
    resourcesDir: resourcesDir(),
    context: appContext,
    canNotify: () => settings.notifications,
    language: () => settings.language,
    trayClick: () => settings.trayClick,
    menuClosed: () => appMenu.trayMenuClosed(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    onNotificationClick: () => reopen?.notificationClicked(),
    onToggle: toggle,
    // A click on an earlier banner obeys the quit gate, as every other way in does (`handleAction`).
    showSaved: file => {
      if (quitRequested) { log(`notification: show saved ${file} ignored while quitting`); return; }
      void showRecording(file).catch((cause: unknown) => log(`notification: show saved ${file} failed: ${stackOf(cause)}`));
    },
    permissionAction: () => {
      const state = recorder.state;
      runAction(state.type === "needsPermission" ? state.needsRelaunch ? "relaunch" : "openPermissionSettings" : "openSettings", "permission notification");
    },
    onAction: (action) => runAction(action, "tray"),
    log,
  });
  /** The tray, the settings panel and the menu bar's Record menu project the same state; they move together. */
  function renderUi(state: RecordingState): void {
    tray.render(state);
    settingsWindow.refresh();
    appMenu.refresh();
  }
  /** Context changed while the state did not (output folder, language, quality). */
  function refreshUi(): void {
    tray.refresh();
    settingsWindow.refresh();
    appMenu.refresh();
  }
  renderUi(recorder.state);
  faultWiring.recorder = recorder;
  faultWiring.refresh = refreshUi;
  shortcuts.start();

  const openOutputDir = createOutputFolderOpener({
    outputDir: () => settings.outputDir,
    defaultOutputDir: settings.defaultOutputDir,
    language: () => settings.language,
    openPath: dir => shell.openPath(dir),
    focus: focusApp,
    show: options => dialog.showMessageBox(options),
    // A modal warning now would hold that work's writes and deadlines (plan 056); after capture a banner is not muted.
    mediaPending: () => recorder.mediaPending,
    notify: body => captureNotices.hold("output folder warning", () => tray.notifyOutputFolderProblem(body)),
    // The warning may outlive the idle state; the chooser keeps its own lock too.
    chooseFolder: async () => { if (settled()) await changeOutputDir(); },
    log,
  });

  /**
   * For entry points with no reply channel (the tray, notifications, the Settings shortcut):
   * a rejected action would otherwise only reach process-level `unhandledRejection`. Keep it attributable.
   */
  function runAction(action: AppAction, source: string): void {
    void handleAction(action).catch((cause: unknown) =>
      log(`${source}: action ${JSON.stringify(action)} failed: ${stackOf(cause)}`));
  }

  async function handleAction(action: AppAction): Promise<boolean | void> {
    if (quitRequested && action !== "quit") return false;
    if (typeof action !== "string" && "recordingFile" in action) {
      const { id, action: verb } = action.recordingFile;
      // A drag belongs to the window it starts in (settings-window.ts).
      return verb === "drag" ? false : library.act(id, verb);
    }
    if (typeof action !== "string" && "recordingResult" in action) {
      const request = action.recordingResult;
      return recordingResults.act(request.id, request.action, {
        stat: file => fs.stat(file), refresh: refreshUi, settled, platform: process.platform,
        reveal: file => shell.showItemInFolder(file), folder: async () => { await changeOutputDir(); },
        permission: async () => { await handleAction("openPermissionSettings"); },
        relaunch: async () => { await handleAction("relaunch"); },
        needsRelaunch: () => recorder.state.type === "needsPermission" && recorder.state.needsRelaunch,
      });
    }
    if (typeof action !== "string") {
      if ("setDisplay" in action) {
        const before = JSON.stringify(settings.display);
        await savePreference("display", {
          locked: true,
          write: () => settings.setDisplay(action.setDisplay),
          applied: () => {
            // What the last recording on another screen ran into is no longer what the next one will.
            if (JSON.stringify(settings.display) !== before) { displayMedia.failure = undefined; captureDegraded = false; }
            log(`settings: display ${JSON.stringify(settings.display)}`);
          },
          notifyFailure: () => tray.notifyDisplayWriteFailed(),
        });
      } else if ("setUpdateChecks" in action) {
        await savePreference("update checks", { locked: true, write: () => settings.setUpdates({ enabled: action.setUpdateChecks }) });
      } else if ("setNotifications" in action) {
        const turningOn = action.setNotifications && !settings.notifications;
        await savePreference("notifications", { locked: true, write: () => settings.setNotifications(action.setNotifications) });
        // Electron asks macOS for authorization inside `show()`, so turning the
        // switch on is the one moment the system prompt can appear at the
        // user's own request. The confirmation doubles as the delivery test.
        if (turningOn && settings.notifications) tray.notifyNotificationsEnabled();
      } else if ("setTrayClick" in action) {
        // A click mid-recording follows the new choice at once; nothing a session holds depends on it.
        await savePreference("tray click", {
          write: () => settings.setTrayClick(action.setTrayClick),
          applied: () => log(`settings: tray click ${settings.trayClick}`),
        });
      } else if ("setLibraryLayout" in action) {
        await savePreference("library layout", { write: () => settings.setLibraryLayout(action.setLibraryLayout) });
      } else if ("setAppearance" in action) {
        await savePreference("appearance", {
          write: () => settings.setAppearance(action.setAppearance),
          applied: () => { nativeTheme.themeSource = settings.appearance; },
        });
      } else if ("setLanguage" in action) {
        await savePreference("language", {
          write: () => settings.setLanguage(action.setLanguage),
          notifyFailure: () => tray.notifyLanguageWriteFailed(),
        });
      } else if ("setHotkey" in action) {
        await shortcuts.set(action.setHotkey);
      } else if ("setCountdown" in action) {
        await savePreference("countdown", {
          locked: true,
          write: () => settings.setCountdown(action.setCountdown),
          applied: () => log(`settings: countdown ${settings.countdown} s`),
        });
      } else if ("setCountdownSound" in action) {
        await savePreference("countdown sound", {
          locked: true,
          write: () => settings.setCountdownSound(action.setCountdownSound),
          applied: () => log(`settings: countdown sound ${settings.countdownSound ? "on" : "off"}`),
        });
      } else {
        const cap = settings.quality.resolutionCap;
        await savePreference("quality", {
          locked: true,
          write: () => settings.setQuality(action.setQuality),
          applied: () => {
            // The unconfirmed cap was the last recording's; another cap is the next recording's to confirm.
            if (settings.quality.resolutionCap !== cap) captureDegraded = false;
            log(`settings: quality ${JSON.stringify(settings.quality)}`);
          },
          notifyFailure: () => tray.notifyQualityWriteFailed(),
        });
      }
      return;
    }
    switch (action) {
      case "openRecordingResult":
        settingsWindow.showRecordingResult();
        return;
      case "openShortcutSettings":
        settingsWindow.showShortcut();
        return;
      case "openRecordingSettings":
        settingsWindow.showRecording();
        return;
      case "openSettings":
        settingsWindow.show();
        return;
      case "showLastRecording":
        await showRecording();
        return;
      case "retryShortcuts":
        return shortcuts.retry();
      case "checkUpdates":
        // Not awaited: the check can wait on two network timeouts, and the
        // panel's save queue and its controls must not wait with it. The
        // checker's state changes push the button's own progress.
        void updates.check(true);
        return true;
      case "openWebsite":
      case "openSource":
        try {
          await shell.openExternal(action === "openWebsite" ? WEBSITE_URL : SOURCE_URL);
          return true;
        } catch (error) { log(`settings: external link failed: ${String(error)}`); return false; }
      case "openUpdate":
        // Recording locks the button; a click that raced the lock opened nothing, which is not a failure.
        if (!settled()) return true;
        try {
          await shell.openExternal(updates.state.kind === "available" ? DOWNLOAD_URL : RELEASES_URL);
          return true;
        } catch (error) { log(`settings: update link failed: ${String(error)}`); return false; }
      case "start":
        // An open macOS menu cannot change, so a Start chosen late is resolved now: only idle starts (plan 048).
        if (!recorder.startIfIdle()) log(`tray: Start recording ignored in state ${recorder.state.type}`);
        return;
      case "stop":
        recorder.stop();
        return;
      case "cancelCountdown":
        recorder.cancelCountdown("menu");
        return;
      case "quit":
        // A request, as Relaunch is: a quit deferred for a save or refused says so itself. Settings' Quit has no
        // checked value to compare, so without this answer it read as a failed link (settings-window.ts `apply`).
        quitCoordinator.quit();
        return true;
      // A pressed button that opens nothing must say so: this state blocks
      // recording entirely, and the tray menu is its only route.
      case "openPermissionSettings":
        try { await openScreenCaptureSettings(); }
        catch (cause) {
          log(`permission: open settings failed: ${String(cause)}`);
          const detail = translate("Could not open System Settings. Allow RecordStuff in System Settings → Privacy & Security → Screen & System Audio Recording.", settings.language);
          // A windowless warning would hold the failed session's cleanup until answered (plan 056).
          if (recorder.mediaPending) {
            log("permission: recording work is pending; telling the problem in a notification instead of a warning");
            captureNotices.hold("permission settings warning", () => tray.notifyAnswer(detail));
            return;
          }
          focusApp();
          await dialog.showMessageBox({ type: "info", title: APP_NAME, message: APP_NAME, detail });
        }
        return;
      // An actions choice has no committed value to compare, so it reports its
      // own outcome: a refused pane leaves the note's manual path as recovery.
      case "openNotificationSettings":
        try { await openNotificationSettings(); return true; }
        catch (error) { log(`notifications: open settings failed: ${String(error)}`); return false; }
      case "relaunch":
        quitCoordinator.relaunch();
        return;
      // Settings → General → Log file reads the outcome (2026-10-04); the log moved there from the tray.
      case "revealLog":
        return revealLog();
      // Explicit outcomes: the Settings row reads them (plan 048 review); the tray ignores them.
      case "openOutputDir":
        // A failure the opener warned about itself answers true, so the row adds no second message; one only held
        // for a notice until the recording ends answers false, and the row says it failed now.
        return openOutputDir();
      case "changeOutputDir":
        return changeOutputDir();
    }
  }

  /**
   * The Recordings tab, listed afresh so a new file is there, with one recording in view and focused:
   * the saved notification's own file (2026-10-04), or without one the newest the folder holds, for the
   * tray's Show last recording. A file the user moved or deleted since is simply not listed, and an empty
   * or unreadable folder opens the tab on what it shows; never the folder itself.
   */
  async function showRecording(savedPath?: string): Promise<void> {
    await library.refresh();
    const files = library.state.files;
    const target = savedPath === undefined ? files[0] : files.find(file => file.path === savedPath);
    if (target) log(`show last recording: Recordings with ${target.path}`);
    else if (savedPath !== undefined) log(`show last recording: ${savedPath} is not in the folder any more; opening Recordings`);
    else log(`show last recording: ${library.state.failed ? "the output folder could not be listed" : "no recording in the output folder"}; opening Recordings`);
    settingsWindow.showLibrary(target?.id);
  }

  /**
   * Select the log file in Finder / Explorer. If file logging was disabled
   * (no file was ever written) fall back to opening the logs folder.
   * Resolves whether the file or, without one yet, its folder was shown.
   */
  async function revealLog(): Promise<boolean> {
    try {
      await fs.access(logPath);
      log("reveal log: showing file in Finder");
      shell.showItemInFolder(logPath);
      return true;
    } catch {
      // No log file yet: open (or fail to open) the folder instead.
    }
    log("reveal log: file missing, opening folder");
    const error = await shell.openPath(path.dirname(logPath));
    if (error) log(`openPath(${path.dirname(logPath)}) failed: ${error}`);
    return !error;
  }

  const preferenceActions = createPreferenceActions({
    settled,
    chooseFolder: async () => {
      focusApp();
      const result = await dialog.showOpenDialog({
        title: translate("Choose a recording folder", settings.language),
        defaultPath: settings.outputDir, properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    saveFolder: folder => settings.setOutputDir(folder),
    focus: focusApp,
    folderChanged: () => { recorder.outputDirChanged(); void library.refreshIfWatched(); },
    folderFailed: folder => tray.notifySettingsWriteFailed(folder),
    // Told once the recording ends: a banner now could be muted while the display is shared.
    folderRefused: folder => captureNotices.hold("output folder not changed", () => tray.notifyFolderRefused(folder)),
    refresh: refreshUi, log,
  });
  function changeOutputDir(): Promise<boolean> { return preferenceActions.changeOutputDir(); }
  const savePreference = preferenceActions.save;

  const savedNotification = new SavedNotification({
    platform: process.platform,
    show: (savedPath, stoppedEarly) => tray.notifySaved(savedPath, stoppedEarly),
    log,
  });
  const captureNotices = new CaptureNotices({ platform: process.platform, log });
  const permissionNotices = new PermissionNotices({
    permission: needsRelaunch => tray.notifyPermission(needsRelaunch),
    failure: code => captureNotices.hold(`recording failure ${code}`, () => tray.notifyRecordingFailure(code)),
  });
  // A session keeps the display awake, so idle sleep cannot end its capture (plan 050).
  const keepAwake = new KeepAwake(powerSaveBlocker, log);
  recorder.subscribe((event) => {
    logSessionEvent(log, runId, event);
    switch (event.type) {
      case "state": {
        // renderUi below draws the cleared line.
        clearQuitDeferred(false);
        if (preferencesUnlocked(event.state)) {
          displayMedia.settle();
          host.destroy();
          // The recorder closes the overlay on every path; this is the safety net.
          overlay.close();
        }
        savedNotification.stateChanged(event.state);
        captureNotices.stateChanged(event.state);
        keepAwake.update(event.state);
        log(`state → ${event.state.type}${event.state.type === "countdown" ? ` (${event.state.remaining})` : ""}`);
        renderUi(event.state);
        updates.flush();
        // A shortcut change saved during a session applies now that it is over.
        shortcuts.flush();
        permissionNotices.stateChanged(event.state);
        return;
      }
      case "saved":
        savedNotification.schedule(event.path, event.stoppedEarly);
        void library.refreshIfWatched();
        return;
      case "displayFailed":
        displayMedia.failure = event.detail;
        refreshUi();
        return;
      case "captureStarted": {
        // Settings shows the cap warning at once; the notifications wait for the display to stop being shared.
        captureDegraded = event.capture.capUnconfirmed === true;
        if (captureDegraded) captureNotices.hold("resolution cap unconfirmed", () => tray.notifyCaptureWarning(captureWarning()));
        displayMedia.failure = undefined;
        refreshUi();
        const actual = frameRateDowngrade(event.requested, event.capture);
        if (actual !== undefined) {
          log(`frame rate downgraded: requested ${event.requested.frameRate}, track reports ${actual}`);
          const requested = event.requested.frameRate;
          captureNotices.hold("frame rate downgrade", () => tray.notifyFrameRateDowngrade(requested, actual));
        }
        return;
      }
      case "failureStatus":
        // The Recorder's awaited publication callback owns verification/persistence.
        return;
      case "cancelled":
        // Logged by logSessionEvent; a cancel shows no failure, notification or diagnostic.
        return;
      case "failed":
        // The OS says granted, yet capture is refused: TCC needs a relaunch.
        if (event.code === "permission_denied" && permission) permission.markRelaunchRequired();
        return;
      case "permissionRequested":
        // The answer to the user's own click or shortcut, which otherwise does nothing visible.
        tray.notifyPermission(event.needsRelaunch, true);
        return;
    }
  });

  const displayChanged = (): void => {
    if (displayMedia.topologyChanged(screen.getAllDisplays().map((d) => String(d.id)))) recorder.displayRemoved();
    if (settled()) refreshUi();
  };
  screen.on("display-added", displayChanged);
  screen.on("display-removed", displayChanged);
  screen.on("display-metrics-changed", displayChanged);
  // Evidence only: a failure after sleep then reads as sleep, not unexplained track loss.
  // A sleep cannot be refused, and capture ends about 150 ms after it begins: stop first, log after (plan 050).
  // Holding notifications is only a flag, and it must be set before a cancel can notify.
  const onSuspend = (): void => {
    const session = recorder.sessionId ?? "none";
    const state = recorder.state.type;
    tray.systemWillSleep();
    recorder.systemWillSleep();
    log(`power: suspend; session ${session}; state ${state}`);
  };
  const onResume = (): void => {
    log(`power: resume; session ${recorder.sessionId ?? "none"}; state ${recorder.state.type}`);
    tray.systemDidWake();
  };
  const onUnlock = (): void => tray.userDidUnlock();
  powerMonitor.on("suspend", onSuspend);
  powerMonitor.on("resume", onResume);
  powerMonitor.on("unlock-screen", onUnlock);

  permission?.start();
  void reportInterruptions(sentinels, {
    restore: interrupted => recordingResults.restore(file => fs.stat(file), refreshUi, interrupted),
    saved: ids => recordingResults.saved(ids),
    hold: ids => recordingResults.hold(ids),
  }, log).catch((cause: unknown) => log(`start: interruption check failed: ${stackOf(cause)}`));

  if (autoRecord?.ok) {
    runAutoRecord(autoRecord.config, {
      state: () => recorder.state,
      toggle: () => recorder.toggle(),
      stop: () => recorder.stop(),
      subscribe: (listener) => recorder.subscribe(listener),
      quit: () => app.quit(),
      log,
    });
  }

  const showQuitFeedback = createQuitFeedback({
    language: appLanguage,
    notify: body => tray.notifyAnswer(body),
    log,
  });
  let historyPrompt = false;
  let quitDeferral: QuitDeferral = "media";
  /** The metadata writes the last quit waited on; a line about them clears once they finish. */
  let metadataWritten: Promise<void> = Promise.resolve();
  const quitCoordinator = installQuitCoordinator(app, {
    relaunch: () => app.relaunch(),
    shutdown: async () => {
      quitDeferral = quitStep = "media";
      clearQuitDeferred();
      beginQuitting();
      if (!await recorder.shutdown()) return false;
      // Media is settled here, so a timeout names the metadata write that is still pending.
      quitDeferral = quitStep = "metadata";
      if (quitting) refreshUi();
      const pending = new Set(["settings", "window size", "log"]);
      const flushes = ([["settings", settings.flush()], ["window size", settingsWindow.flush()], ["log", log.flush()]] as const)
        .map(([name, flush]) => flush.then(() => { pending.delete(name); }));
      metadataWritten = Promise.all(flushes.map(flush => flush.catch(() => undefined))).then(() => undefined);
      const flushed = await flushBeforeExit({ flush: () => Promise.all(flushes).then(() => undefined) }, QUIT_METADATA_WAIT_MS);
      if (!flushed) log(`quit: ${[...pending].join(", ")} still writing after ${QUIT_METADATA_WAIT_MS} ms`);
      return flushed;
    },
    pending: () => {
      endQuitting();
      log(`quit deferred: ${quitDeferral === "media" ? "recording work" : "a preference or log write"} is still pending`);
      showQuitFeedback(quitDeferral);
      // Refused, hidden by Focus or muted while the display is shared, the banner may never be seen (plan 056).
      quitDeferred = quitDeferral;
      const token = deferralToken;
      refreshUi();
      void (quitDeferral === "media" ? recorder.whenMediaSettled() : metadataWritten)
        .then(() => { if (token === deferralToken) clearQuitDeferred(); }, () => undefined);
    },
    // Media is safe here; unsaved reminders need a durable save or explicit consent.
    history: createHistoryQuit({ results: recordingResults, language: appLanguage, focus: focusApp, log,
      show: async options => {
        historyPrompt = true;
        try { return await dialog.showMessageBox(options); } finally { historyPrompt = false; }
      } }),
    resume: () => {
      endQuitting();
      // Staying at the history prompt, or a history step that threw, leaves failure-history retries paused.
      recordingResults.resume();
      log("quit declined: failure history is not saved");
      refreshUi();
    },
    // A repeated request brings an open reminder prompt forward; otherwise it just joins.
    joined: () => { if (historyPrompt) focusApp(); },
    // The history step logs its outcome (for example exiting without saving) through the asynchronous queue.
    exit: async () => { await flushBeforeExit(log); },
    error: (cause) => log(`quit deferred: ${stackOf(cause)}`),
  });

  // Windows ends a session without before-quit: a recording in progress is saved by the normal quit first.
  holdSessionEnd({ app, platform: process.platform, mediaPending: () => recorder.mediaPending, quit: () => quitCoordinator.quit(), log });

  // Opening the app again is the way in when its menu bar icon is hidden (plan 053).
  reopen = watchReopen({ events: app, platform: process.platform, open: () => handleAction("openSettings"), log, now: () => performance.now() });

  app.on("will-quit", () => {
    // A modal quit prompt can hold the feedback timer past its 300 ms; it must not render a destroyed tray.
    clearTimeout(quitFeedback);
    reopen?.stop();
    updates.dispose();
    savedNotification.dispose();
    captureNotices.dispose();
    displayMedia.settle();
    screen.removeListener("display-added", displayChanged);
    screen.removeListener("display-removed", displayChanged);
    screen.removeListener("display-metrics-changed", displayChanged);
    powerMonitor.removeListener("suspend", onSuspend);
    powerMonitor.removeListener("resume", onResume);
    powerMonitor.removeListener("unlock-screen", onUnlock);
    keepAwake.dispose();
    shortcuts.dispose();
    permission?.stop();
    host.destroy();
    overlay.close();
    settingsWindow.destroy();
    library.unwatch();
    tray.destroy();
  });

  // Every platform: a menu-bar app is hard to find, and on macOS this is the
  // one moment the notification authorization prompt can appear in context.
  // Without screen permission a click cannot record, and the permission
  // notice already asked: the hint waits for a launch where it is true.
  if (recorder.state.type !== "needsPermission" && await isFirstRun(app.getPath("userData"))) {
    tray.notifyTrayHint();
  }
  updates.flush();
  log(`ready; output dir ${settings.outputDir}; hotkey ${JSON.stringify(shortcuts.status)}`);
}
