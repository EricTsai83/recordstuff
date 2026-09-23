# Agent instructions

## Working on changes

- Use `pnpm` for this repository. For setup, code navigation, and documentation conventions, consult the relevant sections of [CONTRIBUTING.md](CONTRIBUTING.md). Its external contribution steps (forking, opening issues, and submitting PRs) are not prerequisites for user-requested local work.
- Run `pnpm check` after application changes. For documentation-only changes, check affected links and run `git diff --check`. See [verification guidance](CONTRIBUTING.md#verify-your-change) for recording-specific checks.
- Automated checks do not prove screen or system-audio capture works. Report which recording behaviors were actually tested and which remain unverified.

## Operating the app

- RecordStuff runs in the menu bar without a normal main window; do not treat the absence of a window as a launch failure.
- Before quitting or rebuilding a running app, check whether it is recording. Do not interrupt a user's recording without their permission; stop and save recordings you started before closing the app.
- After each complete app acceptance round, including failures or interruption, restore changed settings, close test UI, quit the tested app normally, and confirm its processes have exited. Leave it closed for the next run or rebuild. Report incomplete cleanup as a failure or blocker; unit checks and intermediate UI-entry commands do not close unrelated apps.
- For native UI acceptance, use the project [computer-use acceptance skill](.agents/skills/astra-acceptance-with-computer-use/SKILL.md). Build and signing details belong in the [tooling guide](docs/system-design/tooling.md).

## Task-specific references

- When executing or updating a plan, follow [plans/README.md](plans/README.md) for order, status, and completion handling.
- When preparing a release, follow [release automation](docs/system-design/releases.md). Pushing a version tag triggers public publication.
- Do not commit, push, open a PR, or publish unless the user requests it.
