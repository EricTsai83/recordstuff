import { describe, expect, it, vi } from "vitest";
import { LevelsLink, type LevelsPage } from "./levels-link";
import { SETTINGS_CHANNELS } from "../../shared/settings-panel";

function setup() {
  let session: string | undefined;
  const running = new Set<string>();
  const watch = vi.fn((id: string, _watching: boolean) => running.has(id));
  const link = new LevelsLink({ session: () => session, watch });
  const sent: unknown[][] = [];
  const page: LevelsPage & { destroyed: boolean } = { destroyed: false, isDestroyed() { return this.destroyed; }, send: (...args) => { sent.push(args); } };
  return { link, watch, sent, page, start: (id: string) => { session = id; running.add(id); }, end: (id: string) => { session = undefined; running.delete(id); } };
}

describe("LevelsLink (plan 075, D19)", () => {
  it("asks for the recording's levels while the page watches, passes only that session's to it, and stops asking", () => {
    const ctx = setup();
    ctx.link.watch(ctx.page);
    expect(ctx.watch).not.toHaveBeenCalled();
    ctx.start("s1");
    ctx.link.sync();
    expect(ctx.watch).toHaveBeenLastCalledWith("s1", true);
    ctx.link.deliver({ type: "levels", sessionId: "s1", system: 0.5, microphone: 0.25 });
    ctx.link.deliver({ type: "levels", sessionId: "s0", system: 0.9 });
    ctx.link.deliver({ type: "progress", sessionId: "s1", bytes: 1 });
    expect(ctx.sent).toEqual([[SETTINGS_CHANNELS.levels, { system: 0.5, microphone: 0.25 }]]);
    ctx.link.watch(undefined);
    expect(ctx.watch).toHaveBeenLastCalledWith("s1", false);
    ctx.link.deliver({ type: "levels", sessionId: "s1", system: 0.5 });
    expect(ctx.sent).toHaveLength(1);
  });

  it("follows a new session, asks nothing for a page gone, and joins none the host does not run", () => {
    const ctx = setup();
    ctx.start("s1");
    ctx.link.watch(ctx.page);
    ctx.end("s1");
    ctx.link.sync();
    ctx.start("s2");
    ctx.link.sync();
    expect(ctx.watch.mock.calls).toEqual([["s1", true], ["s1", false], ["s2", true]]);
    const gone = setup();
    gone.page.destroyed = true;
    gone.start("s1");
    gone.link.watch(gone.page);
    expect(gone.watch).not.toHaveBeenCalled();
  });
});
