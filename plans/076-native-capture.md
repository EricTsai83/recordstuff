# 076 — Native capture engine for macOS and Windows

[English](076-native-capture.md) | [繁體中文](076-native-capture.zh-TW.md)

Status: planned; step 1 decided on 2026-10-14, implementation not started. Created: 2026-10-14. Priority: next, before 074 and 075, because its result decides where 074 mixes the microphone and how 075 keeps RecordStuff's windows out of the recording. Hard dependencies: none. Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Replace the part of recording that Chromium and the file writer do today, capturing the screen and system audio, encoding, muxing and writing the file, with a native Rust module that runs in an Electron `utilityProcess`, on macOS and Windows in the same plan. Electron, TypeScript, the Settings window, the tray, the Recorder's state machine, the file's lifecycle (name, sentinel, history, notifications) and the library stay. Success is: on both platforms a recording made through the native engine matches today's recordings or is better on the measured quality, frame timing, audio fidelity and CPU; the engine exposes the capabilities listed below; the old Chromium capture path is removed at closure; macOS is verified on hardware and Windows by CI, as step 1 records.

Capabilities the engine provides in this plan, with the user-facing settings that use them now:

| Capability | macOS | Windows | User-facing in this plan |
| --- | --- | --- | --- |
| Whole display with system audio (today's behavior) | ScreenCaptureKit | Windows.Graphics.Capture, WASAPI loopback | yes, unchanged |
| RecordStuff's own windows left out | `SCContentFilter` excluding the app's windows | `WDA_EXCLUDEFROMCAPTURE` on its windows | yes, always on (075's D14) |
| Hide system UI: menu bar, Dock, desktop icons and widgets | `SCContentFilter` excluding those windows | not possible with Windows.Graphics.Capture (taskbar); step 1 decides | yes, a switch in Settings → Recording |
| Microphone input mixed into the audio track | AVFoundation or Core Audio input | WASAPI capture | used by 074 |
| One window, an area, chosen apps; one app's audio | `SCContentFilter`, `sourceRect`; app-filtered audio | Windows.Graphics.Capture window item, crop; process loopback (Windows 10 2004+) | engine and tests only; the pickers are a later plan |

Out of scope: a browser tab (only a browser or its extension can capture a tab, so it is a separate product), moving to Tauri, an editor or separate tracks, and the pickers for window, area and app.

## Why native capture, why Rust, why not Tauri (assessment)

- **A concrete limitation has been measured.** [Design decisions](../docs/system-design/decisions.md) say to consider native capture "only after measuring a concrete limitation". Chromium's `getDisplayMedia` captures one display or one window and can exclude only this app's own protected windows (Electron patches Chromium for that); it cannot hide the menu bar, Dock or desktop, capture an area or chosen apps, or capture one app's audio. Each item the maintainer asked for on 2026-10-14 needs `SCContentFilter` on macOS, which no Electron or Chromium API exposes.
- **What others do.** Mature desktop recorders capture natively: OBS (per-platform capture plugins), Cap (Rust, ScreenCaptureKit on macOS, Windows.Graphics.Capture on Windows), Screen Studio and CleanShot X (native macOS). Browser-based recorders (Loom's extension, Screenity) are limited to browser APIs.
- **Rust, one language for both platforms.** The operating systems expose their APIs through binary calling conventions (the Objective-C runtime and C on macOS; C, COM and WinRT on Windows), so any compiled language can call them. Swift is Apple's first language and the most direct on macOS, but does not help on Windows. Rust reaches ScreenCaptureKit through binding crates (Cap uses `cidre` in production), and `windows-rs` is Microsoft's own binding. One language keeps one capture pipeline, one muxer and one set of tests. The cost is a Rust toolchain in the two CI jobs that already exist (`check.yml` and `release.yml` already build on `macos-15` and `windows-2025`), build caching, and bindings that may lag a new Apple API. Combining TypeScript with Rust is common: Cap (TypeScript UI, Rust backend), Signal Desktop (Electron with Rust libsignal), 1Password 8 (Electron with a Rust core), and JavaScript tools built with napi-rs.
- **Why `utilityProcess`.** A crash in native code then ends that child process, not the app: what was already written stays on disk in its recoverable form, and main finishes the file and reports the failure. It also keeps today's shape, a separate capture process that talks to main over a `MessagePort` (`prepared`, `record`, `stop`, progress), so the Recorder's state machine changes little.
- **Why not Tauri.** Tauri is also TypeScript plus Rust (its UI is HTML in WKWebView or WebView2). Moving would rewrite about 14,600 lines of main, shared and preload code and about 32,000 lines of tests and acceptance tools that rely on Electron, and change the Mac web engine, for gains in app size and memory that [the plan index](README.md) already declined to rewrite for. The Rust capture module carries over unchanged if a move is ever chosen, so this plan is not a dead end.

## Current state

- `src/renderer/capture/capture-host.ts`, a hidden renderer, calls `getDisplayMedia` (main's handler in `src/main/index.ts` answers with the screen and `audio: "loopback"`) and encodes with `MediaRecorder` to fragmented MP4 (H.264 + AAC 256 kbps), sending one chunk per second over the protocol in `src/shared/protocol.ts`.
- `src/main/recording/recorder.ts` runs the session; `file-writer.ts` writes chunks, syncs every 5 s and keeps the session sentinel; `mp4-finalize.ts` follows fragments and makes the file plain MP4 at save ([recording](../docs/system-design/recording.md)).
- Quality settings, the frame-rate request and the audio constraints are in `src/shared/quality.ts` and `src/renderer/capture/apply-quality.ts`; their reasons are in [recording](../docs/system-design/recording.md#quality-and-encoding) and [audio quality](../docs/system-design/audio-quality.md).
- Verification tools that record through the app: `pnpm acceptance`, `pnpm matrix`, `pnpm audio:quality`, `pnpm measure:cpu`, `pnpm acceptance:lifecycle` ([tooling](../docs/system-design/tooling.md)).
- Cap's license (revision `3d19c5cfa5e636107e78adde6d55be78404d4f23`): the `scap-*` and `camera*` crates, including `scap-screencapturekit`, `scap-direct3d`, `scap-targets` and `scap-ffmpeg`, are MIT; everything else, including its recording pipeline, encoders and muxer, is AGPLv3 and must not be copied into this MIT project.

## Steps

### 1. Decide (decision point)

- [x] **D1 Language (decided 2026-10-14: Rust for both platforms).** Recommended: Rust for both platforms (napi-rs). Alternative: Swift on macOS and Rust or C++ on Windows, which is the most direct on macOS and gets new Apple APIs first, at the cost of two native languages.
- [x] **D2 Process (decided 2026-10-14: `utilityProcess`).** Recommended: the module loaded in an Electron `utilityProcess`, talking to main over a `MessagePort` with the existing message shapes. Alternatives: loaded in main (simplest, but a native crash ends the app), or a separate executable (isolated, but macOS's screen permission must then be proven to apply to it).
- [x] **D3 Who writes the file (decided 2026-10-14: the engine).** The engine captures, encodes, muxes and writes the file, syncing periodically and writing a crash-recoverable fragmented form that becomes plain MP4 at save, as OBS's hybrid MP4 and today's `mp4-finalize.ts` do. Main keeps the file's lifecycle: the name and folder, the free-space check before start, the session sentinel, the history entry, notifications, and the state machine with quit and sleep; the engine reports bytes written and write errors (disk full, write failed) as events. Reasons: most containers need to seek back to finish (MP4's index, MKV's sizes and cues), which a chunk stream to main cannot do cleanly once output formats are selectable; a stalled main event loop no longer delays writing; and media stays in one language. `file-writer.ts` and `mp4-finalize.ts` are rewritten in Rust, carrying over their design and test cases. Rejected: chunks to main's existing writer, which changes least today but blocks other containers.
- [x] **D4 Encoding and muxing (decided 2026-10-14).** Two replaceable layers. Encoders: the platform's hardware encoders, VideoToolbox and AudioToolbox on macOS, Media Foundation on Windows (hardware when the GPU offers it, Microsoft's software encoder otherwise; Windows N editions without the Media Feature Pack get a clear error). Muxer: an ISO BMFF muxer written for this project in Rust, covering MP4 and MOV, writing OBS-style hybrid MP4 (fragmented while recording, plain at save). This plan ships H.264 + AAC in MP4, today's format; HEVC and MOV are later settings on the same layers. Other formats (GIF, WebM, MKV) belong to a later export feature, which may bring FFmpeg in for conversion only. Basis: recorders capture with system encoders and a lean muxer (Chromium, Cap, Kap, QuickTime, OBS's hybrid MP4) and use FFmpeg for export or broad format support; no FFmpeg in the recording path keeps the app small and free of LGPL linking.
- [x] **D5 Reuse from Cap (decided 2026-10-14).** Depend on or adapt Cap's MIT `scap-*` crates where they fit, keeping their license notices, and record each crate, license and revision. Cap's AGPL code is a design reference only: it may be read to understand an approach, but nothing is copied or translated line by line, and the implementation follows Apple's and Microsoft's documentation and the ISO BMFF specification.
- [x] **D6 Hide system UI (decided 2026-10-14).** A "Hide menu bar and Dock" switch in Settings → Recording, off by default, macOS only: the recording leaves out the menu bar, the Dock, desktop icons and widgets while the user still sees them; the ⓘ says that an app's open menu is still recorded, because it is that app's window. On Windows the switch is shown unavailable with the reason (Windows.Graphics.Capture cannot leave out the taskbar), and nothing is cropped. Off by default because existing recordings must not change after an update and what is on screen is what users expect to be recorded; Loom and CleanShot X also offer this as an option.
- [x] **D7 Transition (decided 2026-10-14).** Keep the Chromium path behind a development flag for side-by-side comparison until the native engine passes step 7 on macOS, then remove it in this plan; Windows switches with it and is checked by CI (D8).
- [x] **D8 Windows verification (decided by the maintainer on 2026-10-14).** Windows is verified by CI only, as every Windows change is today: the `windows-2025` jobs build the module, run its tests and load it, and record through it as far as the runner's desktop allows. What CI cannot exercise is listed as untested in the plan's closure and in the release record, and is left to users' reports; there is no Windows hardware or virtual-machine round.

All of step 1 was decided by the maintainer on 2026-10-14.

### 2. macOS prototype and measurement gate (decision point)

- [ ] A minimal Rust module records the chosen display with system audio through ScreenCaptureKit, excludes RecordStuff's windows, optionally hides the menu bar and Dock, encodes with VideoToolbox and AudioToolbox and writes a hybrid MP4 file through the D4 muxer.
- [ ] Confirm the screen and system-audio permission prompts and grants apply to the module in the `utilityProcess` (TCC attributes it to RecordStuff), on a signed `pnpm start:app` bundle.
- [ ] Crash and stop safety: kill the `utilityProcess` mid-recording and confirm main turns what was written into a playable file, as today's interrupted-recording handling expects.
- [ ] Measure against today's engine on the same machine: `pnpm audio:quality` fidelity, a `pnpm matrix -- quick` and `fps` subset, `pnpm measure:cpu -- --fps 60 --repeat 3`, start latency, and a 10-minute recording's drift between audio and picture.
- [ ] Report the numbers to the maintainer. This plan pauses here: continue, change approach (for example D1's Swift alternative), or stop and keep the Chromium path.

### 3. Windows prototype

- [ ] The same module on Windows: Windows.Graphics.Capture for the display, WASAPI loopback for system audio, Media Foundation H.264/AAC, the shared muxer; `WDA_EXCLUDEFROMCAPTURE` on RecordStuff's windows.
- [ ] In CI on `windows-2025`: build, `cargo test`, load the module, and try a short display recording with system audio. Whether the runner's session can capture at all is itself a finding; when it cannot, the recording is listed as untested rather than failed.

### 4. The engine

- [ ] Add the Rust crate (proposed `native/capture/`) with napi-rs bindings, `cargo test` for the muxer, timestamps and source filters, and platform modules behind one Rust interface.
- [ ] Writing (D3): the Rust writer and muxer take over `file-writer.ts` and `mp4-finalize.ts` (periodic sync, write-error classification, fragment index, plain MP4 at save), with their test cases ported; main keeps the sentinel, the free-space check, publication and history, and drops the two TypeScript modules at closure.
- [ ] Clock and sync: one monotonic clock per session (mach absolute time; QueryPerformanceCounter); audio timestamps from cumulative sample counts and gaps filled with silence, as Cap does, so audio never drifts against video over long recordings.
- [ ] Inputs: display (now), window, area and app filters, per-app audio (engine and tests only), microphone (for 074), each with clear errors mapped to the existing `HostErrorCode`s or new ones.
- [ ] Quality: the existing settings in `src/shared/quality.ts` (size cap, frame rate, bit rates) applied natively; the `CaptureReport` keeps its fields so the Recorder, logs and warnings stay as they are.

### 5. Integration

- [ ] Replace the hidden capture renderer with a `utilityProcess` host that loads the module and speaks the existing protocol (`ready`, `ping`/`pong`, `start` → `prepared` with the file path from main, `record`, progress and write errors, `stop` → finished, failures), so `recorder.ts` keeps its states, deadlines, countdown and quit handling; adjust only what the new host needs.
- [ ] Remove the display-media handler and loopback request from `src/main/index.ts` once D7's flag is gone; keep display selection and its diagnostics.
- [ ] Settings → Recording: the D6 switch, with zh-TW strings; 075's own-window rule moves here and is always on.

### 6. Build and release

- [ ] Rust toolchain and cargo cache in `check.yml` and `release.yml` on both runners; the `.node` binary unpacked from asar and signed with the app on macOS; the Windows installer smoke covers loading it.
- [ ] `pnpm check` runs `cargo test` and a load test of the built module; contributor setup in [CONTRIBUTING.md](../CONTRIBUTING.md) names the Rust requirement.

### 7. Verification tools and acceptance

- [ ] Adapt `pnpm acceptance`, `pnpm matrix`, `pnpm audio:quality`, `pnpm measure:cpu` and `pnpm acceptance:lifecycle` to the new host, with the same reports.
- [ ] macOS: full recording acceptance, the matrix cases the plan's risks touch, the audio fidelity suite, a new CPU baseline (`pnpm measure:cpu -- --fps 60 --repeat 3`), lifecycle, quit and sleep during recording, permission denial, display removal, own windows absent from frames, and the D6 switch.
- [ ] Windows: the CI checks of step 3 and the installer smoke; everything CI cannot show (real capture quality, own windows absent, system audio content, CPU, frame timing) is listed as untested.

### 8. Documentation

- [ ] Update [decisions](../docs/system-design/decisions.md) (the Electron/TypeScript, built-in `getDisplayMedia`/`MediaRecorder` and hidden capture renderer rows), [architecture](../docs/system-design/architecture.md), [recording](../docs/system-design/recording.md), [audio quality](../docs/system-design/audio-quality.md), [WebRTC](../docs/system-design/webrtc.md), [tooling](../docs/system-design/tooling.md), [functions](../docs/system-design/functions.md), [repository](../docs/system-design/repository.md) and [overview](../docs/system-design/overview.md), each with its `docs/zh-TW/` translation; README and the website's help page for the D6 switch.
- [ ] Note in 074 and 075 what the engine now provides.
- [ ] Learning articles: write the articles in [the index's list](README.md#learning-articles-from-074076) whose sources have all closed with this plan, divided by subject rather than by plan.

## Completion and verification boundaries

Complete when step 1 and step 2's decisions are recorded; macOS records through the native engine with results at least equal to today's on the measured axes, or with each regression recorded and accepted by the maintainer, and Windows passes its CI checks with the rest listed as untested; own windows are absent and D6 works on macOS; the Chromium path is removed; documentation and the learning articles due at this closure are updated.

Checks follow [the testing policy](../docs/testing.md#select-tests-from-behavior). This changes recording start/stop, the capture host and protocol, encoding, permissions, packaging, CPU and audio fidelity, so every one of those rows applies: `pnpm check` plus a recording smoke round on a fresh `pnpm start:app` bundle, the affected `pnpm matrix` cases, `pnpm audio:quality`, `pnpm measure:cpu` with a new baseline, and `pnpm acceptance:lifecycle`; the final run is `pnpm acceptance:regression`. Desktop rounds follow the [desktop handoff](../docs/testing.md#confirm-desktop-handoff-before-testing) and the [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md). Windows is checked by CI only (D8); its untested cases are listed in the closure record, not reported as passed.

Writing this plan needs only: links and anchors, existing and proposed commands, English/Chinese parity and `git diff --check`; no tests, build or app launch.

At closure, record the design in the system-design documents and the results with their translation in the verification record, update both indexes and remove the plan files under the project's completion rules. Do not commit, push or publish unless the user asks.
