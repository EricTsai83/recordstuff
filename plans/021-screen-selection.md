# 021 — Choose which screen to record

[English](021-screen-selection.md) | [繁體中文](021-screen-selection.zh-TW.md)

Status: implementation not started; revised design agreed on 2026-09-23. Next after completed 023, before 022. Created: 2026-09-21. This revision changes the plan only; no application behavior has been implemented or verified.

## Problem and outcome

`chooseDisplayMedia` always resolves the primary display and falls back to the first screen source ([index.ts](../src/main/index.ts), [recording design](../docs/system-design/recording.md#start)). On a machine with a second display that is a policy, not a preference: everything worth recording has to be dragged onto the primary display first, and the app gives no hint that the other screen exists. The app already knows how to capture any screen source — the one it picks is hard-coded.

Let the user choose the target display in Settings → Recording. The choice survives a relaunch, resolves after a reconnect only if the stored id still matches, and a choice that can no longer be resolved refuses the start with a stated reason instead of silently recording a different screen. Scope is whole displays on the supported macOS app with the existing audio policy unchanged; other platforms keep working without a claim of acceptance. Window capture, region capture and recording two displays at once stay out of scope (see [boundaries](#completion-and-boundaries)).

## Design decisions

### The default is "Primary display", and it is not a stored display id

`{ kind: "primary" }` is the default and resolves through the current code path: the primary display's id, falling back to the first screen source. A user who never opens the setting sees no change at all — same source, same log line, same unattended acceptance run — and a user whose monitor arrangement changes keeps recording whatever macOS currently calls primary. This preference follows the current primary rather than storing an id that can become stale. New explicit-target resolution failures apply only to a specific display choice.

### A specific choice stores an id and a display label, without heuristic recovery

Store `{ kind: "display", id, label }`. Resolve only an exact id match against the current display list; never match by label, size, list position or model. The label is presentation metadata for a disconnected choice, not identity. Do not silently replace or rewrite the saved id. A changed id requires an explicit new selection, even when exactly one display has the same name and size.

The guarantee is **no automatic substitution when resolution fails**, not permanent physical-device identity. A platform id is not a durable hardware identity; id reuse cannot be ruled out by this design. Reconnecting with the same id can work, while reconnecting with a different id requires reselection. Native hardware identity and automatic reconnect matching are outside this first version.

Validate ids as nonempty strings representing supported display ids; reject known invalid/synthetic sentinels such as Electron's -1 and -10 for an explicit choice. Empty labels are valid and get a deterministic, localized presentation fallback. Duplicate ids in a supplied list are ambiguous and must not select an arbitrary entry.

### An unavailable choice refuses the start and leaves visible feedback

Use `display_unavailable` when an explicit target is missing, ambiguous, lacks a corresponding capture source, or cannot be safely resolved after topology changes. Record a structured detail separately from the public error code so the UI can distinguish “selected display is unavailable; choose again”, “display is connected but capture source is unavailable” and “display configuration changed; retry”. Do not claim every failure means a physically disconnected screen.

Keep the existing denial/error mapping and logs. Notifications obey the existing preference. Also retain the last display-related start/capture failure in main-process memory and project it in the tray and Settings → Recording, including when notifications are off. Keep it until a recording successfully starts or a different display preference is successfully saved; an attempted start, UI refresh or failed save must not clear it. This diagnostic is not persisted across relaunches; current missing-target status is recomputed then. Log requested and resolved ids, selection rule, retry count and failure detail.

A stale saved choice remains selected but cannot be submitted as a new action. Offer Primary display and connected selectable displays for recovery without relaunch. A currently missing target gets an unavailable tray line; a historical failure is explicitly labeled as the last failure rather than claiming the screen is still disconnected.

### Share display resolution, then select a capture source

Move pure logic to `src/main/display-source.ts`. `resolveDisplayPreference({ displays, primaryDisplayId, preference })` supplies the same current-target result to Settings, tray and the capture path. `selectScreenSource({ sources, resolution, preference })` separately maps that result to a capture source. Opening Settings does not claim that a listed display is capturable.

For `primary`, preserve the existing selection and error policy: match the primary id, otherwise use the first screen source; an empty source list is `no_display`. For an explicit choice, require exactly one current display and exactly one source with matching `display_id`; absence, empty source ids or ambiguity is `display_unavailable`, including an empty source list. A throwing `getSources` retains the existing mapping: `permission_denied` on darwin and `no_display` elsewhere. Add tests for this precedence.

### Bound start-time retries and reject stale requests

Snapshot the preference and recording-attempt identity at start. Track a display-topology generation on every added/removed/metrics event, including while recording preferences are locked. For an explicit choice, read current displays and the generation, await `getSources`, then recheck the generation, exact target and active attempt before handing off the source. Retry transient missing sources or topology changes at most three total enumeration attempts, with 150 ms between attempts; use the same preference throughout. A definitely absent or ambiguous target is rejected immediately. Do not retry permission/enumeration exceptions or fall back to another target.

Cancellation or a superseding attempt invalidates delayed results and timers. Complete each request callback at most once; a stale request must never grant capture or overwrite a newer attempt's denial/UI diagnostic. Preserve the existing recorder start timeout as the outer bound; three attempts do not bound a hung `getSources` promise. Test delayed completion after cancellation/timeout and a subsequent start. Keep primary's existing source-selection policy, while applying request-lifetime guards to both modes. No application-level check makes OS capture atomic; failure after handoff follows the existing capture-failure path.

### Dimensions describe the display, not its identity or final video

Use `logicalWidth`, `logicalHeight` (DIP) and `scaleFactor` in live `DisplayInfo`, alongside `id`, `label`, `internal` and `primary`; do not persist dimensions in the preference. If shown in Settings, label these as logical dimensions rather than native recording pixels. Use the actual video track dimensions plus existing resolution-cap/quality policy to verify output pixels; do not infer the encoded size from Screen API dimensions. Rotation/scaling changes update live metadata without changing an id-based choice.

### The panel lists displays from the Screen API, not from desktopCapturer

`screen.getAllDisplays()` is synchronous, needs no capture permission and prompts nothing, so `settingsView` stays a pure projection of (state, context) and opening Settings never touches the capture stack or asks macOS for anything. `desktopCapturer` is consulted only when a recording starts. The gap between the two lists is not hidden: a display the panel offered and capture cannot see is the `display_unavailable` case above.

### The renderer still only echoes an id

Each choice in the new group is built from the live display list, so the action main authorizes already carries the id and presentation label it will store; the panel sends back a display id string and nothing else. This group needs no new value-carrying IPC channel, and `settingsAction` keeps resolving ids against a freshly built model.

### A changing display set refreshes both projections

`screen` emits `display-added`, `display-removed` and `display-metrics-changed`. Each one calls `refreshUi()` while the recorder is settled, so an unplugged monitor disappears from the panel and a stale choice grows its note without the window being reopened. Events always advance the topology generation. They never retarget an active capture; refresh both projections again when the recorder settles, including changes observed while busy.

### No tray submenu, but the tray names a non-default target

[tray-model.ts](../src/main/tray-model.ts) builds no submenus by design, and a per-display list cannot be a flat menu. The choice therefore lives only in Settings. The risk that creates is a user who forgets the setting and records an idle second screen, so when the preference is not `primary` and is available, the idle tray's first line reads `Ready — <display label>`. With a healthy default it stays `Ready`; display-loss diagnostics still apply if a running capture fails.

### Not the system picker

`useSystemPicker` (macOS 15+, experimental) would hand the choice to Apple's own picker and delete this plan's UI, but the Electron documentation is explicit that the handler is then not invoked — and the handler is where `audio: "loopback"` and every audio decision this app is built around lives ([audio design](../docs/system-design/audio-quality.md)). Trading the app's measured audio policy for a free picker is not a trade this app can make. Reconsider only if Electron lets the system picker coexist with an application-chosen audio source.

### Losing the active display ends capture without switching targets

Reuse the host's video-track-ended / `capture_failed` path and existing partial-file preservation. Also detect removal of the active resolved display id through display events and route it into the same idempotent failure/finalization path, without relying solely on the OS to deliver `ended`. Preserve recoverable content, report the cause in the tray/settings, and never substitute another source. Race tests must cover removal, track end and user stop arriving together. A partial file is not guaranteed playable; verify and report what was recovered. Automatic stream reconstruction is outside this plan.

## Expected experience

- Settings → Recording gains a Screen control listing `Primary display` first, then each connected display by name — `Built-in Retina Display (Primary)`, `Studio Display` — with a note saying the recording captures one whole screen and that system audio is unaffected by the choice.
- The default is Primary display. Changing the choice saves immediately, like every other recording preference, and is locked while starting, recording or saving.
- Connecting or disconnecting a display updates the list while the window is open. A disconnected display that is the stored choice stays selected and the note says it is not connected and cannot be recorded.
- Starting a recording with an unresolvable choice does not record: the log says which stored display could not be matched, a notification says the chosen screen is unavailable when enabled, and the tray returns to idle with a persistent failure explanation. Choosing Primary display or a connected display recovers without a relaunch.
- A recording started on a non-primary display shows that display's content, with output dimensions governed by the actual capture and existing resolution cap, and the same quality settings, and the start log line names the display and the rule that matched it.
- With the default choice on the normal path, the tray, the log line and `pnpm acceptance` behave as they do today.

## Implementation order

### 1. Shared preference and vocabulary

- [ ] Add `src/shared/display.ts`: `DisplayPreference`, `DEFAULT_DISPLAY_PREFERENCE` (`{ kind: "primary" }`), `isDisplayPreference`, a `DisplayInfo` shape (`id`, `label`, `logicalWidth`, `logicalHeight`, `scaleFactor`, `internal`, `primary`) and the label builder both projections use, including the fallback when `Display.label` is empty.
- [ ] Add `display_unavailable` to `ERROR_CODES` in [state.ts](../src/shared/state.ts).
- [ ] Tests: the guard accepts both kinds and rejects a missing id, an empty/non-string/invalid id, a non-string label and an unknown `kind`; live display metadata rejects non-finite or non-positive dimensions/scale; labels are stable for an unnamed display and mark the primary one.

### 2. Storage

- [ ] Read `display` leniently in [settings.ts](../src/main/settings.ts) with `DEFAULT_DISPLAY_PREFERENCE` and a warning for an unusable value, and add `setDisplay`. A well-formed but absent display id remains saved; it is not malformed configuration. No `SETTINGS_VERSION` bump: `updates` and `notifications` set the precedent that a field added after the fact is read leniently rather than versioned.
- [ ] Tests: a primary and a specific value round-trip, a garbage value falls back with the warning, a version 1–3 file without the field takes the default, and an unrelated setting's save does not drop the display choice.

### 3. Source selection

- [ ] Add `src/main/display-source.ts` with the shared resolver and `selectScreenSource` and wire `chooseDisplayMedia` in [index.ts](../src/main/index.ts) to it, including the `display_unavailable` denial and a start log line naming the display, its id and the matching rule.
- [ ] Controlled async tests: topology changes during enumeration, bounded retry exhaustion/recovery, absent target, cancellation/timeout and late completion followed by a new attempt; callback-at-most-once and no stale denial contamination. Simultaneous removal/track-end/stop finalizes once.
- [ ] Tests: primary resolves by display id; primary with no id match falls back to the first source; a stored id matches; a changed id is unresolved even with one or two identical-name/size displays; duplicate ids/sources are rejected; empty sources yield `no_display` for primary and `display_unavailable` for explicit selection; sources without `display_id` leave a specific choice unresolved while primary still works.

### 4. Panel and tray

- [ ] Extend `AppContext` in [ui-model.ts](../src/main/ui-model.ts) with `displays`, `display` and the retained display failure, add `{ setDisplay: DisplayPreference }` to `AppAction`, and populate them from live Screen API data, saved settings and main-process diagnostic state in `appContext()`.
- [ ] Add the `screen` group to [settings-model.ts](../src/main/settings-model.ts) on the recording tab (its tab list is id-based and must include it), with the unavailable/recovery notes and the same lock rule as quality.
- [ ] Show the non-default target in the idle tray line in [tray-model.ts](../src/main/tray-model.ts) and add the `display_unavailable` notification message to [tray.ts](../src/main/tray.ts).
- [ ] Tests: the group lists primary plus every display with the stored one checked; a stored display that is absent stays checked and carries the note; the group is locked while recording; `settingsAction` returns the id and label for a listed id and nothing for an unknown one; the idle tray line is unchanged for healthy `primary` and names an available explicit display otherwise. Assert missing/source-unavailable states agree across projections; stale choices are disabled and unique; id reuse is not claimed to prove identity; notification-off failures persist and clear only under the stated rules.

### 5. Main wiring

- [ ] Handle `setDisplay` in `handleAction` (settled check, persist, log, refresh, write-failure notification; a failed save changes neither preference nor diagnostic) and subscribe to display events: always advance topology generation, detect loss of the active target, refresh while settled and after returning to settled; release listeners and invalidate pending attempts/timers on `will-quit`.

### 6. Messages

- [ ] Add every new string to [i18n.ts](../src/shared/i18n.ts) in English and Traditional Chinese with consistent placeholders: the group label, the note, the unavailable/source-missing/topology-changed details, last-failure feedback, recovery instruction, logical-dimension units, the tray idle line and the `display_unavailable` notification.

### 7. Documentation

- [ ] Update [recording design](../docs/system-design/recording.md) (start step 4 and the error table), [desktop design](../docs/system-design/desktop.md) (settings window), the main-process row in [webrtc.md](../docs/system-design/webrtc.md) that states main selects the primary display, and all three [zh-TW](../docs/zh-TW/system-design/) mirrors.
- [ ] Run `pnpm check` and `git diff --check`.

### 8. Verify behavior

- [ ] With the default choice: start → stop → save → playback, and confirm the log line and tray are unchanged from today. Use the [native computer-use acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) with `pnpm start:app`; check for a user recording in progress before rebuilding or quitting.
- [ ] Hand-edit `settings.json` to a display that does not exist, relaunch, and confirm the refusal: the note in the panel, the notification, the log line, idle afterwards, and recovery by choosing Primary display without a relaunch. Repeat with notifications off and confirm tray/settings retain the reason until a successful start or a successfully saved different selection. This case needs no second monitor.
- [ ] Run `pnpm acceptance` with a valid specific display stored and with the default; restart the app between rounds because acceptance leaves it closed.
- [ ] With a second display if hardware is available: record it, confirm the file shows that screen, unplug it while the panel is open and confirm the list and the note update, then reconnect: the same id may resolve, while a changed id must require reselection with no name/size recovery. Separately unplug during recording and verify termination, persistent reason and the actual recoverability of saved content. Without hardware, record every multi-display case as untested and claim nothing about it.
- [ ] Mirrored displays, rotation/scaling changes and a display whose resolution changes between launches are accepted unknowns; test them if the hardware allows and record the result either way.
- [ ] After every native acceptance round, save recordings started by the test, restore changed settings, close test UI, quit normally and confirm process exit. Report incomplete cleanup as failure/blocker.
- [ ] Record what was actually tested and what was not in the [verification record](../docs/verification/README.md).

## Completion and boundaries

No commit, push, tag or publication is authorized by this plan. Out of scope: window or application capture (its own plan — the audio semantics, the window identity and the mid-recording resize question are unanswered), region and cursor-following capture, recording more than one display in one session, automatic reconnect matching, native hardware identity, automatic stream reconstruction, per-display quality, thumbnails in the panel, a tray submenu, the macOS system picker, and any claim of Windows or Linux acceptance. The audio policy does not change: the recording carries system audio, not the audio of whatever is on the chosen screen.

On completion, move the durable conclusions into [recording design](../docs/system-design/recording.md) and the [verification record](../docs/verification/README.md), then follow [plan completion](README.md#completing-a-plan).

## Technical references

- [Electron: desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer): source ids, `display_id` and its possible emptiness.
- [Electron: Display](https://www.electronjs.org/docs/latest/api/structures/display): `id`, `label`, `internal`, `size` and `scaleFactor`.
- [Electron: screen](https://www.electronjs.org/docs/latest/api/screen): `getAllDisplays`, `getPrimaryDisplay` and the display change events.
- [Electron: session.setDisplayMediaRequestHandler](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts): the handler contract and `useSystemPicker`.
- [Apple: CGDirectDisplayID](https://developer.apple.com/documentation/coregraphics/cgdirectdisplayid): display identifiers; do not treat an id as permanent hardware identity.

## Cap reference and deliberate differences

Source review only, pinned to [Cap commit ce785e7](https://github.com/CapSoftware/Cap/tree/ce785e705e79652adba4b8bf752669c4093499e0); Cap was not run. Its [macOS start preparation](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/recording.rs#L645-L713) checks target availability with three attempts and 150 ms waits. Its [capture monitor](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/crates/recording/src/sources/screen_capture/macos.rs#L665-L789) checks that the target still exists before stream reconstruction. Borrow bounded checks and target-loss handling, not automatic reconstruction. Cap's main UI has a first-display fallback, while its picker submits an explicit target; RecordStuff instead requires one consistent no-substitution policy for explicit choices across all entry points. This reference does not establish durable hardware identity or prove RecordStuff's behavior.
