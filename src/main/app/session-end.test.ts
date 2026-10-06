import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { holdSessionEnd } from "./session-end";

/** An app that creates one window, and the query Windows sends it before ending the session. */
function setup(platform: NodeJS.Platform, pending: boolean) {
  const app = new EventEmitter();
  const quit = vi.fn();
  const log = vi.fn();
  holdSessionEnd({ app: app as never, platform, mediaPending: () => pending, quit, log });
  const window = new EventEmitter();
  app.emit("browser-window-created", {}, window);
  const event = { preventDefault: vi.fn(), reasons: ["shutdown"] };
  window.emit("query-session-end", event);
  return { event, quit, log, window };
}

it("holds a Windows session end while recording work is pending and quits the normal way, which saves it", () => {
  const { event, quit, log } = setup("win32", true);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(quit).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith("quit: Windows is ending the session (shutdown); holding it to save the recording");
});

it("lets the session end as the user chose when nothing would be lost", () => {
  const { event, quit } = setup("win32", false);
  expect([event.preventDefault.mock.calls.length, quit.mock.calls.length]).toEqual([0, 0]);
});

it("does nothing on macOS, whose log out joins the normal quit", () => {
  const { window, quit } = setup("darwin", true);
  expect([window.listenerCount("query-session-end"), quit.mock.calls.length]).toEqual([0, 0]);
});
