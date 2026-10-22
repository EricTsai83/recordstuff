# 084 — Bounded preview delivery and recovery

[English](084-bounded-preview-delivery.md) | [繁體中文](084-bounded-preview-delivery.zh-TW.md)

Status: planned; not started. Created: 2026-10-22. Hard dependencies: 083. Execute in order under the [plan index](README.md). This task writes plans only; none of the implementation or performance claims below has been verified.

## Goal and current state

Keep a slow or suspended Studio from accumulating work or disturbing capture. The native `PreviewGate` already admits at most two callbacks and waits for a key frame after loss. `StudioLink` already controls subscriptions and 081 already selects 10/5 fps. Audit the remaining host → MessagePort → decoder boundary; do not describe existing controls as missing or replace the transport with the rejected 080 prototype.

## Steps and ownership

- [ ] Use 083 to reproduce a stalled renderer, slow decoder and repeated hide/rejoin. Locate actual buffering and define finite byte, frame, dimension and age limits at each boundary. Include native allocations and in-flight messages, not just `decodeQueueSize` or the JavaScript map. Document what cannot be measured directly.
- [ ] Implement a small session/generation-scoped credit or acknowledgement protocol only where bounds are absent. Credits represent released capacity, with bounded encoded chunk sizes; close/rejoin creates a new generation, and duplicate/stale acknowledgements cannot create capacity. A missing consumer must stop preview work without blocking capture, the writer or stop/save. Keep media off main and retain current pacing and independent level subscriptions.
- [ ] Preserve H.264 dependencies: do not drop arbitrary deltas and then decode later deltas. On loss/reset/age limit discard until a current key frame with configuration, close old decoded frames immediately, clear pending entries and bound key-frame recovery without per-frame reset/flush. Define behavior for oversized/malformed input, timestamp discontinuity, decoder error and missing WebCodecs. A broken preview reports unavailable; recording continues.
- [ ] If measurements justify it, prototype unchanged-frame suppression within this plan. Camera motion, layout edits, seek/config changes and meters remain independent invalidation sources; retain a bounded refresh/recovery mechanism. Keep it only if the frozen static workload meets 083's improvement gate and moving/interactive workloads regress neither latency nor quality. Otherwise remove the prototype and document rejection.

## Gates and completion

Under a controlled 30-second consumer stall, queued preview bytes/frames never exceed specified limits; no growth remains after resume or repeated reconnects. Recover to the current picture within two configured key-frame intervals plus the measured decode/draw allowance; freeze that allowance from 083 before coding. Test this with fake time, and confirm on hardware without introducing an always-on watchdog. Recording cadence, audio sync, CPU budgets and saved bytes remain valid. Preview-only failure must not fail a recording. The protocol is small, documented and owned by the existing modules; no generic event bus or second UI system.

## Verification

Focused protocol, decoder and native gate tests cover bounds, malformed messages, loss, old generations and close/error paths. Broad host/IPC changes require `pnpm check`; Studio integration uses the affected scopes, and its final run uses `pnpm acceptance:regression` per policy. Fresh signed recording smoke, `pnpm acceptance:studio` and affected CPU cases establish real capture, pacing and cleanup. Use a controlled fixture for stalls; do not freeze the user's app or block main. Add matrix cases only for changed timing/sync. Close with before/after metrics, resource ownership and remaining limitations.

## Execution and closure contract

Follow the [series contract](README.md#glide-inspired-evolution-083088) for evidence, gates, desktop handoff and closure. Preserve Electron/React, capture-process fault isolation and the default direct-MP4 workflow. At execution start inspect the current tree and predecessor closure records; paths and numbers here are design targets, not permission to skip current policy.
