# 029 — Session-correlated logs and rotation-safe acceptance

[English](029-recording-log-correlation.md) | [繁體中文](029-recording-log-correlation.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-24. Execution order: see [queue](README.md#order-and-status).

## Scope and evidence

Bug **7**. Queue after 028; depend on 025's stable terminal owner. Logs with A=1080p and B=4k, A failing first but B cleanup finishing first, make [pairRecordingsWithLog](../scripts/lib/verify.mts) swap their settings. Recorder permits the next capture while older failure cleanup finishes, so ordering is not an identity.

Affected: Recorder terminal event metadata, [main logging](../src/main/index.ts), [log pairing](../scripts/lib/verify.mts), autorecord/acceptance consumers and their tests. Preserve the producer rotation policy while fixing rotation-aware reading; no cloud telemetry or video format change.

## Round 2 extension: R2-07

Merge R2-07 (P2) with R1-7 because event identity and reliable event delivery must be fixed together for acceptance consumers. [waitForLog](../scripts/lib/acceptance-runtime.mts) searches from an old active-file line count; [acceptance-hotkey](../scripts/acceptance-hotkey.mts) reads only the new active file after rotation. A real FileLogger/rotateLog test placed saved in the new three-line file after a 31-line old file, yet waitForLog timed out. Cleanup's slice(from) has the same invalid cursor boundary; actual native cleanup failure was not demonstrated.

- [ ] Replace raw line-count checkpoints with a rotation-aware cursor/reader shared by waiting and cleanup. Preserve the production rotation/retention policy. Combine file identity/position with session IDs so reading a new file neither skips events nor accepts stale recordings.
- [ ] Follow retained rotated segments across a switch, tolerate transient absence and incomplete trailing lines, and deduplicate replay. If retention has removed the cursor's history, report an explicit evidence gap instead of assuming success or waiting without a useful reason.
- [ ] With real temporary log files, cover rotation during start/stop/save/failure cleanup, multiple rotations, truncation, restart, duplicate events and missing segments. Assert bounded timeout, no extra start/stop toggle during cleanup, and detection of saved in the new file. Exercise production reader and cleanup wiring, not a copied search loop.

Cap's identity reference does not establish rotation-aware text-log consumption.

## Cap assessment

Cap [keys finalization attempts by project identity and assigns an attempt UUID](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/lib.rs#L1010-L1133), rather than identifying ownership through completion order. This is an identity-model reference. No equivalent chronological text-log parser was found in the inspected desktop finalization/diagnostic paths; this is not a claim that Cap has fixed our exact parser bug.

## Implementation and tests

- [ ] Carry the existing sessionId through capture, terminal saved/failed, retained path and start/stop timing. Distinguish preflight refusal (no attempt) explicitly; never borrow a previous session. Preserve consumer compatibility or update all typed callers together.
- [ ] Emit structured, escaped, versioned diagnostic records with sessionId and full path, including failures with no file. Human-readable messages may remain, but new analyzers must not consume both forms as two outcomes. Keep existing autorecord success/failure semantics working.
- [ ] Pair by session identity, not arrival order. Avoid basename-only collision across directories; normalize path identity consistently without requiring a failed/missing file to exist. Handle duplicate terminal lines idempotently and flag conflicting outcomes.
- [ ] Read historical logs conservatively: accept an unambiguous legacy association, otherwise show unknown/ambiguous and suppress dependent quality conclusions. Two unresolved legacy failures cannot be safely assigned merely because one prints first. Do not manufacture a match to preserve a green report.
- [ ] Cover A/B reversed completion and different/no-file outcomes, three interleaved sessions, duplicate lines, same basename in different directories, special characters/spaces in paths, mixed old/new logs, unknown IDs, and failed preflight. Include a real Recorder-driven log integration test, not only hand-authored lines.
- [ ] Update bilingual tooling/log format documentation; preserve historical evidence without rewriting old logs.

Required: `pnpm check`, focused parser/consumer tests and retained-log replay. R2-07 changes runner waiting/cleanup, so run `pnpm acceptance` against a fresh `pnpm start:app` bundle, covering start/stop/save/media verification and observed playback. Force rotation in an isolated runner fixture to exercise failure/cleanup without changing user logs. The former metadata-only native exclusion no longer applies. Exclude settings, media matrices, permissions and publication; distinguish ambiguous metadata from independent media measurements.

## Completion and evidence handling

Follow [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Use the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) for any required native UI round. Serialize shared builds; one desktop/audio/shortcut owner per round. Restore changed settings, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan. Cap assessment is static source review at revision `ce785e705e79652adba4b8bf752669c4093499e0`, not execution or an assurance about every Cap mode/platform.
