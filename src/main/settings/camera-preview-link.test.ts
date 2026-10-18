import { describe, expect, it, vi } from "vitest";
import { CameraPreviewLink, type PreviewPage } from "./camera-preview-link";
import { SETTINGS_CHANNELS } from "../../shared/settings-panel";

class End { closed = false; constructor(readonly name: string) {} close(): void { this.closed = true; } }

function setup() {
  let session: string | undefined;
  const running = new Set<string>();
  const watch = vi.fn((id: string, _watching: boolean, _port?: End) => running.has(id));
  const channels: Array<{ port1: End; port2: End }> = [];
  const link = new CameraPreviewLink<End>({
    session: () => session,
    watch,
    channel: () => { const pair = { port1: new End(`a${channels.length}`), port2: new End(`b${channels.length}`) }; channels.push(pair); return pair; },
    log: () => undefined,
  });
  const posted: Array<[string, End[] | undefined]> = [];
  const page: PreviewPage<End> & { destroyed: boolean } = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    postMessage: (channel, _message, transfer) => { posted.push([channel, transfer]); },
  };
  return { link, watch, channels, posted, page, start: (id: string) => { session = id; running.add(id); }, end: (id: string) => { session = undefined; running.delete(id); } };
}

describe("CameraPreviewLink (plan 075 step 7)", () => {
  it("joins a watching page to the session composing the camera, with a channel of its own, and leaves it when the page stops", () => {
    const ctx = setup();
    ctx.link.watch(ctx.page);
    expect(ctx.watch).not.toHaveBeenCalled();
    ctx.start("s1");
    ctx.link.sync();
    expect(ctx.watch).toHaveBeenLastCalledWith("s1", true, ctx.channels[0]!.port1);
    expect(ctx.posted).toEqual([[SETTINGS_CHANNELS.cameraPreviewPort, [ctx.channels[0]!.port2]]]);
    ctx.link.sync();
    expect(ctx.watch).toHaveBeenCalledTimes(1);
    ctx.link.watch(undefined);
    expect(ctx.watch).toHaveBeenLastCalledWith("s1", false);
  });

  it("gives a page that watches again a new port, and a new session a new channel", () => {
    const ctx = setup();
    ctx.start("s1");
    ctx.link.watch(ctx.page);
    ctx.link.watch(ctx.page);
    expect(ctx.watch.mock.calls.map(([id, watching]) => [id, watching])).toEqual([["s1", true], ["s1", false], ["s1", true]]);
    expect(ctx.posted).toHaveLength(2);
    ctx.end("s1");
    ctx.link.sync();
    ctx.start("s2");
    ctx.link.sync();
    expect(ctx.watch).toHaveBeenLastCalledWith("s2", true, ctx.channels[2]!.port1);
  });

  it("closes both ends when the host no longer runs the session, and sends nothing to a page that is gone", () => {
    const stale = setup();
    stale.page.destroyed = true;
    stale.start("s1");
    stale.link.watch(stale.page);
    expect(stale.watch).not.toHaveBeenCalled();
    // The recorder still names the session, but the host has let it go.
    const gone = setup();
    gone.start("s1");
    gone.end("s1");
    (gone.link as unknown as { options: { session: () => string } }).options.session = () => "s1";
    gone.link.watch(gone.page);
    expect(gone.channels[0]).toMatchObject({ port1: { closed: true }, port2: { closed: true } });
    expect(gone.posted).toEqual([]);
  });
});
