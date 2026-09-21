# recordstuff System Design

[English](README.md) | [繁體中文](../zh-TW/system-design/README.md)

Updated: 2026-09-21. These documents describe the current implementation and replace completed execution plans. recordstuff is a local desktop recorder, with no backend service.

## Reading order

| Document | What it answers |
| --- | --- |
| [Product overview](overview.md) | Product goals, features, platform scope, and delivery expectations |
| [Design overview](design-overview.md) | The design spine, layer direction, one recording end to end, and cross-cutting invariants |
| [Architecture](architecture.md) | Process boundaries, ownership, IPC, and persistent data |
| [Repository layout](repository.md) | What each directory holds, the naming and translation conventions, and what enforces the structure |
| [Electron, Chromium, and WebRTC](webrtc.md) | Media engine layers, local recording versus peer transport, audio processing, and verification boundaries |
| [Recording pipeline](recording.md) | Start, capture, encoding, chunks, stop, failure, and file durability |
| [Desktop features](desktop.md) | Tray, notifications, permissions, settings, and logging |
| [Function reference](functions.md) | Named functions and methods, contracts, side effects, and collaborators |
| [Website, App, and update-feed delivery](delivery.md) | Flow diagrams, deployment ownership, token requirements, and release boundaries |
| [GitHub release automation](releases.md) | Tag-triggered build, signing secrets, gates, publishing and failure handling |
| [macOS signing identities and self-signing](signing.md) | Identity design, certificate creation/backup, local signing, and planned CI provisioning |
| [Build, packaging, and verification](tooling.md) | Developer workflows, signing, measurement tools, and delivery |
| [Audio quality testing](audio-quality.md) | Why each audio metric matters, fixture design, frequency fitting, failure interpretation, and evidence |
| [Design decisions](decisions.md) | Rationale, accepted tradeoffs, and conditions for architectural changes |
| [Verification record](../verification/README.md) | Evidence, accepted limitations, and original measurements |

Source code defines implemented behavior. Update the corresponding design document whenever behavior changes. The function reference covers production code and developer tools; anonymous event callbacks are documented with their owning flow. Test cases remain in adjacent `*.test.ts` files.

[Plans](../../plans/README.md) contain unfinished work only. Windows/Linux verification and Apple-certified distribution are outside the current delivery scope. Git history retains previous execution plans.
