// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SETTINGS_CHANNELS } from "../../../shared/settings-panel";

/** A port as the preload posts it into the page (plan 081): what the page posts, whether it is open. */
function fakePort() {
  return { posted: [] as unknown[], closed: false, started: false, onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: unknown) { this.posted.push(message); }, close() { this.closed = true; }, start() { this.started = true; },
    say(data: unknown) { this.onmessage?.({ data }); } };
}
type Port = ReturnType<typeof fakePort>;
const give = (port: Port, data: unknown = SETTINGS_CHANNELS.cameraPreviewPort, source: MessageEventSource | null = window): void => {
  window.dispatchEvent(new MessageEvent("message", { data, source, ports: [port as unknown as MessagePort] }));
};
const chunk = { width: 640, height: 360, data: new Uint8Array([1]), key: true, timestamp: 1, sent: 2, n: 1 };

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

it("gives each listener its own part of the Studio's port: chunks to the preview, levels to the meters (plan 081)", async () => {
  const feed = await import("./studio-feed");
  const preview = { chunk: vi.fn(), joined: vi.fn() };
  const levels = vi.fn();
  const stopPreview = feed.onPreview(preview);
  const stopLevels = feed.onLevels(levels);
  const port = fakePort();
  give(fakePort(), "something else");
  // A port another window or frame posts is not the preload's.
  const stranger = fakePort();
  give(stranger, SETTINGS_CHANNELS.cameraPreviewPort, null);
  expect([stranger.started, preview.joined.mock.calls.length]).toEqual([false, 0]);
  give(port);
  expect(port.started).toBe(true);
  expect(preview.joined).toHaveBeenCalledTimes(1);
  port.say(chunk);
  port.say({ type: "levels", system: 0.5 });
  port.say({ type: "levels", system: 0.25, microphone: 0.1 });
  port.say({ type: "levels", system: -1 });
  expect(preview.chunk.mock.calls).toEqual([[chunk]]);
  expect(levels.mock.calls).toEqual([[{ system: 0.5 }], [{ system: 0.25, microphone: 0.1 }]]);
  // The preview let go, the meters still listen: the port stays.
  stopPreview();
  expect(port.closed).toBe(false);
  stopLevels();
  expect(port.closed).toBe(true);
  // Nothing listens: a port posted now is not taken.
  const late = fakePort();
  give(late);
  expect(late.started).toBe(false);
});

it("says its rate on each new port and when it changes, and closes the port a newer one replaces", async () => {
  const feed = await import("./studio-feed");
  const stop = feed.onLevels(() => undefined);
  const first = fakePort(), second = fakePort();
  give(first);
  expect(first.posted).toEqual([{ type: "rate", fps: 10 }]);
  feed.setPreviewRate(5);
  feed.setPreviewRate(5);
  expect(first.posted).toEqual([{ type: "rate", fps: 10 }, { type: "rate", fps: 5 }]);
  give(second);
  expect(first.closed).toBe(true);
  // A new session's preview starts at the full rate: the page says its own.
  expect(second.posted).toEqual([{ type: "rate", fps: 5 }]);
  stop();
});

it("keeps the preview's figures only once the capture process asks, reports them on the port and at its release (plan 083)", async () => {
  vi.useFakeTimers();
  try {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const feed = await import("./studio-feed");
    const stop = feed.onPreview({ chunk: () => undefined, joined: () => undefined });
    const port = fakePort();
    give(port);
    // Not asked: nothing kept, nothing reported, and the clock not even read.
    port.say({ ...chunk, sent: 990, n: 1 });
    expect(clock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(port.posted).toEqual([{ type: "rate", fps: 10 }]);
    port.say({ type: "diagnostics", everyMs: 5000 });
    port.say({ ...chunk, sent: 990, n: 2 });
    // Chunk 3 never came.
    port.say({ ...chunk, sent: 996, n: 4 });
    feed.previewFigures.drawn(998, 1_000);
    vi.advanceTimersByTime(5000);
    expect(port.posted[1]).toEqual(expect.objectContaining({ type: "previewDiagnostics", schema: 1, received: 2, drawn: 1, missed: 1,
      port: expect.objectContaining({ n: 2, max: 10_000 }), decode: expect.objectContaining({ n: 1, max: 2000 }) }));
    feed.previewFigures.restarted("error");
    stop();
    // Let go: what was kept since goes with the port, and nothing more is reported.
    expect(port.posted[2]).toEqual(expect.objectContaining({ received: 0, restarts: { codec: 0, error: 1 } }));
    expect(port.closed).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(port.posted).toHaveLength(3);
    expect(feed.previewFigures.keeping).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
