# 043 — Register global shortcuts by physical key

[English](043-physical-shortcut-keys.md) | [繁體中文](043-physical-shortcut-keys.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-26. Execution order: see [queue](README.md#order-and-status).

## Scope, evidence and separation

Found in the plan 032 native round ([closure](../docs/verification/history-2026-09.md#plan-032-closure--2026-09-26)); fixing it is a maintainer request. With the Zhuyin input method active, whose keyboard layout `com.apple.keylayout.ZhuyinBopomofo` types Bopomofo on the number row, the default ⌘⇧1 is bound to the keypad. The number-row ⌘⇧1 does nothing. The settings shortcut ⌘⌥, uses the same listener.

Cause: Chromium 152 in Electron 44.3.0 enables `kLayoutAwareGlobalHotkeys` by default ([global_accelerator_listener_mac.mm](https://github.com/chromium/chromium/blob/152.0.7977.78/ui/base/accelerators/global_accelerator_listener/global_accelerator_listener_mac.mm)). While registering, it searches key codes 0–127 for the key that types the accelerator's character in the current layout, falls back to the fixed US position only when no key does, and re-registers every hotkey when the keyboard selection changes. Under Zhuyin only keypad 1 types `1`; letters are typed nowhere, so letter shortcuts fall back to their fixed position and keep working.

The app is inconsistent with itself here: [shortcut-capture.ts](../src/renderer/shortcut-capture.ts) records physical `event.code` values and refuses keypad keys, yet registration binds by character, and under Zhuyin it binds to the keypad.

Evidence (2026-09-26, Electron 44.3.0, macOS 26.6.2, Zhuyin active with the ZhuyinBopomofo layout; synthetic System Events keys against a probe that registered ⌘⇧1 and ⌘⌥⇧R, run outside the repository):

| Probe | Number-row ⌘⇧1 (`key code 18`) | Keypad ⌘⇧1 (`key code 83`) | ⌘⌥⇧R |
| --- | --- | --- | --- |
| Default | not fired | fired | fired |
| `--disable-features=LayoutAwareGlobalHotkeys` | fired | not fired | fired |

Physical key presses were not tested.

Cap comparison, pinned to `40f44a803f0980fb7ed530f17d12b8fed40f6b5a` with `tauri-plugin-global-shortcut` 2.3.0 and `global-hotkey` 0.7.0; this is a static comparison, not evidence that Cap handles every layout:
- The settings page records `e.code` and stores `{ code, meta, ctrl, alt, shift }`.
- `global-hotkey` maps `Code::Digit1` to the fixed key code `0x12` for Carbon `RegisterEventHotKey`, with no layout lookup.
- Cap has no default shortcut, ignores registration failures, and labels digits as `Digit1`.

This plan adopts only physical registration. RecordStuff keeps its defaults, reserved-combination checks, conflict reporting and `⌘⇧1` labels.

Out of scope:
- the default shortcut, the settings format, the editor, the preset list, `pnpm acceptance`'s key mapping and native modules;
- Windows and Linux: the feature exists only in Chromium's macOS listener, and verification is macOS-only.

## Implementation contract

- [ ] Before any `globalShortcut` registration and before app ready, on macOS only, disable `LayoutAwareGlobalHotkeys` through `app.commandLine`. Keep the feature name in one constant. Merge it into any `disable-features` value already on the command line instead of replacing it.
- [ ] Cover the decision with focused tests on real logic: macOS gets the feature and other platforms do not, and an existing `disable-features` list, a duplicate or an empty value merge correctly. Do not add tests that only restate the call.
- [ ] Document it in the bilingual [desktop design](../docs/system-design/desktop.md#recording-shortcut) and add a [design decision](../docs/system-design/decisions.md) row covering:
  - global shortcuts register by physical US key position, matching the editor's physical capture and Cap;
  - the accepted trade-off: on non-QWERTY Latin layouts such as Dvorak or AZERTY, a letter shortcut is the US position, not the keycap letter;
  - the reconsideration trigger: on every Electron upgrade, confirm the feature name still exists in that Chromium, or behavior silently returns to layout lookup.
- [ ] Replace the `desktop.md` sentence saying physical `event.code` does not establish layout compatibility with the measured result.
- [ ] Remove plan 032's Zhuyin/ABC prerequisite from the bilingual tooling guide, and point that closure's found-but-not-fixed note to this plan's closure.

## Required verification and exclusions

The diff changes global shortcut registration, which can start and stop capture, so the testing policy's shortcut and recording rows apply.

- Run `pnpm check` and `pnpm acceptance:regression`.
- Native, on freshly built bundles with Zhuyin (ZhuyinBopomofo layout) active:
  - `pnpm acceptance:updates`: its isolated fixture uses the default ⌘⇧1, the exact failing case, and its two recordings supply the recording smoke with media verification. Observe playback of one saved recording.
  - `pnpm start:app`, then `pnpm acceptance:settings-shortcut` for ⌘⌥,. Quit the app afterward.
- The "before" evidence reuses the probe table above: same Electron, machine and layout.
- The maintainer presses the physical number-row ⌘⇧1 once under Zhuyin and once under ABC (Settings → Shortcut → Recommended: ⌘⇧1 on the local bundle, start then stop, then restore the original shortcut), and confirms the usual ⌘⌥⇧R still works. Synthetic events cannot prove physical keys. If this is not done in the round, record it as not run and carry it to 035.
- Not needed, by scope: the matrix, long recordings, notification acceptance, `--full` feed cases, Windows, and a separate `pnpm acceptance` round. Letter shortcuts on QWERTY-based layouts resolve to the same key code either way, and the probe covers them.

## Completion and evidence handling

Follow [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Use the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) for any required native UI round. Serialize shared builds; one desktop/audio/shortcut owner per round. Restore changed settings and the input source, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan.
