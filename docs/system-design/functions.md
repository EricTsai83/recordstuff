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
| chooseDisplayMedia | Enumerate screens, match primary ID or first source, provide loopback; refuse unavailable capture |
| deny | Record concrete source failure and invoke callback without streams |
| main | Wait ready, compose dependencies, register events/actions, start permission polling and optional development recording |
| quality | Development override or persisted settings → platform-effective quality |
| handleAction | Dispatch stop/quit/settings/relaunch/Finder, quality patches, and serialized language changes |
| revealLog | Reveal the file, otherwise open its directory; log open failures |
| changeOutputDir | Native folder dialog → persist choice; failure notification or successful refresh |
| setQuality | Only idle/needsPermission; persist patch, notify on failure, refresh on success |

Process callbacks log uncaught exceptions/rejections. Recorder events render state, notify saved/error/permission, and report clear frame-rate downgrades. Before-quit coordinates shutdown; will-quit releases resources. CurrentLanguage is updated only after a successful settings save and localizes unexpected-error dialogs.

## Recording state machine

[main/recorder.ts](../../src/main/recorder.ts). Injected dependencies make timing, stale sessions, and I/O failures testable without Electron.

| Function/method | Contract |
| --- | --- |
| formatTimestamp | Date → local-time filename timestamp |
| errorCodeOf | Known cause.code or caller-provided fallback |
| delay / messageOf | Grace-period Promise / error string conversion |
| Recorder constructor | Apply clock/ID/deadline/log defaults and subscribe to host messages/failures |
| state getter | Current authoritative RecordingState |
| subscribe | Register event listener and return unsubscribe |
| toggle | Start when idle, stop when recording, request permission guidance when blocked, otherwise ignore |
| stop | Matching recording session → stopping, arm deadline, send stop |
| shutdown | Wait startup, request stop, wait completion/failure while racing quit cap |
| setPermission | Update idle/needsPermission without replacing an active recording state |
| outputDirChanged | Clear idle.outputDirUnavailable |
| start | Preflight, snapshot, session, folder probe, unique writer, host start; clean late results |
| openUniqueWriter | Try temporary/final filename pairs; retry temporary EEXIST up to ten attempts |
| handleHostMessage | Filter session, dispatch started/chunk/stopped/error, stop stale capture |
| handleChunk | Validate consecutive seq, clear first-chunk deadline, append; map rejection to failure |
| finalize | Wait writes, ensure session still current, finish file, then idle/saved |
| handleHostFailure | Fail only when a recording session exists |
| fail | Detach session, clear deadline, stop host, idle immediately, abandon writer, emit failure with optional partial path |
| clearTimer | Cancel and clear session deadline |
| setState / emit | Replace state and emit / notify registered listeners |
| nextStateChange | One-shot state subscription resolved and removed after a state event |

## Main capture supervisor

[main/capture-host.ts](../../src/main/capture-host.ts). Distinct from the same-named renderer class.

| Method | Contract |
| --- | --- |
| constructor | Paths/dev URL plus default 5-second ping and 8-second readiness deadline |
| onMessage / onFailure | Register valid-message and host-failure callbacks |
| start | Ensure readiness, then post start with session quality |
| stop | Post stop when a port exists |
| destroy | Tear down during app quit |
| ensureReady | Reuse a live window's readiness promise, otherwise create; clean up failure |
| create | Build sandbox window/channel, install guards/crash handlers, load page, hand off port, wait ready, start heartbeat |
| ping | Check for two unanswered pings before sending another; on failure tear down and emit |
| post / emitFailure | Send MainMessage / notify failure listeners |
| teardown | Clear timer, close port, reset readiness, destroy window for future recreation |

## Renderer capture and encoding

[renderer/capture-host.ts](../../src/renderer/capture-host.ts). No filesystem or arbitrary Node access.

