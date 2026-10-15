# 077 — Hands-on acceptance of the native capture engine

[English](077-native-hands-on-acceptance.md) | [繁體中文](077-native-hands-on-acceptance.zh-TW.md)

Status: planned; not started. Created: 2026-10-16, from 076's step 7 at the maintainer's request ("記下來，之後做"). Priority: proposed right after 076; the maintainer orders it. Hard dependencies: 076, whose native engine these cases exercise. Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Finish the macOS acceptance of the native capture engine (076) for the cases a runner cannot stage alone, because each needs the maintainer's hands or a change to the machine that agents may not make: putting the Mac to sleep, unplugging a display, revoking the screen-recording permission, and showing the Dock. Success is: each case is run on the signed bundle through the native engine, its outcome recorded against what [recording](../docs/system-design/recording.md) promises (a saved file and the right notice for sleep and a removed display, the permission card for a denial, a recording without the Dock with D6 on), and each settings or permission change put back.

Out of scope: Windows (CI only, as 076's D8 says), any engine change (a defect found here becomes its own plan or a fix the maintainer approves), and the cases 076's runners already cover (recording quality, CPU, tray, lifecycle fixtures, quit while recording and own windows, which 076 adds to `pnpm acceptance`).

## Current state

- 076 recorded the native engine's recording quality, CPU baseline and tray cases on 2026-10-15 and 2026-10-16 ([076's closure record](../docs/verification/history-2026-10.md#plan-076-closure--2026-10-16)); these four cases were left for later at the maintainer's word.
- The Chromium path handled sleep (plan 050), display removal and permission denial; the native engine maps its failures to the same `HostErrorCode`s, but none of these four has run through it on hardware.
- The maintainer's Dock appears to be hidden automatically, so 076's D6 round showed no Dock in either recording.

## Steps

### 1. Sleep during a recording

- [ ] With a recording running through the native engine, the maintainer puts the Mac to sleep (Apple menu → Sleep, or closing the lid where the display allows). Expected per plan 050: the recording stops and saves before sleep, the saved notification appears after wake, and no sentinel is left. Watch for a known risk found in 076's documentation: the engine ignores capture failures only once its drain to the stop has ended (up to 250 ms), so a stream that ends inside the drain still reports `capture_failed` and fails the stopping session. Record the log's stop and save lines and the file's integrity (`pnpm verify`).

### 2. Display removal during a recording

- [ ] With a recording of an external display running, the maintainer unplugs that display. Expected: main sees the display leave (`target_removed`; the native host never sends the Chromium path's `track_ended`) and ends the session with the display failure, the partial is kept or saved as recording.md says, and the next recording on the remaining display works. Reconnect afterwards.

### 3. Permission denial

- [ ] The maintainer turns RecordStuff off in System Settings → Privacy & Security → Screen & System Audio Recording, then starts a recording. Expected: no capture, the permission card and notice as today, `permission_denied` in the log, no empty file. The maintainer turns the permission back on and confirms the next recording works (a relaunch may be needed, as recording.md says).

### 4. D6 with the Dock visible

- [ ] With the Dock shown (the maintainer turns off automatic hiding for the round, or the round runs on a machine that shows it), record once with Hide menu bar and Dock off and once on. Expected: the Dock in the first recording's frames, absent from the second's; the maintainer puts the Dock setting back.

### 5. Record

- [ ] Write the results, with the evidence paths and what each case's setting change was and how it was undone, into the verification record and 076's or its successor's closure; list any case left unrun as untested.

## Completion and verification boundaries

Complete when each case has run on the signed bundle or the maintainer has accepted it as untested, the results are recorded with their evidence, and every setting and permission the round changed is back as it was. Each case is a desktop round under the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing); the maintainer performs the hardware and System Settings actions, agents never change TCC or system settings. Writing this plan needs only links, English/Chinese parity and `git diff --check`.
