/**
 * App lifecycle (docs/system-design/recording.md): hide the Dock icon, create the tray, register
 * the display-media handler (primary display + system audio loopback), detect
 * permission, and make quitting wait for a running recording to finish.
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
  net,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
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
import { createOutputFolderOpener } from "./output-folder";
import { createFileLogger, flushBeforeExit } from "./log";
import { createRunId, logSessionEvent } from "./session-log";
import { PermissionWatcher, openNotificationSettings, openScreenCaptureSettings } from "./permission";
import { Recorder } from "./recorder";
import { SessionSentinels, reportInterruptions } from "./session-sentinel";
import { SavedNotification } from "./saved-notification";
import { CaptureNotices } from "./capture-notices";
import { watchReopen, type ReopenWatcher } from "./reopen";
import { SettingsStore } from "./settings";
import { parseAutoRecord, runAutoRecord } from "./autorecord";
import { UpdateChecker, fetchVersion, DOWNLOAD_URL, RELEASES_URL, SOURCE_URL, WEBSITE_URL } from "./updates";
import { AppTray } from "./tray";
import { SettingsWindow } from "./settings-window";
import { APP_NAME, preferencesUnlocked, type AppAction, type AppContext } from "./ui-model";
import { effectiveQuality, frameRateDowngrade, type QualitySettings } from "../shared/quality";
import { AppShortcuts } from "./shortcuts";
import { physicalHotkeyFeatures } from "./hotkey";
import type { RecordingState } from "../shared/state";
import type { CountdownSeconds } from "../shared/countdown";

import { DEFAULT_LANGUAGE, translate, type Language } from "../shared/i18n";

let currentLanguage: Language = DEFAULT_LANGUAGE;
/** Reverse-DNS of the maintainer's domain (docs/system-design/signing.md#bundle-identifier). */
const APP_ID = "com.ericts.record";

/**
 * stdout plus a rotated file (docs/system-design/desktop.md). `app.getPath("logs")` is
 * `~/Library/Logs/<app name>` on macOS (where Console.app looks) and
 * `<userData>/logs` on Windows.
 */
const logPath = path.join(app.getPath("logs"), "recordstuff.log");
const log = createFileLogger({ filePath: logPath });
/** Printed in the `start:` line and carried in every session record (plan 029). */
const runId = createRunId(new Date(), process.pid);

