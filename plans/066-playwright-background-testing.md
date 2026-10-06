# 066 — Migrate routine acceptance to Playwright without taking over the desktop

[English](066-playwright-background-testing.md) | [繁體中文](066-playwright-background-testing.zh-TW.md)

Created: 2026-10-06. Status: planned; implementation has not started. Source: the maintainer wants automated tests that let them keep using their keyboard and mouse, and requested a complete migration plan first. Execute this plan in order under [the plan index](README.md) and [the shared testing policy](../docs/testing.md).

## Outcome and limits

Make `pnpm acceptance:regression` a fully automated background check of routine renderer and Electron integration behavior. It must not show windows, take OS focus, move the system pointer, register global shortcuts, play sound, deliver native notifications, open Finder/browser/System Settings, or record the user's display/audio. The maintainer can continue working during this command. Keep the production renderer, CSP, sandboxed preload, IPC, persistence and media protocol under test where their behavior is claimed.

Move every eligible assertion from the current settings, shortcut and player fixtures into that background path. Keep a small, explicit desktop suite for actual OS behavior and real recording. Automate those desktop cases through the existing project runners wherever possible; automation alone does not make them safe to share with an actively used desktop. Subjective listening, first-time permission approval, Touch ID/password steps and physical hardware changes retain their human prerequisites.

The technical basis is Playwright's [Electron API](https://playwright.dev/docs/api/class-electron) and Electron's [offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering). Electron support in Playwright is experimental; an offscreen window is frameless. This plan therefore does not claim native window-frame coverage or universal execution without a graphical session. A separate hidden Electron fixture is also different from a headless Chromium browser. Locked-session and CI compatibility must be measured, not assumed. If a needed behavior cannot run without showing/focusing a window, keep its OS-dependent part in the desktop suite and retain the other assertions in the background suite.

This planning change adds only this plan, its translation and the index entries. It does not implement the migration, change the testing policy, launch an app, or waive existing acceptance requirements. The working tree already contains a broad React/shadcn and Playwright change; preserve that work and record its exact identity before implementation rather than assuming HEAD describes the baseline.

## Inspected starting point

The inventory below describes the working tree inspected on 2026-10-06, not a claim that its tests have passed in this task.

