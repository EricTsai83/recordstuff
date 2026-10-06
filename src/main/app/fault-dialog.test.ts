import { expect, it, vi } from "vitest";
import { createUncaughtExceptionHandler } from "./fault-dialog";

function harness(pending = false) {
  const state = { pending };
  let settle: (() => void) | undefined;
  const deps = {
    log: vi.fn(),
    showErrorBox: vi.fn(),
    mediaPending: vi.fn(() => state.pending),
    whenMediaSettled: vi.fn(() => new Promise<void>(resolve => { settle = () => { state.pending = false; resolve(); }; })),
    held: vi.fn(),
  };
  const handle = createUncaughtExceptionHandler(deps);
  return { deps, handle, state, settle: async () => { settle!(); await vi.waitFor(() => expect(deps.showErrorBox).toHaveBeenCalled()); } };
}

it("keeps the settled app's box: log first, then the box at once, once per process", () => {
  const h = harness();
  h.handle(new Error("first"));
  expect(h.deps.log.mock.calls[0]![0]).toMatch(/^uncaught exception: Error: first/);
  expect(h.deps.showErrorBox).toHaveBeenCalledOnce();
  expect(h.deps.log.mock.invocationCallOrder[0]!).toBeLessThan(h.deps.showErrorBox.mock.invocationCallOrder[0]!);
  expect(h.deps.whenMediaSettled).not.toHaveBeenCalled();
  h.handle("again");
  expect(h.deps.log).toHaveBeenLastCalledWith("uncaught exception: again");
  expect(h.deps.showErrorBox).toHaveBeenCalledOnce();
});

it("shows no blocking box while recording work is pending, and presents it once the work settles", async () => {
  const h = harness(true);
  h.handle(new Error("during recording"));
  expect(h.deps.showErrorBox).not.toHaveBeenCalled();
  expect(h.deps.held).toHaveBeenCalledExactlyOnceWith(true);
  expect(h.deps.log).toHaveBeenCalledWith("uncaught exception: error box held until recording work settles");
  // A repeat while held only logs; it neither waits again nor stacks a second box.
  h.handle(new Error("repeat"));
  expect(h.deps.whenMediaSettled).toHaveBeenCalledOnce();
  await h.settle();
  expect(h.deps.held).toHaveBeenLastCalledWith(false);
  expect(h.deps.held.mock.invocationCallOrder.at(-1)!).toBeLessThan(h.deps.showErrorBox.mock.invocationCallOrder[0]!);
  expect(h.deps.showErrorBox).toHaveBeenCalledOnce();
  h.handle(new Error("after"));
  expect(h.deps.showErrorBox).toHaveBeenCalledOnce();
});

it("waits again if another session began before the box could be shown", async () => {
  const h = harness(true);
  const waits: Array<() => void> = [];
  h.deps.whenMediaSettled.mockImplementation(() => new Promise<void>(resolve => { waits.push(resolve); }));
  h.handle(new Error("x"));
  waits.shift()!();
  await vi.waitFor(() => expect(h.deps.whenMediaSettled).toHaveBeenCalledTimes(2));
  expect(h.deps.showErrorBox).not.toHaveBeenCalled();
  h.state.pending = false;
  waits.shift()!();
  await vi.waitFor(() => expect(h.deps.showErrorBox).toHaveBeenCalledOnce());
});

it("a fault that keeps the work from settling leaves the tray line and the log, never a box", async () => {
  const h = harness(true);
  h.deps.whenMediaSettled.mockImplementation(() => new Promise<void>(() => undefined));
  h.handle(new Error("stuck"));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(h.deps.showErrorBox).not.toHaveBeenCalled();
  expect(h.deps.held).toHaveBeenCalledExactlyOnceWith(true);
});

it("never throws out of the handler, which would end the process", async () => {
  const h = harness(true);
  h.deps.held.mockImplementation(() => { throw new Error("tray gone"); });
  h.deps.whenMediaSettled.mockImplementation(() => { throw new Error("no recorder"); });
  expect(() => h.handle(new Error("x"))).not.toThrow();
  expect(h.deps.log).toHaveBeenCalledWith("uncaught exception: tray update failed: Error: tray gone");
  await vi.waitFor(() => expect(h.deps.log).toHaveBeenCalledWith("uncaught exception: waiting for recording work failed: Error: no recorder"));

  const settled = harness();
  settled.deps.showErrorBox.mockImplementation(() => { throw new Error("no display"); });
  settled.deps.mediaPending.mockImplementation(() => { throw new Error("unreadable"); });
  expect(() => settled.handle(new Error("y"))).not.toThrow();
  expect(settled.deps.log).toHaveBeenCalledWith("uncaught exception: media check failed: Error: unreadable");
  expect(settled.deps.log).toHaveBeenCalledWith("uncaught exception: error box failed: Error: no display");
});
