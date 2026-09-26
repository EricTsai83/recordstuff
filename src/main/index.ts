import { createHistoryQuit, createQuitFeedback } from "./quit-feedback";
import { installQuitCoordinator } from "./quit-coordinator";
import { RecordingResultStore } from "./recording-result-store";
import { RecordingResults } from "./recording-result";
import { SettingsWindowState } from "./settings-window-state";
import { DisplayMedia } from "./display-media";
import { isDisplayInfo, type DisplayInfo } from "../shared/display";
/**
 * App lifecycle (docs/system-design/recording.md): hide the Dock icon, create the tray, register
 * the display-media handler (primary display + system audio loopback), detect
 * permission, and make quitting wait for a running recording to finish.
 * Settings use a separate sandboxed window; capture keeps its hidden host.
 */
import {
  app,
  desktopCapturer,
  dialog,
  globalShortcut,
  net,
  nativeTheme,
  powerMonitor,
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
import { createOutputFolderOpener } from "./output-folder";
import { createFileLogger } from "./log";
import { createRunId, logSessionEvent } from "./session-log";
import { PermissionWatcher, openNotificationSettings, openScreenCaptureSettings } from "./permission";
import { Recorder } from "./recorder";
import { SessionSentinels, reportInterruptions } from "./session-sentinel";
import { SavedNotification } from "./saved-notification";
import { SettingsStore } from "./settings";
import { parseAutoRecord, runAutoRecord } from "./autorecord";
import { UpdateChecker, fetchVersion, DOWNLOAD_URL, RELEASES_URL } from "./updates";
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
process.on("uncaughtException", (error) => {
  log(`uncaught exception: ${error.stack ?? String(error)}`);
  dialog.showErrorBox(APP_NAME, translate("An unexpected error occurred. See the log for details.", currentLanguage));
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

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
 * Windows may tuck the icon into the tray overflow, so the first launch shows
 * a hint notification (docs/system-design/recording.md). A marker file in userData records that it
 * was shown; settings.json stores user preferences independently.
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

if (!app.requestSingleInstanceLock()) {
  log(`start: another instance already holds the userData lock; run ${runId}; exiting`);
  app.quit();
} else {
  void main();
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
  // a development-only unattended run driven by an environment
  // variable; its quality and folder overrides live in memory only. Packaged builds
  // never read it (`parseAutoRecord` returns undefined).
  const autoRecord = parseAutoRecord(process.env["RECORDSTUFF_AUTORECORD"], app.isPackaged);
  if (autoRecord && !autoRecord.ok) log(`autorecord: ignoring RECORDSTUFF_AUTORECORD: ${autoRecord.error}`);
  const qualityOverride = autoRecord?.ok ? autoRecord.config.quality : undefined;
  /** A stored 60 fps on a platform where it is not yet verified records at 30. */
  const quality = (): QualitySettings => effectiveQuality(qualityOverride ?? settings.quality, process.platform);
  /** Autorecord counts down only when its configuration names a countdown. */
  const countdownSeconds = (): CountdownSeconds => autoRecord?.ok ? autoRecord.config.countdown : settings.countdown;
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
    countdown: overlay,
    ensureWritableDir,
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
  const settled = (): boolean => preferencesUnlocked(recorder.state);
  const shortcuts = new AppShortcuts({
    globalShortcut, platform: process.platform, toggle, settled, store: settings, log,
    openSettings: () => { void handleAction("openSettings"); },
    notifyRegistrationFailed: accelerator => tray.notifyHotkeyRegistrationFailed(accelerator),
    notifyWriteFailed: () => tray.notifyHotkeyWriteFailed(),
    refresh: () => refreshUi(),
  });
  const updates = new UpdateChecker({
    localVersion: app.getVersion(), settled,
    preference: () => settings.updates,
    saveAttempt: (lastAttempt) => settings.setUpdates({ lastAttempt }),
    fetch: (signal) => fetchVersion(process.platform, process.arch, signal, (url, init) => net.fetch(url, init)),
    changed: () => { if (settled()) refreshUi(); }, log,
  });
  // Loads asynchronously; background save outcomes refresh both projections.
  const recordingResults = new RecordingResults(
    new RecordingResultStore(path.join(app.getPath("userData"), "recording-history.json"), log,
      path.join(app.getPath("userData"), "recording-result.json")), log, () => refreshUi());
  const appContext = (): AppContext => ({
    recordingResults: recordingResults.all,
    historyLoading: recordingResults.loading,
    displays: displays(), display: settings.display, ...(displayMedia.failure ? { displayFailure: displayMedia.failure } : {}),
    platform: process.platform,
    outputDir: settings.outputDir,
    homeDir: os.homedir(),
    quality: quality(),
    countdown: countdownSeconds(),
    language: settings.language,
    appearance: settings.appearance,
    updates: { state: updates.state, enabled: settings.updates.enabled },
    notifications: settings.notifications,
    settingsShortcut: shortcuts.settingsStatus,
    hotkey: { ...settings.hotkey, registered: shortcuts.registered },
  });
  const settingsWindow = new SettingsWindow({
    geometry: new SettingsWindowState(path.join(app.getPath("userData"), "settings-window.json"), log),
    state: () => recorder.state,
    context: appContext,
    act: handleAction,
    capture: armed => shortcuts.capture(armed),
    log,
  });
  const tray = new AppTray({
    resourcesDir: resourcesDir(),
    context: appContext,
    canNotify: () => settings.notifications,
    onToggle: toggle,
    // The tray has no reply channel, so a rejected action would otherwise only
    // reach process-level `unhandledRejection`. Keep it attributable instead.
    onAction: (action) => void handleAction(action).catch((cause: unknown) =>
      log(`action ${JSON.stringify(action)} failed: ${String(cause)}`)),
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
    focus: () => { if (process.platform === "darwin") app.focus({ steal: true }); },
    show: options => dialog.showMessageBox(options),
    // The warning may outlive the idle state; the chooser keeps its own lock too.
    chooseFolder: async () => { if (settled()) await changeOutputDir(); },
    log,
  });

  async function handleAction(action: AppAction): Promise<boolean | void> {
    if (typeof action !== "string" && "recordingResult" in action) {
      const request = action.recordingResult;
      return recordingResults.act(request.id, request.action, {
        stat: file => fs.stat(file), refresh: refreshUi, settled, platform: process.platform,
        reveal: file => shell.showItemInFolder(file), folder: changeOutputDir,
        permission: async () => { await handleAction("openPermissionSettings"); },
        relaunch: async () => { await handleAction("relaunch"); },
        needsRelaunch: () => recorder.state.type === "needsPermission" && recorder.state.needsRelaunch,
      });
    }
    if (typeof action !== "string") {
      if ("setDisplay" in action) {
        if (!settled()) return;
        const before = JSON.stringify(settings.display);
        try {
          await settings.setDisplay(action.setDisplay);
          if (JSON.stringify(settings.display) !== before) displayMedia.failure = undefined;
          log(`settings: display ${JSON.stringify(settings.display)}`);
        } catch (cause) {
          log(`settings: display save failed: ${String(cause)}`);
          tray.notifyDisplayWriteFailed();
        }
        refreshUi();
      } else if ("setUpdateChecks" in action) {
        if (!settled()) return;
        try { await settings.setUpdates({ enabled: action.setUpdateChecks }); }
        catch (error) { log(`updates: preference save failed: ${String(error)}`); }
        if (settled()) refreshUi();
      } else if ("setNotifications" in action) {
        if (!settled()) return;
        const turningOn = action.setNotifications && !settings.notifications;
        try { await settings.setNotifications(action.setNotifications); }
        catch (error) { log(`notifications: preference save failed: ${String(error)}`); }
        if (settled()) refreshUi();
        // Electron asks macOS for authorization inside `show()`, so turning the
        // switch on is the one moment the system prompt can appear at the
        // user's own request. The confirmation doubles as the delivery test.
        if (turningOn && settings.notifications) tray.notifyNotificationsEnabled();
      } else if ("setAppearance" in action) {
        try {
          await settings.setAppearance(action.setAppearance);
          nativeTheme.themeSource = settings.appearance;
        } catch (cause) { log(`settings: failed to save appearance: ${String(cause)}`); }
        refreshUi();
      } else if ("setLanguage" in action) {
        try {
          await settings.setLanguage(action.setLanguage);
          currentLanguage = settings.language;
          refreshUi();
        } catch (cause) {
          log(`settings: failed to save language: ${String(cause)}`);
          tray.notifyLanguageWriteFailed();
        }
      } else if ("setHotkey" in action) {
        await shortcuts.set(action.setHotkey);
      } else if ("setCountdown" in action) {
        if (!settled()) return;
        try {
          await settings.setCountdown(action.setCountdown);
          log(`settings: countdown ${settings.countdown} s`);
        } catch (cause) { log(`settings: countdown save failed: ${String(cause)}`); }
        refreshUi();
      } else {
        await setQuality(action.setQuality);
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
      case "checkUpdates":
        await updates.check(true);
        return;
      case "openWebsite":
      case "openSource":
        try {
          await shell.openExternal(action === "openWebsite" ? "https://record.ericts.com" : "https://github.com/EricTsai83/recordstuff");
          return true;
        } catch (error) { log(`settings: external link failed: ${String(error)}`); return false; }
      case "openUpdate":
        if (settled()) await shell.openExternal(updates.state.kind === "available" ? DOWNLOAD_URL : RELEASES_URL);
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
          shell.showItemInFolder(state.lastSavedPath);
        }
        return;
      }
      case "revealLog":
        await revealLog();
        return;
      case "openOutputDir":
        await openOutputDir();
        return;
      case "changeOutputDir":
        await changeOutputDir();
        return;
    }
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

  async function changeOutputDir(): Promise<void> {
    // Starting and counting-down sessions already opened their file in the current folder.
    if (!settled()) return;
    // A window-less app's dialog may open behind the frontmost app on macOS.
    if (process.platform === "darwin") app.focus({ steal: true });
    const result = await dialog.showOpenDialog({
      title: translate("Choose a recording folder", settings.language),
      defaultPath: settings.outputDir,
      properties: ["openDirectory", "createDirectory"],
    });
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) return;
    try {
      await settings.setOutputDir(chosen);
    } catch (cause) {
      log(`settings: failed to save outputDir: ${String(cause)}`);
      tray.notifySettingsWriteFailed(chosen);
      return;
    }
    recorder.outputDirChanged();
    refreshUi();
  }

  /**
   * the choice is applied only after settings.json is written;
   * a failed write keeps the previous value and says so. The settings panel
   * locks these controls outside idle / needsPermission and this guard repeats
   * the rule, so a running session's snapshot is never touched.
   */
  async function setQuality(patch: Partial<QualitySettings>): Promise<void> {
    if (!settled()) return;
    try {
      await settings.setQuality(patch);
    } catch (cause) {
      log(`settings: failed to save quality ${JSON.stringify(patch)}: ${String(cause)}`);
      tray.notifyQualityWriteFailed();
      return;
    }
    log(`settings: quality ${JSON.stringify(settings.quality)}`);
    refreshUi();
  }

  const savedNotification = new SavedNotification({
    platform: process.platform,
    show: (savedPath, stoppedEarly) => tray.notifySaved(savedPath, stoppedEarly),
    log,
  });
  let previous = recorder.state;
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
        displayMedia.failure = undefined;
        refreshUi();
        const actual = frameRateDowngrade(event.requested, event.capture);
        if (actual !== undefined) {
          log(`frame rate downgraded: requested ${event.requested.frameRate}, track reports ${actual}`);
          tray.notifyFrameRateDowngrade(event.requested.frameRate, actual);
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
  const onSuspend = (): void => log(`power: suspend; session ${recorder.sessionId ?? "none"}; state ${recorder.state.type}`);
  const onResume = (): void => log(`power: resume; session ${recorder.sessionId ?? "none"}; state ${recorder.state.type}`);
  powerMonitor.on("suspend", onSuspend);
  powerMonitor.on("resume", onResume);

  permission?.start();
  void reportInterruptions(sentinels, {
    restore: interrupted => recordingResults.restore(file => fs.stat(file), refreshUi, interrupted),
    saved: ids => recordingResults.saved(ids),
  }, log).catch((cause: unknown) => log(`start: interruption check failed: ${String(cause)}`));
  // Every platform: a menu-bar app is hard to find, and on macOS this is the
  // one moment the notification authorization prompt can appear in context.

  if (await isFirstRun(app.getPath("userData"))) {
    tray.notifyTrayHint();
  }
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
    focus: () => { if (process.platform === "darwin") app.focus({ steal: true }); },
    show: options => dialog.showMessageBox(options),
    log,
  });
  const quitFocus = (): void => { if (process.platform === "darwin") app.focus({ steal: true }); };
  let historyPrompt = false;
  const quitCoordinator = installQuitCoordinator(app, {
    relaunch: () => app.relaunch(),
    shutdown: () => {
      savedNotification.setQuitting(true);
      return recorder.shutdown();
    },
    pending: () => {
      savedNotification.setQuitting(false);
      log("quit deferred: recording save or cleanup is still pending");
      void showQuitFeedback();
    },
    // Media is safe here; unsaved reminders need a durable save or explicit consent.
    history: createHistoryQuit({ results: recordingResults, language: () => currentLanguage, focus: quitFocus, log,
      show: async options => {
        historyPrompt = true;
        try { return await dialog.showMessageBox(options); } finally { historyPrompt = false; }
      } }),
    resume: () => {
      savedNotification.setQuitting(false);
      recorder.resumeAdmission();
      log("quit declined: failure history is not saved");
      refreshUi();
    },
    // A repeated request brings an open reminder prompt forward; otherwise it just joins.
    joined: () => { if (historyPrompt) quitFocus(); },
    error: (cause) => log(`quit deferred: ${String(cause)}`),
  });

  app.on("will-quit", () => {
    updates.dispose();
    savedNotification.dispose();
    displayMedia.settle();
    screen.removeListener("display-added", displayChanged);
    screen.removeListener("display-removed", displayChanged);
    screen.removeListener("display-metrics-changed", displayChanged);
    powerMonitor.removeListener("suspend", onSuspend);
    powerMonitor.removeListener("resume", onResume);
    shortcuts.dispose();
    permission?.stop();
    host.destroy();
    overlay.destroy();
    settingsWindow.destroy();
    tray.destroy();
  });

  updates.flush();
  log(`ready; output dir ${settings.outputDir}; hotkey ${JSON.stringify(shortcuts.status)}`);
}
