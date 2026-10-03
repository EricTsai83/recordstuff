# Function Reference

[English](functions.md) | [繁體中文](../zh-TW/system-design/functions.md)

Named application and tool functions are grouped by source file. Follow source links for exact TypeScript signatures. Tables describe contracts and side effects, including constructors, getters, and important nested helpers. Anonymous callbacks belong to the [recording](recording.md) and [desktop](desktop.md) flows; test cases remain beside the implementation.

## App composition

[main/index.ts](../../src/main/index.ts). Nested action handlers share settings, Recorder, and Tray through closures; they are not renderer-callable APIs.

| Function | Contract |
| --- | --- |
| defaultOutputDir | Electron videos path → RecordStuff subdirectory; does not create it |
| osSupported | Darwin major ≥22 on Mac; other platforms currently return true |
| isFirstRun | Exclusively create a marker in userData; success means first run, existing file/I/O failure means false |
| resourcesDir | Packaged resourcesPath or development appPath/resources |
| displays | Project connected Electron displays into the shared display model without enumerating capture sources |
| displayChanged | Pass connected display ids to DisplayMedia, fail a session whose active display was removed, and refresh UI |
| main | Wait ready, compose dependencies, register events/actions, start permission polling and optional development recording |
| renderUi / refreshUi | Move the tray and the settings panel together on a state change or a context change |
| quality | Development override or persisted settings → platform-effective quality |
| handleAction | Dispatch stop/quit/settings/relaunch/Finder, result actions, and every preference change through `savePreference` or `AppShortcuts.set` |
| savePreference | One preference write: a `locked` one needs a settled recorder; the write is awaited, a failure logged and, where the tray has one, notified; both projections refresh afterwards |
| focusApp | Bring the menu-bar app forward on macOS before a dialog or window, so it does not open behind the frontmost app |
| revealSaved | Show last recording: select the file, or, when it was moved or deleted since, log that and open the output folder |
| revealLog | Reveal the file, otherwise open its directory; log open failures |
| changeOutputDir | Native folder dialog → persist choice; failure notification or successful refresh |
| openOutputDir | The tray's output-folder action: `createOutputFolderOpener` over `shell.openPath`, the native warning, app focus and `changeOutputDir` behind the settled check |

[main/output-folder.ts](../../src/main/output-folder.ts): `createOutputFolderOpener` returns the single-flight open action. It stats the folder. A directory opens; the missing known default is created with a non-recursive `mkdir` only inside an existing parent folder; a missing custom folder, a file, a refused creation, an unreadable path or a Finder failure becomes one localized warning with the path, details and Change output folder/Cancel; while recording work is pending, the problem is logged and told in a notification held by `CaptureNotices` instead, because a modal warning would hold that work. An access refusal still asks Finder first. It never writes settings; a repeated click joins, focusing an open warning. `nodeOutputFolderFs` is the real stat/mkdir boundary.

Process callbacks log uncaught exceptions and rejections; the first uncaught exception also shows the error dialog, and a `main()` that rejects logs, shows it and exits. `savePreference` is the one place a preference write is awaited, logged and refreshed. Recorder events render state, notify saved/error/permission, and report clear frame-rate downgrades. The tray left click and the global shortcut share one `toggle` closure. Recorder receives `fs.statfs` free space and the `userData/recording-sessions` sentinels; launch reports leftover sentinels through the history restore, and `powerMonitor` suspend/resume are logged with the in-flight session. Before-quit coordinates shutdown; will-quit disposes the shortcut and releases resources. CurrentLanguage is updated only after a successful settings save and localizes unexpected-error dialogs.

## Display selection

[main/display-source.ts](../../src/main/display-source.ts): `resolveDisplayPreference` resolves the saved primary or explicit display; `selectScreenSource` requires exactly one source whose display id matches the resolved primary or explicit display, with no fallback. `DisplayRequest.run` checks topology around source enumeration, retries a missing source or a topology change up to three attempts for either preference, and settles the callback once, also when something throws (reported through the optional `failed` dependency). `cancel` settles pending callbacks and clears retry delays. `displayResolution` shares availability with tray and settings.

[main/display-media.ts](../../src/main/display-media.ts): `DisplayMedia` owns display-media state across attempts. `begin(sessionId)` cancels the previous request and snapshots the saved preference; `answer(owns, callback)` runs the attempt's `DisplayRequest` only for a frame the attempt owns and otherwise returns no source; `explain(code)` replaces one explainable host error with main's refusal reason; `settle()` cancels pending work and stops watching the active display; `topologyChanged(connectedIds)` advances the topology generation and reports whether the recorded display disconnected. `failure` is the display diagnostic shown by tray and settings.

## Recording state machine

[main/recorder.ts](../../src/main/recorder.ts). Injected dependencies make timing, stale sessions, and I/O failures testable without Electron.

