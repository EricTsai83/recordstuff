/**
 * App lifecycle (docs/system-design/recording.md): hide the Dock icon, create the tray, register
 * the display-media handler (the chosen display + system audio loopback), detect
 * permission, and make quitting wait for recording work, metadata writes and failure history.
 * Settings use a separate sandboxed window; capture keeps its hidden host.
 */
import { createPreferenceActions } from "./settings/preferences";
import { createHistoryQuit, createQuitFeedback } from "./app/quit-feedback";
import { QuitStatus } from "./app/quit-status";
import { installQuitCoordinator } from "./app/quit-coordinator";
import { prepareDataCleanup, releaseFailedCleanup, waitForDataCleanup } from "./app/data-cleanup";
import { DataCleanupRequest } from "./app/data-cleanup-request";
import { RecordingResultStore } from "./recording/recording-result-store";
import { RecordingResults } from "./recording/recording-result";
import { SettingsWindowState } from "./settings/settings-window-state";
import { DisplayMedia } from "./display/display-media";
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
import { CaptureHost } from "./recording/capture-host";
import { CountdownOverlay } from "./recording/countdown-overlay";
import { FileWriter, ensureWritableDir } from "./recording/file-writer";
import { KeepAwake } from "./recording/keep-awake";
import { createOutputFolderOpener, isSameFolder } from "./library/output-folder";
import { createUncaughtExceptionHandler } from "./app/fault-dialog";
import { createFileLogger, flushBeforeExit } from "./lib/log";
import { stackOf } from "./lib/errors";
import { createRunId, logSessionEvent } from "./recording/session-log";
import { PermissionWatcher, openNotificationSettings, openScreenCaptureSettings } from "./permission/permission";
import { Recorder } from "./recording/recorder";
import { SessionSentinels, reportInterruptions } from "./recording/session-sentinel";
import { SavedNotification } from "./recording/saved-notification";
import { CaptureNotices } from "./recording/capture-notices";
import { PermissionNotices } from "./permission/permission-notices";
import { watchReopen, type ReopenWatcher } from "./app/reopen";
import { holdSessionEnd } from "./app/session-end";
import { SettingsStore } from "./settings/settings";
import { parseAutoRecord, runAutoRecord } from "./recording/autorecord";
import { UpdateChecker, fetchVersion, DOWNLOAD_URL } from "./app/updates";
import { createActionHandler } from "./actions/actions";
import { AppTray } from "./menus/tray";
import { AppMenu } from "./menus/app-menu";
import { VideoFullScreen } from "./library/video-fullscreen";
import { SettingsWindow } from "./settings/settings-window";
import { MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES, RecordingsLibrary } from "./library/recordings-library";
import { videoThumbnail } from "./library/video-thumbnail";
import type { AppAction, AppContext } from "./app/ui-model";
import { APP_NAME } from "./lib/app-name";
import { preferencesUnlocked } from "./recording/recording-lock";
import { effectiveQuality, frameRateDowngrade, type QualitySettings } from "../shared/quality";
import { AppShortcuts } from "./shortcuts/shortcuts";
import { physicalHotkeyFeatures } from "./shortcuts/hotkey";
import type { RecordingState } from "../shared/state";
import type { CountdownSeconds } from "../shared/countdown";

import { DEFAULT_LANGUAGE, translate, type Language } from "../shared/i18n";
import { formatFileName } from "../shared/file-name";

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

// Register before any asynchronous cleanup wait can let Electron become ready.
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { ...MEDIA_SCHEME_PRIVILEGES } }]);

void start().catch((cause: unknown) => {
  // Cleanup still owns the profile: even an error log must not recreate it.
  console.error(`start: local data cleanup blocked startup: ${String(cause)}`);
  dialog.showErrorBox(APP_NAME, String(cause));
  app.exit(1);
});

