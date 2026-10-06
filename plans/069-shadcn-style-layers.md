# 069 — Manage the renderer's styles in shadcn's layers

[English](069-shadcn-style-layers.md) | [繁體中文](069-shadcn-style-layers.zh-TW.md)

Created: 2026-10-06. Status: planned; implementation has not started. Source: after plan 067 the maintainer asked whether the CSS tokens follow shadcn, then asked that the styles be organised the way shadcn manages them so that they stay maintainable, while keeping the app's own design values. This document is the executable plan; its creation does not claim the refactor is done.

067 closed on 2026-10-06 ([record](../docs/verification/history-2026-10.md#plan-067-closure--2026-10-06)); execute next, following [the plan index](README.md). This is a queue dependency: reuse 067's gallery, measurements and assertions as the proof that nothing visible changes. Select checks using the testing policy in force at execution.

## Outcome and scope

The renderer's look keeps every value 067 settled, but each customisation lives in the layer shadcn expects for it:

1. **Tokens.** Semantic CSS variables in a `:root` block and a `.dark` block, mapped to Tailwind through `@theme inline`, as shadcn generates them. App-specific meanings (the recording red, the media overlay, the brand mark) are added there as named tokens, the way shadcn adds `--chart-*` or `--sidebar-*`.
2. **Components.** `src/renderer/components/ui/*` stays owned shadcn code. A difference the app needs is a `cva` variant or a prop of the primitive, not a selector from outside that reaches into it (`[data-slot=…]`, or a feature class that overrides a primitive's utilities).
3. **Features.** Pages compose primitives with Tailwind utilities and tokens. Layout CSS that remains in `ui.css` sits in `@layer components` and uses tokens, with no hard-coded colour.

The result must be visually identical: this is a refactor, not a redesign. Changing a design value, adopting shadcn's default palette (a white page instead of the light grey one), replacing Base UI, the countdown overlay's own stylesheet (`countdown.css`, outside shadcn by design) and the website are out of scope. Do not commit, push, open a PR or publish unless the maintainer asks.

## Starting evidence

Inspected at `39dd5196` (2026-10-06):

| Area | Current state | Target |
| --- | --- | --- |
| Token format | `light-dark(#hex, #hex)` values in one `:root`; `card-`, `popover-`, `secondary-` and `accent-foreground` all map to `--foreground` | `:root` and `.dark` blocks with the same computed colours; each `*-foreground` its own variable, set to today's value |
| App tokens | `--recording` (067); the root scale's `--text-xs: 0.8125rem` in `@theme` | Kept, documented as the app's deliberate theme decisions |
| Hard-coded colours | About 29 in `ui.css`, e.g. `#ef4444` (unread dot, arrival outline, brand mark), `#18181b`/`#fff` (brand and status marks), `#000b`/`#0009`/`#0002` (media overlays and shadows), `#000`/`#fff` (player and full-screen surfaces) | Named tokens (`--recording`, `--media`, `--media-foreground`, `--media-scrim`, `--shadow-*` or equivalents) |
| Outside selectors into primitives | `.section > [data-slot="card"]` (spacing), `.controls > [data-slot="button"]` and `.row-actions > [data-slot="button"]` (wrapping), `.controls [data-slot="native-select-wrapper"]`, `.pc [data-slot="slider-*"]`, forced-colour rules on `[data-slot="switch*"]`, `.tab-badge`/`.toast-key` font sizes | Card size/spacing prop, Button `wrap` (or equivalent) variant, Slider `media` variant, `forced-colors:` variants inside the primitives, Badge/Kbd size variants |
| Feature CSS | About 1,170 lines of unlayered rules in `ui.css` | Layout rules in `@layer components` (or utilities in the components), using tokens; unlayered rules only where a cascade reason is written beside them |

## 1. Baseline and identity

- [ ] Record HEAD, the working tree and a task-local test recipe in a new `docs/verification/measurements/<timestamp>-shadcn-layers/`.
- [ ] Build once and run `pnpm preview:ui -- --out <dir>/before` serially. Keep its `shots.json` and `measurements.json` as the reference. No desktop round is needed for this.

## 2. Tokens

- [ ] Rewrite the colour tokens as `:root` and `.dark` blocks that produce the same computed colours in both themes. Keep `color-scheme` and the `.dark` class the page already toggles; confirm the System appearance still follows the OS.
- [ ] Give each `*-foreground` its own variable, set to today's value, so a later palette change needs no mapping edit.
- [ ] Add named tokens for every hard-coded colour above and replace the literals. A colour that is the same meaning shares one token.

## 3. Components

- [ ] Replace each outside selector into a primitive with a variant or prop of that primitive, used at the call site. Keep the primitive's default rendering unchanged for every other caller.
- [ ] Move the forced-colour overrides into the primitives (`forced-colors:` variants) and keep their behaviour.
- [ ] Record, at the top of each edited `components/ui` file, what differs from the shadcn source and why, so a later comparison with upstream separates intended edits from drift.

## 4. Feature styles and guards

- [ ] Put the remaining feature layout in `@layer components` (or utilities at the call site where that is clearer). Keep an unlayered rule only with a written cascade reason.
- [ ] Add a check that fails when `src/renderer` (outside the token block and `countdown.css`) gains a hard-coded colour, or a feature stylesheet gains a `[data-slot=…]` selector. Keep it small and part of `pnpm check`.
- [ ] Update [desktop design](../docs/system-design/desktop.md#settings-window) and [repository](../docs/system-design/repository.md) (and translations) with the three layers and where a new customisation belongs.

## 5. Verification and closure

Classify the final diff under [the testing policy](../docs/testing.md). The expected recipe for a renderer style refactor that also reaches the player and full-screen page through shared tokens:

| Check | Requirement |
| --- | --- |
| `pnpm acceptance:regression` | Pass, including `settings-layout` (U067-0…3) and the 36 reviewed matrix baselines **unchanged**; a baseline that differs is a regression to fix, not to re-approve |
| `pnpm preview:ui -- --out <dir>/after` on the same `out/` | Paired with the before run by `shots.json`: every frame pixel-identical, or any difference inspected and explained (for example anti-aliasing) and `measurements.json` identical in text size, contrast, targets and overflow |
| The new guard | Fails on a planted hard-coded colour and a planted `[data-slot]` selector, then passes |
| `pnpm acceptance:player` (desktop round) | Only if the player's or full-screen page's tokens or primitives changed rendering paths; with the readiness handoff |
| `git diff --check`, links and translations | Pass |

Window options, `window-controls.ts` and the top-left drawing are not in scope; if they change, add `pnpm acceptance:settings-shortcut -- --observe` on a fresh `pnpm start:app`. Recording, CPU, notification and website checks are excluded for a style-only change.

- [ ] Write the closure record (before/after pairing, guard, checks, anything not identical and why) to [verification](../docs/verification/README.md) and its translation, update both plan indexes, then remove this plan and its translation under [the completion rule](README.md#completing-a-plan).
