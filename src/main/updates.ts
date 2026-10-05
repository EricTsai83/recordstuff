/** User-triggered/once-per-launch checks; no polling or installation. */
import { stableVersion } from "../shared/version";

/** The project's public addresses; the About footer and the update check share them. */
export const WEBSITE_URL = "https://record.ericts.com";
export const SOURCE_URL = "https://github.com/EricTsai83/recordstuff";
export const RELEASES_URL = `${SOURCE_URL}/releases`;
export const DOWNLOAD_URL = `${WEBSITE_URL}/download`;
export const FEED_URL = `${WEBSITE_URL}/release.json`;
export const API_URL = "https://api.github.com/repos/EricTsai83/recordstuff/releases/latest";
export const DAY_MS = 86_400_000;
export type UpdateResult = { kind: "current"; checkedAt: number } | { kind: "available"; version: string } |
  { kind: "failed" };
export type UpdateState = { kind: "idle" } | { kind: "checking"; previous?: UpdateResult } | UpdateResult;

/**
 * The installed version: a stable one, or a pre-release build (`1.2.0-rc.1`,
 * the release tool's `vX.Y.Z-suffix`), which semver orders before its own
 * stable release. Undefined for anything else.
 */
function installedVersion(value: string): { core: bigint[]; prerelease: boolean } | undefined {
  const stable = stableVersion(value);
  if (stable) return { core: stable, prerelease: false };
  const match = /^(\d+\.\d+\.\d+)-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/.exec(value);
  const core = match ? stableVersion(match[1]) : undefined;
  return core ? { core, prerelease: true } : undefined;
}
/** Whether the published stable `remote` is newer than the installed `local`. */
export function isNewer(remote: string, local: string): boolean {
  const a = stableVersion(remote), b = installedVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b.core[i]) return a[i]! > b.core[i]!;
  return b.prerelease;
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
/** The release asset this platform installs, or undefined where none is published. */
function installerName(version: string, platform: string, arch: string): string | undefined {
  if (platform === "darwin") return `RecordStuff-${version}-${arch}-selfsigned.dmg`;
  if (platform === "win32" && arch === "x64") return `RecordStuff-${version}-x64-unsigned-setup.exe`;
  return undefined;
}
export function githubVersion(value: unknown, platform: string, arch: string): string {
  const r = object(value);
  const version = typeof r["tag_name"] === "string" ? r["tag_name"].replace(/^v/, "") : "";
  const name = installerName(version, platform, arch);
  if (!stableVersion(version) || r["draft"] !== false || r["prerelease"] !== false ||
      !name || !Array.isArray(r["assets"]) || !r["assets"].some((a: unknown) => object(a)["name"] === name)) {
    throw new Error("invalid or incompatible GitHub release");
  }
  return version;
}
/**
 * The website feed first, GitHub's API if it fails. A working fallback would
 * otherwise hide a broken feed, so its failure goes to `log`, and a check
 * that fails at both names both causes. The feed describes the macOS DMG
 * only (installed apps read its exact shape), so Windows reads GitHub alone.
 */
export async function fetchVersion(platform: string, arch: string, signal: AbortSignal,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch, log?: (message: string) => void): Promise<string> {
  const read = async (url: string, parse: typeof feedVersion): Promise<string> => {
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(8_000);
    const response = await request(url, { signal: AbortSignal.any([signal, timeout]), cache: "no-store", redirect: "error" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parse(await response.json(), platform, arch);
  };
  if (platform === "win32") return read(API_URL, githubVersion);
  let feedError: unknown;
  try {
    return await read(FEED_URL, feedVersion);
  } catch (error) {
    if (signal.aborted) throw error;
    feedError = error;
  }
  log?.(`updates: feed failed (${String(feedError)}); trying GitHub`);
  try {
    return await read(API_URL, githubVersion);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`feed: ${String(feedError)}; GitHub: ${String(error)}`, { cause: error });
  }
}
interface Options {
  localVersion: string;
  settled: () => boolean;
  preference: () => { enabled: boolean; lastAttempt: number; notifiedVersion?: string };
  saveAttempt: (at: number) => Promise<void>;
  /** Remembers the newest version the user has been told about, in a notification or the panel. */
  saveNotified?: (version: string) => Promise<void>;
  /**
   * A launch check found a version the user has not been told about yet. False when no notification could be asked
   * for (the user turned them off): the version then stays untold, so a launch once they are back on announces it.
   */
  announce?: (version: string) => boolean | void;
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
  /** Whether the deferred result came from a launch check, which alone notifies. */
  private deferredLaunch = false;
  private controller: AbortController | undefined;
  private disposed = false;
  constructor(private readonly options: Options) {}
  flush(): void {
    if (this.disposed || !this.options.settled()) return;
    if (this.deferred) {
      const result = this.deferred, launch = this.deferredLaunch;
      this.state = result; this.deferred = undefined; this.deferredLaunch = false; this.options.changed();
      this.told(result, launch);
    }
    if (this.manualPending) { this.manualPending = false; void this.check(true); }
    else if (this.launchPending) void this.check(false);
  }
  async check(manual: boolean): Promise<void> {
    if (this.disposed || this.controller) return;
    if (!this.options.settled()) { if (manual) this.manualPending = true; return; }
    const now = (this.options.now ?? Date.now)();
    const pref = this.options.preference();
    if (!manual && (!this.launchPending || !pref.enabled || (!this.retryLaunch && pref.lastAttempt <= now && now - pref.lastAttempt < DAY_MS))) {
      // Said once, so a measurement can tell that startup work has settled (plan 049).
      if (this.launchPending) this.options.log(`updates: launch check skipped (${pref.enabled ? "checked within 24 hours" : "off"})`);
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
        // Nothing was fetched: show the previous result, not a check that is not running.
        this.state = previous;
        this.deferred = previous;
        this.deferredLaunch = false;
        if (manual) this.manualPending = true;
        else { this.launchPending = true; this.retryLaunch = true; }
        this.options.changed();
        return;
      }
      const version = await this.options.fetch(controller.signal);
      if (!installedVersion(this.options.localVersion)) throw new Error(`local version ${this.options.localVersion} cannot be compared`);
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
    if (this.options.settled()) { this.state = result; this.options.changed(); this.told(result, !manual); return; }
    // Recording began during the fetch: the result waits, and the check is no longer running.
    this.state = previous;
    this.deferred = result;
    this.deferredLaunch = !manual;
    this.options.changed();
  }
  /**
   * A newer version is announced once: a launch check notifies about a version
   * newer than the last one told, and any shown result marks it told, so a
   * version first seen in the panel never notifies at a later launch. The told
   * version only moves forward: a stale source offering an older release than
   * one already told neither notifies nor lowers it. A launch check that
   * could not notify (notifications off) leaves it untold. A failed save only
   * means the next launch may notify again.
   */
  private told(result: UpdateState, launch: boolean): void {
    const told = this.options.preference().notifiedVersion;
    if (result.kind !== "available" || (told !== undefined && !isNewer(result.version, told))) return;
    if (launch && this.options.announce) {
      if (this.options.announce(result.version) === false) {
        this.options.log(`updates: ${result.version} not announced: notifications are off`);
        return;
      }
      this.options.log(`updates: announced ${result.version}`);
    }
    this.options.saveNotified?.(result.version).catch((error: unknown) =>
      this.options.log(`updates: cannot persist the announced version: ${String(error)}`));
  }
  dispose(): void { this.disposed = true; this.controller?.abort(); }
}