| Function/method | Contract |
| --- | --- |
| formatTimestamp | Date → local-time filename timestamp |
| errorCodeOf | Known cause.code or caller-provided fallback |
| Recorder constructor | Apply clock/ID/deadline/log defaults and subscribe to host messages/failures |
| state getter | Current authoritative RecordingState |
| sessionId getter | In-flight session ID for diagnostics such as sleep/wake logging |
| subscribe | Register event listener and return unsubscribe |
| toggle | Start when idle, stop when recording, cancel a countdown, request permission guidance when blocked, cancel a start that has lasted at least 1 s (`START_CANCEL_GRACE_MS`), otherwise ignore |
| cancelCountdown | Before `record`: cancel the attempt; after it: request stop once capture starts; a menu's Cancel recording arriving while recording stops the recording; otherwise ignore |
| stop | Matching recording session → stopping (recording its stop-request time), arm deadline, send stop, then publish stopping |
| systemWillSleep | The Mac is going to sleep (plan 050): stop a recording with `stoppedEarly: "sleep"`, cancel a countdown or a preparing attempt with reason `sleep`, stop an arming one once capture starts; nothing while stopping or without a session |
| shutdown | Cancel an opening, preparing or countdown attempt at once (plan 065), keep stop intent after `record`, stop a recording, wait completion/failure while racing the quit deadline |
| setPermission | Always store the latest status; while idle/needsPermission re-settle on a change, never replace a busy state |
| outputDirChanged | Clear the remembered outputDirUnavailable, also while needsPermission; update the state only when idle |
| start | Preflight (a refusal emits a failed event marked `preflight`, naming no session), quality and countdown snapshots, session, folder probe, unique writer, overlay prepare, host start; clean late results |
| openUniqueWriter | Write the interruption sentinel for each temporary name, then try temporary/final filename pairs; retry temporary EEXIST up to ten attempts |
| markInFlight / clearInFlight | Write the session sentinel (a failure logs once and never blocks) / remove it on every terminal outcome |
| handleHostMessage | Filter session, dispatch prepared/started/chunk/stopped/error, map a pre-capture capture_failed to capture_start_failed with the phase, stop stale capture |
| beginCountdown | Enter countdown N, show the overlay and schedule every tick, the dismissal and N seconds from one monotonic anchor |
| dismissOverlay / recordAfterCountdown | Await the overlay's dismissal within its bound (then close it and log) / send `record` once N seconds passed and the overlay is gone |
| record | Enter arming, arm the `record → started` deadline and send `record`; a refusal fails the start |
| cancel | Detach session, clear timers, close the overlay, stop the host, return to the pre-attempt idle, abandon the writer, emit `cancelled`, remove the sentinel |
| present / closeOverlay / clearCountdown | Call the presenter, logging its errors / close the overlay once / clear countdown timers |
| handleChunk | Validate consecutive seq, clear first-chunk deadline, reset the stall guard on nonempty media after started, append; map rejection to failure |
| finalize | Wait writes, ensure session still current, finish file, then idle/saved with any early-stop reason and the session trace, then remove the sentinel |
| armStall | Inter-chunk timer after media began: log once at the warning bound, fail with capture_failed at the second |
| watchDisk | While recording, poll free space on one non-overlapping timer; log once below the warning threshold, request one normal stop below the stop threshold; a failed poll logs once |
| retainedWriteError | Drain the writer within a bound and return its retained write/sync error, used only to reclassify capture_start_failed |
| handleHostFailure | Fail only when a session exists; before `record` as capture_start_failed naming the phase |
| cancelMarked | An attempt sleep or quit marked before `prepared` is cancelled with that reason instead of failing on a host error or loss, display removal, or a timed-out or refused request |
| fail | Detach session, clear deadline, countdown and health timers, close the overlay, stop host, idle immediately, report a writer-retained disk error instead of capture_start_failed, abandon writer, emit failure with its file outcome, session trace and optional partial path, remove the sentinel |
| trace | The session's id, temporary path and recording/stop-request times carried on captureStarted, saved and failed (plan 029) |
| clearTimer / clearDisk / clearHealth | Cancel and clear the session deadline / free-space poll / poll and stall timers |
| setState / emit | Replace state and emit / notify registered listeners, logging a throwing one so the others and the recorder's own cleanup still run |

## Main capture supervisor

[main/capture-host.ts](../../src/main/capture-host.ts). Distinct from the same-named renderer class.

| Method | Contract |
| --- | --- |
| constructor | Paths/dev URL plus default 5-second ping and 8-second readiness deadline |
| onMessage / onFailure | Register valid-message and host-failure callbacks |
| start | Tear down any previous host, create a fresh window for this attempt and wait for ready; begin the session heartbeat, then post start with session quality; a creation/load failure tears the new window down and rejects |
| record | Post record for the watched session; throws when no host is attached to it |
| stop | Post stop when a port exists |
| destroy | Tear down when an attempt settles and during app quit |
| create | Build sandbox window/channel, install guards/crash handlers, load page, hand off port, wait ready; log a malformed message as field names and value kinds only |
| stopHeartbeat | End the heartbeat when the watched session reports stopped or failed, and on teardown |
| ping | Check for two unanswered pings before sending another; on failure tear down and emit |
| post / emitFailure | Send MainMessage / notify failure listeners |
| teardown | Stop the heartbeat, close port, destroy window; invalidates an in-flight start |

## Renderer capture and encoding

[renderer/capture-host.ts](../../src/renderer/capture-host.ts). No filesystem or arbitrary Node access.

| Function/method | Contract |
| --- | --- |
| measureFrameSize | Observe muted video intrinsic dimensions until matching size, error, or timeout; detach video in finally |
| current / matches / check | Read positive dimensions, match optional expected size, resolve measurement and clear timer |
| CaptureHost constructor | Subscribe/start port, inject frame measurer, send ready |
| handle | Validate MainMessage; ping→pong, start, record, or stop |
| start | Reject overlap/unsupported MIME, request stream, handle cancellation/audio validation, apply quality, build an inactive MediaRecorder, watch its tracks and send prepared |
| record | Refuse unless this session is prepared and live; register callbacks, start MediaRecorder, send started; ignore a duplicate |
| release | Drop a prepared session and stop its tracks |
| cancelled | During pending start, discard canceled stream, remove pending ID, send stopped |
| refuse | Remove pending ID, stop tracks, and report start failure |
| stop | Cancel pending ID, release a matching prepared session and reply stopped, or stop matching active recorder once; inactive recorder schedules terminal cleanup |
| enqueueChunk | Skip empty Blob; allocate seq, serialize ArrayBuffer conversion and copying; report conversion failure |
| finish | Once-only terminal path: stop tracks, drain send chain, clear session, invoke terminal callback |
| fail / send | Construct error / post typed HostMessage |
| finiteOrUndefined | Finite numeric value or undefined |
| applyQuality | Measure source, fit cap, repeat fps constraint, remeasure, calculate bitrate and warnings → CaptureReport |
| stopTracks | Stop every stream track |
| describe | Format Error name/message or unknown cause |
| classifyGetDisplayMediaError | NotAllowedError→permission_denied; NotFoundError→no_display; otherwise capture_start_failed |

