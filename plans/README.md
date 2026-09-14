# Remaining Work

[English](README.md) | [繁體中文](README.zh-TW.md)

Updated: 2026-09-15. v0.1.1 was built in CI, manually accepted, and published without rebuilding; see [release evidence](../docs/verification/releases/0.1.1.md). The user-provided browser-download checksum matches; 011 is complete. See [release automation](../docs/system-design/releases.md).

## Order and status

| Order | Plan | Status | Completion target |
| --- | --- | --- | --- |
| Next | [013 Installation experience](013-macos-installation-experience.md) | Planned | DMG without help documents; online guides; manual update/removal and data retention instructions |
| With next release | [014 Finder notification focus](014-finder-notification-focus.md) | Planned | Reproduce and fix explicit-click foreground behavior; verify native focus |
| Ready for implementation | [012 Official website](012-download-website.md) | Planned | Bilingual product/help website with direct DMG downloads and version/checksum details |
| When update convenience is prioritized | [015 App update assessment](015-app-update-assessment.md) | Deferred decision only | Compare manual, user-triggered check and automatic update; establish self-signing feasibility |

013 and 014 may share a new release; neither requires CI or a website. 011 automates publishing, not installed-app updates. 015 does not authorize implementation of an updater. Public release notes stay English-only; app UI and reader guides remain bilingual. Published v0.1.0 bytes must not be overwritten.

No dedicated uninstaller is planned: quit and move the app to Trash; user data remains unless separately removed. No native-platform rewrite solely for size reduction, Apple certification, Windows/Linux/Intel verification or expansion is scheduled. DMG size was explained by Electron's runtime cost; discussion alone does not create a rewrite project.

All plan language versions live in this directory: English `<name>.md`, Traditional Chinese `<name>.zh-TW.md`.

## Completing a plan

Keep plans limited to unfinished work. Capture durable conclusions in [system design](../docs/system-design/README.md) and [verification](../docs/verification/README.md), update README/index and translations, then remove completed plans and their translations. Preserve failures and historical evidence; Git retains execution history.
