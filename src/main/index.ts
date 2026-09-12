/**
 * App lifecycle (plans/001-first-version.md §12): hide the Dock icon, create the tray, register
 * the display-media handler (primary display + system audio loopback), detect
 * permission, and make quitting wait for a running recording to finish.
 * No window is ever created here; the only renderer is the hidden capture host.
 */
import {
  app,
  desktopCapturer,
  dialog,
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
import { createFileLogger } from "./log";
import { PermissionWatcher, openScreenCaptureSettings } from "./permission";
import { Recorder } from "./recorder";
import { SettingsStore } from "./settings";
import { AppTray } from "./tray";
import { APP_NAME, type TrayAction } from "./tray-model";
import type { ErrorCode } from "../shared/state";

const APP_ID = "com.recordstuff.app";

/**
 * stdout plus a rotated file (plans/002-file-logging.md). `app.getPath("logs")` is
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
  dialog.showErrorBox(APP_NAME, `發生未預期的錯誤：${error.message}`);
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
 * a hint notification (plans/001-first-version.md §8). A marker file in userData records that it
 * was shown; settings.json stays limited to `outputDir`.
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
 * generic `AbortError`; this lets the recorder report the real cause (§13).
 */
let lastDenialReason: ErrorCode | undefined;

/** Always the primary display, always with system audio (plans/001-first-version.md §6). */
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
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
  // No window: neither of these may quit the app (plans/001-first-version.md §12).
  app.on("window-all-closed", () => undefined);

  await app.whenReady();
  if (process.platform === "darwin") app.dock?.hide();

  const settings = new SettingsStore({
    filePath: path.join(app.getPath("userData"), "settings.json"),
    defaultOutputDir: defaultOutputDir(),
    log,
  });
  log(
    `start: ${APP_NAME} ${app.getVersion()}; electron ${process.versions.electron}; ` +
      `${process.platform} ${os.release()}; outputDir ${settings.outputDir}; log ${logPath}`,
  );

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
  const tray = new AppTray({
    resourcesDir: resourcesDir(),
    context: () => ({ platform: process.platform, outputDir: settings.outputDir, homeDir: os.homedir() }),
    onToggle: () => recorder.toggle(),
    onAction: (action) => void handleAction(action),
  });
  tray.render(recorder.state);

  async function handleAction(action: TrayAction): Promise<void> {
    switch (action) {
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
      title: "選擇錄影儲存位置",
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

  let previous = recorder.state;
  recorder.subscribe((event) => {
    switch (event.type) {
      case "state": {
        log(`state → ${event.state.type}`);
        tray.render(event.state);
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
        tray.notifySaved(event.path);
        return;
      case "failed":
        log(`failed: ${event.code} ${event.detail}${event.partialPath ? ` (kept ${event.partialPath})` : ""}`);
        tray.notifyError(event.code, event.detail, event.partialPath);
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

  app.on("before-quit", (event) => {
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
    permission?.stop();
    host.destroy();
    tray.destroy();
  });

  log(`ready; output dir ${settings.outputDir}`);
}
