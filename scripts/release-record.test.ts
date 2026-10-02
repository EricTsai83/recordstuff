/** Exercise the real record CLI in disposable checkouts; all external data is local. */
import { buildFixture } from './lib/build-fixture.mts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { releaseFactsFromManifest, renderDownloadSection } from './release.mts';
import { carriesWindows } from './lib/release-manifest.mts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const repository = 'EricTsai83/recordstuff';
const commit = 'b'.repeat(40);
const runUrl = `https://github.com/${repository}/actions/runs/123`;
const readmes = [['README.md', 'en'], ['README.zh-TW.md', 'zh-TW']] as const;
const stableFiles = ['package.json', 'README.md', 'README.zh-TW.md', 'website/release-manifest.json'];
let root: string;

interface ReleaseOptions { sourceCommit?: string; tagCommit?: string; sha256?: string; size?: number }
/** The manifest the fixture's published release verifies to, as a committed record would hold it. */
function stableManifest(version: string, { sourceCommit = commit, sha256 = 'a'.repeat(64), size = 12345 }: ReleaseOptions = {}) {
  const tag = `v${version}`;
  const name = `RecordStuff-${version}-arm64-selfsigned.dmg`;
  const releases = `https://github.com/${repository}/releases`;
  return {
    version, tag, sourceCommit, publishedAt: '2026-09-21T00:00:00Z', platform: 'darwin-arm64', architecture: 'arm64',
    dmg: { name, size, sha256, url: `${releases}/download/${tag}/${name}` },
    sha256sumsUrl: `${releases}/download/${tag}/SHA256SUMS`, releaseJsonUrl: `${releases}/download/${tag}/release.json`,
    releaseUrl: `${releases}/tag/${tag}`, notesUrl: `${releases}/tag/${tag}`, verifiedAt: '2026-09-21T00:01:00.000Z',
  };
}
/** Commits a consistent stable pointer: the manifest and both README blocks rendered from it. */
function commitStable(version: string) {
  const manifest = stableManifest(version);
  writeFileSync(path.join(root, 'website/release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const facts = releaseFactsFromManifest(manifest, runUrl);
  for (const [file, lang] of readmes) {
    writeFileSync(path.join(root, file), `Intro\n<!-- release-download:start -->\n${renderDownloadSection(lang, facts)}\n<!-- release-download:end -->\nOutro\n`);
  }
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'recordstuff-record-test-'));
  for (const file of ['scripts/release.mts', 'scripts/lib/release-manifest.mts', 'scripts/lib/release-manifest-client.mts', 'scripts/lib/fetch-retry.mts', 'src/shared/version.ts']) {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repositoryRoot, file), destination);
  }
  for (const dir of ['website', 'docs/verification/releases', 'docs/zh-TW/verification/releases']) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{\n  "version": "0.1.3"\n}\n');
  commitStable('0.1.3');
  await buildFixture('release-record-network', root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Runs `record` against a published release; `tagCommit` is what the tag points to, `sourceCommit` what release.json claims. */
function record(version = '0.1.4', { tagCommit = commit, sourceCommit = tagCommit, sha256 = 'a'.repeat(64), size = 12345 }: ReleaseOptions = {}) {
  const tag = `v${version}`;
  const file = `RecordStuff-${version}-arm64-selfsigned.dmg`;
  const base = `https://github.com/${repository}/releases/download/${tag}/`;
  const metadata = { version, tag, sourceCommit, repository, platform: 'darwin-arm64', file, size, sha256 };
  // Every version after 1.1.1 carries the Windows installer and its record.
  const exe = `RecordStuff-${version}-x64-unsigned-setup.exe`;
  const windows = carriesWindows(version)
    ? { version, tag, sourceCommit, repository, platform: 'win32-x64', file: exe, size: 98765, sha256: 'e'.repeat(64), appAsarSHA256: 'f'.repeat(64), signature: 'unsigned' }
    : undefined;
  const release = {
    tag_name: tag, draft: false, prerelease: version.includes('-'), published_at: '2026-09-21T00:00:00Z',
    html_url: `https://github.com/${repository}/releases/tag/${tag}`,
    assets: [
      ...[file, 'release.json', 'SHA256SUMS'].map(name => ({ name, size: name === file ? size : 100, digest: `sha256:${sha256}`, browser_download_url: base + name })),
      ...(windows ? [{ name: exe, size: windows.size, digest: `sha256:${windows.sha256}`, browser_download_url: base + exe },
        { name: 'release-win32-x64.json', size: 100, digest: `sha256:${sha256}`, browser_download_url: `${base}release-win32-x64.json` }] : []),
    ],
  };
  const fixture = path.join(root, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ commit: tagCommit, metadata, release, windows }));
  return spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'release-record-network.mjs')).href, 'scripts/release.mts', 'record', tag], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, GITHUB_REPOSITORY: repository, RELEASE_FIXTURE: fixture, RELEASE_RUN_URL: runUrl },
  });
}
function text(file: string) { return readFileSync(path.join(root, file), 'utf8'); }
function snapshot() {
  return Object.fromEntries(stableFiles.map(file => [file, existsSync(path.join(root, file)) ? text(file) : null]));
}
function records() {
  return ['docs/verification/releases', 'docs/zh-TW/verification/releases'].map(dir => readdirSync(path.join(root, dir)).sort());
}
/** Asserts the stable pointer (manifest and both README blocks) is `version` and package.json is `packageVersion`. */
function expectStable(version: string, packageVersion: string) {
  const manifest = JSON.parse(text('website/release-manifest.json'));
  expect(manifest).toEqual({ ...stableManifest(version), verifiedAt: expect.any(String) });
  const facts = releaseFactsFromManifest(manifest, runUrl);
  for (const [file, lang] of readmes) expect(text(file), file).toContain(`<!-- release-download:start -->\n${renderDownloadSection(lang, facts)}\n<!-- release-download:end -->\nOutro\n`);
  expect(JSON.parse(text('package.json')).version).toBe(packageVersion);
}

