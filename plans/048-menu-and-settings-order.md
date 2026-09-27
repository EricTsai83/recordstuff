# 048 — Tray menu and Settings order

[English](048-menu-and-settings-order.md) | [繁體中文](048-menu-and-settings-order.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-27. Queue after [047](047-failure-history-tab.md) and before [035](035-guided-native-acceptance.md), which stays last. It has no hard dependency on 045–047; 047 also changes the Settings tabs and 046 adds a Recording group, so this plan orders the result of both. Execution order: see [queue](README.md#order-and-status).

## Purpose and boundary

On 2026-09-27 the maintainer asked for a review of the order in which the UI presents information, above all whether the right-click menu's order is normal. This plan audits the [tray model](../src/main/tray-model.ts) in every state and the [Settings groups](../src/main/settings-model.ts), proposes a consistent order, and implements the order the maintainer approves.

In scope: the order and grouping of tray menu items, the few menu conventions that affect scanning (ellipses, shortcuts shown in the menu, the Quit label), a Start recording item, and the order of Settings groups. Out of scope: the failure rows themselves ([047](047-failure-history-tab.md) orders them), the countdown ([045](045-countdown-digit-scaling.md), [046](046-countdown-sound.md)), wording beyond the labels named here, notifications and dialogs (each carries one message, so there is nothing to order), and left-click behaviour.

## Current order and findings

The menu is one flat list rebuilt from the state on each right-click ([desktop](../docs/system-design/desktop.md#tray-and-notifications)). Today, idle after a failure that was already reviewed, and recording with an unread failure:

```text
Recent failure: <reason>            (disabled)
View recording failures…
────────────
Ready — <display>                   (disabled)
Show last recording
────────────
Output folder: ~/Movies/RecordStuff
Change output folder
────────────
Settings (⌥⌘,)
Show log
Quit
```

```text
Unreviewed recording failures: 1    (disabled)
View recording failures…
────────────
Recording                           (disabled)
Stop
────────────
Output folder: ~/Movies/RecordStuff (disabled)
Change output folder                (disabled)
────────────
Settings (⌥⌘,)
Show log
Quit
```

1. **Failures come before the state.** Whenever any failure is retained, the failure lines open every menu, above the status line and the state's primary action. While recording, Stop is the fourth row.
2. **Reviewed failures never leave the top.** With every failure acknowledged, "Recent failure: <reason>" and View recording failures… stay first until the history is empty, and up to 20 reviewed rows are kept, so one old failure can head the menu for a long time.
3. **No Start item.** Recording offers Stop and the countdown offers Cancel countdown, but idle offers no way to start; the model's own comment names start/stop as a tray command. Only the left click starts.
4. **Files are split.** Show last recording sits in the status group, apart from the output folder items.
5. **Quit is not set apart.** Settings, Show log and Quit form one group. Standard menus, and [Cap's tray](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/desktop/src-tauri/src/tray.rs#L577-L620), keep Quit in the last group; Cap labels it "Quit Cap".
6. **Conventions are mixed.** View recording failures… has an ellipsis, while Settings (opens a window) and Change output folder (opens a dialog) do not. The Settings shortcut is typed into the label, "Settings (⌥⌘,)", and the recording shortcut appears only in the tooltips of Stop and Cancel countdown, instead of right-aligned as native menus show shortcuts.
7. **General puts maintenance before everyday preferences.** General runs Shortcut, Notifications, Updates, Language, Appearance, then About, so Language and Appearance sit below the update controls. Recording runs Screen, Countdown, Video quality, Resolution cap and Frame rate, which already reads what, when, how.
8. **The output folder is the only saved preference missing from Settings.** It can be seen and changed only from the tray, although Settings already opens the folder dialog from a failure row.

[Cap's tray](https://github.com/CapSoftware/Cap/blob/119edf04864b59abfc0d52f60bf77d7f33cfd2b8/apps/desktop/src-tauri/src/tray.rs#L471-L620) (static review at the pinned revision, not run) orders its menu by use: actions first (Open Main Window, Record Display…, Import Media…), then modes and recent items, then windows (View all recordings, View all screenshots, Settings), and last Upload Logs, the version and Quit Cap.

## Proposed order

Initial proposal, subject to the maintainer review below. Every state uses the same groups in the same order, omitting a group that has nothing to show, so an item never changes places between states:

1. **State:** the status line, then the state's primary action: Start recording (idle), Stop (recording), Cancel countdown (countdown), or the permission steps (needsPermission). Idle's last-display-failure line stays directly under the status line.
2. **Unread failures,** only while any is unread: "Unreviewed recording failures: n" and View recording failures….
3. **Files:** Show last recording, Output folder, Change output folder….
4. **Windows:** View recording failures… when failures are retained but none is unread (the "Recent failure: <reason>" line is dropped), then Settings…, with the shortcut explanation under it when the Settings shortcut is unavailable.
5. **App:** Show log, Quit RecordStuff.

```text
Ready — <display>                   (disabled)
Start recording                 ⇧⌘1
────────────
Unreviewed recording failures: 1    (disabled)
View recording failures…
────────────
Show last recording
Output folder: ~/Movies/RecordStuff
Change output folder…
────────────
Settings…                       ⌥⌘,
────────────
Show log
Quit RecordStuff
```

Settings: Recording keeps Screen, Countdown, Countdown sound (046), Video quality, Resolution cap, Frame rate. If the maintainer accepts decision 6 below, Output folder follows Screen. General becomes Shortcut, Notifications, Language, Appearance, Updates, then About, so everyday preferences come first and maintenance sits beside the About footer, as Cap keeps its version and update check at the foot of its Settings sidebar.

## Implementation contract

- [ ] **Maintainer review first.** Show the maintainer the current and proposed menus for idle (with no failures, unread failures and only reviewed failures), needsPermission, countdown and recording, and the proposed Settings order, as text mockups like those above or as screenshots. Record each decision in this plan before implementing: (1) add Start recording; (2) the failure groups as proposed; (3) "Quit RecordStuff" / "結束 RecordStuff"; (4) shortcuts right-aligned in the menu; (5) the General order; (6) an Output folder row in Settings → Recording, with the tray items kept. Drop any rejected item from this contract.
- [ ] **Tray order.** [tray-model.ts](../src/main/tray-model.ts) builds every state from the five groups in order, never emits a leading, trailing or doubled separator, and keeps the tooltip as it is. Disabled items stay disabled rather than hidden, so the recording menu keeps its greyed output folder.
- [ ] **Start recording.** A new `start` action appears in idle whenever a left click would start, labelled "Start recording" / "開始錄製", matching the tray's existing "錄製中". It starts exactly as the left click does, countdown included. Because an open macOS menu cannot change ([desktop](../docs/system-design/desktop.md#tray-and-notifications)), it is resolved against the state when chosen: it starts only from idle and otherwise does nothing and logs it, so a stale Start can never stop a recording or cancel a countdown.
- [ ] **Menu conventions.** Settings… and Change output folder… gain ellipses. Start recording, Stop and Cancel countdown show the registered recording shortcut, and Settings… the registered Settings shortcut, as right-aligned native accelerators (`accelerator` with `registerAccelerator: false`), so the menu never registers a second global shortcut. When a shortcut is not registered no accelerator is shown, and the existing tooltips stay. If the native check shows that the tray's `popUpContextMenu` does not draw them, keep today's text and tooltips and record why.
- [ ] **Settings order.** [settings-model.ts](../src/main/settings-model.ts) orders General as proposed; section headings, the locked footnote and the About footer move with their groups. If decision 6 is accepted, the Recording tab gets an Output folder row after Screen that shows the path and offers Change… and Show in Finder, through the existing `changeOutputDir` and `openOutputDir` handlers and their locks; the tray items stay.
- [ ] **Translations and documentation.** English and Traditional Chinese for the new and changed labels. Update in both languages the desktop design's tray section and state table and its Settings window paragraphs, the acceptance guide's tray rows, and the English website's "Right-click for Settings, your output folder and logs" line if the order it implies changes.

## Verification and exclusions

- [ ] Unit tests: the exact item order and separators of every state, with no history, unread failures and only reviewed failures, in both languages; the reviewed-only entry in the windows group without the "Recent failure" line; Start recording enabled exactly when a left click would start; a stale Start ignored outside idle; accelerators present only for registered shortcuts; the shortcut explanation under Settings…; the Settings group order in both tabs, including 046's group and, if accepted, the Output folder row and its lock.
- [ ] `pnpm acceptance:regression` (Settings order changes; includes `pnpm check`) and inspection of the Settings screenshots in both languages.
- [ ] On a fresh `pnpm start:app` bundle, open the tray menu in idle, countdown and recording and screenshot it in both languages, in light and dark, through the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) or an Accessibility action on the menu bar item: the order, the separators and whether the right-aligned shortcuts appear. Start one short recording from Start recording and stop it from Stop, then verify and play the file; this new entry point takes the recording start path. If the tray cannot be targeted, as happened to computer use in 040, record these as blocked and carry them to 035.
- [ ] If the website changes: `pnpm site:check` and inspection of the changed page.
- [ ] Exclusions: capture and encoding (Start calls the existing start), the countdown, failure rows (047), notifications and dialogs, and Windows appearance (the tray model is shared but only macOS is verified).

## Completion and evidence handling

Follow the [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Serialize shared builds; one desktop/audio/shortcut owner per round. Restore changed settings, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Reconcile 035 in both languages: N02 finds View recording failures… in its new place; N32 also starts once from Start recording; add a case that reads the menu in each state on light and dark menu bars for order, separators and shortcuts, plus any case carried from the native check above. Update 035's reconciliation note to name 048.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan. The Cap references are a static source review at the pinned revision, not execution or an assurance about every Cap mode or platform.
