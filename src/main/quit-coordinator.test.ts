import { expect, it, vi } from "vitest";
import { installQuitCoordinator } from "./quit-coordinator";

it("joins repeated quit requests, defers unsafe exit and admits only a safe retry", async () => {
  let listener!: (event: { preventDefault(): void }) => void;
  const preventDefault = vi.fn();
  const app = { on: (_: "before-quit", fn: typeof listener) => { listener = fn; }, quit: vi.fn(() => listener({ preventDefault })) };
  let release!: (safe: boolean) => void;
  const shutdown = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
  const pending = vi.fn();
  installQuitCoordinator(app, { shutdown, pending, error: vi.fn() });
  listener({ preventDefault }); listener({ preventDefault });
  expect(shutdown).toHaveBeenCalledTimes(1);
  release(false); await new Promise(resolve => setTimeout(resolve, 0));
  expect(app.quit).not.toHaveBeenCalled(); expect(pending).toHaveBeenCalledOnce();
  listener({ preventDefault }); release(true); await new Promise(resolve => setTimeout(resolve, 0));
  expect(app.quit).toHaveBeenCalledOnce(); expect(shutdown).toHaveBeenCalledTimes(2);
  expect(preventDefault).toHaveBeenCalledTimes(3);
});

it("registers relaunch only on safe admission and clears it after a deferral", async () => {
  let listener!: (event: { preventDefault(): void }) => void;
  const app = { on: (_: "before-quit", fn: typeof listener) => { listener = fn; }, quit: vi.fn(() => listener({ preventDefault() {} })) };
  let safe = false;
  const relaunch = vi.fn();
  const coordinator = installQuitCoordinator(app, { shutdown: async () => safe, pending() {}, error() {}, relaunch });
  coordinator.relaunch(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(relaunch).not.toHaveBeenCalled();
  safe = true; app.quit(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(relaunch).not.toHaveBeenCalled();
});

it("registers an admitted relaunch exactly once", async () => {
  let listener!: (event: { preventDefault(): void }) => void;
  const app = { on: (_: "before-quit", fn: typeof listener) => { listener = fn; }, quit: vi.fn(() => listener({ preventDefault() {} })) };
  const relaunch = vi.fn();
  const coordinator = installQuitCoordinator(app, { shutdown: async () => true, pending() {}, error() {}, relaunch });
  coordinator.relaunch(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(relaunch).toHaveBeenCalledOnce();
});

it("runs the history phase only after media is safe, joins repeats and resumes admission when declined", async () => {
  let listener!: (event: { preventDefault(): void }) => void;
  const app = { on: (_: "before-quit", fn: typeof listener) => { listener = fn; }, quit: vi.fn(() => listener({ preventDefault() {} })) };
  const order: string[] = [];
  let media!: (safe: boolean) => void, decide!: (exit: boolean) => void;
  const shutdown = vi.fn(() => { order.push("media"); return new Promise<boolean>(resolve => { media = resolve; }); });
  const history = vi.fn(() => { order.push("history"); return new Promise<boolean>(resolve => { decide = resolve; }); });
  const resume = vi.fn(), joined = vi.fn(), relaunch = vi.fn(), pending = vi.fn();
  const coordinator = installQuitCoordinator(app, { shutdown, history, resume, joined, relaunch, pending, error: vi.fn() });
  coordinator.relaunch();
  expect(history).not.toHaveBeenCalled();
  media(true); await new Promise(resolve => setTimeout(resolve, 0));
  listener({ preventDefault() {} });
  expect(joined).toHaveBeenCalledOnce();
  decide(false); await new Promise(resolve => setTimeout(resolve, 0));
  expect(order).toEqual(["media", "history"]);
  expect(resume).toHaveBeenCalledOnce(); expect(pending).not.toHaveBeenCalled();
  expect(app.quit).toHaveBeenCalledOnce(); expect(relaunch).not.toHaveBeenCalled();
  // A declined relaunch is not remembered by a later ordinary quit.
  app.quit(); media(true); await new Promise(resolve => setTimeout(resolve, 0));
  decide(true); await new Promise(resolve => setTimeout(resolve, 0));
  expect(relaunch).not.toHaveBeenCalled(); expect(app.quit).toHaveBeenCalledTimes(3);
});

it("unsafe media never reaches the history phase and a history error keeps the app open", async () => {
  let listener!: (event: { preventDefault(): void }) => void;
  const app = { on: (_: "before-quit", fn: typeof listener) => { listener = fn; }, quit: vi.fn(() => listener({ preventDefault() {} })) };
  let safe = false;
  const history = vi.fn(async () => { throw new Error("prompt failed"); });
  const pending = vi.fn(), resume = vi.fn(), error = vi.fn();
  installQuitCoordinator(app, { shutdown: async () => safe, history, pending, resume, error });
  app.quit(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(history).not.toHaveBeenCalled(); expect(pending).toHaveBeenCalledOnce();
  safe = true; app.quit(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(error).toHaveBeenCalledOnce(); expect(resume).toHaveBeenCalledOnce();
  expect(pending).toHaveBeenCalledOnce(); expect(app.quit).toHaveBeenCalledTimes(2);
});
