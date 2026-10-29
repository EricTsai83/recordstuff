# 101 — A System audio switch beside Microphone and Camera

[English](101-system-audio-switch.md) | [繁體中文](101-system-audio-switch.zh-TW.md)

Status: planned; not started; decisions D1–D6 proposed, to be answered by the maintainer before step 1. Created: 2026-10-29 at the maintainer's request, from the question of how a person picks what a recording includes each time. Hard dependencies: none open. It builds on the closed 074 (the microphone switch and the tray's inputs), 075 (the camera switch, per-recording mutes and faders), 087 and 098 (editable recordings and their tracks) and 097 (the inputs' names and problems in the tray). Execute in order under the [plan index](README.md). This task writes the plan only. Nothing below has been implemented or verified.

## The problem today

A recording always captures system audio. What a person can choose before recording, and where:

| Choice | Tray (Include in recordings) | Recording Studio | Recording settings |
| --- | --- | --- | --- |
| Microphone on or off | ✓ | ✓ | ✓ |
| Camera on or off | ✓ (when a camera is available) | ✓ | ✓ |
| System audio on or off | — | only during a session: Don't record, for that recording | — |

So screen with system audio only, screen with both, and screen with the camera are each one tick away in the tray, but **screen with the microphone only** (a narrated walkthrough without notification sounds, music or a video call's audio) has no choice before recording. The ways around it are poor: the System audio volume at 0%, a setting that silently stays for every later recording until moved back, or Don't record in the Studio after a session starts, which a recording started from the tray or the shortcut never offers in time.

The goal: one System audio switch, beside Microphone and Camera wherever they are offered, so every combination of the three inputs is chosen the same way, before recording.

## What the engine already does

- `SystemAudio::Off` exists in the engine on both platforms ([core](../native/capture/src/core/mod.rs)): on macOS no audio filter is built and the core has one input fewer ([session.rs](../native/capture/src/mac/session.rs)); on Windows no process loopback is opened ([win/session.rs](../native/capture/src/win/session.rs)). The macOS live test records a `microphone-only` case.
- A recording with no sound input at all gets a silent track as long as its video (core test `a_recording_without_any_sound_gets_a_silent_track_as_long_as_its_video`), so players and the edit view still see a sound track.
- An editable recording's description lists its sounds (`system`, `microphone`, `silent`; [editable.ts](../src/shared/editable.ts)), so a file without the system's track is already describable.
- Main never asks for `off` today, except through the development switch `RECORDSTUFF_CAPTURE_AUDIO=off` ([native-host-process.ts](../src/main/recording/native-host-process.ts)).

The work is therefore mostly main, settings and UI; the engine paths need confirming, not building.

## What the industry does

Loom, CleanShot X, Cap and Camtasia each let the person choose, before recording, whether system audio and the microphone are recorded, as independent toggles in the place recording starts; OBS does it with sources in a scene. None hides the choice behind a volume. This is the agent's knowledge of those products, not re-checked against their current documentation on 2026-10-29; step 0 records sources if the design rests on a detail. It matches the tray's Include in recordings, which already lists Microphone and Camera.

## Design (proposed)

- **One switch, `systemAudio`, on by default**, stored in settings as a boolean. A file without the field reads as on, silently, so existing users record as before; no settings version change (as 099's fields were added).
- **Wherever Microphone is offered, System audio is too, first:** the tray's Include in recordings (System audio, Microphone, Camera), the Recording Studio's inputs, and Recording settings. Locked while a countdown or recording runs, as Microphone is.
- **Off means not captured**, not captured and muted: `start` carries `systemAudio: false` and the capture process asks the engine for `SystemAudio::Off`. No permission prompt is involved: system audio needs none beyond screen recording.
- **The Studio follows it.** With the switch off, the System audio row and its fader are not shown before or during a session, as the Microphone row is not shown while its switch is off; a held Live preview is prepared again when the switch changes, as for the microphone. Don't record stays the per-recording choice for an input that is captured.
- **An editable recording without system audio** has the microphone's track, or a silent one with neither, and the edit view shows only the inputs the file has.

## Rejected alternatives

- **Global shortcuts that toggle an input.** Global shortcuts are few and collide with other apps, and a toggle pressed blind gives no sight of the result: a person learns the camera was off after recording. OBS's scene hotkeys work because its preview is always visible; RecordStuff has no visible state before recording besides the tray menu. Revisit as optional, unassigned shortcuts only if users ask.
- **Recording modes** (Screen and camera, Screen only, …). Three independent switches already are the choice; a mode layer on top would duplicate them and need rules for when the two disagree.
- **System audio at 0% as the way to leave it out.** It is a lasting setting, not a choice per recording, and the sound is still captured.

## Decisions (proposed by the agent, 2026-10-29; to be answered by the maintainer)

- **D1 — placement:** the tray's Include in recordings, the Recording Studio and Recording settings, System audio listed first. Alternative: the tray and the Studio only.
- **D2 — default on**, also for existing users, so nothing changes until someone turns it off.
- **D3 — locked while recording**, as Microphone; the Studio's Don't record remains for the recording in progress.
- **D4 — neither sound is allowed**, with no warning: the file keeps a silent track. Alternative: a line under Include in recordings saying the recording will have no sound.
- **D5 — Windows too**, checked by CI only, as every Windows change.
- **D6 — no new shortcuts and no modes** (the rejected alternatives above).

## Steps

0. **Confirm the engine paths** before any UI: on macOS, record with `RECORDSTUFF_CAPTURE_AUDIO=off` plain and editable, with and without the microphone; check the tracks with `ffprobe`, the edit view's rows and an export of the editable ones, and the Live preview. Stop and report if a path fails.
1. **Settings and protocol:** the `systemAudio` field and `setSystemAudio` action (saved, locked while recording, ignored where unavailable); `NativeStart.systemAudio`; the capture process maps it to `off`, the development switch still winning.
2. **The surfaces:** the tray item with its problem line rules, the Recording settings row, the Studio's inputs (rows, faders, the Live preview's inputs), strings in English and Traditional Chinese, icons.
3. **Editable recordings and the edit view**, as step 0 found needed.
4. **Documentation:** README (both languages), the website's settings table, [recording](../docs/system-design/recording.md#audio), [desktop](../docs/system-design/desktop.md) and [decisions](../docs/system-design/decisions.md), in both languages.
5. **Desktop round** after the maintainer's “好了”, recording only what the cases need ([testing](../docs/testing.md#environment-and-shared-machine-use)): the tray's switch and its lock; system audio off with the microphone on (a tone played through the speakers, measured absent from a plain recording's track, the voice present); both off (a silent track as long as the video); an editable recording without the system's track opened in the edit view and exported.
6. **Closure** under the plan index.

## Verification

Focused scopes for settings, tray, Studio, recording and editing ([testing policy](../docs/testing.md#select-tests-from-behavior)), `pnpm check` for the recording path's change, and the desktop round of step 5. Windows: CI only.

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure. D1–D6 must be answered before step 1; a failure in step 0 pauses the plan for the maintainer. No commit, push, PR or release is part of this plan unless requested.
