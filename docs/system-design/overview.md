# Product Overview

[English](overview.md) | [繁體中文](../zh-TW/system-design/overview.md)

RecordStuff provides one macOS menu bar button: click to record one screen (the primary display by default) and system audio, then click again to save an MP4. Users do not need to create a project, select codecs, or manage a main window. Recording runs through RecordStuff's native capture engine, a Rust module in a process that exists only while a recording starts, runs and is saved (plan 076; [why](webrtc.md)).

## Features

| Feature | Behavior | Design |
| --- | --- | --- |
| Start and stop | Left-click toggles recording after a countdown (3 s by default; Off, 5 or 10 s in Settings) that a second click, the shortcut or Cancel recording cancels; clicks during startup or saving are ignored | [Recording](recording.md#countdown) |
| Display and audio | Follow the primary display by default, or require an exact match for a chosen display; a start whose display or system audio cannot be opened fails | [Architecture](architecture.md) |
| What is left out | RecordStuff's own windows, always, including ones opened during a recording (its menu-bar icon stays); optionally the menu bar, Dock, desktop icons and widgets with Hide menu bar and Dock (off by default, macOS only; shown as Hide taskbar, unavailable, on Windows). A menu opened in another app is still recorded with that app | [Decisions](decisions.md) |
| Status | Ring when idle, hourglass while starting or saving, stopwatch during the countdown with the digit at the top-right of the recorded screen, filled dot plus macOS `REC` while recording | [Desktop](desktop.md) |
| Recording quality | Economy/Standard/High; 1080p/1440p/4K/Source; 30/60 fps | [Recording](recording.md) |
| Output location | Defaults to `~/Movies/RecordStuff`; a chosen folder persists | [Desktop](desktop.md) |
| Saved files | Local-time filenames, completion notification, reveal last recording, and open output folder | [Recording](recording.md) |
| Permission guidance | Open System Settings and offer relaunch when permission is unavailable | [Desktop](desktop.md) |
| Failure and quit | Report errors, preserve written media when possible, and stop before quitting | [Recording](recording.md) |
| Language | English by default; persistent Traditional Chinese choice, including while recording | [Desktop](desktop.md) |
| Settings and shortcuts | Persistent settings panel; ⇧⌘1 starts/stops by default, a custom shortcut or Off is available, and ⌥⌘, opens Settings | [Desktop](desktop.md) |
| Appearance and notifications | System/Light/Dark appearance; app notifications can be disabled independently of macOS permission | [Desktop](desktop.md) |
| Diagnostics | Reveal the log from every tray state | [Desktop](desktop.md) |

Defaults are Standard, Source resolution, 30 fps and Hide menu bar and Dock off. Audio always requests AAC at 256 kbps (Windows' encoder takes at most 192 kbps). The microphone is off by default; turned on in Settings → Recording or the idle menu, it is mixed raw with system audio into the same track, and a start without microphone access is refused before the countdown ([recording](recording.md#audio)). There is no audio-quality selector. When nothing plays the recording holds silence, so an audio track does not prove that sound was playing.

## Platform and delivery scope

RecordStuff's capture engine exists for macOS (ScreenCaptureKit, VideoToolbox, AudioToolbox) and Windows (Windows.Graphics.Capture, WASAPI, Media Foundation); other platforms have no recording engine. Due to available hardware, **RecordStuff has only been verified on macOS**, specifically Apple M1 Pro/macOS 26/Electron 44.3. Electron's own portability is not proof that this application's recording, system audio, or installation works on every platform.

By the maintainer's decision of 2026-10-03 ([design decisions](decisions.md)), every version after 1.1.1 also carries an unsigned Windows x64 installer built and checked by CI only. A GitHub Windows runner runs `pnpm check`, records short clips of the display, an area, a window and one process's sound through the engine and decodes them, installs the installer silently for the current user, checks its registration, version, architecture, signature state, tray icons, Start-menu shortcut and that the installed engine loads, and uninstalls it; nothing has run on Windows hardware, so capture quality, frame timing, own windows left out, system audio content, CPU, notifications and the Windows tray branches (ICO assets, first-run hint) are unverified there, its own wording ("system tray", "the computer went to sleep", Ctrl-only shortcut messages) has not been seen there, and the app enforces no Windows version floor beyond Electron 44's own Windows 10. Linux has no packaging and no recording engine. The macOS preflight checks Darwin 22/macOS 13 or newer; this code threshold is not a claim of testing every supported OS version. Intel Macs and Windows on Arm are also unverified and have no published build; the verified artifact is arm64.

The delivery target is a downloadable, self-signed macOS DMG, with the unverified Windows x64 installer in the same release. Recipients need no Node, pnpm, FFmpeg, compiler, or signing certificate. On macOS they install the app into Applications and grant the necessary OS permissions; on Windows the installer installs for the current user without an administrator prompt and registers an uninstaller that keeps user data. Apple certification/notarization, Windows code signing, App Store distribution, and Windows/Linux hardware verification are not release prerequisites. An unnotarized app may require a first-launch security exception, and SmartScreen may warn about the unsigned Windows installer; a warning-free launch is not promised. See [Apple's instructions](https://support.apple.com/102445).

## Data and product boundaries

Recordings and settings stay local. There is no account, cloud storage, upload service, telemetry, recording library, editor, or automatic download/installation. Update checks contact the website version feed, with GitHub Releases as fallback (on Windows, GitHub Releases only, since the feed describes the macOS DMG), without installation identifiers; the default-on launch check can be disabled. The application exposes no remote recording API. Packaged builds ignore the development-only automatic-recording environment variable.

Region, window and app selection are not offered (the engine can record them; there is no picker), and pause/resume, file segmentation and FFmpeg repair are not implemented or required for the current delivery. A sleep the system forces stops and saves the recording. Display removal is handled: removal of the active capture display fails the session and preserves written media where possible. Add a scoped plan only when a concrete requirement arises.

## Design priorities

1. Correctness: media, saved files, and visible state must be truthful; failure must never masquerade as success.
2. Clarity: keep module responsibilities explicit and avoid abstractions for unscheduled features.
3. Resilience: give resources a cleanup path, preserve media where possible, and retain diagnostics.
4. Performance: measure before optimizing; encoder requests are not output guarantees.

See the [verification record](../verification/README.md) for measured results and the [remaining plans](../../plans/README.md) for remaining delivery work.
