/**
 * What every `AppAction` does (docs/system-design/desktop.md). The tray, the settings panel, the application
 * menu, notifications and the Settings shortcut all end here, so the quit gate and each preference's lock are
 * decided in one place. `index.ts` builds the collaborators and passes them in; this module creates none.
 */
import fs from "node:fs/promises";
import type { MessageBoxOptions } from "electron";
import type { AppAction } from "../app/ui-model";
import type { CaptureNotices } from "../recording/capture-notices";
import type { DataCleanupRequest } from "../app/data-cleanup-request";
import type { AppShortcuts } from "../shortcuts/shortcuts";
import type { AppTray } from "../menus/tray";
import type { PreferenceSave } from "../settings/preferences";
import type { Recorder } from "../recording/recorder";
import type { RecordingResults } from "../recording/recording-result";
import type { RecordingsLibrary } from "../library/recordings-library";
import type { SettingsStore } from "../settings/settings";
import type { SettingsWindow } from "../settings/settings-window";
import { RELEASES_URL, SOURCE_URL, WEBSITE_URL, downloadPageUrl, type UpdateChecker } from "../app/updates";
import { translate } from "../../shared/i18n";

export interface ActionDeps {
  /** A quit is running: every action but quit is refused until it exits or is declined. */
  quitRequested(): boolean;
  /** Whether the Recording Studio is open in a window in sight (plan 075, D20), which a Live preview lasts as long as. */
  studioOpen?(): boolean;
  /** Shows or hides the recording's picture in the Recording Studio while it records (2026-10-21). */
  studioPicture?(shown: boolean): void;
  /** Makes the next recording editable though the setting is off (2026-10-25): until it ends or does not start. */
  editableOnce?(): void;
  /** Nothing is recording or quitting (`preferencesUnlocked`), so a session-touching change may apply. */
  settled(): boolean;
  platform: NodeJS.Platform;
  log(line: string): void;
  /** Redraw the tray, the settings panel and the application menu after a context change. */
  refresh(): void;
  settings: Pick<SettingsStore, "language" | "display" | "setDisplay" | "hideSystemUi" | "setHideSystemUi" | "editableRecording" | "setEditableRecording" | "setUpdates" | "notifications" | "setNotifications"
    | "trayClick" | "setTrayClick" | "fileNameTemplate" | "setFileNameTemplate" | "setLibraryLayout" | "setLibraryPreviewSound" | "setStudioPreview" | "setAppearance"
    | "studioPreview" | "setLanguage" | "countdown" | "setCountdown" | "countdownSound" | "setCountdownSound" | "quality" | "setQuality"
    | "microphone" | "setMicrophone" | "microphoneDevice" | "setMicrophoneDevice" | "camera" | "setCamera"
    | "cameraDevice" | "setCameraDevice" | "cameraLayout" | "setCameraLayout" | "setCameraPosition"
    | "audioVolume" | "setAudioVolume">;
  recorder: Pick<Recorder, "state" | "startIfIdle" | "stop" | "cancelCountdown" | "mediaPending" | "updateCamera" | "updateAudio" | "updateGains" | "updateMicrophone"
    | "audio" | "startPreview" | "stopPreview">;
  /** Lists the audio inputs again at once (plan 079, D2); resolves once they are listed or could not be. */
  searchMicrophones?(): Promise<void>;
  library: Pick<RecordingsLibrary, "act" | "undoTrash">;
  recordingResults: Pick<RecordingResults, "act" | "historyFailed" | "resetHistory">;
  tray: Pick<AppTray, "notifyDisplayWriteFailed" | "notifyNotificationsEnabled" | "notifyLanguageWriteFailed"
    | "notifyQualityWriteFailed" | "notifyAnswer" | "notifyMicrophoneDenied" | "notifyCameraDenied">;
  settingsWindow: Pick<SettingsWindow, "show" | "showRecordingResult" | "showShortcut" | "showShortcutList" | "showRecording" | "showStudio">;
  shortcuts: Pick<AppShortcuts, "set" | "retry">;
  updates: Pick<UpdateChecker, "check" | "state">;
  captureNotices: Pick<CaptureNotices, "hold">;
  clearData: Pick<DataCleanupRequest, "request">;
  /** Saves one preference under its lock (settings/preferences.ts `save`). */
  savePreference(what: string, save: PreferenceSave): Promise<void>;
  changeOutputDir(): Promise<boolean>;
  openOutputDir(): Promise<boolean>;
  revealLog(): Promise<boolean>;
  /** The Recordings tab with the newest recording in view. */
  showLastRecording(): Promise<void>;
  /** The same hide path as the application menu: release capture, pause playback and hide the Dock icon. */
  hideSettings(): void;
  /** The display preference changed: the last screen's failure no longer describes the next one. */
  displayPreferenceChanged(): void;
  /** Applies the saved appearance to the native theme. */
  applyAppearance(): void;
  quit(): void;
  /** Exits now when only saves in the background hold the quit; their sentinels report them at the next launch. */
  quitWithoutWaiting(): void;
  relaunch(): void;
  openExternal(url: string): Promise<void>;
  revealFile(file: string): void;
  openScreenCaptureSettings(): Promise<void>;
  openNotificationSettings(): Promise<void>;
  /** System Settings → Privacy & Security → Microphone (plan 074). */
  openMicrophoneSettings(): Promise<void>;
  /** The camera's privacy page, on macOS and Windows (plan 075). */
  openCameraSettings(): Promise<void>;
  openOptionalFeatures(): Promise<void>;
  /**
   * Asks macOS for the microphone when it never has (plan 074): the prompt then follows the user's own click. Answers
   * whether access is allowed now; Windows, which has no prompt, answers true.
   */
  askMicrophoneAccess(): Promise<boolean>;
  /** The same for the camera (plan 075). */
  askCameraAccess(): Promise<boolean>;
  /** A windowless informational box, brought forward first. */
  showInfo(detail: string): Promise<void>;
  /** A warning with Cancel first and the named action second, brought forward first; answers the button pressed. */
  confirm(options: MessageBoxOptions): Promise<{ response: number }>;
}