async function start(): Promise<void> {
  try { await waitForDataCleanup(app.getPath("userData")); }
  catch (cause) {
    // A failed/interrupted helper has stopped deleting. Tell the user before
    // accepting new writes, then allow them to reopen Settings and retry.
    dialog.showErrorBox(translate("Could not clear local app data", DEFAULT_LANGUAGE),
      `${translate("Local data cleanup did not finish. Some app data may remain. Your recordings were kept. You can retry from Settings or remove the remaining app data manually.", DEFAULT_LANGUAGE)}\n\n${String(cause)}`);
    // Never resume while a live helper could still be deleting this profile.
    await releaseFailedCleanup(app.getPath("userData"));
  }

  // Acquire the userData lock only after the helper finishes: otherwise it
  // could delete a new instance's lock while that instance waits on cleanup.
  if (!app.requestSingleInstanceLock()) {
    const loser = createFileLogger({ filePath: logPath, maxBytes: Number.POSITIVE_INFINITY });
    loser(`start: another instance already holds the userData lock; run ${runId}; exiting`);
    await flushBeforeExit(loser);
    app.quit();
    return;
  }
  await main().catch(async (cause: unknown) => {
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

  await app.whenReady();
  if (process.platform === "darwin") app.dock?.hide();

  const settings = new SettingsStore({
    filePath: path.join(app.getPath("userData"), "settings.json"),
    defaultOutputDir: defaultOutputDir(),
    log,
  });
  await settings.resetOlderFormat().catch(cause => log(`settings: startup reset failed; original retained: ${String(cause)}`));
  nativeTheme.themeSource = settings.appearance;
  // Without a menu Electron installs its default one, whose Reload and Developer Tools shortcuts work in Settings
  // even in a release build. It is installed before any window, in the saved language; while the window is open
  // the menu bar shows it with a Record menu.
  const hideSettings = (): void => {
    void settingsWindow.hide().then(hidden => {
      // Opened again while it was leaving full screen: it stays a Dock app that follows its folder.
      if (!hidden) return;
      library.unwatch();
      void library.flushTrash();
      appMenu.windowClosed();
    });
  };
  const appMenu = new AppMenu({
    state: () => recorder.state, context: () => appContext(), language: () => settings.language,
    onAction: action => runAction(action, "app menu"), log,
    trayMenuOpen: () => tray.menuOpen,
    // Hiding leaves only the menu bar's icon, as closing does; Quit alone ends RecordStuff. The folder is not
    // followed out of sight either: showing the window again watches and lists it afresh (`activated`).
    hide: hideSettings,
    zoom: request => settingsWindow.zoom(request),
  });
  const library = new RecordingsLibrary({
    dir: () => settings.outputDir,
    // Only Settings shows the listing; the tray has nothing to redraw.
    changed: () => settingsWindow.refresh(),
    thumbnail: file => videoThumbnail(nativeImage, file),
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
      logicalWidth: d.size.width, logicalHeight: d.size.height, scaleFactor: d.scaleFactor, x: d.bounds.x, y: d.bounds.y,
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
    fileName: date => formatFileName(settings.fileNameTemplate, date),
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
  /** A quit in progress: what it holds back, and what the tray and the window say about it. */
  const quit = new QuitStatus({
    holdNotices: held => { savedNotification.setQuitting(held); captureNotices.setQuitting(held); },
    resumeAdmission: () => recorder.resumeAdmission(),
    // Work held back while the quit made the app unsettled applies now, not at the next recording.
    flushHeld: () => { updates.flush(); shortcuts.flush(); },
    refresh: () => refreshUi(),
  });
  const clearData = new DataCleanupRequest({
    settled: () => settled(), language: () => settings.language, quit: () => quitCoordinator.quit(),
    confirm: options => { focusApp(); return dialog.showMessageBox(options); },
  });
  const toggle = (): void => { if (!quit.requested) recorder.toggle(); };
  /** Settings that touch a session (quality, shortcut) change only here. */
  const settled = (): boolean => !quit.requested && preferencesUnlocked(recorder.state);
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
    new RecordingResultStore(path.join(app.getPath("userData"), "recording-history.json"), log), log, () => refreshUi());
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
    fileNameTemplate: settings.fileNameTemplate,
    libraryLayout: settings.libraryLayout,
    updates: { state: updates.state, enabled: settings.updates.enabled },
    notifications: settings.notifications,
    settingsShortcut: shortcuts.settingsStatus,
    hotkey: { ...settings.hotkey, registered: shortcuts.registered },
    ...quit.context(),
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
    quitRequested: () => quit.requested,
    opened: () => appMenu.windowOpened(),
    // Recordings waiting to go to the Trash go now: nothing is left to undo them from.
    closed: () => { library.unwatch(); void library.flushTrash(); appMenu.windowClosed(); },
    rename: (id, name) => library.rename(id, name),
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
      if (quit.requested) { log(`notification: show saved ${file} ignored while quitting`); return; }
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

  /** Hoisted, so the windows and the tray built above can hold it; every action is decided in actions/actions.ts. */
  function handleAction(action: AppAction): Promise<boolean | void> {
    return actionHandler(action);
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
  const actionHandler = createActionHandler({
    quitRequested: () => quit.requested, settled, platform: process.platform, log, refresh: refreshUi,
    settings, recorder, library, recordingResults, tray, settingsWindow, shortcuts, updates, captureNotices, clearData,
    savePreference, changeOutputDir, openOutputDir, revealLog,
    showLastRecording: () => showRecording(), hideSettings,
    displayPreferenceChanged: () => { displayMedia.failure = undefined; captureDegraded = false; },
    resolutionCapChanged: () => { captureDegraded = false; },
    applyAppearance: () => { nativeTheme.themeSource = settings.appearance; },
    quit: () => quitCoordinator.quit(),
    relaunch: () => quitCoordinator.relaunch(),
    openExternal: url => shell.openExternal(url),
    revealFile: file => shell.showItemInFolder(file),
    openScreenCaptureSettings, openNotificationSettings,
    showInfo: async detail => {
      focusApp();
      await dialog.showMessageBox({ type: "info", title: APP_NAME, message: APP_NAME, detail });
    },
  });
  // A session keeps the display awake, so idle sleep cannot end its capture (plan 050).
  const keepAwake = new KeepAwake(powerSaveBlocker, log);
  recorder.subscribe((event) => {
    logSessionEvent(log, runId, event);
    switch (event.type) {
      case "state": {
        // renderUi below draws the cleared line.
        quit.clearDeferred(false);
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
  /** The last quit was refused because the Clear local app data prompt is open: its answer decides the quit. */
  let cleanupPromptOpen = false;
  /** The metadata writes the last quit waited on; a line about them clears once they finish. */
  let metadataWritten: Promise<void> = Promise.resolve();
  const quitCoordinator = installQuitCoordinator(app, {
    relaunch: () => app.relaunch(),
    shutdown: async () => {
      cleanupPromptOpen = clearData.confirming;
      if (cleanupPromptOpen) return false;
      quit.begin();
      if (!await recorder.shutdown()) return false;
      // Media is settled here, so a timeout names the metadata write that is still pending.
      quit.metadata();
      const pending = new Set(["settings", "window size", "trash", "log"]);
      const flushes = ([["settings", settings.flush()], ["window size", settingsWindow.flush()], ["trash", library.flushTrash()], ["log", log.flush()]] as const)
        .map(([name, flush]) => flush.then(() => { pending.delete(name); }));
      metadataWritten = Promise.all(flushes.map(flush => flush.catch(() => undefined))).then(() => undefined);
      const flushed = await flushBeforeExit({ flush: () => Promise.all(flushes).then(() => undefined) }, QUIT_METADATA_WAIT_MS);
      if (!flushed) log(`quit: ${[...pending].join(", ")} still writing after ${QUIT_METADATA_WAIT_MS} ms`);
      return flushed;
    },
    pending: () => {
      if (cleanupPromptOpen) {
        // Nothing is pending: no banner or tray line about recording work, just the prompt to answer.
        log("quit deferred: the Clear local app data prompt is still open");
        focusApp();
        return;
      }
      clearData.cancel();
      recordingResults.resume();
      quit.end();
      log(`quit deferred: ${quit.step === "media" ? "recording work" : "a preference or log write"} is still pending`);
      showQuitFeedback(quit.step);
      // Refused, hidden by Focus or muted while the display is shared, the banner may never be seen (plan 056).
      quit.defer(quit.step === "media" ? recorder.whenMediaSettled() : metadataWritten);
    },
    // Media is safe here; unsaved reminders need a durable save or explicit consent.
    history: async () => {
      if (clearData.requested) {
        // The confirmed action discards history, so no second unsaved-history
        // consent is needed. In-flight writes must still settle before exit.
        const outcome = await recordingResults.flush(QUIT_METADATA_WAIT_MS);
        if (outcome === "writing") throw new Error("Failure history is still writing; cleanup was not started");
        return true;
      }
      return createHistoryQuit({ results: recordingResults, language: appLanguage, focus: focusApp, log,
      show: async options => {
        historyPrompt = true;
        try { return await dialog.showMessageBox(options); } finally { historyPrompt = false; }
      } })();
    },
    beforeExit: async () => {
      if (!clearData.requested) return;
      await prepareDataCleanup({
        userData: app.getPath("userData"), logs: app.getPath("logs"), sessionData: app.getPath("sessionData"),
        outputDir: settings.outputDir, parentPid: process.pid,
        media: recordingResults.all.flatMap(result => [result.partialPath, result.recordingPath].filter((file): file is string => Boolean(file))),
      });
      recordingResults.close();
    },
    resume: () => {
      const wasClearing = clearData.requested;
      clearData.cancel();
      quit.end();
      // Staying at the history prompt, or a history step that threw, leaves failure-history retries paused.
      recordingResults.resume();
      if (wasClearing) {
        dialog.showErrorBox(translate("Could not clear local app data", settings.language),
          translate("Local data cleanup did not finish. Some app data may remain. Your recordings were kept. You can retry from Settings or remove the remaining app data manually.", settings.language));
      }
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
    quit.dispose();
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
