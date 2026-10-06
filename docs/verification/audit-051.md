# Forty audit repairs (051)

[English](audit-051.md) | [繁體中文](../zh-TW/verification/audit-051.md)

All forty repairs are implemented; plan 051 closed on 2026-09-29 after guided display and permission acceptance. Native tray clicks remain deferred by the maintainer. Exact branch limits are retained below. No commit, push or publication.

| # | Reason | Result | Main location |
| --- | --- | --- | --- |
| 1 | Missing custom folder recreated | Create only default/development folders; reject missing custom folders | [file-writer.ts](../../src/main/recording/file-writer.ts) |
| 2 | Pending preferences lost on quit | Flush preferences, geometry and logs after media settles; defer on timeout | [index.ts](../../src/main/index.ts) |
| 3 | Quit protection installed too late | Install the coordinator before first-run asynchronous interaction | [index.ts](../../src/main/index.ts) |
| 4 | Recording starts while folder dialog is open | Deduplicate the dialog and recheck admission on return | [preferences.ts](../../src/main/settings/preferences.ts) |
| 5 | Queued setting input is mutable | Snapshot patches before enqueueing | [settings.ts](../../src/main/settings/settings.ts) |
| 6 | Getters expose mutable internal state | Return copies of structured preferences | [settings.ts](../../src/main/settings/settings.ts) |
| 7 | Unreadable history appears empty | Expose load failure and preserve the unreadable file | [recording-result-store.ts](../../src/main/recording/recording-result-store.ts) |
| 8 | Completed recording leaves false interruption | Persist completion checkpoint; describe the remaining crash gap as unknown | [session-sentinel.ts](../../src/main/recording/session-sentinel.ts) |
| 9 | Post-copy sync failure leaves a final-looking file | Remove failed destination and retain original media | [file-writer.ts](../../src/main/recording/file-writer.ts) |
| 10 | Uncontained capture preparation exception | Release tracks and report preparation failure | [capture-host.ts](../../src/renderer/capture/capture-host.ts) |
| 11 | Unbounded Blob handoff | Stop with failure at a 64 MiB backlog | [capture-host.ts](../../src/renderer/capture/capture-host.ts) |
| 12 | Repeated finish and late append | Own terminal operations and reject late appends | [file-writer.ts](../../src/main/recording/file-writer.ts) |
| 13 | Large JSON parsing blocks main | Parse histories above 1 MiB in a worker | [recording-result-store.ts](../../src/main/recording/recording-result-store.ts) |
| 14 | Repeated history projection costs | Cache immutable row projections and send loaded rows | [settings-model.ts](../../src/main/settings/settings-model.ts) |
| 15 | Unbounded initial history DOM | Render 50 rows initially, load more explicitly | [settings.ts](../../src/renderer/settings/settings.ts) |
| 16 | Synchronous logging blocks event loop | Bound and serialize asynchronous file logging | [log.ts](../../src/main/lib/log.ts) |
| 17 | Synchronous geometry fsync | Queue atomic geometry writes and flush on quit | [settings-window-state.ts](../../src/main/settings/settings-window-state.ts) |
| 18 | Resolution degradation is log-only | Expose a localized Settings diagnostic and notification | [index.ts](../../src/main/index.ts) |
| 19 | Stale Settings response overwrites new state | Version views and isolate retired-window delivery caches | [settings-window.ts](../../src/main/settings/settings-window.ts) |
| 20 | Preference side effects crowd index | Extract shared preference orchestration | [preferences.ts](../../src/main/settings/preferences.ts) |
| 21 | Missing primary captures arbitrary source | Require exactly one matching display ID | [display-source.ts](../../src/main/display/display-source.ts) |
| 22 | Primary changes during enumeration | Revalidate topology and primary identity after enumeration | [display-source.ts](../../src/main/display/display-source.ts) |
| 23 | Enumeration exceptions misclassified as permissions | Preserve exception cause and report capture_start_failed | [display-source.ts](../../src/main/display/display-source.ts) |
| 24 | Preparation cannot be cancelled | Add explicit cancellation during opening and preparation | [recorder.ts](../../src/main/recording/recorder.ts) |
| 25 | Capture starts with too little disk | Check minimum headroom before opening media | [recorder.ts](../../src/main/recording/recorder.ts) |
| 26 | Copy fallback needs recording-sized space | Check full file size plus 8 MiB before copying | [file-writer.ts](../../src/main/recording/file-writer.ts) |
| 27 | Partial-file stat stalls UI indefinitely | Bound metadata lookup to two seconds | [recording-result.ts](../../src/main/recording/recording-result.ts) |
| 28 | Permission state suppresses completed-save notice | Allow completed-save notices during permission recovery | [saved-notification.ts](../../src/main/recording/saved-notification.ts) |
| 29 | Notification constructor can throw | Contain construction and display exceptions | [tray.ts](../../src/main/menus/tray.ts) |
| 30 | Stale permission notice relaunches unnecessarily | Revalidate permission action at click time | [index.ts](../../src/main/index.ts) |
| 31 | Missing saved file has no notification fallback | Reuse the shared saved-file reveal fallback | [tray.ts](../../src/main/menus/tray.ts) |
| 32 | Wake polling without pending notices | Poll only while held notifications await delivery | [tray.ts](../../src/main/menus/tray.ts) |
| 33 | Shortcut conflict cannot be retried | Expose explicit registration retry | [shortcuts.ts](../../src/main/shortcuts/shortcuts.ts) |
| 34 | Release/update version grammar differs | Share stable-version grammar and reject leading zeros | [version.ts](../../src/shared/version.ts) |
| 35 | Failed website script hides content | Activate reveal styling only after observer installation | [Layout.astro](../../website/src/layouts/Layout.astro) |
| 36 | Relative links resolve from root incorrectly | Resolve against each source page URL | [check-links.mts](../../website/scripts/check-links.mts) |
| 37 | HEAD redirect accepted without destination check | Follow redirects and require final success | [release-manifest-client.mts](../../scripts/lib/release/release-manifest-client.mts) |
| 38 | Unbounded media subprocess | Apply configurable 15-minute timeout with SIGKILL | [media-tools.mts](../../scripts/lib/verification/media-tools.mts) |
| 39 | Tool probe ignores exit status | Require successful version-command exit | [media-tools.mts](../../scripts/lib/verification/media-tools.mts) |
| 40 | Measurement evidence partially updated | Atomically replace both files with replayable recovery journal | [verify-recording.mts](../../scripts/lib/verification/verify-recording.mts) |

