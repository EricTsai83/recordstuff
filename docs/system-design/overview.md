# Product Overview

[English](overview.md) | [繁體中文](../zh-TW/system-design/overview.md)

RecordStuff provides one macOS menu bar button: click to record the primary display and system audio, then click again to save an MP4. Users do not need to create a project, select codecs, or manage a main window.

## Features

| Feature | Behavior | Design |
| --- | --- | --- |
| Start and stop | Left-click toggles recording; clicks during startup or saving are ignored | [Recording](recording.md) |
| Display and audio | Select the current primary display at each start, falling back to the first source if no ID matches; reject missing or ended audio tracks | [Architecture](architecture.md) |
| Status | Idle/recording icons, macOS `REC`, and `…` while starting or saving | [Desktop](desktop.md) |
| Recording quality | Economy/Standard/High; 1080p/1440p/4K/Source; 30/60 fps | [Recording](recording.md) |
| Output location | Defaults to `~/Movies/RecordStuff`; a chosen folder persists | [Desktop](desktop.md) |
| Saved files | Local-time filenames, completion notification, reveal last recording, and open output folder | [Recording](recording.md) |
| Permission guidance | Open System Settings and offer relaunch when permission is unavailable | [Desktop](desktop.md) |
| Failure and quit | Report errors, preserve written media when possible, and stop before quitting | [Recording](recording.md) |
| Language | English by default; persistent Traditional Chinese choice, including while recording | [Desktop](desktop.md) |
| Diagnostics | Reveal the log from every tray state | [Desktop](desktop.md) |

Defaults are Standard, Source resolution, and 30 fps. Audio always requests AAC at 256 kbps. There is no microphone capture or audio-quality selector. Track validation detects missing or ended audio tracks; it does not prove that sound is currently playing.

## Platform and delivery scope

Electron supports Windows, Linux, and macOS. Due to available hardware, **RecordStuff has only been verified on macOS**, specifically Apple M1 Pro/macOS 26/Electron 44.3. Framework portability is not proof that this application's recording, system audio, or installation works on every platform.

The repository retains Windows tray branches and NSIS configuration, but they have not been tested on hardware. Linux has no dedicated packaging or recording verification. The macOS preflight checks Darwin 22/macOS 13 or newer; this code threshold is not a claim of testing every supported OS version. Intel Macs are also unverified; the verified artifact is arm64.

The delivery target is a downloadable, self-signed macOS DMG. Recipients need no Node, pnpm, FFmpeg, compiler, or signing certificate. They install the app into Applications and grant the necessary OS permissions. Apple certification/notarization, App Store distribution, and Windows/Linux verification are not release prerequisites. An unnotarized app may require a first-launch security exception; a warning-free launch is not promised. See [Apple's instructions](https://support.apple.com/102445).

## Data and product boundaries

Recordings and settings stay local. There is no account, cloud storage, upload service, telemetry, recording library, editor, or automatic updater. The application exposes no remote recording API. Packaged builds ignore the development-only automatic-recording environment variable.

Region/window selection, global shortcuts, pause/resume, file segmentation, FFmpeg repair, and dedicated sleep/display-removal handlers are not implemented or required for the current delivery. Add a scoped plan only when a concrete requirement arises.

## Design priorities

1. Correctness: media, saved files, and visible state must be truthful; failure must never masquerade as success.
2. Clarity: keep module responsibilities explicit and avoid abstractions for unscheduled features.
3. Resilience: give resources a cleanup path, preserve media where possible, and retain diagnostics.
4. Performance: measure before optimizing; encoder requests are not output guarantees.

See the [verification record](../verification/README.md) for measured results and the [downloadable release plan](../../plans/010-downloadable-macos-release.md) for remaining delivery work.
