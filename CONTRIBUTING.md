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

Keep a change focused on the problem it addresses and follow the surrounding code's conventions. Tests live alongside the source as `*.test.ts`. Add or update tests when behavior changes; for a bug fix, cover the regression where practical.

App messages live in `src/shared/i18n.ts`. When adding or changing a message, update the English and Traditional Chinese entries and keep named placeholders consistent. When changing documented behavior or commands, update the relevant documentation and its existing translation. Keep document links valid relative to each file.

## Verify your change

For application changes, run:

```bash
pnpm check
```

This runs TypeScript checks, Vitest tests, and the production build. You can run `pnpm typecheck`, `pnpm test`, or `pnpm build` separately while developing. Before submitting any change, run `git diff --check`; for documentation-only edits, also check the affected links and commands.

For recording changes, make a recording and check that starting, stopping, saving, and playback work. Note your OS, hardware, settings, and any cases you could not test. Automated checks alone do not verify actual screen and system-audio capture.

FFmpeg and ffprobe are needed for developer media analysis, not to run the app. For example:

```bash
pnpm probe -- /absolute/path/recording.mp4
pnpm verify -- /absolute/path/recording.mp4 --screen 1920x1080 --sync --out
```

Use your actual source dimensions for `--screen`; sync analysis needs the test material described in the [tooling guide](docs/system-design/tooling.md). That guide also covers the recording matrix and audio fidelity checks. Keep new measurements separate from historical results and state any verification limitations.

## Submit a pull request

Commit your changes, push your branch to your fork or the repository, and open a pull request against the default branch. Include:

- The problem being solved and a related issue, if one exists.
- What behavior changes and any design choices a reviewer needs to understand.
- Checks you ran and their results, including relevant manual recording checks and untested cases.
- Screenshots or a short recording when they help demonstrate a visible change.

Keep unrelated cleanup in separate changes so reviewers can assess the contribution. If review leads to further edits, rerun the checks affected by those edits and update the PR description with the final behavior and verification results.
