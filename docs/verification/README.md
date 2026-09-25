# Verification index

[English](README.md) | [繁體中文](../zh-TW/verification/README.md)

For what to run now, use the [testing policy](../testing.md) and [shared acceptance cases](../acceptance.md). This index summarizes recorded evidence; reorganizing these documents does not rerun tests or extend their coverage.

## Recorded scope as of 2026-09-24

| Area | Recorded result and limits |
| --- | --- |
| Plan 026 empty-recording rejection | `FileWriter.finish` refuses zero confirmed bytes as `capture_start_failed` after any retained disk error; no saved event or `.mp4`, empty temporary file removed, idempotent cleanup keeps a same-second retry. 706 tests, a 10.3-second fresh-bundle smoke, a 0.33-second immediate stop saved as nonempty and decodable, and QuickTime playback of both passed; Codex GPT-6 Astra fixed two Medium findings. Native capture never produced empty output, so the no-media path rests on controlled real-file tests. See [history](history-2026-09.md#plan-026-closure--2026-09-25) |
| Plan 036 background history persistence | Asynchronous single-writer history, durable acknowledgement/removal, automatic retry, intent-based focus and a media-first unsaved-reminder quit phase. 687 tests, Settings 113/113, shortcut integration, lifecycle `history` case and fresh-bundle recording/QuickTime/quit smoke passed; Codex GPT-6 Astra fixed two Medium findings, final pass no findings. One pre-fix fixture failure remains unexplained; N24–N26 native cases stay in Plan 035. See [history](history-2026-09.md#plan-036-closure--2026-09-25) |
| Plan 025 termination/exit | Nine findings from two Opus passes fixed; independent disk/result ownership and safe quit. Notifications 2/2, Settings rerun 100/100 and recording smoke passed; maintainer recording-time Quit passed; bilingual dialog capture passed and the maintainer confirmed automatic foregrounding. Plan 025 closed; final check 651 tests, plus four follow-up tooling findings fixed. See [history](history-2026-09.md#plan-025-terminal-ownership--2026-09-25) |
| Multi-failure history | Final627 tests,100/100 Settings and shortcut integration passed; Opus5.5 fixed6Low, final pass no findings; independent unread retry, per-record acknowledgement/removal and v1 migration. Native cases deferred to Plan035. See [history](history-2026-09.md#multi-failure-history--2026-09-25) |
| Latest failure persistence | One result/read state survives restart;617 tests,94/94 Settings and shortcut integration passed. Native restart/recording checks deferred by maintainer to final Plan035. See [persistence](history-2026-09.md#latest-failure-persistence--2026-09-25) |
| Recording failure results | Initial result section and integrated badge verification; 589 unit tests, 86/86 Settings cases and shortcut integration passed. Native error/tray/banner coverage remains blocked; see [failure results](history-2026-09.md#recording-failure-results--2026-09-25) |
| Complete recording writes | Plan 024: 572 tests plus fresh-bundle 10.267-second capture, stereo RMS −27.21/−27.21 dBFS, QuickTime playback/seek and cleanup. Controlled partial-write failures and recovery use real FileWriter; not crash durability or damaged-file playback. See [complete writes](history-2026-09.md#plan-024-complete-writes--2026-09-24) |
| Settings automation | Latest recorded run: 555 unit tests, 76/76 panel cases and 40/40 integration cases, with cleanup. Includes window-size persistence. Controlled registration/tray boundaries do not prove native OS delivery. See [size persistence](history-2026-09.md#settings-window-size-persistence--2026-09-24) |
| Settings native acceptance | Maintainer reported entry, recording/playback, shortcut and appearance checks; confirmed the mouse Confirm fix. Remaining VoiceOver, native contrast, full native matrix, new display-error UI and final external-link opening cases were waived, not passed. See [Plan 022 closure](history-2026-09.md#plan-022-closure--2026-09-24) |
| Display removal/recovery | Maintainer-reported target refusal, recovery and recording/save/playback after removal; no extension to untested hardware or later error UI. See [Plan 021 closure](history-2026-09.md#plan-021-closure--2026-09-23) |
| Release 1.0.0 | CI publication/download verification and local short recording/QuickTime playback on tagged source. First permissions, subjective listening, long recording, full native settings/tray regression and manual DMG install were not tested in this release round. See [release evidence](releases/1.0.0.md) |

These are revision- and environment-specific results, not a declaration that the current checkout passes. Older failure reports remain in history even when a later entry records a fix.

## Evidence locations

- [September 2026 history](history-2026-09.md): development rounds, measurements, failures, fixes, accepted limitations and plan closure decisions, preserved with their original headings.
- Release records: [0.1.0](releases/0.1.0.md), [0.1.1](releases/0.1.1.md), [0.1.2](releases/0.1.2.md), [0.1.3](releases/0.1.3.md), [0.1.4](releases/0.1.4.md), [0.1.5](releases/0.1.5.md), [1.0.0](releases/1.0.0.md).
- `docs/verification/measurements/`: gitignored raw runs, logs, media analyses and screenshots. Links to this directory are **local evidence references**, not downloadable repository artifacts; a fresh clone will not contain them.

For new durable results, add a dated entry to the corresponding monthly history (create a new month when needed), or to the versioned release record. Update this summary when the supported scope changes, and maintain the existing translation. Record source/artifact identity, command/case results, cleanup and limitations using the [report template](../acceptance.md#report-template). Keep history append-only except for link/format corrections; do not rewrite an old failure as a pass. Summaries must remain understandable without local raw files. If another collaborator needs raw evidence, provide a sanitized artifact through an agreed accessible location and label its availability.
