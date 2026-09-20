# RecordStuff — Install, Update, and Remove on macOS

[English](INSTALL.md) | [繁體中文](INSTALL.zh-TW.md)

RecordStuff.app is signed with the developer's own certificate and has not been
notarized by Apple. You do not need a paid Apple membership or any additional
certificates. Files with arm64 in the name are for Apple silicon Macs.

The DMG contains only the app and an Applications shortcut. This page is the
installation guide; it is linked from every GitHub release.

## Installation and first launch (no Terminal required)

1. Open the DMG and drag RecordStuff onto the Applications folder shown next to it.
   Before updating an existing installation, follow "Update manually" below.
2. Eject the disk image in Finder, open Applications, and double-click RecordStuff.
3. If macOS blocks the app because the developer cannot be verified or the app
   is not notarized, first make sure you trust the source of the file.
   Open the Apple menu in the top-left corner → System Settings → Privacy & Security.
   Find the message about RecordStuff being blocked, click Open Anyway,
   and follow the confirmation prompts.
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
   You can also press Command-Option-Shift-R (⌘⌥⇧R) from any app; the app menu
   lets you pick another combination or turn the shortcut off.
   Recordings are saved to Movies → RecordStuff in your home folder by default.
   You can open the output folder from the app menu.

## Update manually

Use **Check for updates…** in the tray menu to check for a newer release and open its download page. **Check for updates on launch** is on by default and checks at most once per 24 hours; you can switch it off. Checks and results wait while recording. A failed manual check offers the releases page; launch failures only go to the log. There is no automatic download or installation. To install a new version:

1. Stop any recording, then choose Quit from the RecordStuff menu bar icon.
2. Download the new DMG from the [latest release](https://github.com/EricTsai83/recordstuff/releases/latest)
   and optionally compare its SHA-256 with the release's SHA256SUMS file.
3. Open the DMG and drag RecordStuff onto Applications. When Finder asks,
   choose Replace so the new app takes the same path as the old one.
4. Eject the disk image and launch RecordStuff from Applications.

Every release is signed with the same certificate and installed at the same path,
so your language choice, output folder, and other settings are kept, and macOS
normally keeps the screen and system audio recording permission. If a permission
prompt appears again, allow it and relaunch as described above.

## Remove RecordStuff

There is no separate uninstaller and no background service.

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
Language → 繁體中文 for Traditional Chinese. The choice is saved for future launches.
App diagnostics remain English; macOS permission dialogs follow the system language.
