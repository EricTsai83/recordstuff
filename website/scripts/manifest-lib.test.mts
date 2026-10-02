import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertManifestShape,
  buildManifest,
  carriesWindows,
  diffManifest,
  expectedAssetNames,
  expectedDmgName,
  expectedWindowsInstallerName,
  formatBytes,
  parseSha256Sums,
  parseStableTag,
  type GitHubRelease,
  type ReleaseJson,
  type WindowsReleaseJson,
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

// The first two-platform version: every version after 1.1.1 carries Windows.
const W_TAG = "v1.2.0";
const W_VERSION = "1.2.0";
const W_BASE = `https://github.com/EricTsai83/recordstuff/releases/download/${W_TAG}`;
const EXE_SHA = "e".repeat(64);
const EXE = expectedWindowsInstallerName(W_VERSION);

function windowsInput(overrides: { record?: Partial<WindowsReleaseJson>; assets?: (assets: GitHubRelease["assets"]) => GitHubRelease["assets"]; sums?: string } = {}) {
  const dmg = expectedDmgName(W_VERSION);
  const assets: GitHubRelease["assets"] = [
    { name: dmg, size: 127314171, browser_download_url: `${W_BASE}/${dmg}`, digest: `sha256:${SHA}` },
    { name: "release.json", size: 532, browser_download_url: `${W_BASE}/release.json` },
    { name: "SHA256SUMS", size: 200, browser_download_url: `${W_BASE}/SHA256SUMS` },
    { name: EXE, size: 98765432, browser_download_url: `${W_BASE}/${EXE}`, digest: `sha256:${EXE_SHA}` },
    { name: "release-win32-x64.json", size: 400, browser_download_url: `${W_BASE}/release-win32-x64.json` },
  ];
  return {
    tag: W_TAG,
    release: release({ tag_name: W_TAG, html_url: `https://github.com/EricTsai83/recordstuff/releases/tag/${W_TAG}`, assets: overrides.assets ? overrides.assets(assets) : assets }),
    releaseJson: releaseJson({ tag: W_TAG, version: W_VERSION, file: dmg }),
    windowsJson: {
      tag: W_TAG, version: W_VERSION, sourceCommit: COMMIT, repository: "EricTsai83/recordstuff", platform: "win32-x64",
      file: EXE, size: 98765432, sha256: EXE_SHA, appAsarSHA256: "f".repeat(64), signature: "unsigned", ...overrides.record,
    },
    sha256sums: overrides.sums ?? `${SHA}  ${dmg}\n${EXE_SHA}  ${EXE}\n`,
    now: NOW,
  };
}

test("versions after the last macOS-only one carry the Windows installer and its record", () => {
  assert.equal(carriesWindows("1.1.1"), false);
  assert.equal(carriesWindows("0.9.9"), false);
  assert.equal(carriesWindows("1.1.2"), true);
  assert.equal(carriesWindows("1.2.0-rc.1"), true);
  assert.deepEqual(expectedAssetNames("1.1.1"), [expectedDmgName("1.1.1"), "release.json", "SHA256SUMS"]);
  assert.deepEqual(expectedAssetNames(W_VERSION).slice(3), [EXE, "release-win32-x64.json"]);
});

test("buildManifest adds the verified Windows facts for a two-platform release", () => {
  const manifest = buildManifest(windowsInput());
  assert.deepEqual(manifest.windows, { platform: "win32-x64", name: EXE, size: 98765432, sha256: EXE_SHA, url: `${W_BASE}/${EXE}`, recordUrl: `${W_BASE}/release-win32-x64.json` });
  assert.deepEqual(assertManifestShape(JSON.parse(JSON.stringify(manifest))), manifest);
  // The macOS facts, which the website feed serves to installed apps, are unchanged.
  assert.equal(manifest.platform, "darwin-arm64");
  assert.equal(manifest.dmg.name, expectedDmgName(W_VERSION));
});

test("buildManifest refuses a two-platform release with a missing, mismatched or unlisted Windows asset", () => {
  assert.throws(() => buildManifest({ ...windowsInput(), windowsJson: undefined }), /release-win32-x64.json was not supplied/);
  assert.throws(() => buildManifest(windowsInput({ assets: (a) => a.filter((x) => x.name !== EXE) })), /assets/);
  assert.throws(() => buildManifest(windowsInput({ record: { sha256: "d".repeat(64) } })), /SHA256SUMS hash/);
  assert.throws(() => buildManifest(windowsInput({ record: { size: 1 } })), /size 1 differs/);
  assert.throws(() => buildManifest(windowsInput({ record: { signature: "signed" } })), /signature/);
  assert.throws(() => buildManifest(windowsInput({ record: { sourceCommit: "c".repeat(40) } })), /sourceCommit/);
  assert.throws(() => buildManifest(windowsInput({ assets: (a) => a.map((x) => x.name === EXE ? { ...x, digest: `sha256:${"d".repeat(64)}` } : x) })), /GitHub asset digest/);
  assert.throws(() => buildManifest(windowsInput({ sums: `${SHA}  ${expectedDmgName(W_VERSION)}\n` })), /SHA256SUMS hash missing/);
  assert.throws(() => buildManifest(windowsInput({ sums: `${SHA}  ${expectedDmgName(W_VERSION)}\n${EXE_SHA}  ${EXE}\n${SHA}  extra.zip\n` })), /lists 3 files/);
});

test("assertManifestShape requires the Windows block exactly for two-platform versions", () => {
  const two = buildManifest(windowsInput());
  const { windows, ...withoutWindows } = two;
  assert.throws(() => assertManifestShape(withoutWindows), /windows block is missing/);
  assert.throws(() => assertManifestShape({ ...build(), windows }), /macOS only/);
  assert.throws(() => assertManifestShape({ ...two, windows: { ...windows!, url: `${BASE}/${EXE}` } }), /windows.url does not point/);
  assert.throws(() => assertManifestShape({ ...two, windows: { ...windows!, sha256: "x" } }), /windows.sha256/);
});

test("diffManifest reports a changed Windows installer", () => {
  const two = buildManifest(windowsInput());
  assert.deepEqual(diffManifest(two, two), []);
  const changed = { ...two, windows: { ...two.windows!, sha256: "d".repeat(64) } };
  assert.match(diffManifest(two, changed).join("\n"), /windows.sha256/);
});
