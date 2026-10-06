import { stableVersion } from "../../../src/shared/version.ts";
/**
 * Shared release manifest schema, validation and presentation helpers.
 *
 * The manifest supplies published download facts for release records and the site.
 * It is generated from a published GitHub release (release.json, SHA256SUMS and
 * the asset list) and re-verified before every build, so the page can only ever
 * advertise a release that exists and matches its checksum.
 */

export const REPOSITORY = "EricTsai83/recordstuff";
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;
export const ARCHITECTURE = "arm64";
export const PLATFORM = "darwin-arm64";
export const WINDOWS_ARCHITECTURE = "x64";
export const WINDOWS_PLATFORM = "win32-x64";
/** The Windows installer's own record, beside the macOS `release.json` whose shape installed apps rely on. */
export const WINDOWS_RECORD = "release-win32-x64.json";
/**
 * The last version published for macOS alone. Every later version, its
 * pre-releases included, carries the Windows installer and its record, while
 * the tooling on main can still verify every earlier tag by its own asset set.
 */
export const LAST_MACOS_ONLY_VERSION = "1.1.1";

export interface ReleaseManifest {
  version: string;
  tag: string;
  sourceCommit: string;
  publishedAt: string;
  platform: typeof PLATFORM;
  architecture: typeof ARCHITECTURE;
  dmg: {
    name: string;
    size: number;
    sha256: string;
    url: string;
  };
  /** Present exactly for versions after LAST_MACOS_ONLY_VERSION. */
  windows?: {
    platform: typeof WINDOWS_PLATFORM;
    name: string;
    size: number;
    sha256: string;
    url: string;
    recordUrl: string;
  };
  sha256sumsUrl: string;
  releaseJsonUrl: string;
  releaseUrl: string;
  notesUrl: string;
  verifiedAt: string;
}

/** The subset of GitHub's release API response the manifest depends on. */
export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  html_url: string;
  assets: GitHubAsset[];
}

export interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
  /** `sha256:<hex>`; GitHub computes it for assets uploaded since 2025. */
  digest?: string | null;
}

/** release.json as written by scripts/release.mts candidate. */
export interface ReleaseJson {
  tag: string;
  version: string;
  sourceCommit: string;
  repository: string;
  platform: string;
  file: string;
  size: number;
  sha256: string;
}

/** release-win32-x64.json as written by scripts/release.mts candidate-windows. */
export interface WindowsReleaseJson {
  tag: string;
  version: string;
  sourceCommit: string;
  repository: string;
  platform: string;
  file: string;
  size: number;
  sha256: string;
  appAsarSHA256: string;
  signature: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export function parseStableTag(tag: string): string {
  if (!tag.startsWith("v") || tag.includes("+") || !stableVersion(tag.slice(1))) {
    throw new Error(`Tag ${tag} is not a stable vX.Y.Z tag; pre-releases are never published on the site.`);
  }
  return tag.slice(1);
}

export function expectedDmgName(version: string): string {
  return `RecordStuff-${version}-${ARCHITECTURE}-selfsigned.dmg`;
}

export function expectedWindowsInstallerName(version: string): string {
  return `RecordStuff-${version}-${WINDOWS_ARCHITECTURE}-unsigned-setup.exe`;
}

/** Whether `version` (stable or pre-release) is published for Windows too; its numeric core decides. */
export function carriesWindows(version: string): boolean {
  const core = (v: string) => v.split(/[-+]/)[0]!.split(".").map(Number);
  const a = core(version), b = core(LAST_MACOS_ONLY_VERSION);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export function expectedAssetNames(version: string): string[] {
  return [expectedDmgName(version), "release.json", "SHA256SUMS",
    ...(carriesWindows(version) ? [expectedWindowsInstallerName(version), WINDOWS_RECORD] : [])];
}

/** Checks a Windows record against the release context; size and digest are compared by the caller with the bytes it holds. */
export function assertWindowsRecord(record: WindowsReleaseJson, expected: { tag: string; version: string; repository: string; sourceCommit?: string }): void {
  const file = expectedWindowsInstallerName(expected.version);
  if (record.tag !== expected.tag) throw new Error(`${WINDOWS_RECORD} tag ${record.tag} differs from ${expected.tag}.`);
  if (record.version !== expected.version) throw new Error(`${WINDOWS_RECORD} version ${record.version} differs from ${expected.version}.`);
  if (record.repository !== expected.repository) throw new Error(`${WINDOWS_RECORD} repository ${record.repository} is not ${expected.repository}.`);
  if (record.platform !== WINDOWS_PLATFORM) throw new Error(`${WINDOWS_RECORD} platform ${record.platform} is not ${WINDOWS_PLATFORM}.`);
  if (record.file !== file) throw new Error(`${WINDOWS_RECORD} file ${record.file} differs from ${file}.`);
  if (!COMMIT_PATTERN.test(record.sourceCommit)) throw new Error(`${WINDOWS_RECORD} sourceCommit is not a full SHA.`);
  if (expected.sourceCommit && record.sourceCommit !== expected.sourceCommit) throw new Error(`${WINDOWS_RECORD} sourceCommit ${record.sourceCommit} differs from ${expected.sourceCommit}.`);
  if (!SHA256_PATTERN.test(record.sha256)) throw new Error(`${WINDOWS_RECORD} sha256 is malformed.`);
  if (!SHA256_PATTERN.test(record.appAsarSHA256)) throw new Error(`${WINDOWS_RECORD} appAsarSHA256 is malformed.`);
  if (!Number.isInteger(record.size) || record.size <= 0) throw new Error(`${WINDOWS_RECORD} size is not a positive integer.`);
  if (record.signature !== "unsigned") throw new Error(`${WINDOWS_RECORD} signature ${record.signature} is not the expected "unsigned".`);
}

/** Parses `<sha256>  <filename>` lines into a name → hash map. */
export function parseSha256Sums(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    if (!match) throw new Error(`Unparseable SHA256SUMS line: ${JSON.stringify(rawLine)}`);
    entries.set(match[2]!, match[1]!);
  }
  if (entries.size === 0) throw new Error("SHA256SUMS is empty.");
  return entries;
}

function findAsset(release: GitHubRelease, name: string): GitHubAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`Release ${release.tag_name} has no asset named ${name}.`);
  return asset;
}

