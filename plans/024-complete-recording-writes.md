# 024 — Complete recording writes before reporting success

[English](024-complete-recording-writes.md) | [繁體中文](024-complete-recording-writes.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-24. Execution order: next queued development plan.

## Problem and evidence

[FileWriter.append](../src/main/file-writer.ts) ignores the result of `handle.write(bytes)` and counts the entire input as written. A successful call can report fewer bytes than requested. The remaining bytes are then lost, and `finish()` can publish an incomplete file successfully.

During investigation, an isolated macOS Node child process with `RLIMIT_FSIZE=2` requested a six-byte write. The real FileHandle returned two bytes; the current FileWriter counted six and successfully finalized a two-byte file. The limit affected only that child; temporary files were removed. This is a controlled resource-limit reproduction, not a measurement of ordinary recording failure frequency. Earlier injected short-write tests showed the same accounting defect.

Node/libuv already retries many low-level short writes, but callers must still respect the returned count. A failure after some progress can leave a positive short result. Slow storage alone is not sufficient evidence of this condition. See [Node FileHandle.write](https://nodejs.org/api/fs.html#filehandlewritebuffer-offset-length-position) and [libuv write handling](https://github.com/libuv/libuv/blob/v1.x/src/unix/fs.c).

## Design reference: Cap

Use the design principle, not Rust syntax or a new media stack. Reviewed Cap revision: `ce785e705e79652adba4b8bf752669c4093499e0`.

- Cap's [muxer protocol writer](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/cap-muxer-protocol/src/lib.rs#L210-L238) uses `write_all` to complete each payload or propagate an error.
- Its [short-write regression](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/cap-muxer-protocol/src/lib.rs#L561-L609) limits individual writes to seven bytes and checks a 4096-byte payload survives intact. This tests a process transport, not direct MP4 disk writes; the complete-write contract is what transfers to RecordStuff.
- Cap's [macOS media writer](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/enc-avfoundation/src/mp4.rs#L4383-L4475) delegates media output to AVAssetWriter and checks its status. Adopting AVAssetWriter is outside this plan.
- [Rust write_all semantics](https://doc.rust-lang.org/std/io/trait.Write.html#method.write_all) provide the reference: finish the buffer or fail, including failure when no progress can be made.

## Scope and behavior contract

Implement the complete-write guarantee inside FileWriter. Preserve its public `append(): Promise<void>`, serialized queue, five-second sync schedule, existing error codes, and Recorder's saved/failed event contract. Preserve the current final-name collision fix and its tests; it is already in the working tree and is not this plan's implementation.

1. Type `WritableHandle.write` to return at least `{ bytesWritten: number }`, compatible with Node FileHandle. Update injected handles to honor that contract.
2. Within one queued append, repeatedly write only the remaining `Uint8Array.subarray(offset)`. Advance the offset and total byte count by each actual successful result immediately. Do not let a later chunk or sync interleave between pieces of this chunk.
3. Resolve append only when the whole chunk is written. An empty chunk completes without calling write. A nonempty remainder with a zero result fails promptly; invalid counts (negative, non-integer, non-finite, or larger than the remainder) also fail rather than corrupt accounting or loop indefinitely.
4. Propagate thrown I/O errors through the existing first-failure mechanism. Preserve `ENOSPC → disk_full`; zero/invalid progress and other write failures use `output_write_failed`. Do not blindly retry thrown errors or restart an already partially written chunk.
5. A failure after progress retains the actual confirmed byte count. Later appends and finish reject; finish must not publish a final file. Abandon closes the handle, stops syncing and preserves a nonempty `.recording.mp4`; an actually empty file retains current best-effort cleanup behavior. Rejected background queue work must not cause an unhandled rejection during this failure path.
6. Recorder must emit failure with the retained partial path and must not emit saved for this recording. Preserve the ability to start a subsequent recording after failure cleanup.

Successful writes and fsync are distinct guarantees. Keep current flushing behavior; this work does not promise recovery from every crash, power loss, or filesystem failure. Preserving a partial MP4 does not guarantee it is playable.

## Implementation sequence

- [ ] 1. Add failing behavior regressions in [file-writer.test.ts](../src/main/file-writer.test.ts), including real temporary-file contents and byte counts. Record the pre-fix failures.
- [ ] 2. Implement the typed complete-write loop and progress accounting in [file-writer.ts](../src/main/file-writer.ts). Audit injected handle implementations and failure cleanup callers; change lifecycle code only where required by the contract above.
- [ ] 3. Add focused [Recorder tests](../src/main/recorder.test.ts) using the real FileWriter with injected short/error writes to verify failure, partial-path reporting, no saved event, cleanup, and a successful subsequent recording. Do not substitute a mock that only throws without exercising FileWriter.
- [ ] 4. Complete the checks below and update the [English recording design](../docs/system-design/recording.md) and [Traditional Chinese recording design](../docs/zh-TW/system-design/recording.md) with the verified contract and limitations.
- [ ] 5. Preserve durable conclusions in the bilingual verification documentation; update both plan indexes and remove this plan and its translation only when required work is complete, following [plan completion](README.md#completing-a-plan). Retain failed and blocked evidence. Do not commit, push, or publish without a separate request.

## Regression cases

| Case | Required observation |
| --- | --- |
| Full write and empty chunk | Exact contents/count; no write call for empty input |
| Repeated short writes | A 4096-byte payload written at most seven bytes per call is byte-for-byte intact |
| Multiple queued chunks, finish requested immediately | Ordered concatenation without missing/duplicated bytes; finish waits for all remaining pieces |
| Progress then ENOSPC / EIO | Correct classification and actual byte count, including progress within the first chunk; partial retained, no final file |
| Zero progress before/after some data | Prompt failure without looping; empty file cleanup versus nonempty partial preservation |
| Invalid returned count | Reject without advancing byte accounting incorrectly |
| First failure followed by append/finish/abandon and timer activity | No further writes/publication, no unhandled rejection, handle released and timer cleared during cleanup |
| Final-name collisions | Existing early/late-collision tests still pass; complete contents at the actual returned destination |
| Recorder propagation and recovery | Failure event and partial path, no saved event, subsequent recording can succeed |

Use deterministic injected handles over real temporary files. Clean up writers/timers in test teardown even after expected failures. The earlier process-limit experiment is supporting evidence; it is not necessary to change real user disk capacity, machine-wide limits, or production app limits to run this suite.

## Verification and acceptance

Apply the [shared testing policy](../docs/testing.md): this affects file writing and recording failure behavior.

- Required automated checks on the final implementation: `pnpm check` (types, tests, production build) and `git diff --check`. Focused tests can run during development; do not repeat passed composite checks without a further change or unresolved concern.
- Required native smoke: build a fresh bundle with `pnpm start:app`; start, stop, save, verify media and observe playback using the [shared cases](../docs/acceptance.md). GPT-6 Astra performs native computer use under the [acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md); its supported unattended `pnpm acceptance` path may supply start/stop/save/media checks, with playback observed separately. Prior collision-fix acceptance is not acceptance of the new implementation.
- Changed failure cases are covered by controlled FileWriter/Recorder tests; report them separately from successful real screen/system-audio capture. Do not fill the user's disk to simulate ENOSPC.
- Serialize builds sharing `out/`/`dist/`; assign one desktop/audio/shortcut owner per acceptance round. Record environment/settings/evidence, restore changes, close test UI, quit normally and confirm all tested app processes exited.
- Exclusions: settings regression, permission resets, hardware removal, all-quality/fps matrices, long recordings, audio fidelity and release/installation checks are outside this change unless implementation expands into those behaviors.
- Missing native prerequisites are blocked, not not-applicable. Report checks/results, exclusions and required-but-unverified cases separately. Do not mark the plan complete merely because unit tests pass.

This planning-only change requires link/anchor, command-name and translation checks plus `git diff --check`; do not build or launch the app just to create the plan.