describe('record CLI', () => {
  it('promotes a newer stable version from one snapshot and keeps a retry idempotent', () => {
    const result = record();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('promoted: stable download pointers moved from v0.1.3 to v0.1.4');
    expectStable('0.1.4', '0.1.4');
    expect(records()).toEqual([['0.1.4.md'], ['0.1.4.md']]);
    for (const dir of ['docs/verification/releases', 'docs/zh-TW/verification/releases']) {
      const file = `${dir}/0.1.4.md`;
      expect(text(file)).toContain('a'.repeat(64));
      writeFileSync(path.join(root, file), `${text(file)}\nManual acceptance evidence.\n`);
    }
    const promoted = snapshot();
    const retry = record();
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).toContain('unchanged: v0.1.4 is already the stable release with the same facts');
    expect(retry.stdout).toContain('No file changed.');
    expect(snapshot()).toEqual(promoted);
    expect(text('docs/verification/releases/0.1.4.md')).toContain('Manual acceptance evidence.');
    expect(text('docs/zh-TW/verification/releases/0.1.4.md')).toContain('Manual acceptance evidence.');
  });

  it('records an older stable version as history without moving newer pointers back', () => {
    expect(record('0.1.4').status).toBe(0);
    const promoted = snapshot();
    const result = record('0.1.3');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('historical only: stable download pointers stay at the newer v0.1.4');
    expect(snapshot()).toEqual(promoted);
    expect(records()).toEqual([['0.1.3.md', '0.1.4.md'], ['0.1.3.md', '0.1.4.md']]);
    expect(text('docs/verification/releases/0.1.3.md')).toContain('`v0.1.3`');
    writeFileSync(path.join(root, 'docs/verification/releases/0.1.3.md'), 'Manual evidence.\n');
    const again = record('0.1.3');
    expect(again.stdout).toContain('No file changed.');
    expect(text('docs/verification/releases/0.1.3.md')).toBe('Manual evidence.\n');
  });

  it('promotes the first two-platform version with its Windows installer in every output', () => {
    const result = record('1.2.0');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('promoted: stable download pointers moved from v0.1.3 to v1.2.0');
    const manifest = JSON.parse(text('website/release-manifest.json'));
    expect(manifest.windows).toMatchObject({ platform: 'win32-x64', name: 'RecordStuff-1.2.0-x64-unsigned-setup.exe', size: 98765, sha256: 'e'.repeat(64) });
    for (const file of ['README.md', 'README.zh-TW.md', 'docs/verification/releases/1.2.0.md', 'docs/zh-TW/verification/releases/1.2.0.md']) {
      expect(text(file), file).toContain('RecordStuff-1.2.0-x64-unsigned-setup.exe');
    }
    const retry = record('1.2.0');
    expect(retry.stdout).toContain('No file changed.');
  });

  it('records a two-platform pre-release with both installers and no stable pointer', () => {
    const before = snapshot();
    const result = record('1.2.0-rc.1');
    expect(result.status, result.stderr).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(text('docs/verification/releases/1.2.0-rc.1.md')).toContain('RecordStuff-1.2.0-rc.1-x64-unsigned-setup.exe');
  });

  it('records the committed stable version again without rewriting its pointer', () => {
    const before = snapshot();
    const result = record('0.1.3');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('unchanged: v0.1.3');
    expect(snapshot()).toEqual(before);
    expect(records()).toEqual([['0.1.3.md'], ['0.1.3.md']]);
  });

  it.each([
    ['source commit', { tagCommit: 'c'.repeat(40) }, 'sourceCommit'],
    ['DMG digest', { sha256: 'd'.repeat(64) }, 'dmg.sha256'],
    ['DMG size', { size: 54321 }, 'dmg.size'],
  ] as const)('rejects an equal version with a different %s before writing any output', (_, options, field) => {
    const before = snapshot();
    const result = record('0.1.3', options);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('v0.1.3 is already the recorded stable release with different facts');
    expect(result.stderr).toContain(`${field}: stored`);
    expect(snapshot()).toEqual(before);
    expect(records()).toEqual([[], []]);
  });

  it('records prereleases without modifying stable pointers', () => {
    const before = snapshot();
    const result = record('0.2.0-rc.1');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('historical only: pre-releases never move the stable download pointers');
    expect(snapshot()).toEqual(before);
    expect(records()).toEqual([['0.2.0-rc.1.md'], ['0.2.0-rc.1.md']]);
  });

  it.each([
    ['ahead of the manifest, promotion leaves it', '0.2.0', '0.1.4', '0.1.4', '0.2.0'],
    ['behind the manifest, promotion advances it', '0.1.2', '0.1.4', '0.1.4', '0.1.4'],
    ['behind the manifest, an older record advances only it', '0.1.1', '0.1.2', '0.1.3', '0.1.2'],
  ])('with package.json %s', (_, packageVersion, recorded, pointer, packageAfter) => {
    writeFileSync(path.join(root, 'package.json'), `{\n  "version": "${packageVersion}"\n}\n`);
    const result = record(recorded);
    expect(result.status, result.stderr).toBe(0);
    expectStable(pointer, packageAfter);
    if (pointer === '0.1.3') expect(text('website/release-manifest.json')).toBe(`${JSON.stringify(stableManifest('0.1.3'), null, 2)}\n`);
  });

  it.each([
    ['missing', () => rmSync(path.join(root, 'website/release-manifest.json')), 'Cannot read the committed stable manifest'],
    ['non-JSON', () => writeFileSync(path.join(root, 'website/release-manifest.json'), '{'), 'The committed stable manifest website/release-manifest.json is invalid'],
    ['malformed', () => writeFileSync(path.join(root, 'website/release-manifest.json'), JSON.stringify({ ...stableManifest('0.1.3'), dmg: { ...stableManifest('0.1.3').dmg, sha256: 'invalid' } })), 'is invalid: Manifest dmg.sha256 is malformed.'],
    ['pre-release', () => writeFileSync(path.join(root, 'website/release-manifest.json'), JSON.stringify({ ...stableManifest('0.1.3'), tag: 'v0.1.3-rc.1' })), 'is invalid: Tag v0.1.3-rc.1 is not a stable'],
  ])('refuses a %s stable baseline before writing any output', (_, corrupt, message) => {
    corrupt();
    const before = snapshot();
    const result = record();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain('pnpm site:manifest generate vX.Y.Z');
    expect(snapshot()).toEqual(before);
    expect(records()).toEqual([[], []]);
  });

  it.each(['0.1.5', '0.2.0-rc.2'])('keeps README checks independent of candidate package version %s', (version) => {
    for (const file of ['scripts/release.test.ts', 'README.md', 'README.zh-TW.md', 'website/release-manifest.json']) {
      cpSync(path.join(repositoryRoot, file), path.join(root, file));
    }
    // A junction needs no symlink privilege on Windows.
    symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
    const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run', 'scripts/release.test.ts'], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 90_000);

  it('rejects a mismatched source commit before writing any output', () => {
    const before = snapshot();
    const result = record('0.1.4', { sourceCommit: 'c'.repeat(40) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('source commit does not match');
    expect(snapshot()).toEqual(before);
    expect(records()).toEqual([[], []]);
  });

  it.each(['README.md', 'README.zh-TW.md'])('validates %s markers before writing any output', (file) => {
    writeFileSync(path.join(root, file), 'Missing release markers.');
    const before = snapshot();
    const result = record();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Markers');
    expect(snapshot()).toEqual(before);
    expect(records()).toEqual([[], []]);
  });
});
