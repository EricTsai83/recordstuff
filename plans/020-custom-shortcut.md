# 020 — Custom recording shortcut

[English](020-custom-shortcut.md) | [繁體中文](020-custom-shortcut.zh-TW.md)

Status: not started; design proposed, nothing implemented. Priority: after 019. Created: 2026-09-21.

## Problem and outcome

Settings → Shortcut offers four presets and Off (016, [desktop design](../docs/system-design/desktop.md#recording-shortcut)). A preset is a guess about a keyboard the maintainer cannot see: the user's own apps, launcher, window manager or keyboard layout may already own all four, and a global shortcut wins over the frontmost app, so the app that loses is the one the user is actually typing in. Today the only remedy is Off.

Let the user record their own combination in Settings, with the same guarantees the presets already have: the choice survives a relaunch, a combination the OS refuses is reported rather than silently inert, and nothing about the shortcut can block starting, stopping or saving a recording. Scope is the supported macOS app and the single start/stop toggle; other platforms keep working without a claim of acceptance.

## Design decisions

### Presets stay, Custom joins them

The preset list is the quick path and the compatibility guarantee — every accelerator ever offered stays in [`HOTKEY_PRESETS`](../src/shared/hotkey.ts), so nobody's saved choice disappears. Custom is an addition to that group, not a replacement, and Off keeps remembering the last accelerator so re-enabling restores it. The default does not change.

### An accelerator is validated, never trusted

Storage widens from the preset union to a string, so the validator becomes the boundary. `isAccelerator` accepts exactly: one or more modifiers drawn from `CommandOrControl`, `Control`, `Alt`, `Shift`, at least one of which is `CommandOrControl` or `Control`, followed by exactly one non-modifier key from a named set (A–Z, 0–9, F1–F24, Space, the four arrows, and the punctuation Electron documents). It rejects modifier-only strings, bare keys, two keys, unknown names, duplicate modifiers and anything over 64 characters.

Requiring a Command/Control modifier is not politeness: a global shortcut on a plain key takes that key away from every app on the system, including the field the user types the next sentence into. Recording is normalized to one canonical order — `CommandOrControl`, `Control`, `Alt`, `Shift`, key — so the same physical combination always produces the same stored string and comparisons stay string comparisons. ⌘ records as `CommandOrControl` rather than `Command`, so a stored custom value still means something on a platform with no Command key.

A small hard-reserved list (`CommandOrControl+Shift+3/4/5/6`, `CommandOrControl+Space`, `CommandOrControl+Tab`, `CommandOrControl+Q`) is rejected with a reason. It is deliberately short: anything else macOS actually owns fails registration and is already reported through the existing failure path.

Every current preset must pass the validator, checked by a test. Settings reading stays lenient exactly as it is: an unrecognized value falls back to the default with the existing warning, which is also what happens to a future value read by an older build.

### The panel gains one value-carrying control

The settings panel is a projection that echoes ids back ([settings-panel.ts](../src/shared/settings-panel.ts)), and a recorded combination is a value, not an id. Rather than open a general free-text channel, the shortcut group gains `kind: "shortcut"`: for that one group `choose(group, choice)` may carry a candidate accelerator, and [`settingsAction`](../src/main/settings-model.ts) builds the action only after re-validating and canonicalizing it against the same shared validator. The renderer still cannot describe work main does not offer — it can only propose a string that main independently accepts or refuses — and a refusal reports through the existing `applied: false` path plus a note saying which rule failed.

### The registered shortcut is suspended while a new one is recorded

While the capture field is armed, the currently registered accelerator is still live at OS level: pressing it to re-record it would start a recording instead. `RecordingHotkey` therefore gains `suspend()` / `resume()` — the registration is released while keeping the settings, and it is restored when the capture commits, is cancelled, the window blurs or closes, a timeout elapses, or the app quits. Capture is offered only while preferences are unlocked, so no recording exists to be disturbed in the first place.

### A refused registration stays saved and inert

Current behavior is kept: the setting is saved, `apply` has already released the previous accelerator, and the note plus notification say the shortcut does nothing. Custom values make refusals more likely, which is an argument for saying so clearly, not for quietly keeping a different combination alive than the one the panel shows.

### Escape and the OS keep what they own

Escape cancels the capture, so it cannot be bound. ⌘Tab, ⌘Q and the Spotlight combination are consumed by macOS before the renderer sees them; the field simply never records them, and the reserved list gives the same answer for the ones that do arrive. Keys are read from `event.code` for the `Key*`, `Digit*` and `F*` ranges so a non-QWERTY layout records the key that was physically pressed; whether that matches what Electron registers on such a layout is a native acceptance question, not a unit-test one.

## Expected experience

- Settings → General → Shortcut lists the presets, Off, and Custom…. Choosing Custom… arms a capture field that reads "Press a combination" and shows each modifier as it is held.
- The first non-modifier key commits the combination: the field shows ⌘⌥⇧R form, the setting saves, and the OS registration follows. Escape, clicking elsewhere, or closing the window cancels and leaves the previous shortcut untouched and re-registered.
- A combination that fails a rule is not saved and says why in one line: a shortcut needs ⌘ or ⌃, this key cannot be used, or macOS reserves this combination.
- A combination the OS refuses keeps the existing report: the choice stays selected, the note says another app is using it, and a notification says the same.
- The tray menu and logs show the custom combination in the same symbol form as a preset, including keys the presets never used — Space, F-keys and arrows.
- The whole group is locked during a capture, like every other recording preference, and no shortcut state ever blocks saving.

## Implementation order

### 1. Shared validation and presentation

- [ ] Add `isAccelerator`, canonicalization, the allowed key set and the reserved list to [shared/hotkey.ts](../src/shared/hotkey.ts); widen `HotkeySettings.accelerator` to a validated string and keep `HOTKEY_PRESETS` as the offered list.
- [ ] Extend `describeAccelerator` with display names for Space, F1–F24, arrows and punctuation on macOS and elsewhere.
- [ ] Tests: every preset passes; modifier-only, bare key, two keys, unknown key, duplicate modifier, over-length and reserved values are rejected; canonical order is stable; display strings on both platforms.

### 2. Storage

- [ ] Point [settings.ts](../src/main/settings.ts) at the new validator, keeping the lenient read and the existing warning for unrecognized values.
- [ ] Tests: custom value round-trips, a legacy preset is untouched, a garbage value falls back to the default with the warning.

### 3. Main model and shortcut lifetime

- [ ] Add `kind: "shortcut"` to [settings-panel.ts](../src/shared/settings-panel.ts) and the Custom… choice, capture state and rejection note to [settings-model.ts](../src/main/settings-model.ts); validate candidates in `settingsAction`.
- [ ] Add `suspend()` / `resume()` to [hotkey.ts](../src/main/hotkey.ts) and wire arm/disarm, window blur, window close, timeout and quit in [index.ts](../src/main/index.ts).
- [ ] Tests: a valid candidate yields `setHotkey`, an invalid one yields no action, the group is locked while recording; suspend releases and resume restores, including with a deferred request pending and on dispose.

### 4. Renderer capture control

- [ ] Add the capture field to [renderer/settings.ts](../src/renderer/settings.ts) and [settings.css](../src/renderer/settings.css): arming, live modifier display, commit on the first non-modifier key, Escape and blur cancel, `aria-live` announcement, keyboard reachable without a mouse.
- [ ] Tests for arm, record, cancel and the disabled-while-locked state.

### 5. Messages

- [ ] Add every new string to [i18n.ts](../src/shared/i18n.ts) in English and Traditional Chinese, with consistent placeholders.

### 6. Tooling and documentation

- [ ] Teach `acceleratorToKeystroke` in [scripts/lib/acceptance.mts](../scripts/lib/acceptance.mts) the keys a custom shortcut can now use, or fail with a message naming the shortcut it cannot type; `pnpm acceptance` must stay runnable for a user who has changed the shortcut.
- [ ] Update [desktop design](../docs/system-design/desktop.md#recording-shortcut) and its [translation](../docs/zh-TW/system-design/desktop.md#錄影快捷鍵), which currently state that a free-form recorder is out of scope.
- [ ] Run `pnpm check` and `git diff --check`.

### 7. Verify behavior

- [ ] Record a custom shortcut in the panel, confirm `hotkey: registered …` in the log, then press it while another app is frontmost and complete start → stop → save → playback. Use the [native computer-use acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) with `pnpm start:app`; check for a user recording in progress before rebuilding or quitting.
- [ ] Confirm pressing the currently registered shortcut while the capture is armed records it and does not start a recording, and that cancelling restores it.
- [ ] Confirm a deliberately conflicting combination produces the note and the notification, and that the saved choice survives a relaunch.
- [ ] Run `pnpm acceptance` with a custom shortcut in place.
- [ ] Check one non-US keyboard layout, or record it as untested.
- [ ] Record what was actually tested and what was not in the [verification record](../docs/verification/README.md).

## Completion and boundaries

No commit, push, tag or publication is authorized by this plan. Out of scope: shortcuts for anything other than start/stop, key sequences or chords, per-source or per-quality shortcuts, a database of other apps' shortcuts, changing the default accelerator, and any claim of Windows or Linux acceptance. Do not reset a user's saved shortcut to create a test fixture.

On completion, move the durable conclusions into [desktop design](../docs/system-design/desktop.md) and the [verification record](../docs/verification/README.md), then follow [plan completion](README.md#completing-a-plan).

## Technical references

- [Electron: Accelerator](https://www.electronjs.org/docs/latest/api/accelerator): the modifier and key-code vocabulary the validator must stay inside.
- [Electron: globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut): registration, refusal and release semantics.
- [MDN: KeyboardEvent.code](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code): layout-independent physical key identity for the capture field.
- [Apple: Mac keyboard shortcuts](https://support.apple.com/en-us/HT201236): the system-owned combinations behind the reserved list.
