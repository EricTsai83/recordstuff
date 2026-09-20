/** Fetch and verify a published stable release for every release-data consumer. */
import { REPOSITORY, buildManifest, parseStableTag, type GitHubRelease, type ReleaseJson, type ReleaseManifest } from "./release-manifest.mts";

const API_BASE = `https://api.github.com/repos/${REPOSITORY}`;
const FETCH_TIMEOUT_MS = 20_000;

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "recordstuff-website-manifest",
    "x-github-api-version": "2022-11-28",
  };
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return response;
}

async function fetchRelease(tag: string): Promise<GitHubRelease> {
  const response = await fetchWithTimeout(`${API_BASE}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: apiHeaders(),
  });
  if (response.status === 404) throw new Error(`No GitHub release exists for ${tag}.`);
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${tag}.`);
  return (await response.json()) as GitHubRelease;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithTimeout(url, { headers: { "user-agent": "recordstuff-website-manifest" } });
  if (!response.ok) throw new Error(`Download of ${url} returned ${response.status}.`);
  return response.text();
}

/** GitHub answers asset URLs with a redirect to its object store; both 200 and 302 prove the asset exists. */
async function assertAssetReachable(url: string): Promise<void> {
  const response = await fetchWithTimeout(url, {
    method: "HEAD",
    redirect: "manual",
    headers: { "user-agent": "recordstuff-website-manifest" },
  });
  if (response.status !== 200 && response.status !== 302) {
    throw new Error(`HEAD ${url} returned ${response.status}; the download button would be broken.`);
  }
}

export async function fetchManifest(tag: string, now = new Date()): Promise<ReleaseManifest> {
  parseStableTag(tag);
  const release = await fetchRelease(tag);
  const releaseJsonAsset = release.assets.find((asset) => asset.name === "release.json");
  const sumsAsset = release.assets.find((asset) => asset.name === "SHA256SUMS");
  if (!releaseJsonAsset || !sumsAsset) {
    throw new Error(`${tag} lacks release.json or SHA256SUMS; it was not published by the release workflow.`);
  }
  const [releaseJsonText, sha256sums] = await Promise.all([
    fetchText(releaseJsonAsset.browser_download_url),
    fetchText(sumsAsset.browser_download_url),
  ]);
  const releaseJson = JSON.parse(releaseJsonText) as ReleaseJson;
  const manifest = buildManifest({ tag, release, releaseJson, sha256sums, now });
  await assertAssetReachable(manifest.dmg.url);
  return manifest;
}
