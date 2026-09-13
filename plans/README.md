# Remaining Work

[English](README.md) | [繁體中文](../docs/zh-TW/plans/README.md)

Updated: 2026-09-14. Completed plans have been replaced by the [system design](../docs/system-design/README.md) and [verification record](../docs/verification/README.md). Windows verification and Apple-certified distribution were canceled by the user. The speculative roadmap was removed from execution planning; current boundaries and evolution triggers remain in the design decisions.

## Order and status

| Order | Plan | Status | Completion target |
| --- | --- | --- | --- |
| 1 | [010 Downloadable macOS release](010-downloadable-macos-release.md) | Pending | A versioned self-signed arm64 DMG available through a stable download, with checksums, bilingual installation guidance, and recorded download/install verification |

English/Traditional Chinese app support and repository documentation are implemented in the working tree. The next installer must be rebuilt and verified with these changes; the previously verified DMG is not the new language-enabled release.

## Completing a plan

Update product/design documents and verification evidence, including translations. Update README and this index. Once all durable conclusions are captured, remove the completed plan and its translation. Preserve history in Git rather than keeping completed execution checklists as product specifications.
