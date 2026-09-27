# 049 — CPU budget: idle and recording

[English](049-cpu-budget.md) | [繁體中文](049-cpu-budget.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-28. Queue after [048](048-menu-and-settings-order.md) and before [035](035-guided-native-acceptance.md), which stays last. It has no dependency on 045–048 and can run at any point; running it earlier would give 047 and 048 a baseline for the Settings-open case. Execution order: see [queue](README.md#order-and-status).

## Purpose and boundary

On 2026-09-28 the maintainer asked for a plan that keeps RecordStuff's CPU use small while it waits in the menu bar, then asked, the same day, that CPU while recording also be checked against a normal range, with Cap's approach as a reference and the metrics added to this plan.

What exists today:

- **Idle: nothing.** `pnpm check` cannot see what keeps running across the app, and no runner samples an idle process.
- **Recording: `pnpm matrix`.** It samples `ps` `%cpu` of every process in the development Electron.app once a second during each case, drops the first three samples, and fails a case whose summed average exceeds 40% of one core ([thresholds](../docs/system-design/tooling.md#measurement-pipeline-and-thresholds)). Recorded results on the reference M1 Pro ([history](../docs/verification/history-2026-09.md#results)): 1080p30 Standard over ten minutes averaged 17% with a 21% peak, 60 fps about 23%, and VTEncoderXPCService, the system's hardware encoder, 1.4–1.9% while encoding.

The recording check has five gaps. The matrix is required only for frame-timing, resolution, frame-rate and audio changes, and `pnpm acceptance`, the recording smoke on the packaged app, measures no CPU. It measures the development Electron.app rather than RecordStuff.app. macOS `ps` reports `%cpu` as a decaying average over up to a minute, which flattens peaks and carries start-up load into the first samples. Work done for the app by system helpers is not shown. And 40% is about twice what was measured, so only a doubling fails.

What runs while idle, from the current source:

- **Processes.** The main process and Electron's GPU and utility helpers. While Settings is closed there is no renderer: the capture host window and the countdown overlay are destroyed whenever the state settles ([index.ts](../src/main/index.ts)).
- **Timers.** [PermissionWatcher](../src/main/permission.ts) polls `getMediaAccessStatus('screen')` every 5 seconds, a cheap call by design. The capture host's 5-second ping and the writer's fsync interval exist only during a session. [Update checks](../src/main/updates.ts) run at launch, at most once a day.
- **Listeners only.** Display changes, power suspend and resume, global shortcuts and tray clicks wake the app only when they happen.
- **Settings, if left open.** An idle renderer whose only animation is the listening indicator during shortcut capture.

This plan adds a budget for both states, one CPU sampler shared by a new runner and the matrix, and unit tests that catch leftover timers in `pnpm check`. It optimizes only what the measurements show. Out of scope: memory limits (reported, not budgeted), battery-life measurement (`powermetrics` needs root), and Windows.

## Cap reference

At pinned revision `119edf04864b59abfc0d52f60bf77d7f33cfd2b8` (static source review, Cap not run). Cap measures CPU thoroughly, but only in developer tools: no CI job or shipped code measures it, and no CPU figure fails anything.

- **An external per-process sampler.** Its macOS harness compiles a small C program that [reads `proc_pid_rusage` for each process](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/scripts/instant-mode-process-sampler.c#L101-L131) once a second (CPU time, energy, idle and interrupt wake-ups and more), sums Cap, its WebKit helpers and child processes, and [marks a phase invalid when that set of processes changes](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/scripts/instant-mode-performance-macos.py#L466-L521). It reports each phase, idle included, as the median of repetitions, and it [does not attribute shared macOS encoder and camera services to Cap](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/scripts/instant-mode-performance.md#L96-L99).
- **Advisory labels, no gates.** Its profilers print bands such as [below 5% excellent, below 15% good and below 30% moderate](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/crates/recording/examples/instant-mode-profile.rs#L82-L117), averaged per core across all cores, which is lenient on a many-core machine. The limits its test harness enforces cover [frame drops, frame rate, latency and A/V sync](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/crates/cap-test/src/config/types.rs#L204-L239), and its weekly [performance workflow](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/.github/workflows/performance-regressions.yml#L3-L15) tests playback and export only.
- **One CPU figure worth knowing.** Its encoder benchmark on an M4 Max measured [763 µs of CPU per 1080p30 frame through VideoToolbox's zero-copy path, and 45 ms per 4K60 frame after falling back to libx264](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/crates/recording/FINDINGS.md#L497-L505): about 2.3% of one core against about 270%. Losing the hardware path is an order-of-magnitude jump, not a drift.
- **Nothing for idle.** There is no idle or energy target, and the shipped app [logs its memory every 60 seconds for its whole life](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/desktop/src-tauri/src/lib.rs#L727-L759), a timer that keeps firing while idle.

Adopted: an external per-process sampler reading `proc_pid_rusage`, wake-ups and energy beside CPU, discarding a window whose process set changed, medians of repeated runs for a baseline, and system encoder services reported apart from the app. Not adopted: labels without thresholds, per-core averages over all cores, and any monitoring timer inside the shipped app, which would itself wake the idle app. Cap's 2.3% covers its encoder alone in a native pipeline, so it is not a target for RecordStuff's whole Chromium pipeline.

## Reasonable ranges

CPU is given as a percentage of one core, as Activity Monitor shows it; the reference M1 Pro has ten cores, so the whole machine is 1000%. Wake-ups are timer firings per second, Activity Monitor's Idle Wake Ups. The figures hold for the reference machine; another machine takes its own baseline before its results are judged.

| State | Reasonable | Test threshold (initial target) | Why |
| --- | --- | --- | --- |
| Idle, Settings closed | About 0–0.2%, a few wake-ups per second | Average ≤ 0.2%, 95th percentile of one-second samples ≤ 1%, ≤ 5 wake-ups per second in total | There is nothing to do. Apple's [energy guide](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html) says timers keep the CPU from idling and that apps should respond to events instead of polling; RecordStuff's only periodic work is the 5-second permission poll, 0.2 wake-ups per second. Anything above this is Electron's floor, which the baseline measures, or a leak |
| Idle, Settings open behind another app | Under 0.5% | Average ≤ 0.5% | One idle renderer with no running animation |
| After a recording | Back in the idle range | Within 30 seconds of saving, the idle thresholds and the same processes as after launch | A timer, renderer or encoder left behind shows up here |
| Recording, 30 fps | About 15–25% | Average ≤ 30%; fails above 40% until the new baseline confirms 30% | Capture and H.264 encoding run in hardware; the app's own share is the Chromium media pipeline, AAC audio, IPC and file writes. Measured 17% average and 21% peak |
| Recording, 60 fps | About 20–35% | Average ≤ 40% | Twice the frames, but not twice the fixed costs. Measured about 23% |
| Hardware encoder while recording | VTEncoderXPCService present at a few percent | Reported, not judged | If it is absent while the app's own CPU is high, suspect a software-encoding fallback, which in Cap's benchmark cost tens of times the hardware path per frame |

A recording case whose average rises more than 25% above its recorded baseline for the same machine and settings is flagged for investigation even under its threshold, because a regression can hide under a generous ceiling. It is a warning rather than a failure, since CPU drifts between rounds.

## Implementation contract

- [ ] **Idle timer audit.** List every interval, timeout and listener in main and whether it may run while idle, and add unit tests that a settled session leaves none behind: the Recorder after saved, failed and cancelled sessions (with fake timers, no pending timer remains), the capture host after teardown and destroy (the ping interval is cleared), the file writer after close and abandon (the fsync interval is cleared) and the countdown overlay after close. PermissionWatcher remains the one expected interval, and its test asserts exactly one timer at its interval. These run in `pnpm check`, so a leak fails before any native round.
- [ ] **Shared CPU sampler.** A development-only module under `scripts/lib/`, after Cap's harness: a small C helper, compiled with `clang` from the Command Line Tools into the run's output folder, reads `proc_pid_rusage` for each process once a second: CPU time in nanoseconds, idle and interrupt wake-ups, energy and resident memory. `ps` reports CPU time in hundredths of a second, too coarse for an idle second, where 0.2% is 2 ms. The module resolves the app's main process and all its descendants at every sample, can follow named system helpers outside the tree such as VTEncoderXPCService, and reports the average, 95th percentile and maximum per process and in total. A judging window in which the app's process set changed is discarded and reported, apart from the expected start and end of a recording. Without the Command Line Tools the CPU measurement is blocked, not skipped. Its parsing, tree resolution and statistics are tested on recorded samples.
- [ ] **`pnpm measure:cpu`.** A development-only macOS runner on a fresh `pnpm start:app` bundle. It refuses to start while another RecordStuff is running, launches the app, and waits until the log shows idle and startup work finished (history loaded, the update check settled or skipped). Scenarios, in order:
  - **A. Idle after launch,** Settings closed: 5 minutes after a 60-second warm-up.
  - **R. Recording:** a 60-second recording started and stopped with the recording shortcut, as `pnpm acceptance` does, with the test material moving on the recorded display, the countdown Off and the quality seeded to Standard at 30 fps, all restored afterwards; judged over seconds 5 to 55, with VTEncoderXPCService followed. `--fps 60` adds a second recording at 60 fps, and `--repeat N` repeats the recordings.
  - **B. Idle after the recording:** from 30 seconds after saving, 5 minutes, compared with A's process set (no renderer left, VTEncoderXPCService gone).
  - **C. Settings open** behind another app: 3 minutes.

  Options: `--minutes`, `--fps 60`, `--repeat N`, `--skip-recording`, `--skip-settings` and `--out`. It writes a Markdown and JSON report to `docs/verification/measurements/<time>-cpu/`, which git ignores, with each scenario's CPU, wake-ups and energy against the thresholds above, any discarded window, the per-process breakdown and process list, memory, and the machine, macOS, Electron, displays and power source. Like the other runners it declares user activity, holds a display and idle-sleep assertion for its lifetime, restores what it changed, quits the app normally and confirms that its processes exited.
- [ ] **Matrix on the shared sampler.** `pnpm matrix` replaces its `ps` `%cpu` sampling with the shared sampler, keeps dropping the first three seconds, adds the 95th percentile and the VTEncoderXPCService figure to each case, applies the per-frame-rate thresholds above in place of the single 40% once the first baseline confirms them, and prints the 25% regression warning against the case's last recorded baseline.
- [ ] **Budget in the tooling guide.** The thresholds above go into the [measurement thresholds](../docs/system-design/tooling.md#measurement-pipeline-and-thresholds) as initial targets. The first baseline with the new sampler confirms each one, with each recording figure taken as the median of three repetitions, since recording CPU drifts between runs: keep a target only if the baseline passes it with margin. A baseline that fails a target is a finding to investigate, not a reason to loosen the target without written evidence and the maintainer's agreement. The 17%, 21% and 23% figures came from `ps`'s decaying average on the development Electron.app, so the new baseline replaces them rather than being compared with them.
- [ ] **Fix what the baseline finds.** If a target fails, locate the process and cause from the per-process breakdown, with `sample` or Instruments if needed, then fix it or record it with the maintainer's decision. The 5-second permission poll is the known periodic waker; change it only with evidence that it matters, because it is how a revoked permission is noticed while no window is open.
- [ ] **Documentation.** Update in both languages: the tooling guide (the sampler, `pnpm measure:cpu`, its scenarios, the thresholds, how to read the report, and the Command Line Tools as a prerequisite of CPU measurement), the [testing policy](../docs/testing.md) (a row: new timers, polling, watchers, windows that stay alive, tray changes and Electron upgrades need `pnpm check` plus `pnpm measure:cpu`, an Electron upgrade takes a new baseline, and changes that already require the matrix read its CPU figures too), and an idle-behaviour paragraph in the [design overview](../docs/system-design/design-overview.md) that lists what may run while idle. Record the baselines in the verification history.

## Verification and exclusions

- [ ] `pnpm check`: the timer tests and the sampler's tests on recorded samples.
- [ ] On a fresh `pnpm start:app` bundle, one `pnpm measure:cpu -- --fps 60 --repeat 3` run: the idle scenarios once and both recordings three times, whose medians are the recording baseline. Repeat only a result close to a threshold, as the testing policy says. Exercise the runner's refusal while RecordStuff is already running, and its cleanup after an interrupted run.
- [ ] One `pnpm matrix -- fps --repeat 3` round (Source Standard at 30 and 60 fps, 15 seconds each) to exercise the matrix on the new sampler and take its median baseline; its other metrics are unchanged.
- [ ] Exclusions: memory budgets, battery drain, long soak runs (a 30-minute idle run only if the 5-minute results sit near a threshold), resolutions beyond the reference displays, and Windows (macOS-only verification). No case moves to 035: the measurements need no judgement from the maintainer.

## Completion and evidence handling

Follow the [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Serialize shared builds; one desktop/audio/shortcut owner per round, since the recording scenario and the matrix record and press the shortcut. Restore changed settings, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan. The Cap references are a static source review at the pinned revision, not execution or an assurance about every Cap mode or platform.
