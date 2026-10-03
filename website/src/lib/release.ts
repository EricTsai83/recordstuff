/**
 * Build-time view of the verified release.
 *
 * The manifest is read once when Astro renders; nothing on the page fetches
 * GitHub at runtime. `pnpm build` runs `manifest.mts verify` first and only
 * then sets SITE_MANIFEST_VERIFIED=1 for the Astro build, so a manifest that no
 * longer matches the published release stops the build. Every other render
 * (`astro dev`, `build:offline`) lacks that evidence and is marked not
 * re-verified so a design preview cannot be mistaken for a publishable site.
 */

import manifestJson from "../../release-manifest.json" with { type: "json" };
import {
  RELEASES_URL,
  REPOSITORY,
  REPOSITORY_URL,
  assertManifestShape,
  formatBytes,
  formatReleaseDate,
  type ReleaseManifest,
} from "../../../scripts/lib/release-manifest.mts";

export const manifest: ReleaseManifest = assertManifestShape(manifestJson);

/**
 * The Windows x64 installer's facts, or undefined for a release published for
 * macOS alone (1.1.1 and earlier), whose manifest has no windows block.
 */
export function windowsRelease(source: ReleaseManifest) {
  const windows = source.windows;
  if (!windows) return undefined;
  return {
    architectureLabel: "x64",
    name: windows.name,
    size: windows.size,
    sizeLabel: formatBytes(windows.size),
    sha256: windows.sha256,
    /** Direct installer download from the tagged GitHub release. */
    url: windows.url,
    /** release-win32-x64.json: the installer's source commit, version, size and SHA-256. */
    recordUrl: windows.recordUrl,
  } as const;
}

export const reverified = process.env.SITE_MANIFEST_VERIFIED === "1";

export const release = {
  version: manifest.version,
  tag: manifest.tag,
  architectureLabel: "Apple silicon (arm64)",
  fileName: manifest.dmg.name,
  sizeBytes: manifest.dmg.size,
  sizeLabel: formatBytes(manifest.dmg.size),
  sha256: manifest.dmg.sha256,
  publishedLabel: formatReleaseDate(manifest.publishedAt),
  sourceCommitShort: manifest.sourceCommit.slice(0, 7),
  /** Direct DMG. Always present because the manifest validated; the Releases page is the visible fallback. */
  dmgUrl: manifest.dmg.url,
  sha256sumsUrl: manifest.sha256sumsUrl,
  releaseJsonUrl: manifest.releaseJsonUrl,
  notesUrl: manifest.notesUrl,
  sourceCommitUrl: `${REPOSITORY_URL}/commit/${manifest.sourceCommit}`,
  /** Absent for macOS-only releases; pages then say which release first carries Windows. */
  windows: windowsRelease(manifest),
} as const;

export const links = {
  repository: REPOSITORY_URL,
  /** owner/name, as `gh attestation verify --repo` takes it. */
  repositorySlug: REPOSITORY,
  releases: RELEASES_URL,
  issues: `${REPOSITORY_URL}/issues`,
  license: `${REPOSITORY_URL}/blob/main/LICENSE`,
  installGuide: `${REPOSITORY_URL}/blob/${manifest.sourceCommit}/resources/INSTALL.md`,
  installGuideZh: `${REPOSITORY_URL}/blob/${manifest.sourceCommit}/resources/INSTALL.zh-TW.md`,
  verificationRecord: `${REPOSITORY_URL}/blob/main/docs/verification/README.md`,
  appleOpenAnyway: "https://support.apple.com/102445",
} as const;
