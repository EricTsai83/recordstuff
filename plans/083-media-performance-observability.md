# 083 — Media pipeline measurements and budgets

[English](083-media-performance-observability.md) | [繁體中文](083-media-performance-observability.zh-TW.md)

Status: planned; not started. Created: 2026-10-22. Hard dependencies: None; follows 089 in the queue, 077 having closed on 2026-10-22. Execute in order under the [plan index](README.md). This task writes plans only; none of the implementation or performance claims below has been verified.

## Goal and current state

Make performance decisions reproducible before changing transport or adding an editor. Extend existing measurements, not a second benchmark system. `measure:cpu`, `matrix`, `measure:finalization`, preview statistics and camera-age reports already exist. Closed 080 found no CPU gain from shared textures; 081 identified Chromium window composition as the dominant Studio cost. Neither experiment is reopened here.

## Steps and ownership

- [ ] Inventory existing metrics and their clocks in the native engine, host, Studio port and decoder. Reuse session IDs and sampling infrastructure. Define capture/compose/encode/write, port/decode/draw durations, queue high-water marks and recovery/drop reasons. Never subtract independent process clocks without a measured mapping; distinguish draw completion from physical display presentation.
- [ ] Add development-only, bounded counters/histograms and aggregate reporting to the existing runners. No per-frame synchronous log or file I/O, screen content, device identifiers or input text in performance telemetry. The renderer remains outside the recording byte path. Collect metrics only while the relevant session exists.
- [ ] Use controlled footage with static text, motion and an optional synthetic camera; supplement with one real-camera run where available. Report process-tree CPU, shared encoder-service attribution limits, peak/resident memory, preview age p50/p95, throughput, drops and stop/save latency. Separate 30/60 fps and Studio active/resting/hidden cases. Extend existing CLI entry points and document any new options before using them.
- [ ] Compare diagnostics enabled/disabled back to back on identical artifacts. A/B/A is required only when the result hinges on drift, under the testing policy. Retain machine, OS, revision/dirty input identity, settings, fixture version, thermal/power conditions and raw samples. Publish bounded-workload results, not universal performance claims.

## Gates and completion

Freeze the workload and thresholds before candidate measurements. Existing CPU, frame cadence, sync and shutdown budgets remain authoritative. Instrumentation must stay within baseline spread; if it measurably perturbs the workload, reduce sampling before relying on it. A claimed optimization must exceed measured spread and improve its target by at least 10% relative, with no recording-integrity regression; improvements below that are inconclusive, not a reason to add architecture.

Record numerical memory/queue and latency baselines and the agreed budgets used by 084–088. New editor budgets are provisional until those plans measure their own workloads; feature overhead is reported separately from optimizations. Close with a reusable report schema and a written diagnosis, even if no optimization is justified.

## Verification and failure handling

Pure reporting/parser edits: focused fixtures and `pnpm typecheck`. Native/runtime instrumentation or new timers also require `pnpm check`, fresh signed recording smoke with media verification/playback, and the affected `pnpm measure:cpu` / `pnpm matrix` cases; reuse one take for several metrics. Exercise missing samples, interrupted reports and cleanup. Do not run a full matrix or full UI suite for a parser alone. An unavailable camera is an explicit unverified workload, not evidence of a pass. Remove temporary probes and retain evidence before closure.

## Execution and closure contract

Follow the [series contract](README.md#glide-inspired-evolution-083088) for evidence, gates, desktop handoff and closure. Preserve Electron/React, capture-process fault isolation and the default direct-MP4 workflow. At execution start inspect the current tree and predecessor closure records; paths and numbers here are design targets, not permission to skip current policy.
