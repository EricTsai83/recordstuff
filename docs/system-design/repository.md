# Repository Layout

[English](repository.md) | [繁體中文](../zh-TW/system-design/repository.md)

One repository holds two deliverables and the documentation for both: the Electron desktop app at the root, and the static website under `website/`. They share a Git history, a release flow and this documentation set, but nothing else — the website is a separate package with its own dependencies and lockfile, and the app never imports from it.

This document describes where things live and why. [Architecture](architecture.md) explains process boundaries and data ownership, [the function reference](functions.md) covers individual modules, and [tooling](tooling.md) covers the commands that act on these directories.

## Top level

| Path | What it holds |
| --- | --- |
| `src/` | Application source, split by Electron process |
| `scripts/` | Developer tools: build/launch, signing, release, recording verification and acceptance |
| `docs/` | System design, verification evidence, and the Traditional Chinese mirror |
| `plans/` | Execution plans for unfinished work only |
| `resources/` | Runtime assets copied into the app, plus the installation guide |
| `build/` | Packaging artwork consumed by electron-builder |
| `website/` | The Astro site published at record.ericts.com; its own package |
| `.github/workflows/` | Release and website deployment automation |
| `.agents/`, `.claude/` | Agent skill definitions used during development |
| Root configs | `package.json`, `tsconfig*.json`, `electron.vite.config.ts`, `vitest.config.ts`, `electron-builder*.yml` |
| Root guides | `README.md`, `CONTRIBUTING.md`, `AGENTS.md`/`CLAUDE.md`, `LICENSE`, and the `*.zh-TW.md` translations |
| `out/`, `dist/`, `node_modules/` | Generated; ignored by Git and rebuildable |

## Application source

`src/` is divided by Electron process, not by feature. Which process a file runs in determines what it may import, so that boundary comes first.

| Directory | Runs in | Contents |
| --- | --- | --- |
| `src/main/` | Main process | Lifecycle (`index.ts`), the recording state machine (`recorder.ts`), capture-host supervision, file writing, permission detection, settings, tray, global shortcut, saved notification, update checks, logging, and development-only unattended recording (`autorecord.ts`) |
| `src/renderer/` | Renderer processes | Two entries: the hidden capture host (`index.html` + `capture-host.ts`) that owns media streams and encoding, and the settings panel (`settings.html`, `settings.ts`, `settings.css`) |
| `src/preload/` | Preload, sandboxed | One file per renderer: `index.ts` hands the MessagePort to the capture host and exposes no API; `settings.ts` carries the settings panel's IPC contract |
| `src/shared/` | Both | State (`state.ts`), the MessagePort protocol, recording quality arithmetic, the settings-panel contract, shortcut presets, and translations (`i18n.ts`) |

Four conventions hold across this tree:

- **`src/shared/` stays environment-neutral.** It is the only directory included by both `tsconfig.node.json` and `tsconfig.web.json`, so it must import neither Electron nor DOM APIs.
- **Tests sit next to their source** as `foo.test.ts`. There is no separate test tree; `vitest.config.ts` collects `src/**/*.test.ts` and `scripts/**/*.test.ts`.
- **`*-model.ts` separates decisions from side effects.** `tray.ts`, `settings.ts` and `settings-window.ts` talk to Electron; `tray-model.ts`, `settings-model.ts` and `ui-model.ts` are pure projections that can be tested without a window. `recorder.ts` follows the same rule with injected collaborators.
- **User-visible text lives in `src/shared/i18n.ts`,** in English and Traditional Chinese together, never inline in a module.

## Developer tooling

`scripts/` holds everything that supports development but ships with nothing:

- **Entry points** at the top level, one per `package.json` script: `start-app.mjs`, `make-icons.mjs`, `probe-recording.mjs`, `verify-recording.mts`, `run-matrix.mts`, `audio-quality.mts`, `acceptance-*.mts`, `create-signing-identity.mts`, `release.mts`, and `cleanup-release-keychain.py`.
- **`scripts/lib/`** for the shared implementation behind those entry points — acceptance runtime, verification and media tools, audio-quality analysis, release manifest clients.
- **`scripts/fixtures/`** for test doubles and injected stand-ins, plus `test-material.html`, the fixture played during sync and audio-quality runs.

Tools use `.mts`/`.mjs` because they run under Node directly rather than through the app's bundler. Their tests are ordinary `*.test.ts` files beside them.

## Documentation