| Existing entry / implementation | Current evidence and desktop dependency | Destination |
| --- | --- | --- |
| `pnpm check`; colocated Vitest and integration tests | Types, logic and build; no desktop acceptance | Keep. Playwright does not replace fast unit tests or the production build |
| `pnpm test:ui`; `tests/ui/components.spec.ts`, `tests/ui/fixture.cjs`, `playwright.config.ts` | Existing hidden/offscreen Electron with real settings preload/page and synthetic views/handlers; one worker; component input, geometry and DOM focus | Extend into reusable Playwright fixtures. Its simplified handlers alone cannot replace main-process integration evidence |
| `pnpm acceptance:settings`; `scripts/fixtures/settings-panel.ts` | Built renderer/CSP/preload/IPC, real `RecordingsLibrary` and `recordstuff-media:`; most handlers are fixture-owned. `activate()` shows/focuses the window; plan 057 classifies interrupted activation as blocked | Port rendering, interactions and protocol/file assertions. Extract genuine activation cases into an explicitly selected desktop fixture |
| `pnpm acceptance:shortcut`; `scripts/acceptance-shortcut.mts`, `scripts/fixtures/shortcut-failure.ts` | Production main/actions/SettingsWindow/persistence; normal/restart phases use real globalShortcut registration. The settings phase controls registration but still shows, minimizes and focuses windows, and tests crashes and held saves | Port deterministic ownership/save/restart/crash assertions using controlled OS adapters. Retain real registration and actual window activation/minimize/restore evidence in desktop runners |
| `pnpm acceptance:player`; `scripts/fixtures/player-panel.ts` | FFmpeg's decodable clip through the real library/protocol; page input, real playback and production full-screen window covering the display | Port controls, decode/progress and time/title handoff to muted hidden windows. Retain actual full-screen entry/exit, window placement and native controls on the desktop |
| `pnpm preview:ui`; `scripts/fixtures/ui-preview.ts` | Already renders a gallery offscreen in both languages/themes/sizes. It judges nothing and can omit playback pictures when FFmpeg is absent | Reuse scenario/data preparation; add required visual assertions to Playwright. Preserve gallery utility; an optional preview omission must not pass a required playback case |
| `pnpm acceptance:lifecycle` | Production Recorder/FileWriter/quit/history with synthetic bytes and scripted prompts, isolated processes; no screen-capture proof | Keep independent unless there is a concrete overlap. Audit hidden-window/OS boundaries before labelling it desktop-free; no rewrite merely to use Playwright |
| `pnpm acceptance:shortcut-layout`, `pnpm acceptance:settings-shortcut -- --observe`, `pnpm acceptance:tray` | OS registration/key delivery, native entry/menu/frame/focus and real status-item input | Keep as desktop checks; move only deterministic model/controller assertions, not OS proof |
| `pnpm acceptance:notification`, `pnpm acceptance:quit-dialog`, `pnpm acceptance:playback` | Signed notification delivery/banner/Finder and actual playback observation | Keep native evidence. Test notification policy and requested actions in background adapters too |
| `pnpm acceptance`, `pnpm matrix`, `pnpm audio:quality`, CPU/finalization/cadence tools | Actual capture, media output, audio route or production performance; may use visible material/global input | Keep impact-selected desktop/recording rounds. Synthetic media or Playwright videos cannot replace these |
| `pnpm acceptance:updates`, `pnpm acceptance:controlled` | Some logic/synthetic-state paths; other modes launch signed apps, use tray/shortcuts or capture | Classify each mode and its callers. Existing `--logic-only`/selftest labels do not automatically qualify the entire runner as desktop-free |
| `.github/workflows/check.yml` | macOS and Windows currently run check + test:ui; Windows also packages and exercises installation | Expand background coverage on both CI platforms. Installer gates and existing release policy remain in place |

## Evidence and architecture contracts

Use three test scopes with explicit names in commands and reports:

| Scope | Execution | What its pass establishes |
| --- | --- | --- |
| Logic | Vitest/Node; controlled inputs and filesystem | State transitions, ownership, validation, failure recovery and byte/file assertions actually tested |
| Background UI / integration | Playwright controlling hidden offscreen Electron, production `out/` pages and preloads; no OS interaction | Browser input, DOM focus, rendering, actual IPC and the selected production main/file/media paths |
| Desktop / capture | Fresh signed bundle or the appropriate native fixture and committed runner, one desktop executor | Actual OS input, frame/focus/notification behavior and tested recording/playback cases, with screenshots/listening reported separately |

Background implementation constraints:

