# 088 — Optional editable capture and automatic zoom

[English](088-editable-capture-and-auto-zoom.md) | [繁體中文](088-editable-capture-and-auto-zoom.zh-TW.md)

Status: planned; not started. Created: 2026-10-22. Hard dependencies: 085–087 implemented; 083 budgets and 084 bounds retained. Execute in order under the [plan index](README.md). This task writes plans only; none of the implementation or performance claims below has been verified.

## Goal and product gate

Make future recordings editable after capture: cursor/zoom and optional camera placement, while ordinary direct MP4 stays the default. First show the maintainer a working project/export flow from 087 and measured estimates for extra encoders, disk writes and privacy permissions. Confirm the editable mode's source/track scope before implementation. Do not promise to recover camera or clean-screen pixels from old flattened recordings.

## Steps

- [ ] Define an explicit editable-capture option and honest storage/CPU estimate. Keep the existing default path unchanged. In editable mode capture clean screen video, optional separate camera and independent system/microphone tracks with a common media clock, offsets, pause/stop rules and loss metadata. Reuse native encoders/muxing where possible. Prototype resource cost before building UI; do not double-encode a convenience flattened MP4 unless the measured budget and product decision allow it. 087 supplies the explicit later MP4 export.
- [ ] Add opt-in mouse position/click/cursor-shape events in bounded, chunked sidecars. Record coordinate-space transforms and bounds changes for high-DPI/multi-display alignment; missing events degrade to a standard cursor/no auto zoom. No raw keyboard logging, typing detection, passwords or app-title collection. Document platform permission needs from tested APIs and request only in context. Input-logger failure disables that enhancement, not screen capture.
- [ ] Extend 085's asset transaction/recovery to multi-track sessions: one session owner, per-track size/backlog limits, aggregate disk-space/backlog policy, manifest last-commit ordering and incremental recovery metadata. Do not rewrite a growing JSON array per event. Preserve recoverable screen fragments after worker death; mark missing camera/mic and timing gaps explicitly. Disk exhaustion terminates media safely under the existing outcome contract. A broken optional logger never triggers a fallback recording secretly.
- [ ] In 086's pure scene model, derive click-based zoom targets with bounded scale/speed, edge clamping and time-based spring evaluation that is seek/order independent. Separate observed events from editable zoom keyframes. Add a small zoom inspector, manual adjustment, disable/reset and bounded undo using production UI; no full nonlinear timeline or plugin system. Cursor motion and zoom use the same model in preview/export.

## Gates and verification

Before implementation freeze resource ceilings against 083 on one reference machine. Initial prototype ceiling for editable mode: total app CPU ≤1.5× direct-mode baseline with the same active camera/audio inputs, additional resident memory ≤256 MiB, and bounded queues independent of take length. These are proposed product budgets, not evidence or improvements. Record disk amplification separately for clean screen/camera/audio/events. If exceeded, reduce track/resolution scope or stop at the prototype decision; do not weaken the default recording budget.

Default mode must remain within baseline spread and existing cadence/sync budgets. Editable mode must meet existing sync/cadence criteria with all enabled tracks; a long case is required because multi-clock drift changes. Replay event fixtures for pause boundaries, rotation/DPI, window movement if supported, cursor loss and random seeks. Verify event chunk bounds, no keyboard data, camera/mic dropout and process-death recovery, then import → adjust → export → native playback. Test permissions using the existing hands-on boundaries; do not reset TCC automatically.

Broad capture, storage, UI and lifecycle integration requires `pnpm check`, final `pnpm acceptance:regression`, fresh signed recording/media/playback, affected capture-settings/Studio/lifecycle cases, CPU comparison and relevant matrix including `long`. Windows CI verifies contracts/build only; list untested hardware behavior. Finalize recovery/format/privacy documents and bilingual help, retain failed experiments, remove temporary probes, and update durable design decisions before closure.

## Execution and closure contract

Follow the [series contract](README.md#glide-inspired-evolution-083088) for evidence, gates, desktop handoff and closure. Preserve Electron/React, capture-process fault isolation and the default direct-MP4 workflow. At execution start inspect the current tree and predecessor closure records; paths and numbers here are design targets, not permission to skip current policy.
