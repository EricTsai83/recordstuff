# recordstuff

[English](README.md) | [繁體中文](README.zh-TW.md)

Record. Cut. Done. A menu bar app that records one screen with its system audio, and your microphone and camera if you turn them on, to a plain MP4, then cuts out what you don't need without touching the original. No account required.

[Website](https://record.ericts.com) · [Downloads](https://record.ericts.com/download) · [Help](https://record.ericts.com/help)

## Download

<!-- release-download:start -->
Download **[RecordStuff 3.1.0 for macOS Apple silicon (arm64)](https://github.com/EricTsai83/recordstuff/releases/download/v3.1.0/RecordStuff-3.1.0-arm64-selfsigned.dmg)** (134,040,791 bytes). [Release notes](https://github.com/EricTsai83/recordstuff/releases/tag/v3.1.0) · [SHA256SUMS](https://github.com/EricTsai83/recordstuff/releases/download/v3.1.0/SHA256SUMS) · [Latest release](https://github.com/EricTsai83/recordstuff/releases/latest).

SHA-256: `c0aaabd6d90f58501c54cc2e80b37ff1863fbc4a6919dbe57062e59ba8ce966b`.

Windows: **[RecordStuff 3.1.0 for Windows x64](https://github.com/EricTsai83/recordstuff/releases/download/v3.1.0/RecordStuff-3.1.0-x64-unsigned-setup.exe)** (103,399,946 bytes), unsigned and built by CI; capture has not been verified on Windows hardware.

SHA-256: `7b9c8c1d05347c8b55b4a17619ff041cad0f1db7c41c69b3d99ecee9adb9bdfe`.
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
4. Under **Include in recordings** in the menu bar menu, check what each recording takes: **System audio** (the sound your computer plays), **Microphone** and **Camera**; uncheck System audio for a narrated walkthrough without notification sounds or music. To arrange the camera, choose **Open Recording Studio…**. Under its preview, a line of compact buttons lets you choose the recording type (plain, or editable on macOS), the screen, the camera, system audio and the microphone, each saying whether it is on; a problem, such as a camera that is not found, is marked on its own button and explained in its menu. In the Camera button you also set the bubble's size, rounding and mirror, and you drag the bubble into place in the preview; **Live preview** shows the picture. Under the preview a plain recording offers showing or hiding the camera, a speaker beside each sound that turns its recording off or on (struck through while it is not recorded) and its volume; an editable recording keeps everything and lets you set it afterwards in **Edit…**. The camera is drawn into the video, not shown on your screen.
5. To send a recording, drag its card out of the Recordings tab: you give what the card plays, cuts applied and the camera composed (⌥-drag gives the original). **Share…** in the card's menu also offers the sound alone, the original, the video without the camera and each track as its own file (for an editor), with **Copy** and **Save to…**; ⌘C on a card copies its video. **Edit…** cuts a recording without changing it, and **Save a copy…** there saves the result as a file of your own.

Open settings with **⌥⌘,**:

| Setting | Options | Default |
| --- | --- | --- |
| Screen | Primary display / a connected display | Primary display |
| Hide menu bar | On / Off; leaves the menu bar and its icons out of recordings, and the strip it keeps at the top of the screen (macOS only) | Off |
| Hide Dock | On / Off; leaves the Dock out of recordings, and its strip when it stays on screen (macOS only) | Off |
| Hide desktop icons and widgets | On / Off; leaves desktop icons and widgets out of recordings (macOS only) | Off |
| Output folder | Any folder | Movies → RecordStuff |
| Countdown | Off / 3 / 5 / 10 s, optional tick | 3 s, tick on |
| System audio | On / Off, also in the menu bar menu and the Recording Studio; off records none of the computer's sound | On |
| Microphone | On / Off, also in the menu bar menu; recorded with system audio in one track (headphones avoid speaker echo) | On |
| Input device | System default / a connected microphone | System default |
| Camera | On / Off, also in the menu bar menu; arranged in the Recording Studio (not yet tested with a camera on Windows) | On |
| Camera device | System default / a connected camera | System default |
| Video quality | Economy / Standard / High | Standard |
| Resolution cap | 1080p / 1440p / 4K / Source | Source |
| Frame rate | 30 / 60 fps (60 on macOS only) | 30 |
| Shortcut | ⇧⌘1 / Custom / Off | ⇧⌘1 |
| Icon click | Open the menu / Start / stop recording | Open the menu |
| Language | English / 繁體中文 | English |

The **Keyboard Shortcuts** tab, also opened from the Help menu on macOS, lists every shortcut and whether it works now.

Output is H.264/AAC MP4. One whole screen is captured, without window or region selection. Recordings and settings stay local; update checks send no identifiers or telemetry.

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

Requires Node ≥22.18, Rust's stable toolchain (it builds the native capture engine) and, for self-signed builds, a local `RecordStuff Dev` signing identity.

- [Contributing](CONTRIBUTING.md): setup, code map, testing and pull requests
- [System design](docs/system-design/README.md) · [Tooling](docs/system-design/tooling.md) · [Verification record](docs/verification/README.md) · [Plans](plans/README.md) · [Releases](docs/system-design/releases.md)

## License

[MIT](LICENSE)
