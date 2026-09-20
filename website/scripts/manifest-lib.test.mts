import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertManifestShape,
  buildManifest,
  diffManifest,
  expectedDmgName,
  formatBytes,
  parseSha256Sums,
  parseStableTag,
  type GitHubRelease,
  type ReleaseJson,
} from "../../scripts/lib/release-manifest.mts";

const TAG = "v0.1.2";
const VERSION = "0.1.2";
const SHA = "2de49bbd552e46934ef4573ca8c8b103e3a0b1334dd12b2022dee1f332f7fc7f";
const COMMIT = "122a854fffb98d0ef2c9783af7d9d07329d5bb6c";
const BASE = `https://github.com/EricTsai83/recordstuff/releases/download/${TAG}`;

function release(overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    tag_name: TAG,
    draft: false,
    prerelease: false,
    published_at: "2026-09-19T10:23:02Z",
    html_url: `https://github.com/EricTsai83/recordstuff/releases/tag/${TAG}`,
    assets: [
      { name: expectedDmgName(VERSION), size: 127314171, browser_download_url: `${BASE}/${expectedDmgName(VERSION)}`, digest: `sha256:${SHA}` },
      { name: "release.json", size: 532, browser_download_url: `${BASE}/release.json` },
      { name: "SHA256SUMS", size: 105, browser_download_url: `${BASE}/SHA256SUMS` },
    ],
    ...overrides,
  };
}

function releaseJson(overrides: Partial<ReleaseJson> = {}): ReleaseJson {
  return {
    tag: TAG,
    version: VERSION,
    sourceCommit: COMMIT,
    repository: "EricTsai83/recordstuff",
    platform: "darwin-arm64",
    file: expectedDmgName(VERSION),
    size: 127314171,
    sha256: SHA,
    ...overrides,
  };
}

const SUMS = `${SHA}  ${expectedDmgName(VERSION)}\n`;
const NOW = new Date("2026-09-20T00:00:00Z");

function build(input: { release?: Partial<GitHubRelease>; releaseJson?: Partial<ReleaseJson>; sums?: string } = {}) {
  return buildManifest({
    tag: TAG,
    release: release(input.release),
    releaseJson: releaseJson(input.releaseJson),
    sha256sums: input.sums ?? SUMS,
    now: NOW,
  });
}

test("parseStableTag accepts vX.Y.Z and rejects pre-release tags", () => {
  assert.equal(parseStableTag("v0.1.2"), "0.1.2");
  assert.throws(() => parseStableTag("v0.2.0-rc.1"), /pre-releases/);
  assert.throws(() => parseStableTag("0.1.2"), /not a stable/);
});

test("parseSha256Sums reads GNU style lines and rejects garbage", () => {
  const sums = parseSha256Sums(`${SHA}  a.dmg\n${SHA} *b.dmg\n\n`);
  assert.equal(sums.get("a.dmg"), SHA);
  assert.equal(sums.get("b.dmg"), SHA);
  assert.throws(() => parseSha256Sums("not a checksum line"), /Unparseable/);
  assert.throws(() => parseSha256Sums("\n"), /empty/);
});

test("buildManifest produces the verified download facts", () => {
  const manifest = build();
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.dmg.size, 127314171);
  assert.equal(manifest.dmg.sha256, SHA);
  assert.equal(manifest.dmg.url, `${BASE}/${expectedDmgName(VERSION)}`);
  assert.equal(manifest.sha256sumsUrl, `${BASE}/SHA256SUMS`);
  assert.equal(manifest.verifiedAt, NOW.toISOString());
  assert.deepEqual(assertManifestShape(JSON.parse(JSON.stringify(manifest))), manifest);
});

test("buildManifest refuses drafts, pre-releases and wrong tags", () => {
  assert.throws(() => build({ release: { draft: true } }), /draft/);
  assert.throws(() => build({ release: { prerelease: true } }), /pre-release/);
  assert.throws(() => build({ release: { tag_name: "v0.1.3" } }), /returned v0.1.3/);
});

test("buildManifest requires exactly the three workflow assets", () => {
  const extra = release();
  extra.assets.push({ name: "notes.txt", size: 1, browser_download_url: `${BASE}/notes.txt` });
  assert.throws(() => build({ release: { assets: extra.assets } }), /differ from expected/);
  assert.throws(() => build({ release: { assets: release().assets.slice(1) } }), /differ from expected/);
});

test("buildManifest detects disagreement between release.json, SHA256SUMS and GitHub", () => {
  assert.throws(() => build({ releaseJson: { size: 1 } }), /differs from GitHub asset size/);
  assert.throws(() => build({ sums: `${"0".repeat(64)}  ${expectedDmgName(VERSION)}\n` }), /SHA256SUMS hash/);
  assert.throws(() => build({ sums: `${SHA}  other.dmg\n` }), /does not list/);
  const wrongDigest = release();
  wrongDigest.assets[0].digest = `sha256:${"f".repeat(64)}`;
  assert.throws(() => build({ release: { assets: wrongDigest.assets } }), /GitHub asset digest/);
  assert.throws(() => build({ releaseJson: { version: "0.1.3" } }), /release.json version/);
  assert.throws(() => build({ releaseJson: { platform: "darwin-x64" } }), /platform/);
  assert.throws(() => build({ releaseJson: { sourceCommit: "abc" } }), /sourceCommit/);
});

test("buildManifest tolerates a missing GitHub digest", () => {
  const noDigest = release();
  delete noDigest.assets[0].digest;
  assert.equal(build({ release: { assets: noDigest.assets } }).dmg.sha256, SHA);
});

test("assertManifestShape rejects tampered manifests", () => {
  const manifest = JSON.parse(JSON.stringify(build()));
  assert.throws(() => assertManifestShape({ ...manifest, version: "9.9.9" }), /does not match its tag/);
  assert.throws(() => assertManifestShape({ ...manifest, dmg: { ...manifest.dmg, url: "https://example.com/x.dmg" } }), /github.com/);
  assert.throws(() => assertManifestShape({ ...manifest, dmg: { ...manifest.dmg, url: `${BASE}/other.dmg` } }), /does not match the version|tagged asset/);
  assert.throws(() => assertManifestShape({ ...manifest, dmg: { ...manifest.dmg, sha256: "zz" } }), /sha256/);
  assert.throws(() => assertManifestShape({ ...manifest, releaseUrl: "http://github.com/EricTsai83/recordstuff/releases" }), /https/);
  assert.throws(() => assertManifestShape(null), /not an object/);
});

test("diffManifest reports each changed field and nothing when equal", () => {
  const a = build();
  assert.deepEqual(diffManifest(a, build()), []);
  const b = { ...a, dmg: { ...a.dmg, size: 1 }, publishedAt: "2026-09-20T00:00:00Z" };
  const diff = diffManifest(a, b);
  assert.equal(diff.length, 2);
  assert.match(diff.join("\n"), /dmg.size/);
  assert.match(diff.join("\n"), /publishedAt/);
});

test("diffManifest catches a release-notes link pointed at another release", () => {
  const a = build();
  const b = { ...a, notesUrl: "https://github.com/EricTsai83/recordstuff/releases/tag/v0.1.1" };
  const diff = diffManifest(a, b);
  assert.equal(diff.length, 1);
  assert.match(diff[0], /notesUrl/);
});

test("formatBytes renders megabytes for a DMG", () => {
  assert.equal(formatBytes(127314171), "127.3 MB");
  assert.equal(formatBytes(532), "532 bytes");
});
