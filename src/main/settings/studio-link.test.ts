import { describe, expect, it, vi } from "vitest";
import { StudioLink, type StudioFeed, type StudioPage } from "./studio-link";
import { SETTINGS_CHANNELS } from "../../shared/settings-panel";

class End { closed = false; constructor(readonly name: string) {} close(): void { this.closed = true; } }

function setup() {
  let session: string | undefined;
  const running = new Set<string>();
  const join = vi.fn((id: string, _port: End) => running.has(id));
  const watch = vi.fn((id: string, _feed: StudioFeed, _watching: boolean) => running.has(id));
  const channels: Array<{ port1: End; port2: End }> = [];
  const link = new StudioLink<End>({
    session: () => session,
    join,
    watch,
    channel: () => { const pair = { port1: new End(`a${channels.length}`), port2: new End(`b${channels.length}`) }; channels.push(pair); return pair; },
    log: () => undefined,
  });
  const posted: Array<[string, End[] | undefined]> = [];
  const page: StudioPage<End> & { destroyed: boolean } = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    postMessage: (channel, _message, transfer) => { posted.push([channel, transfer]); },
  };
  return { link, join, watch, channels, posted, page, start: (id: string) => { session = id; running.add(id); }, end: (id: string) => { session = undefined; running.delete(id); } };
}

describe("StudioLink (plan 075 step 7, plan 081)", () => {
  it("joins a watching page to the session with a channel of its own, and tells the feed watched until the page stops", () => {
    const ctx = setup();
    ctx.link.watch("preview", ctx.page);
    expect(ctx.join).not.toHaveBeenCalled();
    ctx.start("s1");
    ctx.link.sync();
    expect(ctx.join).toHaveBeenLastCalledWith("s1", ctx.channels[0]!.port1);
    expect(ctx.posted).toEqual([[SETTINGS_CHANNELS.cameraPreviewPort, [ctx.channels[0]!.port2]]]);
    expect(ctx.watch.mock.calls).toEqual([["s1", "preview", true]]);
    ctx.link.sync();
    expect(ctx.join).toHaveBeenCalledTimes(1);
    ctx.link.watch("preview", undefined);
    expect(ctx.watch).toHaveBeenLastCalledWith("s1", "preview", false);
  });

  it("carries the preview and the levels on one port, each watched apart, with no new port while either is", () => {
    const ctx = setup();
    ctx.start("s1");
    ctx.link.watch("levels", ctx.page);
    ctx.link.watch("preview", ctx.page);
    ctx.link.watch("preview", undefined);
    ctx.link.watch("preview", ctx.page);
    expect(ctx.join).toHaveBeenCalledTimes(1);
    expect(ctx.posted).toHaveLength(1);
    expect(ctx.watch.mock.calls).toEqual([["s1", "levels", true], ["s1", "preview", true], ["s1", "preview", false], ["s1", "preview", true]]);
    // Both let go: the page closed its port, so watching again joins anew.
    ctx.link.watch("preview", undefined);
    ctx.link.watch("levels", undefined);
    ctx.link.watch("levels", ctx.page);
    expect(ctx.join).toHaveBeenCalledTimes(2);
    expect(ctx.watch.mock.calls.slice(4)).toEqual([["s1", "preview", false], ["s1", "levels", false], ["s1", "levels", true]]);
  });

  it("gives a new session a new channel and tells it what the page watches", () => {
    const ctx = setup();
    ctx.start("s1");
    ctx.link.watch("preview", ctx.page);
    ctx.link.watch("levels", ctx.page);
    ctx.end("s1");
    ctx.link.sync();
    ctx.start("s2");
    ctx.link.sync();
    expect(ctx.join).toHaveBeenLastCalledWith("s2", ctx.channels[1]!.port1);
    expect(ctx.watch.mock.calls.filter(([id]) => id === "s2")).toEqual([["s2", "preview", true], ["s2", "levels", true]]);
  });

  it("closes both ends when the host no longer runs the session, and sends nothing to a page that is gone", () => {
    const stale = setup();
    stale.page.destroyed = true;
    stale.start("s1");
    stale.link.watch("levels", stale.page);
    expect(stale.join).not.toHaveBeenCalled();
    // The recorder still names the session, but the host has let it go.
    const gone = setup();
    gone.start("s1");
    gone.end("s1");
    (gone.link as unknown as { options: { session: () => string } }).options.session = () => "s1";
    gone.link.watch("preview", gone.page);
    expect(gone.channels[0]).toMatchObject({ port1: { closed: true }, port2: { closed: true } });
    expect(gone.posted).toEqual([]);
    expect(gone.watch).not.toHaveBeenCalled();
  });
});
