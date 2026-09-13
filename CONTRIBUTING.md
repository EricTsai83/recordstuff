# Contributing and Translations

[English](CONTRIBUTING.md) | [繁體中文](docs/zh-TW/CONTRIBUTING.md)

English is the source language for this repository: README, system design, plans, developer instructions, code comments, diagnostics, and new issue/PR descriptions. Traditional Chinese is supported through explicit translations, not mixed-language canonical documents.

## Documentation layout

| English source | Traditional Chinese translation |
| --- | --- |
| README.md | README.zh-TW.md |
| CONTRIBUTING.md | docs/zh-TW/CONTRIBUTING.md |
| docs/system-design/*.md | docs/zh-TW/system-design/*.md |
| docs/verification/README.md | docs/zh-TW/verification/README.md |
| plans/*.md | docs/zh-TW/plans/*.md |
| resources/INSTALL.md | resources/INSTALL.zh-TW.md |

Pair every reader-facing document with a language switch at the top. Update both versions for behavior, scope, command, or path changes. English is authoritative if translations diverge. Links to code must resolve from each language's directory. Machine-readable identifiers, paths, commands, and hashes stay unchanged.

Historical raw measurement files retain their original language and values as evidence; they are explicitly marked as original records and explained by the bilingual verification summary. Chinese strings are also expected in translation catalogs, localization assertions, and intentional CJK rendering fixtures. Do not translate identifiers or alter historical measurements merely to remove non-ASCII text.

## Application localization

English messages are typed keys in src/shared/i18n.ts, with matching Traditional Chinese templates in ZH_TW. Use named placeholders rather than assembling translated fragments. English is the default regardless of OS locale. Language changes are persisted only after a successful settings write.

Localize menu/tooltip/dialog/notification and user-recovery text. Keep machine diagnostics and new measurement output English so reports can be compared. Do not embed raw technical diagnostics into localized error summaries; details remain in logs. Native OS dialogs follow the OS locale.

For a new message, add both languages and test placeholder parity. For a new setting, test old-file defaults, persistence, failed saves, and concurrent updates when relevant. Tests should cover actual behavior rather than snapshots of the entire implementation.

## Development and documentation checks

Run `pnpm check` after application changes and `git diff --check` before handoff. Verify local document links and paired translations after moving files. Media changes need appropriate capture/measurement checks; document hardware limitations honestly. Publishing a build and creating release assets belong to the explicit delivery plan, not routine documentation maintenance.

Keep lasting product/design/evidence in docs. Plans contain unfinished work only; on completion move durable conclusions into design/verification, remove the completed plan and its translation, and update the indexes. Do not commit, push, or publish unless requested.
