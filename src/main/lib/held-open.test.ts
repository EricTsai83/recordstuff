import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { retryWhileHeldOpen } from "./held-open";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const held = (code: string) => Object.assign(new Error(code), { code });

it("retries on Windows while the file is held open, then succeeds", async () => {
  const change = vi.fn<() => Promise<string>>().mockRejectedValueOnce(held("EBUSY")).mockRejectedValueOnce(held("EPERM")).mockResolvedValue("done");
  const result = retryWhileHeldOpen(change, "win32");
  await vi.runAllTimersAsync();
  await expect(result).resolves.toBe("done");
  expect(change).toHaveBeenCalledTimes(3);
});

it("gives the last attempt's error after about a second on Windows", async () => {
  const change = vi.fn(async () => { throw held("EACCES"); });
  const result = retryWhileHeldOpen(change, "win32");
  const settled = expect(result).rejects.toMatchObject({ code: "EACCES" });
  await vi.runAllTimersAsync();
  await settled;
  expect(change).toHaveBeenCalledTimes(6);
});

it("does not retry another error, nor on other platforms", async () => {
  const missing = vi.fn(async () => { throw held("ENOENT"); });
  await expect(retryWhileHeldOpen(missing, "win32")).rejects.toMatchObject({ code: "ENOENT" });
  expect(missing).toHaveBeenCalledTimes(1);
  const busy = vi.fn(async () => { throw held("EBUSY"); });
  await expect(retryWhileHeldOpen(busy, "darwin")).rejects.toMatchObject({ code: "EBUSY" });
  expect(busy).toHaveBeenCalledTimes(1);
});
