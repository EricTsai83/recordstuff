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

it("says its rate and view on each new port and when they change, and closes the port a newer one replaces (plan 092)", async () => {
  const feed = await import("./studio-feed");
  const stop = feed.onLevels(() => undefined);
  const first = fakePort(), second = fakePort();
  give(first);
  const told = [{ type: "rate", fps: 10 }, { type: "view", view: "composed" }];
  expect(first.posted).toEqual(told);
  feed.setPreviewRate(5);
  feed.setPreviewRate(5);
  feed.setPreviewRate(15);
  feed.setPreviewView("camera");
  feed.setPreviewView("camera");
  expect(first.posted).toEqual([...told, { type: "rate", fps: 5 }, { type: "rate", fps: 15 }, { type: "view", view: "camera" }]);
  give(second);
  expect(first.closed).toBe(true);
  // A new session's preview starts at 10 and composed: the page says its own.
  expect(second.posted).toEqual([{ type: "rate", fps: 15 }, { type: "view", view: "camera" }]);
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
    expect(port.posted).toEqual([{ type: "rate", fps: 10 }, { type: "view", view: "composed" }]);
    port.say({ type: "diagnostics", everyMs: 5000 });
    port.say({ ...chunk, sent: 990, n: 2 });
    // Chunk 3 never came.
    port.say({ ...chunk, sent: 996, n: 4 });
    feed.previewFigures.queued(2, 1);
    feed.previewFigures.queued(1, 3);
    feed.previewFigures.drawn(998, 1_000);
    vi.advanceTimersByTime(5000);
    expect(port.posted[2]).toEqual(expect.objectContaining({ type: "previewDiagnostics", schema: 1, received: 2, drawn: 1, missed: 1, pendingHigh: 2, decodingHigh: 3,
      port: expect.objectContaining({ n: 2, max: 10_000 }), decode: expect.objectContaining({ n: 1, max: 2000 }) }));
    feed.previewFigures.restarted("error");
    stop();
    // Let go: the chunks received are done with (plan 084), what was kept since goes with the port, and nothing more is
    // reported.
    expect(port.posted[3]).toEqual({ type: "drawn", through: 4 });
    expect(port.posted[4]).toEqual(expect.objectContaining({ received: 0, restarts: { codec: 0, error: 1 } }));
    expect(port.closed).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(port.posted).toHaveLength(5);
    expect(feed.previewFigures.keeping).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("holds its thread for the stall the capture process asks for, and takes no malformed request (plan 084)", async () => {
  const feed = await import("./studio-feed");
  const stop = feed.onLevels(() => undefined);
  const port = fakePort();
  give(port);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (now += 100));
  port.say({ type: "stall", ms: 0 });
  expect(now).toBe(0);
  port.say({ type: "stall", ms: 1000 });
  // Read once to set the end, then until it passed: about 1000 ms of the fake clock.
  expect(now).toBeGreaterThanOrEqual(1100);
  expect(now).toBeLessThanOrEqual(1300);
  stop();
});

it("tells the capture process the last chunk done with, once each, on this port only, and at once when no preview draws (plan 084)", async () => {
  const feed = await import("./studio-feed");
  const stopLevels = feed.onLevels(() => undefined);
  const stopPreview = feed.onPreview({ chunk: () => undefined, joined: () => undefined });
  const first = fakePort(), second = fakePort();
  give(first);
  const drawn = (port: Port) => port.posted.filter((m) => (m as { type?: string }).type === "drawn");
  feed.previewDone(2);
  feed.previewDone(2);
  feed.previewDone(1);
  feed.previewDone(3);
  // A dropped decoder is told even with nothing new done.
  feed.previewDone(3, true);
  expect(drawn(first)).toEqual([{ type: "drawn", through: 2 }, { type: "drawn", through: 3 }, { type: "drawn", through: 3, key: true }]);
  first.say({ ...chunk, n: 5 });
  give(second);
  // A new port counts from nothing.
  feed.previewDone(1);
  expect(drawn(second)).toEqual([{ type: "drawn", through: 1 }]);
  second.say({ ...chunk, n: 7 });
  // The preview let go while the meters keep the port: what it received is done with, and so is what comes after.
  stopPreview();
  second.say({ ...chunk, n: 8 });
  expect(drawn(second)).toEqual([{ type: "drawn", through: 1 }, { type: "drawn", through: 7 }, { type: "drawn", through: 8 }]);
  expect(drawn(first)).toHaveLength(3);
  stopLevels();
});

it("times a stalled page's catching up, from its first stale chunk to its first fresh frame drawn (plan 084)", async () => {
  const feed = await import("./studio-feed");
  const figures = feed.previewFigures;
  figures.start();
  figures.received({ ...chunk, sent: 0, n: 1 }, 30_000);
  figures.received({ ...chunk, sent: 100, n: 2 }, 30_010);
  // Old frames drawn while catching up are not the end of it.
  figures.drawn(30_000, 30_020, 0);
  figures.received({ ...chunk, sent: 30_100, n: 3 }, 30_101);
  figures.drawn(30_101, 30_105, 30_100);
  // A fresh frame with nothing stale before it times nothing.
  figures.drawn(30_200, 30_205, 30_200);
  const taken = figures.take();
  expect(taken.recover).toEqual(expect.objectContaining({ n: 1, max: 105_000 }));
  figures.stop();
});
