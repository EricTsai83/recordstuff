import { describe, it, expect, vi, afterEach } from "vitest";
import { API_URL, DAY_MS, DOWNLOAD_URL, FEED_URL, RELEASES_URL, UpdateChecker, feedVersion, fetchVersion, githubVersion, isNewer, stableVersion } from "./updates";
const feed = { version: "0.2.0", tag: "v0.2.0", platform: "darwin-arm64", architecture: "arm64", publishedAt: "2026-09-20T00:00:00Z", downloadUrl: DOWNLOAD_URL, releaseUrl: `${RELEASES_URL}/tag/v0.2.0`, dmg: { name: "RecordStuff-0.2.0-arm64-selfsigned.dmg", size: 123, sha256: "a".repeat(64) } };
const gh = { tag_name: "v0.2.0", draft: false, prerelease: false, assets: [{ name: feed.dmg.name }] };
function harness() {
  let settled = true;
  const preference = { enabled: true, lastAttempt: 0 };
  const options = { localVersion: "0.1.2", settled: () => settled, preference: () => preference,
    saveAttempt: vi.fn(async (at: number) => { preference.lastAttempt = at; }),
    fetch: vi.fn(async (_signal: AbortSignal) => "0.2.0"), changed: vi.fn(), log: vi.fn(), now: () => DAY_MS * 2 };
  return { checker: new UpdateChecker(options), options, preference, busy: (value: boolean) => { settled = !value; } };
}
afterEach(() => vi.restoreAllMocks());
describe("release validation", () => {
  it.each([["0.2.0", true], ["0.1.2", false], ["0.1.1", false], ["0.2.0-beta.1", false], ["junk", false], ["01.2.3", false], ["0.1.2+build", false], ["1.0.0", true]])("compares %s", (v, expected) => expect(isNewer(v, "0.1.2")).toBe(expected));
  it("compares large components without precision loss", () => expect(isNewer("999999999999999999999.0.0", "999999999999999999998.0.0")).toBe(true));
  it("rejects malformed build metadata", () => expect(stableVersion("1.0.0+a..b")).toBeUndefined());
  it("accepts the complete matching feed", () => expect(feedVersion(feed, "darwin", "arm64")).toBe("0.2.0"));
  it.each(Object.keys(feed))("rejects missing %s", (key) => { const bad: Record<string, unknown> = { ...feed }; delete bad[key]; expect(() => feedVersion(bad, "darwin", "arm64")).toThrow(); });
  it("rejects architecture, platform, prerelease and untrusted link", () => {
    expect(() => feedVersion(feed, "darwin", "x64")).toThrow();
    expect(() => feedVersion(feed, "win32", "arm64")).toThrow();
    expect(() => feedVersion({ ...feed, version: "0.2.0-beta" }, "darwin", "arm64")).toThrow();
    expect(() => feedVersion({ ...feed, downloadUrl: "https://evil.test" }, "darwin", "arm64")).toThrow();
  });
  it("requires a stable published matching GitHub asset", () => {
    expect(githubVersion(gh, "darwin", "arm64")).toBe("0.2.0");
    for (const bad of [{ ...gh, draft: true }, { ...gh, prerelease: true }, { ...gh, assets: [] }]) expect(() => githubVersion(bad, "darwin", "arm64")).toThrow();
    expect(() => githubVersion(gh, "darwin", "x64")).toThrow();
  });
});
describe("network", () => {
  it("makes only the static request on success", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(feed));
    expect(await fetchVersion("darwin", "arm64", new AbortController().signal, request)).toBe("0.2.0");
    expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0]![0]).toBe(FEED_URL);
  });
  it("falls back on HTTP failure and malformed feed", async () => {
    for (const response of [new Response("", { status: 503 }), Response.json({})]) {
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response).mockResolvedValueOnce(Response.json(gh));
      expect(await fetchVersion("darwin", "arm64", new AbortController().signal, request)).toBe("0.2.0");
      expect(request.mock.calls[1]![0]).toBe(API_URL);
    }
  });
  it("rejects when both sources fail", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    await expect(fetchVersion("darwin", "arm64", new AbortController().signal, request)).rejects.toThrow("offline");
  });
  it("bounds each request and cancels without falling back on shutdown", async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => { expect(ms).toBe(8000); return AbortSignal.abort(new Error("timeout")); });
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { signals.push(init!.signal!); init!.signal!.throwIfAborted(); throw new Error("unreachable"); });
    await expect(fetchVersion("darwin", "arm64", new AbortController().signal, request)).rejects.toThrow("timeout");
    expect(signals).toHaveLength(2);
    const controller = new AbortController(); controller.abort(); request.mockClear();
    await expect(fetchVersion("darwin", "arm64", controller.signal, request)).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  });
});
describe("lifecycle", () => {
  it("checks once per launch and persists the 24 hour limit", async () => {
    const h = harness(); await h.checker.check(false); await h.checker.check(false);
    expect(h.options.fetch).toHaveBeenCalledTimes(1); expect(h.preference.lastAttempt).toBe(DAY_MS * 2);
    const restarted = new UpdateChecker(h.options); await restarted.check(false); expect(h.options.fetch).toHaveBeenCalledTimes(1);
    await restarted.check(true); expect(h.options.fetch).toHaveBeenCalledTimes(2);
  });
  it("checks after the system clock moves backwards", async () => {
    const h = harness(); h.preference.lastAttempt = DAY_MS * 20;
    await h.checker.check(false); expect(h.options.fetch).toHaveBeenCalledTimes(1);
    expect(h.preference.lastAttempt).toBe(DAY_MS * 2);
  });
  it("manual checks survive failed settings writes; launch checks do not bypass persistence", async () => {
    const h = harness(); h.options.saveAttempt.mockRejectedValue(new Error("disk full"));
    await h.checker.check(false); expect(h.options.fetch).not.toHaveBeenCalled();
    await h.checker.check(true); expect(h.checker.state.kind).toBe("available");
    expect(h.options.log).toHaveBeenCalledWith(expect.stringContaining("cannot persist manual"));
  });
  it("preference off suppresses launch but permits manual checks", async () => {
    const h = harness(); h.preference.enabled = false; await h.checker.check(false); expect(h.options.fetch).not.toHaveBeenCalled();
    await h.checker.check(true); expect(h.checker.state.kind).toBe("available");
  });
  it("defers checks during recording", async () => {
    const h = harness(); h.busy(true); await h.checker.check(true); expect(h.options.fetch).not.toHaveBeenCalled();
    h.busy(false); h.checker.flush(); await vi.waitFor(() => expect(h.checker.state.kind).toBe("available"));
  });
  it("hides results until recording ends and suppresses overlapping requests", async () => {
    const h = harness(); let resolve!: (v: string) => void;
    h.options.fetch.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const pending = h.checker.check(true); await vi.waitFor(() => expect(h.options.fetch).toHaveBeenCalledTimes(1));
    h.busy(true); await h.checker.check(true); h.options.changed.mockClear(); resolve("0.2.0"); await pending;
    expect(h.options.changed).not.toHaveBeenCalled(); h.busy(false); h.checker.flush(); expect(h.checker.state.kind).toBe("available");
  });
  it("defers a launch when recording starts during preference persistence", async () => {
    const h = harness(); h.options.saveAttempt.mockImplementationOnce(async (at) => { h.preference.lastAttempt = at; h.busy(true); });
    await h.checker.check(false); expect(h.options.fetch).not.toHaveBeenCalled();
    h.busy(false); h.checker.flush(); await vi.waitFor(() => expect(h.checker.state.kind).toBe("available"));
  });
  it("fails silently on launch, explicitly on manual check, without reporting current", async () => {
    const h = harness(); h.options.fetch.mockRejectedValue(new Error("offline"));
    await h.checker.check(false); expect(h.checker.state.kind).toBe("idle"); expect(h.options.log).toHaveBeenCalled();
    await h.checker.check(true); expect(h.checker.state.kind).toBe("failed");
  });
  it("cancels shutdown and never publishes a late result", async () => {
    const h = harness(); let signal!: AbortSignal, resolve!: (v: string) => void;
    h.options.fetch.mockImplementation((s) => { signal = s; return new Promise((r) => { resolve = r; }); });
    const pending = h.checker.check(true); await vi.waitFor(() => expect(h.options.fetch).toHaveBeenCalled());
    h.checker.dispose(); h.options.changed.mockClear(); expect(signal.aborted).toBe(true); resolve("0.2.0"); await pending;
    h.checker.flush(); await h.checker.check(true); expect(h.options.changed).not.toHaveBeenCalled();
  });
});
