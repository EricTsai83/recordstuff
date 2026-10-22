# 087 — Supervised, bounded hardware export

[English](087-supervised-hardware-export.md) | [繁體中文](087-supervised-hardware-export.zh-TW.md)

Status: planned; not started. Created: 2026-10-22. Hard dependencies: 085 and successful 086 backend gate. Execute in order under the [plan index](README.md). This task writes plans only; none of the implementation or performance claims below has been verified.

## Goal and boundaries

Export one immutable project revision to a separate playable MP4 using 086's scene model. Initial scope is trim and styling over 085's existing recording, H.264/AAC, one export job. HEVC/ProRes/GIF, file-size targeting, captions, voice enhancement, speed changes and a general job scheduler are outside this increment. Do not change the default recording encoder or add FFmpeg as a runtime dependency without a separate dependency decision.

## Steps

- [ ] Define a narrow validated job protocol and reuse utility-process supervision patterns. Export runs in a separate worker process from a live capture; main owns job admission, destination reservation, progress and final publication, never frame bytes. Bind a job to a manifest revision and source identities so autosave cannot change an in-flight export.
- [ ] Implement decode → shared scene/render → hardware encode → mux/write, with finite frame/byte queues and backpressure. Use IOSurface/Metal where measured and a deliberate Windows adapter; zero-copy is a measured path, not an unconditional guarantee. Explicitly select/report hardware support and software fallback policy; do not silently spend unlimited CPU when unavailable.
- [ ] Keep audio/video trim mapping consistent, account for codec priming/end padding and preserve color metadata/range. Use deterministic source fixtures to verify exact start/end behavior; define documented frame/sample tolerances. Reject unsupported media and output sizes clearly instead of silently rescaling or dropping audio.
- [ ] Reserve a new destination exclusively, write an owned temporary file and publish only after encoder flush, successful finalization and required syncs. Cancellation/crash/disk-full retains source and project bytes exactly and removes only owned disposable output; retain a recoverable partial when that is the chosen documented policy. Bound cancellation and shutdown, handle late callbacks and retry a fresh job. Never terminate a recording to finish an export.
- [ ] Default to serial export and refuse/defer a new export while recording/live preview uses the engine. Define admission in the existing recording state/quit gates, including the inverse race where a recording starts while export is active: cancel/defer export before admitting capture. Do not add concurrent GPU/media-engine competition until separately measured. Production UI provides progress, cancel, error/retry and unsaved-project semantics in both languages.

## Gates and verification

Freeze 1080p30 reference media and quality settings before benchmarking. Target at least real-time export on the reference Mac, bounded queue memory independent of clip length, and p95 cancel completion ≤2 seconds for the local fixture; test a blocked I/O case separately with the supervisor's explicit deadline. Failure to meet a target triggers optimization or a documented scope decision, never an unqualified performance claim. Report decode/render/encoder-wait/write time and output quality; prevent speed gains obtained by silently lowering fidelity.

Use synthetic decode/render/audio fixtures, source checksums, forced worker death, GPU failure, disk-full, destination collision and cancel-at-finalize cases. Broad native/process/file-lifecycle changes require `pnpm check`, lifecycle fixture coverage if quit changes, final UI regression and affected package checks. Native playback validates a real exported file. Fresh recording smoke and CPU cases verify admission and no default-path regression; only affected matrix subsets. Windows CI build/fixtures remain distinct from unverified hardware export. Close with measured results, cleanup, failure recovery and a minimal user workflow.

## Execution and closure contract

Follow the [series contract](README.md#glide-inspired-evolution-083088) for evidence, gates, desktop handoff and closure. Preserve Electron/React, capture-process fault isolation and the default direct-MP4 workflow. At execution start inspect the current tree and predecessor closure records; paths and numbers here are design targets, not permission to skip current policy.
