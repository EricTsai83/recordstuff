import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertDmgContents, assertPublishedAssets, assertUnreleased, compareVersions, isPrerelease, notes, renderDownloadSection, renderVerificationRecord, replaceMarked, setPackageVersion, validateDigest, validateTag, type ReleaseFacts } from './release.mts';

describe('release gates', () => {
  it('accepts only a tag equal to v + package version, stable or pre-release', () => {
    expect(() => validateTag('v0.1.2', '0.1.2')).not.toThrow();
    expect(() => validateTag('v0.2.0-rc.1', '0.2.0-rc.1')).not.toThrow();
    for (const tag of ['v0.1.0', '0.1.2', 'v0.1.2-beta', 'v0.1.2\n', 'v0.1.2;echo x']) {
      expect(() => validateTag(tag, '0.1.2')).toThrow();
    }
    for (const version of ['0.1', '0.1.2-', '0.1.2-rc 1', 'v0.1.2', '0.1.2+build']) {
      expect(() => validateTag(`v${version}`, version)).toThrow();
    }
    expect(isPrerelease('0.1.2')).toBe(false);
    expect(isPrerelease('0.2.0-rc.1')).toBe(true);
  });
  it('rejects reuse of drafts as well as published versions', () => {
    expect(() => assertUnreleased([{ tag_name: 'v0.1.0' }], 'v0.1.1')).not.toThrow();
    expect(() => assertUnreleased([{ tag_name: 'v0.1.1' }], 'v0.1.1')).toThrow();
  });
  it('accepts a public release only when every asset matches the verified files by name, size and digest', () => {
    const sha = 'a'.repeat(64);
    const files = [{ name: 'RecordStuff-0.1.2-arm64-selfsigned.dmg', size: 10, sha256: sha }, { name: 'SHA256SUMS', size: 1, sha256: sha }, { name: 'release.json', size: 2, sha256: sha }];
    const ok = { draft: false, assets: files.map(f => ({ name: f.name, size: f.size, digest: `sha256:${sha}` })) };
    expect(() => assertPublishedAssets(ok, files)).not.toThrow();
    expect(() => assertPublishedAssets({ ...ok, draft: true }, files)).toThrow(/draft/);
    expect(() => assertPublishedAssets({ ...ok, assets: ok.assets.slice(1) }, files)).toThrow(/Expected 3 assets/);
    expect(() => assertPublishedAssets({ ...ok, assets: ok.assets.map(a => a.name === 'SHA256SUMS' ? { ...a, size: 99 } : a) }, files)).toThrow(/99 bytes/);
    expect(() => assertPublishedAssets({ ...ok, assets: ok.assets.map(a => a.name.endsWith('.dmg') ? { ...a, digest: `sha256:${'b'.repeat(64)}` } : a) }, files)).toThrow(/digest/);
    expect(() => assertPublishedAssets({ ...ok, assets: ok.assets.map(a => ({ ...a, digest: null })) }, files)).toThrow(/missing/);
    expect(() => assertPublishedAssets({ ...ok, assets: [...ok.assets.slice(0, 2), { name: 'extra.txt', size: 2, digest: `sha256:${sha}` }] }, files)).toThrow(/Missing published asset release.json/);
  });
  it('rejects incorrect and malformed checksums', () => {
    expect(() => validateDigest('a'.repeat(64), 'a'.repeat(64))).not.toThrow();
    expect(() => validateDigest('a'.repeat(64), 'b'.repeat(64))).toThrow();
    expect(() => validateDigest('', '')).toThrow();
  });
  it('preserves English self-signing, update and removal instructions with commit-pinned bilingual guide links', () => {
    const body = notes('0.1.2', 'owner/repo', 'a'.repeat(40));
    expect(body).toContain('Open Anyway');
    expect(body).toContain('not notarized');
    expect(body).toContain('Screen & System Audio Recording');
    expect(body).toContain('Update manually');
    expect(body).toContain('Check for updates…');
    expect(body).toContain('Downloads and installation remain manual');
    expect(body).toContain('Remove');
    expect(body).toContain('Trash');
    expect(body).toContain(`/blob/${'a'.repeat(40)}/resources/INSTALL.md`);
    expect(body).toContain(`/blob/${'a'.repeat(40)}/resources/INSTALL.zh-TW.md`);
    expect(body).toContain('Finder');
  });
});

