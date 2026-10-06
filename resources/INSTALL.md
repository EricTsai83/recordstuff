# RecordStuff — Install, Update, and Remove on macOS and Windows

[English](INSTALL.md) | [繁體中文](INSTALL.zh-TW.md)

RecordStuff.app is signed with the developer's own certificate and has not been
notarized by Apple. You do not need a paid Apple membership or any additional
certificates. Files with arm64 in the name are for Apple silicon Macs.

The DMG contains only the app and an Applications shortcut. This page is the
installation guide; it is linked from every GitHub release. The sections up to
"Language" cover macOS; the unverified Windows x64 installer is covered in
[Windows](#windows) at the end.

## Installation and first launch (no Terminal required)

1. Open the DMG and drag RecordStuff onto the Applications folder shown next to it.
   Before updating an existing installation, follow "Update manually" below.
2. Eject the disk image in Finder, open Applications, and double-click RecordStuff.
3. If macOS blocks the app, verify you trust the download, then manually open
   System Settings → Privacy & Security. Scroll down to Security, find RecordStuff,
   click Open Anyway and confirm. Done only dismisses the warning; it does not unblock the app.
   Organization-managed Macs may not allow this; contact your administrator.
   If macOS explicitly warns about malware or a damaged file, stop the installation
   and report the issue to the developer.
4. RecordStuff has no regular main window. Look for its icon in the menu bar
   at the top of the screen.
5. Follow the app's prompts to open Privacy & Security → Screen & System Audio Recording
   and allow RecordStuff. Choose Quit & Reopen if macOS asks you to do so.
   The app menu also offers an option to restart RecordStuff after granting permission.
   If a separate system audio recording prompt appears, allow it as well
   to record sound playing on your computer.
6. Click the menu bar icon to start recording, then click it again to stop.
   You can also press Shift-Command-1 (⇧⌘1) from any app; Settings → General
   lets you enter a custom combination or turn the shortcut off.
   Settings → Recording settings → Screen selects one whole screen; the default
   follows the primary display. A selected display must be available.
   Recordings are saved to Movies → RecordStuff in your home folder by default.
   You can open the output folder from the app menu.

## Update manually

Use **Check for updates…** in **Settings → General** to check for a newer release and open its download page. **Check for updates on launch** is on by default and checks at most once per 24 hours; you can switch it off. Checks and results wait while recording. A failed manual check offers the releases page; launch failures only go to the log. There is no automatic download or installation. To install a new version:

1. Stop any recording, then choose Quit from the RecordStuff menu bar icon.
2. Download the new DMG from the [latest release](https://github.com/EricTsai83/recordstuff/releases/latest)
   and optionally compare its SHA-256 with the release's SHA256SUMS file.
3. Open the DMG and drag RecordStuff onto Applications. When Finder asks,
   choose Replace so the new app takes the same path as the old one.
4. Eject the disk image and launch RecordStuff from Applications.
5. If the update is blocked, use Privacy & Security → Security → Open Anyway
   as described above. Clicking Done does not unblock the app.

Every release is signed with the same certificate and installed at the same path,
so your language choice, output folder, and other settings are kept, and macOS
normally keeps the screen and system audio recording permission. If a permission
prompt appears again, allow it and relaunch as described above.

## Remove RecordStuff

There is no separate uninstaller and no background service.

To also remove local app data, first open **Settings → General → Local app data → Clear local app data and quit…**. Confirm the scope: RecordStuff exits, then clears settings, failure history, cache, logs and old data backups. Recordings and the output folder are kept. This does not remove the app or reset OS permissions. Wait for cleanup before reopening; a new launch waits automatically. If cleanup fails or is interrupted, the next launch reports it and lets you retry or remove the remaining data manually. An output folder containing an app-data root must be moved outside it before cleanup; an output folder nested inside app data is kept. Then remove the app as below.

1. Stop any recording, then choose Quit from the RecordStuff menu bar icon.
2. Open Applications, drag RecordStuff.app to the Trash, and empty the Trash.
   Ejecting the DMG does not remove an installed app.

Removing the app leaves your data in place. Delete these yourself only if you
no longer need them; the app never deletes recordings:

| Data | Location |
| --- | --- |
| Recordings | Movies → RecordStuff in your home folder, or the output folder you chose |
| Settings and cache | `~/Library/Application Support/recordstuff` |
| Logs | `~/Library/Logs/recordstuff` |

In Finder, choose Go → Go to Folder and paste a path to open it. Any remaining
privacy permission entry can be removed in System Settings → Privacy & Security →
Screen & System Audio Recording; this is optional and is not required for removal.

## If permission prompts continue after you have granted access

Make sure you are opening RecordStuff from Applications, then quit and reopen it.
If recording still fails, report the issue to the developer and include the relevant
log entries. Use the app menu's option to reveal the log file.
Switching from an older ad-hoc signature to a self-signed certificate may leave
outdated permission records. You do not need to keep toggling permission switches.
Do not install certificates, disable Gatekeeper for your entire Mac,
or reset permissions for other apps.

Allowing the app to open and granting recording permissions are separate steps;
both must be completed.

Apple's instructions: https://support.apple.com/102445

## Language

RecordStuff starts in English. Right-click its menu bar icon and choose
Settings → General → Language → 繁體中文 for Traditional Chinese. The choice is saved for future launches.
App diagnostics remain English; macOS permission dialogs follow the system language.

## Windows

Windows x64 installers are published on GitHub Releases starting with the first
release after 1.1.1, as `RecordStuff-<version>-x64-unsigned-setup.exe`.
Windows on Arm is not supported.

**Not verified on Windows hardware.** CI builds the installer, silently installs
and uninstalls it on a GitHub Windows runner and checks its version,
architecture and files. Screen capture, system audio, notifications and the tray
have not been verified on Windows hardware, nor has the app's Windows wording,
such as "system tray" where macOS says "menu bar". Windows 10 or newer is
required. The sections above were written for, and verified on, macOS.

### Install

1. Download the installer from the [latest release](https://github.com/EricTsai83/recordstuff/releases/latest)
   and run it. It installs RecordStuff for your Windows account only, without an
   administrator prompt, and creates a Start-menu shortcut, which Windows
   notifications need.
2. The installer is not code-signed, which its file name states. If Windows
   SmartScreen shows "Windows protected your PC", verify you trust the download,
   click More info, then Run anyway. Organization-managed PCs may not allow this;
   contact your administrator.
3. RecordStuff has no regular main window. Its icon is in the system tray; click
   it to start recording and click it again to stop. Right-click it for Settings,
   the output folder, logs and Quit. Recordings are saved to Videos → RecordStuff
   by default.

### Verify the download

SHA256SUMS lists both the DMG and the installer, one line each. In PowerShell, run:

```powershell
Get-FileHash $HOME\Downloads\RecordStuff-<version>-x64-unsigned-setup.exe
```

`Get-FileHash` prints the hash in capitals; compare it, ignoring case, with the
installer's line in SHA256SUMS. The release's `release-win32-x64.json` records
the installer's source commit, version, size and SHA-256. The installer also
carries a GitHub build-provenance attestation, which the GitHub CLI can check:

```bash
gh attestation verify RecordStuff-<version>-x64-unsigned-setup.exe --repo EricTsai83/recordstuff
```

### Update

**Check for updates…** in **Settings → General** also works on Windows: it reads
the latest release on GitHub. Installation stays manual:

1. Stop any recording, then choose Quit from the RecordStuff tray menu.
2. Download the new installer from the [latest release](https://github.com/EricTsai83/recordstuff/releases/latest),
   optionally verify it as described above, and run it.

Your settings and recordings are kept.

### Uninstall

1. Stop any recording, then choose Quit from the RecordStuff tray menu.
2. Open Settings → Apps → Installed apps, find RecordStuff and choose Uninstall.

Uninstalling keeps your data by default. To clear local app data first, use **Settings → General → Local app data → Clear local app data and quit…**, then uninstall. Recordings are kept. Without that explicit cleanup, it keeps
your data in these locations; delete them yourself only if you no longer need them:

| Data | Location |
| --- | --- |
| Recordings | `Videos\RecordStuff` in your user folder, or the output folder you chose |
| Settings and history | `%APPDATA%\recordstuff` |
| Logs | `%APPDATA%\recordstuff\logs` |

Paste a path into the File Explorer address bar to open it.