1. Extract Playwright `test.extend` fixtures with per-test temporary userData/output/media directories and a supervised Electron process tree. Use the installed Electron, scrub inherited runner/signing environment, and retain the current one-worker policy until isolation is established. Tests load production artifacts after one build; no dev server, fake HTML, weakened CSP, `nodeIntegration` or replacement preload.
2. Provide two hosts: a lightweight view/component host and a production-main integration host. Reuse `settingsView`, `RecordingsLibrary`, production settings actions/storage and window controllers where the case claims those paths. Replace only environmental boundaries: OS shortcut registration, Tray, native notifications/dialogs, external opens and actual display capture. Expose test-only controls for seeds, delayed/rejected operations, process restart and recorded adapter calls. Build these hosts with the existing fixture tooling; do not ship test IPC or fixture entry points.
3. Construct all settings/video/countdown windows hidden with offscreen rendering, mute audio, disable background throttling for the test and hide Dock presence where supported. Use a narrow, test-only window/OS boundary to prevent production show/focus/full-screen calls from reaching the desktop. Record such requested calls as adapter evidence; do not label them as actual activation/full-screen evidence. Avoid a broad Electron mock that substitutes the IPC or storage behavior under test.
4. Guard the fixture boundary: fail if any owned window becomes visible, an OS focus/show/full-screen operation escapes, a real globalShortcut/Tray/notification/external-open/capture boundary is invoked, or audio is unmuted. Include windows created after launch. Inspect callers as well as initial BrowserWindow options. A forbidden operation must produce diagnostic evidence and cleanup, not be silently ignored. These guards establish fixture containment, not a claim to detect every human desktop action.
5. Drive tested interactions through Playwright locators, mouse and keyboard. Prefer roles/names, with stable IDs for structural/race cases. Keep `evaluate` for setup/observation, precise fault injection and controlled clock/state work; do not replace a required click/key with a direct production-handler call. Distinguish DOM focus from OS activation. Keep the existing native case when a browser event cannot reproduce its trigger.
6. Await specific state/events and use auto-retrying assertions instead of broad sleeps. Retain real-time intervals when elapsed time is itself being verified. Renderer clock control cannot stand in for main timers, media time or native lifecycle timing; held-save and race gates need explicit start/release/settled signals.
7. Teardown handles pass, assertion failure, launch failure, renderer crash, timeout and SIGINT/SIGTERM. Close owned windows/app normally; use bounded process-tree cleanup for a hung fixture and report forced termination. Verify no owned main/helpers remain before removing temporary state. Retain diagnostics when cleanup cannot be confirmed and fail the round. Never quit unrelated apps as part of background tests.

## Coverage ledger and migration map

Before porting, create a case ledger in the migration evidence. Enumerate every old runner assertion, including loop-expanded language/theme/size/state/delay combinations, and give each a stable ID. Record its behavior, old source/assertion, fixture boundaries, new spec/test ID, evidence kind, required native counterpart and final disposition. Use behavior identity rather than total test count: one old case can map to several new assertions, and a duplicate can be consolidated only with its complete contract preserved. An intentionally removed assertion needs a concrete obsolete-behavior reason; inability to port is not one.

| Behavior group | Required background coverage | Remaining OS evidence |
| --- | --- | --- |
| Settings load/view/persistence | Production bundles/CSP, sandbox API, IPC read/ready/change/choose, committed views, async stale completion, errors, restart persistence, light/dark/system and languages | macOS-drawn frame/traffic lights; actual startup/focus behavior |
| Layout/accessibility | All tabs, default/narrow/minimum sizes, long copy/scrolling, disabled/busy controls, labels/roles, tab order, DOM focus returns, tooltip/menu placement and escape/hover | VoiceOver and subjective readability when required; actual activation loss |
| Library/files | Real isolated files, durations/sizes/dates, custom protocol and ranges, thumbnails/fallback, empty/failing folders, rename validation and file changes, delayed trash/undo semantics | OS Trash/Finder/external-player effect where tested; keep file-operation evidence separate from adapter calls |
| Recording results | Acknowledgement/removal, independent expansion, stale mouse press versus new result, delayed saves, pending/unsaved/final results, retention and focus routing | Native re-entry/focus across apps; notifications and true recording failures where required |
| Shortcut editor/ownership | Candidate capture/preview/confirm/cancel/timeout, reserved keys/legacy collisions, registration failure/retry via adapter, no unintended persistence, held saves across close/reopen/crash, restart and registration restoration | Real registration success/failure, keyboard layouts, OS global key delivery and application-menu accelerators |
| Settings lifecycle | Repeated creation/close/reopen, no duplicates, geometry persistence, crash disposal/replacement, committed key restoration, no recorder start from entry requests | Actual visible/minimized/focused state and tray/shortcut delivery. Preserve native keyboard-close behavior |
| Player/media | Controls and accessible values, drag/keys, mute/volume, resting/waking overlays, focus on close, real decodable media/loaded metadata/time progression/seek/errors, title/time handoff between hidden settings/video pages | Actual full-screen transition/placement/Escape, native controls, visible playback and subjective sound |
| Countdown | Renderer ready/state updates, digits/progress, cancellation and completion presentation in a hidden host, sound preference requests behind a silent adapter | Real shortcut/countdown capture exclusion and audio-route behavior |
| Notifications/permissions/quit/update states | Copy/view/action requests, policy, blocked states, queued work and failure transitions using appropriate production logic | TCC/System Settings, signing/delivery/banner text/Finder, native quit interactions and real update/capture lifecycle |

