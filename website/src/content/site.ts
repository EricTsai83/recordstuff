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
  title: "RecordStuff — screen and sound, nothing else",
  description:
    "A free, open-source macOS menu bar app that records your screen and system audio to a plain MP4. No account, no editor; files stay on your Mac.",
  ogImageAlt: "A low-poly Mac desktop with a campsite at night; in the menu bar the RecordStuff icon is a filled dot with REC beside it, meaning a recording is in progress.",
} as const;

export const hero = {
  title: "Screen and sound. Nothing else.",
  primaryCta: "Download for macOS",
  /** Replaces the macOS button for Windows visitors, only while the release carries the installer. */
  windowsCta: "Download for Windows",
  windowsNote: "not verified on Windows hardware",
  /** Under the version line: the other platform, for a wrong guess or another computer. */
  otherWindows: "Also available for Windows",
  otherMac: "Also available for macOS",
  secondaryCta: "View source on GitHub",
  /** The demo loops for as long as the page is open; this control stops it (WCAG 2.2.2). */
  pauseScene: "Pause animation",
  playScene: "Play animation",
} as const;

export const notFound = {
  title: "Page not found",
  description: "This page doesn't exist or has moved.",
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
  { title: "Lives in the menu bar", body: "One icon to start, stop and find your recordings." },
  { title: "Your files stay yours", body: "Plain MP4s in Movies → RecordStuff, or any folder you pick." },
  { title: "Keeps what it can", body: "If a recording fails, it tries to save what was written." },
  { title: "English and 繁體中文", body: "Switch any time, even while recording." },
];

export interface Step {
  title: string;
  body: string;
}

export const installSteps: Step[] = [
  { title: "Open the DMG and drag RecordStuff onto Applications", body: "Then eject the DMG." },
  {
    title: "Open RecordStuff from Applications",
    body: "If macOS blocks it, see ‘App blocked by macOS?’ above.",
  },
  {
    title: "Allow Screen & System Audio Recording",
    body: "Follow the app's prompt to System Settings → Privacy & Security, allow RecordStuff, then choose Quit & Reopen. Allow the system audio prompt too if one appears.",
  },
  {
    title: "Record from the menu bar",
    body: "Click the icon and choose Start recording, or press ⇧⌘1. Stop the same way.",
  },
];

export const updateSteps: Step[] = [
  { title: "Quit RecordStuff from its menu bar icon", body: "" },
  {
    title: "Download the new DMG",
    body: "Optionally check it with `shasum -a 256` against the release's SHA256SUMS.",
  },
  {
    title: "Drag RecordStuff onto Applications and choose Replace",
    body: "Settings are kept, and macOS normally keeps the recording permission. If it asks again, allow it and relaunch.",
  },
  { title: "Open the updated app", body: "If macOS blocks it, see ‘App blocked by macOS?’ above." },
];

export const removeSteps: Step[] = [
  { title: "Quit RecordStuff from its menu bar icon", body: "" },
  {
    title: "Drag RecordStuff from Applications to the Trash",
    body: "There is no uninstaller or background service. Your data stays where it is:",
  },
];

export const retainedData = [
  { data: "Recordings", location: "Movies → RecordStuff, or the folder you chose" },
  { data: "Settings", location: "~/Library/Application Support/recordstuff" },
  { data: "Logs", location: "~/Library/Logs/recordstuff" },
] as const;

/** CI-checked, never run on Windows hardware: shown wherever the Windows installer is offered. */
export const windowsBoundary =
  "CI checks that the installer installs and uninstalls; screen capture, system audio, notifications and the tray have not been tested on Windows hardware.";

/** Shown while the published release predates Windows. */
export const windowsUpcoming = `Windows x64 installers are published on GitHub Releases starting with the first release after ${LAST_MACOS_ONLY_VERSION}.`;

export const windowsSmartScreen =
  "The installer is unsigned, so SmartScreen may warn: choose More info → Run anyway.";

export const windowsInstallSteps: Step[] = [
  {
    title: "Run the installer",
    body: "It installs for your account only, with no administrator prompt, and adds a Start-menu shortcut.",
  },
  {
    title: "If SmartScreen appears, choose More info → Run anyway",
    body: "Only for an installer from the RecordStuff release. Managed PCs may block this.",
  },
  {
    title: "Record from the system tray",
    body: "Click the icon and choose Start recording, or press Ctrl+Shift+1. Recordings go to Videos → RecordStuff.",
  },
];

export const windowsUpdateSteps: Step[] = [
  { title: "Quit RecordStuff from its tray icon", body: "" },
  {
    title: "Run the new installer",
    body: "Optionally check it with `Get-FileHash` against the release's SHA256SUMS. Settings and recordings are kept.",
  },
];

export const windowsRemoveSteps: Step[] = [
  { title: "Quit RecordStuff from its tray icon", body: "" },
  {
    title: "Uninstall it in Settings → Apps → Installed apps",
    body: "Your data stays where it is:",
  },
];

/** Where the Windows build keeps its data: Electron's standard locations for this app. */
export const windowsRetainedData = [
  { data: "Recordings", location: "Videos\\RecordStuff, or the folder you chose" },
  { data: "Settings", location: "%APPDATA%\\recordstuff" },
  { data: "Logs", location: "%APPDATA%\\recordstuff\\logs" },
] as const;

export const settings = [
  { setting: "Screen", options: "Primary or a connected display", fallback: "Primary" },
  { setting: "Output folder", options: "Any folder", fallback: "Movies → RecordStuff" },
  { setting: "Countdown", options: "Off / 3 / 5 / 10 s, with an optional tick", fallback: "3 s, tick on" },
  { setting: "Video quality", options: "Economy / Standard / High", fallback: "Standard" },
  { setting: "Resolution cap", options: "1080p / 1440p / 4K / Source", fallback: "Source" },
  { setting: "Frame rate", options: "30 / 60 fps", fallback: "30 fps" },
  { setting: "Shortcut", options: "⇧⌘1 / custom / off", fallback: "⇧⌘1" },
  { setting: "Icon click", options: "Open the menu / Start or stop", fallback: "Open the menu" },
] as const;

export const permissionsTroubleshooting =
  "Opening the app and recording the screen are separate permissions; both are needed. If prompts keep coming back, open RecordStuff from Applications and relaunch it.";

export const platformBoundary = {
  verified: "Verified on an Apple M1 Pro with macOS 26. The macOS build is Apple silicon only.",
  windows: `A Windows x64 build is published but not verified: ${windowsBoundary}`,
  unverified:
    "No builds for Intel Macs, Windows on Arm or Linux. Apple notarization and Windows code signing are not planned.",
} as const;

export const privacy = [
  "Recordings, settings and logs stay on your computer.",
  "No account, uploads, telemetry or crash reporting.",
  "Update checks send nothing that identifies you. The check at launch can be turned off in Settings → General.",
  "This website sets no cookies; it only remembers your macOS or Windows choice in your browser. Downloads come from GitHub Releases.",
] as const;

export const footer = {
  license: "MIT licensed",
  author: "Eric Tsai",
} as const;