/**
 * Builds the manifest from independently fetched facts and refuses when they
 * disagree. Every check here corresponds to a way the site could otherwise
 * advertise something that is not the verified release.
 */
export function buildManifest(input: {
  tag: string;
  release: GitHubRelease;
  releaseJson: ReleaseJson;
  /** Required for versions that carry Windows. */
  windowsJson?: WindowsReleaseJson | undefined;
  sha256sums: string;
  now: Date;
}): ReleaseManifest {
  const { tag, release, releaseJson, windowsJson, sha256sums, now } = input;
  const version = parseStableTag(tag);

  if (release.tag_name !== tag) throw new Error(`GitHub returned ${release.tag_name} for ${tag}.`);
  if (release.draft) throw new Error(`${tag} is a draft release.`);
  if (release.prerelease) throw new Error(`${tag} is marked pre-release.`);
  if (!release.published_at) throw new Error(`${tag} has no published_at timestamp.`);

  const names = release.assets.map((asset) => asset.name).sort();
  const expected = [...expectedAssetNames(version)].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`${tag} assets ${JSON.stringify(names)} differ from expected ${JSON.stringify(expected)}.`);
  }

  const dmgName = expectedDmgName(version);
  const dmgAsset = findAsset(release, dmgName);
  const sumsAsset = findAsset(release, "SHA256SUMS");
  const jsonAsset = findAsset(release, "release.json");

  if (releaseJson.tag !== tag) throw new Error(`release.json tag ${releaseJson.tag} differs from ${tag}.`);
  if (releaseJson.version !== version) throw new Error(`release.json version ${releaseJson.version} differs from ${version}.`);
  if (releaseJson.repository !== REPOSITORY) throw new Error(`release.json repository ${releaseJson.repository} is not ${REPOSITORY}.`);
  if (releaseJson.platform !== PLATFORM) throw new Error(`release.json platform ${releaseJson.platform} is not ${PLATFORM}.`);
  if (releaseJson.file !== dmgName) throw new Error(`release.json file ${releaseJson.file} differs from ${dmgName}.`);
  if (!COMMIT_PATTERN.test(releaseJson.sourceCommit)) throw new Error(`release.json sourceCommit is not a full SHA.`);
  if (!SHA256_PATTERN.test(releaseJson.sha256)) throw new Error(`release.json sha256 is malformed.`);
  if (!Number.isInteger(releaseJson.size) || releaseJson.size <= 0) throw new Error(`release.json size is not a positive integer.`);
  if (releaseJson.size !== dmgAsset.size) {
    throw new Error(`release.json size ${releaseJson.size} differs from GitHub asset size ${dmgAsset.size}.`);
  }

  const sums = parseSha256Sums(sha256sums);
  const listedHash = sums.get(dmgName);
  if (!listedHash) throw new Error(`SHA256SUMS does not list ${dmgName}.`);
  if (listedHash !== releaseJson.sha256) {
    throw new Error(`SHA256SUMS hash ${listedHash} differs from release.json sha256 ${releaseJson.sha256}.`);
  }
  if (dmgAsset.digest) {
    const digest = dmgAsset.digest.replace(/^sha256:/, "");
    if (digest !== releaseJson.sha256) {
      throw new Error(`GitHub asset digest ${digest} differs from release.json sha256 ${releaseJson.sha256}.`);
    }
  }

  let windows: ReleaseManifest["windows"];
  if (carriesWindows(version)) {
    if (!windowsJson) throw new Error(`${tag} carries Windows but its ${WINDOWS_RECORD} was not supplied.`);
    assertWindowsRecord(windowsJson, { tag, version, repository: REPOSITORY, sourceCommit: releaseJson.sourceCommit });
    const installerAsset = findAsset(release, windowsJson.file);
    const recordAsset = findAsset(release, WINDOWS_RECORD);
    if (windowsJson.size !== installerAsset.size) {
      throw new Error(`${WINDOWS_RECORD} size ${windowsJson.size} differs from GitHub asset size ${installerAsset.size}.`);
    }
    const listed = sums.get(windowsJson.file);
    if (listed !== windowsJson.sha256) throw new Error(`SHA256SUMS hash ${listed ?? "missing"} for ${windowsJson.file} differs from ${WINDOWS_RECORD} sha256 ${windowsJson.sha256}.`);
    if (installerAsset.digest && installerAsset.digest.replace(/^sha256:/, "") !== windowsJson.sha256) {
      throw new Error(`GitHub asset digest for ${windowsJson.file} differs from ${WINDOWS_RECORD} sha256 ${windowsJson.sha256}.`);
    }
    windows = { platform: WINDOWS_PLATFORM, name: windowsJson.file, size: installerAsset.size, sha256: windowsJson.sha256,
      url: installerAsset.browser_download_url, recordUrl: recordAsset.browser_download_url };
  }
  if (sums.size !== (windows ? 2 : 1)) throw new Error(`SHA256SUMS lists ${sums.size} files; expected ${windows ? 2 : 1}.`);

  return {
    version,
    tag,
    sourceCommit: releaseJson.sourceCommit,
    publishedAt: release.published_at,
    platform: PLATFORM,
    architecture: ARCHITECTURE,
    dmg: {
      name: dmgName,
      size: dmgAsset.size,
      sha256: releaseJson.sha256,
      url: dmgAsset.browser_download_url,
    },
    sha256sumsUrl: sumsAsset.browser_download_url,
    ...(windows ? { windows } : {}),
    releaseJsonUrl: jsonAsset.browser_download_url,
    releaseUrl: release.html_url,
    notesUrl: release.html_url,
    verifiedAt: now.toISOString(),
  };
}

