/** Exercise the real record CLI in disposable checkouts; all external data is local. */
import { buildFixture } from './lib/build-fixture.mts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { releaseFactsFromManifest, renderDownloadSection } from './release.mts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const repository = 'EricTsai83/recordstuff';
const commit = 'b'.repeat(40);
let root: string;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'recordstuff-record-test-'));
  for (const file of ['scripts/release.mts', 'scripts/lib/release-manifest.mts', 'scripts/lib/release-manifest-client.mts', 'website/release-manifest.json']) {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repositoryRoot, file), destination);
  }
  for (const dir of ['bin', 'docs/verification/releases', 'docs/zh-TW/verification/releases']) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{\n  "version": "0.1.3"\n}\n');
  for (const file of ['README.md', 'README.zh-TW.md']) writeFileSync(path.join(root, file), 'Intro\n<!-- release-download:start -->\nold\n<!-- release-download:end -->\n');
  writeFileSync(path.join(root, 'bin/gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync(process.env.RELEASE_FIXTURE));
const endpoint = process.argv[3];
if (endpoint.includes('/commits/')) console.log(JSON.stringify({ sha: fixture.commit }));
else if (endpoint.includes('/releases/tags/')) console.log(JSON.stringify(fixture.release));
else throw new Error('Unexpected gh request: ' + endpoint);
`, { mode: 0o755 });
  await buildFixture('release-record-network', root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function record(version = '0.1.4', sourceCommit = commit) {
  const tag = `v${version}`;
  const file = `RecordStuff-${version}-arm64-selfsigned.dmg`;
  const base = `https://github.com/${repository}/releases/download/${tag}/`;
  const sha256 = 'a'.repeat(64);
  const metadata = { version, tag, sourceCommit, repository, platform: 'darwin-arm64', file, size: 12345, sha256 };
  const release = {
    tag_name: tag, draft: false, prerelease: version.includes('-'), published_at: '2026-09-21T00:00:00Z',
    html_url: `https://github.com/${repository}/releases/tag/${tag}`,
    assets: [file, 'release.json', 'SHA256SUMS'].map(name => ({ name, size: 12345, digest: `sha256:${sha256}`, browser_download_url: base + name })),
  };
  const fixture = path.join(root, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ commit, metadata, release }));
  return spawnSync(process.execPath, ['--import', path.join(root, 'release-record-network.mjs'), 'scripts/release.mts', 'record', tag], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: repository, RELEASE_FIXTURE: fixture, RELEASE_RUN_URL: `https://github.com/${repository}/actions/runs/123` },
  });
}
function text(file: string) { return readFileSync(path.join(root, file), 'utf8'); }
function snapshot() {
  return Object.fromEntries(['package.json', 'README.md', 'README.zh-TW.md', 'website/release-manifest.json'].map(file => [file, text(file)]));
}
function expectNoRecords() {
  expect(readdirSync(path.join(root, 'docs/verification/releases'))).toEqual([]);
  expect(readdirSync(path.join(root, 'docs/zh-TW/verification/releases'))).toEqual([]);
}

describe('record CLI', () => {
  it('generates all stable outputs from one snapshot and preserves existing manual evidence on rerun', () => {
    const result = record();
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(text('website/release-manifest.json'));
    const facts = releaseFactsFromManifest(manifest, `https://github.com/${repository}/actions/runs/123`);
    expect(facts).toMatchObject({ version: '0.1.4', sourceCommit: commit, size: 12345, sha256: 'a'.repeat(64) });
    expect(JSON.parse(text('package.json')).version).toBe('0.1.4');
    for (const [file, language] of [['README.md', 'en'], ['README.zh-TW.md', 'zh-TW']] as const) {
      expect(text(file)).toContain(renderDownloadSection(language, facts));
    }
    for (const dir of ['docs/verification/releases', 'docs/zh-TW/verification/releases']) {
      const file = `${dir}/0.1.4.md`;
      expect(text(file)).toContain(facts.sha256);
      writeFileSync(path.join(root, file), `${text(file)}\nManual acceptance evidence.\n`);
    }
    expect(record().status).toBe(0);
    expect(text('docs/verification/releases/0.1.4.md')).toContain('Manual acceptance evidence.');
    expect(text('docs/zh-TW/verification/releases/0.1.4.md')).toContain('Manual acceptance evidence.');
  });

  it('records prereleases without modifying stable pointers', () => {
    const before = snapshot();
    const result = record('0.2.0-rc.1');
    expect(result.status, result.stderr).toBe(0);
    expect(snapshot()).toEqual(before);
    for (const dir of ['docs/verification/releases', 'docs/zh-TW/verification/releases']) {
      expect(existsSync(path.join(root, dir, '0.2.0-rc.1.md'))).toBe(true);
    }
  });

  it.each(['0.1.5', '0.2.0-rc.2'])('keeps README checks independent of candidate package version %s', (version) => {
    for (const file of ['scripts/release.test.ts', 'README.md', 'README.zh-TW.md']) {
      cpSync(path.join(repositoryRoot, file), path.join(root, file));
    }
    symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
    const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run', 'scripts/release.test.ts'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('rejects a mismatched source commit before writing any output', () => {
    const before = snapshot();
    const result = record('0.1.4', 'c'.repeat(40));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('source commit does not match');
    expect(snapshot()).toEqual(before);
    expectNoRecords();
  });

  it.each(['README.md', 'README.zh-TW.md'])('validates %s markers before writing any output', (file) => {
    writeFileSync(path.join(root, file), 'Missing release markers.');
    const before = snapshot();
    const result = record();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Markers');
    expect(snapshot()).toEqual(before);
    expectNoRecords();
  });
});
