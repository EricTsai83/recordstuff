# 089 — A prompt permission refusal and a closed-lid microphone

[English](089-start-feedback-from-077.md) | [繁體中文](089-start-feedback-from-077.zh-TW.md)

Status: planned; not started. Created: 2026-10-22, from two observations of 077's hands-on round, at the maintainer's request. Priority: proposed next, before 083; the maintainer orders it. Hard dependencies: none. Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Two ways a start or a recording fails the user without saying so promptly, both seen on hardware in [077's round](../docs/verification/history-2026-10.md#plan-077-closure--2026-10-22):

1. **Permission refused 9.3 s late.** With the screen permission turned off and the running app told "Later", a start sat in `starting` for 9.3 s before `permission_denied`. [`display-source.ts`](../src/main/display/display-source.ts) enumerates capture sources up to three times, 150 ms apart, and only on the third empty answer (displays present, no sources, macOS) concludes the grant was revoked; each `desktopCapturer.getSources` call apparently waited about 3 s. Success: a revoked grant is refused within a bound the plan sets from measurement (target ≤ 1 s after the first empty enumeration), with the same `permission_denied`, card and notice, and without refusing a real topology change that the retries exist for.
2. **A closed-lid built-in microphone records silence.** With a MacBook's lid closed the built-in microphone is still listed, opens and delivers digital zeros; 13 s of a 077 recording were silent and nothing told the user, since a loss is judged by missing buffers, not by their content. Success: the user learns before or during the recording that the chosen input cannot hear, in a way the maintainer chooses at D2.

Out of scope: Windows beyond CI; any change to how an ordinary quiet microphone or a muted one is treated (a quiet room is not a fault); the shareable-content path inside the engine; 077's other observations (the 1.4 s between a removed display's last frame and main noticing it is accepted as documented).

## Steps

### 1. Measure the refusal

- [ ] Time each `getSources` call and the whole resolution in the log for a start with the grant revoked (maintainer revokes; agents never change TCC) and for an ordinary start; record whether an empty answer with displays present ever occurs with the grant intact (a display waking, a topology change). Unit-test the timing line.

### 2. D1 — when to conclude the grant was revoked (maintainer)

- [ ] Recommended: on macOS, an empty source list while displays exist and `PermissionWatcher` already doubts the grant (or the engine's own probe says so) is refused at once; otherwise keep the three tries. Alternatives: refuse on the first empty answer always; or ask the engine's `probe` in parallel and take whichever answers first. Implement the choice with tests for each branch, keeping `topology_changed` and `no_display` as they are.

### 3. Detect a microphone that cannot hear

- [ ] Find what macOS exposes for a closed lid (IOKit `AppleClamshellState`, the built-in device's data source or `kAudioDevicePropertyDeviceIsAlive`/`IsRunningSomewhere`) and whether the HAL lists the built-in input differently then; and measure, from 077's file and a new one, whether "every sample exactly zero for N s" separates it from a quiet room on the BenQ, built-in and Bluetooth inputs.

### 4. D2 — what the user sees (maintainer)

- [ ] Recommended: mark the built-in input in the device list while the lid is closed ("lid closed") and, during a recording, tell exact digital silence lasting 2 s as a microphone dropout through the existing `microphoneLost` path, so the notice, record and log already promised apply. Alternatives: hide the input while the lid is closed; or only warn in Settings. Implement with engine core tests and Recorder tests.

### 5. Verify and record

- [ ] Focused tests for the changed modules; `pnpm check` since capture and the engine change; a signed-bundle round: a revoked grant (maintainer), a recording on the built-in microphone with the lid closed and one with it open; restore every setting and permission. Update [recording](../docs/system-design/recording.md), [desktop](../docs/system-design/desktop.md) and translations, then close under the plan index.

## Completion

Complete when D1 and D2 are decided and implemented, both cases have run on the signed bundle or been accepted as untested by the maintainer, and the documents and the closure record carry the results.