// The main process has no window: an uncaught error would otherwise leave no
// trace at all. Electron's default for the exception case is a modal error
// dialog and the process keeps running; keep that, but write the log line first.
// The dialog is modal, so a fault that repeats (a timer, a listener) would
// otherwise stack one dialog per repetition; later ones only reach the log.
let errorDialogShown = false;
process.on("uncaughtException", (error) => {
  log(`uncaught exception: ${error.stack ?? String(error)}`);
  if (errorDialogShown) return;
  errorDialogShown = true;
  dialog.showErrorBox(APP_NAME, translate("An unexpected error occurred. See the log for details.", currentLanguage));
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
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
 * The first launch shows where the icon lives (docs/system-design/recording.md): a menu-bar
 * icon is easy to miss, and Windows may tuck it into the tray overflow. A marker file in
 * userData records that it was shown; settings.json stores user preferences independently.
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
  log(`start: another instance already holds the userData lock; run ${runId}; exiting`);
  void flushBeforeExit(log).then(() => app.quit());
} else {
  // A menu-bar app that fails to wire up has no window and no tray to quit
  // from: it would sit invisible until Activity Monitor found it.
  main().catch(async (cause: unknown) => {
    log(`start: failed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}; exiting`);
    await flushBeforeExit(log);
    dialog.showErrorBox(APP_NAME, translate("An unexpected error occurred. See the log for details.", currentLanguage));
    app.exit(1);
  });
}

async function main(): Promise<void> {
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
  // Closing Settings must leave the menu-bar recorder running.
  app.on("window-all-closed", () => undefined);

  await app.whenReady();
  if (process.platform === "darwin") app.dock?.hide();

  const settings = new SettingsStore({
    filePath: path.join(app.getPath("userData"), "settings.json"),
    defaultOutputDir: defaultOutputDir(),
    log,
  });
  nativeTheme.themeSource = settings.appearance;
  currentLanguage = settings.language;
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
    ensureWritableDir: dir => ensureWritableDir(dir, undefined,
      dir === settings.defaultOutputDir || dir === outputDirOverride),
    openWriter: (recordingPath, finalPath) => FileWriter.open(recordingPath, finalPath),
    freeSpace: async (dir) => { const volume = await fs.statfs(dir); return volume.bavail * volume.bsize; },
    sentinels,
    publishFailure: result => recordingResults.receive(result, {
      stat: file => fs.stat(file), refresh: refreshUi,
      notify: code => tray.notifyRecordingFailure(code),
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

  // One action for both entry points (plan 016): the tray's left click and the
  // global shortcut call the same `toggle`, whose state guards decide.
  const toggle = (): void => recorder.toggle();
  /** Settings that touch a session (quality, shortcut) change only here. */
  let quitRequested = false;
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
  let quitFeedback: ReturnType<typeof setTimeout> | undefined;
  const endQuitting = (): void => {
    quitRequested = false;
    clearTimeout(quitFeedback);
    quitFeedback = undefined;
    if (quitting) { quitting = false; refreshUi(); }
    // Work held back while the quit made the app unsettled applies now, not at the next recording.
    updates.flush();
    shortcuts.flush();
  };
  let captureDegraded = false;
  const captureWarning = () => translate("The resolution cap could not be confirmed. The recording may use a larger size.", settings.language);
  const appContext = (): AppContext => ({
    ...(captureDegraded ? { captureWarning: captureWarning() } : {}),
    recordingResults: recordingResults.all,
    historyLoading: recordingResults.loading,
    historyFailed: recordingResults.historyFailed,
    displays: displays(), display: settings.display, ...(displayMedia.failure ? { displayFailure: displayMedia.failure } : {}),
    platform: process.platform,
    outputDir: settings.outputDir,
    homeDir: os.homedir(),
    quality: quality(),
    countdown: countdownSeconds(),
    countdownSound: countdownSound(),
    language: settings.language,
    appearance: settings.appearance,
    updates: { state: updates.state, enabled: settings.updates.enabled },
    notifications: settings.notifications,
    settingsShortcut: shortcuts.settingsStatus,
    hotkey: { ...settings.hotkey, registered: shortcuts.registered },
    ...(quitting ? { quitting } : {}),
  });
  const settingsWindow = new SettingsWindow({
    geometry: new SettingsWindowState(path.join(app.getPath("userData"), "settings-window.json"), log),
    state: () => recorder.state,
    context: appContext,
    act: handleAction,
    capture: armed => shortcuts.capture(armed),
    log,
  });
  /** Set once every listener is wired, near the end of startup; a click before then has no reopen to explain. */
  let reopen: ReopenWatcher | undefined;
  const tray = new AppTray({
    resourcesDir: resourcesDir(),
    context: appContext,
    canNotify: () => settings.notifications,
    language: () => settings.language,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    onNotificationClick: () => reopen?.notificationClicked(),
    onToggle: toggle,
    revealSaved,
    permissionAction: () => {
      const state = recorder.state;
      runAction(state.type === "needsPermission" ? state.needsRelaunch ? "relaunch" : "openPermissionSettings" : "openSettings", "permission notification");
    },
    onAction: (action) => runAction(action, "tray"),
    log,
  });
  /** The tray and the settings panel project the same state; they move together. */
  function renderUi(state: RecordingState): void {
    tray.render(state);
    settingsWindow.refresh();
  }
  /** Context changed while the state did not (output folder, language, quality). */
  function refreshUi(): void {
    tray.refresh();
    settingsWindow.refresh();
  }
  renderUi(recorder.state);
  shortcuts.start();

  const openOutputDir = createOutputFolderOpener({
    outputDir: () => settings.outputDir,
    defaultOutputDir: settings.defaultOutputDir,
    language: () => settings.language,
    openPath: dir => shell.openPath(dir),
    focus: focusApp,
    show: options => dialog.showMessageBox(options),
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
      log(`${source}: action ${JSON.stringify(action)} failed: ${String(cause)}`));
  }

  async function handleAction(action: AppAction): Promise<boolean | void> {
    if (quitRequested && action !== "quit") return false;
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
            if (JSON.stringify(settings.display) !== before) displayMedia.failure = undefined;
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
      } else if ("setAppearance" in action) {
        await savePreference("appearance", {
          write: () => settings.setAppearance(action.setAppearance),
          applied: () => { nativeTheme.themeSource = settings.appearance; },
        });
      } else if ("setLanguage" in action) {
        await savePreference("language", {
          write: () => settings.setLanguage(action.setLanguage),
          applied: () => { currentLanguage = settings.language; },
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
        await savePreference("quality", {
          locked: true,
          write: () => settings.setQuality(action.setQuality),
          applied: () => log(`settings: quality ${JSON.stringify(settings.quality)}`),
          notifyFailure: () => tray.notifyQualityWriteFailed(),
        });
      }
      return;
    }
    switch (action) {
      case "openRecordingResult":
        settingsWindow.showRecordingResult();
        return;
      case "openSettings":
        settingsWindow.show();
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
        app.quit();
        return;
      // A pressed button that opens nothing must say so: this state blocks
      // recording entirely, and the tray menu is its only route.
      case "openPermissionSettings":
        try { await openScreenCaptureSettings(); }
        catch (cause) {
          log(`permission: open settings failed: ${String(cause)}`);
          focusApp();
          await dialog.showMessageBox({ type: "info", title: APP_NAME, message: APP_NAME,
            detail: translate("Could not open System Settings. Allow RecordStuff in System Settings → Privacy & Security → Screen & System Audio Recording.", settings.language) });
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
      case "revealLastSaved": {
        const state = recorder.state;
        if ((state.type === "idle" || state.type === "needsPermission") && state.lastSavedPath) {
          await revealSaved(state.lastSavedPath);
        }
        return;
      }
      case "revealLog":
        await revealLog();
        return;
      // Explicit outcomes: the Settings row reads them (plan 048 review); the tray ignores them.
      case "openOutputDir":
        // The opener reports each failure itself in a native warning, so the row adds no second one.
        await openOutputDir();
        return true;
      case "changeOutputDir":
        return changeOutputDir();
    }
  }

  /**
   * Show last recording: select the file, or, when the user moved or deleted it
   * since it was saved, open the output folder instead of doing nothing visible.
   */
  async function revealSaved(savedPath: string): Promise<void> {
    try {
      await fs.access(savedPath);
    } catch {
      log(`reveal last recording: ${savedPath} is gone; opening the output folder instead`);
      await openOutputDir();
      return;
    }
    shell.showItemInFolder(savedPath);
  }

  /**
   * Select the log file in Finder / Explorer. If file logging was disabled
   * (no file was ever written) fall back to opening the logs folder.
   */
  async function revealLog(): Promise<void> {
    try {
      await fs.access(logPath);
      log("reveal log: showing file in Finder");
      shell.showItemInFolder(logPath);
      return;
    } catch {
      // No log file yet: open (or fail to open) the folder instead.
    }
    log("reveal log: file missing, opening folder");
    const error = await shell.openPath(path.dirname(logPath));
    if (error) log(`openPath(${path.dirname(logPath)}) failed: ${error}`);
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
    folderChanged: () => recorder.outputDirChanged(),
    folderFailed: folder => tray.notifySettingsWriteFailed(folder),
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
  let previous = recorder.state;
  // A session keeps the display awake, so idle sleep cannot end its capture (plan 050).
  const keepAwake = new KeepAwake(powerSaveBlocker, log);
  recorder.subscribe((event) => {
    logSessionEvent(log, runId, event);
    switch (event.type) {
      case "state": {
        if (preferencesUnlocked(event.state)) {
          displayMedia.settle();
          host.destroy();
          // The recorder closes the overlay on every path; this is the safety net.
          overlay.destroy();
        }
        savedNotification.stateChanged(event.state);
        captureNotices.stateChanged(event.state);
        keepAwake.update(event.state);
        log(`state → ${event.state.type}${event.state.type === "countdown" ? ` (${event.state.remaining})` : ""}`);
        renderUi(event.state);
        updates.flush();
        // A shortcut change saved during a session applies now that it is over.
        shortcuts.flush();
        // Tell the user each time the permission ask changes: first "open
        // System Settings", later "relaunch" once the grant is in but stale.
        const next = event.state;
        if (
          next.type === "needsPermission" &&
          (previous.type !== "needsPermission" || previous.needsRelaunch !== next.needsRelaunch)
        ) {
          tray.notifyPermission(next.needsRelaunch);
        }
        previous = next;
        return;
      }
      case "saved":
        savedNotification.schedule(event.path, event.stoppedEarly);
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
        tray.notifyPermission(event.needsRelaunch);
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
  }, log).catch((cause: unknown) => log(`start: interruption check failed: ${String(cause)}`));

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
    language: () => currentLanguage,
    notify: body => tray.notifyQuitDeferred(body),
    log,
  });
  let historyPrompt = false;
  let quitDeferral: QuitDeferral = "media";
  const quitCoordinator = installQuitCoordinator(app, {
    relaunch: () => app.relaunch(),
    shutdown: async () => {
      quitRequested = true;
      quitDeferral = "media";
      savedNotification.setQuitting(true);
      captureNotices.setQuitting(true);
      // Pending cleanup can hold quit for the stop deadline, and a history save for its wait; the tray says so meanwhile.
      clearTimeout(quitFeedback);
      quitFeedback = setTimeout(() => { quitting = true; refreshUi(); }, 300);
      if (!await recorder.shutdown()) return false;
      // Media is settled here, so a timeout names the metadata write that is still pending.
      quitDeferral = "metadata";
      const pending = new Set(["settings", "window size", "log"]);
      const flushes = ([["settings", settings.flush()], ["window size", settingsWindow.flush()], ["log", log.flush()]] as const)
        .map(([name, flush]) => flush.then(() => { pending.delete(name); }));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const flushed = await Promise.race([
          Promise.all(flushes).then(() => true),
          new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 5000); }),
        ]);
        if (!flushed) log(`quit: ${[...pending].join(", ")} still writing after 5000 ms`);
        return flushed;
      } finally { clearTimeout(timeout); }
    },
    pending: () => {
      recorder.resumeAdmission();
      endQuitting();
      savedNotification.setQuitting(false);
      captureNotices.setQuitting(false);
      log(`quit deferred: ${quitDeferral === "media" ? "recording work" : "a preference or log write"} is still pending`);
      showQuitFeedback(quitDeferral);
    },
    // Media is safe here; unsaved reminders need a durable save or explicit consent.
    history: createHistoryQuit({ results: recordingResults, language: () => currentLanguage, focus: focusApp, log,
      show: async options => {
        historyPrompt = true;
        try { return await dialog.showMessageBox(options); } finally { historyPrompt = false; }
      } }),
    resume: () => {
      endQuitting();
      savedNotification.setQuitting(false);
      captureNotices.setQuitting(false);
      recorder.resumeAdmission();
      log("quit declined: failure history is not saved");
      refreshUi();
    },
    // A repeated request brings an open reminder prompt forward; otherwise it just joins.
    joined: () => { if (historyPrompt) focusApp(); },
    error: (cause) => log(`quit deferred: ${String(cause)}`),
  });

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
    overlay.destroy();
    settingsWindow.destroy();
    tray.destroy();
  });

  // Every platform: a menu-bar app is hard to find, and on macOS this is the
  // one moment the notification authorization prompt can appear in context.
  if (await isFirstRun(app.getPath("userData"))) {
    tray.notifyTrayHint();
  }
  updates.flush();
  log(`ready; output dir ${settings.outputDir}; hotkey ${JSON.stringify(shortcuts.status)}`);
}
