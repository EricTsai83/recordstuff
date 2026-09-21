# 021 — Choose which screen to record

[English](021-screen-selection.md) | [繁體中文](021-screen-selection.zh-TW.md)

Status: not started; design proposed, nothing implemented. Priority: after 020; independent of 019 and 020 apart from shared edits in [settings-model.ts](../src/main/settings-model.ts) and [i18n.ts](../src/shared/i18n.ts). Created: 2026-09-21.

## Problem and outcome

`chooseDisplayMedia` always resolves the primary display and falls back to the first screen source ([index.ts](../src/main/index.ts), [recording design](../docs/system-design/recording.md#start)). On a machine with a second display that is a policy, not a preference: everything worth recording has to be dragged onto the primary display first, and the app gives no hint that the other screen exists. The app already knows how to capture any screen source — the one it picks is hard-coded.

Let the user choose the target display in Settings → Recording. The choice survives a relaunch, survives a reconnect wherever the platform allows it to be identified, and a choice that can no longer be resolved refuses the start with a stated reason instead of silently recording a different screen. Scope is whole displays on the supported macOS app with the existing audio policy unchanged; other platforms keep working without a claim of acceptance. Window capture, region capture and recording two displays at once stay out of scope (see [boundaries](#completion-and-boundaries)).

## Design decisions

### The default is "Primary display", and it is not a stored display id

`{ kind: "primary" }` is the default and resolves through the current code path: the primary display's id, falling back to the first screen source. A user who never opens the setting sees no change at all — same source, same log line, same unattended acceptance run — and a user whose monitor arrangement changes keeps recording whatever macOS currently calls primary. This is the choice that cannot go stale, which is why it is the default and why every new failure path below is reachable only by someone who deliberately left it.

### A specific choice stores a fingerprint, not only an id

On macOS `Display.id` is a CGDirectDisplayID: stable while the display stays attached, not promised across a reconnect, a reboot or a dock change. Storing only the id would quietly lose the user's choice every time the monitor is unplugged, and the app would fall back to a different screen without either party noticing.

A specific choice therefore stores `{ kind: "display", id, label, width, height }` and is resolved at each start, in this order: the display whose id matches; otherwise exactly one display whose `label`, `width` and `height` all match; otherwise unresolved. The second rule is what survives a reconnect. It deliberately refuses to guess when it is ambiguous — two identical external monitors match each other, so within a session the id rule already answers, and after a reconnect the app says it cannot tell rather than picking one. Which rule matched is logged with the chosen display, so a recording of the wrong screen can be explained after the fact.

### A choice that cannot be resolved refuses the start

New error code `display_unavailable`. The app does not substitute another screen: `ensureWritableDir` already establishes that a failure "never silently selects a different folder" ([recording design](../docs/system-design/recording.md#start)), and a recording of the wrong screen is worse than no recording, because the user finds out after the meeting. The refusal reaches the user the way every other start failure does — the denial reason is recorded in `lastDenialReason`, mapped by `mapHostError`, logged, and shown as a notification — plus a note in the settings panel that keeps the stale choice selected and says the screen is not connected, exactly as a shortcut the OS refused keeps its selection and says it is inert ([desktop design](../docs/system-design/desktop.md#recording-shortcut)).

### Selection becomes a pure function with tests, outside index.ts

The display-media handler is the only code path that starts a real capture and it has no unit tests today, because it lives in `index.ts` with `app`, `screen` and `session`. The choice moves to `src/main/display-source.ts`: `selectScreenSource({ sources, displays, primaryDisplayId, preference })` returning the chosen source and the rule that matched, or the reason it resolved to nothing. `index.ts` keeps the callback plumbing, the deny helper and the `getSources` error mapping.

The existing behaviors are preserved verbatim and pinned by tests, not re-derived: no source matching the primary id falls back to the first source, an empty source list is `no_display`, and a throwing `getSources` is `permission_denied` on darwin and `no_display` elsewhere. Electron documents `display_id` as possibly empty; where no screen source reports one, a specific choice is unresolved and says so, while `primary` still works through the first-source fallback.

### The panel lists displays from the Screen API, not from desktopCapturer

`screen.getAllDisplays()` is synchronous, needs no capture permission and prompts nothing, so `settingsView` stays a pure projection of (state, context) and opening Settings never touches the capture stack or asks macOS for anything. `desktopCapturer` is consulted only when a recording starts. The gap between the two lists is not hidden: a display the panel offered and capture cannot see is the `display_unavailable` case above.

### The renderer still only echoes an id

Each choice in the new group is built from the live display list, so the action main authorizes already carries the whole fingerprint it will store; the panel sends back a display id string and nothing else. This group needs no value-carrying channel like the one 020 proposes for a recorded accelerator, and `settingsAction` keeps resolving ids against a freshly built model.

### A changing display set refreshes both projections

`screen` emits `display-added`, `display-removed` and `display-metrics-changed`. Each one calls `refreshUi()` while the recorder is settled, so an unplugged monitor disappears from the panel and a stale choice grows its note without the window being reopened. Mid-recording events change nothing: the snapshot the session started with is the session's source.

### No tray submenu, but the tray names a non-default target

[tray-model.ts](../src/main/tray-model.ts) builds no submenus by design, and a per-display list cannot be a flat menu. The choice therefore lives only in Settings. The risk that creates is a user who forgets the setting and records an idle second screen, so when the preference is not `primary` the idle tray's first line reads `Ready — <display label>`. With the default it stays `Ready`, so the tray of a user who never touched the setting is byte-identical to today's.

### Not the system picker

`useSystemPicker` (macOS 15+, experimental) would hand the choice to Apple's own picker and delete this plan's UI, but the Electron documentation is explicit that the handler is then not invoked — and the handler is where `audio: "loopback"` and every audio decision this app is built around lives ([audio design](../docs/system-design/audio-quality.md)). Trading the app's measured audio policy for a free picker is not a trade this app can make. Reconsider only if Electron lets the system picker coexist with an application-chosen audio source.

### A display that disappears mid-recording is already handled

The video track ends, the host reports `capture_failed` ("capture source ended"), and the partial file is kept. That path exists and is unchanged; it is stated here so the plan does not invent a second one.

## Expected experience

- Settings → Recording gains a Screen control listing `Primary display` first, then each connected display by name — `Built-in Retina Display — 3456×2234 (Primary)`, `Studio Display — 5120×2880` — with a note saying the recording captures one whole screen and that system audio is unaffected by the choice.
- The default is Primary display. Changing the choice saves immediately, like every other recording preference, and is locked while starting, recording or saving.
- Connecting or disconnecting a display updates the list while the window is open. A disconnected display that is the stored choice stays selected and the note says it is not connected and cannot be recorded.
- Starting a recording with an unresolvable choice does not record: the log says which stored display could not be matched, a notification says the chosen screen is unavailable, and the tray returns to idle. Choosing Primary display or a connected display recovers without a relaunch.
- A recording started on a non-primary display shows that display's content, at that display's size, with the same quality settings, and the start log line names the display and the rule that matched it.
- With the default choice, the tray, the log line and `pnpm acceptance` behave exactly as they do today.

## Implementation order

### 1. Shared preference and vocabulary

- [ ] Add `src/shared/display.ts`: `DisplayPreference`, `DEFAULT_DISPLAY_PREFERENCE` (`{ kind: "primary" }`), `isDisplayPreference`, a `DisplayInfo` shape (`id`, `label`, `width`, `height`, `internal`, `primary`) and the label builder both projections use, including the fallback when `Display.label` is empty.
- [ ] Add `display_unavailable` to `ERROR_CODES` in [state.ts](../src/shared/state.ts).
- [ ] Tests: the guard accepts both kinds and rejects a missing id, a non-string id, non-finite sizes and an unknown `kind`; labels are stable for an unnamed display and mark the primary one.

### 2. Storage

- [ ] Read `display` leniently in [settings.ts](../src/main/settings.ts) with `DEFAULT_DISPLAY_PREFERENCE` and a warning for an unusable value, and add `setDisplay`. No `SETTINGS_VERSION` bump: `updates` and `notifications` set the precedent that a field added after the fact is read leniently rather than versioned.
- [ ] Tests: a primary and a specific value round-trip, a garbage value falls back with the warning, a version 1–3 file without the field takes the default, and an unrelated setting's save does not drop the display choice.

### 3. Source selection

- [ ] Add `src/main/display-source.ts` with `selectScreenSource` and wire `chooseDisplayMedia` in [index.ts](../src/main/index.ts) to it, including the `display_unavailable` denial and a start log line naming the display, its id and the matching rule.
- [ ] Tests: primary resolves by display id; primary with no id match falls back to the first source; a stored id matches; a reconnected display matches by label and size; two identical displays after a reconnect are unresolved; an empty source list is `no_display`; sources without `display_id` leave a specific choice unresolved while primary still works.

### 4. Panel and tray

- [ ] Extend `AppContext` in [ui-model.ts](../src/main/ui-model.ts) with `displays` and `display`, add `{ setDisplay: DisplayPreference }` to `AppAction`, and fill both from `screen.getAllDisplays()` in `appContext()`.
- [ ] Add the `screen` group to [settings-model.ts](../src/main/settings-model.ts) on the recording tab (its tab list is id-based and must include it), with the not-connected note and the same lock rule as quality.
- [ ] Show the non-default target in the idle tray line in [tray-model.ts](../src/main/tray-model.ts) and add the `display_unavailable` notification message to [tray.ts](../src/main/tray.ts).
- [ ] Tests: the group lists primary plus every display with the stored one checked; a stored display that is absent stays checked and carries the note; the group is locked while recording; `settingsAction` returns the full fingerprint for a listed id and nothing for an unknown one; the idle tray line is unchanged for `primary` and names the display otherwise.

### 5. Main wiring

- [ ] Handle `setDisplay` in `handleAction` (settled check, persist, log, refresh, write-failure notification) and subscribe to `display-added`, `display-removed` and `display-metrics-changed` to `refreshUi()` while settled; release the listeners on `will-quit`.

### 6. Messages

- [ ] Add every new string to [i18n.ts](../src/shared/i18n.ts) in English and Traditional Chinese with consistent placeholders: the group label, the note, the not-connected note, the tray idle line and the `display_unavailable` notification.

### 7. Documentation

- [ ] Update [recording design](../docs/system-design/recording.md) (start step 4 and the error table), [desktop design](../docs/system-design/desktop.md) (settings window), the main-process row in [webrtc.md](../docs/system-design/webrtc.md) that states main selects the primary display, and all three [zh-TW](../docs/zh-TW/system-design/) mirrors.
- [ ] Run `pnpm check` and `git diff --check`.

### 8. Verify behavior

- [ ] With the default choice: start → stop → save → playback, and confirm the log line and tray are unchanged from today. Use the [native computer-use acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) with `pnpm start:app`; check for a user recording in progress before rebuilding or quitting.
- [ ] Hand-edit `settings.json` to a display that does not exist, relaunch, and confirm the refusal: the note in the panel, the notification, the log line, idle afterwards, and recovery by choosing Primary display without a relaunch. This case needs no second monitor.
- [ ] Run `pnpm acceptance` with a specific display stored and with the default.
- [ ] With a second display if hardware is available: record it, confirm the file shows that screen, unplug it while the panel is open and confirm the list and the note update, then reconnect and confirm the choice is recovered by the label-and-size rule. Without hardware, record every multi-display case as untested and claim nothing about it.
- [ ] Mirrored displays and a display whose resolution changes between launches are accepted unknowns; test them if the hardware allows and record the result either way.
- [ ] Record what was actually tested and what was not in the [verification record](../docs/verification/README.md).

## Completion and boundaries

No commit, push, tag or publication is authorized by this plan. Out of scope: window or application capture (its own plan — the audio semantics, the window identity and the mid-recording resize question are unanswered), region and cursor-following capture, recording more than one display in one session, per-display quality, thumbnails in the panel, a tray submenu, the macOS system picker, and any claim of Windows or Linux acceptance. The audio policy does not change: the recording carries system audio, not the audio of whatever is on the chosen screen.

On completion, move the durable conclusions into [recording design](../docs/system-design/recording.md) and the [verification record](../docs/verification/README.md), then follow [plan completion](README.md#completing-a-plan).

## Technical references

- [Electron: desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer): source ids, `display_id` and its possible emptiness.
- [Electron: Display](https://www.electronjs.org/docs/latest/api/structures/display): `id`, `label`, `internal`, `size` and `scaleFactor`.
- [Electron: screen](https://www.electronjs.org/docs/latest/api/screen): `getAllDisplays`, `getPrimaryDisplay` and the display change events.
- [Electron: session.setDisplayMediaRequestHandler](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts): the handler contract and `useSystemPicker`.
- [Apple: CGDirectDisplayID](https://developer.apple.com/documentation/coregraphics/cgdirectdisplayid): why a display id is a session-scoped identifier rather than a durable one.
