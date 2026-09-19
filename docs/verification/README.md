# Verification Record

[English](README.md) | [繁體中文](../zh-TW/verification/README.md)

This document preserves conclusions from completed plans separately from the system design. The 2026-09-14 documentation migration did not rerun recordings or expand hardware coverage. Git history retains the removed execution plans.

## Environment and evidence

Verified environment: Apple M1 Pro, macOS 26, Electron 44.3/Chromium 152; external 1920×1080 displays and built-in Liquid Retina XDR at 3456×2234. The installed artifact was macOS arm64, self-signed with recordstuff Dev.

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
| Global shortcut | `pnpm acceptance` against the windowless `/Applications` build (softened 660 Hz material, Chrome app-mode fullscreen): ⌘⌥⇧R through System Events reached the app in 166 ms (pressed → recording 96 ms), 20 s recorded and saved, integrity tier passed, 48 kHz two-channel RMS −27.1/−27.2 dB, 20 flashes and 19 beeps detected, flash/beep offset 79 ms ([report](measurements/2026-09-19T1616-hotkey-acceptance/report.md)); the Codex computer-use run with the same key path completed material, recording, verify and QuickTime playback ([23:34 run](measurements/2026-09-19T233434-computer-use/report.md)) | Audio bitrate is reported only for the sparse test material; a run with a video playing in the background was rejected by the beep guard (0 beeps separable from silence), so background audio must be off; Computer Use `pressKey` cannot reach a global shortcut and three non-interactive runs were blocked by per-app approvals ([20:56](measurements/2026-09-19T205642-computer-use/report.md), [20:59](measurements/2026-09-19T205941-computer-use/report.md), [21:20](measurements/2026-09-19T2120-computer-use/report.md), [21:33 fail](measurements/2026-09-19T213348-computer-use/report.md), [root cause](measurements/2026-09-19T2101-hotkey-osascript/report.md)); tray menu cases and listening remain unverified by tooling |

## Verified artifact identity

These fingerprints identify the historical artifact, not a future rebuild or public download.

| Item | Value |
| --- | --- |
| DMG | dist/local/recordstuff-0.1.0-arm64-selfsigned.dmg |
| Size | 126,081,923 bytes |
| DMG SHA-256 | `a1b7fcd31b7cde79aa652e5b87e17e45a251dbfc7fc1bc705473df37ca9245cc` |
| app.asar SHA-256 | `c29a2ef8f9c1790fcecd597079776474cbab0eff11ec654d40099a05a3320274` |
| Public certificate SHA-1 | `01B373511530BBF287CA35E54C10A5F017AAD637` |

The private key is not part of the repository or download. Temporary logs and recordings may have been removed; retained measurements do not imply those files still exist. The last full pre-migration application check was 13 test files, 211 tests, typecheck, and build passing. New language changes require their own current checks and release artifact.

## Repeatable verification

See [tooling](../system-design/tooling.md) for commands and thresholds. Use short recordings plus full decode for basic regression, and relevant matrices after capture/quality changes. Long is now three minutes; do not rerun the ten-minute baseline solely for documentation work. Separate automated fail/n/a, material limitations, and accepted deviations.

A local DMG is not evidence of public availability or the actual browser-download installation path. The subsequently completed public-download checks are recorded in [v0.1.0 evidence](releases/0.1.0.md).

## Documentation and localization follow-up — 2026-09-14

The English-source documentation migration and persistent English/Traditional Chinese app UI passed `pnpm check`: 14 test files, 221 tests, typecheck, and build. Coverage includes catalog placeholder parity, English defaults for older settings, failed and concurrent saves, language changes during recording, and notification action preservation. `pnpm matrix -- quick --dry-run` passed with English output. Local documentation links and `git diff --check` were checked; the relocated historical Markdown/JSON were byte-for-byte identical to their Git originals.

No new signed installer, native UI recording run, or public release was produced by this follow-up. Those checks remain in the downloadable release plan.

## Audio fidelity automation — 2026-09-14

