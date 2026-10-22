# 086 — Deterministic scene model and shared rendering

[English](086-deterministic-scene-rendering.md) | [繁體中文](086-deterministic-scene-rendering.zh-TW.md)

Status: planned; not started. Created: 2026-10-22. Hard dependencies: 085 implemented; 083 budgets and 084 preview contract. Execute in order under the [plan index](README.md). This task writes plans only; none of the implementation or performance claims below has been verified.

## Goal and boundaries

Let preview and export evaluate the same edit at the same media time. Start with trim, background/padding and the existing camera-layout math; no timeline framework, plugin system or wholesale engine rewrite. A pure Rust scene model returns render parameters from project revision, rational media time and output size. TypeScript owns UI interaction, not a competing animation engine.

## Steps

- [ ] Define time mapping, coordinate spaces (physical pixels, points, normalized layout and output pixels), rounding, aspect/crop rules and color contracts. Cover nonzero track offsets, missing tracks, seek backwards and source rotation. Preserve integer/rational time until the platform boundary; do not advance animation by UI frame deltas.
- [ ] Build a small pure module with deterministic fixtures shared across preview/export. Integrate existing `camera_layout` and WGSL formulas rather than copying them. Keep capture-specific clocks and OS handles out of the scene model; introduce only the smallest actual reuse boundary.
- [ ] At a measured prototype gate compare current Metal/D3D11 adapters with a wgpu editor compositor. A multipass editor may justify wgpu; the live D3D11 capture path does not migrate merely for uniformity. Measure texture import, format conversion, copies, GPU synchronization and supported hardware on each available platform. Retain a single semantic scene/shader source and explicitly document adapter differences. Adopt a backend only after its packaging, device-loss and maintenance cost is accepted.
- [ ] Integrate a minimal production preview, with on-demand rendering when paused, bounded decode/texture caches and explicit cancellation/generation on seek. Release obsolete frames, buffers and GPU resources on every close/error/device-loss path. Media processing stays outside main and the sandboxed renderer; reuse the proven encoded preview transport where appropriate. Low-resolution preview and full-resolution output use the same semantics with documented sampling differences.

## Gates and verification

Replay the same timestamps in forward, random and backward order: scene parameters match within stated numeric tolerances. Compare rendered synthetic frames through both entry points, with color/scale tolerances declared before testing; do not impose UI pixel baselines or design values. Verify crop, rounding, alpha edges, color range/transfer and high-DPI text footage. Device loss must leave source assets intact and permit restart or an explicit unavailable state, not crash main.

Freeze a 1080p30 preview workload and memory budget from 083 before selecting a backend. Playback p95 processing must fit the 33.3 ms frame budget on the reference hardware; seek completion has a separate measured bound. Report decode/render/transfer separately. If the backend misses its gate, remove the prototype and record a decision before continuing 087; do not retain two permanent rendering implementations.

Pure scene changes use Rust focused tests/Clippy/format; backend/build and shared engine integration require `pnpm check` and affected packaging checks. UI integration finishes with `pnpm acceptance:regression`; real GPU/preview cases need the native workflow. Recording smoke/CPU/matrix is required if the live compositor changes, omitted with reasons if editing is isolated. Windows CI synthetic tests do not prove hardware texture sharing. Close with one ownership/lifetime contract and updated architecture documentation.

## Execution and closure contract

Follow the [series contract](README.md#glide-inspired-evolution-083088) for evidence, gates, desktop handoff and closure. Preserve Electron/React, capture-process fault isolation and the default direct-MP4 workflow. At execution start inspect the current tree and predecessor closure records; paths and numbers here are design targets, not permission to skip current policy.
