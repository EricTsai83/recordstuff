/**
 * App lifecycle (docs/system-design/recording.md): hide the Dock icon, create the tray, detect permission, and make
 * quitting wait for recording work, metadata writes and failure history. Settings use a separate sandboxed window;
 * capture runs in the native engine's `utilityProcess` (plan 076).
 */
import { createPreferenceActions } from "./settings/preferences";
import { DEFAULT_AUDIO_VOLUME } from "../shared/audio-volume";
import { DIAGNOSTICS_ENV } from "../shared/pipeline-histogram";
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
import { SHOW_SYSTEM_UI, systemUiCrop } from "../shared/system-ui";
import {
  app,
  BaseWindow,
  BrowserWindow,
  desktopCapturer,
  clipboard,
  ClipboardItem,
  dialog,
  globalShortcut,
  MessageChannelMain,
  nativeImage,
  net,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  screen,
  shell,
  type DesktopCapturerSource,
} from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NativeCaptureHost } from "./recording/native-capture-host";
import { cameraPreviewOn, cameraPrototypeOn } from "./recording/native-host-process";
import { CameraPreview } from "./recording/camera-preview";
import { StudioLink } from "./settings/studio-link";
import { MicrophoneMonitor } from "./settings/microphone-monitor";
import { captureExclusion } from "./recording/capture-exclusion";
import { EngineFileWriter } from "./recording/engine-file-writer";
import { CountdownOverlay } from "./recording/countdown-overlay";
import { ensureWritableDir } from "./recording/file-writer";
import { KeepAwake } from "./recording/keep-awake";
import { DeviceLists } from "./app/device-lists";
import { createOutputFolderOpener, isSameFolder } from "./library/output-folder";
import { createUncaughtExceptionHandler } from "./app/fault-dialog";
import { createFileLogger, flushBeforeExit } from "./lib/log";
import { stackOf } from "./lib/errors";
import { createRunId, logSessionEvent } from "./recording/session-log";
import { PermissionWatcher, askCameraAccess, askMicrophoneAccess, cameraAccess, openCameraSettings, microphoneAccess, openMicrophoneSettings, openNotificationSettings, openOptionalFeatures, openScreenCaptureSettings } from "./permission/permission";
import { missingMediaComponents } from "./recording/media-components";
import { EditableChoice } from "./recording/editable-choice";
import { startProblems } from "./settings/model/inputs";
import { Recorder } from "./recording/recorder";
import { SessionSentinels, reportInterruptions } from "./recording/session-sentinel";
import { SavedNotification } from "./recording/saved-notification";
import { CaptureNotices } from "./recording/capture-notices";
import { PermissionNotices } from "./permission/permission-notices";
import { accessRefused, settleInputAccess } from "./settings/input-access";
import { holdEarlyReopens, watchReopen, type EarlyReopens, type ReopenWatcher } from "./app/reopen";
import { holdSessionEnd } from "./app/session-end";
import { SettingsStore } from "./settings/settings";
import { parseAutoRecord, runAutoRecord } from "./recording/autorecord";
import { UpdateChecker, fetchVersion, downloadPageUrl } from "./app/updates";
import { createActionHandler } from "./actions/actions";
import { AppTray } from "./menus/tray";
import { AppMenu } from "./menus/app-menu";
import { VideoFullScreen } from "./library/video-fullscreen";
import { SettingsWindow } from "./settings/settings-window";
import { MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES, MoveFailure, RecordingsLibrary } from "./library/recordings-library";
import { videoThumbnail } from "./library/video-thumbnail";
import type { AppAction, AppContext } from "./app/ui-model";
import { APP_NAME } from "./lib/app-name";
import { preferencesUnlocked } from "./recording/recording-lock";
import { effectiveQuality, type QualitySettings } from "../shared/quality";
import { AppShortcuts } from "./shortcuts/shortcuts";
import { physicalHotkeyFeatures } from "./shortcuts/hotkey";
import type { ErrorCode, RecordingState } from "../shared/state";
import type { CountdownSeconds } from "../shared/countdown";

import { DEFAULT_LANGUAGE, translate, type Language } from "../shared/i18n";
import { formatFileName } from "../shared/file-name";
import { EditStore, sourceIdentity } from "./editing/edit-store";
import { ExportHost } from "./editing/export-host";
import { Editing } from "./editing/editing";
import { mp4Facts } from "./library/mp4-duration";
import { VersionCache } from "./sharing/version-cache";
import { inOutputFolder, Sharing, VersionFailed } from "./sharing/sharing";
import { clipboardFiles, copiedFiles, filesPropertyList, saveInto } from "./sharing/give";
import { Housekeeping } from "./sharing/housekeeping";
import { Governor, pacePolicy, type Conditions } from "./sharing/governor";
import { PREPARE_AT_LAUNCH_ENV, VERSION_PACE_ENV } from "./sharing/pace-env";
import { DEFAULT_CAMERA_LAYOUT } from "../shared/camera-layout";
import type { EarlyStop } from "../shared/session-record";
import { LOW_POWER_POLL_MS, readLowPower } from "./sharing/low-power";
import { FolderWatch } from "./library/folder-watch";
import { engineAddonPath } from "./lib/engine-module";

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
// Plan 083's development switch: the Studio page's JavaScript heap figure (plan 084) read exactly rather than in buckets.
if (process.env[DIAGNOSTICS_ENV] === "1") app.commandLine.appendSwitch("enable-precise-memory-info");

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
  // From here a second launch reaches this process; it is answered once Settings can open.
  const earlyReopens = holdEarlyReopens(app);
  await main(earlyReopens).catch(async (cause: unknown) => {
    log(`start: failed: ${stackOf(cause)}; exiting`);
    await flushBeforeExit(log);
    dialog.showErrorBox(APP_NAME, translate("An unexpected error occurred. See the log for details.", appLanguage()));
    app.exit(1);
  });
}

