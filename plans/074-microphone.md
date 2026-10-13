# 074 — Record the microphone with system audio

[English](074-microphone.md) | [繁體中文](074-microphone.zh-TW.md)

Status: planned; not started. Created: 2026-10-14. Priority: after 076. Hard dependencies: 076; this plan uses the native engine's microphone input and mixer, so the Chromium mixing first written here (an `AudioContext` in the capture renderer) is replaced by the engine design in step 4. Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Let a recording carry the user's microphone together with the system audio it carries today, so a narrated screen recording needs no second tool. Success is: with the microphone on, a saved MP4 holds one AAC track in which both the system audio and the microphone are audible and in sync with the picture; with it off, the recording path, the file and the [audio fidelity](../docs/system-design/audio-quality.md) results are exactly what they are now; the microphone is opened only between preparation and stop; and a missing permission or device is explained before any countdown, as a missing system-audio track is today.

Out of scope: separate microphone and system tracks or sidecar files, per-track volume or an editor, camera capture, live level meters outside Settings, noise gates or voice effects beyond step 1's processing decision, and a Windows hardware round (CI only, as for every Windows change).

## Should it be a switch? (assessment)

Yes, and off by default. Reasons, strongest first:

1. **Privacy and trust.** Recording someone's voice without a deliberate choice is the worst failure a recorder can have. Off by default means no existing user starts recording their room after an update, and the macOS microphone prompt appears only when the user asks for the feature, in context, instead of at the next recording.
2. **Not every recording wants it.** Recording a video, a game or a call that already contains the user's voice (meeting apps play back the mix) would get a second, echoing copy of the voice or room noise.
3. **Speakers leak.** With loudspeakers the microphone records the system audio a second time, delayed; echo cancellation only helps if it is given that output as its reference, which step 1's processing decision weighs. Headphones avoid it; a switch lets speaker users keep clean recordings.
4. **No change for the default path.** With the switch off nothing new is opened, mixed or processed, so the recorded audio-quality evidence stays valid without re-measurement.

What the switch does not need to be: a per-recording prompt (it would add a step to a one-click recorder) or a choice of mixing levels. Whether it also lives in the tray menu, and whether there is a device picker, are step 1's decisions.

## How Cap does it

Static comparison of the inspected scope at Cap revision `3d19c5cfa5e636107e78adde6d55be78404d4f23` (2026-10-14), read without running it; this plan pins that revision instead of the index's older one (see [sources](README.md#sources-and-evidence-boundaries)). It is not evidence that Cap handles these cases.

| Topic | Cap | Where |
| --- | --- | --- |
| Control | No separate switch: the microphone picker has a "No Microphone" entry, which is off. System audio has its own On/Off switch. Both start off, persist across launches and are locked while recording | `apps/desktop/src/routes/(window-chrome)/new-main/MicrophoneSelect.tsx`, `SystemAudio.tsx`, `apps/desktop/src/utils/queries.ts` |
| Level meter | The picker and the in-progress window show the input level in dB | `MicrophoneSelect.tsx`, `in-progress-recording.tsx` |
| Capture (macOS) | Microphone through cpal (CoreAudio); system audio through ScreenCaptureKit, macOS 13 or later | `crates/recording/src/feeds/microphone.rs`, `crates/recording/src/sources/screen_capture/macos.rs` |
| Storage | Studio mode: separate microphone and system files per segment, mixed in the editor with per-track volume and on export. Instant mode: mixed live into one track (ffmpeg `amix`) | `crates/recording/src/studio_recording.rs`, `instant_recording.rs`, `sources/audio_mixer.rs`, `crates/project/src/configuration.rs` |
| Sync | Audio timestamps from cumulative sample counts on a shared master clock; the mixer fills gaps with silence; system audio is anchored to the recording start because it only delivers packets while something plays | `crates/timestamp/src/master_clock.rs`, `audio_mixer.rs` |
| Permission | AVFoundation status and request; clicking the picker asks; setup is refused with "Click the microphone control to allow access" (not asked yet) or "Allow Cap in System Settings > Privacy & Security > Microphone" (denied), with a link to that pane | `apps/desktop/src-tauri/src/permissions.rs` |
| Device lost | Recording continues with silence and a notification ("Microphone disconnected — Recording continues…"); the device reconnects when it returns | `apps/desktop/src-tauri/src/lib.rs`, `microphone.rs` |

