/**
 * One HTTP request with a few bounded retries, for the website build's network
 * checks (the release manifest and external links). Vercel builds from shared
 * addresses without GitHub credentials, so a single rate-limit answer or reset
 * connection used to fail the deploy and leave the previous site, and its
 * release feed, live. Only answers that can pass on their own are retried: a
 * network error, 429, a 5xx, or a 403 that GitHub marks as a rate limit.
 */
export interface RetryOptions {
  /** Total tries, the first included. */
  attempts?: number;
  /** Doubles per retry when the server names no wait. */
  baseDelayMs?: number;
  /** No single wait is longer, whatever the server asks for. */
  maxDelayMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function retryable(response: Response): boolean {
  if (response.status === 429 || response.status >= 500) return true;
  return response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"));
}

/** `retry-after` (seconds or an HTTP date), then GitHub's `x-ratelimit-reset`, then exponential backoff; always capped. */
export function retryDelayMs(response: Response | undefined, retry: number, options: RetryOptions = {}): number {
  const base = (options.baseDelayMs ?? 1000) * 2 ** retry;
  const max = options.maxDelayMs ?? 10_000;
  const now = (options.now ?? Date.now)();
  const after = response?.headers.get("retry-after");
  const reset = response?.headers.get("x-ratelimit-reset");
  let asked: number | undefined;
  if (after) asked = /^\d+$/.test(after.trim()) ? Number(after) * 1000 : Date.parse(after) - now;
  else if (reset && /^\d+$/.test(reset)) asked = Number(reset) * 1000 - now;
  const wait = asked !== undefined && Number.isFinite(asked) ? Math.max(asked, 0) : base;
  return Math.min(wait, max);
}

export async function fetchWithRetry(url: string, init: RequestInit = {}, options: RetryOptions = {}): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const request = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt >= attempts;
    let response: Response;
    try {
      response = await request(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
    } catch (error) {
      if (last) throw error;
      await sleep(retryDelayMs(undefined, attempt - 1, options));
      continue;
    }
    if (last || !retryable(response)) return response;
    await response.body?.cancel();
    await sleep(retryDelayMs(response, attempt - 1, options));
  }
}