For media tests, choose a deterministic short decodable clip (generated once per run with FFmpeg, or a small checked-in clip with documented origin). Decide at phase 1 and provision the prerequisite on both CI platforms. Missing required media is blocked, never an optional skip. Keep simple synthetic video-property tests as controls tests; add separate real decode/progression assertions. Force silence while allowing decoding. Exported samples/analyzer tests remain on their existing tools.

## Ordered implementation

Each phase ends with its deliverable and checks before the next starts. The listed filenames are proposed where they do not exist yet; final names may follow project conventions without changing the behavior contract.

### Phase 0 — Freeze the baseline and scope

- Record source/dependency/configuration/environment digests including the uncommitted and untracked React/Playwright work, runner versions, old command graph and available artifacts. Do not reset or duplicate that migration.
- Produce the complete case ledger, split mixed UI/OS assertions and document duplicates. Inspect the current test-selection rows and acceptance cases for every scope this plan affects.
- Record timing for the existing commands only where comparable evidence is available under the testing policy's reuse rules. An old desktop round requires the readiness handoff; it is not needed merely to count assertions. Do not record a baseline video just to measure test speed.
- Define the task-local validation recipe: check/build once, new background cases, affected runner/cleanup drills, final native evidence, CPU/recording cases only if implementation changes their production dependencies. No expensive check is dropped merely because it is inconvenient.

Exit: every existing behavior has an identified destination; known gaps and reused evidence are explicit. No desktop runner is deleted.

### Phase 1 — Prove the background host

- Extract the current `tests/ui/fixture.cjs` setup into reusable fixtures; add typed seeds, adapter call logs, artifact identity, containment guards and process supervision. Suggested files: `tests/ui/fixtures.ts`, fixture host modules and focused specs; adjust `playwright.config.ts` as needed.
- First run representative click, key, drag, DOM focus, production IPC, hidden window replacement, screenshots and real muted media. Validate on macOS locally and on macOS/Windows CI. Do not assume `_electron.launch` respects browser-only `headless` settings.
- Prove that the host does not display/focus windows or move the system pointer; use boundary instrumentation plus an observed representative containment check. A check that observes shared desktop state follows the readiness handoff. After containment is established, ordinary background executions require no desktop handoff. Test behavior when another app is frontmost; do not improvise input into the maintainer's apps.
- Exercise launch failure, assertion failure, timeout, renderer crash and interruption cleanup; prove successful cleanup remains normal and incomplete cleanup cannot pass. Observe actual child/helper exit, not just `application.close()` resolving.
- Decide and record whether the installed Electron works while the session is locked or lacks a display. Do not lock the maintainer's session automatically or claim these environments pass from hidden-window results. If unavailable to test, retain a specific unverified environment; if unsupported, fail with the prerequisite and offer a separately scoped headless renderer host only when useful. Browser-only evidence never replaces Electron/preload/IPC evidence.

Exit: background-host feasibility is demonstrated for supported environments; OS-dependent cases and platform limitations are listed. If a capability fails, keep its desktop counterpart and port the eligible subset.

### Phase 2 — Settings and library

- Port `settings-panel.ts` by ledger group into Playwright settings/layout/library/results specs. Keep its real files/library/media protocol and race assertions; reuse data helpers from `ui-preview.ts` where appropriate. Run actual storage/action handlers for assertions claiming persistence.
- Move activation/blur/foreground-window cases to an explicit desktop fixture with plan 057's blocked classification intact. Keep DOM focus tests in background specs. Offscreen screenshots cannot assert native window controls; retain native frame observation and page-corner exclusion as separate checks.
- Migrate both languages, themes, dimensions and dynamic states; do not reduce the old matrix to a single English happy path. Update the `acceptance:settings` wrapper only after case parity passes, preserving its report/output contract or documenting a supported replacement.