| Function/method | Contract |
| --- | --- |
| measureFrameSize | Observe muted video intrinsic dimensions until matching size, error, or timeout; detach video in finally |
| current / matches / check | Read positive dimensions, match optional expected size, resolve measurement and clear timer |
| CaptureHost constructor | Subscribe/start port, inject frame measurer, send ready |
| handle | Validate MainMessage; ping→pong, start, or stop |
| start | Reject overlap/unsupported MIME, request stream, handle cancellation/audio validation, apply quality, start MediaRecorder |
| cancelled | During pending start, discard canceled stream, remove pending ID, send stopped |
| refuse | Remove pending ID, stop tracks, and report start failure |
| stop | Cancel pending ID or stop matching active recorder once; inactive recorder schedules terminal cleanup |
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

[main/file-writer.ts](../../src/main/file-writer.ts). NodeFs adapts open, rename, unlink, mkdir, and writeFile for injected I/O.

| Function/method | Contract |
| --- | --- |
| FileWriteError constructor | Error carrying code, path, and original cause |
| describe / errnoCode | Error text / optional filesystem errno |
| classifyWriteError | ENOSPC→disk_full; otherwise output_write_failed |
| ensureWritableDir | mkdir and write probe; throw output_open_failed on failure; remove probe best effort |
| FileWriter constructor | Store handle/paths/I/O and schedule queued sync |
| FileWriter.open | Exclusive temporary-file open → writer; wrap open failure |
| bytesWritten | Bytes counted after successful append calls |
| append | Reject if closed; queue write and increment byte count |
| finish | Queued sync, release, rename → final path; reject failure |
| abandon | Drain, best-effort close, preserve nonempty temporary file or remove empty file; never throw |
| release | Once-only closed flag, timer cleanup, and handle close |
| enqueue | Serialize operations; retain first failure and reject later operations consistently |

## Settings, quality, language, and protocol

[main/settings.ts](../../src/main/settings.ts):

| Function/method | Contract |
| --- | --- |
| parseSettings | Validate v1/v2 JSON; preserve valid folder when quality/language need defaults; return warnings |
| constructor / load | Read synchronously, validate, fall back and log; do not immediately rewrite defaults |
| outputDir / quality / language | Read successfully committed preferences |
| setOutputDir | Validate absolute path, then enqueue update |
| setQuality | Validate patch, then merge with latest committed quality inside the save queue |
| setLanguage | Validate en/zh-TW, then enqueue update without dropping folder/quality |
| save | Serialize, write, then update memory; one failed operation does not block later saves |
| write | mkdir, write JSON.tmp, rename |

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

[shared/i18n.ts](../../src/shared/i18n.ts): `isLanguage(value)` validates en/zh-TW; `translate(key, language, values)` selects an English-keyed template or Traditional Chinese translation and substitutes every named placeholder. DEFAULT_LANGUAGE is en; ZH_TW is a typed complete translation catalog. Technical logs do not use it.

[shared/protocol.ts](../../src/shared/protocol.ts): `isRecord` and `isNonEmptyString` support `isMainMessage` and `isHostMessage`; chunk validation requires nonnegative integer seq and ArrayBuffer bytes. [shared/state.ts](../../src/shared/state.ts): `isErrorCode` checks the ERROR_CODES whitelist.

[preload/index.ts](../../src/preload/index.ts) has one IPC callback rather than named functions: forward the received capture-host-port to window with transferred ports. No contextBridge API is exposed.

## Permissions

[main/permission.ts](../../src/main/permission.ts):

| Function/method | Contract |
| --- | --- |
| screenCaptureGranted | Compare Electron screen status with granted |
| openScreenCaptureSettings | Open fixed settings URL |
| countCapturableScreens | Enumerate screens without thumbnails; count or reject |
| constructor | Inject APIs/callback; default 5-second polling and 4-second validation deadline |
| start / stop | Immediate check, interval/activate callback / clear interval |
| markRelaunchRequired | If OS still grants access, invalidate cache and recheck |
| check | Reset/prompt when denied; emit cached success; otherwise validate |
| promptOnce | One registration/prompt getSources call per process; log result |
| validate | Deduplicate, time out, recheck grant, cache real source access or request relaunch |
| emit | Suppress identical permission states |
| withTimeout | Race promise with timer and clear timer on settlement; does not cancel OS request |

