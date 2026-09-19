# Desktop Features

[English](desktop.md) | [繁體中文](../zh-TW/system-design/desktop.md)

## Tray and notifications

Sources: [tray-model.ts](../../src/main/tray-model.ts), [tray.ts](../../src/main/tray.ts), [index.ts](../../src/main/index.ts).

TrayModel is a pure projection containing icon, title, tooltip, and a recursive menu. AppTray maps it to Electron without a separate business state machine. Left-click toggles recording; right-click builds the menu from current state and settings. It does not use setContextMenu, which would change left-click behavior on macOS. The [global shortcut](#recording-shortcut) calls the same toggle as the left click.

| State | Icon/title | Actions |
| --- | --- | --- |
| needsPermission | Idle/empty | Permission guidance, settings/relaunch, output folder, quality and shortcut |
| idle | Idle/empty | Ready or folder unavailable; reveal last recording when its path exists in state; output folder, quality and shortcut |
| starting | Idle/`…` | Permission-prompt guidance; quality and shortcut locked |
| recording | Recording/`REC` | Stop (tooltip names the shortcut when registered); output folder, quality and shortcut locked |
| stopping | Idle/`…` | Saving; quality and shortcut locked |

Every state offers Language, Show log, and Quit. macOS uses template PNG/@2x assets and a title; Windows branches use ICO assets. REC may appear in full-display recordings; this is an accepted visibility tradeoff.

Pure functions generate localized notification text. Native notifications are silent. Saved/partial-file notifications reveal the file. Without a partial file, output-open failure opens folder selection, permission denial opens System Settings, and a relaunch error invokes relaunch. Quality/language save failures and frame-rate downgrade notifications are informational.

On macOS, a notification click does two things: it delivers the response to the app and asks the system to activate the notifying app, and the activation lands about 110 ms after the click callback. The reveal runs in setImmediate and asks Finder to select the file at once; when the system then makes the windowless app active, Finder is pushed back behind the user's previous window and nothing visible happens (the v0.1.0 report; on macOS 26.6 it hit about one click in three, rarely the first click of a process). Plan 014 therefore arms a one-shot `did-become-active` listener for `ACTIVATION_WINDOW_MS` (1 s) after the reveal: when the activation arrives inside that window, the file is revealed again from the now-active app so Finder's activation lands last. Logs distinguish `reveal requested`, `reveal repeated after activation` and `reveal failed`. Only the click arms the listener; a save in the background never touches Finder. Unsupported notifications and failed events are logged. OS notification preferences still decide whether a banner is visible. Native evidence is recorded by `pnpm acceptance:notification` ([tooling](tooling.md#notification-acceptance)). The notification icon was confirmed normal after the user's reboot on 2026-09-14.

## Recording shortcut

Sources: [hotkey.ts](../../src/main/hotkey.ts), [shared/hotkey.ts](../../src/shared/hotkey.ts), [index.ts](../../src/main/index.ts). Plan 016 added a global start/stop shortcut so recording can be toggled while another app is frontmost and so unattended acceptance has a system-level entry point on a process with no window.

RecordingHotkey wraps Electron `globalShortcut`. A press calls the same `toggle` function as a tray left click, so `Recorder.toggle()` remains the only decision point: it starts when idle, stops when recording, re-issues the permission notification in needsPermission, and ignores presses while starting or stopping. Every press is logged as `hotkey: <accelerator> pressed` before the toggle. `apply(settings)` releases the previous registration before registering the new one, so a change never leaves two combinations active; `dispose()` runs on will-quit.

The user chooses one of three presets or Off from the tray's **Shortcut** submenu (idle/needsPermission only, like quality). The default is `CommandOrControl+Alt+Shift+R` (⌘⌥⇧R on macOS, Ctrl+Alt+Shift+R elsewhere). The plan proposed ⌘⇧R; the conflict check on 2026-09-19 found it bound to hard reload in Chrome and Firefox, Reader in Safari and local recording in Zoom, and a global shortcut takes precedence over the frontmost app, so a browser user would start a screen recording by accident. The three-modifier default was unbound in Chrome, Safari, Firefox, Finder, Xcode, VS Code, Slack and Zoom; ⌘⇧R and ⌘⌥R remain presets. A free-form shortcut recorder is out of scope.

A registration the OS refuses (another app owns the combination, or `register` throws) is never silent: it is logged as `hotkey: registration failed for …`, shown in the menu label as "Shortcut unavailable (in use by another app): …", and announced by a notification. The setting is still saved so the user's choice survives a relaunch; the tray keeps working. Disabling the shortcut leaves tray behavior unchanged and remembers the accelerator so re-enabling restores it. Changing the shortcut persists first and registers second: a failed write keeps the old registration and reports "Could not save the shortcut". If a recording starts while that write is pending, the registration change is deferred (`request` → `flush` on the next settled state) so the combination that started the session can still stop it; until then the menu shows the saved choice as unavailable.

## Language

Source: [i18n.ts](../../src/shared/i18n.ts). English (`en`) is the default, including upgrades from settings files without a language field. The user can choose English or Traditional Chinese (`zh-TW`) from the Language submenu. There is no implicit OS-locale selection.

English source messages are typed catalog keys; ZH_TW supplies each translation. Translate selects a template and substitutes named placeholders. The model receives language through TrayContext. Notifications read the current context when created; existing OS notifications are not rewritten retroactively.

A language action serializes a settings save, switches the in-memory language only after success, and refreshes the tray. Failure preserves the old language and reports the failure in that language. Switching during recording changes presentation only; recording state, source, output location, and quality snapshot are unaffected.

Menu labels, tooltips, permission guidance, folder dialog title, application error summaries, and notifications are localized. Diagnostic details and developer tool output remain English. Technical failure details remain in the log rather than appearing as untranslated fragments in Chinese error notifications. Native OS permission dialogs follow macOS language settings, not the app's selector.

## Screen permission

Source: [permission.ts](../../src/main/permission.ts). PermissionWatcher is created only on macOS.

1. Check getMediaAccessStatus('screen') every five seconds and on activate. A windowless app cannot rely on activate alone.
2. If not granted, clear validation, emit needsPermission, and call getSources at most once per process to register the app/show the system prompt.
3. If granted but unvalidated, require at least one capturable screen within four seconds.
4. Cache success; failure requires relaunch and is retried on later polls. A validating flag prevents overlapping checks.
5. An actual permission-denied capture can clear the cache through markRelaunchRequired. Revocation also clears it.

Only changed permission states are emitted. Recorder applies them only while idle/needsPermission; polling does not directly interrupt a running session. Actual track termination, capture failure, or an OS-requested quit follows the recording cleanup path.

System Settings opens through a fixed ScreenCapture URL. The app does not reset TCC. The missing-permission menu always offers relaunch because the running process may not observe a new grant. System audio has its own permission and is validated through returned audio tracks. See the [verification record](../verification/README.md) for first-grant, denial, recovery, and revocation evidence.

## Settings and output folder

Sources: [settings.ts](../../src/main/settings.ts), [quality.ts](../../src/shared/quality.ts).

```json
{
  "version": 3,
  "outputDir": "/Users/example/Movies/RecordStuff",
  "quality": { "videoQuality": "standard", "resolutionCap": "source", "frameRate": 30 },
  "language": "en",
  "hotkey": { "enabled": true, "accelerator": "CommandOrControl+Alt+Shift+R" }
}
```

OutputDir must be a nonempty absolute path. Version 1 loads with default quality, version 1 and 2 load with the default shortcut (each logged as a warning), and both are written as version 3 on the next save. The additive language field is optional on disk for older files; it defaults to English. Unsupported language values default to English with a warning, preserving valid folder/quality settings. `hotkey.accelerator` must be one of the presets in shared/hotkey.ts; a missing or unsupported hotkey block in a v3 file falls back to the default shortcut with a warning and keeps the other fields. Unsupported versions or invalid folder data fall back to defaults; an invalid quality block alone does not discard a valid folder. Obsolete audioQuality fields are ignored.

Save operations are serialized and derive each update from the last committed settings. Write settings.json.tmp, rename it, then update memory. A failed save rejects its caller without blocking later saves. This avoids half-written JSON but does not promise power-loss durability through directory fsync.

Folder selection uses a native dialog, with app focus on macOS. A successful save clears the idle folder-unavailable flag and refreshes labels. Actual writability is probed when recording starts. There is no automatic fallback to a different output folder.

Quality and the shortcut can change only while idle/needsPermission, and each recording has a quality snapshot. Platform frame-rate clamping affects effective settings, not persisted preferences.

## Logs

Source: [log.ts](../../src/main/log.ts). Current macOS paths are `~/Library/Logs/recordstuff/recordstuff.log` and `~/Library/Application Support/recordstuff/settings.json`. Electron's internal lowercase app name determines these paths; the displayed product name remains RecordStuff.

Each line starts with a UTC ISO timestamp. Startup records app/Electron/OS versions, output folder, quality, packaged status, and executable path. Recording events include session, state, capture report, first chunk, saved, and failed. Logs include local paths, but no media bytes.

All messages go to stdout. Before an append, a file larger than 5 MiB rotates through three archives. Synchronous writes provide immediate diagnostics for the windowless app. A disk logging failure reports once to stderr and disables file output for the process while retaining stdout. Uncaught main errors also show a localized dialog; unhandled rejections are logged.

Show log reveals the file, falling back to opening its directory if absent. It does not affect capture. Development Electron.app and installed RecordStuff.app are different permission subjects; inspect executable before interpreting a grant or failure.
