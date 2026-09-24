# 039 — Repository hygiene: layout documentation and test placement

[English](039-repository-hygiene.md) | [繁體中文](039-repository-hygiene.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-25. First in the queue: documentation and file moves only, minutes of work, and it removes drift that later plans would otherwise re-edit. Execution order: see [queue](README.md#order-and-status).

## Scope and evidence

A 2026-09-25 review of the tree found the layout itself sound: `src/` is split by process with no cross-process imports, `src/shared/` imports neither Electron nor DOM, generated paths are ignored, and the layout is enforced by the tsconfig pair and the vitest config. Four small things no longer match it.

- [Repository layout](../docs/system-design/repository.md) predates commit `2e38f68`. Line 40 says there is no separate test tree and line 103 says tests are found only under `src/` and `scripts/`, but `tests/capture-protocol.test.ts` exists, `vitest.config.ts` includes `tests/**`, and `tsconfig.tests.json` is missing from the enforcement table at line 102. Line 50 places `test-material.html` under `scripts/fixtures/`; the file lives at `scripts/test-material.html`, and every script and document references that path. The [Traditional Chinese mirror](../docs/zh-TW/system-design/repository.md) has the same four lines. [CONTRIBUTING.md](../CONTRIBUTING.md) already describes `tests/` correctly.
- `.claude/skills/claude-implement-with-gpt6-astra-review/SKILL.md` is byte-identical to `.agents/skills/claude-implement-with-gpt6-astra-review/SKILL.md`; two copies will drift.
- `scripts/update-acceptance.test.ts` tests `scripts/lib/update-acceptance.mts`, and `scripts/lib/settings-entry.test.ts` tests `scripts/lib/acceptance.mts`, which already has `acceptance.test.ts`. Both break the tests-beside-source convention the layout document states.
- Root `tsconfig.json` references only the node and web configs. `pnpm typecheck` runs the tests config explicitly, so results are unaffected, but editor project references miss it.

Not in scope: feature subdirectories under `src/main/`, renaming same-basename files across processes, grouping `scripts/acceptance-*.mts`, turning `website/` into a workspace, or adopting a linter or Effect. Each was considered in the same review and rejected as cost above benefit at the current size.

## Implementation contract

- [ ] Update both repository layout documents: state that `tests/` holds cross-process tests checked by `tsconfig.tests.json` and collected by `vitest.config.ts`, add `tsconfig.tests.json` to the enforcement table, and move the material page to the `scripts/` entry-point list. Keep every link valid relative to the file it appears in.
- [ ] Replace the `.claude/skills/…` copy with a relative symlink to the `.agents/skills/…` file. Confirm the skill still loads by name before removing the copy; if it does not, keep one copy and add a one-line note in each pointing to the other. A Windows checkout without `core.symlinks` sees a text file holding the path; acceptable, because skills are not build inputs.
- [ ] Move `scripts/update-acceptance.test.ts` to `scripts/lib/update-acceptance.test.ts` and fold `scripts/lib/settings-entry.test.ts` into `scripts/lib/acceptance.test.ts`, fixing relative imports. Add the tests config to the root `tsconfig.json` references.

## Verification and completion

Documentation and test placement only: run `pnpm typecheck` and `pnpm test` to prove the moved tests still run with the same test count, check affected links/anchors, and run `git diff --check`. No app launch, packaging or recording. Follow [plan completion](README.md#completing-a-plan) and remove this plan and its translation when done. Do not commit, push or publish without a separate request.