## Validation and limits

- PASS: final pnpm acceptance:regression: TypeScript, 1,192 tests, production build, 171/171 Settings cases and shortcut failure integration. Regressions include concurrent empty finish/abandon, preference snapshots/flush, folder-dialog admission, copy sync/capacity failures, preparation exceptions, Blob backlog, large history/paging, completed sentinels, version grammar and report recovery.
- PASS: pnpm acceptance:lifecycle: copy, cleanup, result and history process-lifetime cases; normal exit in all four.
- PASS: git diff --check; changed-document relative targets/anchors and bilingual commands checked.
- PASS: pnpm site:check: 16 tests, Astro diagnostics/build, online manifest and links; four pages, 49 internal references and 13 external URLs. T3 preview inspection confirmed visible homepage reveal content.
- PASS: pnpm acceptance:shortcut-layout using Zhuyin; input source restored.
- PASS: pnpm acceptance:updates -- --full --logic-only: filtering, fallback, timeout, persistence, restart and shutdown cancellation. The update change is parsing-only; normal-bundle recordings cover capture separately.
- PASS: five notification clicks selected the correct saved file in foreground Finder; installed app/preferences restored. The first preflight refused existing Finder windows; closing the recording-folder window allowed the successful retry.
- PASS: native preference persistence, normal quit/reopen, custom output selection/restoration. Two approximately ten-second shortcut recordings saved and fully decoded with screen flashes and stereo audio markers; countdown cancellation left no media/failure. The bundle before the final retry-action routing fix saved into /private/tmp/recordstuff-audit-051-output and was played in QuickTime. The earlier same-scope movie also verified tail seeking. No subjective listening claim.
- PASS: pnpm measure:cpu -- --fps 60. Idle 0.048%, post-recording idle 0.051%, background Settings 0.065%; recording averages 14.4% at 30 fps and 20.6% at 60 fps. All CPU budgets and process-lifetime checks passed. This establishes budget compliance, not a statistically measured speedup.

