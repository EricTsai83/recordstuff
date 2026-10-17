# 079 — Microphone controls: a level meter, finding devices, switching while recording

[English](079-microphone-controls.md) | [繁體中文](079-microphone-controls.zh-TW.md)

Status: planned; not started. Created: 2026-10-17, from 078's desktop round at the maintainer's request ("可以放在之後做"). Priority: the maintainer orders it; after 075 unless placed earlier. Hard dependencies: 074's microphone (closed) and 078's HAL capture and device check (closed, [record](../docs/verification/history-2026-10.md#plan-078-closure--2026-10-17)). Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Let users check and manage the microphone from Settings without recording a test take: see whether the chosen input hears them, find an input that was just connected, and decide whether a microphone may be changed during a recording. Success is: an input level meter beside the device picker that moves with the chosen input's sound; a device list that follows connections and a Search for devices button; and the maintainer's decision on switching while recording, built if adopted.

Out of scope: voice processing, gain or noise controls (074 records the raw microphone at unity gain), a lost microphone replaced by another automatically (the maintainer decided against it on 2026-10-17: the same device is taken back), and Windows hardware rounds (CI only).

## Current state

- **No way to check the input.** Settings lists inputs and stores a choice; nothing shows whether it hears anything until a recording is played back. During 078's round the maintainer asked for a meter to check the microphone.
- **A stale list.** The list is read by a short-lived capture process when the Settings window is activated or the switch is turned on, never on its own. A FreeClip 2 headset connected while Settings was in front did not appear until the window was activated again, and then took a moment while macOS listed its microphone ([recording](../docs/system-design/recording.md#audio)).
- **No switching while recording.** A session keeps the microphone chosen when it was created; a choice made during a recording applies to the next one. The engine can already close the HAL unit and open another device by UID (078's reconnection), so switching is mostly main-to-engine plumbing and a seam in the track.

## Steps

### 1. Decide behavior

- [ ] **D1 The meter.** Recommended: a horizontal level bar under the Input device picker, shown while the Microphone switch is on and Settings is open in idle, reading the chosen input in the engine's listing process (the HAL on macOS, WASAPI on Windows) and sending peak and RMS about 20 times a second; stopped when the window closes or loses focus, when a recording starts, and while permission is missing (the card's guidance instead). Alternatives: a Test button that listens for a few seconds; a renderer `getUserMedia` meter (another capture path and permission prompt in Chromium). Basis: no recording needed, and the meter uses the engine's own capture so it shows what a recording would hear.
- [ ] **D2 Finding devices.** Recommended: the list follows connections on its own (CoreAudio's `kAudioHardwarePropertyDevices` listener, `IMMNotificationClient` on Windows, in the listing process while Settings is open), plus a Search for devices button beside the picker that lists again at once, as a fallback. Alternatives: the button only; polling while Settings is open.
- [ ] **D3 Switching during a recording.** The maintainer decides whether a user may change the input device while recording. Recommended if adopted: the picker stays enabled while recording, the engine closes the current unit and opens the new device, the gap is left as silence by the aligner, the log and saved record name both devices, and a failure to open the new one keeps the old one. Otherwise: the picker shows that a change applies to the next recording.

### 2. Build

- [ ] The meter per D1: an engine command that streams levels from the chosen input in the listing process, main relaying them to the Settings renderer, the bar in the Recording tab's Audio section with the production components, its strings in both languages, and `role="meter"` with the level as its value.
- [ ] Device changes per D2: the listener in the listing process, a list refreshed without activating the window, and the button with its busy state.
- [ ] Switching per D3, if adopted: a `microphone` message from main to the running engine, the reader reopening by the new UID, and the seam and record.

### 3. Verify and document

- [ ] Unit tests for the level computation and the list updates; background UI cases for the meter, the button and (if built) the picker while recording; Windows checked by CI.
- [ ] A desktop round on the signed bundle: the meter moves with speech and stays still on a silent input; a Bluetooth headset connected and disconnected while Settings is in front appears and leaves without activating the window; CPU of an open Settings with the meter; switching during a recording if built.
- [ ] Record the outcome in [recording](../docs/system-design/recording.md), [desktop](../docs/system-design/desktop.md) and the verification record, with translations.

## Completion and verification boundaries

Complete when each step is done or the maintainer has accepted its outcome. Engine and UI changes follow [the testing policy](../docs/testing.md#select-tests-from-behavior); desktop rounds follow the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing). Writing this plan needs only links, English/Chinese parity and `git diff --check`.
