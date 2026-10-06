import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry, retryDelayMs, retryable } from "./fetch-retry.mts";

const answer = (status: number, headers: Record<string, string> = {}): Response => new Response(null, { status, headers });

describe("fetchWithRetry", () => {
  it("retries a rate limit, then returns the success", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(answer(429, { "retry-after": "2" })).mockResolvedValueOnce(answer(200));
    const sleep = vi.fn(async (_ms: number) => undefined);
    expect((await fetchWithRetry("https://x", {}, { fetch, sleep })).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("returns the last answer after its attempts, and a lasting network error throws", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const failing = vi.fn(async () => answer(503));
    expect((await fetchWithRetry("https://x", {}, { fetch: failing, sleep, attempts: 3 })).status).toBe(503);
    expect(failing).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    const offline = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(fetchWithRetry("https://x", {}, { fetch: offline, sleep, attempts: 2 })).rejects.toThrow("fetch failed");
    expect(offline).toHaveBeenCalledTimes(2);
  });

  it("does not retry an answer that cannot change on its own", async () => {
    for (const status of [200, 301, 404, 403]) {
      const fetch = vi.fn(async () => answer(status));
      expect((await fetchWithRetry("https://x", {}, { fetch, sleep: async () => undefined })).status).toBe(status);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
});

describe("retry rules", () => {
  it("retries 429, 5xx and GitHub's rate-limit 403 only", () => {
    expect([429, 500, 502, 503].map((s) => retryable(answer(s)))).toEqual([true, true, true, true]);
    expect(retryable(answer(403))).toBe(false);
    expect(retryable(answer(403, { "x-ratelimit-remaining": "0" }))).toBe(true);
    expect(retryable(answer(404))).toBe(false);
  });

  it("waits what the server asks for, capped, and backs off otherwise", () => {
    const now = () => 1_000_000;
    expect(retryDelayMs(answer(429, { "retry-after": "3" }), 0, { now })).toBe(3000);
    expect(retryDelayMs(answer(429, { "retry-after": "600" }), 0, { now })).toBe(10_000);
    expect(retryDelayMs(answer(429, { "retry-after": new Date(1_004_000).toUTCString() }), 0, { now })).toBe(4000);
    expect(retryDelayMs(answer(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1005" }), 0, { now })).toBe(5000);
    // A 5xx carries the reset time too, but with quota left it is no reason to wait for it.
    expect(retryDelayMs(answer(503, { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "4600" }), 1, { now })).toBe(2000);
    expect(retryDelayMs(undefined, 2, { now })).toBe(4000);
  });
});
