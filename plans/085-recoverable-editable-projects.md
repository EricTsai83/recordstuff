# 085 — Recoverable, versioned editing projects

[English](085-recoverable-editable-projects.md) | [繁體中文](085-recoverable-editable-projects.zh-TW.md)

Status: planned; not started. Created: 2026-10-22. Hard dependencies: 083 and 084; phase-two product gate below. Execute in order under the [plan index](README.md). This task writes plans only; none of the implementation or performance claims below has been verified.

## Goal and decision gate

Introduce an optional editing project without changing ordinary direct-MP4 recording. Glide's separation of media and edits is the reference, not its exact schema or persistence guarantees. First present one concrete flow: open an existing recording as a project, save edits, reopen, export later. The maintainer chooses whether this editing scope and storage cost are wanted before implementation. If declined, close this assessment with the decision and mark dependent 086–088 deferred; do not build speculative infrastructure.

## Steps and ownership

- [ ] Write a minimal version-1 manifest for one existing flattened recording, rational/integer time units, source dimensions/color metadata, immutable source identity and edit revision. No separate-camera recovery from an already composited MP4. Define owned versus externally referenced assets; default to an explicit self-contained copy with disk-space check, cancellable streaming and progress off main. No hard-link assumption of immutability.
- [ ] Keep project storage/validation separate from recording publication/history. Use one metadata writer per project, enforced across app instances with an OS-backed lock held for the write transaction; combine it with revision checks for conflicting edits. Lock contention is read-only/retry, and crash releases ownership without guessing from a stale PID file. Use bounded input parsing and explicit future-version refusal. Migrations copy forward to a new revision with rollback; never silently reset malformed edits to defaults. Reject escaping/absolute asset paths and symlink escapes; handle missing/replaced media with relink or read-only recovery, never deletion.
- [ ] Specify transaction ordering for assets, manifest and directory: stage on the destination volume, finish/sync data, publish metadata atomically where supported, and test platform-specific rename/durability behavior. Temp-plus-rename alone is not a power-loss guarantee. Interrupted imports leave only identifiable owned staging; recovery cannot delete unrelated user files. Keep the last valid edit revision until replacement is committed. Autosave is debounced/coalesced and bounded, with visible unsaved/error status.
- [ ] Implement open/save/reopen and missing-media recovery using the production React components and existing library action ownership. Do not make project success a prerequisite for a normal MP4 save. Specify move/delete semantics and undo limits; project deletion never implicitly deletes an externally referenced recording.

## Gates and verification

Fault injection at every publication boundary must reopen either the prior committed revision or the new complete revision. Test disk-full, permission failure, concurrent revision, unknown schema, truncated JSON and path escapes. Metadata-only saves must be independent of source-media length; record 64 MiB/2 GiB import time, cancellation latency and peak memory using generated files, not long recordings. Set finite size/count limits and cancellation deadline before implementation. Ordinary recording-off/idle costs remain within 083 spread.

Focused storage/parser tests plus TypeScript checks suffice for isolated logic; cross-module UI/persistence final integration uses `pnpm acceptance:regression`. Exercise real-volume file operations on macOS and Windows CI; CI is not power-loss or Windows hardware evidence. No recording round unless capture/lifecycle changes; no new signing/build dependencies just for JSON. Complete only with the schema, ownership, migration/recovery documentation and English/Chinese UI parity. Existing MP4s remain playable without the editor.

## Execution and closure contract

Follow the [series contract](README.md#glide-inspired-evolution-083088) for evidence, gates, desktop handoff and closure. Preserve Electron/React, capture-process fault isolation and the default direct-MP4 workflow. At execution start inspect the current tree and predecessor closure records; paths and numbers here are design targets, not permission to skip current policy.
