# recordstuff

[English](README.md) | [繁體中文](README.zh-TW.md)

A menu bar button that records your primary display and system audio. Click to start, click again to stop, and open the saved MP4. No main window or account is required.

## Platform status

Electron supports Windows, Linux, and macOS. **Due to available hardware, recordstuff has only been verified on macOS.** The tested environment is Apple M1 Pro, macOS 26, and Electron 44.3; the verified installer is arm64. Windows, Linux, Intel Macs, and other macOS versions are unverified. Existing cross-platform code does not imply verified recording or installation support. See [Electron's platform information](https://github.com/electron/electron#platform-support).

The product target is a downloadable, self-signed macOS app. Apple certification/notarization and Windows/Linux verification are not planned release requirements.

## Download and install

<!-- release-download:start -->
Download **[RecordStuff 0.1.2 for macOS Apple silicon (arm64)](https://github.com/EricTsai83/recordstuff/releases/download/v0.1.2/RecordStuff-0.1.2-arm64-selfsigned.dmg)** (127,314,171 bytes). [Release notes](https://github.com/EricTsai83/recordstuff/releases/tag/v0.1.2) · [SHA256SUMS](https://github.com/EricTsai83/recordstuff/releases/download/v0.1.2/SHA256SUMS) · [Latest release](https://github.com/EricTsai83/recordstuff/releases/latest).

SHA-256: `2de49bbd552e46934ef4573ca8c8b103e3a0b1334dd12b2022dee1f332f7fc7f`.
<!-- release-download:end -->

0.1.2 was built, signed, verified and published by CI from tag `v0.1.2`; recording, playback and permission retention were checked locally on the same source before tagging. See [release evidence](docs/verification/releases/0.1.2.md). Clicking a saved notification selects the file in Finder, but may leave Finder behind other windows.

Download the arm64 DMG and drag RecordStuff onto the Applications folder shown in the disk image; the DMG contains only the app and that Applications shortcut. The [installation guide](resources/INSTALL.md) covers first launch, manual update (quit, download, replace at the same path; settings are kept) and removal (quit, move the app to Trash; recordings, settings and logs stay unless you delete them). There is no automatic updater or uninstaller. Recipients do not need Node, pnpm, FFmpeg, or certificates. Because the app is not notarized, first launch may require **System Settings → Privacy & Security → Open Anyway**. A warning-free first launch is not promised; see [Apple's guidance](https://support.apple.com/102445).

## Use

1. Launch recordstuff from Applications and grant screen/system-audio recording permission when requested. Relaunch if access does not take effect.
2. Left-click its menu bar icon to record the primary display and system audio.
3. Click again to stop. Recordings default to `~/Movies/recordstuff`; click the saved notification or use the menu to find the file.
4. Right-click for recording quality, output folder, language, logs, and quit.

**English is the default.** Choose **Language → 繁體中文** to switch the app to Traditional Chinese. The choice persists and can change during recording without changing capture settings. Application diagnostics remain English; native permission dialogs follow macOS settings.

| Setting | Options | Default |
| --- | --- | --- |
| Video quality | Economy / Standard / High | Standard |
| Resolution cap | 1080p / 1440p / 4K / Source | Source |
| Frame rate | 30 / 60 fps | 30; 60 is enabled only on macOS |

Output is H.264/AAC MP4. Audio requests 256 kbps with voice processing explicitly disabled; local diagnostic recordings preserve high frequencies and left/right separation. Actual bitrate depends on the encoder and content. At 60 fps the tested output was about 57 fps with substantially larger files. These are measured limitations, not hidden quality guarantees.

## Current status and design

The local app has been verified for recording/playback, Retina 3456×2234 capture, permissions and recovery, partial-file preservation, self-signed DMG installation, and same-identity updates. 0.1.2 ships a simplified DMG (app and Applications link only) with online install, update and removal guidance; see [0.1.2 evidence](docs/verification/releases/0.1.2.md). The notification icon was confirmed normal after reboot on 2026-09-14. The new language implementation is covered by automated checks; the release plan includes checking it in the next packaged build. Full evidence and limitations are in the [verification record](docs/verification/README.md).

- [System design](docs/system-design/README.md): overview, architecture, recording, desktop behavior, every module's functions, tooling, and decisions.
- [Remaining work](plans/README.md): scoped follow-ups, including a [recording hotkey](plans/016-recording-hotkey.md), [Finder notification focus](plans/014-finder-notification-focus.md), the [official website and DMG downloads](plans/012-download-website.md), and a deferred [update assessment](plans/015-app-update-assessment.md); completed/canceled plans have been removed.
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
```

The self-signed workflow requires a valid, uniquely named local code-signing identity, default `RecordStuff Dev`; RECORDSTUFF_SIGN_IDENTITY may select its exact name or SHA-1. Quit recordstuff/project Electron before rebuilding. It does not publish or notarize, and recipients do not install the signing certificate. `dist:win` is unverified.

Use a compatible Node version (package requirement ≥22.12); the TypeScript measurement tools are run with Node 24. Install FFmpeg only for developer verification:

```bash
pnpm probe -- /absolute/path/recording.mp4
pnpm verify -- /absolute/path/recording.mp4 --screen 1920x1080 --sync --out
pnpm matrix -- all
pnpm audio:quality -- record /tmp/audio-run-001 --repeat 3  # Audio fidelity regression (macOS; plays diagnostic tones)
```

Matrix is macOS-only and drives unpackaged builds. Results go to `docs/verification/measurements/`. Long is a three-minute drift regression; the ten-minute baseline was already recorded. See [tooling](docs/system-design/tooling.md) for prerequisites and interpretation.

## Repository map

```text
src/main/               App lifecycle, Recorder, file writer, permissions, settings, tray, logs
src/renderer/           Hidden capture host: streams, quality constraints, MediaRecorder
src/preload/            MessagePort handoff only
src/shared/             State, protocol, quality, and English/Traditional Chinese catalog
scripts/                Build/signing, icons, recording inspection and verification
resources/              Runtime assets, entitlements, bilingual installation guides
docs/system-design/     Canonical English design documentation
docs/zh-TW/             Traditional Chinese documentation translations
docs/verification/      Evidence summary and original measurement records
plans/                  Unfinished delivery work only
```

App recordings and settings stay local. No upload backend, account, telemetry, or automatic updater is implemented. Errors preserve partial recordings where possible; recovery is not guaranteed after every crash or power loss.

## License

This project is licensed under the [MIT License](LICENSE).

Learn why and how the audio checks work in the [audio quality design guide](docs/system-design/audio-quality.md).

Release maintainers: verify locally, then push a version tag; see [GitHub release automation](docs/system-design/releases.md) for the checklist and gates.
