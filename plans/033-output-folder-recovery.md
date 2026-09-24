# 033 — Open output folders with visible failure recovery

[English](033-output-folder-recovery.md) | [繁體中文](033-output-folder-recovery.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-24. Execution order: see [queue](README.md#order-and-status).

## Scope, evidence and separation

R2-08 (P3). The enabled openOutputDir action in [main](../src/main/index.ts) calls shell.openPath and only logs its error. A fresh SettingsStore points to Movies/RecordStuff, which is created on recording start rather than settings initialization. The real store/tray/action path with a missing-path shell boundary reproduced an enabled action, no directory and no visible feedback. Finder behavior itself was not tested.

Separate from FileWriter plans: this is an explicit folder-opening action and user recovery, not recording publication. Scope includes the tray action, filesystem/shell boundary, bilingual feedback and focused tests. No new Cap comparison is claimed.

## Implementation contract

- [ ] Existing directories open normally. For a missing known default folder, validate its parent and create only the intended directory before opening, or show a clear actionable creation failure. Do not change persisted output settings merely by opening a folder.
- [ ] Missing custom folders, including disconnected external volumes, must show localized failure and a route to choose/restore the folder; never blindly recreate the configured path and accidentally write onto the system disk. Reuse the existing choose-folder flow and recording locks; cancellation preserves settings.
- [ ] Surface shell.openPath errors and rejected promises to the user with useful path/context, while retaining diagnostics. Prefer existing visible error UI rather than introducing saved-notification behavior. Bound/reuse in-flight repeated clicks and avoid duplicate dialogs or unhandled errors.
- [ ] Cover fresh default before first recording, existing directory, missing default parent, deleted custom folder, disconnected-volume path, permission denial, path that is a file, shell failure and repeated clicks. Assert no unintended directory creation or settings mutation and successful retry after recovery.
- [ ] Update bilingual desktop/usage guidance and messages; preserve recording's own output-directory validation.

## Required verification and exclusions

Run `pnpm check` and exercise the tray action on a fresh `pnpm start:app` bundle: isolated fresh default, existing folder and missing custom folder; observe Finder/error UI in both languages and retry/cancel. Use isolated test paths rather than deleting user folders. If settings UI/IPC changes, add `pnpm acceptance:regression`; if choosing a folder or recording validation changes, add the recording smoke case for the new output path. For a confined open-only action fix, recording, media matrices, hardware removal, notifications and publication are outside scope. A mocked shell cannot replace native Finder observation.

## Completion and evidence handling

Follow [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Use the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) for any required native UI round. Serialize shared builds; one desktop/audio/shortcut owner per round. Restore changed settings, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan.
