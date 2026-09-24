# 030 — Evidence-backed audio and synchronization verification

[English](030-audio-verification-evidence.md) | [繁體中文](030-audio-verification-evidence.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-24. Execution order: see [queue](README.md#order-and-status).

## Scope and evidence

Bug **8**. Queue after 029; can be implemented independently once parser/report interfaces are stable. [judge](../scripts/lib/verify.mts) labels a check requiring energy in both channels pass when channelRmsDb is undefined; [verify-recording](../scripts/lib/verify-recording.mts) omits RMS when ffmpeg is unavailable. A controlled metadata-only test reproduces the false pass. No native audio failure is asserted.

Scope is analyzer, media-tool boundary, report/CLI/acceptance consumers and controlled media tests. Do not alter recording encoding or raise acoustic thresholds merely to make tests pass.

## Round 2 extension: R2-05

Merge R2-05 (P2) with R1-8: both confuse absent required evidence with successful verification. [run-matrix](../scripts/run-matrix.mts) requests sync but exits unsuccessfully only for fail. With valid format/fps/duration/channel RMS and syncAttempted=true but no flash/beep pairs, the real measure/judge path returns sync n/a and overall pass. This is a controlled verdict reproduction, not a native wrong-display matrix run.

- [ ] Model required evidence explicitly at the caller boundary. Matrix requires synchronization; an informational report that did not request it may retain n/a. Missing tools mean blocked/incomplete, insufficient markers mean incomplete or fail with reason, and measured out-of-threshold offsets mean fail. None can produce successful matrix exit.
- [ ] Define and document minimum valid pair count and temporal coverage using existing sync thresholds; short cases need enough pairs for their offset estimate, long cases need valid head and tail windows for drift. Presence of one pair or syncAttempted alone is not evidence of adequate coverage. Do not weaken thresholds to make samples pass.
- [ ] Propagate required sync/energy status through per-case, overall, text/Markdown/JSON and process exit. Audit all consumers that currently recognize only fail. Preserve independent format measurements and unrelated optional checks.
- [ ] Test no flashes, no beeps, too few pairs, head-only/tail-missing, malformed measurements, excessive offset/drift and valid samples. Use generated controlled media and an actual matrix CLI failure path to establish a nonzero exit and cleanup; also cover informational reports without requested sync.

The existing Cap decoded-energy comparison supports evidence-backed assertions; no equivalent matrix missing-marker contract was established by that review.

## Cap assessment

Cap's [audio sync matrix decodes samples, propagates read_audio_stats errors and rejects near-silent output](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/recording/tests/sync_matrix.rs#L775-L802). This demonstrates measurement-backed audio assertions, not a matching missing-FFmpeg verdict model or proof of separate left/right energy checks in that case. Adapt the evidence requirement; keep RecordStuff's per-channel threshold and require both channels independently. Do not copy Cap's linear RMS threshold into a dB-based check.

## Implementation and tests

- [ ] Separate sample-rate/channel format from per-channel energy. Format metadata can pass while energy remains unmeasured. Both valid measured channel values must exceed the existing threshold for the energy check to pass; silence, missing channels, malformed measurements and decode errors cannot become pass.
- [ ] Represent missing measurement and its reason explicitly. Missing FFmpeg for required acceptance is blocked/incomplete; requested measurement errors are failures. Intentional omission in an informational report is not measured, never energy pass. Preserve genuine n/a for unrelated checks.
- [ ] Update overall verdict, Markdown/text/JSON output and CLI exit policy together: a required energy check that is blocked or failed must prevent acceptance success and produce a nonzero CLI result. Do not make every historically optional metric mandatory accidentally. Audit consumers of metric names and verdict unions before splitting the check.
- [ ] Validate FFmpeg exit status and output completeness at the media-tools boundary. A process emitting partial parseable RMS then exiting nonzero is not a valid measurement. Keep stderr/context for diagnosis without silently treating missing values as silence or success.
- [ ] Use generated controlled stereo media: tone in both channels, fully silent, one silent channel, malformed/truncated input. Simulate missing executable/nonzero exit in an isolated subprocess environment without changing the user's PATH or tools. Assert per-check, overall and CLI outcomes; include a known-good retained recording if available.
- [ ] Update bilingual testing/tooling report guidance and fixtures. Historical reports remain historical; only rerun analysis where the missing evidence affects a current conclusion.

Required: analyzer/media-tool/CLI tests, `pnpm typecheck`, controlled FFmpeg/ffprobe media and `git diff --check`. R2-05 extends to matrix success gates and failure/cleanup, so exercise the affected real runner: `pnpm matrix -- quick` and `pnpm matrix -- long` (head/tail drift evidence) on a fresh bundle, retaining start/stop/save/media and observed playback evidence. An isolated missing-marker case must exit nonzero and clean up. Analyzer-only stages can use fixtures first but cannot close the combined plan; missing FFmpeg is blocked. Unchanged encoding/devices exclude full levels/fps/fidelity matrices, permission resets and publication.

## Completion and evidence handling

Follow [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Use the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) for any required native UI round. Serialize shared builds; one desktop/audio/shortcut owner per round. Restore changed settings, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan. Cap assessment is static source review at revision `ce785e705e79652adba4b8bf752669c4093499e0`, not execution or an assurance about every Cap mode/platform.
