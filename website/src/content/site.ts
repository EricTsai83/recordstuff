/**
 * Every sentence the site shows. Facts here are limited to what README.md,
 * resources/INSTALL.md, docs/system-design/desktop.md and the verification
 * record already state; nothing promises notarization, warning-free launch,
 * automatic updates or platforms that were never verified. Windows is offered
 * only together with the statement that it was never verified on hardware.
 */

import { LAST_MACOS_ONLY_VERSION } from "../../../scripts/lib/release-manifest.mts";

export const SITE_NAME = "RecordStuff";

export const meta = {
  title: "RecordStuff — one click in the menu bar records your screen and its sound",
  description:
    "RecordStuff is a free, open-source macOS menu bar app. Click once to record one screen with system audio to MP4, click again to stop. No main window, no account, files stay on your Mac.",
  ogImageAlt: "A low-poly Mac desktop with a campsite at night; in the menu bar the RecordStuff icon is a filled dot with REC beside it, meaning a recording is in progress.",
} as const;

export const hero = {
  title: "One click. Recording.",
  primaryCta: "Download for macOS",
  secondaryCta: "View source on GitHub",
  /** The demo loops for as long as the page is open; this control stops it (WCAG 2.2.2). */
  pauseScene: "Pause animation",
  playScene: "Play animation",
} as const;

export const notFound = {
  title: "Page not found",
  description: "This address does not lead to a RecordStuff page. It may have moved, or the link may be mistyped.",
  links: [
    { href: "/", label: "Home" },
    { href: "/download", label: "Download RecordStuff" },
    { href: "/help", label: "Help" },
  ],
} as const;

export interface Feature {
  title: string;
  body: string;
}

export const features: Feature[] = [
  {
    title: "One icon, no main window",
    body: "Right-click to start or stop, and for your output folder, Settings and logs. Choose a screen, output folder, countdown, quality and shortcut in Settings.",
  },
  {
    title: "Your folder, your files",
    body: "Recordings go to Movies → RecordStuff, or any folder you pick.",
  },
  {
    title: "Recovery when possible",
    body: "On failure, RecordStuff tries to preserve written media. Recovery after every crash or power loss is not guaranteed.",
  },
  {
    title: "English and Traditional Chinese",
    body: "Switch language any time, even mid-recording.",
  },
];

export interface Step {
  title: string;
  body: string;
}

export const installSteps: Step[] = [
  {
    title: "Open the DMG and drag RecordStuff onto Applications",
    body: "The disk image contains only the app and an Applications shortcut. Eject it afterwards; ejecting does not remove the installed app.",
  },
  {
    title: "Allow the app to open",
    body: "Open RecordStuff from Applications. If macOS blocks it, follow ‘App blocked by macOS?’ at the top of this page.",
  },
  {
    title: "Grant Screen & System Audio Recording",
    body: "Follow the app's prompt to System Settings → Privacy & Security → Screen & System Audio Recording and allow RecordStuff. Choose Quit & Reopen if macOS asks; the app menu also offers a restart. If a separate system audio prompt appears, allow it too.",
  },
  {
    title: "Find the icon in the menu bar",
    body: "RecordStuff has no regular window. Look for its icon at the top of the screen. Left-click to record: a stopwatch replaces the icon and a faint 3, 2, 1 counts down at the top-right of the screen, then REC appears. Left-click again to cancel the countdown or to stop. Right-click to start or stop, and for the output folder, Settings, logs and Quit.",
  },
];

export const updateSteps: Step[] = [
  { title: "Stop any recording and choose Quit from the menu bar icon", body: "" },
  {
    title: "Download the new DMG",
    body: "Optionally compare its SHA-256 with the release's SHA256SUMS file: open Terminal and run `shasum -a 256` on the downloaded file.",
  },
  {
    title: "Drag RecordStuff onto Applications and choose Replace",
    body: "Every release is signed with the same certificate and installed at the same path, so your language, output folder and other settings are kept and macOS normally keeps the recording permission. If a prompt appears again, allow it and relaunch.",
  },
  {
    title: "Launch the updated app and allow it to open",
    body: "Eject the DMG and open RecordStuff from Applications. If blocked, follow ‘App blocked by macOS?’ at the top of this page.",
  },
];

export const removeSteps: Step[] = [
  { title: "Stop any recording and choose Quit from the menu bar icon", body: "" },
  {
    title: "Drag RecordStuff.app from Applications to the Trash and empty it",
    body: "There is no separate uninstaller and no background service. Your recordings, settings and logs stay on disk; delete them yourself only if you no longer need them.",
  },
];

export const retainedData = [
  { data: "Recordings", location: "Movies → RecordStuff in your home folder, or the output folder you chose" },
  { data: "Settings and cache", location: "~/Library/Application Support/recordstuff" },
  { data: "Logs", location: "~/Library/Logs/recordstuff" },
] as const;

