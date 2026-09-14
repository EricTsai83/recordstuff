# 015 App Update Mechanism Assessment

[English](015-app-update-assessment.md) | [繁體中文](015-app-update-assessment.zh-TW.md)

Status: Deferred decision option, not scheduled implementation. Updated: 2026-09-15.

## Current boundary

RecordStuff has no in-app update check or automatic updater. Manual replacement is covered by 013. Plan 011 automates release production/publication, not installed apps. Asking about update mechanisms does not select an automatic-install policy. Keep the first-release path and installer cleanup independent of this assessment.

## Assessment when activated

1. Compare continuing manual downloads, a user-triggered update check with a release-page link, and a full automatic updater. State the actual user benefit and maintenance cost; do not assume full automation is required.
2. Verify current Electron/updater requirements for the fixed self-signed macOS identity, supported artifact formats/feed metadata, and Gatekeeper behavior. Establish feasibility before promising transparent installation; Apple certification remains outside the accepted scope.
3. Propose update timing and user control: never interrupt a recording, require explicit restart/install intent, handle offline/error/partial downloads, verify trusted source and artifact integrity, preserve settings/recordings, and reject unintended downgrades or incompatible architectures. Assess recovery if replacement fails.
4. Record the decision and tradeoffs. If implementation is selected, replace this assessment with a concrete implementation/validation plan and dependencies. A real installed-version-to-new-version update, interrupted-download recovery and recording-in-progress deferral must be proven before claiming an updater works.

## Completion

A documented choice with feasibility evidence and a clear implementation boundary. No updater dependency, background polling, telemetry, new signing identity, or silent installation is introduced by this planning task.
