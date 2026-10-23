# 084 — Bounded preview delivery and recovery

[English](084-bounded-preview-delivery.md) | [繁體中文](084-bounded-preview-delivery.zh-TW.md)

Status: planned; not started. Created: 2026-10-22; revised 2026-10-23: narrowed to the one leg without a bound, recovery by a requested key frame, concrete starting limits, and unchanged-frame suppression dropped. Hard dependencies: 083 (closed), 092 and 094 (the port's final messages and rates, and the Studio baseline). Sixth in the queue, after 094. Execute in order under the [plan index](README.md). This task writes the plan only; none of the implementation or performance claims below has been verified.

## Goal and current state

Keep a slow or suspended Studio page from accumulating work in the capture process or the renderer, and bring the picture back promptly when it catches up. The preview's chunks go from the engine through napi to the capture process's JavaScript thread, then over the Studio's `MessageChannelMain` port straight to the page, not through main ([studio-link.ts](../src/main/settings/studio-link.ts)). What is bounded today, and what is not:

- **Bounded:** the native `PreviewGate` ([lib.rs](../native/capture/src/lib.rs)) admits at most two chunks waiting for the JavaScript thread and, after a drop, nothing until the next key frame (the preview encoder makes one every second). A page that lets the preview go out of sight stops it (`StudioLink`), and 081/092 set its rate.
- **Not bounded:** once the JavaScript thread has taken a chunk the gate counts it done, and the host posts it to the port. `postMessage` has no backpressure, so a page that stops drawing (a stalled renderer, a long garbage collection, a throttled hidden window) lets chunks queue in the port and then in the decoder's `pending` map ([preview-decoder.ts](../src/renderer/lib/preview-decoder.ts)), which has no size limit. 083 measured 0 drops with a page that keeps up; the slow page is the untested case.

This plan bounds that leg only. It does not replace the transport (080's rejected prototype stays rejected), does not change the gate, and does not add a general credit protocol: each join already makes a fresh channel, so acknowledgements from an older page cannot reach a newer one.

## Steps and ownership

- [ ] **Reproduce and measure first.** A controlled stall for the page: a development switch that stops the Studio page's drawing for a given time (to be implemented and documented with the [tooling](../docs/system-design/tooling.md); not a runnable command until then), never freezing main or the user's app. With it, on 094's bundle, record what grows during a 30 s stall at each of 092's rates: chunks and bytes posted but not drawn, the decoder's `decodeQueueSize` and `pending`, the capture process's and renderer's memory. This is the before figure.
- [ ] **Acknowledge what was drawn; stop forwarding beyond a limit.** The page tells the host, on the same port, the timestamp of each chunk it has drawn (or dropped), batched to at most one message per drawn frame. The host keeps the chunks and bytes outstanding and stops posting when either reaches its limit, starting at **3 chunks or 512 KiB** (a 1 Mbps stream at 15 fps is about 8 KB a delta frame; key frames are larger), to be confirmed from the first step's figures. While stopped the host drops chunks and marks the stream awaiting a key frame, as the gate does. A missing page (closed port, no acknowledgement) stops preview work without blocking capture, the writer or stop/save; levels keep their own subscription.
- [ ] **Recover by asking for a key frame, not by waiting for one.** When the outstanding count falls below the limit, the host asks the engine for a key frame on the next preview tick (the encoders already take a forced key frame, as 092's view change does) instead of waiting up to a second. The page, on any gap, decode error or reset, closes decoded frames at once, clears `pending` and discards deltas until a key frame with its configuration. No per-frame reset or flush.
- [ ] **Bound the page's own queue.** `pending` and the decoder's queue are capped at the same limit; beyond it the page resets and waits for a key frame rather than growing. A malformed or oversized message is refused by the port's validator (the engine is the only sender, so one validator suffices); missing WebCodecs or a decoder that cannot start shows the preview as unavailable. A broken preview never fails a recording.

## Gates and completion

During a 30 s stall at every rate, chunks and bytes outstanding never exceed the limits and the page's memory does not grow beyond the baseline's spread; nothing remains outstanding after resume or after ten repeated hide/rejoin cycles. After resume the current picture returns within **two preview ticks at the current rate plus the decode-and-draw p95** of 092's Studio baseline, measured on hardware and checked with fake time in unit tests, without an always-on watchdog. A page that keeps up shows no new drops against 092's figures (0 missed, 0 gate drops), and recording cadence, A/V sync, CPU and saved bytes are unchanged.

## Out of scope

Unchanged-frame suppression (not encoding a preview frame when nothing changed): with 092's Off as the default and Power saving as a choice, a Studio left open costs nothing unless the user turns the preview on, 083 measured the still material's encoding as small, and suppression needs invalidation from camera motion, layout edits and meters that is easy to get wrong. Reconsider only if a measured Studio cost remains that 092's choices do not address.

## Verification

Focused tests for the acknowledgement and limits (host side with a fake port and fake time), the page's reset and key-frame wait, and the validator (`pnpm test:scope -- studio pipeline-diagnostics`); `pnpm check` for the host and protocol change. A desktop round on a fresh signed bundle after the “好了” handoff: the stall switch at each rate, `pnpm acceptance:studio`, the Studio CPU cases against 092's figures, and a recording verified with `pnpm verify`. No matrix run: recording timing and sync do not change. Close with before/after figures, the limits adopted and remaining limitations.

## Execution and closure contract

Follow the [plan index](README.md) for order, evidence, desktop handoff and closure; preserve capture-process fault isolation, the default direct-MP4 workflow and that a preview failure never fails a recording. At execution start inspect the current tree and the closure records of 092 and 094.
