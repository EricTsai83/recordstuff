/**
 * App lifecycle (docs/system-design/recording.md): hide the Dock icon, create the tray, register
 * the display-media handler (primary display + system audio loopback), detect
 * permission, and make quitting wait for a running recording to finish.
 * No window is ever created here; the only renderer is the hidden capture host.
 */
import {
  app,
  desktopCapturer,
  dialog,
  globalShortcut,
  net,
  screen,
  session,
  shell,
  type DisplayMediaRequestHandlerHandlerRequest,
  type Streams,
} from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CaptureHost } from "./capture-host";
import { FileWriter, ensureWritableDir } from "./file-writer";
import { RecordingHotkey } from "./hotkey";
import { createFileLogger } from "./log";
import { PermissionWatcher, openScreenCaptureSettings } from "./permission";
import { Recorder } from "./recorder";
import { SavedNotification } from "./saved-notification";
import { SettingsStore } from "./settings";
import { parseAutoRecord, runAutoRecord } from "./autorecord";
import { UpdateChecker, fetchVersion, DOWNLOAD_URL, RELEASES_URL } from "./updates";
import { AppTray } from "./tray";
import { APP_NAME, type TrayAction } from "./tray-model";
import { effectiveQuality, frameRateDowngrade, type QualitySettings } from "../shared/quality";
import type { HotkeyAccelerator, HotkeySettings } from "../shared/hotkey";
import type { ErrorCode } from "../shared/state";

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

/**
 * Why main refused the last display-media request. The renderer only sees a
 * generic `AbortError`; this lets the recorder report the real cause.
 */
let lastDenialReason: ErrorCode | undefined;

/** Always the primary display, always with system audio (docs/system-design/recording.md). */
async function chooseDisplayMedia(
  _request: DisplayMediaRequestHandlerHandlerRequest,
  callback: (streams: Streams) => void,
): Promise<void> {
  // Calling the callback with no streams is the only way to deny that does
  // not throw ("Video was requested, but no video stream was provided").
  const deny = (reason: ErrorCode, why: string): void => {
    log(`display media: denied (${reason}): ${why}`);
    lastDenialReason = reason;
    (callback as () => void)();
  };
  try {
    const primary = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    const source = sources.find((s) => s.display_id === String(primary.id)) ?? sources[0];
    if (!source) {
      deny("no_display", "no screen source available");
      return;
    }
    lastDenialReason = undefined;
    callback({ video: source, audio: "loopback" });
  } catch (cause) {
    // On macOS `getSources` throws "Failed to get sources." when screen
    // recording permission is missing or stale.
    deny(process.platform === "darwin" ? "permission_denied" : "no_display", String(cause));
  }
}

