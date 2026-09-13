# Desktop Features

[English](desktop.md) | [繁體中文](../zh-TW/system-design/desktop.md)

## Tray and notifications

Sources: [tray-model.ts](../../src/main/tray-model.ts), [tray.ts](../../src/main/tray.ts), [index.ts](../../src/main/index.ts).

TrayModel is a pure projection containing icon, title, tooltip, and a recursive menu. AppTray maps it to Electron without a separate business state machine. Left-click toggles recording; right-click builds the menu from current state and settings. It does not use setContextMenu, which would change left-click behavior on macOS.

| State | Icon/title | Actions |
| --- | --- | --- |
| needsPermission | Idle/empty | Permission guidance, settings/relaunch, output folder and quality |
| idle | Idle/empty | Ready or folder unavailable; reveal last recording when its path exists in state |
| starting | Idle/`…` | Permission-prompt guidance; quality locked |
| recording | Recording/`REC` | Stop; output folder and quality locked |
| stopping | Idle/`…` | Saving; quality locked |

Every state offers Language, Show log, and Quit. macOS uses template PNG/@2x assets and a title; Windows branches use ICO assets. REC may appear in full-display recordings; this is an accepted visibility tradeoff.

Pure functions generate localized notification text. Native notifications are silent. Saved/partial-file notifications reveal the file. Without a partial file, output-open failure opens folder selection, permission denial opens System Settings, and a relaunch error invokes relaunch. Quality/language save failures and frame-rate downgrade notifications are informational.

On macOS, notification file reveal runs in setImmediate after the native click response. Logs distinguish reveal requested/failed. Unsupported notifications and failed events are logged. OS preferences and foreground ordering still determine whether a banner is visible or Finder comes to the front. The notification icon was confirmed normal after the user's reboot on 2026-09-14.

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
  "version": 2,
  "outputDir": "/Users/example/Movies/RecordStuff",
  "quality": { "videoQuality": "standard", "resolutionCap": "source", "frameRate": 30 },
  "language": "en"
}
```

OutputDir must be a nonempty absolute path. Version 1 loads with default quality and is written as version 2 on the next save. The additive language field is optional on disk for older v1/v2 files; it defaults to English. Unsupported language values default to English with a warning, preserving valid folder/quality settings. Unsupported versions or invalid folder data fall back to defaults; an invalid quality block alone does not discard a valid folder. Obsolete audioQuality fields are ignored.

Save operations are serialized and derive each update from the last committed settings. Write settings.json.tmp, rename it, then update memory. A failed save rejects its caller without blocking later saves. This avoids half-written JSON but does not promise power-loss durability through directory fsync.

Folder selection uses a native dialog, with app focus on macOS. A successful save clears the idle folder-unavailable flag and refreshes labels. Actual writability is probed when recording starts. There is no automatic fallback to a different output folder.

Quality can change only while idle/needsPermission, and each recording has a snapshot. Platform frame-rate clamping affects effective settings, not persisted preferences.

## Logs

Source: [log.ts](../../src/main/log.ts). Current macOS paths are `~/Library/Logs/recordstuff/recordstuff.log` and `~/Library/Application Support/recordstuff/settings.json`. Electron's internal lowercase app name determines these paths; the displayed product name remains RecordStuff.

Each line starts with a UTC ISO timestamp. Startup records app/Electron/OS versions, output folder, quality, packaged status, and executable path. Recording events include session, state, capture report, first chunk, saved, and failed. Logs include local paths, but no media bytes.

All messages go to stdout. Before an append, a file larger than 5 MiB rotates through three archives. Synchronous writes provide immediate diagnostics for the windowless app. A disk logging failure reports once to stderr and disables file output for the process while retaining stdout. Uncaught main errors also show a localized dialog; unhandled rejections are logged.

Show log reveals the file, falling back to opening its directory if absent. It does not affect capture. Development Electron.app and installed RecordStuff.app are different permission subjects; inspect executable before interpreting a grant or failure.
