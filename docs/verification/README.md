# Verification Record

[English](README.md) | [繁體中文](../zh-TW/verification/README.md)

This document preserves conclusions from completed plans separately from the system design. The 2026-09-14 documentation migration did not rerun recordings or expand hardware coverage. Git history retains the removed execution plans.

## Environment and evidence

Verified environment: Apple M1 Pro, macOS 26, Electron 44.3/Chromium 152; external 1920×1080 displays and built-in Liquid Retina XDR at 3456×2234. The installed artifact was macOS arm64, self-signed with RecordStuff Dev and bundle ID com.recordstuff.app.

Intel Macs, other macOS versions, Windows, Linux, another Mac, and a clean account remain unverified. They are not prerequisites for this delivery, as decided by the user.

Original evidence: [2026-09-13 Markdown](measurements/2026-09-13.md) and [JSON](measurements/2026-09-13.json). These historical raw records retain their original Chinese labels, failed trial runs, and verdicts. The English summary below provides the interpretation. Later threshold changes must not rewrite an old run into a passing result.

## Results

| Area | Recorded result | Limits |
| --- | --- | --- |
| 1080p30 Standard, ten minutes | 600.0 s, 569.6 MB, 7.92 Mbps, 29.30 fps, 0.39% drops; aggregate Electron CPU 17% average/21% peak | Moving test material on this machine |
| Hardware encoding | VTEncoderXPCService appeared during recording at about 1.4–1.9% CPU and disappeared afterward | Local H.264 evidence |
| A/V sync | 552 marker pairs; head 89 ms/tail 93 ms, about 3 ms drift; audio/video duration difference −2 ms | Detector bias about 10 ms; inherent latency in other runs about 45–80 ms |
| 30 fps quality levels | About 4.4/8.1/14.9 Mbps for Economy/Standard/High, near targets | Coefficients remain 0.07/0.13/0.24 |
| 60 fps | About 57 fps, 31 Mbps Standard, 23% CPU, 223 MB/min | Did not meet every fps/bitrate threshold; accepted and enabled on macOS |
| System audio | Real sound produced about 160 kbps AAC; requesting two channels produced dual-mono | Not stereo separation; sparse beeps are unsuitable for target bitrate validation |
| Playback and crash file | QuickTime open/seek; killed renderer left 17.64 s/11.5 MB partial MP4, 404 decodable frames, also playable in Chrome | One demonstrated recovery case, not universal repair |
| Retina | Installed app recorded 22.55/17.43 s at 3456×2234; latest file fully decodable with audio | Includes frame-size and first-chunk fixes |
| Self-signing and update | DMG install and deep signature/content checks; same-identity/path update retained screen grant and recorded audio | Ad-hoc → self-signed is a separate identity migration |
| First screen grant | Scoped reset, visible system prompt, settings/menu relaunch, then granted | Does not prove every first grant always needs relaunch |
| First audio refusal | User confirmed prompt and refusal; no_audio_track, idle, no new recording | Explicit user confirmation completed the evidence |
| Audio recovery | Same process still failed after enabling access and choosing Later; relaunch produced 15.34 s playable audio/video | This tested case needed relaunch |
| Revocation during recording | OS-requested quit finalized 47.594271 s MP4; relaunched process correctly needed permission | Not a power-loss test |
| Final recovery | 2026-09-14 00-17-33.mp4: 12.653633 s, 45,041,905 bytes, 1080p H.264 + 48 kHz two-channel AAC; full decode and user playback confirmation | Local result at that time |
| Notifications | User saw error/saved notifications; click/Finder reports and reveal logs | No guarantee of Finder always becoming frontmost |
| Notification icon | User confirmed normal after reboot on 2026-09-14 | Follow-up closed; exact cause not established |

## Verified artifact identity

These fingerprints identify the historical artifact, not a future rebuild or public download.

| Item | Value |
| --- | --- |
| DMG | dist/local/RecordStuff-0.1.0-arm64-selfsigned.dmg |
| Size | 126,081,923 bytes |
| DMG SHA-256 | `a1b7fcd31b7cde79aa652e5b87e17e45a251dbfc7fc1bc705473df37ca9245cc` |
| app.asar SHA-256 | `c29a2ef8f9c1790fcecd597079776474cbab0eff11ec654d40099a05a3320274` |
| Public certificate SHA-1 | `01B373511530BBF287CA35E54C10A5F017AAD637` |

The private key is not part of the repository or download. Temporary logs and recordings may have been removed; retained measurements do not imply those files still exist. The last full pre-migration application check was 13 test files, 211 tests, typecheck, and build passing. New language changes require their own current checks and release artifact.

## Repeatable verification

See [tooling](../system-design/tooling.md) for commands and thresholds. Use short recordings plus full decode for basic regression, and relevant matrices after capture/quality changes. Long is now three minutes; do not rerun the ten-minute baseline solely for documentation work. Separate automated fail/n/a, material limitations, and accepted deviations.

A local DMG is not evidence of public availability or the actual browser-download installation path. Those remaining steps belong to the [downloadable release plan](../../plans/010-downloadable-macos-release.md).

## Documentation and localization follow-up — 2026-09-14

The English-source documentation migration and persistent English/Traditional Chinese app UI passed `pnpm check`: 14 test files, 221 tests, typecheck, and build. Coverage includes catalog placeholder parity, English defaults for older settings, failed and concurrent saves, language changes during recording, and notification action preservation. `pnpm matrix -- quick --dry-run` passed with English output. Local documentation links and `git diff --check` were checked; the relocated historical Markdown/JSON were byte-for-byte identical to their Git originals.

No new signed installer, native UI recording run, or public release was produced by this follow-up. Those checks remain in the downloadable release plan.