/** CI-checked, never run on Windows hardware: shown wherever the Windows installer is offered. */
export const windowsBoundary =
  "CI builds the installer, silently installs and uninstalls it on a GitHub Windows runner and checks its version, architecture and files. Screen capture, system audio, notifications and the tray have not been verified on Windows hardware, and some app wording still assumes macOS, such as “menu bar” and “the Mac went to sleep”.";

/** Shown while the published release predates Windows. */
export const windowsUpcoming = `Windows x64 installers are published on GitHub Releases starting with the first release after ${LAST_MACOS_ONLY_VERSION}.`;

export const windowsSmartScreen =
  "The installer is not code-signed, which its file name states. Windows SmartScreen may show “Windows protected your PC”: click More info, then Run anyway.";

export const windowsInstallSteps: Step[] = [
  {
    title: "Download the installer and run it",
    body: "The file ends in `-x64-unsigned-setup.exe`. It installs RecordStuff for your Windows account only, without an administrator prompt, and creates a Start-menu shortcut, which Windows notifications need.",
  },
  {
    title: "If SmartScreen appears, choose More info → Run anyway",
    body: "Only do this for an installer you downloaded from the RecordStuff release and, ideally, whose SHA-256 you compared. Organization-managed PCs may not allow it.",
  },
  {
    title: "Find the icon in the system tray",
    body: "RecordStuff has no regular window. Its icon is in the system tray; click it to record and click again to stop. Right-click it for Settings, the output folder, logs and Quit. Recordings are saved to Videos → RecordStuff by default.",
  },
];

export const windowsUpdateSteps: Step[] = [
  { title: "Stop any recording and choose Quit from the tray menu", body: "" },
  {
    title: "Download the new installer and run it",
    body: "Optionally compare its SHA-256 first: in PowerShell run `Get-FileHash` on the downloaded file and compare the result, ignoring case, with the installer's line in the release's SHA256SUMS file. Your settings and recordings are kept.",
  },
];

export const windowsRemoveSteps: Step[] = [
  { title: "Stop any recording and choose Quit from the tray menu", body: "" },
  {
    title: "Open Settings → Apps → Installed apps, find RecordStuff and choose Uninstall",
    body: "Uninstalling never deletes your data. Your recordings, settings, history and logs stay on disk; delete them yourself only if you no longer need them.",
  },
];

/** Where the Windows build keeps its data: Electron's standard locations for this app. */
export const windowsRetainedData = [
  { data: "Recordings", location: "Videos\\RecordStuff in your user folder, or the output folder you chose" },
  { data: "Settings and history", location: "%APPDATA%\\recordstuff" },
  { data: "Logs", location: "%APPDATA%\\recordstuff\\logs" },
] as const;

export const settings = [
  { setting: "Screen", options: "Primary display / a connected display", fallback: "Primary display" },
  { setting: "Output folder", options: "Any folder, with Change… and Show in Finder (also in the menu bar)", fallback: "Movies → RecordStuff" },
  { setting: "Countdown", options: "Off / 3 s / 5 s / 10 s", fallback: "3 s" },
  { setting: "Countdown sound", options: "On / Off (a soft tick with each digit; unavailable while the countdown is Off)", fallback: "On" },
  { setting: "Video quality", options: "Economy / Standard / High", fallback: "Standard" },
  { setting: "Resolution cap", options: "1080p / 1440p / 4K / Source", fallback: "Source" },
  { setting: "Frame rate", options: "30 / 60 fps", fallback: "30; 60 is enabled only on macOS" },
  {
    setting: "Shortcut (General)",
    options: "⌘⇧1 (recommended) / Custom shortcut / Off",
    fallback: "⌘⇧1; Settings shows a warning if another app already owns the combination",
  },
] as const;

export const permissionsTroubleshooting =
  "If permission prompts continue after you granted access, make sure you open RecordStuff from Applications, then quit and reopen it. Allowing the app to open and granting recording permission are separate steps; both are required. Do not install certificates, disable Gatekeeper for the whole Mac or reset permissions for other apps.";

export const platformBoundary = {
  verified:
    "Verified on an Apple M1 Pro running macOS 26 with Electron 44. The published macOS installer is arm64 only.",
  windows: `Windows x64 is published but unverified: every release after ${LAST_MACOS_ONLY_VERSION} also carries an unsigned Windows x64 installer. ${windowsBoundary}`,
  unverified:
    "Windows on Arm, Linux, Intel Macs and other macOS versions are unverified, and no build is published for them. Apple notarization is not planned, and Windows code signing is not planned for now.",
} as const;

export const privacy = [
  "Recordings, settings and logs stay on your computer in the locations listed under Help.",
  "The app has no upload backend, account, telemetry or crash reporting.",
  "Update checks contact the website version feed, with GitHub Releases as fallback (on Windows, GitHub Releases only), without installation identifiers. You can turn off the default-on launch check in Settings → General; manual checks remain available.",
  "This website is static and sets no cookies. Downloads are served by GitHub Releases.",
] as const;

export const footer = {
  license: "MIT licensed",
  author: "Eric Tsai",
} as const;
