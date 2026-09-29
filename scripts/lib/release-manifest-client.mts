/** Fetch and verify a published stable release for every release-data consumer. */
import { fetchWithRetry } from "./fetch-retry.mts";
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

/** A rate limit, a 5xx or a dropped connection is retried a few times before it counts (see fetch-retry.mts). */
async function fetchPublished(url: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(url, init, { timeoutMs: FETCH_TIMEOUT_MS });
}

async function fetchRelease(tag: string): Promise<GitHubRelease> {
  const response = await fetchPublished(`${API_BASE}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: apiHeaders(),
  });
  if (response.status === 404) throw new Error(`No GitHub release exists for ${tag}.`);
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${tag}.`);
  return (await response.json()) as GitHubRelease;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchPublished(url, { headers: { "user-agent": "recordstuff-website-manifest" } });
  if (!response.ok) throw new Error(`Download of ${url} returned ${response.status}.`);
  return response.text();
}

/** Follow GitHub into its object store; only the final successful response proves reachability. */
async function assertAssetReachable(url: string): Promise<void> {
  const response = await fetchPublished(url, {
    method: "HEAD",
    redirect: "follow",
    headers: { "user-agent": "recordstuff-website-manifest" },
  });
  if (!response.ok) {
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
  let releaseJson: ReleaseJson;
  try {
    releaseJson = JSON.parse(releaseJsonText) as ReleaseJson;
  } catch (error) {
    throw new Error(`${tag}: release.json at ${releaseJsonAsset.browser_download_url} is not valid JSON: ${(error as Error).message}`);
  }
  const manifest = buildManifest({ tag, release, releaseJson, sha256sums, now });
  await assertAssetReachable(manifest.dmg.url);
  return manifest;
}