Exit: every settings/library assertion has passing equivalent evidence or a retained native case; the settings background runner never needs `beginDesktopRound`.

### Phase 3 — Main integration and shortcuts

- Separate shortcut-failure's deterministic normal/restart/settings behavior from real registration and activation. The background integration host uses production main/settings handlers/persistence with controlled OS registration; preserve the real registration failure/recovery assertion in an explicit desktop case.
- Port held-save races, timeout, close/reopen/crash/restart, notification requests and repeated-entry contracts. No real global key is registered by this host; recorded ownership proves adapter integration only. Tray callbacks prove requested routing only.
- Retain actual minimize/restore/focus, native keyboard-close/menu routing and OS registration/delivery in existing runners or a narrowly extracted native fixture. Keep direct runner leaf commands for recipes so the combination builds identical inputs once.

Exit: deterministic shortcut integration is background-only, native coverage is preserved, and both normal and intentional failure/timeout cleanup drills have evidence.

### Phase 4 — Player and countdown

- Port player controls and real muted decoding to Playwright. Use the production library/protocol and production video preload/page; exercise time/title transfer and return acknowledgements in hidden windows. If `VideoFullScreen` needs an OS seam, isolate only window activation/full-screen operations and inspect all callers.
- Keep actual OS full-screen/Escape/focus/placement/window controls in the desktop player runner with a short generated clip; shrinking this runner must not remove its native assertions. Keep actual saved-recording playback evidence distinct from generated-media decoding.
- Add a hidden countdown host with the built countdown preload/page. Keep audio creation silent behind an adapter and recording exclusion in real smoke tests. Preserve applicable unit tests rather than converting all timers/state logic to UI tests.

Exit: routine player/countdown changes can be exercised without visible windows or sound; real full-screen and capture cases retain native runners.

### Phase 5 — Visual checks, commands, CI and policy

- Turn selected gallery scenarios into geometry assertions and reviewed screenshot baselines: both languages, themes, sizes and relevant states. Freeze seed data/date/font/scale/animation state for these screenshots; avoid hiding transient UI being tested. Keep baselines scoped by platform/runtime and inspect updates; never auto-accept a failing image. Geometry covers contracts that must hold across rendering drift. Follow Playwright's [visual comparison guidance](https://playwright.dev/docs/test-snapshots).
- Configure trace, page screenshots, console/page errors, adapter events, process logs and a machine-readable report for manually launched Electron pages. Prove an intentional failure produces inspectable evidence; config defaults alone do not prove trace collection for a manually launched context. Playwright videos are UI diagnostics, not RecordStuff capture evidence.
- Switch `acceptance:regression` only after phases 1–4 satisfy parity: one `pnpm check` build plus all background suites, no desktop leaf. Keep `test:ui` as a no-build leaf for CI/recipes. Make `acceptance:settings`/`acceptance:shortcut` clearly background-scoped, or retain compatibility wrappers with explicit scope reporting. Keep `acceptance:player` explicitly desktop-scoped while its ordinary UI cases join `test:ui`.
- Add a discoverable native recipe for the small OS subset, using existing runners and one fresh signed artifact where required. Proposed new recipe name: `native-ui`; it does not exist today. Its report declares desktop use before execution; agents still obtain “好了” before running it. A broad native recipe is an available combination, not a requirement to rerun every OS case after each edit.
- Update recipes/timing tests and cleanup paths in `scripts/lib/runner/verification-timing.mts` and `scripts/acceptance-recipe.mts`. Keep stopped/blocked/failed/invalid distinctions and source/artifact identity. Do not map all nonzero Playwright exits to blocked; a missing prerequisite and a failed assertion differ. Verify existing script flags such as `--out` and cleanup drills against their callers before deprecation.
- Extend macOS/Windows `check.yml` background checks and retain traces/reports/screenshots/logs on failure. Provision chosen media tooling, preserve pinned actions and Windows installer gates, and run CI once on the final code revision without publishing. GitHub cannot test an unpushed local diff: if getting that revision onto a remote requires a commit/push, obtain a separate user request for those actions; until then record final-revision CI as required but not run, not a historical pass. Do not claim Windows native capture/tray acceptance from a passing UI job.
- Update English/Traditional Chinese CONTRIBUTING, testing, acceptance, tooling/repository/desktop documentation as affected, and the native acceptance skill. Rewrite selection rows by behavior: renderer/IPC/storage use background regression; OS focus/frame/menu/full-screen/notification/input use explicit native checks; capture/quality/audio/performance keep applicable recording rows. Only change the policy after replacement evidence and native counterparts exist; preserve handoff, lock, cleanup and evidence-kind rules.

