# recordstuff

[English](README.md) | [繁體中文](README.zh-TW.md)

Screen and sound. Nothing else. A menu bar app that records one screen (your primary display by default) with its system audio to a plain MP4: choose Start recording from its menu or press ⌘⇧1, and stop the same way. No account is required.

## Platform status

Electron supports Windows, Linux, and macOS. **Due to available hardware, recordstuff has only been verified on macOS.** The tested environment is Apple M1 Pro, macOS 26, and Electron 44.3; the verified installer is arm64. Starting with the first release after 1.1.1, each release also carries an unsigned Windows x64 installer that is built and checked by CI but not verified on Windows hardware: CI silently installs and uninstalls it on a GitHub Windows runner and checks its version, architecture and files, while screen capture, system audio, notifications and the tray remain untested on Windows, as is the Windows wording of the app (for example "system tray" instead of "menu bar"). Electron requires Windows 10 or newer. Windows on Arm, Linux, Intel Macs, and other macOS versions are unverified and have no published build. Existing cross-platform code does not imply verified recording or installation support. See [Electron's platform information](https://github.com/electron/electron#platform-support).

The product target is a downloadable, self-signed macOS app, plus the unverified Windows x64 installer. Apple certification/notarization and Windows code signing are not planned, and Windows/Linux verification is not a release requirement.

## Download and install

[Official website](https://record.ericts.com) · [Downloads](https://record.ericts.com/download) · [Help](https://record.ericts.com/help).

<!-- release-download:start -->
Download **[RecordStuff 1.4.0 for macOS Apple silicon (arm64)](https://github.com/EricTsai83/recordstuff/releases/download/v1.4.0/RecordStuff-1.4.0-arm64-selfsigned.dmg)** (127,442,004 bytes). [Release notes](https://github.com/EricTsai83/recordstuff/releases/tag/v1.4.0) · [SHA256SUMS](https://github.com/EricTsai83/recordstuff/releases/download/v1.4.0/SHA256SUMS) · [Latest release](https://github.com/EricTsai83/recordstuff/releases/latest).

SHA-256: `5dbfccb517c2c8cb26b73aa420e63be1315ed5af1badc5f054e80634a6e9d548`.

Windows: **[RecordStuff 1.4.0 for Windows x64](https://github.com/EricTsai83/recordstuff/releases/download/v1.4.0/RecordStuff-1.4.0-x64-unsigned-setup.exe)** (100,316,478 bytes), unsigned and built by CI; capture has not been verified on Windows hardware.

SHA-256: `572d7cd241e7e231db5758871923d697b0e2d3ae79ab22a41386fad5b7228fa1`.
<!-- release-download:end -->

1.0.0 was built, signed, published and publicly re-verified by CI. Local recording and QuickTime playback checks used the tagged source; see [1.0.0 evidence and untested cases](docs/verification/releases/1.0.0.md).

Download the arm64 DMG and drag RecordStuff onto the Applications folder shown in the disk image; the DMG contains only the app and that Applications shortcut. The [installation guide](resources/INSTALL.md) covers first launch, manual update (quit, download, replace at the same path; settings are kept) and removal (quit, move the app to Trash; recordings, settings and logs stay unless you delete them). Settings → General offers Check for updates… and an optional launch check (on by default, at most once per 24 hours). Installation remains manual; on macOS there is no automatic installer or uninstaller. Recipients do not need Node, pnpm, FFmpeg, or certificates. If blocked after installing or updating, manually open System Settings → Privacy & Security, scroll down to Security, find RecordStuff and click Open Anyway. Done only dismisses the warning. A warning-free first launch is not promised; see [Apple's guidance](https://support.apple.com/102445).

On Windows x64, run `RecordStuff-<version>-x64-unsigned-setup.exe`: a per-user one-click installer without an admin prompt that creates a Start-menu shortcut (needed for Windows notifications) and registers an uninstaller in Settings → Apps → Installed apps. It is not code-signed, so SmartScreen may show "Windows protected your PC"; click More info, then Run anyway. SHA256SUMS lists both installers (compare `Get-FileHash` output in PowerShell with its line), `release-win32-x64.json` records the installer's facts, and the installer carries a GitHub build-provenance attestation. To update, quit RecordStuff from its tray menu, then download and run the new installer; settings and recordings are kept. Uninstalling never deletes recordings, settings or logs. The [installation guide](resources/INSTALL.md#windows) has the details and data locations.

## Use

1. Launch RecordStuff from Applications and grant screen/system-audio recording permission when requested. Relaunch if access does not take effect.
2. Press **⌘⇧1** from any app, or click the menu bar icon and choose **Start recording**, to record the selected screen and system audio. Choose a screen in **Settings → Recording settings → Screen**; the default follows the primary display. To start and stop with one click on the icon instead, choose **Settings → General → Icon click → Start / stop recording** (kept for anyone who used RecordStuff before this choice existed).
3. Press the shortcut again, or choose **Stop** from the menu, to stop. Recordings default to `~/Movies/RecordStuff`; click the saved notification, or choose **Open RecordStuff** from the menu, to see it in **Recordings**, newest first, where you can play a recording (its fullscreen fills the screen), drag it into another app, or use its **⋯** menu or a right-click to show it in Finder, open it in another app or move it to the Trash. A recording deleted in Finder leaves the list at once.
4. The menu (a right-click always opens it) keeps what you do right now: start or stop, unread failures, **Open RecordStuff** and quit. The output folder, logs and reviewed failures are in RecordStuff. Showing the output folder creates the default folder if it is missing; a missing custom folder, for example on a disconnected drive, is never recreated: RecordStuff explains the problem and offers **Change output folder** (also in the menu while it blocks recording). Open RecordStuff to adjust the screen, recording quality, language, appearance, notifications, shortcut, and update checks without closing the settings window.

**English is the default.** Choose **Settings → General → Language → 繁體中文** to switch the app to Traditional Chinese. The choice persists and can change during recording without changing capture settings. Application diagnostics remain English; native permission dialogs follow macOS settings.

| Setting | Options | Default |
| --- | --- | --- |
| Screen | Primary display / a connected display | Primary display |
| Video quality | Economy / Standard / High | Standard |
| Resolution cap | 1080p / 1440p / 4K / Source | Source |
| Frame rate | 30 / 60 fps | 30; 60 is enabled only on macOS |
| Shortcut | ⌘⇧1 (recommended) / Custom shortcut / Off | ⌘⇧1; Settings says so if another app already owns the combination |
| Icon click | Open the menu / Start / stop recording | Open the menu; Start / stop recording for settings from before this choice |

Open these settings with **Open RecordStuff** in the menu or with **⌘⌥,**. Appearance offers System / Light / Dark (System by default); notifications are on by default and also require macOS permission. Language and appearance can change while recording; other settings are locked. A specific display must be available: the app does not silently switch to another screen. Capture covers one whole screen, without a microphone, window or region selector.

Output is H.264/AAC MP4. Audio requests 256 kbps with voice processing explicitly disabled; local diagnostic recordings preserve high frequencies and left/right separation. Actual bitrate depends on the encoder and content. The capture asks for slightly more than 30 or 60 fps so the tested Mac records about 29.9 and 59.8 fps; 60 fps files are substantially larger. These are measured limitations, not hidden quality guarantees.

## Current status and design

The [1.0.0 release round](docs/verification/releases/1.0.0.md) verified a short 1920×1080 recording, saved-file integrity, and QuickTime playback. Full native settings/tray regression, subjective audio listening, first-time permissions, long-duration recording and manual DMG installation were not tested in that round. Earlier checks cover Retina capture, permission recovery, partial files, installation and same-identity updates; their environments and limitations remain in the [verification record](docs/verification/README.md).

- [System design](docs/system-design/README.md): overview, architecture, recording, desktop behavior, every module's functions, tooling, and decisions.
- [Remaining work](plans/README.md): plan status and verification references; completed/canceled plans have been removed.
- [Contributing](CONTRIBUTING.md): development setup, bug reports, testing, and pull requests.

## Development

```bash
pnpm install
pnpm start             # Build and open development Electron.app on macOS
pnpm dev               # Hot reload; capture permissions may belong to the launching app
pnpm start:app         # Build, self-sign, verify, and open recordstuff.app
pnpm open:app          # Verify/open the existing development bundle without rebuilding
pnpm check             # Typecheck, tests, build
pnpm icons             # Regenerate PNG/ICO; regenerate ICNS on macOS
pnpm log               # Follow the macOS diagnostic log
pnpm dist:mac    # Produce the self-signed DMG in dist/ (CI builds the released one)
pnpm dist:win    # Produce the unsigned Windows x64 installer in dist/ (CI builds the released one)
```

The self-signed workflow requires a valid, uniquely named local code-signing identity, default `RecordStuff Dev`; RECORDSTUFF_SIGN_IDENTITY may select its exact name or SHA-1. Before rebuilding, check whether recordstuff/project Electron is recording; stop and save your recording before quitting it. It does not publish or notarize, and recipients do not install the signing certificate. `pnpm dist:win` produces the unsigned Windows x64 NSIS installer in `dist/`, without the macOS signing path; CI builds and checks the released one on a GitHub Windows runner. No Linux build target exists.

Use a compatible Node version (package requirement ≥22.12); the TypeScript measurement tools are run with Node 24. Install FFmpeg only for developer verification:

```bash
pnpm probe -- /absolute/path/recording.mp4
pnpm verify -- /absolute/path/recording.mp4 --screen 1920x1080 --sync --out
pnpm matrix -- all
pnpm audio:quality -- record /tmp/audio-run-001 --repeat 3  # Audio fidelity regression (macOS; plays diagnostic tones)
```

Matrix is macOS-only and drives unpackaged builds. Results go to `docs/verification/measurements/`, a gitignored local directory; curated conclusions belong in the [verification record](docs/verification/README.md). Long is a three-minute drift regression; the ten-minute baseline was already recorded. See [tooling](docs/system-design/tooling.md) for prerequisites and interpretation.

## Repository map

```text
src/main/               App lifecycle, Recorder, file writer, permissions, settings, tray, settings window, logs
src/renderer/           Hidden capture host and visible settings panel
src/preload/            Capture MessagePort handoff and settings bridge
src/shared/             State, protocol, quality, and English/Traditional Chinese catalog
scripts/                Build/signing, icons, recording inspection and verification
resources/              Runtime assets, entitlements, bilingual installation guides
docs/system-design/     Canonical English design documentation
docs/zh-TW/             Traditional Chinese documentation translations
docs/verification/      Evidence summary and original measurement records
plans/                  Unfinished delivery work only
website/                Official website (Astro, independent package); see docs/system-design/tooling.md
```

App recordings and settings stay local. Update checks contact the static website feed, with GitHub Releases as fallback, without installation identifiers or telemetry. No upload backend, account, or automatic installer is implemented. Errors preserve partial recordings where possible; recovery is not guaranteed after every crash or power loss.

## License

This project is licensed under the [MIT License](LICENSE).

Learn why and how the audio checks work in the [audio quality design guide](docs/system-design/audio-quality.md).

Release maintainers: verify locally, then push a version tag; see [GitHub release automation](docs/system-design/releases.md) for the checklist and gates.
