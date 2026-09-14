# Remaining Work

[English](README.md) | [繁體中文](../docs/zh-TW/plans/README.md)

Updated: 2026-09-15. Completed plans have been replaced by the [system design](../docs/system-design/README.md) and [verification record](../docs/verification/README.md). Windows verification and Apple-certified distribution were canceled by the user. The speculative roadmap was removed from execution planning; current boundaries and evolution triggers remain in the design decisions.

Current execution: v0.1.0 is public; candidate checks passed with a Finder foreground limitation. Browser-download installation remains pending. See [release evidence](../docs/verification/releases/0.1.0.md).

## Order and status

| Order | Plan | Status | Completion target |
| --- | --- | --- | --- |
| 1 | [010 Downloadable macOS release](010-downloadable-macos-release.md) | In progress; execute first | Locally build and verify the first arm64 self-signed release, publish DMG/checksum/notes to GitHub Releases, and verify the actual download and install |
| After 010 | [011 GitHub release automation](011-github-release-automation.md) | Deferred; optional | Repeatable release candidates and explicit promotion, preserving signing identity and verification |
| After 010 | [012 Product and download website](012-download-website.md) | Deferred; optional | Bilingual product page linking to the verified GitHub download |

## Why this order

The immediate goal is a downloadable, installable product. Plan 010 already owns that full outcome and now names the public `EricTsai83/recordstuff` repository as its release destination. Do not split off or duplicate a second first-release project. A local build plus GitHub Release satisfies the first delivery without CI or a website.

After 010, choose 011 when release repetition warrants automation, or 012 when a product entry point matters. These two plans are independent and neither must precede the other. They are scoped follow-up options, not requirements for the first release. Automatic app updates, additional platforms, and Apple certification remain outside this work. This update records planning only; no release or deployment was performed.

English/Traditional Chinese app support and repository documentation are implemented in the working tree. The next installer must be rebuilt and verified with these changes; the previously verified DMG is not the new language-enabled release.

## Completing a plan

Update product/design documents and verification evidence, including translations. Update README and this index. Once all durable conclusions are captured, remove the completed plan and its translation. Preserve history in Git rather than keeping completed execution checklists as product specifications.
