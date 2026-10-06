import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertManifestShape, carriesWindows, expectedWindowsInstallerName } from "../../scripts/lib/release/release-manifest.mts";
import { release, windowsRelease } from "../src/lib/release.ts";

const committed = assertManifestShape(JSON.parse(await readFile(new URL("../release-manifest.json", import.meta.url), "utf8")));

/** The committed manifest moved to a version that carries Windows, with the block the release tooling adds. */
function withWindows(version: string) {
  const tag = `v${version}`;
  const base = `https://github.com/EricTsai83/recordstuff/releases/download/${tag}`;
  const name = expectedWindowsInstallerName(version);
  const dmg = committed.dmg.name.replace(committed.version, version);
  return assertManifestShape({
    ...committed, version, tag,
    releaseUrl: `https://github.com/EricTsai83/recordstuff/releases/tag/${tag}`, notesUrl: `https://github.com/EricTsai83/recordstuff/releases/tag/${tag}`,
    sha256sumsUrl: `${base}/SHA256SUMS`, releaseJsonUrl: `${base}/release.json`,
    dmg: { ...committed.dmg, name: dmg, url: `${base}/${dmg}` },
    windows: { platform: "win32-x64", name, size: 98_765_432, sha256: "ab".repeat(32), url: `${base}/${name}`, recordUrl: `${base}/release-win32-x64.json` },
  });
}

test("the page view carries Windows facts exactly when the committed release does", () => {
  assert.equal(release.windows === undefined, !carriesWindows(committed.version));
});

test("a macOS-only release exposes no Windows facts", () => {
  const { windows: _, ...macOnly } = committed;
  assert.equal(windowsRelease(macOnly), undefined);
});

test("a release after the last macOS-only version exposes the installer facts", () => {
  const manifest = withWindows("1.2.0");
  assert.deepEqual(windowsRelease(manifest), {
    architectureLabel: "x64",
    name: "RecordStuff-1.2.0-x64-unsigned-setup.exe",
    size: 98_765_432,
    sizeLabel: "98.8 MB",
    sha256: "ab".repeat(32),
    url: "https://github.com/EricTsai83/recordstuff/releases/download/v1.2.0/RecordStuff-1.2.0-x64-unsigned-setup.exe",
    recordUrl: "https://github.com/EricTsai83/recordstuff/releases/download/v1.2.0/release-win32-x64.json",
  });
});
