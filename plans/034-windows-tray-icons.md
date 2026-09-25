# 034 — Improve Windows system tray icon visibility

[English](034-windows-tray-icons.md) | [繁體中文](034-windows-tray-icons.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-25. Execution order: see [queue](README.md#order-and-status).

## Purpose and current behavior

Give RecordStuff a complete, recognizable app symbol in the Windows notification area (system tray), instead of carrying over the simple macOS menu bar ring. “Windows menu bar” in this request means the system tray; Start menu, pinned taskbar and installer icons are outside scope.

The [icon generator](../scripts/make-icons.mjs) already emits separate macOS template PNGs and Windows ICOs, but shares ring/dot geometry: Windows uses a gray idle ring and a red recording dot. The [tray model](../src/main/tray-model.ts) already defines the `warning` state with its own macOS PNG and Windows ICO assets (plan 025, complete); implementation must preserve it. [Tray](../src/main/tray.ts) selects assets by platform; Windows does not display the macOS `REC` title, so the icon must communicate state on its own. These are source observations, without Windows native appearance evidence.

## Visual direction and scope

Use one brand symbol with platform-specific artwork: preserve the simple macOS template ring, and strengthen the Windows silhouette while keeping the same recording symbol and state meanings. Shared design does not require identical image files or a scaled-down app icon. A rounded background is a candidate, not a Windows requirement or a settled design.

Compare two Windows candidates before choosing:

- **A — Rounded base:** simplify the existing app icon's dark rounded base, white ring and red recording element for tray sizes.
- **B — No base:** use transparent surroundings with a thicker recording symbol, refining its outline and contrast for light/dark backgrounds.

Choose through actual-size comparison of recognition, state distinction and edge clarity; record the selected design and rationale. Refine stroke width, spacing and proportions per size.

| State | Shared contract for both candidates | Recognition requirement |
| --- | --- | --- |
| Idle | Recording ring with an empty center; candidate A adds a rounded base | Clear silhouette, beyond an isolated gray ring, without implying active recording |
| Recording | Same chosen silhouette with a prominent solid red center | Distinguishable from idle through hollow/solid geometry as well as color |
| Warning | Same chosen silhouette with a high-contrast exclamation mark; simplify the inner ring if needed | Warning remains recognizable at the smallest size without relying on color alone |

- Keep transparent outer margins and visible edges on light and dark backgrounds; add a thin outline if needed.
- No text, blinking or animation. The warning must retain app recognition.
- Preserve macOS template PNG designs, the main app icon and DMG background. Linux is outside scope.
- Retain existing state mapping, warning precedence, tooltips and click behavior; do not change recording workflows.
- This adds Windows tray appearance work and its necessary acceptance, not a full Windows support, packaging or release project.

## Platform guidance and Cap reference

[Electron's Tray documentation](https://www.electronjs.org/docs/latest/api/tray) recommends template images on macOS and ICO on Windows. [Microsoft's notification-area guidance](https://learn.microsoft.com/en-us/windows/win32/uxguide/winenv-notification) emphasizes simple, recognizable symbols; a rounded background is our design option, not a platform rule.

Cap reference inspected at fixed revision `26e1a6d882f311d10b5317e9e0d29babe4f6737e`:

- Its Tauri desktop implementation selects mode-specific template artwork on macOS and a dedicated default image on Windows. The inspected Windows asset has a white rounded-square silhouette with central concentric circles. See [platform asset selection](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/apps/desktop/src-tauri/src/tray.rs#L709-L721), [template configuration](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/apps/desktop/src-tauri/src/tray.rs#L833-L838), and the [actual Windows asset](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/apps/desktop/src-tauri/icons/tray-default-icon.png).
- The two desktop implementations differ: [Tauri skips Windows icon changes on recording start/stop](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/apps/desktop/src-tauri/src/tray.rs#L1060-L1097), whereas [GPUI switches Windows to a stop icon during recording](https://github.com/CapSoftware/Cap/blob/26e1a6d882f311d10b5317e9e0d29babe4f6737e/apps/desktop-gpui/src/tray/windows.rs#L208-L230). Do not combine these into a claim about one shipped version.
- Adopt the platform-specific artwork principle, not Cap's artwork or state behavior. RecordStuff retains its idle/recording/warning distinctions. This reference is source and asset inspection, not native Windows acceptance or proof of small-size readability.

## Implementation steps

- [ ] Start from the committed `TrayIcon` states (`idle`, `recording`, `warning`, plus `busy` and `countdown` from [040](040-recording-countdown.md), which is queued first) and their existing precedence; do not change `tray-model.ts` semantics. Previews, the candidate comparison, regenerated ICOs and native checks cover every committed state, not only the three in the table above; `busy` and `countdown` keep 040's silhouettes (hourglass, stopwatch) unless the chosen candidate needs a Windows-specific refinement. Visual drafts can proceed independently.
- [ ] Prepare actual-size and enlarged previews of candidates A/B for all three states at 16/20/24/32/48px on light/dark backgrounds. Compare with the current Windows icons, select the clearer candidate and record why. Confirm idle and recording remain distinguishable without color; an enlarged preview alone is insufficient.
- [ ] Separate Windows drawing layers in `scripts/make-icons.mjs`, retaining programmatic generation instead of shrinking the 512px app icon directly. Keep 16, 24, 32 and 48px entries, add 20px, and tune details per size in the multi-resolution ICOs.
- [ ] Regenerate `resources/tray-idle.ico`, `resources/tray-recording.ico` and `resources/tray-warning.ico`. Inspect generation side effects to ensure macOS PNGs, app artwork and DMG backgrounds are not accidentally changed.
- [ ] Prefer the existing platform branch in `src/main/tray.ts`. Change the loader only if needed, with platform-selection/state-transition behavior tests. Preserve `tray-model.ts` semantics.
- [ ] Update desktop design documentation and its Traditional Chinese translation; preserve actual appearance evidence and limitations in verification documentation.

## Verification and completion

Combine runtime assets, generator scripts and visible native tray behavior requirements from the [testing policy](../docs/testing.md):

- [ ] Run `pnpm icons`; inspect expected ICO dimensions, transparency, decoding and nonempty artwork. Inspect every size visually and confirm repeated generation produces identical Windows ICO bytes.
- [ ] Run `pnpm check` and `git diff --check`. If the loader changes, cover the three Windows assets and macOS template paths; avoid tests that merely restate drawing constants.
- [ ] On a native Windows desktop, inspect all three states in a freshly built app across light/dark taskbars, 100%/125%/150%/200% scaling, and the visible tray/hidden-icons panel. Record OS, scaling, build and screenshots; check clipping, blurry edges and missing warning details. Record unavailable combinations.
- [ ] In the same Windows round, confirm existing left-click toggling, right-click menu and tooltips. Start/stop one short recording, checking icon transitions, saving and playback. Controlled state injection may display warning artwork, but distinguish appearance evidence from real failure/recovery evidence.
- [ ] If macOS assets and loader remain unchanged, verify isolation through asset comparison and automated checks. If shared drawing or loader changes affect macOS, use the native acceptance skill on a fresh bundle for affected appearance/actions; add recording smoke when recording actions are affected.
- [ ] After each native round, restore settings, close test UI, quit normally and confirm process exit. Serialize builds sharing artifacts and give one executor desktop ownership.

An icon-only change does not need settings regression, long recordings, audio-quality matrices or publication. Expand checks according to policy if implementation affects other behavior. Existing macOS `pnpm start:app` and acceptance runners cannot establish Windows acceptance; confirm the Windows launch method during execution rather than documenting an unverified command.

Without a Windows desktop, mark native acceptance blocked; neither macOS nor static previews substitute for Windows evidence. This plan is documentation only: implementation and native acceptance have not run. On completion, preserve design/verification conclusions and remove this plan and its translation according to queue rules.
