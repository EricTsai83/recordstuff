import { describe, it, expect, vi, afterEach } from "vitest";
import { API_URL, DAY_MS, DOWNLOAD_URL, FEED_URL, RELEASES_URL, UpdateChecker, feedVersion, fetchVersion, githubVersion, isNewer } from "./updates";
import { stableVersion } from "../shared/version";
const feed = { version: "0.2.0", tag: "v0.2.0", platform: "darwin-arm64", architecture: "arm64", publishedAt: "2026-09-20T00:00:00Z", downloadUrl: DOWNLOAD_URL, releaseUrl: `${RELEASES_URL}/tag/v0.2.0`, dmg: { name: "RecordStuff-0.2.0-arm64-selfsigned.dmg", size: 123, sha256: "a".repeat(64) } };
const gh = { tag_name: "v0.2.0", draft: false, prerelease: false, assets: [{ name: feed.dmg.name }] };
function harness() {
  let settled = true;
  const preference: { enabled: boolean; lastAttempt: number; notifiedVersion?: string } = { enabled: true, lastAttempt: 0 };
  const options = { localVersion: "0.1.2", settled: () => settled, preference: () => preference,
    saveAttempt: vi.fn(async (at: number) => { preference.lastAttempt = at; }),
    saveNotified: vi.fn(async (version: string) => { preference.notifiedVersion = version; }),
    announce: vi.fn((_version: string): boolean | void => {}),
    fetch: vi.fn(async (_signal: AbortSignal) => "0.2.0"), changed: vi.fn(), log: vi.fn(), now: () => DAY_MS * 2 };
  return { checker: new UpdateChecker(options), options, preference, busy: (value: boolean) => { settled = !value; } };
}
afterEach(() => vi.restoreAllMocks());
describe("release validation", () => {
  it.each([["0.2.0", true], ["0.1.2", false], ["0.1.1", false], ["0.2.0-beta.1", false], ["junk", false], ["01.2.3", false], ["0.1.2+build", false], ["1.0.0", true]])("compares %s", (v, expected) => expect(isNewer(v, "0.1.2")).toBe(expected));
  it.each([["1.2.0", "1.2.0-rc.1", true], ["1.2.1", "1.2.0-rc.1", true], ["1.1.9", "1.2.0-rc.1", false], ["1.2.0", "1.2.0", false], ["1.2.0", "1.2.0-", false], ["1.2.0", "01.2.0-rc.1", false]])(
    "compares published %s with installed %s", (remote, local, expected) => expect(isNewer(remote, local)).toBe(expected));
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
  it("finds the Windows x64 installer in a two-platform release, and nothing for another platform or a macOS-only one", () => {
    const both = { ...gh, assets: [{ name: feed.dmg.name }, { name: "RecordStuff-0.2.0-x64-unsigned-setup.exe" }, { name: "SHA256SUMS" }] };
    expect(githubVersion(both, "win32", "x64")).toBe("0.2.0");
    // A macOS app still finds its DMG among the extra assets.
    expect(githubVersion(both, "darwin", "arm64")).toBe("0.2.0");
    expect(() => githubVersion(gh, "win32", "x64")).toThrow();
    for (const [platform, arch] of [["win32", "arm64"], ["linux", "x64"]] as const) expect(() => githubVersion(both, platform, arch)).toThrow();
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
      const log = vi.fn();
      expect(await fetchVersion("darwin", "arm64", new AbortController().signal, request, log)).toBe("0.2.0");
      expect(request.mock.calls[1]![0]).toBe(API_URL);
      // A working fallback must not hide a broken feed.
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^updates: feed failed \(Error: (HTTP 503|invalid release object)\); trying GitHub$/));
    }
  });
  it("reads only GitHub on Windows, since the feed describes the macOS DMG", async () => {
    const release = { ...gh, assets: [{ name: "RecordStuff-0.2.0-x64-unsigned-setup.exe" }] };
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(release));
    const log = vi.fn();
    expect(await fetchVersion("win32", "x64", new AbortController().signal, request, log)).toBe("0.2.0");
    expect(request.mock.calls.map(([url]) => url)).toEqual([API_URL]);
    expect(log).not.toHaveBeenCalled();
    request.mockResolvedValue(new Response("", { status: 503 }));
    await expect(fetchVersion("win32", "x64", new AbortController().signal, request)).rejects.toThrow("HTTP 503");
  });
  it("rejects with both causes when both sources fail", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("", { status: 404 })).mockRejectedValueOnce(new Error("offline"));
    await expect(fetchVersion("darwin", "arm64", new AbortController().signal, request)).rejects.toThrow("feed: Error: HTTP 404; GitHub: Error: offline");
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
  it("offers the stable release to a pre-release install and says a pre-release of the published version is current", async () => {
    const h = harness();
    const rc = new UpdateChecker({ ...h.options, localVersion: "0.2.0-rc.1" });
    await rc.check(true); expect(rc.state).toEqual({ kind: "available", version: "0.2.0" });
    const next = new UpdateChecker({ ...h.options, localVersion: "0.3.0-rc.1" });
    await next.check(true); expect(next.state.kind).toBe("current");
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
    // The result waits, but the panel stops saying a check is running.
    expect(h.checker.state.kind).toBe("idle"); expect(h.options.changed).toHaveBeenCalledTimes(1);
    h.busy(false); h.checker.flush(); expect(h.checker.state.kind).toBe("available");
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


it("shows the previous result while a check deferred by a session waits", async () => {
  const h = harness();
  await h.checker.check(true);
  const previous = h.checker.state;
  // The recorder becomes busy while the attempt timestamp is being saved.
  h.options.saveAttempt.mockImplementationOnce(async () => { h.busy(true); });
  h.options.changed.mockClear();
  await h.checker.check(true);
  expect(h.checker.state).toEqual(previous);
  // Once for "checking", once for the return to the previous result: the panel stops saying a check is running.
  expect(h.options.changed).toHaveBeenCalledTimes(2);
  expect(h.options.fetch).toHaveBeenCalledTimes(1);
  h.busy(false); h.checker.flush();
  await vi.waitFor(() => expect(h.options.fetch).toHaveBeenCalledTimes(2));
});

it("preserves the last result throughout a repeated check", async () => {
  const h = harness();
  await h.checker.check(true);
  const previous = h.checker.state;
  let finish!: (version: string) => void;
  h.options.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const checking = h.checker.check(true);
  await vi.waitFor(() => expect(h.options.fetch).toHaveBeenCalledTimes(2));
  expect(h.checker.state).toEqual({ kind: "checking", previous });
  await h.checker.check(true);
  expect(h.options.fetch).toHaveBeenCalledTimes(2);
  finish("0.1.2"); await checking;
  expect(h.checker.state.kind).toBe("current");
});

describe("launch check settles visibly (plan 049)", () => {
  it("logs once when the launch check is skipped, so a measurement knows startup work is done", async () => {
    const recent = harness();
    recent.preference.lastAttempt = DAY_MS * 2 - 1000;
    await recent.checker.check(false);
    await recent.checker.check(false);
    expect(recent.options.fetch).not.toHaveBeenCalled();
    expect(recent.options.log.mock.calls.map(([m]) => m)).toEqual(["updates: launch check skipped (checked within 24 hours)"]);
    const off = harness();
    off.preference.enabled = false;
    await off.checker.check(false);
    expect(off.options.log).toHaveBeenCalledWith("updates: launch check skipped (off)");
  });
});

describe("announcing a newer version once", () => {
  it("notifies when a launch check finds a version not yet told, and remembers it", async () => {
    const h = harness(); await h.checker.check(false);
    expect(h.options.announce).toHaveBeenCalledExactlyOnceWith("0.2.0");
    expect(h.options.saveNotified).toHaveBeenCalledExactlyOnceWith("0.2.0");
    expect(h.options.log).toHaveBeenCalledWith("updates: announced 0.2.0");
    // The next day's launch finds the same version: the panel shows it, no second notification.
    h.preference.lastAttempt = 0;
    const tomorrow = new UpdateChecker(h.options); await tomorrow.check(false);
    expect(tomorrow.state).toEqual({ kind: "available", version: "0.2.0" });
    expect(h.options.announce).toHaveBeenCalledTimes(1); expect(h.options.saveNotified).toHaveBeenCalledTimes(1);
  });
  it("leaves a version untold when a launch check could not notify, so a later launch announces it", async () => {
    const h = harness();
    h.options.announce.mockReturnValueOnce(false);
    await h.checker.check(false);
    expect(h.checker.state.kind).toBe("available");
    expect([h.options.announce.mock.calls.length, h.options.saveNotified.mock.calls.length, h.preference.notifiedVersion]).toEqual([1, 0, undefined]);
    expect(h.options.log).toHaveBeenCalledWith("updates: 0.2.0 not announced: notifications are off");
  });
  it("notifies again for a version newer than the one told", async () => {
    const h = harness(); h.preference.notifiedVersion = "0.1.9"; await h.checker.check(false);
    expect(h.options.announce).toHaveBeenCalledExactlyOnceWith("0.2.0");
  });
  it("never lowers the told version or announces an older release from a stale source", async () => {
    const h = harness(); h.preference.notifiedVersion = "0.3.0";
    await h.checker.check(false); await h.checker.check(true);
    expect(h.checker.state).toEqual({ kind: "available", version: "0.2.0" });
    expect(h.options.announce).not.toHaveBeenCalled(); expect(h.options.saveNotified).not.toHaveBeenCalled();
    expect(h.preference.notifiedVersion).toBe("0.3.0");
  });
  it("marks a manual result as told without notifying, so a later launch stays quiet", async () => {
    const h = harness(); await h.checker.check(true);
    expect(h.options.announce).not.toHaveBeenCalled(); expect(h.preference.notifiedVersion).toBe("0.2.0");
    h.preference.lastAttempt = 0;
    await new UpdateChecker(h.options).check(false); expect(h.options.announce).not.toHaveBeenCalled();
  });
  it("says nothing for a current version or a failed launch check", async () => {
    const current = harness(); current.options.fetch.mockResolvedValue("0.1.2"); await current.checker.check(false);
    const failed = harness(); failed.options.fetch.mockRejectedValue(new Error("offline")); await failed.checker.check(false);
    for (const h of [current, failed]) { expect(h.options.announce).not.toHaveBeenCalled(); expect(h.options.saveNotified).not.toHaveBeenCalled(); }
  });
  it("holds the notification with the result while recording, then notifies once it ends", async () => {
    const h = harness(); let resolve!: (v: string) => void;
    h.options.fetch.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const pending = h.checker.check(false); await vi.waitFor(() => expect(h.options.fetch).toHaveBeenCalledTimes(1));
    h.busy(true); resolve("0.2.0"); await pending;
    expect(h.options.announce).not.toHaveBeenCalled(); expect(h.options.saveNotified).not.toHaveBeenCalled();
    h.busy(false); h.checker.flush();
    expect(h.options.announce).toHaveBeenCalledExactlyOnceWith("0.2.0"); expect(h.preference.notifiedVersion).toBe("0.2.0");
    h.checker.flush(); expect(h.options.announce).toHaveBeenCalledTimes(1);
  });
  it("does not notify for a manual result held by recording", async () => {
    const h = harness(); let resolve!: (v: string) => void;
    h.options.fetch.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const pending = h.checker.check(true); await vi.waitFor(() => expect(h.options.fetch).toHaveBeenCalledTimes(1));
    h.busy(true); resolve("0.2.0"); await pending;
    h.busy(false); h.checker.flush();
    expect(h.checker.state.kind).toBe("available"); expect(h.options.announce).not.toHaveBeenCalled();
  });
  it("logs a failed save of the told version and still notifies", async () => {
    const h = harness(); h.options.saveNotified.mockRejectedValue(new Error("disk full"));
    await h.checker.check(false);
    expect(h.options.announce).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.options.log).toHaveBeenCalledWith(expect.stringContaining("cannot persist the announced version: Error: disk full")));
  });
});