| Path | Purpose |
| --- | --- |
| `docs/system-design/` | What the code does now. Completed plans are folded in here and then removed |
| `docs/verification/README.md` | Curated evidence: what was measured, with numbers and limitations |
| `docs/verification/releases/<version>.md` | Per-release verification facts |
| `docs/verification/measurements/` | Raw local runs written by `pnpm verify`, `matrix`, `acceptance*` and `audio:quality`. Gitignored; never a link target from committed documentation |
| `docs/zh-TW/` | Traditional Chinese mirror of `docs/` and of `CONTRIBUTING.md`, at the same relative paths |
| `plans/` | Unfinished work only, `<name>.md` with `<name>.zh-TW.md` beside it, indexed by `plans/README.md` |
| `resources/INSTALL.md` | Reader-facing install/update/removal guide, linked from releases and the README |

Translation follows two different rules by design: documentation under `docs/` mirrors into `docs/zh-TW/` at the same path, while plans and root guides keep the translation next to the original with a `.zh-TW.md` suffix. Keep every link valid relative to the file it appears in.

## Packaging inputs

- `build/` is electron-builder's `buildResources`: `icon.png`, the macOS `icon.icns`, and the DMG background pair `background.png` / `background@2x.png`. All of it is generated by `pnpm icons` from code.
- `resources/` holds what the app needs at runtime: the macOS tray template images, the Windows `.ico` pair (both also produced by `pnpm icons`), `entitlements.mac.plist`, and the bilingual install guide. The packaging filter copies only `*.png` and `*.ico`, so the entitlements file and the guide stay out of the shipped bundle.
- `electron-builder.yml` is the shared packaging configuration; `electron-builder.local.yml` extends it for free local self-signing. The `files` filter admits only `out/**` and `package.json`, which is why nothing under `src/`, `scripts/`, `docs/` or `plans/` can reach a user.

## Website

`website/` is a standalone Astro project, not a workspace member: it has its own `package.json`, `pnpm-lock.yaml` and `node_modules/`, and the root delegates to it with `pnpm site:dev`, `site:build`, `site:check`, `site:manifest` and `site:screenshots`.

| Path | Contents |
| --- | --- |
| `website/src/pages/` | Routes: `index`, `download`, `help`, `support`, and the `release.json` feed endpoint |
| `website/src/components/` | Page sections and marks, with `pages/` and `scenes/`, `heroes/` for larger compositions |
| `website/src/layouts/`, `styles/`, `themes/` | The shared layout, global and font CSS, and the ember theme |
| `website/src/content/site.ts`, `src/lib/` | Site copy and the release/text helpers behind it |
| `website/scripts/` | Manifest generation, release and link checks, screenshots, and their tests |
| `website/release-manifest.json` | The committed manifest the build verifies before publishing |
| `website/compare/` | Local screenshot comparisons; gitignored |

The app's update check reads this site's `release.json`, so `scripts/lib/release-manifest*.mts` is shared across the boundary and the website workflow watches it. See [delivery](delivery.md) for the ownership split.

## Automation and generated paths

`.github/workflows/release.yml` builds, signs, verifies and publishes on a `v*` tag push; `website.yml` deploys the site on website changes, on manual dispatch, or when called after a stable release. `.agents/skills/` and `.claude/skills/` hold development skill definitions and are not part of either deliverable.

Everything generated is ignored and rebuildable: `out/` from `pnpm build`, `dist/` from `pnpm start:app` and `pnpm dist:mac`, `website/dist/` and `website/.astro/` from the site build, `node_modules/` from `pnpm install`, and `docs/verification/measurements/` from local verification runs.

## What keeps the layout consistent

The structure is enforced by configuration, not convention alone:

| File | What it constrains |
| --- | --- |
| `tsconfig.node.json` / `tsconfig.web.json` | Which directories typecheck against Node/Electron versus DOM libraries; `src/shared/` appears in both |
| `vitest.config.ts` | Tests are found only under `src/` and `scripts/`, as `*.test.ts` |
| `electron.vite.config.ts` | The one main entry, two preload entries and two renderer HTML entries |
| `electron-builder.yml` | What is packaged (`out/**`, `package.json`) and which resources are copied |
| `.gitignore` | Generated output, raw measurements, and signing material stay untracked |
| `website/scripts/check-links.mts` | Link integrity for the published site |

## Where a new file goes

- Logic that touches Electron, the filesystem or the OS: `src/main/`, with the decision part extracted into a `*-model.ts` if it deserves a test.
- Types or pure functions both processes need: `src/shared/`, importing neither Electron nor DOM.
- Anything a user reads: `src/shared/i18n.ts`, in both languages.
- A tool you run by hand or from CI: `scripts/` as an entry point, with the logic in `scripts/lib/` so it can be tested.
- A durable conclusion about behavior: `docs/system-design/`, with the Traditional Chinese mirror updated in the same change.
- Evidence from a run: summarize in `docs/verification/README.md`; the raw output stays in the ignored `measurements/` directory.
- Work not yet finished: `plans/`, and remove the plan once the behavior is documented.
