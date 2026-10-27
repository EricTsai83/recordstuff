# 097 — The Recording Studio redesigned: choices above the preview, live controls below

[English](097-studio-redesign.md) | [繁體中文](097-studio-redesign.zh-TW.md)

Status: planned; not started. Created: 2026-10-27 at the maintainer's request. Hard dependencies: none open. It reshapes the Studio built by the closed 075 (Studio, camera, Live preview), 090 (the camera's state while recording), 092 (preview rate and view), 094 (the Camera view) and 095 (the toolbar line), the Recording tab's device rows from 074 and 079 (microphone device and level), and what an editable recording (087) records while it runs. Execute in order under the [plan index](README.md). This task writes the plan only. Nothing below has been implemented or verified.

## Goal and current state

The maintainer found the Studio hard to read (2026-10-27). It started with a screenshot: in the Screen only view, while the camera was hidden from the recording, a dashed outline of the camera's bubble still sat over the picture, as if the camera were there.

Current state ([desktop: Recording Studio](../docs/system-design/desktop.md#recording-studio)):

- **Two camera switches with nearly one meaning.** The Camera switch in the Studio's camera panel (`studioCamera`, the same `camera` setting as Recording settings and the tray) is locked while recording. The person icon in the toolbar (`cameraShown`, plan 075's D13) exists only while a recording composes the camera. To a user, both answer "is the camera in my recording".
- **Three preview views, one of them odd.** As recorded, Screen only and Camera only (`STUDIO_VIEWS` in [studio-port.ts](../src/shared/studio-port.ts)). Screen only draws the bubble as a dashed outline that can still be dragged ([ui.css](../src/renderer/ui.css), `[data-view="screen"]`), even while the camera is hidden, because `composed` in [camera.ts](../src/main/settings/model/camera.ts) only asks whether the session has a camera.
- **Five looks for the bubble.** Glass bubble, dashed outline, invisible but draggable (As recorded with the camera hidden), absent, and enlarged (Camera view). A user cannot guess what each means.
- **Device choices live elsewhere.** The screen, the camera device and the microphone device are only in Recording settings. The Studio deliberately left them there ("so each control lives in one place"), so a user who sees a wrong picture or hears nothing in the Studio must leave it to fix it.
- **Problems are said in several places at once.** The camera's state is a line over the stage (plan 090). A missing microphone or display is a row diagnostic in Recording settings. Silence is never said: between sessions the meters rest, and nothing watches a microphone that delivers nothing.
- **Recording without opening anything.** The tray and the shortcut start a recording with the Studio closed. Nothing then says whether the camera or microphone is working, apart from the tray's "Include in recordings" ticks.
- **The recording type is chosen elsewhere, and the Studio does not follow it.** Editable recordings (plan 087, macOS, off by default) are a switch in Recording settings; on Windows that switch is shown unavailable with "Editable recordings are available on macOS only." The tray offers "Start editable recording" for one recording. The Studio looks the same for both types, yet in an editable recording the mutes, the faders and hiding the camera all change the recorded tracks for good (a muted input is silence in its track, the volumes are in each track, a hidden camera's track is black), while the edit view could set all three afterwards ([editing](../docs/system-design/editing.md#editable-recordings)).
- **Mute is read as a monitor mute.** It says "Mute", and a muted input's meter keeps moving (greyed, since it shows the level before the mute). A user who speaks and sees the meter move can believe they are recorded when they are not.

The goal: one Studio layout in which "what will be recorded" and "how it is going" are separate and each obvious; the controls during a recording matching the recording's type; the bubble shown only where the recording shows it; problems said once, where they can be fixed; and the Recording tab kept as the place to check and test devices.

## Requirements (maintainer, 2026-10-27)

1. The Studio is where a user confirms, before and during a recording, that what they record is right. It shows the state of the screen, camera and microphone, so a problem in the middle of a recording is seen at once.
2. The large preview stays. Nothing should need expanding or collapsing to give it room.
3. Choices (which screen, which camera, which microphone) sit above the preview. Live, adjustable or monitoring controls (levels, volume, mute, showing or hiding the camera) sit below it.
4. The Recording tab keeps the screen, camera and microphone choices. It works as a device check: choose a device, see whether it is connected, and test it.
5. No green and yellow status dots. When everything is fine the controls stay quiet. When something is wrong, the control itself says what.
6. A recording started from the tray or the shortcut, with the Studio closed, still lets the user know about problems, and leads them to the Studio to look.
7. The Studio offers the recording type, a plain or an editable recording, and its live controls follow the type: a plain recording has the mutes; an editable recording does not need them.
8. Where editable recordings are not available (Windows), the user sees that when choosing, and why, rather than finding the choice missing.

## Design

The mockups reviewed on 2026-10-27 are summarized here in words. Final spacing and styles follow the production components and tokens, not the mockups.

### One rule for each row

| Row | Holds | While recording |
| --- | --- | --- |
| **Title line** | The title; the view menu; Live preview; ⋯ with Preview rate | Unchanged: these only change what the user watches, never the file |
| **Choices** (above the preview) | The record control; the recording type; Screen, Camera and Microphone pickers | Type, Screen and Camera are locked, with a lock icon. Microphone stays switchable, as plan 079 already allows |
| **Preview** | The picture, the bubble dragged in place | Unchanged |
| **Live row** (below the preview) | Depends on the recording type (below) | Everything it shows stays adjustable |

Removed: the camera panel, the Preview panel and the Audio panel below the stage, and the person toggle in the toolbar. Their controls move into the rows above. The sidebar toggle stays as it is.

### Pickers

- **Screen**: the displays, as Recording settings lists them, and Hide menu bar and Dock.
- **Camera**: an on/off switch at the top of its menu, the devices, then the bubble's shape (Width, Height, Rounding) and Mirror. The shape is chosen before recording and locked with the picker. The bubble's position is still dragged in the preview.
- **Microphone**: an on/off switch, then the inputs, including the system default and a chosen input that is not connected (plan 074's rules stay).

Each picker shows the device's name and nothing else when the device is fine.

### The recording type, and a live row for each

A picker at the start of the choices row, beside the record control, offers:

- **Plain recording**: "Ready to share as soon as it stops."
- **Editable recording**: "Move the camera and set the volumes afterwards in Edit…. Export it before sharing; files are about twice as large."

It is the same `editableRecording` setting as Recording settings' switch, locked while recording. A recording started with the tray's "Start editable recording" shows the editable layout for that recording while the setting stays as it was.

| Live row | Plain recording | Editable recording |
| --- | --- | --- |
| Camera | Show or Hide | Not offered |
| Microphone | Not recorded (its switch), meter, fader | Meter only |
| System audio | Not recorded (its switch), meter, fader | Meter only |
| Below the row | — | One line: "Set the volumes and hide the camera afterwards in Edit…" |

**An editable recording records everything as it comes.** No mute, the volumes at 100% whatever the faders are set to, and the camera never hidden in its track, so each can be set later in the edit view, which already offers volumes, volume stretches and hidden stretches ([editing](../docs/system-design/editing.md#editable-recordings)). The faders' saved values are kept and apply again to plain recordings. Its meters stay, so the user still sees that each input is heard, and no-sound still applies. This removes the editable recording's mute, fader and hide from the engine's path rather than making them reversible.

**A plain recording's mutes say what they do.** The button reads "Don't record" next to the input's name rather than "Mute". While on, the whole input turns to the warning look and says "Microphone not recorded" (or "System audio not recorded"), not only a greyed meter. The tray adds one line while an input is not recorded, so it is seen with the Studio closed.

**Where editable recordings are not available** (Windows, where the engine refuses them: [session.rs](../native/capture/src/win/session.rs)), the type picker is still shown, with Editable recording listed but unavailable and its reason under it: "Editable recordings are available on macOS only." Plain recording stays selected. This follows what Recording settings already does on Windows, so the two say the same. The tray keeps omitting "Start editable recording" there.

### Problems: quiet when fine, the picker says what is wrong

When an input has a problem, its picker changes: warning surface and border, the icon's struck-through form, and the problem in place of the name, for example "找不到 FaceTime HD" or "麥克風沒有收到聲音". Pressing it opens the same menu, where another device can be chosen. No dots, no separate status line in the toolbar.

| Input | Problems said by its picker |
| --- | --- |
| Screen | The chosen display is unavailable; no screen recording permission |
| Camera | No access; the chosen device is not connected; waiting, not ready or dropped out (plan 090's states, moved from the line over the stage) |
| Microphone | No access; the chosen input is not connected; the lid is closed (existing text); no sound (new, below) |

**No sound** is new. While a session runs (Live preview or a recording), the microphone counts as silent when its level stays below a floor for a stretch, not while it is muted or its fader is at 0%. The floor and stretch are D3. Between sessions there is no level, so no-sound is only known with Live preview on or while recording.

The live row's meters keep showing levels as they do now. They do not carry a second warning.

### The camera: one switch, and the bubble only where it is seen

| When | The Camera picker's switch | The live row's Show / Hide (plain recordings only) |
| --- | --- | --- |
| Before recording | Whether this recording takes the camera | Unavailable: nothing is being recorded yet |
| Recording, with the camera | Locked | Shows or hides the camera in the file at once (plan 075's D13) |
| Recording, without the camera | Locked | Unavailable, saying the camera joins from the next recording (existing text) |

In an editable recording the camera is hidden afterwards in Edit…, so the live row has no Show / Hide.

The bubble follows one rule: **it can be dragged only where the preview shows the camera.**

| State | In the preview |
| --- | --- |
| Camera on and its picture shown | The camera itself, draggable |
| Camera on, no picture yet (Live preview off, or the camera starting) | The glass bubble, draggable (today's placeholder) |
| Camera off, or hidden from the recording | Nothing, and nothing to drag |

The dashed outline and the invisible drag target go away.

### Two views

The view menu offers **As recorded** (default) and **Check camera** (today's Camera only, renamed to say what it is for). Screen only is removed. Its one use, seeing what the camera covers, is done by hiding the camera. A stored `screen` view reads as `composed`.

### The Recording tab as the device check

The screen, camera and microphone rows stay in Recording settings and change the same settings as the Studio's pickers. Each row also gives live evidence that the device works:

- **Microphone**: the input level row that exists today (plan 079) stays next to the device.
- **Camera**: a small live picture of the chosen camera beside its device row (D4 decides when it opens).
- **Screen**: the arrangement drawing that exists today. No live capture of the screen here.

Device problems use the same words as the Studio's pickers. "Arrange in Recording Studio…" stays.

### Outside the Studio

- **Tray.** Under "Include in recordings", each input is named with its device, for example "Microphone — MacBook Pro 麥克風". A known problem adds one line under it ("Camera not found"), whose action opens the Studio.
- **Countdown.** When a recording starts with a known problem (a missing device, no access, an unavailable display; not no-sound, which needs a session), the countdown overlay adds one line saying it, so the user can still cancel. With no problem it shows nothing new.
- **During a recording with the Studio closed.** A problem that starts mid-recording (the camera drops out, the microphone goes silent) is said by the tray (D5).

## Decisions

- **D1 — the layout.** Adopted 2026-10-27: choices above, live controls below, no expanding strip, no side panel, no overlay HUD. Recorded so it is not reopened without changed conditions.
- **D2 — status presentation.** Adopted 2026-10-27: no status dots; quiet when fine; the picker says the problem. Live evidence (thumbnails, levels) belongs in the Recording tab's device check, not in the Studio's pickers, where the preview and the live row already show it.
- **D3 — the no-sound rule.** Proposal: peak below −60 dBFS for 10 s during a session, not while muted or at 0%, cleared as soon as the level rises. Checked against step 1's data: a quiet room with a working microphone must never trip it.
- **D4 — the camera's picture in the Recording tab.** Opening the camera turns on its light and costs CPU. Proposal: a "Test camera" button that shows the picture until it is pressed again or the tab is left; never opened by visiting the tab. The alternative is opening it whenever the tab is in sight. Decided before step 5.
- **D5 — a problem during a recording with the Studio closed.** Proposal: the tray only (its line, and the tooltip). A notification is louder and may interrupt the recording's subject on screen. Decided before step 6.
- **D6 — the recording type in the Studio.** Adopted 2026-10-27: the type is chosen in the Studio as well as Recording settings, and the live row follows it. An editable recording records every input at 100%, unmuted, with the camera never hidden in its track; those are set afterwards in Edit…. A plain recording keeps the mutes, faders and Show / Hide, the mutes renamed to say the input is not recorded. Where editable recordings are unavailable, the choice is shown unavailable with its reason, never hidden.

## Steps

- [ ] **0. Start.** Inspect the current tree and the closed plans named above. Start `caffeinate -d -i -t 5400` before the first desktop round, per [AGENTS.md](../AGENTS.md).
- [ ] **1. Model.** In main's settings model: per-input problem states in one place (screen, camera, microphone) used by the Studio, the Recording tab, the tray and the countdown; the no-sound detector over the meters' levels (D3), with tests including quiet-room and muted cases; `composed` and draggability following the bubble rule; the view list reduced to `composed` and `camera`, a stored `screen` reading as `composed`; the camera's on/off and Show/Hide availability per the table above; the recording type group for the Studio (the same setting, unavailable with its reason off macOS) and which live controls each type offers, including a recording started as editable from the tray. Unit tests first.
- [ ] **2. Studio layout.** [studio.tsx](../src/renderer/settings/tabs/studio.tsx): the title line, the choices row with the type picker, the three device pickers and the record control, the live row for each type, the removed panels and person toggle. Pickers reuse the existing Select and switch components. Lock states while recording. The plain recording's "Don't record" switches and their not-recorded look.
- [ ] **2b. Editable recordings record as they come.** In the [recorder](../src/main/recording/recorder.ts) and its actions: for an editable session, send 100% for both inputs instead of the saved volumes, refuse mute and camera-hide requests (tray included: its Hide camera item is not offered for an editable recording), and keep the saved volumes for plain recordings. Tests for both types. The engine's file format does not change.
- [ ] **3. Preview.** [camera-preview.tsx](../src/renderer/settings/tabs/camera-preview.tsx) and [ui.css](../src/renderer/ui.css): the bubble rule; remove the dashed outline and the invisible target; the camera's state moves from the line over the stage to the Camera picker. Check camera keeps today's enlarged camera and its status.
- [ ] **4. Problem presentation.** The pickers' problem look and words; the same words in the Recording tab's rows; translations for every new string.
- [ ] **5. Recording tab device check.** D4 answered. The camera's live picture by D4; the microphone level row kept beside its device; problem words shared with step 4.
- [ ] **6. Tray and countdown.** D5 answered. The tray's device names and problem line with its Studio action; its line while an input is not recorded; the countdown overlay's problem line.
- [ ] **7. Desktop round.** After the "好了" handoff, on a fresh `pnpm start:app` bundle, with the [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md): the Studio before and during a recording, with the camera on, hidden and off; unplugging or denying the camera; a silent microphone with Live preview on; starting from the shortcut with a missing camera (the countdown line); the tray's lines. A plain recording with an input not recorded for a stretch, and an editable recording with the microphone fader saved at 50%: the plain file is silent there, and the editable file's microphone track is at its incoming level (media verification) and its live row offers no mute, fader or hide. Restore settings, close the app and confirm its processes exited.
- [ ] **8. Document and close.** Rewrite [desktop: Recording Studio](../docs/system-design/desktop.md#recording-studio) (it says device choices stay out of the Studio; that is reversed), [recording](../docs/system-design/recording.md) and [editing](../docs/system-design/editing.md) (an editable recording ignores the volumes, mutes and camera hiding while it records), [design decisions](../docs/system-design/decisions.md) (D1, D2, D6 and the removed Screen only view), the function reference, translations, help and README text if they describe the Studio, the verification record and the plan index.

## Verification

Selected by the [testing policy](../docs/testing.md) when each step lands:

- Steps 1–4: `pnpm test:scope -- studio recording-settings tray countdown` (Studio, Recording tab controls, tray model, countdown overlay), plus `layout` when shared components change. New behavior tests: the bubble rule per state, the view migration, the no-sound detector, lock states, and each picker's problem state. UI tests assert behavior and accessibility only, never design values.
- Step 2b: `pnpm test:scope -- recording` for the recorder's per-type volumes, mutes and hiding.
- `pnpm check`, because the settings model, the recorder, the tray and the countdown change together.
- `pnpm measure:cpu` if the no-sound detector or the camera test adds a timer or keeps a capture alive (the CPU row of the testing policy).
- Step 7's desktop round as above. Step 2b changes what an editable recording records, so the recording row of the testing policy applies: a recording smoke round (start, stop, save, media verification, playback) for each type, with the cases above. Capture, encoding and the file format do not change, so no recording matrix.
- Report separately: automated results, what the desktop round observed, and what stayed unverified (Windows is checked by CI only; external cameras and USB microphones only if connected).

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure. D3 is settled in step 1, D4 before step 5, D5 before step 6. No commit, push, PR or release is part of this plan unless requested.
