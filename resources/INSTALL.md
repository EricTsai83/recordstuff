# RecordStuff — Self-Signed macOS Trial

[English](INSTALL.md) | [繁體中文](INSTALL.zh-TW.md)

RecordStuff.app in this DMG is signed with the developer's own certificate
and has not been notarized by Apple. You do not need a paid Apple membership
or any additional certificates.
Files with arm64 in the name are for Apple silicon Macs; x64 files are for Intel Macs.

## Installation and First Launch (No Terminal Required)

1. Open the DMG and drag RecordStuff to Applications.
   Before updating an existing installation, stop recording and quit the app
   from the RecordStuff menu.
2. In Finder, open Applications and double-click RecordStuff.
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
   Recordings are saved to Movies → RecordStuff in your home folder by default.
   You can open the output folder from the app menu.
7. After installation, eject the DMG in Finder. Launch RecordStuff from Applications
   for future use.

## If Permission Prompts Continue After You Have Granted Access

Make sure you are opening RecordStuff from Applications, then quit and reopen it.
If recording still fails, report the issue to the developer and include the relevant
log entries. Use the app menu's option to reveal the log file.
Switching from an older ad-hoc signature to a self-signed certificate may leave
outdated permission records. You do not need to keep toggling permission switches.
Do not install certificates, disable Gatekeeper for your entire Mac,
or reset permissions for other apps.

Allowing the app to open and granting recording permissions are separate steps;
both must be completed.
Local package verification does not mean installation and recording have been
validated on another Mac.

Apple's instructions: https://support.apple.com/102445