The page's window-message callback checks source/marker/port before creating the host. Recorder callbacks preserve chunk-chain-before-terminal-message ordering.

## Media storage

[main/file-writer.ts](../../src/main/file-writer.ts). NodeFs adapts open, link, exclusive copy, unlink, mkdir, and writeFile for injected I/O.

| Function/method | Contract |
| --- | --- |
| FileWriteError constructor | Error carrying code, path, and original cause |
| errnoCode / messageOf ([main/errors.ts](../../src/main/errors.ts)) | Optional filesystem errno / error text, shared by every main module that reads a Node error |
| classifyWriteError | ENOSPC→disk_full; otherwise output_write_failed |
| classifyOpenError | ENOSPC→disk_full; otherwise output_open_failed (the folder probe and the exclusive open) |
| ensureWritableDir | mkdir and write probe; throw classifyOpenError's code on failure; remove probe best effort |
| FileWriter constructor | Store handle/paths/I/O and schedule queued sync |
| FileWriter.open | Exclusive temporary-file open → writer; wrap open failure |
| bytesWritten | Sum of confirmed bytes from each write, including progress before an append fails |
| backlogBytes | Bytes accepted by append and not yet confirmed written or released after a failure |
| append | Reject if closed or already refused; refuse at once, without queueing, an append that would exceed the backlog bound (keeping an earlier disk error); otherwise queue complete writes of the remaining buffer, counting confirmed progress; empty input skips write, zero/invalid counts reject |
| drain | Wait for queued work, then return the retained failure or refusal, if any |
| finish | Queued sync; reject after a refusal; release, exclusive hard link with collision suffixes (exclusive copy once a link is refused other than EEXIST), best-effort temporary removal → actual final path and `finishTimings`; reject failure |
| finishTimings | After a successful finish: flush, close, publish and cleanup milliseconds, `link` or `copy`, and the link's error code when it copied; diagnostics only |
| abandon | Drain, best-effort close, preserve nonempty temporary file or remove empty file; never throw |
| release | Once-only closed flag and handle close; `beginTerminal` already stopped the fsync timer |
| enqueue | Serialize operations; retain first failure and reject later operations consistently |

## Settings, quality, language, and protocol

[main/settings.ts](../../src/main/settings.ts):

| Function/method | Contract |
| --- | --- |
| parseSettings | Validate v1/v2/v3 JSON; preserve valid folder when quality/language/hotkey need defaults; return warnings |
| constructor / load | Read synchronously, validate, fall back and log; do not immediately rewrite defaults |
| outputDir / quality / language / hotkey | Read successfully committed preferences |
| defaultOutputDir | The fallback folder given at construction; the only folder opening may create |
| setHotkey | Validate enabled flag and custom accelerator, canonicalize it, then enqueue update |
| setOutputDir | Validate absolute path, then enqueue update |
| setQuality | Validate patch, then merge with latest committed quality inside the save queue |
| setLanguage | Validate en/zh-TW, then enqueue update without dropping folder/quality |
| countdown / setCountdown | Read the committed countdown / validate 0, 3, 5 or 10, then enqueue update |
| countdownSound / setCountdownSound | Read the committed switch (a missing field reads as on) / validate a boolean, then enqueue update (plan 046) |
| save | Serialize, write, then update memory; one failed operation does not block later saves |
| write | `writeFileAtomic`: mkdir, write and fsync JSON.tmp, then rename |

[main/atomic-file.ts](../../src/main/atomic-file.ts): `writeFileAtomic` / `writeFileAtomicSync` create the parent folder, write `<file>.tmp`, fsync it and rename it over the file; a failure removes the temporary file and keeps the previous content. Settings, settings-window size and failure history use `writeFileAtomic`; `writeFileAtomicSync` serves only the verification scripts.

[shared/quality.ts](../../src/shared/quality.ts):

| Function | Contract |
| --- | --- |
| isQualitySettings | Check the three enum fields; tolerate unrelated extra fields |
| isFrameRateAvailable | 30 available; 60 available only on darwin |
| effectiveQuality | Return original settings or a 30-fps copy without mutating preferences |
| even | Round, then lower an odd result to even for downscaling |
| fitWithinCap | Preserve aspect/orientation, never upscale, use even downscaled dimensions |
| videoBitsPerSecond | Pixels×requested fps×quality coefficient, round to 100 kbps, clamp |
| isOptionalFiniteNumber | Undefined or finite number only |
| isCaptureReport | Validate optional numbers and required target bitrates/warnings; not comprehensive value-range validation |
| frameRateDowngrade | Requested 60 and reported ≤30 → rounded actual fps, otherwise undefined |
| unknown / describeCapture | Format unknown values / English requested, track, target, and warning diagnostics |

[shared/hotkey.ts](../../src/shared/hotkey.ts): `DEFAULT_HOTKEY` enables ⌘⇧1; the accelerators earlier versions shipped stay valid, checked by `hotkey.test.ts`. `validateAccelerator` validates supported custom combinations, requires Command or Control and rejects reserved keys; `canonicalizeAccelerator` normalizes modifier order and shifted glyphs. `isAccelerator` / `isHotkeySettings` validate persisted values without restricting them to the offered choices; `describeAccelerator(accelerator, platform)` renders `⌘⌥⇧R` on darwin and `Ctrl+Alt+Shift+R` elsewhere for menus, notifications and logs.

[main/hotkey.ts](../../src/main/hotkey.ts):

| Function/method | Contract |
| --- | --- |
| RecordingHotkey constructor | Inject a `globalShortcut` subset (register/unregister), the tray's toggle action and a logger |
| status | `disabled`, `registered` with accelerator, or `failed` with accelerator and reason |
| apply(settings) | Drop any pending request, release the current registration, then register when enabled; return the new status; a refusal or thrown register becomes `failed` and is logged |
| request(settings, settled) | `apply` when the recorder is idle/needsPermission; otherwise hold the request, log it and return `deferred` |
| flush(settled) | Apply the held request once settled; undefined when nothing was pending |
| dispose | Release and reset to disabled; idempotent |
| pressed | Log `hotkey: <accelerator> pressed` and call the toggle |
| release | Unregister only a `registered` accelerator; log an unregister error |

