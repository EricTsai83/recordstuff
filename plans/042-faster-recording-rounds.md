# 042 — Faster recording rounds

[English](042-faster-recording-rounds.md) | [繁體中文](042-faster-recording-rounds.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-26. Source: the time analysis of the [plan 041](../docs/verification/history-2026-09.md#plan-041-closure--2026-09-26) round and a maintainer request. Scheduled before 040 and 037, whose recording rounds benefit; there is no hard dependency. Execution order: see [queue](README.md#order-and-status).

## Problem and evidence

The plan 041 round held the desktop for about 50 minutes, and about 20 of them repeated evidence that already existed. The policy part is already fixed: on 2026-09-26 the [testing guide](../docs/testing.md#keep-recording-rounds-short) gained rules for reusing a baseline, recording only cases that differ in the environment, screening candidates once, measuring each quantity once after a change and repeating only on doubt. What remains is the runners' fixed cost:

| Command in the 041 round | Recording | Wall time |
| --- | --- | --- |
| `pnpm matrix -- fps` | 2 × 30 s | 103 s |
| `pnpm matrix -- quick` | 3 × 30 s | 144 s |
| `pnpm matrix -- long` | 180 s | 218 s |

Each case also pays for an app launch, the 1.5-second autorecord start delay, stop and save, a quit, verification that reads the file with ffprobe twice and ffmpeg three times (a full `-count_frames` decode, the frame timestamps, blackdetect, silencedetect and astats) and a fixed 10-second rest. Each invocation also rebuilds `out/` and opens the test material with a 5-second wait. A repeat means a second invocation, so running `fps` twice paid for two builds and two material launches. These component costs are estimates from the command totals; step 1 measures them before anything changes. The matrix also has no interruption cleanup: after Ctrl-C the material browser stays open and an autorecord app keeps recording until its timer stops it.

## Scope

In scope: `pnpm matrix` orchestration (several matrices and repeats in one invocation, interruption cleanup, per-phase timing), the rest between cases, the duration of short cases, and the verification's decode passes. Out of scope: the thresholds and required evidence, the test material, the app's autorecord behavior and one launch per case (it isolates cases), `pnpm acceptance` and the notification, settings and update runners, the audio-quality diagnostic, and Windows.

## Step 1 — Measure where the time goes

- [ ] Print and record per-phase durations for every matrix run: build, material open, and per case launch-to-recording, recording, stop-to-saved, quit, each verification tool, and rest. Collect them over at least one `fps`, one `quick` and one `long` run on the maintainer machine. Use this table, not the estimates above, to choose which of step 2's items to implement.

## Step 2 — Remove fixed cost where it is measured

- [ ] One invocation for several matrices and repeats, for example `pnpm matrix -- fps,long --repeat 2`: one build, one material launch and one desktop round; repeated cases interleave, like the cadence diagnostic's rates, so no case always runs first or warmest. The summary keeps every run and groups repeats per case with minimum, median and maximum; any failed, blocked or incomplete run keeps the case from passing, and exit codes stay as they are.
- [ ] Rest between cases: compare the current 10 seconds with a shorter rest, or with the verification time counted as rest, on the same cases. Adopt the shorter rest only when CPU, average frame rate, median interval and drops stay within the run-to-run spread observed in step 1.
- [ ] Short cases: compare 15-second with 30-second `fps` and `quick` cases. The `all` matrix already uses 15 seconds, and with one flash per second a 15-second case still holds about 14 flash/beep pairs, well above the minimum of 3. Adopt 15 seconds only when every judged metric stays within the observed spread; `long` stays 180 seconds.
- [ ] Verification: when step 1 shows the decode passes are a material share, obtain the markers and channel levels from one ffmpeg run instead of three. Controlled generated media must give the same flashes, beeps and per-channel RMS as the separate passes, and a tool that fails must still fail its checks and discard partial output (the plan 030 rule).
- [ ] Interruption: SIGINT or SIGTERM stops the material browser, lets a running autorecord case finish saving or stops it, ends the desktop round, confirms that the round's processes exited and exits 130 or 143, the way the cadence diagnostic does. Cleanup must not kill another RecordStuff.

## Go criteria

- The same evidence set, for example `fps` twice plus `long` once, takes at least 25% less wall time than separate invocations did.
- No judged metric moves beyond the run-to-run spread for the same code; verdicts, required evidence and exit codes are unchanged; a repeat summary never hides a failed run.
- An item whose measured saving is small or whose comparison fails is dropped and recorded as such, not implemented anyway.

## Verification and exclusions

- [ ] `pnpm check`, with unit tests for argument parsing (lists of matrices, `--repeat` bounds, unknown names), interleaving order, repeat summaries that keep failures, and, if implemented, single-decode parsing against the separate passes.
- [ ] Exercise the changed runner for real: one multi-matrix `--repeat` round on the maintainer machine, and one interrupted round checking that no Electron or material process remains. Record the before and after wall times and per-phase tables.
- [ ] Excluded: app recording smoke and native acceptance, because the app is not changed; the levels matrix, ten-minute runs and the audio diagnostic, unless a change touches them.

## Completion and evidence handling

Follow the [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Keep a `caffeinate` running during desktop rounds, give one executor the desktop, serialize builds, and confirm that every owned process exited.

- [ ] Update the matrix section and commands of the bilingual [tooling guide](../docs/system-design/tooling.md), record the timings, the adopted and dropped items and their evidence in the bilingual verification history and index, then remove this plan and its translation. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no build, tests, launch or recording just to write this plan.
