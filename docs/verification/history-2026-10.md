# Verification History — October 2026

[English](history-2026-10.md) | [繁體中文](../zh-TW/verification/history-2026-10.md)

[Back to the verification index](README.md). These are historical results; use the [testing guide](../testing.md) for current policy. Raw measurements links are local only and absent from a fresh clone.

## Plan 061 closure — 2026-10-02

Plan 061 measured the acceptance work after `pnpm check` and removed the repeated work it found. Claude implemented it, with Codex GPT-6.1 Sol review. Only developer tooling and documentation changed; the app did not. The durable rules are in [select once, validate once](../testing.md#select-once-validate-once) and [verification recipes and timing](../system-design/tooling.md#verification-recipes-and-timing).

- **Timing.** [verification-timing.mts](../../scripts/lib/verification-timing.mts) runs each leaf command in its own process group. For each phase it records a monotonic duration, the outcome, the exit code and the cleanup. `pnpm start:app` reports its own preflight, build, package, verify and open phases through `RECORDSTUFF_TIMING_FILE`; these appear inside their phase and are not counted a second time. Each report also records the revision, a digest of uncommitted content, runtime-input, `out/` and `app.asar` digests, and tool versions. Agent orchestration gaps and desktop-readiness waits are recorded as unknown.
- **Recipes.** `pnpm acceptance:recipe -- <check|settings|shortcut-registration|recording>` runs the same leaf checks as the composites it replaces, with one build of identical inputs. A unit test keeps each recipe equal to the package scripts it replaces.
- **Bundle reuse.** `pnpm start:app` records the bundle's runtime inputs beside it. `pnpm open:app` refuses a bundle whose inputs changed, so a round after a test-, script- or documentation-only edit can reopen the verified bundle instead of rebuilding it.
- **Runner fix found by measurement.** The first recipe run started `pnpm acceptance` 0 s after `open` returned. The runner then judged the previous app's log session (run `…-49210`) for the new pid 71654 and stopped with "the app restarted" after sending the start key. Only a round started straight after `start:app` could hit this. The runner now waits up to 30 s for the latest session's run id to end with the running pid and for that session to be idle. A unit test covers `sessionBelongsTo`.
- **Instruction audit.** AGENTS.md and the testing policy already forbade running a composite's `check` twice, and the implementation skills already reran only affected checks; no skill required an unconditional full rerun. The policy now states the task-local recipe and the evidence-invalidation rules. AGENTS.md references them, and the acceptance skill allows `pnpm open:app` after an edit that cannot reach the bundle.

### Post-check cost breakdown

M1 Pro, macOS 26.6.2, Node 24.21.0, pnpm 10.33.4, Electron 44.3.0, from `e1949be` plus the uncommitted change. One run per path; these are single observations, not budgets.

| Path | Phase | Wall time |
| --- | --- | --- |
| Logic only (`check` reference) | typecheck / tests / build | 0.71–0.84 s / 18.70–21.01 s / 0.77–0.89 s; four runs passed at 20.36–22.64 s wall |
| Settings change (post-check) | settings fixture, 176/176 | 55.29 s |
| | shortcut integration, three phases | 37.89 s |
| Registration or Electron change | keyboard layout (Zhuyin), restored to ABC | 6.17 s |
| Build/package/sign | `pnpm start:app`: preflight / build / package / verify / open | 0.07 / 0.77 / 36.34 / 0.30 / 0.15 s (37.70 s phase); the earlier run took 40.58 s with a 39.12 s package phase |
| | `pnpm open:app` on the same bundle: preflight / freshness / verify / open | 0.07 / 0.01 / 0.30 / 0.07 s (0.66 s wall) |
| Recording | `pnpm acceptance`, 10 s take plus cancel case | 29.70 s |
| Playback | `pnpm acceptance:playback` on the same file | 14.33 s |
| Native entry (`acceptance:settings-shortcut` plus Computer Use) | — | Not measured; built from start:app (~38 s), a callback bounded at 30 s and observation time that stays unknown |
| Agent repetition | — | Unknown; no session-log intervals were available |

Ranking of the measured post-check costs: Settings regression fixtures 93.18 s; bundle build/sign 37.7–40.6 s, nearly all electron-builder packaging; the recording round 29.70 s; playback 14.33 s; the keyboard-layout check 6.17 s.

### Before and after, with equivalent coverage

- **Rebuild of a verified bundle** (confirmed over-broad path). Before this plan, `pnpm open:app` could not tell a stale bundle from a fresh one, so the only safe way to run another native round after any edit was to rebuild. A later round after an edit that cannot reach the bundle now costs 0.66 s instead of 37.7–40.6 s, saving about 37–40 s per round. It reopens the same signed bundle, with its signature verified and its runtime-input record matching. An edit that does reach the bundle still forces the rebuild.
- **Duplicate build** (confirmed). `pnpm acceptance:regression && pnpm acceptance:shortcut-layout` and `pnpm check && pnpm start:app` each built identical inputs twice. The recipes build once. Standalone `pnpm build` took 0.75–0.78 s in three runs and 0.77–0.89 s as a phase, so this saves under 1 s per path. Real, but negligible next to the fixtures.
- **Recording.** One take supplied start/stop/save, media verification, countdown evidence, the cancel case and the playback check; no recording was repeated for timing. The run that failed on the stale session was a real defect, not a repeat, and the rerun after the fix is the evidence.

### Consequence for 058

The largest measured post-check cost is the Settings UI fixture pair: 93 s per Settings change. Both passed every case in this round, so no instability was observed. Neither runner exposes startup, interaction and screenshot boundaries, so the share a driver change could save is unknown. 058 stays conditional. If the maintainer takes it up, its pilot first splits the settings fixture's 55 s into startup, interactions and screenshot matrix, and compares a Playwright pilot against that breakdown. Otherwise 058–060 are deferred and the existing driver stays.

### Verification

- **Automated.** `pnpm acceptance:recipe -- check` passed four times: 96 files with 1390, 1390, 1396 and then 1397 tests as review fixes added tests. Focused tests cover the timing library, recipes, runtime inputs, `start-app` and `sessionBelongsTo`; `git diff --check` passed. The first run exposed that `start-app.test.ts` passed the recipe's timing file to the start-app processes it spawns, so test runs were reported as nested phases; the test now gives each run its own file and asserts what was written.
- **Controlled interruption.** SIGINT during the test phase exited 130, with the phase interrupted, build not run and no vitest left. Unit tests with controlled processes cover pass, failure, blocked exit 2, a timeout, an interrupt cleaned up by the child, forced cleanup after exit 0, and app cleanup.
- **Desktop round.** The maintainer replied “好了” before the round. `shortcut-registration` passed in 122.10 s: settings 176/176, shortcut integration PASS, keyboard layout PASS with the input source restored. `recording` first failed on the stale session above and, after the fix, passed in 87.07 s with a 10.2 s 1920×1080 recording at 59.94 fps, 10 flashes and 10 beeps, integrity pass and the cancel case pass. The app quit itself, so the recipe's app cleanup was not needed. Playback passed duration, dimensions, real-time playback, seeks, picture change and play to the end. `pnpm open:app` reopened the bundle; it was quit normally and every bundle process exited.
- **Not run.** A recipe interrupted during a real desktop runner, and the recipe's own app cleanup against a running app; these rest on unit tests. Native Settings entry, Computer Use observation, listening and the capture matrix are outside this plan.

Review: Codex GPT-6.1 Sol (medium reasoning, read-only), two passes of 148 s and 82 s. Pass 1 found four issues; all were accepted and fixed:

- Forced cleanup could still pass a phase.
- `recording` could leave an app opened by `start:app` running.
- Instrumented workspaces import `scripts/fixtures`, which the runtime-input digest missed.
- Symlinks were hashed by target path only.

Pass 2 found three more; all were accepted and fixed without a further pass:

- App cleanup ignored helper processes.
- An interrupted phase with incomplete cleanup reported 130/143 instead of failure.
- The initial identity hashing was outside the wall time.

The hotkey runner fix came after both passes and was not reviewed.

Cleanup: no RecordStuff, Electron fixture, material browser profile or QuickTime process remained. The input source was ABC. The recording and reports remain. `caffeinate -d -i -t 5400` ran during the task.
