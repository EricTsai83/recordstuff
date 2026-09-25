# Agent instructions

## Working on changes

- Use `pnpm` for this repository. For setup, code navigation, and documentation conventions, consult the relevant sections of [CONTRIBUTING.md](CONTRIBUTING.md). Its external contribution steps (forking, opening issues, and submitting PRs) are not prerequisites for user-requested local work.
- Before choosing tests, read the [shared testing policy](docs/testing.md). Classify the diff by affected behavior and dependencies, combine applicable rows, and state required checks plus reasons for omitting expensive checks. Use the same policy for human and AI work; do not infer scope from filenames alone.
- Run `pnpm check` after application changes (already included in `pnpm acceptance:regression`). Documentation-only work checks affected links/anchors, commands and translations plus `git diff --check`; do not launch the app or record for documentation alone.
- Report checks/results, scope-based exclusions, and required-but-unverified cases separately. Missing tools or permissions mean blocked, not not-applicable; a user waiver remains untested. Stop after required checks pass unless another edit, failure or unresolved concern warrants more testing.
- Follow the testing policy’s shared-machine rules: serialize builds consuming the same `out/`/`dist/`, and give one executor exclusive use of the desktop/audio/global shortcuts for each acceptance round.
- When a task will need a desktop round (Electron fixtures, native acceptance or recording), start `caffeinate -d -i -t 5400` (1.5 hours) in the background before the first edit, and stop it after the final round's cleanup or when the task ends early; report that it ran. It only keeps an unattended session from idling into a lock between rounds: it never unlocks a locked session, and the testing policy's lock rules still apply. Skip it when the maintainer wants the normal auto-lock.
- Automated checks do not prove screen or system-audio capture works. Report which recording behaviors were actually tested and which remain unverified.

## Operating the app

- RecordStuff runs in the menu bar without a normal main window; do not treat the absence of a window as a launch failure.
- During development, you may stop recordings and quit, restart or rebuild RecordStuff as needed without asking for confirmation. The development app is available for testing; do not treat possible active use as a blocker.
- After each complete app acceptance round, including failures or interruption, restore changed settings, close test UI, quit the tested app normally, and confirm its processes have exited. Leave it closed for the next run or rebuild. Report incomplete cleanup as a failure or blocker; unit checks and intermediate UI-entry commands do not close unrelated apps.
- For native UI acceptance, use the project [computer-use acceptance skill](.agents/skills/astra-acceptance-with-computer-use/SKILL.md). Build and signing details belong in the [tooling guide](docs/system-design/tooling.md).

## Task-specific references

- When executing or updating a plan, follow [plans/README.md](plans/README.md) for order, status, and completion handling.
- When preparing a release, follow [release automation](docs/system-design/releases.md). Pushing a version tag triggers public publication.
- Do not commit, push, open a PR, or publish unless the user requests it.