async function main(earlyReopens: EarlyReopens): Promise<void> {
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
  /**
   * Settings closed or hid, which end the same way: the folder is not followed out of sight (showing the window again
   * watches and lists it afresh, `activated`), recordings waiting to go to the Trash go now, since nothing is left to
   * undo them from, and the menu bar app gives back its window's menu.
   */
  const settingsGone = (): void => {
    library.unwatch();
    void library.flushTrash();
    appMenu.windowClosed();
  };
  const hideSettings = (): void => {
    void settingsWindow.hide().then(hidden => {
      // Opened again while it was leaving full screen: it stays a Dock app that follows its folder.
      if (hidden) settingsGone();
    });
  };
  const appMenu = new AppMenu({
    state: () => recorder.state, context: () => appContext(), language: () => settings.language,
    onAction: action => runAction(action, "app menu"), log,
    trayMenuOpen: () => tray.menuOpen,
    // Hiding leaves only the menu bar's icon, as closing does; Quit alone ends RecordStuff.
    hide: hideSettings,
    zoom: request => settingsWindow.zoom(request),
  });
  const library = new RecordingsLibrary({
    dir: () => settings.outputDir,
    // Only Settings shows the listing; the tray has nothing to redraw. A recording gone from the folder takes what was
    // made from it to share it (plan 100).
    changed: () => {
      settingsWindow.refresh();
      const listed = library.state;
      if (!listed.loading && !listed.failed) scheduleHousekeeping();
    },
    thumbnail: file => videoThumbnail(nativeImage, file),
    trash: file => shell.trashItem(file),
    open: file => shell.openPath(file),
    reveal: file => shell.showItemInFolder(file),
    // A saved copy's recording is found by the identity its edit is known by (plan 100, D4).
    identity: async file => (await sourceIdentity(file)).hash,
    // What was made from a recording to share it goes once the recording really went (plan 100), and its edit with it.
    trashed: file => { void sharing.removed(file); void editStore.discard(file).catch((cause: unknown) => log(`editing: the edit of ${file} was not removed: ${String(cause)}`)); },
    // A recording's edit is written for its new path before it moves in the tab, and the move is not made if it cannot
    // be (plan 100); afterwards the old record goes, and the versions follow it.
    beforeMove: async (from, to, folder) => {
      try {
        await (folder ? editStore.prepareFolderMove(from, to) : editStore.prepareMove(from, to));
      } catch (cause) {
        const free = await fs.statfs(editStore.folder).then(stat => stat.bavail * stat.bsize, () => undefined);
        throw MoveFailure.of(cause, editStore.folder, free);
      }
    },
    afterMove: async (from, to, moved, folder) => {
      await (folder ? editStore.finishFolderMove(from, to, moved) : editStore.finishMove(from, to, moved))
        .catch((cause: unknown) => log(`editing: the edit left at ${moved ? from : to} was not removed: ${String(cause)}`));
      if (moved) await (folder ? sharing.folderMoved(from, to) : sharing.moved(from, to));
      settingsWindow.refresh();
    },
    log,
  });
  // The library's media protocol lives on the default session, and using that session makes Electron start a renderer
  // ahead of time, which then idles. Nothing else uses the session until a window opens, so the protocol is registered
  // as the first window is made, before it loads anything (plan 076, step 4). Nothing may use it at launch.
  // An editable recording's preview tracks (plan 087) are the edit view's own; every other address is the library's.
  let editingPreview: ((request: Request) => Promise<Response> | undefined) | undefined;
  app.once("browser-window-created", () => protocol.handle(MEDIA_SCHEME, request => editingPreview?.(request) ?? library.handle(request)));
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
  /** Autorecord mixes the microphone in only when its configuration says so (plan 074). */
  const microphoneOn = (): boolean => autoRecord?.ok ? autoRecord.config.microphone : settings.microphone;
  /** An autorecord folder, like its quality, lives in memory only. */
  const outputDirOverride = autoRecord?.ok ? autoRecord.config.outputDir : undefined;

  const displays = (): DisplayInfo[] => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({ id: String(d.id), label: d.label,
      logicalWidth: d.size.width, logicalHeight: d.size.height, scaleFactor: d.scaleFactor, x: d.bounds.x, y: d.bounds.y,
      workArea: { x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height },
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
  // Plan 076's native engine: a `utilityProcess` running the Rust engine, which captures with ScreenCaptureKit (macOS)
  // or Windows.Graphics.Capture (Windows) and writes the file itself. It leaves RecordStuff's own windows out of every
  // recording, those opened after the start included (075's D14). Other platforms have no engine: a recording fails
  // when the module does not load.
  const excludeWindowsFromCapture = captureExclusion<BrowserWindow>({
    windows: () => BrowserWindow.getAllWindows(),
    onCreated: (listener) => {
      const created = (_event: Electron.Event, window: BrowserWindow): void => listener(window);
      app.on("browser-window-created", created);
      return () => app.removeListener("browser-window-created", created);
    },
  });
  // Windows without Media Foundation cannot encode (plan 078): checked once, as the libraries come only with an update.
  const missingMedia = missingMediaComponents(process.platform, process.env["SystemRoot"]);
  const mediaComponentsMissing = missingMedia.length > 0;
  if (mediaComponentsMissing) log(`media components: missing ${missingMedia.join(", ")}; recording is unavailable until the Media Feature Pack is installed`);
  // What the engine keeps between recordings, each of which runs in a process of its own (plan 078 step 4: which of the
  // Windows adapters' hardware encoders passed their self-test or failed); the capture process inherits it.
  process.env["RECORDSTUFF_ENGINE_DATA"] = path.join(app.getPath("userData"), "engine");
  let captureAnchor: BaseWindow | undefined;
  /** Whether the next recording is editable: the setting, or the tray's Start editable recording (2026-10-25) once. */
  const editable = new EditableChoice({
    platform: process.platform,
    setting: () => settings.editableRecording,
    preview: () => recorder.preview !== undefined,
    stopPreview: () => { previewPrepared = undefined; recorder.stopPreview(); },
    log,
  });
  const cameraPreview = process.platform === "darwin" && cameraPreviewOn(process.env) ? new CameraPreview({
    preloadPath: path.join(__dirname, "../preload/camera-preview.js"),
    devUrl: !app.isPackaged && process.env["ELECTRON_RENDERER_URL"]
      ? new URL("camera-preview.html", process.env["ELECTRON_RENDERER_URL"]).href : undefined,
    htmlPath: path.join(__dirname, "../renderer/camera-preview.html"),
    log,
  }) : undefined;
  // Access is asked when the Camera switch is turned on (plan 075 step 4), not at launch.
  if (process.platform === "darwin" && cameraPrototypeOn(process.env)) {
    log(`camera prototype: on (${process.env["RECORDSTUFF_CAMERA_PROTOTYPE"] ?? ""}), preview page ${cameraPreview ? "on" : "off"}, camera access ${cameraAccess() ?? "unknown"}`);
  }
  /** What the last session started records of its display (plan 099), which the Studio's preview keeps while it shows that session. */
  let captureArea: AppContext["captureArea"];
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  const host = new NativeCaptureHost({
    entryPath: path.join(__dirname, "native-host-process.js"),
    addonPath: engineAddonPath(__dirname),
    resolveDisplay: (_sessionId, screenAccess) => new Promise((resolve) => displayMedia.answer(() => true, (source) => resolve(source?.display_id || undefined), screenAccess)),
    // Main first: the engine takes its bundle identifier as the prefix of RecordStuff's helpers.
    ownPids: () => [process.pid, ...app.getAppMetrics().map((metric) => metric.pid).filter((pid) => pid !== process.pid)],
    // macOS lists RecordStuff among the apps a recording can leave out only while it owns a window (plan 078 step 2):
    // with no countdown and nothing open it owned none, and its windows opened later were recorded. A hidden 1-pixel
    // BaseWindow, made once and never shown, is that window; it has no page and so no renderer process.
    ...(process.platform === "darwin" ? { beforeCapture: () => {
      if (!captureAnchor || captureAnchor.isDestroyed()) {
        captureAnchor = new BaseWindow({ show: false, width: 1, height: 1, frame: false, focusable: false, hasShadow: false, skipTaskbar: true });
      }
    } } : {}),
    // Only ScreenCaptureKit can leave the system's chrome out (D6 of plan 076). A hidden menu bar or Dock that keeps a
    // strip on this display has it cut off (plan 099): the work area says which strips are kept, as the recording starts.
    systemUi: (displayId: string) => {
      if (process.platform !== "darwin") return { hide: SHOW_SYSTEM_UI };
      const hide = settings.systemUi;
      const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === displayId);
      const crop = display ? systemUiCrop(display.bounds, display.workArea, display.scaleFactor, hide) : undefined;
      captureArea = crop ? { display: displayId, width: crop.width, height: crop.height }
        : display ? { display: displayId, width: even(display.bounds.width * display.scaleFactor), height: even(display.bounds.height * display.scaleFactor) }
        : undefined;
      if (crop) log(`capture: display ${displayId} cut to ${crop.width}x${crop.height} at ${crop.x},${crop.y} without the system's strips`);
      return { hide, ...(crop ? { crop } : {}) };
    },
    // The prompt, when macOS never asked, comes as the recording starts (plan 074); a refusal is the engine's to report.
    prepareMicrophone: async () => { if (!(await askMicrophoneAccess())) log("microphone: access is not allowed"); },
    // Plan 075 step 2's prototype, only behind its development switch: the camera's access asked at launch, and each
    // attempt's capture process joined to the preview page.
    ...(cameraPreview ? { onLaunch: (child: Electron.UtilityProcess) => cameraPreview.connect(child) } : {}),
    ...(process.platform === "win32" ? {
      // The engine finds the display by the physical point at its centre: Electron's ids name no monitor there.
      displayPoint: (displayId: string) => {
        const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === displayId);
        if (!display) return undefined;
        const { x, y, width, height } = display.bounds;
        const point = screen.dipToScreenPoint({ x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) });
        return { x: Math.round(point.x), y: Math.round(point.y) };
      },
      excludeOwnWindows: excludeWindowsFromCapture,
    } : {}),
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

  // Cutting a recording (plan 085): the edit view's state and its export, in a worker process of its own that loads
  // the same engine. Exports a crash left unfinished are removed first; recording always wins over an export.
  const editsDir = path.join(app.getPath("userData"), "edits");
  const exportJournal = path.join(editsDir, "exports-in-flight.json");
  const editStore = new EditStore(editsDir);
  // One export worker for the edit view and the versions prepared for sharing (plan 100), one request at a time.
  const exportHost = new ExportHost({
    entryPath: path.join(__dirname, "export-process.js"),
    addonPath: engineAddonPath(__dirname),
    log,
  });
  /** What capture is doing that an export, or a version prepared ahead, must not compete with. */
  const captureBusy = (): "quitting" | "recording" | "preview" | "saving" | undefined => {
    if (quitInProgress()) return "quitting";
    if (!preferencesUnlocked(recorder.state)) return "recording";
    if (recorder.preview) return "preview";
    if (recorder.mediaPending) return "saving";
    return undefined;
  };
  const editing = new Editing({
    store: editStore,
    runner: exportHost,
    find: (id) => library.find(id),
    blocked: captureBusy,
    language: () => settings.language,
    // A view or an export that ended lets a version waiting for the worker go on (plan 100).
    changed: () => { settingsWindow.refresh(); sharing.resume(); },
    opening: () => sharing.yield("the edit view opened"),
    // D2: the Video is prepared when the edit view closes.
    closed: (file) => sharing.prepare(file),
    published: () => { void library.refresh(); },
    reveal: (file) => shell.showItemInFolder(file),
    // Save a copy…'s Change… (plan 100): the system's folder picker, starting where copies go now.
    chooseFolder: async (from) => {
      focusApp();
      const chosen = await dialog.showOpenDialog({ title: translate("Choose where to save", settings.language), defaultPath: from, properties: ["openDirectory", "createDirectory"] });
      return chosen.canceled ? undefined : chosen.filePaths[0];
    },
    journal: exportJournal,
    previewDir: path.join(editsDir, "preview"),
    log,
  });
  // What a crash left, in the journal's own queue: an export started meanwhile is journalled after it.
  void editing.removeLeftovers();
  // Which recordings hold an edit, for the Recordings tab's mark.
  void editing.scanEdits().then(() => settingsWindow.refresh(), () => undefined);
  void editing.removePreviews();
  editingPreview = (request) => editing.previewResponse(request);

  // Sharing a recording (plan 100): the versions a drag gives, prepared ahead into the system's cache folder, in the same
  // worker, one at a time and only while nothing else needs it (step 4 lets it run beside a recording under a governor).
  const versionCache = new VersionCache({
    root: process.platform === "win32" && process.env["LOCALAPPDATA"]
      ? path.join(process.env["LOCALAPPDATA"], APP_NAME, "Cache", "Versions")
      : path.join(app.getPath("home"), "Library", "Caches", APP_NAME, "Versions"),
    log,
  });
  const sharing = new Sharing({
    cache: versionCache,
    store: editStore,
    runner: exportHost,
    editable: async (file) => (await mp4Facts(file).catch(() => ({ editable: false }))).editable,
    // A recording, a Live preview and a save hold a version where it is (the governor below); these cancel it.
    paused: () => (quitInProgress() ? "quitting" : editing.view() || editing.exporting ? "editing" : undefined),
    language: () => settings.language,
    changed: () => { settingsWindow.refresh(); followLowPower(); },
    log,
  });
  /**
   * Low Power Mode, which Electron does not tell (plan 100 step 4): read as versions start being prepared and every
   * `LOW_POWER_POLL_MS` while they are, never while idle, which allows no timer of its own.
   */
  let lowPowerTimer: ReturnType<typeof setInterval> | undefined;
  function followLowPower(ending = false): void {
    const read = (): void => { void readLowPower().then((lowPower) => governor.update({ lowPower })); };
    if (!ending && sharing.working) {
      if (lowPowerTimer) return;
      read();
      // Each tick looks again, so the polling ends with the work however it ended (Codex F2).
      lowPowerTimer = setInterval(() => { if (sharing.working) read(); else followLowPower(); }, LOW_POWER_POLL_MS);
      lowPowerTimer.unref();
    } else if (lowPowerTimer) {
      clearInterval(lowPowerTimer);
      lowPowerTimer = undefined;
    }
  }
  // Versions prepared alongside a recording never cost it a picture (plan 100 step 4): held where they are by a recording
  // (by its health, on a Mac whose class passed the gate), a Live preview, a save, heat or Low Power Mode.
  const chip = os.cpus()[0]?.model;
  // Development only (plan 100 step 4's gate, `pnpm matrix -- pace`): the pace forced, and a version prepared at launch.
  const forcedPace = app.isPackaged ? undefined : process.env[VERSION_PACE_ENV];
  const policy = forcedPace === "governed" || forcedPace === "pause" ? forcedPace : pacePolicy(process.platform, chip);
  const governor = new Governor({ policy, changed: (pace) => sharing.pace(pace), log });
  log(`versions: during a recording, ${policy === "governed" ? "paced by its health" : "held until it ends"} on this Mac (${chip ?? "unknown chip"}${forcedPace ? `; ${VERSION_PACE_ENV}=${forcedPace}` : ""})`);
  const prepareAtLaunch = app.isPackaged ? undefined : process.env[PREPARE_AT_LAUNCH_ENV];
  if (prepareAtLaunch) {
    // Made afresh each launch, so every case of the gate prepares it while it records.
    void versionCache.removeSource(prepareAtLaunch, "prepared again at launch").then(() => {
      log(`versions: preparing ${prepareAtLaunch} at launch (${PREPARE_AT_LAUNCH_ENV})`);
      sharing.prepare(prepareAtLaunch);
    });
  }
  /** What the governor hears of the recorder: a recording, a Live preview, a save. */
  function followCapture(): void {
    const preview = recorder.preview !== undefined;
    governor.update({ recording: !preferencesUnlocked(recorder.state) && !preview, preview, saving: recorder.saving.length > 0 });
  }
  // What is kept for a recording is kept only while it is (plan 100): checked at launch, as the window lists the folder
  // and whenever the folder changes, which is followed for as long as RecordStuff runs, recording or not.
  const housekeeping = new Housekeeping({
    store: editStore,
    sweepVersions: dir => sharing.sweep(dir),
    outputDir: () => settings.outputDir,
    changed: () => settingsWindow.refresh(),
    log,
  });
  let housekeepingTimer: ReturnType<typeof setTimeout> | undefined;
  /** A check soon, once: a listing publishes several times while it reads the files' lengths. */
  function scheduleHousekeeping(): void {
    clearTimeout(housekeepingTimer);
    housekeepingTimer = setTimeout(() => { housekeepingTimer = undefined; folderWatch.start(); void housekeeping.run(); }, 300);
  }
  // Watching starts again at every check (a folder away at launch or lost to an error comes back once it is there).
  const folderWatch = new FolderWatch({ dir: () => settings.outputDir, changed: () => { folderWatch.start(); void housekeeping.run(); }, log });
  folderWatch.start();
  void Promise.all([versionCache.scan(), editStore.scan()]).then(() => housekeeping.run()).then(() => settingsWindow.refresh(), () => undefined);

  // One file per in-flight session; any left at launch belongs to a process that ended while recording.
  const sentinels = new SessionSentinels(path.join(app.getPath("userData"), "recording-sessions"), log);
  const recorder = new Recorder({
    host,
    ...(mediaComponentsMissing ? { mediaComponentsMissing } : {}),
    outputDir: () => outputDirOverride ?? settings.outputDir,
    quality,
    countdownSeconds,
    countdownSound,
    microphone: () => {
      // Autorecord's microphone is the system default; the user's is the one Settings chose.
      const device = autoRecord?.ok ? undefined : settings.microphoneDevice;
      const named = device ? devices.microphones?.find((candidate) => candidate.id === device.id)?.name ?? device.label
        : devices.microphones?.find((candidate) => candidate.default)?.name;
      // Refused by macOS (its switch is turned off at the next launch or press): left out, so the recording still starts.
      const enabled = microphoneOn() && (autoRecord?.ok || !accessRefused(microphoneAccess()));
      return { enabled, ...(device ? { deviceId: device.id } : {}), ...(named ? { label: named } : {}) };
    },
    // The camera (plan 075): the user's switch, shown and so honoured only where the camera is available (step 7, with
    // the Camera group's controls, removes the development switch); autorecord never records it.
    camera: () => {
      // On macOS only an allowed camera (review pass 2): the engine opens no other, and one never asked, left on by a
      // guide finished mid-recording or a reset grant, would refuse the whole recording as camera_unavailable.
      // Autorecord records the camera only when its configuration asks (plan 100 step 4's gate): the default one, at the default layout.
      if (autoRecord?.ok) {
        if (!autoRecord.config.camera) return undefined;
        if (cameraAvailable() && cameraAccess() === "granted") return { layout: DEFAULT_CAMERA_LAYOUT };
        log(`autorecord: the camera was asked for but is ${cameraAvailable() ? `not allowed (${cameraAccess()})` : "unavailable"}`);
        return undefined;
      }
      if (!settings.camera || !cameraAvailable() || (process.platform === "darwin" ? cameraAccess() !== "granted" : accessRefused(cameraAccess()))) return undefined;
      const device = settings.cameraDevice;
      return { ...(device ? { deviceId: device.id } : {}), layout: settings.cameraLayout };
    },
    // The volumes (D21): autorecord's are 0 dB, its sound as the inputs give it.
    audioVolume: () => autoRecord?.ok ? { ...DEFAULT_AUDIO_VOLUME } : settings.audioVolume,
    // Plan 087: the engine records editable files on macOS only. The tray's Start editable recording (2026-10-25) makes
    // one recording editable while the setting stays off; the session keeps what it began as (plan 097, D6).
    editable: () => editable.next(),
    // What the recording starts without (plan 097), under the countdown's digit so it can still be cancelled.
    countdownNotice: () => {
      if (autoRecord?.ok) return undefined;
      const problems = startProblems(recorder.state, appContext());
      return problems.length ? problems.join(settings.language === "zh-TW" ? "、" : " · ") : undefined;
    },
    countdown: overlay,
    // Only RecordStuff's own folders are created; a chosen one that is missing may be an offline drive.
    ensureWritableDir: dir => ensureWritableDir(dir, undefined,
      isSameFolder(dir, settings.defaultOutputDir) || dir === outputDirOverride),
    openWriter: (recordingPath, finalPath) => EngineFileWriter.open(recordingPath, finalPath, { outcome: (file) => host.fileOutcome(file) }),
    fileName: date => formatFileName(settings.fileNameTemplate, date),
    freeSpace: async (dir) => { const volume = await fs.statfs(dir); return volume.bavail * volume.bsize; },
    sentinels,
    publishFailure: result => recordingResults.receive(result, {
      stat: file => fs.stat(file), refresh: refreshUi,
      // Requested as the display stops being shared, which macOS may mute: held like the other capture notices.
      notify: code => permissionNotices.failed(code),
    }),
    preflight: () => (osSupported() ? undefined : "unsupported_os_version"),
    // A version being prepared is held by the governor instead (plan 100 step 4), where it goes on from.
    onSessionStart: (sessionId) => { editing.yieldToCapture(); followCapture(); displayMedia.begin(sessionId); },
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
  /**
   * Quit Without Waiting for the Save was chosen: from that moment nothing may start, whatever the ordinary quit
   * does meanwhile (a deferral reopens admission), since the exit that follows would end a new recording unsaved.
   */
  let exitingWithoutSaves = false;
  const quitInProgress = (): boolean => quit.requested || exitingWithoutSaves;
  const toggle = (): void => { if (!quitInProgress()) recorder.toggle(); };
  /** Settings that touch a session (quality, shortcut) change only here. */
  const settled = (): boolean => !quitInProgress() && preferencesUnlocked(recorder.state);
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
        shell.openExternal(downloadPageUrl(process.platform)).catch((error: unknown) => log(`updates: download link failed: ${String(error)}`));
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
  // The engine composes the camera on macOS and, since plan 075 step 6, on Windows.
  const cameraAvailable = (): boolean => process.platform === "darwin" || process.platform === "win32";
  const devices = new DeviceLists({
    listMicrophones: (allowed) => host.listMicrophones(allowed),
    listCameras: (allowed) => host.listCameras(allowed),
    allowed: () => preferencesUnlocked(recorder.state),
    cameraAvailable,
    changed: () => refreshUi(),
    log,
  });
  /** Why the last Live preview could not start (plan 075, D20), until the next one begins. */
  let previewFailure: ErrorCode | undefined;
  /** Whether the Recording Studio is open in a window in sight, which a Live preview lasts as long as. */
  let studioOpen = false;
  /**
   * The first-launch guide (2026-10-26): open at launch on macOS until finished or set aside, so it comes back after
   * macOS's Quit & Reopen for the screen's grant; General opens it again. Autorecord never shows it.
   */
  let onboardingOpen = process.platform === "darwin" && !autoRecord?.ok && !settings.onboardingDone;
  /** The recording whose picture Live preview was switched off for (2026-10-21); the next session shows its own again. */
  let pictureHiddenFor: string | undefined;
  const pictureHidden = (): boolean => pictureHiddenFor !== undefined && pictureHiddenFor === recorder.previewSessionId && !recorder.preview;
  /** What the Live preview was prepared with: a change to any of it prepares the preview again (D20). */
  const previewInputs = (): string => JSON.stringify([settings.display, settings.quality, settings.systemUi, cropInputs(), settings.outputDir,
    settings.microphone, settings.microphoneDevice ?? null, settings.camera, settings.cameraDevice ?? null,
    // A capture process records an editable file or not from its start: Start must not take a preview of the other kind.
    editable.next()]);
  /**
   * The strips the displays keep for the menu bar and Dock, while one of them is hidden (plan 099): a Dock moved, resized
   * or set to hide automatically changes the part of the display recorded, so the Live preview is prepared again.
   */
  const cropInputs = (): unknown => {
    const hide = settings.systemUi;
    if (process.platform !== "darwin" || !(hide.menuBar || hide.dock)) return null;
    return screen.getAllDisplays().map((display) => [display.id, display.bounds, display.workArea, display.scaleFactor]);
  };
  let previewPrepared: string | undefined;
  /** Follows the Live preview: one prepared with settings since changed is prepared again, while the Studio is open. */
  const followPreview = (): void => {
    const preview = recorder.preview;
    if (!preview) { previewPrepared = undefined; return; }
    const inputs = previewInputs();
    if (previewPrepared === undefined) { previewPrepared = inputs; return; }
    if (inputs === previewPrepared) return;
    log("studio: settings changed under the Live preview; preparing it again");
    previewPrepared = undefined;
    recorder.stopPreview();
    if (studioOpen) setTimeout(() => { if (studioOpen && !recorder.preview) recorder.startPreview(); }, 0);
  };
  /** Saves in the background (2026-10-09), by the name each is saved under, and whether a quit waits only for them. */
  const savingContext = (): Pick<AppContext, "saving" | "quitWithoutWaiting"> => {
    const saving = recorder.saving.map(({ recordingPath, slow }) => ({ file: path.basename(recordingPath).replace(/\.recording(\.[^.]+)$/i, "$1"), slow }));
    const { quitting, quitStep, quitDeferred } = quit.context();
    const heldBySaves = recorder.waitingOnlyForSaves && ((quitting && quitStep === "media") || quitDeferred === "media");
    return { ...(saving.length ? { saving } : {}), ...(heldBySaves ? { quitWithoutWaiting: true } : {}) };
  };
  const appContext = (): AppContext => ({
    recordingResults: recordingResults.all,
    historyLoading: recordingResults.loading,
    historyFailed: recordingResults.historyFailed,
    displays: displays(), display: settings.display, systemUi: settings.systemUi,
    ...(captureArea && recorder.previewSessionId !== undefined ? { captureArea } : {}), editableRecording: settings.editableRecording, studioOnStart: settings.studioOnStart, ...(displayMedia.failure ? { displayFailure: displayMedia.failure } : {}),
    microphone: (() => {
      const device = settings.microphoneDevice, access = microphoneAccess();
      return { enabled: settings.microphone, ...(device ? { device } : {}), ...(devices.microphones ? { devices: devices.microphones } : {}), ...(access ? { access } : {}),
        ...(devices.searching ? { searching: true as const } : {}) };
    })(),
    camera: (() => {
      // The engine records the camera on macOS and Windows (plan 075).
      const access = cameraAccess(), session = recorder.camera, device = settings.cameraDevice;
      return { enabled: settings.camera, available: cameraAvailable(), layout: settings.cameraLayout, ...(access ? { access } : {}),
        ...(session ? { session } : {}), ...(device ? { device } : {}), ...(devices.cameras ? { devices: devices.cameras } : {}) };
    })(),
    studio: {
      ...(recorder.preview ? { preview: { live: recorder.preview.live } } : {}),
      showing: recorder.previewSessionId !== undefined && !pictureHidden(),
      ...(pictureHidden() ? { pictureHidden: true } : {}),
      ...(previewFailure ? { previewFailure } : {}),
    },
    ...(() => {
      const audio = recorder.audio;
      return audio ? { audioSession: { systemMuted: audio.systemMuted, ...(audio.microphone ? { microphone: audio.microphone } : {}),
        ...(audio.editable ? { editable: true as const } : {}) } } : {};
    })(),
    ...(recorder.editable === undefined ? {} : { editableSession: recorder.editable }),
    editableNext: editable.next(),
    audioVolume: settings.audioVolume,
    platform: process.platform,
    ...(mediaComponentsMissing ? { mediaComponentsMissing } : {}),
    outputDir: settings.outputDir,
    homeDir: os.homedir(),
    version: app.getVersion(),
    library: library.state,
    ...(() => { const editor = editing.view(); return editor ? { editor } : {}; })(),
    editedRecordings: editing.edited(),
    preparingVideos: sharing.videoStates(),
    shareStates: sharing.shareStates(),
    keptEdits: housekeeping.kept,
    versionCacheBytes: versionCache.size(),
    quality: quality(),
    countdown: countdownSeconds(),
    countdownSound: countdownSound(),
    language: settings.language,
    appearance: settings.appearance,
    trayClick: settings.trayClick,
    fileNameTemplate: settings.fileNameTemplate,
    libraryLayout: settings.libraryLayout,
    libraryPreviewSound: settings.libraryPreviewSound,
    studioPreview: settings.studioPreview,
    libraryFavorites: settings.libraryFavorites,
    ...(settings.libraryShown === undefined ? {} : { libraryShown: settings.libraryShown }),
    updates: { state: updates.state, enabled: settings.updates.enabled },
    notifications: settings.notifications,
    settingsShortcut: shortcuts.settingsStatus,
    hotkey: { ...settings.hotkey, registered: shortcuts.registered },
    ...(onboardingOpen ? { onboarding: { open: true as const } } : {}),
    ...quit.context(),
    ...savingContext(),
    ...(errorBoxHeld ? { errorBoxHeld } : {}),
  });
  // The Recording Studio's preview and meters (plan 075 step 7 and D19): joined to the session while the page shows
  // either, on a port of their own that main does not read (plan 081).
  const studioLink = new StudioLink<Electron.MessagePortMain>({
    session: () => recorder.previewSessionId,
    join: (sessionId, port) => host.joinStudio(sessionId, port),
    watch: (sessionId, feed, watching) => feed === "preview" ? host.watchPreview(sessionId, watching) : host.watchLevels(sessionId, watching),
    channel: () => new MessageChannelMain(),
    log,
  });
  // Settings' microphone monitor (plan 079): the device list followed, and the Input level read, between recordings.
  const microphoneMonitor = new MicrophoneMonitor({
    open: (onMessage, onExit) => host.openMonitor(onMessage, onExit),
    // While the microphone is on, whose input device it follows, and while recording too, where that device switches
    // the microphone (D3); with it off the picker waits, and no process runs for it.
    allowed: () => settings.microphone && !quitInProgress(),
    meterDevice: () => {
      const access = microphoneAccess();
      // The meter reads only between recordings: a recording's own levels are the Studio's.
      if (!preferencesUnlocked(recorder.state) || !settings.microphone || (access !== undefined && access !== "granted")) return undefined;
      const device = settings.microphoneDevice;
      return device ? { deviceId: device.id } : {};
    },
    devices: (listed) => devices.setMicrophones(listed),
    log,
  });
  const settingsWindow = new SettingsWindow({
    geometry: new SettingsWindowState(path.join(app.getPath("userData"), "settings-window.json"), log),
    cameraPreview: (page) => studioLink.watch("preview", page),
    levels: (page) => studioLink.watch("levels", page),
    microphoneLevel: (page) => microphoneMonitor.watch(page),
    monitor: (open) => microphoneMonitor.window(open),
    // A Live preview lasts while the Studio is open in sight (D20); a recording it became goes on.
    studio: (open) => { studioOpen = open; if (!open) recorder.stopPreview(); },
    state: () => recorder.state,
    context: appContext,
    act: handleAction,
    capture: armed => shortcuts.capture(armed),
    // While the window is open the Recordings tab follows the folder: a video deleted in Finder leaves at once.
    // The output folder's watch (plan 100) starts again too, if a folder away until now is back.
    activated: () => { library.watch(); void library.refresh(); devices.refresh(); folderWatch.start(); },
    quitRequested: quitInProgress,
    opened: () => appMenu.windowOpened(),
    closed: settingsGone,
    // In sharing's `during`: a drag of the card at its new path waits until its edit has followed it (plan 100).
    // The recording's edit and versions follow it in the library's own move (`beforeMove`, `afterMove`, plans 085 and
    // 100); a drag of the card at its new path waits in sharing's `during` until they have.
    rename: (id, name) => sharing.during(() => library.rename(id, name)),
    move: (id, folder) => sharing.during(() => library.move(id, folder)),
    edit: (id, choice) => editing.choose(id, choice),
    editPlayback: (id) => editing.playback(id),
    folders: {
      create: name => library.createFolder(name),
      // A category renamed or deleted here keeps or drops its favorite and the remembered choice with it (2026-10-09).
      rename: (folder, name) => sharing.during(async () => {
        const outcome = await library.renameFolder(folder, name);
        if ("folder" in outcome && outcome.folder !== folder) {
          // The edits and versions of its recordings followed them in the library's own move (`beforeMove`, `afterMove`).
          await settings.renameLibraryCategory(folder, outcome.folder).catch((cause: unknown) => log(`library: could not carry ${folder}'s favorite and choice to ${outcome.folder}: ${String(cause)}`));
        }
        return outcome;
      }),
      remove: async folder => {
        const outcome = await library.removeFolder(folder);
        if (outcome === true) await settings.forgetLibraryCategory(folder).catch((cause: unknown) => log(`library: could not forget ${folder}'s favorite and choice: ${String(cause)}`));
        return outcome;
      },
      show: async folder => {
        if (typeof folder === "string" && !library.state.folders?.some(entry => entry.name === folder)) return { problem: "missing" };
        try {
          await settings.setLibraryShown(folder);
          return true;
        } catch (cause) {
          log(`library: could not remember the category shown: ${String(cause)}`);
          return { problem: "failed" };
        }
      },
      favorite: async (folder, favorite) => {
        if (!library.state.folders?.some(entry => entry.name === folder)) return { problem: "missing" };
        try {
          await settings.setLibraryFavorite(folder, favorite);
          return true;
        } catch (cause) {
          log(`library: could not ${favorite ? "add" : "remove"} the favorite ${folder}: ${String(cause)}`);
          return { problem: "failed" };
        }
      },
    },
    // Plan 100: the drag gives the Video, what the card plays, and ⌥-drag the Original. A Video not ready yet is
    // prepared and the drag does not start (D1). Electron offers a drop outside the app a copy only, so a drop into a
    // Finder window on the same volume never moves the recording (drag_util_mac.mm).
    drag: async (contents, id, original) => {
      const file = library.find(id);
      if (!file) return false;
      let given: Awaited<ReturnType<typeof sharing.handOut>>;
      try {
        given = await sharing.handOut(file.path, original ? "original" : "video");
      } catch (cause) {
        log(`versions: no ${original ? "original" : "video"} of ${file.path} to drag: ${String(cause)}`);
        return { problem: "failed" as const };
      }
      if (!("file" in given)) return { problem: "preparing" in given ? "preparing" as const : "failed" as const };
      // macOS refuses a drag without an image: the thumbnail if one is made, else the file's own icon. Never one made
      // now: the drag must start while the pointer is still down.
      const jpeg = library.madeThumbnail(file);
      const icon = jpeg ? nativeImage.createFromBuffer(jpeg).resize({ width: 160 }) : await app.getFileIcon(file.path, { size: "normal" });
      contents.startDrag({ file: given.file, icon });
      return true;
    },
    // Share… (plan 100 step 3): its versions prepared as it opens, dragged together, copied as files or saved.
    share: async (contents, id, choice) => {
      const file = library.find(id);
      if (!file) return { problem: "failed" as const };
      const kinds = choice.kinds ?? ["video"];
      try {
        switch (choice.action) {
          case "open":
            await sharing.openShare(file.path);
            return true;
          case "drag": {
            // A drag needs its files now: every one ready, or none is dragged and the panel shows what is not.
            const given = await Promise.all(kinds.map(kind => sharing.handOut(file.path, kind)));
            const files = given.flatMap(entry => ("file" in entry ? [entry.file] : []));
            if (files.length !== kinds.length) return { problem: given.some(entry => "failed" in entry) ? "failed" as const : "preparing" as const };
            const jpeg = library.madeThumbnail(file);
            const icon = jpeg ? nativeImage.createFromBuffer(jpeg).resize({ width: 160 }) : await app.getFileIcon(files[0]!, { size: "normal" });
            contents.startDrag({ file: files[0]!, files, icon });
            return true;
          }
          case "copy": {
            // Waits for what is still being prepared, then gives files (Sources as their files, D7), as Finder's ⌘C.
            if (process.platform !== "darwin") return { problem: "failed" as const };
            const handed = await Promise.all(kinds.map(kind => sharing.whenReady(file.path, kind)));
            // Clones of their own, never the cache's links, which Finder's ⌘V would move away (plan 100 step 5).
            const files = await clipboardFiles(versionCache.root, (await Promise.all(handed.map(copiedFiles))).flat());
            // The pasteboard's own file types, as Finder's ⌘C writes them: the list of paths, and the first as a file URL.
            const raw = (format: string): string => `electron application/osclipboard;format="${format}"`;
            await clipboard.write([new ClipboardItem({
              [raw("NSFilenamesPboardType")]: new Blob([filesPropertyList(files)]),
              [raw("public.file-url")]: new Blob([pathToFileURL(files[0]!).href]),
            })]);
            log(`versions: copied ${files.length} file(s) of ${file.path}`);
            return true;
          }
          case "save": {
            focusApp();
            // The chooser's button says what it does, not macOS's Open (plan 100 step 6).
            const chosen = await dialog.showOpenDialog({ title: translate("Choose where to save", settings.language), buttonLabel: translate("Save Here", settings.language), properties: ["openDirectory", "createDirectory"] });
            const folder = chosen.canceled ? undefined : chosen.filePaths[0];
            if (!folder) return { problem: "cancelled" as const };
            const handed = await Promise.all(kinds.map(kind => sharing.whenReady(file.path, kind)));
            const written = await saveInto(folder, handed);
            log(`versions: saved ${written.join(", ")}`);
            return true;
          }
        }
      } catch (cause) {
        log(`versions: ${choice.action} of ${kinds.join("+")} of ${file.path} failed: ${String(cause)}`);
        return { problem: "failed" as const };
      }
    },
    // A failure's way out (plan 100): System Settings' Storage, RecordStuff's data folder, or its log.
    help: async (action) => {
      if (action === "revealLog") return revealLog();
      if (action === "revealData") { shell.showItemInFolder(editStore.folder); return true; }
      if (process.platform !== "darwin") return false;
      return shell.openExternal("x-apple.systempreferences:com.apple.settings.Storage").then(() => true, () => false);
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
      if (quitInProgress()) { log(`notification: show saved ${file} ignored while quitting`); return; }
      void showRecording(file).catch((cause: unknown) => log(`notification: show saved ${file} failed: ${stackOf(cause)}`));
    },
    permissionAction: () => {
      const state = recorder.state;
      runAction(state.type === "needsPermission" ? state.needsRelaunch ? "relaunch" : "openPermissionSettings" : "openSettings", "permission notification");
    },
    onAction: (action) => runAction(action, "tray"),
    log,
  });
  /**
   * A recording saved and ready to share (plan 100, D6). Finished while the next recording runs (a save in the
   * background, 2026-10-09): nothing interrupts a recording, so the banner is held until it ends, as the capture notices are.
   */
  function announceSaved(saved: string, stoppedEarly?: EarlyStop, videoFailed?: true): void {
    if (!preferencesUnlocked(recorder.state)) {
      captureNotices.hold(`saved ${saved}`, () => tray.notifySaved(saved, stoppedEarly, videoFailed));
      return;
    }
    savedNotification.schedule(saved, stoppedEarly, videoFailed);
  }
  /** The tray, the settings panel and the menu bar's Record menu project the same state; they move together. */
  function renderUi(state: RecordingState): void {
    // A recording, a Live preview or a save that began or ended paces the versions being prepared (plan 100).
    followCapture();
    sharing.resume();
    tray.render(state);
    settingsWindow.refresh();
    appMenu.refresh();
    studioLink.sync();
    microphoneMonitor.sync();
  }
  /** Context changed while the state did not (output folder, language, quality). */
  function refreshUi(): void {
    followPreview();
    followCapture();
    tray.refresh();
    settingsWindow.refresh();
    appMenu.refresh();
    // The microphone switched on or off, or its input changed, between recordings (plan 079, D1).
    microphoneMonitor.sync();
  }
  renderUi(recorder.state);
  /** The inputs that are on, listed with Settings closed too (plan 097); Settings lists them again as it comes forward. */
  const listInputsInUse = (): void => { void devices.refreshInUse({ microphone: settings.microphone, camera: settings.camera }); };
  listInputsInUse();
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

  /** The output folder being left, when its recordings' edits are to go with the change (plan 100). */
  let leavingFolder: string | undefined;
  const preferenceActions = createPreferenceActions({
    settled,
    chooseFolder: async () => {
      leavingFolder = undefined;
      focusApp();
      const result = await dialog.showOpenDialog({
        title: translate("Choose a recording folder", settings.language),
        defaultPath: settings.outputDir, properties: ["openDirectory", "createDirectory"],
      });
      const folder = result.canceled ? undefined : result.filePaths[0];
      if (!folder || isSameFolder(folder, settings.outputDir)) return folder;
      // Plan 100: what leaving the folder does to its recordings' edits and prepared videos, said before it happens,
      // when it holds any; its edits are kept unless the person asks for them to go.
      const old = settings.outputDir;
      const holds = [...editStore.records().keys(), ...versionCache.sources()].some(source => inOutputFolder(old, source));
      if (!holds) return folder;
      const language = settings.language;
      const { response } = await dialog.showMessageBox({
        type: "question",
        message: translate("Change the recording folder?", language),
        detail: [
          translate("Recordings in the current folder will no longer appear in the Recordings tab. The files themselves are not changed.", language),
          translate("Videos prepared for dragging out will be removed; they are made again when needed. Copies you saved and files you dragged out are not affected.", language),
          translate("Edits are kept, and apply again if you switch back to this folder. You can remove them in Settings → General → Kept edits.", language),
        ].join("\n\n"),
        buttons: [translate("Change Folder", language), translate("Change and Remove Old Edits", language), translate("Cancel", language)],
        defaultId: 0, cancelId: 2,
      });
      if (response === 2) return undefined;
      leavingFolder = response === 1 ? old : undefined;
      return folder;
    },
    saveFolder: folder => settings.setOutputDir(folder),
    focus: focusApp,
    folderChanged: () => {
      recorder.outputDirChanged();
      void library.refreshIfWatched();
      folderWatch.start();
      // The old folder's edits go only if that was asked for as it was left (plan 100); the rest is checked as usual.
      const leaving = leavingFolder;
      leavingFolder = undefined;
      void (leaving ? housekeeping.removeIn(leaving) : Promise.resolve()).then(() => housekeeping.run());
    },
    folderFailed: folder => tray.notifySettingsWriteFailed(folder),
    // Told once the recording ends: a banner now could be muted while the display is shared.
    folderRefused: folder => captureNotices.hold("output folder not changed", () => tray.notifyFolderRefused(folder)),
    refresh: refreshUi, log,
  });
  function changeOutputDir(): Promise<boolean> { return preferenceActions.changeOutputDir(); }
  const savePreference = preferenceActions.save;

  const savedNotification = new SavedNotification({
    platform: process.platform,
    show: (savedPath, stoppedEarly, videoFailed) => tray.notifySaved(savedPath, stoppedEarly, videoFailed),
    log,
  });
  const captureNotices = new CaptureNotices({ platform: process.platform, log });
  const permissionNotices = new PermissionNotices({
    permission: needsRelaunch => tray.notifyPermission(needsRelaunch),
    failure: code => captureNotices.hold(`recording failure ${code}`, () => tray.notifyRecordingFailure(code)),
  });
  const actionHandler = createActionHandler({
    studioOpen: () => studioOpen,
    onboarding: {
      open: () => { onboardingOpen = true; settingsWindow.show(); refreshUi(); },
      // Saved before it closes (review F3): a guide that could not be saved stays open, and the press says it failed.
      finish: async () => {
        try {
          if (!settings.onboardingDone) await settings.setOnboardingDone(true);
        } catch (cause) {
          log(`settings: saving the guide as done failed: ${String(cause)}`);
          return false;
        }
        onboardingOpen = false;
        refreshUi();
        return true;
      },
    },
    inputAccess: (input) => input === "microphone" ? microphoneAccess() : cameraAccess(),
    editableOnce: () => editable.chooseOnce(),
    studioPicture: (shown) => {
      pictureHiddenFor = shown || recorder.preview ? undefined : recorder.previewSessionId;
      log(`studio: the recording's picture ${pictureHidden() ? "hidden" : "shown"}`);
      refreshUi();
    },
    quitRequested: quitInProgress, settled, platform: process.platform, log, refresh: refreshUi,
    settings, recorder, library, recordingResults, tray, settingsWindow, shortcuts, updates, captureNotices, clearData,
    savePreference, changeOutputDir, openOutputDir, revealLog,
    removeKeptEdits: async () => {
      await housekeeping.removeKept();
      return true;
    },
    clearVersionCache: async () => {
      await versionCache.clear();
      settingsWindow.refresh();
      return true;
    },
    searchMicrophones: () => devices.search(),
    showLastRecording: () => showRecording(), hideSettings,
    displayPreferenceChanged: () => { displayMedia.failure = undefined; },
    applyAppearance: () => { nativeTheme.themeSource = settings.appearance; },
    quit: () => quitCoordinator.quit(),
    quitWithoutWaiting: () => {
      if (exitingWithoutSaves) return;
      if (!recorder.waitingOnlyForSaves) { log("quit without waiting: refused; recording work other than saves is pending"); return; }
      // Closed before anything is awaited, and never reopened: the flushes below take seconds.
      exitingWithoutSaves = true;
      refreshUi();
      log(`quit: without waiting for ${recorder.saving.length} save(s) in the background; their sentinels report them at the next launch`);
      // Each bounded: the drive the saves wait on may hold the file-system threads these writes need too.
      void (async () => {
        await flushBeforeExit({ flush: () => Promise.all([settings.flush(), settingsWindow.flush(), library.flushTrash(),
          recordingResults.flush(QUIT_METADATA_WAIT_MS)]).then(() => undefined) }, QUIT_METADATA_WAIT_MS);
        await flushBeforeExit(log);
        app.exit(0);
      })();
    },
    relaunch: () => quitCoordinator.relaunch(),
    openExternal: url => shell.openExternal(url),
    revealFile: file => shell.showItemInFolder(file),
    openScreenCaptureSettings, openNotificationSettings, openMicrophoneSettings, openOptionalFeatures,
    openCameraSettings: () => openCameraSettings(),
    askCameraAccess: async () => {
      const allowed = await askCameraAccess();
      // The default camera's name for the menu, now that the camera is on.
      void devices.refreshCameras();
      return allowed;
    },
    confirm: options => { focusApp(); return dialog.showMessageBox(options); },
    askMicrophoneAccess: async () => {
      const allowed = await askMicrophoneAccess();
      // The default input's name for the card, now that the microphone is on.
      void devices.refreshMicrophones();
      return allowed;
    },
    showInfo: async detail => {
      focusApp();
      await dialog.showMessageBox({ type: "info", title: APP_NAME, message: APP_NAME, detail });
    },
  });
  // A session keeps the display awake, so idle sleep cannot end its capture (plan 050).
  const keepAwake = new KeepAwake(powerSaveBlocker, log);
  /** The state before the one each event brings: a recording's start is the step out of waiting. */
  let lastState = recorder.state.type;
  recorder.subscribe((event) => {
    logSessionEvent(log, runId, event);
    switch (event.type) {
      case "state": {
        const before = lastState;
        lastState = event.state.type;
        // renderUi below draws the cleared line.
        quit.clearDeferred(false);
        // A recording starts, from the tray, the shortcut or the Studio itself: with the switch on, the Studio opens
        // without taking the keys from the app in use, showing the recording's picture (2026-10-28). Once per start, not
        // at each step.
        if (event.state.type === "starting" && (before === "idle" || before === "needsPermission") && settings.studioOnStart) {
          log("studio: opened without taking the keys as a recording starts");
          settingsWindow.showStudio(true);
        }
        // No input is listed while a session runs (plan 074): a listing still in flight ends now.
        if (!preferencesUnlocked(event.state)) host.cancelListing();
        // A Live preview's session is held in an idle state (D20): its process stays until the preview is let go of.
        // One recording made editable from the tray: it has ended, or it never started.
        if (event.state.type === "idle") editable.idle();
        // A recording ended: what the next one would open, said with the Studio closed (plan 097).
        if (event.state.type === "idle" && !recorder.preview) listInputsInUse();
        if (preferencesUnlocked(event.state) && !recorder.preview) {
          displayMedia.settle();
          host.destroy();
          // The recorder closes the overlay on every path; this is the safety net.
          overlay.close();
        }
        savedNotification.stateChanged(event.state);
        captureNotices.stateChanged(event.state);
        keepAwake.update(event.state, recorder.saving.length);
        log(`state → ${event.state.type}${event.state.type === "countdown" ? ` (${event.state.remaining})` : ""}`);
        renderUi(event.state);
        updates.flush();
        // A shortcut change saved during a session applies now that it is over.
        shortcuts.flush();
        permissionNotices.stateChanged(event.state);
        return;
      }
      case "saving":
        keepAwake.update(recorder.state, event.saving.length);
        refreshUi();
        return;
      case "savingSlow":
        // Told once the recording that may be running now has ended, as the other capture notices are.
        captureNotices.hold("save slow", () => tray.notifySavingSlow(event.dir));
        return;
      case "saved":
        void library.refreshIfWatched();
        // D2 and D6 (plan 100): an editable recording's Video is prepared once it is saved, so a drag has it, and the
        // notification says it is saved once it is ready to share, or that its Video could not be prepared.
        if (event.editable) {
          const { path: saved, stoppedEarly } = event;
          sharing.prepare(saved);
          void sharing.whenReady(saved, "video").then(
            () => announceSaved(saved, stoppedEarly),
            (cause: unknown) => {
              // Moved, deleted or the app quitting: nothing to announce of this path.
              if (!(cause instanceof VersionFailed)) { log(`notification: saved ${saved} not announced (${String(cause)})`); return; }
              announceSaved(saved, stoppedEarly, true);
            });
          return;
        }
        announceSaved(event.path, event.stoppedEarly);
        return;
      case "microphoneLost":
        // Told once the recording ends: a banner now could be muted while the display is shared (plan 074).
        captureNotices.hold("microphone lost", () => tray.notifyMicrophoneLost());
        return;
      case "cameraLost":
        // The same for the camera (plan 075, D12).
        captureNotices.hold("camera lost", () => tray.notifyCameraLost());
        return;
      case "cameraState":
        // What the Studio's preview says about the camera (plan 090).
        refreshUi();
        return;
      case "cameraNotReady":
        // Not a loss, told the same way (plan 090, D1).
        captureNotices.hold("camera not ready", () => tray.notifyCameraNotReady());
        return;
      case "displayFailed":
        displayMedia.failure = event.detail;
        refreshUi();
        return;
      case "preview":
        // The Studio says why a Live preview could not start until the next one begins (plan 075, D20).
        if (event.failure) previewFailure = event.failure.code;
        else if (recorder.preview) previewFailure = undefined;
        refreshUi();
        return;
      case "captureStarted":
        displayMedia.failure = undefined;
        refreshUi();
        return;
      case "health":
        governor.sample(event.health);
        return;
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
  // Serious or critical heat holds the versions being prepared (plan 100 step 4); macOS says it, other systems do not.
  const onThermal = ({ state }: { state: Conditions["thermal"] }): void => governor.update({ thermal: state });
  if (process.platform === "darwin") {
    governor.update({ thermal: powerMonitor.getCurrentThermalState() });
    powerMonitor.on("thermal-state-change", onThermal);
  }

  // The microphone and the camera are on by default (2026-10-26), and macOS is asked for them only at the user's own
  // press (the first-launch guide, or a switch turned on): at launch one it refused earlier is turned off, asking
  // nothing. Autorecord keeps its own configuration.
  if (!autoRecord?.ok) {
    // Locked while recording: the refused input is left out of it all the same, and the next launch turns it off.
    const turnedOff = (save: () => Promise<void>) => async (): Promise<boolean> => {
      if (!preferencesUnlocked(recorder.state)) return false;
      await save();
      refreshUi();
      return true;
    };
    void settleInputAccess([
      { name: "microphone", enabled: () => settings.microphone, status: () => microphoneAccess(), turnOff: turnedOff(() => settings.setMicrophone(false)) },
      { name: "camera", enabled: () => settings.camera && cameraAvailable(), status: () => cameraAccess(), turnOff: turnedOff(() => settings.setCamera(false)) },
    ], log);
  }
  // A new install meets the guide in the main window, as nothing else shows at launch for a menu bar app.
  if (onboardingOpen) settingsWindow.show();
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
      // A version being prepared, then an export, are cancelled and their unfinished files removed, within the worker's
      // cancel bound (plans 100 and 085).
      await sharing.shutdown();
      await editing.shutdown();
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
        // The versions prepared for sharing (plan 100), which can all be made again.
        caches: [versionCache.root],
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
  reopen = watchReopen({ events: app, platform: process.platform, open: () => handleAction("openSettings"), log, now: () => performance.now(), early: earlyReopens });

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
    powerMonitor.removeListener("thermal-state-change", onThermal);
    followLowPower(true);
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