/** Structural validation of a manifest read from disk; throws on any defect. */
export function assertManifestShape(value: unknown): ReleaseManifest {
  if (typeof value !== "object" || value === null) throw new Error("Manifest is not an object.");
  const manifest = value as Record<string, unknown>;
  const requireString = (key: keyof ReleaseManifest) => {
    const field = manifest[key];
    if (typeof field !== "string" || field.length === 0) throw new Error(`Manifest field ${key} is missing.`);
    return field;
  };
  const tag = requireString("tag");
  const version = parseStableTag(tag);
  if (requireString("version") !== version) throw new Error("Manifest version does not match its tag.");
  if (!COMMIT_PATTERN.test(requireString("sourceCommit"))) throw new Error("Manifest sourceCommit is malformed.");
  if (Number.isNaN(Date.parse(requireString("publishedAt")))) throw new Error("Manifest publishedAt is not a date.");
  if (Number.isNaN(Date.parse(requireString("verifiedAt")))) throw new Error("Manifest verifiedAt is not a date.");
  if (manifest.platform !== PLATFORM) throw new Error("Manifest platform is not darwin-arm64.");
  if (manifest.architecture !== ARCHITECTURE) throw new Error("Manifest architecture is not arm64.");
  for (const key of ["sha256sumsUrl", "releaseJsonUrl", "releaseUrl", "notesUrl"] as const) {
    assertGitHubUrl(requireString(key), key);
  }
  // The exact addresses the release has, so the offline check catches what the app's feed reader refuses
  // (updates.ts `feedVersion` requires releaseUrl to be the tag's page), not only what online verification does.
  const releasePage = `https://github.com/${REPOSITORY}/releases/tag/${tag}`;
  const expected = { releaseUrl: releasePage, notesUrl: releasePage,
    sha256sumsUrl: `https://github.com/${REPOSITORY}/releases/download/${tag}/SHA256SUMS`,
    releaseJsonUrl: `https://github.com/${REPOSITORY}/releases/download/${tag}/release.json` } as const;
  for (const [key, url] of Object.entries(expected)) {
    if (manifest[key] !== url) throw new Error(`Manifest ${key} must be ${url}.`);
  }
  const dmg = manifest.dmg as Record<string, unknown> | undefined;
  if (!dmg || typeof dmg !== "object") throw new Error("Manifest dmg block is missing.");
  if (dmg.name !== expectedDmgName(version)) throw new Error("Manifest dmg.name does not match the version.");
  if (!Number.isInteger(dmg.size) || (dmg.size as number) <= 0) throw new Error("Manifest dmg.size is invalid.");
  if (typeof dmg.sha256 !== "string" || !SHA256_PATTERN.test(dmg.sha256)) throw new Error("Manifest dmg.sha256 is malformed.");
  if (typeof dmg.url !== "string") throw new Error("Manifest dmg.url is missing.");
  assertGitHubUrl(dmg.url, "dmg.url");
  if (!dmg.url.endsWith(`/${tag}/${dmg.name}`)) throw new Error("Manifest dmg.url does not point at the tagged asset.");
  const windows = manifest.windows as Record<string, unknown> | undefined;
  if (!carriesWindows(version)) {
    if (windows !== undefined) throw new Error(`Manifest has a windows block, but ${tag} was published for macOS only.`);
  } else {
    if (!windows || typeof windows !== "object") throw new Error("Manifest windows block is missing.");
    if (windows.platform !== WINDOWS_PLATFORM) throw new Error("Manifest windows.platform is not win32-x64.");
    if (windows.name !== expectedWindowsInstallerName(version)) throw new Error("Manifest windows.name does not match the version.");
    if (!Number.isInteger(windows.size) || (windows.size as number) <= 0) throw new Error("Manifest windows.size is invalid.");
    if (typeof windows.sha256 !== "string" || !SHA256_PATTERN.test(windows.sha256)) throw new Error("Manifest windows.sha256 is malformed.");
    for (const [key, name] of [["url", windows.name], ["recordUrl", WINDOWS_RECORD]] as const) {
      const url = windows[key];
      if (typeof url !== "string") throw new Error(`Manifest windows.${key} is missing.`);
      assertGitHubUrl(url, `windows.${key}`);
      if (!url.endsWith(`/${tag}/${name}`)) throw new Error(`Manifest windows.${key} does not point at the tagged asset.`);
    }
  }
  return manifest as unknown as ReleaseManifest;
}

