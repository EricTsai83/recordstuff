# 026 — Reject empty recording publication

[English](026-reject-empty-recordings.md) | [繁體中文](026-reject-empty-recordings.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-24. Execution order: see [queue](README.md#order-and-status).

## Scope and evidence

Bug **9**. Execute after 025 and 024. A real Recorder/FileWriter test sends started then requested stopped without media chunks: a zero-byte final MP4 and saved event result. The renderer drops empty blobs. Native MediaRecorder zero-output timing has not been reproduced; do not claim all quick stops fail.

Change [Recorder](../src/main/recorder.ts), [FileWriter](../src/main/file-writer.ts), their tests, and renderer/error presentation only as needed. No arbitrary minimum recording duration, MP4 parser, ffprobe runtime dependency or full decodability guarantee.

## Cap assessment

Cap's AVFoundation writer [rejects finish without a last frame using NoFrames](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/enc-avfoundation/src/mp4.rs#L961-L990). This directly supports rejecting empty output, but RecordStuff receives encoded chunks rather than frame timestamps. Nonzero bytes are a minimum necessary guard, not proof that there is a decodable video frame. Do not describe our byte check as equivalent media validation.

## Implementation and tests

- [ ] Define success as nonempty accepted media with all writes completed. Use actual FileWriter byte accounting from 024; do not trust requested chunk lengths or increment for empty chunks. Check before publication inside FileWriter as defense in depth, and route no-media capture through the recorder's single terminal failure path from 025.
- [ ] Report no media through the existing `capture_start_failed` code with a distinct detail, matching the first-chunk deadline that already uses it, with clear bilingual feedback. Add a new code only if the user-visible text cannot otherwise be honest, and then update the shared validator, translations and every consumer together. Never emit saved or set lastSavedPath for zero output. Real write errors retain their original code.
- [ ] Release handles and sync timers and remove a genuinely empty temporary file; preserve nonempty partials on failures. A successful immediate retry must work. Do not reject a very short but nonempty valid recording solely for duration.
- [ ] Cover started→stop→stopped with no chunks, only empty chunks, nonempty final chunk arriving immediately before stopped, a pending first append, write failure, repeated stopped, and retry. Assert on real temporary-file size/contents and emitted events. Confirm a zero-write outcome cannot bypass the writer guard.
- [ ] Update bilingual recording design with the difference between nonempty and playable.

Required: `pnpm check`; fresh `pnpm start:app` smoke with media verification/playback, plus shortest practical immediate-stop interaction. Inspect its actual outcome without requiring native capture to generate an empty blob. Controlled no-media tests remain a separate evidence layer. Add settings/notification acceptance only if their behaviors change under the shared policy. Exclude full matrices, long runs, permissions and display removal because this change only rejects zero output.

## Completion and evidence handling

Follow [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Use the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) for any required native UI round. Serialize shared builds; one desktop/audio/shortcut owner per round. Restore changed settings, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan. Cap assessment is static source review at revision `ce785e705e79652adba4b8bf752669c4093499e0`, not execution or an assurance about every Cap mode/platform.