export type ActionHandler = (action: AppAction) => Promise<boolean | void>;

export function createActionHandler(deps: ActionDeps): ActionHandler {
  const { settings, recorder, library, tray, log } = deps;

  async function setPreference(action: Exclude<AppAction, string | { recordingFile: unknown } | { recordingResult: unknown }>): Promise<void> {
    if ("setDisplay" in action) {
      const before = JSON.stringify(settings.display);
      await deps.savePreference("display", {
        locked: true,
        write: () => settings.setDisplay(action.setDisplay),
        applied: () => {
          // What the last recording on another screen ran into is no longer what the next one will.
          if (JSON.stringify(settings.display) !== before) deps.displayPreferenceChanged();
          log(`settings: display ${JSON.stringify(settings.display)}`);
        },
        notifyFailure: () => tray.notifyDisplayWriteFailed(),
      });
    } else if ("setHideSystemUi" in action) {
      // Only ScreenCaptureKit can leave the system's chrome out; Windows shows the switch unavailable (D6).
      if (deps.platform !== "darwin") return;
      await deps.savePreference("hide system UI", {
        locked: true,
        write: () => settings.setHideSystemUi(action.setHideSystemUi),
        applied: () => log(`settings: hide menu bar and Dock ${settings.hideSystemUi ? "on" : "off"}`),
      });
    } else if ("setEditableRecording" in action) {
      // The engine records editable files on macOS only (plan 087); Windows shows the switch unavailable.
      if (deps.platform !== "darwin") return;
      await deps.savePreference("editable recording", {
        locked: true,
        write: () => settings.setEditableRecording(action.setEditableRecording),
        applied: () => log(`settings: editable recordings ${settings.editableRecording ? "on" : "off"}`),
      });
    } else if ("setMicrophone" in action) {
      const turningOn = action.setMicrophone && !settings.microphone;
      await deps.savePreference("microphone", {
        locked: true,
        write: () => settings.setMicrophone(action.setMicrophone),
        applied: () => log(`settings: microphone ${settings.microphone ? "on" : "off"}`),
      });
      // Saved even when refused: Settings then shows the denial with the pane that changes it (plan 074).
      if (turningOn && settings.microphone && !(await deps.askMicrophoneAccess())) {
        log("settings: microphone access is not allowed");
        tray.notifyMicrophoneDenied();
      }
      deps.refresh();
    } else if ("setCamera" in action) {
      const turningOn = action.setCamera && !settings.camera;
      await deps.savePreference("camera", {
        locked: true,
        write: () => settings.setCamera(action.setCamera),
        applied: () => log(`settings: camera ${settings.camera ? "on" : "off"}`),
      });
      // Saved even when refused, as the microphone: Settings shows the denial with the pane that changes it.
      if (turningOn && settings.camera && !(await deps.askCameraAccess())) {
        log("settings: camera access is not allowed");
        tray.notifyCameraDenied();
      }
      deps.refresh();
    } else if ("setCameraDevice" in action) {
      await deps.savePreference("camera device", {
        locked: true,
        write: () => settings.setCameraDevice(action.setCameraDevice),
        applied: () => log(`settings: camera device ${settings.cameraDevice ? settings.cameraDevice.id : "system default"}`),
      });
    } else if ("setCameraShape" in action) {
      // Not locked while recording (D7): the recording takes the new bubble from its next frame on.
      const current = settings.cameraLayout;
      const next = { ...current, ...action.setCameraShape };
      await deps.savePreference("camera shape", {
        write: () => settings.setCameraLayout({ width: next.width, height: next.height, rounding: next.rounding, mirror: next.mirror }),
        applied: () => {
          const saved = settings.cameraLayout;
          log(`settings: camera ${Math.round(saved.width * 100)}% × ${Math.round(saved.height * 100)}%, rounding ${Math.round(saved.rounding * 100)}%, mirror ${saved.mirror ? "on" : "off"}`);
          recorder.updateCamera({ layout: saved });
        },
      });
    } else if ("setCameraPosition" in action) {
      // Not locked while recording (D7), as the shape: the recording takes it from its next frame on.
      const { display, x, y } = action.setCameraPosition;
      await deps.savePreference("camera position", {
        write: () => settings.setCameraPosition(display, { x, y }),
        applied: () => {
          const saved = settings.cameraLayout;
          log(`settings: camera at ${Math.round(x * 100)}%, ${Math.round(y * 100)}% on display ${display}`);
          recorder.updateCamera({ layout: saved });
        },
      });
    } else if ("setAudioMuted" in action) {
      // The recording's own choice (D19), as hiding the camera: the next recording starts unmuted.
      const { source, muted } = action.setAudioMuted;
      // Judged as the switch is, by the muting now in force.
      if (!recorder.updateAudio({ [source]: muted })) log(`audio: no recording to mute or unmute ${source === "system" ? "system audio" : "the microphone"} in`);
      deps.refresh();
    } else if ("setAudioVolume" in action) {
      // A setting, not locked while recording (D21), as the bubble's shape: taken from the input's next sound on.
      const { source, volume } = action.setAudioVolume;
      await deps.savePreference(source === "system" ? "system audio volume" : "microphone volume", {
        write: () => settings.setAudioVolume(source, volume),
        applied: () => {
          const saved = settings.audioVolume;
          log(`settings: volume system ${saved.system}%, microphone ${saved.microphone}%`);
          recorder.updateGains();
        },
      });
    } else if ("setCameraHidden" in action) {
      // The recording's own choice (D13), not a setting: the next recording shows the camera again.
      if (!recorder.updateCamera({ hidden: action.setCameraHidden })) log("camera: no recording composes the camera to hide or show");
      deps.refresh();
    } else if ("setMicrophoneDevice" in action) {
      // Not locked while a recording records the microphone (plan 079, D3): it switches to the device chosen.
      await deps.savePreference("microphone device", {
        locked: recorder.audio?.microphone === undefined,
        write: () => settings.setMicrophoneDevice(action.setMicrophoneDevice),
        applied: () => {
          log(`settings: microphone device ${settings.microphoneDevice ? JSON.stringify(settings.microphoneDevice) : "system default"}`);
          recorder.updateMicrophone();
        },
      });
    } else if ("setUpdateChecks" in action) {
      await deps.savePreference("update checks", { locked: true, write: () => settings.setUpdates({ enabled: action.setUpdateChecks }) });
    } else if ("setNotifications" in action) {
      const turningOn = action.setNotifications && !settings.notifications;
      await deps.savePreference("notifications", { locked: true, write: () => settings.setNotifications(action.setNotifications) });
      // Electron asks macOS for authorization inside `show()`, so turning the
      // switch on is the one moment the system prompt can appear at the
      // user's own request. The confirmation doubles as the delivery test.
      if (turningOn && settings.notifications) tray.notifyNotificationsEnabled();
    } else if ("setTrayClick" in action) {
      // A click mid-recording follows the new choice at once; nothing a session holds depends on it.
      await deps.savePreference("tray click", {
        write: () => settings.setTrayClick(action.setTrayClick),
        applied: () => log(`settings: tray click ${settings.trayClick}`),
      });
    } else if ("setFileNameTemplate" in action) {
      // The next recording is named by it; a session in progress already named its file.
      await deps.savePreference("file name", {
        locked: true,
        write: () => settings.setFileNameTemplate(action.setFileNameTemplate),
        applied: () => log(`settings: file name ${JSON.stringify(settings.fileNameTemplate)}`),
      });
    } else if ("setLibraryLayout" in action) {
      await deps.savePreference("library layout", { write: () => settings.setLibraryLayout(action.setLibraryLayout) });
    } else if ("setLibraryPreviewSound" in action) {
      await deps.savePreference("library preview sound", { write: () => settings.setLibraryPreviewSound(action.setLibraryPreviewSound) });
    } else if ("setStudioPreview" in action) {
      // The Studio's page reads it from the view and tells its capture process the rate and view (plan 092).
      await deps.savePreference("Studio preview", {
        write: () => settings.setStudioPreview(action.setStudioPreview),
        applied: () => log(`settings: Studio preview ${JSON.stringify(settings.studioPreview)}`),
      });
    } else if ("setAppearance" in action) {
      await deps.savePreference("appearance", {
        write: () => settings.setAppearance(action.setAppearance),
        applied: () => deps.applyAppearance(),
      });
    } else if ("setLanguage" in action) {
      await deps.savePreference("language", {
        write: () => settings.setLanguage(action.setLanguage),
        notifyFailure: () => tray.notifyLanguageWriteFailed(),
      });
    } else if ("setHotkey" in action) {
      await deps.shortcuts.set(action.setHotkey);
    } else if ("setCountdown" in action) {
      await deps.savePreference("countdown", {
        locked: true,
        write: () => settings.setCountdown(action.setCountdown),
        applied: () => log(`settings: countdown ${settings.countdown} s`),
      });
    } else if ("setCountdownSound" in action) {
      await deps.savePreference("countdown sound", {
        locked: true,
        write: () => settings.setCountdownSound(action.setCountdownSound),
        applied: () => log(`settings: countdown sound ${settings.countdownSound ? "on" : "off"}`),
      });
    } else {
      await deps.savePreference("quality", {
        locked: true,
        write: () => settings.setQuality(action.setQuality),
        applied: () => {
          log(`settings: quality ${JSON.stringify(settings.quality)}`);
        },
        notifyFailure: () => tray.notifyQualityWriteFailed(),
      });
    }
  }

  async function handleAction(action: AppAction): Promise<boolean | void> {
    if (deps.quitRequested() && action !== "quit" && action !== "quitWithoutWaiting") return false;
    if (typeof action !== "string" && "recordingFile" in action) {
      const { id, action: verb } = action.recordingFile;
      // A drag belongs to the window it starts in (settings-window.ts).
      return verb === "drag" ? false : library.act(id, verb);
    }
    if (action === "undoTrash") return library.undoTrash();
    if (typeof action !== "string" && "recordingResult" in action) {
      const request = action.recordingResult;
      return deps.recordingResults.act(request.id, request.action, {
        stat: file => fs.stat(file), refresh: deps.refresh, settled: deps.settled, platform: deps.platform,
        reveal: deps.revealFile, folder: async () => { await deps.changeOutputDir(); },
        permission: async () => { await handleAction("openPermissionSettings"); },
        relaunch: async () => { await handleAction("relaunch"); },
        needsRelaunch: () => recorder.state.type === "needsPermission" && recorder.state.needsRelaunch,
      });
    }
    if (typeof action !== "string") {
      await setPreference(action);
      return;
    }
    switch (action) {
      case "openRecordingResult":
        deps.settingsWindow.showRecordingResult();
        return;
      case "openShortcutSettings":
        deps.settingsWindow.showShortcut();
        return;
      case "openShortcutList":
        deps.settingsWindow.showShortcutList();
        return;
      case "openRecordingSettings":
        deps.settingsWindow.showRecording();
        return;
      case "openStudio":
        deps.settingsWindow.showStudio();
        return true;
      case "openSettings":
        deps.settingsWindow.show();
        return;
      case "hideSettings":
        deps.hideSettings();
        return true;
      case "showLastRecording":
        await deps.showLastRecording();
        return;
      case "retryShortcuts":
        return deps.shortcuts.retry();
      case "checkUpdates":
        // Not awaited: the check can wait on two network timeouts, and the
        // panel's save queue and its controls must not wait with it. The
        // checker's state changes push the button's own progress.
        void deps.updates.check(true);
        return true;
      case "openWebsite":
      case "openSource":
        try {
          await deps.openExternal(action === "openWebsite" ? WEBSITE_URL : SOURCE_URL);
          return true;
        } catch (error) { log(`settings: external link failed: ${String(error)}`); return false; }
      case "openUpdate":
        // Recording locks the button; a click that raced the lock opened nothing, which is not a failure.
        if (!deps.settled()) return true;
        try {
          await deps.openExternal(deps.updates.state.kind === "available" ? downloadPageUrl(deps.platform) : RELEASES_URL);
          return true;
        } catch (error) { log(`settings: update link failed: ${String(error)}`); return false; }
      case "startPreview":
        // Asked from a Studio that has since closed (a choice queued behind a save): nothing to show it in.
        if (deps.studioOpen && !deps.studioOpen()) log("studio: Live preview not started: the Studio is no longer open");
        else if (!recorder.startPreview()) log(`studio: Live preview not started in state ${recorder.state.type}`);
        return true;
      case "stopPreview":
        recorder.stopPreview();
        return true;
      case "showStudioPicture":
      case "hideStudioPicture":
        deps.studioPicture?.(action === "showStudioPicture");
        return true;
      case "start":
        // An open macOS menu cannot change, so a Start chosen late is resolved now: only idle starts (plan 048).
        if (!recorder.startIfIdle()) log(`tray: Start recording ignored in state ${recorder.state.type}`);
        // Done either way: the Recording Studio's button (D19) shows the state that follows, not a failure.
        return true;
      case "startEditable":
        if (recorder.state.type !== "idle") {
          log(`tray: Start editable recording ignored in state ${recorder.state.type}`);
          return true;
        }
        deps.editableOnce?.();
        recorder.startIfIdle();
        return true;
      case "stop":
        recorder.stop();
        return true;
      case "cancelCountdown":
        recorder.cancelCountdown("menu");
        return true;
      case "quitWithoutWaiting":
        deps.quitWithoutWaiting();
        return true;
      case "quit":
        // A request, as Relaunch is: a quit deferred for a save or refused says so itself. Settings' Quit has no
        // checked value to compare, so without this answer it read as a failed link (settings-window.ts `apply`).
        deps.quit();
        return true;
      case "clearAppData":
        return deps.clearData.request();
      case "resetFailureHistory": {
        if (!deps.recordingResults.historyFailed) return false;
        const language = settings.language;
        const answer = await deps.confirm({
          type: "warning", title: translate("Reset failure history?", language), message: translate("Reset failure history?", language),
          detail: translate("The failure history that could not be read is kept as a backup beside it, and an empty one replaces it so new failures can be saved. Recordings are kept.", language),
          buttons: [translate("Cancel", language), translate("Reset failure history", language)], defaultId: 0, cancelId: 0, noLink: true,
        });
        // Cancelling is a successful no-op, as for clearing app data.
        if (answer.response !== 1) return true;
        const reset = await deps.recordingResults.resetHistory();
        deps.refresh();
        return reset;
      }
      // A pressed button that opens nothing must say so: this state blocks
      // recording entirely, and the tray menu is its only route.
      case "openPermissionSettings":
        try { await deps.openScreenCaptureSettings(); }
        catch (cause) {
          log(`permission: open settings failed: ${String(cause)}`);
          const detail = translate("Could not open System Settings. Allow RecordStuff in System Settings → Privacy & Security → Screen & System Audio Recording.", settings.language);
          // A windowless warning would hold the failed session's cleanup until answered (plan 056).
          if (recorder.mediaPending) {
            log("permission: recording work is pending; telling the problem in a notification instead of a warning");
            deps.captureNotices.hold("permission settings warning", () => tray.notifyAnswer(detail));
            return;
          }
          await deps.showInfo(detail);
        }
        return;
      // An actions choice has no committed value to compare, so it reports its
      // own outcome: a refused pane leaves the note's manual path as recovery.
      case "openNotificationSettings":
        try { await deps.openNotificationSettings(); return true; }
        catch (error) { log(`notifications: open settings failed: ${String(error)}`); return false; }
      case "openOptionalFeatures":
        if (deps.platform !== "win32") return false;
        try { await deps.openOptionalFeatures(); return true; }
        catch (error) { log(`media components: open Optional features failed: ${String(error)}`); return false; }
      case "openMicrophoneSettings":
        if (deps.platform !== "darwin") return false;
        try { await deps.openMicrophoneSettings(); return true; }
        catch (error) { log(`microphone: open settings failed: ${String(error)}`); return false; }
      // Requests whose progress the page shows itself (the button reads Searching…, a postponed relaunch says why), so
      // they answer at once: undefined would read as a choice that did not apply, and a search held the panel's
      // queue for up to the listing's bound.
      case "searchMicrophones":
        void deps.searchMicrophones?.().catch((error: unknown) => log(`microphone: search failed: ${String(error)}`));
        return true;
      case "openCameraSettings":
        if (deps.platform !== "darwin" && deps.platform !== "win32") return false;
        try { await deps.openCameraSettings(); return true; }
        catch (error) { log(`camera: open settings failed: ${String(error)}`); return false; }
      case "relaunch":
        deps.relaunch();
        return true;
      // Settings → General → Log file reads the outcome (2026-10-04); the log moved there from the tray.
      case "revealLog":
        return deps.revealLog();
      // Explicit outcomes: the Settings row reads them (plan 048 review); the tray ignores them.
      case "openOutputDir":
        // A failure the opener warned about itself answers true, so the row adds no second message; one only held
        // for a notice until the recording ends answers false, and the row says it failed now.
        return deps.openOutputDir();
      case "changeOutputDir":
        return deps.changeOutputDir();
    }
  }

  return handleAction;
}