if (!app.requestSingleInstanceLock()) {
  log("start: another instance already holds the userData lock; exiting");
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
  // No window: neither of these may quit the app (docs/system-design/recording.md).
  app.on("window-all-closed", () => undefined);

  await app.whenReady();
  if (process.platform === "darwin") app.dock?.hide();

  const settings = new SettingsStore({
    filePath: path.join(app.getPath("userData"), "settings.json"),
    defaultOutputDir: defaultOutputDir(),
    log,
  });
  currentLanguage = settings.language;
  log(
    `start: ${APP_NAME} ${app.getVersion()}; electron ${process.versions.electron}; ` +
      `${process.platform} ${os.release()}; outputDir ${settings.outputDir}; ` +
      `quality ${JSON.stringify(settings.quality)}; log ${logPath}; ` +
      `packaged ${app.isPackaged}; executable ${process.execPath}`,
  );
  // a development-only unattended run driven by an environment
  // variable; its quality override lives in memory only. Packaged builds
  // never read it (`parseAutoRecord` returns undefined).
  const autoRecord = parseAutoRecord(process.env["RECORDSTUFF_AUTORECORD"], app.isPackaged);
  if (autoRecord && !autoRecord.ok) log(`autorecord: ignoring RECORDSTUFF_AUTORECORD: ${autoRecord.error}`);
  const qualityOverride = autoRecord?.ok ? autoRecord.config.quality : undefined;
  /** A stored 60 fps on a platform where it is not yet verified records at 30. */
  const quality = (): QualitySettings => effectiveQuality(qualityOverride ?? settings.quality, process.platform);

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => void chooseDisplayMedia(request, callback),
    { useSystemPicker: false },
  );

  const host = new CaptureHost({
    preloadPath: path.join(__dirname, "../preload/index.js"),
    devUrl: app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"],
    htmlPath: path.join(__dirname, "../renderer/index.html"),
    log,
  });

  const recorder = new Recorder({
    host,
    outputDir: () => settings.outputDir,
    quality,
    ensureWritableDir,
    openWriter: (recordingPath, finalPath) => FileWriter.open(recordingPath, finalPath),
    preflight: () => (osSupported() ? undefined : "unsupported_os_version"),
    onSessionStart: () => {
      lastDenialReason = undefined;
    },
    mapHostError: (code) => {
      const reason = lastDenialReason;
      lastDenialReason = undefined;
      // Only errors that a denied display-media request can explain.
      const explainable = code === "capture_start_failed" || code === "permission_denied" || code === "no_display";
      return reason && explainable ? reason : code;
    },
    log,
  });

  const permission =
    process.platform === "darwin"
      ? new PermissionWatcher((status) => recorder.setPermission(status), { log })
      : undefined;

  let quitting = false;
  // One action for both entry points (plan 016): the tray's left click and the
  // global shortcut call the same `toggle`, whose state guards decide.
  const toggle = (): void => recorder.toggle();
  const hotkey = new RecordingHotkey({ globalShortcut, onToggle: toggle, log });
  /** Settings that touch a session (quality, shortcut) change only here. */
  const settled = (): boolean => recorder.state.type === "idle" || recorder.state.type === "needsPermission";
  const updates = new UpdateChecker({
    localVersion: app.getVersion(), settled,
    preference: () => settings.updates,
    saveAttempt: (lastAttempt) => settings.setUpdates({ lastAttempt }),
    fetch: (signal) => fetchVersion(process.platform, process.arch, signal, (url, init) => net.fetch(url, init)),
    changed: () => { if (settled()) tray.refresh(); }, log,
  });
  const tray = new AppTray({
    resourcesDir: resourcesDir(),
    context: () => ({
      platform: process.platform,
      outputDir: settings.outputDir,
      homeDir: os.homedir(),
      quality: quality(),
      language: settings.language,
      updates: { state: updates.state, enabled: settings.updates.enabled },
      hotkey: {
        ...settings.hotkey,
        // "registered" means the saved combination is the live one; a deferred
        // change shows as unavailable until the recorder settles and it applies.
        registered: hotkey.status.kind === "registered" && hotkey.status.accelerator === settings.hotkey.accelerator,
      },
    }),
    onToggle: toggle,
    onAction: (action) => void handleAction(action),
    log,
  });
  tray.render(recorder.state);
  applyHotkey(settings.hotkey);

  /** Register with the OS and surface a refusal in the menu and a notification. */
  function applyHotkey(setting: HotkeySettings): void {
    reportHotkey(hotkey.request(setting, settled()));
  }

  function reportHotkey(result: { kind: string; accelerator?: HotkeyAccelerator } | undefined): void {
    if (!result) return;
    if (result.kind === "failed" && result.accelerator) tray.notifyHotkeyRegistrationFailed(result.accelerator);
    tray.refresh();
  }

  /**
   * Persist first, register second: a failed write keeps the old registration.
   * A recording that starts while the write is pending keeps its shortcut;
   * the registration change waits for the recorder to settle (review F2).
   */
  async function setHotkey(setting: HotkeySettings): Promise<void> {
    if (!settled()) return;
    try {
      await settings.setHotkey(setting);
    } catch (cause) {
      log(`settings: failed to save hotkey ${JSON.stringify(setting)}: ${String(cause)}`);
      tray.notifyHotkeyWriteFailed();
      return;
    }
    log(`settings: hotkey ${JSON.stringify(settings.hotkey)}`);
    applyHotkey(settings.hotkey);
  }

  async function handleAction(action: TrayAction): Promise<void> {
    if (typeof action !== "string") {
      if ("setUpdateChecks" in action) {
        if (!settled()) return;
        try { await settings.setUpdates({ enabled: action.setUpdateChecks }); }
        catch (error) { log(`updates: preference save failed: ${String(error)}`); }
        if (settled()) tray.refresh();
      } else if ("setLanguage" in action) {
        try {
          await settings.setLanguage(action.setLanguage);
          currentLanguage = settings.language;
          tray.refresh();
        } catch (cause) {
          log(`settings: failed to save language: ${String(cause)}`);
          tray.notifyLanguageWriteFailed();
        }
      } else if ("setHotkey" in action) {
        await setHotkey(action.setHotkey);
      } else {
        await setQuality(action.setQuality);
      }
      return;
    }
    switch (action) {
      case "checkUpdates":
        await updates.check(true);
        return;
      case "openUpdate":
        if (settled()) await shell.openExternal(updates.state.kind === "available" ? DOWNLOAD_URL : RELEASES_URL);
        return;
      case "stop":
        recorder.stop();
        return;
      case "quit":
        app.quit();
        return;
      case "openPermissionSettings":
        await openScreenCaptureSettings();
        return;
      case "relaunch":
        app.relaunch();
        app.quit();
        return;
      case "revealLastSaved":
        if (recorder.state.type === "idle" && recorder.state.lastSavedPath) {
          shell.showItemInFolder(recorder.state.lastSavedPath);
        }
        return;
      case "revealLog":
        await revealLog();
        return;
      case "openOutputDir": {
        const error = await shell.openPath(settings.outputDir);
        if (error) log(`openPath(${settings.outputDir}) failed: ${error}`);
        return;
      }
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
    if (recorder.state.type === "recording" || recorder.state.type === "stopping") return;
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
    tray.refresh();
  }

  /**
   * the choice is applied only after settings.json is written;
   * a failed write keeps the previous value and says so. The menu is
   * disabled outside idle / needsPermission, so a running session's
   * snapshot is never touched.
   */
  async function setQuality(patch: Partial<QualitySettings>): Promise<void> {
    if (recorder.state.type !== "idle" && recorder.state.type !== "needsPermission") return;
    try {
      await settings.setQuality(patch);
    } catch (cause) {
      log(`settings: failed to save quality ${JSON.stringify(patch)}: ${String(cause)}`);
      tray.notifyQualityWriteFailed();
      return;
    }
    log(`settings: quality ${JSON.stringify(settings.quality)}`);
    tray.refresh();
  }

  const savedNotification = new SavedNotification({
    platform: process.platform,
    show: (savedPath) => tray.notifySaved(savedPath),
    log,
  });
  let previous = recorder.state;
  recorder.subscribe((event) => {
    switch (event.type) {
      case "state": {
        savedNotification.stateChanged(event.state);
        log(`state → ${event.state.type}`);
        tray.render(event.state);
        updates.flush();
        // A shortcut change saved during a session applies now that it is over.
        reportHotkey(hotkey.flush(settled()));
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
        log(`saved ${event.path}`);
        savedNotification.schedule(event.path);
        return;
      case "captureStarted": {
        const actual = frameRateDowngrade(event.requested, event.capture);
        if (actual !== undefined) {
          log(`frame rate downgraded: requested ${event.requested.frameRate}, track reports ${actual}`);
          tray.notifyFrameRateDowngrade(event.requested.frameRate, actual);
        }
        return;
      }
      case "failed":
        log(`failed: ${event.code} ${event.detail}${event.partialPath ? ` (kept ${event.partialPath})` : ""}`);
        tray.notifyError(event.code, event.partialPath);
        // The OS says granted, yet capture is refused: TCC needs a relaunch.
        if (event.code === "permission_denied" && permission) permission.markRelaunchRequired();
        return;
      case "permissionRequested":
        tray.notifyPermission(event.needsRelaunch);
        return;
    }
  });

  permission?.start();
  if (process.platform === "win32" && (await isFirstRun(app.getPath("userData")))) {
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

  app.on("before-quit", (event) => {
    updates.dispose();
    savedNotification.dispose();
    if (quitting) return;
    const busy = recorder.state.type === "starting" || recorder.state.type === "recording" || recorder.state.type === "stopping";
    if (!busy) {
      quitting = true;
      return;
    }
    event.preventDefault();
    log("quit requested during recording; stopping first");
    void recorder.shutdown().finally(() => {
      quitting = true;
      app.quit();
    });
  });

  app.on("will-quit", () => {
    hotkey.dispose();
    permission?.stop();
    host.destroy();
    tray.destroy();
  });

  updates.flush();
  log(`ready; output dir ${settings.outputDir}; hotkey ${JSON.stringify(hotkey.status)}`);
}
