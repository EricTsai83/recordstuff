/** User-triggered/once-per-launch checks; no polling or installation. */
export const RELEASES_URL = "https://github.com/EricTsai83/recordstuff/releases";
export const DOWNLOAD_URL = "https://record.ericts.com/download";
export const FEED_URL = "https://record.ericts.com/release.json";
export const API_URL = "https://api.github.com/repos/EricTsai83/recordstuff/releases/latest";
export const DAY_MS = 86_400_000;
export type UpdateResult = { kind: "current"; checkedAt: number } | { kind: "available"; version: string } |
  { kind: "failed" };
export type UpdateState = { kind: "idle" } | { kind: "checking"; previous?: UpdateResult } | UpdateResult;

export function stableVersion(value: unknown): bigint[] | undefined {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) return;
  return value.split("+")[0]!.split(".").map(BigInt);
}
export function isNewer(remote: string, local: string): boolean {
  const a = stableVersion(remote), b = stableVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid release object");
  return value as Record<string, unknown>;
}
export function feedVersion(value: unknown, platform: string, arch: string): string {
  const r = object(value), dmg = object(r["dmg"]);
  if (!stableVersion(r["version"]) || r["tag"] !== `v${r["version"]}` ||
      r["platform"] !== `${platform}-${arch}` || r["architecture"] !== arch ||
      typeof r["publishedAt"] !== "string" || !Number.isFinite(Date.parse(r["publishedAt"])) ||
      r["downloadUrl"] !== DOWNLOAD_URL || r["releaseUrl"] !== `${RELEASES_URL}/tag/${r["tag"]}` ||
      dmg["name"] !== `RecordStuff-${r["version"]}-${arch}-selfsigned.dmg` ||
      !Number.isSafeInteger(dmg["size"]) || Number(dmg["size"]) <= 0 ||
      typeof dmg["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(dmg["sha256"])) throw new Error("invalid or incompatible feed");
  return r["version"] as string;
}
export function githubVersion(value: unknown, platform: string, arch: string): string {
  const r = object(value);
  const version = typeof r["tag_name"] === "string" ? r["tag_name"].replace(/^v/, "") : "";
  if (!stableVersion(version) || r["draft"] !== false || r["prerelease"] !== false ||
      platform !== "darwin" || !Array.isArray(r["assets"]) ||
      !r["assets"].some((a: unknown) => object(a)["name"] === `RecordStuff-${version}-${arch}-selfsigned.dmg`)) {
    throw new Error("invalid or incompatible GitHub release");
  }
  return version;
}
export async function fetchVersion(platform: string, arch: string, signal: AbortSignal, request: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<string> {
  for (const [url, parse] of [[FEED_URL, feedVersion], [API_URL, githubVersion]] as const) {
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(8_000);
    try {
      const response = await request(url, { signal: AbortSignal.any([signal, timeout]), cache: "no-store", redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parse(await response.json(), platform, arch);
    } catch (error) {
      if (signal.aborted || url === API_URL) throw error;
    }
  }
  throw new Error("no release");
}
interface Options {
  localVersion: string;
  settled: () => boolean;
  preference: () => { enabled: boolean; lastAttempt: number };
  saveAttempt: (at: number) => Promise<void>;
  fetch: (signal: AbortSignal) => Promise<string>;
  changed: () => void;
  log: (message: string) => void;
  now?: () => number;
}
export class UpdateChecker {
  state: UpdateState = { kind: "idle" };
  private launchPending = true;
  private retryLaunch = false;
  private manualPending = false;
  private deferred: UpdateState | undefined;
  private controller: AbortController | undefined;
  private disposed = false;
  constructor(private readonly options: Options) {}
  flush(): void {
    if (this.disposed || !this.options.settled()) return;
    if (this.deferred) { this.state = this.deferred; this.deferred = undefined; this.options.changed(); }
    if (this.manualPending) { this.manualPending = false; void this.check(true); }
    else if (this.launchPending) void this.check(false);
  }
  async check(manual: boolean): Promise<void> {
    if (this.disposed || this.controller) return;
    if (!this.options.settled()) { if (manual) this.manualPending = true; return; }
    const now = (this.options.now ?? Date.now)();
    const pref = this.options.preference();
    if (!manual && (!this.launchPending || !pref.enabled || (!this.retryLaunch && pref.lastAttempt <= now && now - pref.lastAttempt < DAY_MS))) {
      this.launchPending = false; return;
    }
    this.launchPending = false;
    this.retryLaunch = false;
    const controller = this.controller = new AbortController();
    const previous = this.state;
    this.state = { kind: "checking", ...(previous.kind !== "idle" && previous.kind !== "checking" ? { previous } : {}) }; this.options.changed();
    let result: UpdateState = previous;
    try {
      // Persist before networking, so fast relaunches (including failures) respect the limit.
      try { await this.options.saveAttempt(now); }
      catch (error) {
        if (!manual) throw error;
        this.options.log(`updates: cannot persist manual check timestamp: ${String(error)}`);
      }
      if (this.disposed) return;
      if (!this.options.settled()) {
        this.deferred = previous;
        if (manual) this.manualPending = true;
        else { this.launchPending = true; this.retryLaunch = true; }
        return;
      }
      const version = await this.options.fetch(controller.signal);
      if (!stableVersion(this.options.localVersion)) throw new Error("local version is not a stable release");
      result = isNewer(version, this.options.localVersion)
        ? { kind: "available", version } : { kind: "current", checkedAt: (this.options.now ?? Date.now)() };
      this.options.log(`updates: ${result.kind}; remote ${version}`);
    } catch (error) {
      if (this.disposed) return;
      this.options.log(`updates: check failed: ${String(error)}`);
      result = manual ? { kind: "failed" } : previous;
    } finally {
      this.controller = undefined;
    }
    if (this.disposed) return;
    if (this.options.settled()) { this.state = result; this.options.changed(); }
    else this.deferred = result;
  }
  dispose(): void { this.disposed = true; this.controller?.abort(); }
}
