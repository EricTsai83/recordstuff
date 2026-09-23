# Contributing

[English](CONTRIBUTING.md) | [繁體中文](docs/zh-TW/CONTRIBUTING.md)

You can contribute by reporting bugs, improving documentation and translations, adding tests, or fixing and extending the app.

## Report a bug or propose a change

For bugs, include steps to reproduce, expected and actual behavior, the app version or commit, and your OS version and hardware. For recording issues, also include display resolution, quality settings, and the audio output device. Attach relevant logs or a short sample when useful, after removing private information. On macOS, `pnpm log` follows the application log.

For a feature or a substantial design change, open an issue describing the problem and proposed behavior so the scope can be discussed before implementation. The [system design](docs/system-design/README.md) and [remaining plans](plans/README.md) provide context for existing behavior and work in progress.

## Set up development

1. Fork the repository if you do not have write access, then clone your fork.
2. Install Node.js and pnpm. The project requires Node ≥22.12; use Node 24 if you will run the TypeScript measurement scripts.
3. Install dependencies and create a branch for your change:

   ```bash
   pnpm install
   git switch -c fix/describe-your-change
   ```

4. Start the development app:

   ```bash
   pnpm dev
   ```

Only macOS has been verified so far. On macOS, `pnpm start` builds and opens the development Electron app and is useful for recording checks. Grant screen/system-audio recording permission when prompted; when using `pnpm dev`, permission may be associated with the launching terminal or editor. Relaunch if a permission change has not taken effect.

For testing a packaged macOS app, `pnpm start:app` builds, self-signs, verifies, and opens a local bundle. This requires a local code-signing identity; see [build and verification tooling](docs/system-design/tooling.md) for setup details. Packaging is not required for ordinary source edits.

## Find the relevant code

| Location | Responsibility |
| --- | --- |
| `src/main/` | App lifecycle, recording coordination, file writing, permissions, settings, tray, and logs |
| `src/renderer/` | Hidden capture host, media streams, and encoding |
| `src/preload/` | MessagePort handoff |
| `src/shared/` | State, message protocol, recording quality, and translations |
| `scripts/` | Build, signing, and recording verification tools |
| `docs/system-design/` | Architecture and module documentation |
| `website/` | The Astro site, a separate package run through the root `pnpm site:*` scripts |

[Repository layout](docs/system-design/repository.md) covers the rest of the tree — packaging inputs, documentation, generated paths, and the configuration that enforces the structure.

Keep a change focused on the problem it addresses and follow the surrounding code's conventions. Tests live alongside the source as `*.test.ts`. Add or update tests when behavior changes; for a bug fix, cover the regression where practical.

App messages live in `src/shared/i18n.ts`. When adding or changing a message, update the English and Traditional Chinese entries and keep named placeholders consistent. When changing documented behavior or commands, update the relevant documentation and its existing translation. Keep document links valid relative to each file.


Keep all execution plans in the root `plans/` directory: `<name>.md` for English and `<name>.zh-TW.md` for Traditional Chinese. Their indexes are `plans/README.md` and `plans/README.zh-TW.md`; other translated documentation remains under `docs/zh-TW/`.

## Verify your change

Use the [shared testing policy](docs/testing.md) to select checks by behavior, including what can be omitted. It applies equally to contributors and AI agents.

| Typical change | Starting point |
| --- | --- |
| Documentation only | Check affected links/anchors, commands and translations; `git diff --check`. No app launch or recording |
| App code | `pnpm check` (TypeScript, Vitest, production build), plus impact-specific checks from the policy |
| Settings / shortcut integration | `pnpm acceptance:regression`, which already includes `pnpm check`; inspect affected UI/screenshots |
| Recording behavior | `pnpm check`, then a fresh `pnpm start:app` bundle and the [recording smoke cases](docs/acceptance.md). `pnpm acceptance` automates start/stop/save/verify; observe playback separately |
| Website | `pnpm site:check`; inspect affected pages for visual edits |

Run `git diff --check` for every change. During development, use `pnpm typecheck`, `pnpm test` or `pnpm build` separately as useful; do not repeat checks already covered by a successful composite command on the final revision.

The [acceptance guide](docs/acceptance.md) defines shared cases, cleanup and reporting. The [tooling guide](docs/system-design/tooling.md) covers signing, FFmpeg/ffprobe, media analysis and specialized runners. Complete app rounds leave the tested app closed after saving, restoring settings and confirming exit. During development, stopping recordings and quitting/restarting/rebuilding RecordStuff as needed is authorized without additional confirmation.

Report actual checks, scope-based exclusions, and required-but-unverified cases separately. Automated checks do not prove screen/system-audio capture. Raw results under `docs/verification/measurements/` are gitignored and local; preserve durable conclusions through the [verification index](docs/verification/README.md).

## Releasing (maintainers)

Contributors do not need to release. Maintainers verify a pushed commit locally, then push a `vX.Y.Z` tag; the tag is the version. GitHub Actions builds, signs, verifies, publishes, re-verifies the public download and records the release facts back on main. The checklist, version rules and failure handling are in [GitHub release automation](docs/system-design/releases.md).

## Submit a pull request

Commit your changes, push your branch to your fork or the repository, and open a pull request against the default branch. Include:

- The problem being solved and a related issue, if one exists.
- What behavior changes and any design choices a reviewer needs to understand.
- Checks you ran and their results, including relevant manual recording checks and untested cases.
- Screenshots or a short recording when they help demonstrate a visible change.

Keep unrelated cleanup in separate changes so reviewers can assess the contribution. If review leads to further edits, rerun the checks affected by those edits and update the PR description with the final behavior and verification results.