describe('record helpers', () => {
  const facts: ReleaseFacts = {
    version: '0.1.2', tag: 'v0.1.2', repository: 'EricTsai83/recordstuff', sourceCommit: '122a854fffb98d0ef2c9783af7d9d07329d5bb6c',
    file: 'RecordStuff-0.1.2-arm64-selfsigned.dmg', size: 127314171, sha256: '2de49bbd552e46934ef4573ca8c8b103e3a0b1334dd12b2022dee1f332f7fc7f',
    runUrl: 'https://github.com/EricTsai83/recordstuff/actions/runs/35437124200', publishedAt: '2026-09-19T10:23:02Z', date: '2026-09-19',
  };
  it('orders versions numerically with pre-releases below their release', () => {
    expect(compareVersions('0.1.2', '0.1.2')).toBe(0);
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('0.2.0-rc.1', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0', '0.2.0-rc.1')).toBe(1);
    expect(compareVersions('0.2.0-rc.1', '0.2.0-rc.2')).toBe(-1);
    expect(compareVersions('0.2.0-rc.1', '0.1.9')).toBe(1);
  });
  it('rewrites only the top-level package version and keeps formatting', () => {
    const text = '{\n  "name": "recordstuff",\n  "version": "0.1.2",\n  "engines": { "node": ">=22.12.0" }\n}\n';
    expect(setPackageVersion(text, '0.1.3')).toBe(text.replace('"0.1.2"', '"0.1.3"'));
    expect(setPackageVersion(text, '0.1.2')).toBe(text);
    expect(() => setPackageVersion('{ "name": "x" }', '1.0.0')).toThrow(/no top-level version/);
  });
  it('replaces marked blocks and rejects missing markers', () => {
    const doc = 'before\n<!-- x:start -->\nold\n<!-- x:end -->\nafter\n';
    expect(replaceMarked(doc, 'x', 'new')).toBe('before\n<!-- x:start -->\nnew\n<!-- x:end -->\nafter\n');
    expect(() => replaceMarked('no markers', 'x', 'new')).toThrow(/Markers/);
  });
  it('renders the README download blocks exactly as the committed READMEs carry them', () => {
    for (const [file, lang] of [['README.md', 'en'], ['README.zh-TW.md', 'zh-TW']] as const) {
      const readme = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(readme).toContain(`<!-- release-download:start -->\n${renderDownloadSection(lang, facts)}\n<!-- release-download:end -->`);
    }
  });
  it('renders bilingual verification skeletons with the facts and explicit fill-in sections', () => {
    const en = renderVerificationRecord('en', facts);
    const zh = renderVerificationRecord('zh-TW', facts);
    for (const text of [en, zh]) {
      expect(text).toContain(facts.sha256);
      expect(text).toContain('127,314,171 bytes');
      expect(text).toContain(facts.runUrl);
      expect(text).toContain(facts.sourceCommit);
    }
    expect(en).toContain('## Local acceptance before tagging — fill in');
    expect(en).toContain('## Not recorded');
    expect(en).toContain('[繁體中文](../../zh-TW/verification/releases/0.1.2.md)');
    expect(zh).toContain('## 打 tag 前的本機驗收 — 待填');
    expect(zh).toContain('[English](../../../verification/releases/0.1.2.md)');
  });
});

describe('mounted DMG contents gate', () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  /** Builds a fake mount root: strings become empty files, `name/` a directory, `name->target` a symlink. */
  function mountRoot(...entries: string[]) {
    const root = mkdtempSync(path.join(tmpdir(), 'recordstuff-dmg-gate-'));
    roots.push(root);
    for (const e of entries) {
      if (e.endsWith('/')) mkdirSync(path.join(root, e.slice(0, -1)));
      else if (e.includes('->')) { const [name, target] = e.split('->') as [string, string]; symlinkSync(target, path.join(root, name)); }
      else writeFileSync(path.join(root, e), '');
    }
    return root;
  }
  const layout = ['.DS_Store', '.VolumeIcon.icns', '.background.tiff', 'Applications->/Applications', 'RecordStuff.app/'];
  it('accepts only the App and Applications link as visible contents', () => {
    expect(() => assertDmgContents(mountRoot('RecordStuff.app/', 'Applications->/Applications'))).not.toThrow();
    expect(() => assertDmgContents(mountRoot(...layout))).not.toThrow();
    expect(() => assertDmgContents(mountRoot(...layout, 'INSTALL.md', 'INSTALL.zh-TW.md'))).toThrow(/INSTALL\.md/);
    expect(() => assertDmgContents(mountRoot('Applications->/Applications'))).toThrow();
    expect(() => assertDmgContents(mountRoot(...layout, 'README.txt'))).toThrow();
    expect(() => assertDmgContents(mountRoot())).toThrow();
  });
  it('permits only regular Finder layout files as hidden entries', () => {
    expect(() => assertDmgContents(mountRoot(...layout, '.INSTALL.md'))).toThrow(/hidden.*\.INSTALL\.md/);
    expect(() => assertDmgContents(mountRoot(...layout, '.help/'))).toThrow(/hidden.*\.help/);
    expect(() => assertDmgContents(mountRoot(...layout, '.INSTALL.zh-TW.md', '.notes.html'))).toThrow(/\.INSTALL\.zh-TW\.md, \.notes\.html/);
  });
  it('rejects hidden directories or links even under permitted names', () => {
    expect(() => assertDmgContents(mountRoot('.DS_Store', '.VolumeIcon.icns', '.background/', 'Applications->/Applications', 'RecordStuff.app/'))).toThrow(/hidden.*\.background/);
    const root = mountRoot('.DS_Store', '.VolumeIcon.icns', '.background.tiff/', 'Applications->/Applications', 'RecordStuff.app/');
    writeFileSync(path.join(root, '.background.tiff', 'INSTALL.md'), '');
    expect(() => assertDmgContents(root)).toThrow(/hidden.*\.background\.tiff/);
    expect(() => assertDmgContents(mountRoot(...layout.filter(e => e !== '.DS_Store'), '.DS_Store->RecordStuff.app'))).toThrow(/hidden.*\.DS_Store/);
  });
});
