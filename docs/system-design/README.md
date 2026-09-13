# RecordStuff System Design

[English](README.md) | [繁體中文](../zh-TW/system-design/README.md)

Updated: 2026-09-14. These documents describe the current implementation and replace completed execution plans. RecordStuff is a local desktop recorder, with no backend service.

| Document | What it explains |
| --- | --- |
| [Product overview](overview.md) | Product goals, features, platform scope, and delivery expectations |
| [Architecture](architecture.md) | Process boundaries, ownership, IPC, and persistent data |
| [Recording pipeline](recording.md) | Start, capture, encoding, chunks, stop, failure, and file durability |
| [Desktop features](desktop.md) | Tray, notifications, permissions, settings, and logging |
| [Function reference](functions.md) | Named functions and methods, contracts, side effects, and collaborators |
| [Build, packaging, and verification](tooling.md) | Developer workflows, signing, measurement tools, and delivery |
| [Design decisions](decisions.md) | Rationale, accepted tradeoffs, and conditions for architectural changes |
| [Verification record](../verification/README.md) | Evidence, accepted limitations, and original measurements |

Source code defines implemented behavior. Update the corresponding design document whenever behavior changes. The function reference covers production code and developer tools; anonymous event callbacks are documented with their owning flow. Test cases remain in adjacent `*.test.ts` files.

[Plans](../../plans/README.md) contain unfinished work only. Windows/Linux verification and Apple-certified distribution are outside the current delivery scope. Git history retains previous execution plans.
