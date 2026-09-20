/**
 * Every sentence the site shows. Facts here are limited to what README.md,
 * resources/INSTALL.md, docs/system-design/desktop.md and the verification
 * record already state; nothing promises notarization, warning-free launch,
 * automatic updates or platforms that were never verified.
 */

export const SITE_NAME = "RecordStuff";

export const meta = {
  title: "RecordStuff — one click in the menu bar records your screen and its sound",
  description:
    "RecordStuff is a free, open-source macOS menu bar app. Click once to record your primary display with system audio to MP4, click again to stop. No window, no account, files stay on your Mac.",
  ogImageAlt: "A low-poly Mac desktop with a campsite at night; in the menu bar the RecordStuff icon is a filled dot with REC beside it, meaning a recording is in progress.",
} as const;

export const hero = {
  titleLines: ["One click. Recording."],
  primaryCta: "Download for macOS",
  secondaryCta: "View source on GitHub",
} as const;

export interface Feature {
  title: string;
  body: string;
}

export const features: Feature[] = [
  {
    title: "One icon, no window",
    body: "Right-click the ring for quality, shortcut, output folder, language and logs.",
  },
  {
    title: "Your folder, your files",
    body: "Recordings go to Movies → RecordStuff, or any folder you pick.",
  },
  {
    title: "Interrupted? Still saved",
    body: "If a recording is cut short, what was written stays on disk.",
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
    body: "RecordStuff is signed with the developer's own certificate and is not notarized by Apple, so macOS may block it after either a first installation or an update. If it does, make sure you trust the file source, then open System Settings → Privacy & Security, find the message about RecordStuff and click Open Anyway. You do not install any certificate. Organization-managed Macs may not allow this. If macOS explicitly warns about malware or a damaged file, stop and report it.",
  },
  {
    title: "Grant Screen & System Audio Recording",
    body: "Follow the app's prompt to System Settings → Privacy & Security → Screen & System Audio Recording and allow RecordStuff. Choose Quit & Reopen if macOS asks; the app menu also offers a restart. If a separate system audio prompt appears, allow it too.",
  },
  {
    title: "Find the icon in the menu bar",
    body: "RecordStuff has no regular window. Look for its icon at the top of the screen. Left-click to record, left-click again to stop. Right-click for quality, shortcut, output folder, language, logs and Quit.",
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
    body: "Eject the DMG and open RecordStuff from Applications. After either a first installation or an update, if macOS blocks the app because the developer cannot be verified or the app is not notarized, make sure you trust the file source, then go to System Settings → Privacy & Security, find the RecordStuff message and click Open Anyway. Follow the confirmation prompts.",
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

export const settings = [
  { setting: "Video quality", options: "Economy / Standard / High", fallback: "Standard" },
  { setting: "Resolution cap", options: "1080p / 1440p / 4K / Source", fallback: "Source" },
  { setting: "Frame rate", options: "30 / 60 fps", fallback: "30; 60 is enabled only on macOS" },
  {
    setting: "Shortcut",
    options: "⌘⌥⇧R / ⌘⇧R / ⌘⌥R / Off",
    fallback: "⌘⌥⇧R; the menu says so if another app already owns the combination",
  },
] as const;

export const permissionsTroubleshooting =
  "If permission prompts continue after you granted access, make sure you open RecordStuff from Applications, then quit and reopen it. Allowing the app to open and granting recording permission are separate steps; both are required. Do not install certificates, disable Gatekeeper for the whole Mac or reset permissions for other apps.";

export const platformBoundary = {
  verified:
    "Verified on an Apple M1 Pro running macOS 26 with Electron 44. The published installer is arm64 only.",
  unverified:
    "Windows, Linux, Intel Macs and other macOS versions are unverified. No Windows, Linux or Intel build is published, and Apple notarization is not planned.",
} as const;

export const privacy = [
  "Recordings, settings and logs stay on your Mac in the locations listed under Help.",
  "The app has no upload backend, account, telemetry or crash reporting.",
  "Update checks contact the website version feed, with GitHub Releases as fallback, without installation identifiers. You can turn off the default-on launch check in the app menu; manual checks remain available.",
  "This website is static and sets no cookies. Downloads are served by GitHub Releases.",
] as const;

export const footer = {
  license: "MIT licensed",
  author: "Eric Tsai",
} as const;