function assertGitHubUrl(url: string, key: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Manifest ${key} is not a URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !parsed.pathname.startsWith(`/${REPOSITORY}/`)) {
    throw new Error(`Manifest ${key} must point at https://github.com/${REPOSITORY}/.`);
  }
}

/** Compares a stored manifest with freshly fetched facts; returns human-readable differences. */
export function diffManifest(stored: ReleaseManifest, fresh: ReleaseManifest): string[] {
  const differences: string[] = [];
  const compare = (label: string, a: unknown, b: unknown) => {
    if (a !== b) differences.push(`${label}: stored ${JSON.stringify(a)}, GitHub now ${JSON.stringify(b)}`);
  };
  compare("version", stored.version, fresh.version);
  compare("tag", stored.tag, fresh.tag);
  compare("sourceCommit", stored.sourceCommit, fresh.sourceCommit);
  compare("publishedAt", stored.publishedAt, fresh.publishedAt);
  compare("dmg.name", stored.dmg.name, fresh.dmg.name);
  compare("dmg.size", stored.dmg.size, fresh.dmg.size);
  compare("dmg.sha256", stored.dmg.sha256, fresh.dmg.sha256);
  compare("dmg.url", stored.dmg.url, fresh.dmg.url);
  for (const key of ["platform", "name", "size", "sha256", "url", "recordUrl"] as const) {
    compare(`windows.${key}`, stored.windows?.[key], fresh.windows?.[key]);
  }
  compare("sha256sumsUrl", stored.sha256sumsUrl, fresh.sha256sumsUrl);
  compare("releaseJsonUrl", stored.releaseJsonUrl, fresh.releaseJsonUrl);
  compare("releaseUrl", stored.releaseUrl, fresh.releaseUrl);
  compare("notesUrl", stored.notesUrl, fresh.notesUrl);
  return differences;
}

/** Each unit is chosen by the value as it will be shown, so rounding never prints "1000 kB" or "1000.0 MB". */
export function formatBytes(bytes: number): string {
  const megabytes = (bytes / 1_000_000).toFixed(1);
  if (Number(megabytes) >= 1000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  const kilobytes = (bytes / 1_000).toFixed(0);
  if (Number(kilobytes) >= 1000) return `${megabytes} MB`;
  if (bytes >= 1_000) return `${kilobytes} kB`;
  return `${bytes} bytes`;
}

export function formatReleaseDate(iso: string): string {
  return new Intl.DateTimeFormat("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(
    new Date(iso),
  );
}