What RecordStuff takes from it: off by default and persisted; locked while recording; the permission asked when the user turns it on, with a pane link when denied; a lost device continuing with silence and telling the user. What it does not take: separate tracks and an editor (RecordStuff has no editor, so one mixed track, Cap's Instant mode, is the natural form); from 076 RecordStuff also has a native engine, which takes Cap's approach to clocks: sample-count timestamps and silence for gaps; a level meter and reconnection, which are follow-ups if asked. Cap's picker-as-switch is offered in step 1 as an alternative.

## Current state

This is the state before 076, which replaces the capture renderer below with a native engine; step 4 is written against that engine.

- The capture host (`src/renderer/capture/capture-host.ts`) calls `getDisplayMedia` once; main's display-media handler (`src/main/index.ts`) answers with the chosen screen and `audio: "loopback"`. The audio constraints disable echo cancellation, noise suppression and AGC and keep `restrictOwnAudio`, for the reasons in [audio quality §15](../docs/system-design/audio-quality.md#15-system-capture-correction--2026-09-14).
- One `MediaRecorder` encodes the stream to fragmented MP4 (H.264 + AAC 256 kbps). Chromium's `MediaRecorder` encodes only the first audio track of a stream, so two audio tracks cannot simply be added: they must be mixed into one track before the encoder.
- No code calls `getUserMedia`, and there is no session permission handler, so Electron grants a renderer's media request and leaves the OS prompt to macOS. `electron-builder.yml` declares `NSScreenCaptureUsageDescription` and `NSAudioCaptureUsageDescription` but not `NSMicrophoneUsageDescription`, and `resources/entitlements.mac.plist` lacks `com.apple.security.device.audio-input`, which the hardened runtime requires for microphone access.
- [Overview](../docs/system-design/overview.md), README, README.zh-TW and the website's help page (`website/src/components/HelpContent.astro`) state that there is no microphone. [WebRTC](../docs/system-design/webrtc.md) already notes that microphone narration needs its own audio policy and that the system track must not inherit speech processing.

## Steps

### 1. Decide the controls and the failure policy (decision point)

- [ ] Where the switch lives. Recommended: a "Microphone" switch in Settings → Recording, locked during a session like the other recording settings, plus a checked "Record microphone" item in the tray menu, because it is a per-recording choice and the tray is where recordings start. Alternatives: Settings only; or, as Cap does, one picker whose first entry is "No microphone", which merges this decision with the next.
- [ ] Which microphone. Recommended for this plan: the system default input (the engine follows the system default), with the card naming the device currently in use; a device picker is a follow-up only if asked. Alternative: a picker with "System default" first, storing the device id and label, falling back to the default with a note when the stored device is absent. The engine enumerates devices and their stable ids.
- [ ] Start policy when the switch is on but the microphone is denied or absent. Recommended: refuse the start with a new `microphone_unavailable` code and recovery guidance, before any countdown, as `no_audio_track` does; a recording the user expected to narrate is lost if it silently records without the voice, and Cap also refuses setup without the permission. Alternative: record system audio only and show a warning.
- [ ] Mid-recording loss (device unplugged, permission revoked). Recommended, as Cap does: keep recording, since the mixed track continues with system audio and the file stays valid; log it, notify once ("Microphone disconnected; recording continues without it") and mark the saved result with a warning. No reconnection in this plan. Alternative: stop and save as the display loss path does.
- [ ] Microphone processing. With 076's native engine there is no Chromium processing. Recommended: the raw microphone, mixed with the unprocessed system audio at unity gain without a compressor; the platform's voice processing (macOS voice processing I/O, the Windows communications pipeline) is not used, because on macOS it can lower other apps' output, which would change the recorded system audio. Headphones are the advice for speaker echo. Alternative: platform voice processing on the microphone only, if step 6 shows it leaves the system audio untouched.

This plan pauses at this step until the maintainer answers.

### 2. Permission and packaging

- [ ] Add `NSMicrophoneUsageDescription` to `mac.extendInfo` and `com.apple.security.device.audio-input` to `resources/entitlements.mac.plist`; confirm with `codesign -d --entitlements` on a `pnpm start:app` bundle.
- [ ] Turning the switch on calls `systemPreferences.askForMediaAccess("microphone")` from main (macOS), so the prompt follows the user's action; the setting is saved even when denied, and the card then shows the denial with an action opening System Settings → Privacy & Security → Microphone (`x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`). `getMediaAccessStatus("microphone")` supplies the card's status, rechecked when the window gains focus, as screen permission is.
- [ ] Windows: no prompt API; a refused device open maps to the same code with Windows guidance (Settings → Privacy & security → Microphone).

### 3. Settings and protocol

- [ ] `src/main/settings/settings.ts`: `microphone: boolean`, default false, parsed with the existing `field` pattern (an invalid value falls back to off and logs). If step 1 chose a picker, also `microphoneDevice?: { id: string; label: string }`.
- [ ] `src/shared/protocol.ts`: the `start` message carries `microphone: { enabled: boolean; deviceId?: string }`; add `microphone_unavailable` to `HOST_ERROR_CODES`; `tests/capture-protocol.test.ts` covers both.
- [ ] `src/main/recording/recording-result.ts`: message and guidance for `microphone_unavailable` on both platforms, grouped with the permission failures only when the cause is a denial.
- [ ] The session's `prepared` log line ends with `mic on` / `mic off`, as it does for the countdown sound, and the `CaptureReport` records the microphone track's label and settings.

### 4. Microphone through the native engine

- [ ] With the microphone off, the engine opens no input and its audio path is exactly 076's.
- [ ] With it on, the `start` message carries the microphone choice; the engine opens the device in preparation (076's microphone input), and a denial, a missing device or a failed open refuses with `microphone_unavailable` before `prepared`, releasing everything already opened.
- [ ] The engine mixes the microphone into the one AAC track: 48 kHz, stereo, the mono microphone up-mixed to both channels, timestamps from sample counts on the session clock, gaps filled with silence.
- [ ] Lifecycle: the device closes on every exit path 076's engine uses for capture, so a cancelled countdown never leaves the microphone open (the macOS orange indicator must disappear). The microphone's loss follows step 1's mid-recording policy.
- [ ] Tests: Rust tests for the mixer (levels, up-mix, gaps, long-run alignment); host tests for the off path, refusal before `prepared`, cancel during opening and loss during recording.

### 5. Settings UI and tray

- [ ] `src/main/settings/settings-model.ts`: a `microphoneGroup` in the Recording section after the countdown sound, using `switchChoices`, with the permission status and the action from step 2; the ⓘ says headphones avoid recording speaker sound twice. New strings into `ZH_TW` in `src/shared/i18n.ts`.
- [ ] If step 1 chose the tray item: a checkbox item in the idle menu (`src/main/menus/`), disabled while a session runs.
- [ ] Page tests for the Recording tab (switch, locked while recording, denied status, zh-TW) and `settings-model.test.ts` for darwin and win32. Behavior and accessibility only, no design values.

### 6. Measurement

- [ ] Fidelity of the system part when mixed: run the relevant `pnpm audio:quality` diagnostics with the microphone on and muted (or a silent virtual input) and compare against the microphone-off baseline. The mixer must not resample, collapse stereo or change level; any difference is recorded, not tolerated silently.
- [ ] Ducking: measure the system part's level with the microphone on against off; any drop is a finding against step 1's processing decision.
- [ ] Sync: a recording with a clap or click heard by the microphone and shown on screen, checking the voice against the picture; record the measured offset.
- [ ] CPU: `pnpm measure:cpu` with the microphone on, against the [CPU budget](../docs/system-design/tooling.md#cpu-budget); the microphone adds an input stream and the mixer to the engine.

### 7. Documentation

- [ ] [Recording](../docs/system-design/recording.md): the start sequence's microphone step, the mixing graph, the lifecycle and the new error; [audio quality](../docs/system-design/audio-quality.md) and [WebRTC](../docs/system-design/webrtc.md): the microphone's processing policy and the step 6 results; [desktop](../docs/system-design/desktop.md): the microphone permission. Mirror each in `docs/zh-TW/`.
- [ ] Remove "without microphone" from the overview, README, README.zh-TW and the website's help page.
- [ ] Learning articles: write the articles in [the index's list](README.md#learning-articles-from-074076) whose sources have all closed with this plan, divided by subject rather than by plan.

## Completion and verification boundaries

Complete when step 1's decisions are recorded; the switch, permission handling, mixing and failure paths behave as decided; step 6's measurements are recorded with their limits; tests and documentation are updated.

Checks follow [the testing policy](../docs/testing.md#select-tests-from-behavior). This changes the capture host and protocol, permissions and packaging, so the recording row applies: `pnpm check` plus a recording smoke round on a fresh `pnpm start:app` bundle with the microphone off and on (start, stop, save, media verification, playback with both sources audible), and the cancelled-countdown case confirming the microphone indicator clears. The fidelity row adds step 6's `pnpm audio:quality` runs; the CPU row adds `pnpm measure:cpu`; the Recording tab's scope (`pnpm test:scope -- recording-settings`) covers the Settings UI, and a tray item adds `pnpm acceptance:tray`. The permission prompt and denial need a native round after `tccutil reset Microphone com.ericts.record`, following the [desktop handoff](../docs/testing.md#confirm-desktop-handoff-before-testing) and the [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md). Device removal mid-recording needs a removable microphone (for example Bluetooth headphones); if none is available it is reported as untested. Windows is checked by CI only, so the Windows microphone path stays unverified.

Writing this plan needs only: links and anchors, existing and proposed commands, English/Chinese parity and `git diff --check`; no tests, build or app launch.

At closure, record the design in the system-design documents and the results with their translation in the verification record, update both indexes and remove the plan files under the project's completion rules. Do not commit, push or publish unless the user asks.