## Tray presentation

[main/tray-model.ts](../../src/main/tray-model.ts):

| Function | Contract |
| --- | --- |
| abbreviateHome | Shorten exact home or complete path prefix, avoiding similarly named folders |
| disabled / item | Build disabled/enabled model entries |
| footer | Localized Language radio group, Show log, and Quit in every state |
| outputDirItems | Folder label and selection action with state-dependent enablement |
| radioGroup | Checked/enabled quality options carrying setQuality patches |
| qualityMenu | Three translated quality submenus; disable unverified platform frame rates |
| permissionActions | Relaunch alone when required; otherwise settings and fallback relaunch |
| trayModel / text / model | Pure state/context projection with local translation/status helpers |
| notice | Wrap body with product title |
| savedNotification | Basename → localized completion text |
| permissionNotification | Localized settings/relaunch guidance |
| settingsWriteFailedNotification | Explain unchanged output folder after failed save |
| qualityWriteFailedNotification / languageWriteFailedNotification | Explain retained quality/language |
| frameRateDowngradeNotification | Include actual and requested fps |
| trayHintNotification | Windows first-run tray discovery text |
| errorNotification(code, partialPath, ctx) | Localize error summary/recovery and preserved-file guidance; technical detail stays in logs |

[main/tray.ts](../../src/main/tray.ts):

| Function/method | Contract |
| --- | --- |
| AppTray constructor | Load icons, create Tray, ignore double-click events, bind left/right clicks |
| render / refresh | Remember presentation state and update image/title/tooltip; refresh rereads context |
| destroy | Destroy native Tray |
| notifySaved | Current-language saved notice with reveal callback |
| notifyError(code, partial) | Error notice; partial path takes precedence over recovery actions |
| revealFromNotification / reveal | Defer macOS Finder call and record requested/failed |
| notifyPermission | Current-language guidance with settings/relaunch callback |
| notifySettingsWriteFailed / notifyQualityWriteFailed / notifyLanguageWriteFailed | Current-language failed-save notices |
| notifyFrameRateDowngrade / notifyTrayHint | Informational localized notifications |
| show | Support check, silent Notification, click/failed handlers, show |
| log | Invoke optional injected logger |
| popUpMenu | Rebuild current model and show native menu |
| toTemplate | Recursively map model to Electron menu templates/actions |
| loadIcons | Windows ICO or template PNG assets |

## Logging and automatic recording

[main/log.ts](../../src/main/log.ts): `rotatedPath` constructs archive names; `rotateLog` removes the oldest and shifts archives; `formatLine` adds UTC ISO time; `createFileLogger` returns a synchronous logging closure. Nested `sizeOf` reads length (failure→0); `appendToFile` creates the directory, rotates, and appends. The returned function writes stdout first and disables file logging after an error.

[main/autorecord.ts](../../src/main/autorecord.ts): `parseAutoRecord` ignores packaged/empty input, validates seconds in (0,3600] and quality keys, and merges defaults. `runAutoRecord` waits 1.5 seconds before toggle, starts its stop timer only after recording begins, and quits after saved/failed/needsPermission through once-only `finish`. It does not write settings.

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

[scripts/make-icons.mjs](../../scripts/make-icons.mjs): `coverage` supersamples geometry; `circle`, `ring`, and `roundedSquare` create masks; `rasterize` composites RGBA; `chunk` constructs PNG chunks with CRC; `png` and `ico` encode formats; `idleShape`, `recordingShape`, and `appIcon` define assets. Top-level generation writes resources and invokes iconutil on macOS.

## Verification tools

See [tooling](tooling.md) for pipeline and thresholds. These tools are development-only.

