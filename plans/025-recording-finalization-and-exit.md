# 025 — Recording termination, finalization and safe exit

[English](025-recording-finalization-and-exit.md) | [繁體中文](025-recording-finalization-and-exit.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-24. Execution order: see [queue](README.md#order-and-status).

## Scope and evidence

Bugs **3, 4 and 10**. Execute after [completed 024](../docs/verification/history-2026-09.md#plan-024-complete-writes--2026-09-24). The actual before-quit callback allows exit while failure cleanup is pending in idle, and calls quit after the 10-second cap even while finish is unresolved. A real FileWriter test also reproduces a host crash during delayed final copy: failure reports a retained partial, then finish deletes that partial and suppresses saved. These are controlled regressions, not measurements of native-exit data loss.

Affected owners: [Recorder](../src/main/recorder.ts), [exit integration](../src/main/index.ts), [FileWriter](../src/main/file-writer.ts), lifecycle tests and bilingual user feedback. Preserve exclusive destination naming and 024's complete-write contract. Do not add remuxing, crash recovery, background helper processes, or a native media rewrite.

## Round 2 extension: R2-01 and R2-02

Merge these bugs here because renderer termination and main finalization form one end-to-end ownership contract. R1 denotes the first audit; R2 denotes the second. Existing numbered bugs above are R1.

R2-01 (P1): [CaptureHost](../src/renderer/capture-host.ts) calls finish immediately on encoder error and waits on the chain captured at that instant. A later final dataavailable joins a newer chain. A controlled test of the real renderer emitted started, chunk, error, chunk; main has already cleared the session before the last chunk arrives. This differs from 024: the bytes never reach FileWriter. R2-02 (P2): after audio track ended, onstop waits for pending blobs before reading mutable stopRequested. A user stop during that wait changes the outcome from unexpected interruption to normal stopped. A real-renderer/fake-media test reproduced started, chunk, stopped with no error. Neither test establishes native fault frequency.

- [ ] Record the terminal cause when termination begins. Unexpected track end or encoder error must survive a later user stop; a normal stop that happens first must not become an error merely because its cleanup ends tracks. Preserve audio/display-specific diagnostics and real finalization errors.
- [ ] On encoder error, retain the cause and drain final dataavailable/stop and the latest blob handoff chain before sending exactly one terminal message. Track cleanup must not invalidate the remaining handoff. Define a bounded missing-stop/host-loss recovery that reports failure and only claims bytes actually retained; it cannot recover data lost in a hard crash.
- [ ] Test both event orders, delayed Blob conversion, rejected handoff, duplicate stop/error and absent terminal events. Add an integration path through the real CaptureHost protocol, Recorder and FileWriter, asserting final bytes, error cause, one terminal outcome and no unhandled rejection. Keep main's post-stopped ownership protection while fixing renderer's pre-terminal ordering.
- [ ] Extend the recording smoke and isolated lifecycle fixture below to cover the protocol changes. Controlled encoder faults are separate from native capture/playback evidence. No additional quality matrix is needed for unchanged encoding settings.

The existing Cap comparison concerns finalization/exit ownership; it does not establish that Cap handles these MediaRecorder event races.

## Cap assessment

Cap [checks active recording and pending finalizations independently before admitting normal exit](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/lib.rs#L3550-L3618). Its [finalization registry owns a result per project/attempt](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/lib.rs#L1010-L1133). This is a strong analogous design for bugs 3/4 and an ownership reference for bug 10; it does not prove the exact Electron renderer-crash case is tested in Cap.

Cap also has [bounded resource cleanup and a watchdog after exit admission](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/lib.rs#L3745-L3817); do not claim that it waits forever or guarantees survival of force-quit. Adopt the distinction between safety admission and later resource shutdown, not its Rust types or entire registry. RecordStuff retains its existing automatic stop-on-quit behavior, unlike Cap's normal busy-exit refusal.

## Implementation sequence and contract

- [ ] Give each attempt one terminal owner: capture failure/abandon or normal finalization. Once stopped is accepted, late host crash/error/display events cannot start concurrent abandon; disk errors from the finalizer still cause failure. Emit exactly one saved/failed outcome only after the resulting path is stable.
- [ ] Track all outstanding opening, writing, finalizing and failure-cleanup work independently of UI state. Register work before synchronous state subscribers can request exit. Replace a single overwritable pendingFailure reference with tracked operations; an older cleanup cannot disappear when a newer attempt fails. Include late writer-open completion after startup timeout.
- [ ] Make before-quit use one idempotent shutdown coordinator even from idle. Block new recording admission while a quit attempt is active; repeated quit requests join the same work. Automatically request stop as today, then wait for all owned disk work. Keep files and their handles owned until completion.
- [ ] Keep the capture-response timeout, but remove its authority to end a still-running finalization. If a deadline expires with disk work pending, cancel/defer quit, keep the app open, and show localized saving/cleanup-pending feedback. Do not destroy the host/app or claim saved/kept prematurely. Reset quit admission safely so the user can retry; a second quit cannot bypass outstanding work. Do not add an in-app destructive force-exit path.
- [ ] Resolve publication-versus-abandon races inside the writer if needed; do not rely on the deleted session pointer to undo already-started I/O. Verify paths before exposing a retained result. Preserve the ability to start a later recording after failed capture, while retaining ownership of earlier cleanup.
- [ ] Update recording/desktop design and translations with the normal-quit contract and force-quit limitations.

## Regression and acceptance

Automated: delayed abandon from idle; two overlapping failure cleanups completing in either order; late writer open after timeout; delayed finish beyond 10 seconds; repeated quit; completion/failure during quit; host crash/error before and after stopped; disk error during finalization; exact contents and stable terminal paths using real temporary files. Test production exit orchestration, not a copied busy predicate. No double saved/failed, lost task, deleted advertised partial, unhandled rejection or premature app.quit.

Required: `pnpm check`; fresh `pnpm start:app` recording smoke (start/stop/save/media/playback), normal quit during recording, and idle quit. Add an isolated Electron lifecycle fixture that delays actual final copy/cleanup, requests quit through production wiring, confirms the process remains alive with pending work and exits only safely. A Recorder promise test alone is insufficient evidence of process lifetime. Use scoped test injection, never fill the disk or change real machine limits. If pending-work feedback touches settings, add `pnpm acceptance:regression`; if native notifications are changed, add the notification-policy row.

Excluded unless implementation expands: full quality/fps matrices, long recordings, audio fidelity, permission resets, display removal and release checks. Until 030, media evidence must explicitly include measured channel RMS with functioning FFmpeg, not just an overall green verdict.

## Completion and evidence handling

Follow [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Use the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) for any required native UI round. Serialize shared builds; one desktop/audio/shortcut owner per round. Restore changed settings, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan. Cap assessment is static source review at revision `ce785e705e79652adba4b8bf752669c4093499e0`, not execution or an assurance about every Cap mode/platform.