Exit: the default routine command contains no desktop dependency, commands and reports expose their scopes, CI passes on both supported runner platforms, and the testing policy requires the correct native checks for each changed OS boundary.

### Phase 6 — Final parity, measurement and closure

- Reconcile every ledger ID with final passing evidence, an explicit retained desktop case or an agreed obsolete assertion. Missing/blocked required evidence prevents claiming the whole migration is complete. Retain the old runner until its replacement and all residual native cases are validated, then remove duplicate fixture/input helpers.
- Run one final covering recipe on unchanged inputs; collect containment, case coverage, cleanup and timing evidence. Compare total time and actual desktop-held time with phase 0 evidence, separating user-readiness waits and unknown intervals. Target zero desktop-held time for routine regression; do not invent a speedup percentage or require a full old/new duplicate matrix after unaffected evidence is already valid.
- Perform one exclusive native round for the affected extracted window/shortcut/player operations, after the readiness reply. Use the [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md), committed runners and observed screenshots. Start background `caffeinate -d -i -t 5400` before the first implementation edit when this task will include desktop rounds; stop it after final cleanup and report its use. Restore settings, close test UI, quit tested apps normally and confirm their processes exited.
- Apply additional recording/CPU/build checks only when the final implementation affects those dependencies under the shared policy. Changing production window controllers or live renderer lifetimes must be reclassified; adding a test-only host does not automatically require capture. Report actual screen/system-audio behaviors tested and any remaining gaps separately.
- Write durable architecture/tooling conclusions and bilingual verification closure, update indexes and remove the finished plan/translations as [the completion rule](README.md#completing-a-plan) requires. Do not commit, push, create a PR, tag or publish without a separate user request.

Exit: all required checks and cleanup have evidence, residual native/human/platform limits remain explicit, and the plan can be closed without reducing claimed coverage.

## Command contract after migration

These are target contracts, not instructions to execute now. Existing commands keep their current requirements until their migration phase passes and policy/documentation are updated.

| Command | Target desktop use | Coverage / build rule |
| --- | --- | --- |
| `pnpm check` | None | Existing types, Vitest and one production build |
| `pnpm test:ui` | None in validated environments | All migrated background UI/integration/media/selected visual cases, production `out/` required; no extra build |
| `pnpm acceptance:regression` | None in validated environments | Check/build once + the complete background suite; stop and report failures |
| `pnpm acceptance:recipe -- settings` | None in validated environments | Same background regression with identity/timing evidence |
| `pnpm acceptance:settings`, `pnpm acceptance:shortcut` | Background scope after migration | Compatibility/filter commands with native evidence explicitly excluded; avoid a second build inside composite recipes |
| Proposed `pnpm acceptance:recipe -- native-ui` | Exclusive desktop | Applicable native entry/frame/focus/registration/player cases; recipe declares prerequisites and uses signed bundles where needed |
| Existing tray/settings-shortcut/shortcut-layout/player/notification/quit-dialog/playback commands | Exclusive desktop where their selected operations require it | Preserve their actual OS evidence; select by affected behavior |
| Existing recording/matrix/audio/performance commands | As required by their real capture/material path | Preserve hardware/media/performance proof and evidence reuse rules |
| `pnpm preview:ui` | Existing background gallery | Optional preview remains a convenience; required visual/media assertions live in the suite |

## Validation recipe and acceptance criteria

Implementation must write its final task-local recipe before running checks, refining this baseline according to the actual diff:

| Impact | Required final evidence | Conditional exclusions |
| --- | --- | --- |
| Test hosts/specs/wrappers/recipe changes | `pnpm typecheck`; focused runner tests; one production build before UI tests; new background suite; failure/timeout/crash/interruption cleanup and required reports | When `pnpm acceptance:regression` covers typecheck/build/suite, do not run those again separately |
| Any application/preload/window-controller change | `pnpm check` via final regression plus changed interactions; the relevant native window/full-screen/shortcut case | Recording only if production capture, recording coordination or affected OS action can start/stop/interfere with capture |
| Live timers/renderers/window lifecycle changes | Shared CPU policy on fresh `pnpm start:app` artifact, when that impact row applies | Test-only fixture polling does not impose a production CPU baseline |
| CI/runtime/build changes | Final macOS/Windows jobs and affected packaging checks; artifact/debug evidence | No release/tag/publication; Electron version remains unchanged unless a separately assessed need emerges |
| Documentation/skill updates | Affected relative links/anchors, actual script/flag names, translations, skill metadata where changed; `git diff --check` | No app launch or recording solely for documentation |

Acceptance requires all of the following:

- Routine regression is automatic and contains no OS desktop effects, with containment evidence for all created windows and adapters; the maintainer can keep working during it.
- Every old eligible assertion has equivalent coverage; every remaining OS assertion has an executable native counterpart or a clearly recorded required-but-unverified case. Zero hidden removals or blanket skips.
- Actual Electron CSP/preload/IPC/storage/media evidence is preserved; adapter calls, synthetic media, actual decoding, native observation and real capture are reported as different evidence.
- Reports diagnose missing prerequisites, failures, blocked native rounds, interruption, stale inputs and incomplete cleanup. Success cannot depend on deleting logs or leaving helpers running.
- Final macOS and Windows background evidence is available; hardware/native Windows gaps remain explicit. Locked/no-display execution is labelled only as actually verified or specifically limited.
- The policy, command graph, recipes and both language versions agree; routine execution does not accidentally call a residual desktop fixture.

## Risks and fallback decisions

| Risk | Response |
| --- | --- |
| Hidden input/DOM focus differs from an active window | Prove representative interactions in phase 1; keep actual activation tests native. Do not fake document focus to pass an OS contract |
| Main startup recreates visible windows, shortcuts or tray | Use a narrow test-only boundary with hard containment guards; audit creation and route callers; retain production-main behavior where claimed |
| Tests pass against simplified IPC handlers while production breaks | Separate component and production integration hosts and label each ledger entry's boundary; run actual storage/actions for persistence/race tests |
| Offscreen screenshots omit native controls or differ by OS/font/GPU | Keep native frame evidence, stable geometry assertions and reviewed platform baselines; do not change production rendering just to match snapshots |
| Playback is mocked, muted incorrectly or media tooling is missing | Include decodable-media progress/seek checks, verify muting, provision prerequisites and report blocked when required media cannot be made |
| Offscreen Electron still needs a GUI session / locks stop rendering | Measure supported environments; record restrictions. Use dedicated CI/session for incompatible environments; do not silently broaden browser-only evidence |
| Crashes/timeouts leave helpers, timers or state | Supervise owned process trees, validate drills, retain diagnostics and fail incomplete cleanup; do not use global process kills |
| Transition duplicates builds/tests or removes native proof | Use the case ledger and one-build recipes; retire old eligible cases only after parity, and preserve residual native assertions |

No separate-machine/VM setup is part of this implementation. A dedicated macOS test machine/session could move native rounds away from the maintainer's desktop, but needs its own signing, TCC, notification, display/audio and hardware validation. It is a follow-up option, not a Playwright capability or a prerequisite for this background migration.

## Planning-only verification

For this turn: inspect links/anchors, current commands and matching language structure, then run `git diff --check` on the four plan/index files. No source edits, builds, tests, desktop handoff, app launch, capture or caffeinate are needed for a documentation-only plan. Execution evidence will be created during implementation; the inventory and official references above are design inputs, not pass results.