| Source/functions | Contract |
| --- | --- |
| [probe-recording.mjs](../../scripts/probe-recording.mjs): probe, ratio, kbps, fixed | Run ffprobe, parse ratios, format quick inspection output |
| [verify-recording.mts](../../scripts/verify-recording.mts): usage, next | CLI help/exit 2 and argument values; top-level loop verifies files and returns failure exit status |
| [lib/media-tools.mts](../../scripts/lib/media-tools.mts): ToolMissingError, run, hasTool | External-tool error, bounded-buffer subprocess invocation, availability check |
| Same: probe | Container/stream/frame count and decode errors |
| Same: frameTimes, read | PTS intervals; long files sample head/tail separately |
| Same: channelRms, syncMarkers | Per-channel astats energy and flash/beep times |
| [lib/verify-recording.mts](../../scripts/lib/verify-recording.mts): readLogText, readLogPairs | Active plus newest archive; optional capture/saved pairing |
| Same: verifyRecording | Probe/frame/RMS/optional sync → measure → judge → result |
| Same: parseDimensions | WxH string → dimensions or undefined |
| Same: tryExec, environmentSummary | Best-effort machine/OS/Electron/display/tool facts |
| Same: localDate, measurementsPath | Local date → evidence filename |
| Same: appendMeasurements | Initialize environment header, append Markdown, write structured JSON |
| [run-matrix.mts](../../scripts/run-matrix.mts): shorten, usage | Change case duration / show CLI help |
| Same: mainDisplaySize, outputDir | Primary-display dimensions and configured/default folder |
| Same: sleep, electronPids, cpuPercent | Inter-case delay and app-process CPU sampling |
| Same: logPosition, readFrom, logSince | Read only this run's log, accounting for rotation |
| Same: recordOnce | Launch development app with automatic-recording config, sample CPU, await outcome |
| Same: main | Validate prerequisites, open material, run cases, verify/save results, clean up |

### Pure measurement logic

[scripts/lib/verify.mts](../../scripts/lib/verify.mts) never spawns processes.

| Functions | Contract |
| --- | --- |
| numberOrUndefined, parseRatio | Parse numeric values/fractions or return undefined |
| parseCaptureLine | Extract requested/track/target/warnings from capture log |
| pairRecordingsWithLog, basename | Pair sessions and saved filenames across path styles |
| parseAutorecordOutcome | Extract saved/failed outcome |
| parseFrameTimes, frameStats | Parse PTS and measure per-interval gaps/drops without crossing unsampled regions |
| dropEofClosures | Remove detector closure artifacts near EOF |
| parseBlackdetect, parseSilencedetect | Parse flash/audio boundaries and discard EOF artifacts |
| parseChannelRms | Parse per-channel energy |
| median, syncStats | Match sufficient markers and estimate offsets/head-tail drift |
| measure | Combine stream/container/frame/decode/audio/CPU/sync facts |
| fmt, mbps, kbps, ms | Format values and unknowns |
| pass, offsetWithinLimits, aspectMatches | Verdict, asymmetric offset bounds, aspect tolerance |
| judge | Produce threshold checks and unavailable notes |
| overallVerdict | Any fail→fail; any pass and no fail→pass; otherwise n/a |
| describeRequested, formatText, width, pad | Human-readable requested settings and aligned terminal table |
| cell, formatMarkdown | Escape table cells and produce evidence section |

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

[release.mts](../../scripts/release.mts) defines release gates in `validateTag`, `validateDigest`, `assertUnreleased`, and `assertPromotion`. `verifyDmg` mounts read-only and checks packaging/signatures; `verifyCandidate` checks final checksums/metadata. `context` resolves source/version/repository and `notes` produces English notes. CLI `main` dispatches preflight, candidate, verify, draft and promote; only the last two write to GitHub, and only promote publishes. `start-app.mjs --verify-app` reuses `verifyBundle` without Keychain private keys.

`cleanup-release-keychain.py` only runs on disposable GitHub-hosted runners. It removes per-run trust and keychain state with a 15-second bound per command, kills timed-out process groups with a warning, and removes temporary certificate/archive files.