The new click regression exposed a shortcut retry action/accelerator routing conflict and a DOM ID collision with the existing hidden save-retry control. Both are fixed; the final real-page click restores registration and retains the saved selection. Earlier failed fixture runs remain in the local evidence.

### Evidence and limits

Final Settings: 2026-09-28T16-25-03-009Z-settings-acceptance; shortcuts: 2026-09-28T16-25-55-763Z-shortcut-failure; lifecycle: 2026-09-28T15-59-19-218Z-lifecycle. Recordings: 2026-09-28T15-51-14-620Z-hotkey-acceptance (default folder), 2026-09-28T16-01-09-180Z-hotkey-acceptance (custom folder, before retry routing fix). Notifications: 2026-09-28T162758.157Z-notification-acceptance; updates: 2026-09-28T16-29-17-242Z-updates-qDj7WY; layout: 2026-09-28T16-26-32-155Z-shortcut-layout. Evidence lives under local docs/verification/measurements, which is gitignored.

Final regression, layout, signed-build quit, notification and update runs follow the last shortcut retry fix. CPU (2026-09-28T16-02-59-528Z-cpu), custom-path recording and playback were captured earlier in this dirty-tree round on HEAD 1d57d7138f43d035aefd9ed15fc9f3b4eabea298 plus these repairs; only retry-action routing/identity changed afterwards, so the unchanged recording/timer scope is reused. Native acceptance used the project computer-use skill; native panel/player snapshots are tool observations, not invented local PNGs. The website screenshot is in T3 browser-artifacts.

Guided native follow-up (2026-09-29): seven functional cases passed on a freshly signed bundle, HEAD 1d57d7138f43d035aefd9ed15fc9f3b4eabea298 plus these repairs. The maintainer switched the primary display to portrait; an 11.5 s, 1080×1920 recording saved, decoded and played with user-confirmed tail seeking. Removing that primary during countdown safely returned idle without media or switching capture to another display. Turning permission off during an existing recording still allowed a valid 27.8 s save; a subsequent start correctly failed with permission_denied and no media. Re-enabling permission recovered the same process without restart. Clicking the old permission notice opened Settings without restarting. A final agent-run 10.4 s, 1920×1080 recording passed integrity checks (10 flashes/10 beeps), and native QuickTime observations showed playback advancing and a jump back to the beginning. Evidence: local docs/verification/measurements/2026-09-29-audit-051-guided/report.md and recovery-smoke/report.md. Both desktop takeovers followed an explicit “好了”; hardware and privacy-switch actions were performed by the maintainer.

Limits retained at closure: removal happened during countdown, not while getSources was pending, so the precise enumeration race has deterministic coverage only. The save after permission revocation occurred in idle, not needsPermission; that saved-notification branch also remains native-unverified. An initial unplug attempt removed the secondary display and is retained without counting it as the primary-removal case. Native tray access had returned -10005 timeoutReached; the maintainer explicitly deferred those clicks, not marked them passed. Filesystem faults were injected instead of filling or disconnecting real storage. Plan closure records the observed display/permission cases and this tray disposition; it does not claim every OS timing branch was reproduced.

Follow-up cleanup passed: settings JSON unchanged, both displays and the original landscape primary restored, permission on, owned material/player/Settings UI closed, RecordStuff/helpers exited normally and caffeinate stopped. Test movies and expected failure-history entries were retained. QuickTime screenshots are conversation tool observations, not local PNGs; subjective listening was not assessed.

Scope exclusions: full resolution/quality matrix, long recordings, audio fidelity, first permission grant and release/install acceptance; encoding parameters and audio processing were unchanged. This dirty-tree development run is not release acceptance.

Caffeinate ran during testing and was stopped. Final cleanup passed: preferences and the original Finder recording-folder window restored; RecordStuff/helpers, QuickTime and owned fixtures exited. The app remains closed. Force quit/power loss cannot guarantee recovery; the publication/checkpoint crash gap remains explicitly unknown. Metadata deadlines do not cancel OS filesystem requests. Report journaling restores the pair on the next write, not cross-process atomic visibility.

Human desktop interaction outside test steps can affect focus, screenshots and interpretation; the workflow does not detect every interference.
