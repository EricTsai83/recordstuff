import { expect, it, vi } from "vitest";
import { DataCleanupRequest } from "./data-cleanup-request";
import type { MessageBoxOptions } from "electron";

it.each(["en", "zh-TW"] as const)("defaults to cancellation and explains retained recordings in %s", async language => {
  const confirm = vi.fn(async (_options: MessageBoxOptions) => ({ response: 0 })), quit = vi.fn();
  const request = new DataCleanupRequest({ settled: () => true, language: () => language, confirm, quit });
  expect(await request.request()).toBe(true);
  expect(confirm.mock.calls[0]?.[0]).toMatchObject({ defaultId: 0, cancelId: 0, noLink: true });
  expect(confirm.mock.calls[0]?.[0]?.detail).toContain(language === "en" ? "Recordings and your output folder are kept" : "錄影檔與儲存資料夾會保留");
  expect(request.requested).toBe(false); expect(quit).not.toHaveBeenCalled();
});

it("refuses capture/quit races and repeated requests while confirmation is open", async () => {
  let settled = false, answer!: (value: { response: number }) => void;
  const confirm = vi.fn(() => new Promise<{ response: number }>(resolve => { answer = resolve; })), quit = vi.fn();
  const request = new DataCleanupRequest({ settled: () => settled, language: () => "en", confirm, quit });
  expect(await request.request()).toBe(false); expect(confirm).not.toHaveBeenCalled();
  settled = true; const pending = request.request();
  expect(await request.request()).toBe(false); expect(confirm).toHaveBeenCalledOnce();
  settled = false; answer({ response: 1 }); expect(await pending).toBe(false);
  expect(request.requested).toBe(false); expect(request.confirming).toBe(false); expect(quit).not.toHaveBeenCalled();
});

it("requests cleanup exactly once after confirmation, clears the prompt gate before quit, and can retry after refusal", async () => {
  const quit = vi.fn(() => { expect(request.confirming).toBe(false); expect(request.requested).toBe(true); });
  const request = new DataCleanupRequest({ settled: () => true, language: () => "en", confirm: async () => ({ response: 1 }), quit });
  expect(await request.request()).toBe(true); expect(await request.request()).toBe(false); expect(quit).toHaveBeenCalledOnce();
  request.cancel(); expect(await request.request()).toBe(true); expect(quit).toHaveBeenCalledTimes(2);
});

it("a failed confirmation never authorizes deletion and releases the prompt gate", async () => {
  const quit = vi.fn();
  const request = new DataCleanupRequest({ settled: () => true, language: () => "en", confirm: async () => { throw new Error("prompt failed"); }, quit });
  await expect(request.request()).rejects.toThrow("prompt failed");
  expect(request.requested).toBe(false); expect(request.confirming).toBe(false); expect(quit).not.toHaveBeenCalled();
});
