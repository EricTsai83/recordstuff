# Repository Layout

[English](repository.md) | [繁體中文](../zh-TW/system-design/repository.md)

One repository holds two deliverables and the documentation for both: the Electron desktop app at the root, with its native capture engine under `native/capture/`, and the static website under `website/`. They share a Git history, a release flow and this documentation set, but nothing else — the website is a separate package with its own dependencies and lockfile, and the app never imports from it.

This document describes where things live and why. [Architecture](architecture.md) explains process boundaries and data ownership, [the function reference](functions.md) covers individual modules, and [tooling](tooling.md) covers the commands that act on these directories.

## Top level

| Path | What it holds |
| --- | --- |
| `src/` | Application source, split by Electron process |
| `native/capture/` | The native capture engine, a Rust crate built into the app as `recordstuff-capture.node` ([below](#native-capture-engine)) |
| `scripts/` | Developer tools: build/launch, signing, release, recording verification and acceptance |
| `tests/` | Cross-process tests that need both browser DOM and Node APIs, and the source-boundary check |
| `docs/` | System design, verification evidence, and the Traditional Chinese mirror |
| `plans/` | Execution plans for unfinished work only |
| `resources/` | Runtime assets copied into the app, plus the installation guide |
| `build/` | Packaging artwork consumed by electron-builder |
| `website/` | The Astro site published at record.ericts.com; its own package |
| `.github/workflows/` | Checks, release and website deployment automation |
| `.agents/`, `.claude/` | Agent skill definitions used during development |
| Root configs | `package.json`, `tsconfig*.json`, `electron.vite.config.ts`, `vitest.config.ts`, `electron-builder*.yml` |
| Root guides | `README.md`, `CONTRIBUTING.md`, `AGENTS.md`/`CLAUDE.md`, `LICENSE`, and the `*.zh-TW.md` translations |
| `out/`, `dist/`, `node_modules/`, `native/capture/target/` | Generated; ignored by Git and rebuildable |

## Application source

`src/` is divided first by Electron process, then by module inside each process. The process decides which APIs a file may use, so that boundary comes first; the module folder says which part of the app a file belongs to and what it may depend on.

| Directory | Runs in | Contents |
| --- | --- | --- |
| `src/main/` | Main process, and the capture `utilityProcess` | `index.ts`, the composition root that builds and wires every module, and one folder per module ([below](#main-process-modules)); `recording/native-host-process.ts` is the second main-side entry, run in the capture process |
| `src/renderer/` | Renderer processes | The three HTML entries (`settings.html`, `countdown.html`, `video.html`) and `ui.css`, the shared tokens and feature layout, at the top; one folder per page and the parts pages share ([below](#renderer-pages)) |
| `src/preload/` | Preload, sandboxed | One file per renderer: `settings.ts` carries the settings panel's IPC contract; `countdown.ts` exposes the overlay value subscription and its unsubscribe; `video.ts` carries fullscreen ready/exit |
| `src/shared/` | Both | State (`state.ts`), the capture host protocol, recording quality arithmetic, the settings-panel contract, display preferences, appearance, shortcut validation, and translations (`i18n.ts`) |

### Main process modules

| Folder | What it owns |
| --- | --- |
| `lib/` | Process-wide helpers that know no feature: atomic file replacement, the write-drain queue, reading errors, the file log, and the app name |
| `recording/` | One recording session end to end: the state machine (`recorder.ts`), supervision of the native engine's capture host (`native-capture-host.ts`) and the host process itself (`native-host-process.ts`), keeping RecordStuff's windows out of capture on Windows (`capture-exclusion.ts`), file reservation and publication (`engine-file-writer.ts`, `file-writer.ts`), health thresholds, interruption sentinels, session log lines, the countdown overlay, keep-awake, capture and saved notices, the result history (`recording-result*.ts`), the preference lock (`recording-lock.ts`) and development-only unattended recording (`autorecord.ts`) |
| `display/` | Which screen a recording uses (`display-source.ts`), and the display each attempt records, main's refusal reason and the display diagnostic (`display-media.ts`) |
| `permission/` | Screen-recording permission detection and its notices |
| `library/` | The recordings on disk: the Recordings tab's library, MP4 duration, the output folder and the full-screen video window |
| `editing/` | Cutting a recording (plan 085): the edit view's owner (`editing.ts`), edit records (`edit-store.ts`), the export worker's supervisor (`export-host.ts`) and the worker itself (`export-process.ts`) |
| `sharing/` | Sharing a recording (plan 100): the versions a drag gives (`sharing.ts`), prepared ahead in the export worker, and the cache they are made into (`version-cache.ts`) |
| `shortcuts/` | Global shortcut registration: the recording key and the Settings key |
| `app/` | App-wide vocabulary and lifecycle: the action and context both interfaces share (`ui-model.ts`), quitting and its feedback, Windows session end, reopening, uncaught faults, local data cleanup and update checks |
| `settings/` | Preferences and their window: the persisted store, preference side effects, the panel model, the window and its saved size |
| `menus/` | The tray (`tray.ts` with `tray-model.ts`) and the application menu |
| `actions/` | What every `AppAction` does (`actions.ts`): the quit gate, each preference's lock and every command, with the collaborators `index.ts` passes in |

### Renderer pages

| Folder | What it holds |
| --- | --- |
| `settings/` | The settings page: its entry, the shell (`settings-app.tsx`), one module per tab in `tabs/`, the undo and zoom toasts, the controller (`settings-controller.ts`, one surface over `controller/`, kept by concern), and the page's tests |
| `countdown/` | The countdown digit and its own `countdown.css` |
| `video/` | The full-screen video page |
| `player/` | The playback controls the settings page and the video page share |
| `components/ui/` | shadcn/ui primitives; an app difference is a variant or prop, noted at the top of the file |
| `lib/` | Page-independent helpers: `cn` (`utils.ts`), React mounting and shortcut capture |
| `testing/` | Input helpers for renderer tests only |

## Native capture engine

`native/capture/` is a Rust crate (`Cargo.toml`, `Cargo.lock`, and `build.rs`, which sets up napi-rs and translates `shaders/compose.wgsl`, plan 075's camera compositor, with naga to MSL and HLSL) built as a `cdylib`, which the build copies to `out/native/recordstuff-capture.node`, and as an `rlib` for its tests. Only `src/main/recording/native-host-process.ts` loads it, in the capture `utilityProcess` ([architecture](architecture.md#processes-and-responsibilities)).

| Path under `src/` | What it holds |
| --- | --- |
| `lib.rs` | The N-API surface: the `NativeCapture` class (`probe`, `prepare`, `record`, `stop`, `finish`, `cancel`, `microphones`), its option and report objects, and the event callback |
| `core/` | One session whatever captures it (`mod.rs`: phases, which frames are encoded, the sound up to the stop, the file), the audio mixer (`mixer.rs`) and their tests with fake encoders (`tests.rs`) |
| `pacing.rs`, `timing.rs` | The frame-rate grid (`Pacer`); the session clock and sample-counted audio placement (`AudioAligner`) |
| `writer.rs` | The writer thread that owns the file and the muxer, its sync, progress, backlog bound and error classification |
| `mux/` | ISO BMFF boxes (`boxes.rs`), the hybrid MP4 (`mp4.rs`), a recording's fragmenting (`session.rs`) and a test-only reader (`parse.rs`) |
| `edit/`, `export_api.rs` | Cutting a recording (plan 085): the bounded reader of the engine's own MP4 (`source.rs`), the cut plan and sound layout (`plan.rs`), the remux (`remux.rs`); the N-API `NativeExport` class the export worker loads |
| `avc.rs`, `aac.rs`, `nv12.rs` | H.264 Annex B to MP4 form, the AAC AudioSpecificConfig, BGRA to NV12 on the CPU |
| `mac/` | macOS only: ScreenCaptureKit session and content filters, VideoToolbox, AudioToolbox, the AVFoundation microphone |
| `win/` | Windows only: Windows.Graphics.Capture, Media Foundation H.264 and AAC, WASAPI sound |

Inside the crate, dependencies point one way by convention, not by a test: `timing` ← `pacing`; `mux` (`boxes` ← `mp4` ← `session`) ← `writer` ← `core` ← `mac`, `win` ← `lib.rs`. `core` never names a platform; `mac/` and `win/` compile only on their own platform. Platform-independent tests run everywhere with `pnpm test:native` (`cargo test --lib`); `live_test.rs` in each platform folder captures for real and is ignored unless asked for by name.

## Module boundaries

Imports between folders point one way, so a folder's place in this order is its contract:

```text
main:      lib ← recording, display, permission, library, shortcuts, editing ← sharing ← app ← settings ← menus ← actions ← index.ts
renderer:  lib ← components ← player ← countdown, settings, video
scripts:   runner, release ← verification ← audio;  runner, verification ← acceptance ← fixtures ← entry points
```

- **Feature folders** (`recording/`, `display/`, `permission/`, `library/`, `shortcuts/`, `editing/`) import only `lib/`, `src/shared/` and themselves, never each other. When two of them need the same thing, it moves down into `lib/` or `src/shared/`, or `index.ts` connects them.
- **`sharing/`** (plan 100) sits on `editing/` and `library/`: it makes versions of a recording from its edit, in the edit view's export worker, so it reads both; nothing below it imports it.
- **`app/`** may use the feature folders. `settings/` may also use `app/`, `menus/` may also use `settings/`, and `actions/` may use all of them. Nothing imports upward.
- **Nothing imports `index.ts`.** It is the composition root; what an action does lives in `actions/`, so the root only builds and wires. The update and controlled acceptance runners patch a copy of it by text anchors, which is one more reason it stays at the top of `src/main/`.
- **Renderer pages do not import one another.** What two pages share lives in `player/`, `components/` or `lib/`. Only tests import `testing/`. `camera-preview/`, plan 075 step 2's measurement page behind its development switch, imports only `src/shared/`.
- **The HTML entries stay at the top of `src/renderer/`,** so the built pages remain `out/renderer/<name>.html`, where main and the fixtures load them.
- **The native engine is outside the TypeScript import graph.** Nothing imports it; `native-host-process.ts` `require`s it at run time from the path main passes, and `scripts/native-load.mjs` loads it only to check its methods. Its TypeScript-facing shape is declared by hand in `native-host-process.ts` and checked by `native-load.mjs`'s method list.
- **Developer tools never reach into the app's import graph.** Nothing in `src/` imports `scripts/`. Inside `scripts/lib/`, `runner/` and `release/` import no other group; `verification/` builds on them, `audio/` on `verification/`, and `acceptance/` on `runner/` and `verification/`. Fixtures import only `src/`, `scripts/lib/` and other fixtures, and nothing in `scripts/lib/` imports an entry point.

[`tests/source-boundaries.test.ts`](../../tests/source-boundaries.test.ts) enforces these rules for `src/` and `scripts/` in `pnpm test`. A new folder needs its place in that test before its files may import anything. Test files may reach across folders for their fixtures, but never into `index.ts`.

Four conventions hold across this tree:

- **`src/shared/` stays environment-neutral.** It is the only directory included by both `tsconfig.node.json` and `tsconfig.web.json`, so it must import neither Electron nor DOM APIs.
- **Tests sit next to their source** as `foo.test.ts`. The Settings page's own tests, which drive the whole page through its DOM and need a file each because each imports the page once, sit together in `src/renderer/settings/page-tests/`, so the folder's sources stay readable. The other exceptions are `tests/`, for cross-process tests that need both browser DOM and Node APIs, and `tests/ui/`, the background Playwright suite: its specs, fixtures, the Electron hosts its global setup compiles (`tests/ui/hosts/`), reviewed screenshot baselines and checked-in test clips (`tests/ui/media/`); `tsconfig.tests.json` checks it so the renderer config stays free of Node types. `vitest.config.ts` collects `src/**/*.test.ts`, `scripts/**/*.test.ts` and `tests/**/*.test.ts`.
- **`*-model.ts` separates decisions from side effects.** `tray.ts`, `settings.ts` and `settings-window.ts` talk to Electron; `tray-model.ts`, `settings-model.ts` and `ui-model.ts` are pure projections that can be tested without a window. `recorder.ts` follows the same rule with injected collaborators.
- **User-visible text lives in `src/shared/i18n.ts`,** in English and Traditional Chinese together, never inline in a module.

## Developer tooling

`scripts/` holds everything that supports development but ships with nothing:

- **Entry points** at the top level, mostly one per `package.json` script: `start-app.mjs`, `make-icons.mjs`, `probe-recording.mjs`, `verify-recording.mts`, `run-matrix.mts`, `audio-quality.mts`, `measure-cpu.mts`, `measure-finalization.mts`, `bench-publication.mts`, `acceptance-*.mts`, `preview-ui.mts`, `test-scope.mts`, `native-load.mjs` (loads the built or installed engine and checks its methods; part of `pnpm check` and the Windows installer smoke), `create-signing-identity.mts`, `release.mts`, and `cleanup-release-keychain.py`. `test-material.html`, the page played during sync and audio-quality runs, sits beside them.
- **`scripts/lib/`** for the shared implementation behind those entry points, grouped by purpose: `runner/` (what every desktop runner shares: processes, the scrubbed environment, desktop sessions, round exits, native accessibility, fixture builds, the log reader and session records, timing and the bundle's runtime inputs), `acceptance/` (each acceptance runner's own logic), `verification/` (recording verification, the matrix, playback, media tools, finalization and CPU measurement), `audio/` (audio-quality analysis) and `release/` (the release manifest and its client, which the website also imports).
- **`scripts/fixtures/`** for test doubles and injected stand-ins.

Tools use `.mts`/`.mjs` because they run under Node directly rather than through the app's bundler. Their tests are ordinary `*.test.ts` files beside them.

## Documentation

| Path | Purpose |
| --- | --- |
| `docs/system-design/` | What the code does now. Completed plans are folded in here and then removed |
| `docs/verification/README.md` | Curated evidence: what was measured, with numbers and limitations |
| `docs/verification/releases/<version>.md` | Per-release verification facts |
| `docs/verification/measurements/` | Raw local runs written by `pnpm verify`, `matrix`, `acceptance*` and `audio:quality`. Gitignored; never a link target from committed documentation |
| `docs/learning/` | Standalone HTML articles that teach transferable design patterns with this project as the worked example; design rationale, not current behavior. Written in the language they were requested in and not mirrored; indexed by `docs/learning/README.md` |
| `docs/zh-TW/` | Traditional Chinese mirror of `docs/` and of `CONTRIBUTING.md`, at the same relative paths |
| `plans/` | Unfinished work only, `<name>.md` with `<name>.zh-TW.md` beside it, indexed by `plans/README.md` |
| `resources/INSTALL.md` | Reader-facing install/update/removal guide, linked from releases and the README |

Translation follows two different rules by design: documentation under `docs/` mirrors into `docs/zh-TW/` at the same path, while plans and root guides keep the translation next to the original with a `.zh-TW.md` suffix. Keep every link valid relative to the file it appears in.

## Packaging inputs

- `build/` is electron-builder's `buildResources`: `icon.png`, the macOS `icon.icns`, the Windows `icon.ico`, and the DMG background pair `background.png` / `background@2x.png`. All of it is generated by `pnpm icons` from code.
- `resources/` holds what the app needs at runtime: one macOS tray template image (with `@2x`) and one Windows `.ico` per tray state — idle, busy, countdown, recording, warning (all produced by `pnpm icons`, which `scripts/make-icons.test.ts` checks byte for byte) — `entitlements.mac.plist`, and the bilingual install guide. The packaging filter copies only `*.png` and `*.ico`, so the entitlements file and the guide stay out of the shipped bundle.
- `electron-builder.yml` is the shared packaging configuration, including the `win`/`nsis` sections of the unsigned Windows installer; `electron-builder.local.yml` extends it for free local self-signing. The `files` filter admits only `out/**` and `package.json`, which is why nothing under `src/`, `native/`, `scripts/`, `docs/` or `plans/` can reach a user. `asarUnpack: out/native/**` keeps the engine outside the asar archive, since native code cannot load from inside it; on macOS electron-builder signs it with the app ([architecture](architecture.md#packaging-and-signing-the-engine)).

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

The app's update check reads this site's `release.json`, so `scripts/lib/release/release-manifest*.mts` is shared across the boundary and the website workflow watches it. See [delivery](delivery.md) for the ownership split.

## Automation and generated paths

`.github/workflows/check.yml` runs `pnpm check` (Cargo tests and the engine's load included), the background UI suite and its drills on both platforms, the Windows installer, and the `native-windows` job's live engine recordings; `release.yml` builds, signs, verifies and publishes on a `v*` tag push, compiling the engine from source without a cache; `website.yml` deploys the site on website changes, on manual dispatch, or when called after a stable release. `.agents/skills/` and `.claude/skills/` hold development skill definitions and are not part of either deliverable. Claude Code uses only `.claude/skills/` and the other agents use `.agents/skills/`, so a skill both need keeps a separate copy in each directory.

Everything generated is ignored and rebuildable: `out/` from `pnpm build` (with `out/native/recordstuff-capture.node` from Cargo on macOS and Windows unless `RECORDSTUFF_SKIP_NATIVE=1`), `native/capture/target/` from Cargo, `dist/` from `pnpm start:app` and `pnpm dist:mac`, `website/dist/` and `website/.astro/` from the site build, `node_modules/` from `pnpm install`, and `docs/verification/measurements/` from local verification runs.

## What keeps the layout consistent

The structure is enforced by configuration, not convention alone:

| File | What it constrains |
| --- | --- |
| `tsconfig.node.json` / `tsconfig.web.json` | Which directories typecheck against Node/Electron versus DOM libraries; `src/shared/` appears in both. |
| `tsconfig.tests.json` | `tests/` typechecks against both DOM and Node libraries, separately from the renderer |
| `vitest.config.ts` | Tests are found only under `src/`, `scripts/` and `tests/`, as `*.test.ts` |
| `electron.vite.config.ts` | The main entries (`index.ts` and the native engine's `native-host-process.ts`), three preload entries (`settings`, `countdown`, `video`) and three renderer HTML entries, plus the Cargo build of `native/capture` copied to `out/native/` |
| `native/capture/Cargo.toml` | The crate's types (`cdylib`, `rlib`), napi-rs, and the platform-gated macOS and Windows bindings |
| `tests/source-boundaries.test.ts` | Which module folders in `src/` and `scripts/` may import which ([module boundaries](#module-boundaries)) |
| `electron-builder.yml` | What is packaged (`out/**`, `package.json`), what stays outside the asar archive (`out/native/**`) and which resources are copied |
| `.gitignore` | Generated output, raw measurements, and signing material stay untracked |
| `website/scripts/check-links.mts` | Link integrity for the published site |

## Where a new file goes

- Logic that touches Electron, the filesystem or the OS: the `src/main/` folder of the module it belongs to, with the decision part extracted into a `*-model.ts` if it deserves a test. A new module gets its own folder and its place in [the boundaries](#module-boundaries).
- A new renderer page: its own folder under `src/renderer/`, with its HTML entry at the top of `src/renderer/` and in `electron.vite.config.ts`.
- Types or pure functions both processes need: `src/shared/`, importing neither Electron nor DOM.
- Capture, encoding or file-format code: the folder of `native/capture/src/` it belongs to, platform-independent where it can be, with its test beside it; a new engine method also goes into `native-host-process.ts`'s declaration and `native-load.mjs`'s method list.
- Anything a user reads: `src/shared/i18n.ts`, in both languages.
- A renderer style ([three layers](desktop.md#settings-window)): a colour is a token in `ui.css` (`:root` and `.dark`); a change to a primitive is a variant or prop in `components/ui/`; a page's own layout is utilities at the call site or a rule in `ui.css`'s `@layer components`. A size is a token too: spacing `--spacing(n)` (Tailwind's numeric names in TSX), type `var(--text-*)`, corners `var(--radius-*)` ([scale](desktop.md#settings-window), plan 102). `tests/style-guard.test.ts` keeps colours, pixel sizes outside its listed geometry and `[data-slot]` selectors out of the rest.
- A tool you run by hand or from CI: `scripts/` as an entry point, with the logic in the `scripts/lib/` group it belongs to so it can be tested.
- A durable conclusion about behavior: `docs/system-design/`, with the Traditional Chinese mirror updated in the same change.
- Evidence from a run: summarize in `docs/verification/README.md`; the raw output stays in the ignored `measurements/` directory.
- Work not yet finished: `plans/`, and remove the plan once the behavior is documented.