[shared/i18n.ts](../../src/shared/i18n.ts): `isLanguage(value)` validates en/zh-TW; `translate(key, language, values)` selects an English-keyed template or Traditional Chinese translation and substitutes every named placeholder; the compiler requires a value for each placeholder of the key, and label tables use `PlainMessageKey` (messages without placeholders). DEFAULT_LANGUAGE is en; ZH_TW is a typed complete translation catalog. Technical logs do not use it.

[shared/protocol.ts](../../src/shared/protocol.ts): `isRecord` and `isNonEmptyString` support `isMainMessage` and `isHostMessage`; `prepared` requires a mime type and a CaptureReport, `started` may carry neither; chunk validation requires nonnegative integer seq and ArrayBuffer bytes.

[shared/countdown.ts](../../src/shared/countdown.ts): `COUNTDOWN_CHOICES` (0, 3, 5, 10), `DEFAULT_COUNTDOWN` (3) and `isCountdownSeconds`; `COUNTDOWN_TIMING` (tick, overlay lead, dismissal bound, fades, settle) and `COUNTDOWN_OVERLAY` (the font fraction of the display's shorter side and its 56–216 pt clamp, the window-to-font ratio, insets, font, digit, outline and shadows at the 56 pt reference size, reduced-transparency values), the tick's values `COUNTDOWN_TICK` (sine at 523 Hz, the last digit ×1.5, a quiet fourth partial, 4 ms attack, 140 ms, −20 dBFS), `DEFAULT_COUNTDOWN_SOUND` (on), `tickFrequencyHz(digit)` and the page's `COUNTDOWN_SOUND_QUERY` (plan 046), the one place every timing, appearance and sound value lives; `overlayFontPt(displayBounds)` gives the digit's size for a display and `overlayBounds(displayBounds, workArea)` the square window, in whole points, at the top-right of its work area; the value channel and bridge type the overlay preload exposes.

[main/countdown-overlay.ts](../../src/main/countdown-overlay.ts):

| Function/method | Contract |
| --- | --- |
| overlayWindowOptions | Transparent, frameless, shadowless, fixed, unfocusable, sandboxed window options with `autoplayPolicy: "no-user-gesture-required"`; a non-activating panel on macOS |
| prepare | Build the hidden window once at the primary display, at the `screen-saver` level on every Space, click-through; load the page, with `?sound=1` when the session's presentation ticks (a different flag rebuilds the page); a crash or failed load closes it |
| show / update | Place on the recorded display (primary, logged, when unknown), log the placement with the display bounds, send the digit and show inactive once loaded / send the next digit |
| dismiss | Send `null` so the digit fades, destroy the window after the fade and settle interval, then resolve; destroy at once when nothing was drawn |
| close / destroy | Destroy at once, resolving a pending dismissal; `destroy` is the app's safety net on settled states and quit |

[renderer/countdown.ts](../../src/renderer/countdown.ts): `overlayStyle` turns the shared appearance values into CSS custom properties; `createCountdownView` crossfades two stacked faces, fades the stage out on `null` and calls its optional `onDigit` once per new digit; `playTick` synthesizes one tick from `COUNTDOWN_TICK` with Web Audio; `soundRequested` reads the page's query (plan 046). [preload/countdown.ts](../../src/preload/countdown.ts) exposes only `countdown.onValue` and forwards positive integers or `null`. [shared/state.ts](../../src/shared/state.ts): `isErrorCode` checks the ERROR_CODES whitelist.

[preload/index.ts](../../src/preload/index.ts) has one IPC callback rather than named functions: forward the received capture-host-port to window with transferred ports. No contextBridge API is exposed.

## Permissions

[main/permission.ts](../../src/main/permission.ts):

| Function/method | Contract |
| --- | --- |
| screenCaptureGranted | Compare Electron screen status with granted |
| openScreenCaptureSettings | Open fixed settings URL |
| countCapturableScreens | Enumerate screens without thumbnails; count or reject |
| constructor | Inject APIs/callback; default 5-second polling, 4-second validation deadline and 60-second backoff cap |
| start / stop | Immediate check, interval and activate listener / new generation, remove interval, listener, deadline and retry; a pending call stays owned |
| markRelaunchRequired | If running and the OS still grants access, start a new generation, invalidate cache and recheck |
| check | Reset (new generation, clear deadline/retry/backoff) and prompt when denied; emit cached success; otherwise validate |
| promptOnce | One registration/prompt getSources call per process, only when the enumeration slot is free |
| validate | Skip while a retry waits; arm the guidance deadline; enumerate only when no call is in flight |
| overdue | Deadline reached: emit needsRelaunch guidance without freeing the in-flight slot |
| enumerate / settle | Own the single call until it settles; free only its own slot; ignore stale generations; cache success or schedule the doubling backoff |
| emit | Suppress identical permission states |

## Shared UI vocabulary

[main/ui-model.ts](../../src/main/ui-model.ts): what the tray and the settings panel both build on. Neither projection is derived from the other.

| Function | Contract |
| --- | --- |
| AppAction / AppContext / AppHotkey | The action union every interface raises, and the read-only context snapshot both project from |
| preferencesUnlocked | The single rule for whether a preference may change: idle or needsPermission only |
| abbreviateHome | Shorten exact home or complete path prefix, avoiding similarly named folders |

## Settings panel model

[main/settings-model.ts](../../src/main/settings-model.ts): every preference declared once, with stable ids.

| Function | Contract |
| --- | --- |
| qualityGroups | Video quality, resolution cap and frame rate; an unverified frame rate stays listed but not selectable |
| hotkeyGroup | Recommended default, the saved custom value when distinct, and Off; the renderer adds Custom shortcut…; a refused registration adds a diagnostic, as does a Settings shortcut (⌘⌥,) that failed to register or is taken by the recording shortcut; Off keeps the remembered accelerator |
| updateChecksGroup | On/Off for the launch check |
| languageGroup | English and Traditional Chinese; never locked, because language cannot touch a capture |
| settingsView | The panel's whole view: title, hint, failure text, the three tabs (the failures tab counting unread rows) and groups with the actions stripped; failure rows carry their day, short time, file name and full path |
| failureDay / failureTime | A failure row's day heading (Today, Yesterday, the date, the year only for an earlier year) and short local time, relative to `ctx.now` (plan 047) |
| settingsAction | The action for a group/choice pair that is offered and enabled right now, or nothing |
| settingsChecked | Whether a choice is the committed one; how main reports that a save took effect |

## Settings window

[main/settings-window.ts](../../src/main/settings-window.ts) and [renderer/settings.ts](../../src/renderer/settings.ts).

| Function/method | Contract |
| --- | --- |
| SettingsWindow constructor | Register the three IPC handlers (`settings:capture`, `settings:read`, `settings:choose`), each refusing any sender but the panel's main frame; `capture` suspends the global shortcuts while the shortcut editor records a new one |
| show | Focus the menu-bar app first, reuse a live window, otherwise create a sandboxed one and load the page with the current language |
| refresh | Push the current view and retitle; a closed panel needs nothing, and a view identical to the one the page already holds (by push or by an invoke reply, tracked through `deliver`) is not sent again |
| destroy | Remove the handlers and the window on quit |
| apply | Resolve the group/choice pair, run the shared action handler, answer with the new view and whether it committed |
| queue (settings:choose) | Serialize saves in request order so a second request waits instead of being reported as a failure |
| panel: draw / row | Render a view, restoring focus to the control the rebuild replaced; an explicit failure entry selects the failures tab; each tab's scroll offset is stored on leaving and restored once the rebuilt panel has settled |
| panel: updateRecordingResult / resultRow / fillRow | The failures tab (plan 047): day groups of collapsed rows kept by ID, one open at a time, Up/Down/Home/End between headers, the entry target opened and focused, focus to the neighbour after a removal or to the tab after the last |
| panel: choose | Send the ids, keep the control in use live while its neighbours go inert, and show the failure text if the value did not commit |

## Tray presentation

[main/tray-model.ts](../../src/main/tray-model.ts): a flat command menu; preferences are not in it.

| Function | Contract |
| --- | --- |
| disabled / item | Build disabled/enabled model entries |
| windowsGroup / appGroup | Settings… (with the Settings shortcut, and an explanation when it is unavailable) and reviewed failures / Show log and Quit, in every state |
| outputDirItems | Folder label and selection action with state-dependent enablement |
| shortcutHint | Start/stop or Cancel recording tooltip naming the registered accelerator; undefined when disabled or unregistered |
| permissionActions | Relaunch alone when required; otherwise settings and fallback relaunch |
| trayModel / text / model | Pure state/context projection with local translation/status helpers; one icon per state (ring, hourglass, stopwatch, filled dot, badge on the idle ring only), a title only while recording; the tooltip carries the status and the right-click hint |
| notice | Wrap body with product title |
| savedNotification | Basename → localized completion text |
| permissionNotification | Localized settings/relaunch guidance |
| settingsWriteFailedNotification | Explain unchanged output folder after failed save |
| qualityWriteFailedNotification / languageWriteFailedNotification / hotkeyWriteFailedNotification | Explain retained quality/language/shortcut |
| hotkeyRegistrationFailedNotification(accelerator, platform) | Localized conflict notice with the platform rendering of the accelerator, pointing at Settings |
| frameRateDowngradeNotification | Include actual and requested fps |
| trayHintNotification | First-launch text pointing at the menu bar on macOS or the system tray elsewhere; on macOS it also raises the one notification authorization prompt |

[main/recording-result.ts](../../src/main/recording-result.ts):

| Function/method | Contract |
| --- | --- |
| RecordingResults.receive / act | Confirm partial files, reject stale results/actions, retain unread state and expose recovery actions; each acknowledgement, removal and retry logs one line with its ID and outcome (saved, failed with the storage error class, or refused with the reason) when it settles |
| RecordingResults.restore | Adopt launch-time interruption entries not yet in history, recheck them and saved paths with a deadline; restore acknowledgement without a notification or overwriting newer state; resolve whether this attempt saved the history |
| RecordingResults.saved | Resolve once every given ID has been in a saved file, including through a later automatic retry; never starts a save |
| isOutputFolderFailure / isPermissionFailure | The shared recovery categories: output-folder failures offer the folder action; permission failures, including no_audio_track, offer System Settings and Relaunch on macOS |

[main/session-sentinel.ts](../../src/main/session-sentinel.ts): `SessionSentinels.write` atomically names a session's temporary file before it exists; `remove` deletes it without throwing; `leftovers` lists sentinels of earlier processes, skipping this process's sessions, discarding interrupted writes and invalid content, and keeping ones it cannot read now. `interruptionFailure` turns one into an `app_terminated` entry with a session-derived ID; `reportInterruptions` hands them to `RecordingResults.restore` at launch and removes them only once `RecordingResults.saved` confirms their entries were saved.

[main/recording-health.ts](../../src/main/recording-health.ts): `RECORDING_HEALTH`, the single place for the stall, free-space, writer-backlog and start-drain thresholds.

[main/keep-awake.ts](../../src/main/keep-awake.ts): `KeepAwake.update` holds one `prevent-display-sleep` power blocker from `starting` until the state settles and logs each start and stop; a blocker that throws is logged only; `dispose` releases it on quit (plan 050).

[main/recording-result-store.ts](../../src/main/recording-result-store.ts): validates and atomically replaces versioned failure history; migrates the legacy single record without overwriting it. Exact-ID retry preserves unread state; removal deletes only reviewed metadata.

[main/tray.ts](../../src/main/tray.ts):

| Function/method | Contract |
| --- | --- |
| AppTray constructor | Load icons, create Tray, ignore double-click events, bind left/right clicks |
| render / refresh | Remember presentation state and update image/title/tooltip, each only when it changed; refresh rereads context |
| destroy | Destroy native Tray once, drop held notifications; later render, refresh, right-click and notifications do nothing |
| systemWillSleep / systemDidWake / userDidUnlock | Hold notifications from `suspend`; after `resume`, check each second and show them in order once the idle time is at most 2 s or shows input since the wake; unlocking shows them at once (plan 050) |
| notifySaved | Current-language saved notice with reveal callback |
| notifyRecordingFailure(code) | Open failure history at the newest unread record without acknowledging it |
| revealFromNotification / reveal | Defer macOS Finder call and record requested/failed |
| notifyPermission | Current-language guidance with settings/relaunch callback |
| notifySettingsWriteFailed / notifyQualityWriteFailed / notifyLanguageWriteFailed / notifyHotkeyWriteFailed | Current-language failed-save notices |
| notifyHotkeyRegistrationFailed(accelerator) | Current-language conflict notice |
| notifyFrameRateDowngrade / notifyTrayHint | Informational localized notifications |
| show | Hold while asleep, then switch and support checks, silent Notification, click/failed handlers, show |
| log | Invoke optional injected logger |
| popUpMenu | Rebuild current model and show native menu |
| toTemplate | Map a separator or command entry to an Electron menu template |
| TRAY_ICON_FILES / loadIcons | The asset per state / Windows ICO or template PNG assets for every state; a file that loads as an empty image is logged, since the item would be invisible |

## Logging and automatic recording

[main/log.ts](../../src/main/log.ts): `rotatedPath` constructs archive names; `rotateLog` removes the oldest and shifts archives; `formatLine` adds UTC ISO time; `createFileLogger` returns a logging function with `flush()`: each line goes to stdout at once and joins one serialized asynchronous file queue bounded at 1 MiB (lines past the bound are dropped from the file only, reported once). The first write creates the directory and reads the length once per process; later writes count the bytes, rotate before a write past `maxBytes`; a full disk or a removed logs folder skips lines until a later write succeeds and then records how many the file missed, while any other file error disables file logging. `flushBeforeExit` waits a bounded time for that queue, so a failed start or a second instance exits only after its reason reaches the file.

[main/session-log.ts](../../src/main/session-log.ts): `createRunId` forms the per-launch run id from launch time and pid; `logSessionEvent` writes the human `saved`/`failed:` line and then the versioned session record for captureStarted, saved, failed and a preflight refusal; a cancelled countdown is one plain `cancelled:` line naming its temporary file and no record; other events are ignored. [shared/session-record.ts](../../src/shared/session-record.ts) defines the record schema, prefix and version and formats one record; it has only type imports so scripts load it directly.

[main/autorecord.ts](../../src/main/autorecord.ts): `parseAutoRecord` ignores packaged/empty input, validates seconds in (0,3600], quality keys and an optional countdown (0 unless named), sets `countdownSound: false` whatever is given (plan 046), and merges defaults. `runAutoRecord` waits 1.5 seconds before toggle, starts its stop timer only after recording begins, and quits after saved/failed/cancelled, or needsPermission before its press, through once-only `finish`. An absolute `outputDir` overrides the saved folder for that run only; it does not write settings.

## Packaging and icons

[scripts/start-app.mjs](../../scripts/start-app.mjs):

| Function | Contract |
| --- | --- |
| run | Spawn synchronously in repo with filtered environment; reject spawn/nonzero failures |
| fingerprint | Public certificate SHA-1 without separators, uppercase |
| checkCertificate | Validate dates and self-signature |
| resolveIdentity | Exact name/SHA-1 selection, reject ambiguity/duplicate names; return hash/name/expiry |
| assertNotRunning / escapeRegex | Match RecordStuff/project Electron processes safely; refuse rebuild while running |
| verifyBundle / walk | Deep signature and nested bundle checks without following symlinks; check certificate/identifier/runtime/designated requirement |

Top-level CLI checks platform/options, filters release credentials, builds/verifies an app, then opens it or creates a DMG; temporary extracted public certificates are removed.

[scripts/make-icons.mjs](../../scripts/make-icons.mjs): `coverage` supersamples geometry; `circle`, `ring`, and `roundedSquare` create masks; `rasterize` composites RGBA; `chunk` constructs PNG chunks with CRC; `png` and `ico` encode formats; `box` makes fractional rectangles; `idleShape`, `busyShape` (hourglass), `countdownShape` (stopwatch), `recordingShape`, `warningShape` and `appIcon` define assets. The Windows tray artwork (plan 034) is drawn per ICO entry from `WINDOWS_TRAY`, a table of pixel geometry for 16, 20, 24, 32 and 48 px: `rect`, `union` and `offset` compose pixel masks; `exclamation`, `hourglass` and `stopwatch` draw the warning mark, busy and countdown symbols; `windowsTrayLayers(state, size)` stacks the grey-rimmed dark base with that state's symbol. Top-level generation writes resources and invokes iconutil on macOS.

## Verification tools

See [tooling](tooling.md) for pipeline and thresholds. These tools are development-only.

| Source/functions | Contract |
| --- | --- |
| [acceptance-settings.mts](../../scripts/acceptance-settings.mts) top level | Require the build output and a local Electron; run the fixture with a 90-second deadline into a fresh evidence directory; print each case; write report.md; exit 2 on a missing prerequisite or no results, 1 on any failing case |
| [fixtures/settings-panel.ts](../../scripts/fixtures/settings-panel.ts) | Load the built preload and page in a hidden sandboxed window with its own view and IPC handlers; judge CSP/console, the exposed bridge, absent Node APIs, the URL language, the rendered controls, an unavailable option, a refused shortcut's note, a real change round trip and an uncommitted choice; write results.json and panel.png |
| [acceptance-hotkey.mts](../../scripts/acceptance-hotkey.mts) top level | Require ffmpeg/ffprobe and a running idle RecordStuff with a run id and its `hotkey: registered` line; open the kiosk material; send the accelerator through System Events; wait ≤30 s each, from rotation-aware cursors, for `pressed`, `state → recording`, this run's capture record, second `pressed` and that session's terminal record; verify the integrity tier with `testMaterial` and channel energy required, and require the file's metadata to match that session; write report.md/verify.json/app-session.log; exit 2 before any key without ffmpeg/ffprobe, exit 1 when a check failed, was blocked or is incomplete |
| [lib/acceptance.mts](../../scripts/lib/acceptance.mts) `acceleratorToKeystroke` / `keystrokeScript` | Electron accelerator → System Events `keystroke … using {…}`; undefined for keys it cannot type |
| Same file `lastStartIndex` / `registeredAccelerator` / `currentState` / `currentRunId` / `lineTime` | Scope log reading to the current process (skipping a lock-refused second launch's `start:` line) and its run id; parse the line timestamp |
| [lib/log-reader.mts](../../scripts/lib/log-reader.mts) `LogReader.end` / `since` / `all`, `readRetainedLog`, `evidenceSince` | Rotation-aware cursor (file identity + byte offset) just past the last complete line; complete lines after a cursor across retained archives, each once, or `LogGapError` when retention or truncation removed that history (the cursor's 64-byte mark also catches a truncated file that regrew past it); every retained line oldest first; evidence lines with a marked gap |
| [lib/session-records.mts](../../scripts/lib/session-records.mts) `parseSessionRecord` / `startLineRun` / `logMessage` | Validate one session record of a known version (malformed or future records are ignored); the run id of a `start:` line; strip the timestamp |
| [lib/acceptance-runtime.mts](../../scripts/lib/acceptance-runtime.mts) `waitForLog` / `waitForRecord` / `recordingOutcome` / `finishRecording` / `settleRecording` | Bounded waits from a cursor that reject at once on an evidence gap; this recording's outcome from records when the app writes them, else from human lines, optionally for one session; interrupted-recording settlement that never toggles twice; its runner fallback for an app that never left idle |
| [probe-recording.mjs](../../scripts/probe-recording.mjs): probe, ratio, kbps, fixed | Run ffprobe, parse ratios, format quick inspection output |
| [verify-recording.mts](../../scripts/verify-recording.mts): usage, next | CLI help/exit 2 and argument values; top-level loop requires energy (and markers with `--sync`), verifies files and exits by `verdictExitCode`: 1 fail, incomplete or unreadable, 2 blocked |
| [lib/media-tools.mts](../../scripts/lib/media-tools.mts): ToolMissingError, MeasurementError, run, hasTool | Missing tool; a tool that ran without a valid measurement; bounded-buffer subprocess invocation; availability check |
| Same: completed, stderrTail | Only a zero exit is a measurement; a nonzero exit or signal throws MeasurementError with the last stderr lines |
| Same: probe | Container/stream/frame count and decode errors; malformed JSON is a MeasurementError |
| Same: frameTimes, read | PTS intervals; long files sample head/tail separately |
| Same: channelRms, syncMarkers | Per-channel astats energy, complete only when every channel of the stream is reported; flash/beep times from detector runs that exited 0 |
| [lib/verify-recording.mts](../../scripts/lib/verify-recording.mts): readLogText, readLogPairs | Every retained file oldest first; identity pairing, empty without a log |
| Same: attempt, verifyRecording | Look up the file's pairing, then probe/frame; energy (only with an audio stream) and optional sync become evidence (missing ffmpeg `unavailable`, any other failure `error`) → measure → judge with the caller's required evidence → result with the pairing status |
| Same: parseDimensions | WxH string → dimensions or undefined |
| Same: tryExec, environmentSummary | Best-effort machine/OS/Electron/display/tool facts |
| Same: localDate, measurementsPath | Local date → evidence filename |
| Same: appendMeasurements | Initialize environment header, append Markdown, write structured JSON |
| [run-matrix.mts](../../scripts/run-matrix.mts): shorten, usage | Change case duration / show CLI help |
| Same: mainDisplaySize, outputDir | Primary-display dimensions and configured/default folder |
| Same: sleep, electronPids, electronMainPid | Inter-case delay; every process of this checkout's Electron.app, and its main process, the root the CPU sampler follows |
| Same: logSince | This case's lines from its cursor across rotation; a lost history is a case failure |
| Same: recordOnce | Launch development app with automatic-recording config, follow its process tree with the shared CPU sampler, await outcome; CPU judged over the recording from its third second (`cpuWindow` in lib/matrix.mts), with the 95th percentile, VTEncoderXPCService and this machine's baseline |
| Same: main | Validate prerequisites (ffmpeg/ffprobe, then clang for the CPU sampler; blocked exit 2 before anything runs), open material, run cases with energy and sync required, verify/save results, clean up, exit by `verdictExitCode` |
| Same: unmetChecks | A case's verdict and each check that kept it from passing, with its reason |
| [lib/cpu-sampler.mts](../../scripts/lib/cpu-sampler.mts) `compileSampler`, `CpuSampler` | Compile [cpu-sampler.c](../../scripts/lib/cpu-sampler.c) with clang (missing Command Line Tools: `SamplerBlockedError`); stream its once-a-second `proc_pid_rusage` counters for a root process, its descendants and followed helpers such as VTEncoderXPCService, until stopped |
| Same: `parseSample`, `intervals`, `summarize`, `percentile` | Parse one helper line; per-second CPU, wake-ups and energy per process with the app's process-set changes marked; average, nearest-rank 95th percentile and maximum over a window, discarding changed intervals unless changes are expected |
| Same: `CPU_BUDGET`, `judgeIdle`, `judgeSettingsOpen`, `judgeRecording`, `judgeCoverage`, `cpuBaseline`, `machineModel` | The plan 049 budget and its verdicts (the recording threshold, encoder report, 25% baseline warning and the 80% sampled coverage); this machine's recorded baseline from cpu-baselines.json |
| Same: `processRole`, `rolesFromPs`, `readRoles`, `IDLE_ROLES`, `judgeRoles`, `judgeSteadyState` | A Chromium process's role from its command line; the roles of an app's tree; the idle contract by scenario; the same roles after every recording |
| [measure-cpu.mts](../../scripts/measure-cpu.mts) `launch`, `seed` / `restoreSettings`, `main` | Launch the quit bundle and wait for settled startup; write the countdown, display and quality only while the app is quit and set just those keys back once no process remains; run scenarios A, R, B and C, write report.md/report.json, quit the app and confirm it exited, exit 0/1/2/130/143 |

### Pure measurement logic

[scripts/lib/verify.mts](../../scripts/lib/verify.mts) never spawns processes.

| Functions | Contract |
| --- | --- |
| numberOrUndefined, parseRatio | Parse numeric values/fractions or return undefined |
| parseCaptureLine | Extract requested/track/target/warnings from capture log |
| pairRecordingsWithLog, LogPairs.lookup, normalizeRecordingPath | Pair session records by run and session id, older launches by conservative legacy association; look a file up by normalized full path, by name only when one session names it; report matched/legacy/ambiguous/conflict/unknown |
| parseAutorecordOutcome | Extract saved/failed outcome |
| parseFrameTimes, frameStats | Parse PTS and measure per-interval gaps/drops without crossing unsampled regions |
| dropEofClosures | Remove detector closure artifacts near EOF |
| parseBlackdetect, parseSilencedetect | Parse flash/audio boundaries and discard EOF artifacts |
| parseChannelRms | Parse per-channel energy |
| median, syncStats | Match markers; always return flash/beep/pair counts overall and per edge window, with offsets and head-tail drift only from at least MIN_SYNC_PAIRS pairs |
| measure | Combine stream/container/frame/decode/audio/CPU/sync facts; energy and sync are Evidence that names why it is absent; CPU (`CpuFigures`) comes from the matrix runner |
| fmt, mbps, kbps, ms | Format values and unknowns |
| pass, offsetWithinLimits, aspectMatches | Verdict, asymmetric offset bounds, aspect tolerance |
| judge, unmeasured, markerShortage, energyProblems, dbText | Produce threshold checks; turn evidence status, the caller's required evidence, marker coverage and per-channel levels into pass/fail/blocked/incomplete/n/a with a reason |
| overallVerdict, blocksSuccess, verdictExitCode | fail > blocked > incomplete > pass > n/a; the verdicts that keep a run from succeeding; process exit 1/2/0 |
| describeRequested, formatText, width, pad | Human-readable requested settings (or why the metadata is missing) and aligned terminal table |
| cell, formatMarkdown, resultLine | Escape table cells and produce evidence section; the result line names its verdict |

[scripts/test-material.html](../../scripts/test-material.html): `scheduleBeep` builds a timed alternating-channel tone; `frame` advances visual motion/flash using the audio clock. The click callback initializes/resumes AudioContext and fullscreen playback. Mixed Latin/CJK sample text intentionally tests glyph sharpness rather than representing application UI localization.


### Audio diagnostics v2

The [design guide](audio-quality.md) explains the mathematics, gates, and limitations.

| Module/functions | Contract |
| --- | --- |
| [audio-quality.mts](../../scripts/lib/audio-quality.mts): fixture, wav | Generate known stereo v2 material and serialize PCM16 WAV |
| Same: fit, estimateFrequency | Least-squares sinusoid model including DC, bounded frequency search; no external processes |
| Same: markerOnset, energy, analyze | Identify markers, measure power, judge format/frequency/channels/continuity; return pass, fail, or invalid |
| [audio-quality-tools.mts](../../scripts/lib/audio-quality-tools.mts): inspectAudio | Check format first; bounded decode of first 60 seconds without resampling/remixing |
| Same: recordAudio | Build/drive development app, play after capture starts, verify completion, clean up only owned children |
| [audio-quality-summary.mts](../../scripts/lib/audio-quality-summary.mts): summarize | Requested/completed counts, verdict counts, min/median/max and missing counts; incomplete batches remain incomplete |
| [CLI](../../scripts/audio-quality.mts): inspect, context, read, exitCode | Report provenance, environment snapshots, bounded external reads, exit mapping; top level owns new directory and 1–10 repeats |

## Signing identity creation

[create-signing-identity.mts](../../scripts/create-signing-identity.mts) separates archive generation from Keychain provisioning. `createIdentity(name, output, password, days)` validates inputs and destination, exclusively creates a private directory, generates and checks a self-signed code-signing identity, exports encrypted PKCS#12, and returns public metadata. It removes intermediate files on success and the new directory on failure. `openssl(args, password)` passes the password through a child environment and suppresses sensitive diagnostics. `main()` parses CLI options, preserves existing matching Keychain certificates, and requires explicit creation inputs. No Keychain mutation occurs.

## Release verification tools

[release.mts](../../scripts/release.mts) defines release gates in `validateTag` (stable or pre-release version equal to the tag), `isPrerelease` and `assertUnreleased`; `latestFlag` marks a stable release latest only when no newer stable release is public. `verifyDmg` mounts read-only and checks packaging/signatures; `assertDmgContents` requires the visible root to be exactly `Applications` and `RecordStuff.app` and rejects hidden entries other than the permitted Finder layout files, checking with `lstat` that each is a regular file rather than a directory or symlink; `verifyCandidate` checks final checksums/metadata. `context` resolves source/version/repository and `notes` produces English notes. `assertPublishedAssets` requires a non-draft release whose assets match the verified files by name, size and digest. `compareVersions`, `setPackageVersion`, `replaceMarked`, `renderDownloadSection` and `renderVerificationRecord` are the pure helpers of the record step. CLI `main` dispatches preflight, version, candidate, verify, publish, published and record; only publish writes to GitHub, and only record writes repository files, creating the public release (latest, historical or pre-release) after reverifying the candidate and the tag's commit. `start-app.mjs --verify-app` reuses `verifyBundle` without Keychain private keys.

`cleanup-release-keychain.py` only runs on disposable GitHub-hosted runners. It removes per-run trust and keychain state with a 15-second bound per command, kills timed-out process groups with a warning, and removes temporary certificate/archive files.