Added `pnpm audio:quality` ([usage and thresholds](../system-design/tooling.md#audio-fidelity-regression)). `pnpm check` passed: 15 test files, 232 tests, typecheck, and build, including actual FFmpeg AAC/low-pass/format/CLI integration tests. Clean PCM and FFmpeg AAC pass; deliberately degraded fixtures fail. A startup-transient regression test protects marker alignment; invalid marker/gap checks suppress misleading frequency measurements.

The completed macOS automatic run recorded 16 seconds through the unchanged app capture path. The [raw report](measurements/2026-09-14-audio-quality.json) is **fail**, not a passing audio baseline: 48 kHz/two-channel format and marker checks passed, but 1 kHz channel separation was approximately 0 dB (required ≥30 dB), 12 kHz response was −20.44/−12.64 dB in the left/right probe sequences, and 16 kHz was −74.72/−66.73 dB, relative to each sequence's 1 kHz reference. Additional gain/residual failures are retained in the report. The PCM fixture and FFmpeg AAC control pass these same frequency checks.

This is evidence of high-frequency loss and dual-mono in this local playback → system capture → AAC path, consistent with the reported muffled sound; it does not isolate the responsible stage. Sequential tones can also expose time-varying gain, so channel response differences are not proof of asymmetric hardware. Device/volume were not controlled or measured; thresholds are initial engineering gates. The runner did not change app audio settings or fix the underlying sound. Reference and capture logs remain under `/tmp/recordstuff-audio-quality-20260914-final`; the MP4 location is in the raw report. Temporary artifacts may later be removed. No new installer was produced.

## Audio diagnostic v2 robustness repair — 2026-09-14

The [design guide](../system-design/audio-quality.md) records the rationale, algorithms, gates, and limits. Two v1 problems were reproduced: deleting the first/last 100 ms of each 600 ms probe still passed, while clean signals with only 10 ppm clock offset failed residual checks. V2 closes those cases with overlapping per-component windows and bounded frequency estimation/least-squares fitting. Simultaneous pilot normalization also separates between-probe gain changes from spectral response; a terminal marker prevents silent duration padding from masquerading as a complete fixture.

`pnpm check` passed: 15 files, 254 tests, including **33 audio-tool tests**, typecheck, and build. Controls include ±10/20/100 ppm with independent phase, excessive clock offset, actual FFmpeg AAC/low-pass/format decoding, edge/central/target-only dropouts, a 50 ms end insertion, local clipping, invalid markers, repeat aggregation, incomplete batches, and CLI preservation/exit status. Document targets, paired chapters, and `git diff --check` passed. No production audio-processing change was made.

Three real v2 captures completed: **0 pass, 2 fail, 1 invalid**. The [summary](measurements/2026-09-14-audio-v2/summary.json) remains invalid. Run 1's marker gap was −22.63 dB versus the −30 dB identity gate; unsupported spectral rows were suppressed. Runs 2 and 3 had valid markers and retained failures: 1 kHz separation approximately 0 dB, left 16 kHz response −46.64 to −46.48 dB and right −44.14 to −43.85 dB against the simultaneous pilot. Some additional residual/gain/12 kHz checks failed; see [run 1](measurements/2026-09-14-audio-v2/run-1.json), [run 2](measurements/2026-09-14-audio-v2/run-2.json), and [run 3](measurements/2026-09-14-audio-v2/run-3.json).

[Before](measurements/2026-09-14-audio-v2/environment-before.json) and [after](measurements/2026-09-14-audio-v2/environment-after.json) device/volume snapshots were unchanged. This is endpoint evidence, not continuous control of the environment. Invalid measurements were excluded from per-metric ranges and counted as missing. These runs are failure evidence, not a calibrated passing baseline. V1/V2 use different stimuli and estimators; their exact dB values must not be read as a before/after product improvement. Original v1 evidence is unchanged. Temporary material/logs remain in `/tmp/recordstuff-audio-v2-20260914`; MP4 paths are in each report. No new installer was produced.

## System audio processing correction — 2026-09-14

The capture host now explicitly disables echo cancellation, noise suppression, and automatic gain while retaining own-audio exclusion and ideal stereo. See the [design explanation](../system-design/audio-quality.md#15-system-capture-correction--2026-09-14). The fixture, analyzer and its thresholds were unchanged during the comparison. The [initial trial](measurements/2026-09-14-audio-processing-off/initial-trial.json) restored high-frequency response but retained early noise/separation/gap failures.

The repeated final-code batch was **2 pass, 0 fail, 1 invalid**, with unchanged before/after device/volume snapshots. Its [summary](measurements/2026-09-14-audio-processing-off/summary.json) deliberately remains invalid: [run 1](measurements/2026-09-14-audio-processing-off/run-1.json) failed marker-gap identity (−18.81 dB). [Run 2](measurements/2026-09-14-audio-processing-off/run-2.json) and [run 3](measurements/2026-09-14-audio-processing-off/run-3.json) passed every gate. In these valid runs, left/right 16 kHz response was within 0.004 dB of the simultaneous pilot, compared with approximately −44 to −47 dB in the earlier valid baseline; stereo separation exceeded 30 dB rather than approximately 0 dB. Near-floor separation values are numerical evidence of negligible leakage, not calibrated hardware specifications.

Environment evidence: [before](measurements/2026-09-14-audio-processing-off/environment-before.json), [after](measurements/2026-09-14-audio-processing-off/environment-after.json). The code warnings report explicitly enabled processing despite false requests; missing settings remain unknown. This experiment identifies the combined-constraint correction on this local path, not each effect's individual contribution. Previously saved files remain unchanged.

Validation of the correction: `pnpm check` passed 15 files/255 tests, typecheck, and build. `pnpm start:app` built, self-signed, verified nine bundle identities and opened `dist/dev/mac-arm64/recordstuff.app`. This is the local rebuilt app for listening; it does not replace the copy in `/Applications`. Local document targets and `git diff --check` passed.

## macOS 0.1.0 release — 2026-09-15

[Current artifact and download-path evidence](releases/0.1.0.md). The public release is available; installed-candidate checks passed with a Finder foreground limitation. Browser-download installation and recording passed after per-app Open Anyway approval; see the linked record for user-reported checks and local limits. Historical hashes above are unchanged.

## Simplified installer and tag-triggered release 0.1.2 — 2026-09-19

The 0.1.2 source removes the bundled guides from the DMG and adds a generated arrow background; the release gate now requires exactly the App and Applications link. A local `pnpm dist:mac` build passed the candidate gate and a Finder layout check; `pnpm start:app` plus a manual 16.7 s recording passed the integrity checks; removal on a disposable copy left user data unchanged; the `v0.1.2` tag push published the release in under three minutes, and the anonymous public-download verification job passed in 22 seconds. See [0.1.2 evidence](releases/0.1.2.md) and [release automation](../system-design/releases.md). The verifier was split into integrity and performance tiers the same day, see [tooling](../system-design/tooling.md#measurement-pipeline-and-thresholds).
