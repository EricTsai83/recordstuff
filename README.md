# recordstuff

[English](README.md) | [繁體中文](README.zh-TW.md)

Screen and sound. Nothing else. A menu bar app that records one screen with its system audio to a plain MP4. No account required.

[Website](https://record.ericts.com) · [Downloads](https://record.ericts.com/download) · [Help](https://record.ericts.com/help)

## Download

<!-- release-download:start -->
Download **[RecordStuff 1.8.0 for macOS Apple silicon (arm64)](https://github.com/EricTsai83/recordstuff/releases/download/v1.8.0/RecordStuff-1.8.0-arm64-selfsigned.dmg)** (133,180,131 bytes). [Release notes](https://github.com/EricTsai83/recordstuff/releases/tag/v1.8.0) · [SHA256SUMS](https://github.com/EricTsai83/recordstuff/releases/download/v1.8.0/SHA256SUMS) · [Latest release](https://github.com/EricTsai83/recordstuff/releases/latest).

SHA-256: `4d2783aedbaa3185ff0ea54c88aca543c133a6ca1a0a42c2cb23921c79576db4`.

Windows: **[RecordStuff 1.8.0 for Windows x64](https://github.com/EricTsai83/recordstuff/releases/download/v1.8.0/RecordStuff-1.8.0-x64-unsigned-setup.exe)** (102,736,217 bytes), unsigned and built by CI; capture has not been verified on Windows hardware.

SHA-256: `fabea0f445c6415ed13a10d48b31775f794be3e78899fa0f7344b5a9ebb101c9`.
<!-- release-download:end -->

- **macOS**: drag RecordStuff into Applications. If it is blocked, open **System Settings → Privacy & Security** and click **Open Anyway** ([Apple's guidance](https://support.apple.com/102445)).
- **Windows**: run the installer. If SmartScreen warns, click **More info → Run anyway**.

Updates, removal and data locations: [installation guide](resources/INSTALL.md).

## Platforms

| Platform | Status |
| --- | --- |
| macOS Apple silicon | Verified on M1 Pro, macOS 26; self-signed, not notarized |
| Windows x64 | Installer built and checked by CI; capture not verified on hardware; unsigned |
| Linux, Intel Mac, Windows on Arm | Unverified, no build |

## Use

1. Launch RecordStuff and grant screen and system-audio recording permission.
2. Press **⇧⌘1** (Ctrl+Shift+1 on Windows), or choose **Start recording** from the menu bar icon. Recording starts after a 3-second countdown. Do the same to stop.
3. Recordings are saved to `~/Movies/RecordStuff` (`Videos\RecordStuff` on Windows). Click the notification or choose **Open RecordStuff** to play, rename, reveal or delete them.

Open settings with **⌥⌘,**:

| Setting | Options | Default |
| --- | --- | --- |
| Screen | Primary display / a connected display | Primary display |
| Output folder | Any folder | Movies → RecordStuff |
| Countdown | Off / 3 / 5 / 10 s, optional tick | 3 s, tick on |
| Video quality | Economy / Standard / High | Standard |
| Resolution cap | 1080p / 1440p / 4K / Source | Source |
| Frame rate | 30 / 60 fps (60 on macOS only) | 30 |
| Shortcut | ⇧⌘1 / Custom / Off | ⇧⌘1 |
| Icon click | Open the menu / Start / stop recording | Open the menu |
| Language | English / 繁體中文 | English |

Output is H.264/AAC MP4. One whole screen is captured, without microphone, window or region selection. Recordings and settings stay local; update checks send no identifiers or telemetry.

## Development

```bash
pnpm install
pnpm start        # Build and open the development app
pnpm dev          # Hot reload
pnpm start:app    # Build, self-sign and open recordstuff.app
pnpm check        # Typecheck, tests, build
pnpm dist:mac     # Self-signed DMG in dist/
pnpm dist:win     # Unsigned Windows x64 installer in dist/
```

Requires Node ≥22.12 and, for self-signed builds, a local `RecordStuff Dev` signing identity.

- [Contributing](CONTRIBUTING.md): setup, code map, testing and pull requests
- [System design](docs/system-design/README.md) · [Tooling](docs/system-design/tooling.md) · [Verification record](docs/verification/README.md) · [Plans](plans/README.md) · [Releases](docs/system-design/releases.md)

## License

[MIT](LICENSE)
