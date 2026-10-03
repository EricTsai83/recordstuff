import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertDmgContents, assertPublishedAssets, assertUnreleased, compareVersions, failureReason, isPrerelease, latestFlag, notes, PE_MACHINE_X64, peMachine, releaseMount, windowsVersionMatches, renderDownloadSection, releaseFactsFromManifest, renderVerificationRecord, replaceMarked, setPackageVersion, sha256sums, splitCommandLine, validateTag, type ReleaseFacts } from './release.mts';

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
  it('preserves English self-signing, update and removal instructions with commit-pinned bilingual guide links', () => {
    const body = notes('0.1.2', 'owner/repo', 'a'.repeat(40));
    expect(body).toContain('Open Anyway');
    expect(body).toContain('not notarized');
    expect(body).toContain('Screen & System Audio Recording');
    expect(body).toContain('Update manually');
    expect(body).toContain('Check for updates… in Settings → General');
    expect(body).toContain('Downloads and installation remain manual');
    expect(body).toContain('Remove');
    expect(body).toContain('Trash');
    expect(body).toContain(`/blob/${'a'.repeat(40)}/resources/INSTALL.md`);
    expect(body).toContain(`/blob/${'a'.repeat(40)}/resources/INSTALL.zh-TW.md`);
    expect(body).toContain('https://record.ericts.com/help');
    expect(body).not.toContain('Known limitation: clicking a recording notification');
    expect(body).not.toContain('Windows');
  });
  it('adds honest Windows install, SmartScreen, update, removal and verification notes from the first two-platform version', () => {
    const body = notes('1.2.0', 'owner/repo', 'a'.repeat(40));
    expect(body).toContain('for Apple silicon Macs (arm64) and Windows x64.');
    expect(body).toContain('Not verified on Windows hardware');
    expect(body).toContain('RecordStuff-1.2.0-x64-unsigned-setup.exe');
    expect(body).toContain('More info → Run anyway');
    expect(body).toContain('without an administrator prompt');
    expect(body).toContain('Settings → Apps → Installed apps → RecordStuff → Uninstall');
    expect(body).toContain('Videos\\RecordStuff');
    expect(body).toContain('Get-FileHash');
    expect(body).toContain('release-win32-x64.json');
    expect(body).toContain('gh attestation verify <file> --repo owner/repo');
    // The macOS instructions stay.
    expect(body).toContain('Open Anyway');
  });
  it('lists every binary asset on its own line of SHA256SUMS', () => {
    expect(sha256sums([{ file: 'a.dmg', sha256: 'a'.repeat(64) }, { file: 'b.exe', sha256: 'b'.repeat(64) }]))
      .toBe(`${'a'.repeat(64)}  a.dmg\n${'b'.repeat(64)}  b.exe\n`);
  });
});

describe('Windows installer gates', () => {
  /** A minimal MZ/PE header with the given COFF machine type. */
  function pe(machine: number, at = 0x80) {
    const head = Buffer.alloc(at + 6);
    head.write('MZ', 0, 'latin1');
    head.writeUInt32LE(at, 0x3c);
    head.write('PE\0\0', at, 'latin1');
    head.writeUInt16LE(machine, at + 4);
    return head;
  }
  it('reads the machine type of a PE image and refuses anything else', () => {
    expect(peMachine(pe(PE_MACHINE_X64))).toBe(0x8664);
    expect(peMachine(pe(0x14c))).toBe(0x14c);
    expect(peMachine(pe(0xaa64))).not.toBe(PE_MACHINE_X64);
    expect(() => peMachine(Buffer.from('#!/bin/sh\n'.padEnd(80)))).toThrow(/MZ/);
    const truncated = pe(PE_MACHINE_X64); truncated.writeUInt32LE(4000, 0x3c);
    expect(() => peMachine(truncated)).toThrow(/PE signature/);
  });
  it('reads the four-part Windows version resource as the release version', () => {
    expect(windowsVersionMatches('1.2.0.0', '1.2.0')).toBe(true);
    expect(windowsVersionMatches('1.2.0', '1.2.0')).toBe(true);
    expect(windowsVersionMatches('1.2.0.0', '1.2.0-rc.1')).toBe(true);
    expect(windowsVersionMatches('1.2.0-rc.1', '1.2.0-rc.1')).toBe(true);
    for (const wrong of ['1.2.1.0', '1.2.0.1', '1.1.1.0', '']) expect(windowsVersionMatches(wrong, '1.2.0')).toBe(false);
  });
  it('splits the registered quiet uninstall command, quoted or not', () => {
    expect(splitCommandLine('"C:\\Users\\a b\\AppData\\Local\\Programs\\recordstuff\\Uninstall RecordStuff.exe" /currentuser /S'))
      .toEqual(['C:\\Users\\a b\\AppData\\Local\\Programs\\recordstuff\\Uninstall RecordStuff.exe', ['/currentuser', '/S']]);
    expect(splitCommandLine('C:\\u.exe /S')).toEqual(['C:\\u.exe', ['/S']]);
    expect(() => splitCommandLine('   ')).toThrow(/Cannot parse/);
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
    // Pre-release identifiers compare one by one, numeric ones by value.
    expect(compareVersions('0.2.0-rc.9', '0.2.0-rc.10')).toBe(-1);
    expect(compareVersions('0.2.0-rc.10', '0.2.0-rc.9')).toBe(1);
    expect(compareVersions('0.2.0-rc-1', '0.2.0-rc-2')).toBe(-1);
    expect(compareVersions('0.2.0-rc', '0.2.0-rc.1')).toBe(-1);
    expect(compareVersions('0.2.0-1', '0.2.0-alpha')).toBe(-1);
    expect(compareVersions('0.2.0-alpha.1', '0.2.0-beta')).toBe(-1);
    expect(compareVersions('0.2.0-rc.1', '0.2.0-rc.1')).toBe(0);
    // Build metadata has no precedence (a tag `stableVersion` accepts).
    expect(compareVersions('1.3.0+rebuild', '1.3.1')).toBe(-1);
    expect(compareVersions('1.3.1', '1.3.0+rebuild')).toBe(1);
    expect(compareVersions('1.3.0+rebuild', '1.3.0')).toBe(0);
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
    const manifest: unknown = JSON.parse(readFileSync(new URL('../website/release-manifest.json', import.meta.url), 'utf8'));
    const published = releaseFactsFromManifest(manifest, 'https://github.com/EricTsai83/recordstuff/actions');
    for (const [file, lang] of [['README.md', 'en'], ['README.zh-TW.md', 'zh-TW']] as const) {
      const readme = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(readme, file).toContain(`<!-- release-download:start -->\n${renderDownloadSection(lang, published)}\n<!-- release-download:end -->`);
    }
  });
  it('derives stable document facts from structured data and rejects malformed snapshots', () => {
    const manifest = JSON.parse(readFileSync(new URL('../website/release-manifest.json', import.meta.url), 'utf8'));
    const runUrl = 'https://github.com/EricTsai83/recordstuff/actions/runs/123';
    const published = releaseFactsFromManifest(manifest, runUrl);
    expect(published).toEqual({
      version: manifest.version, tag: manifest.tag, repository: 'EricTsai83/recordstuff',
      sourceCommit: manifest.sourceCommit, file: manifest.dmg.name, size: manifest.dmg.size,
      sha256: manifest.dmg.sha256, publishedAt: manifest.publishedAt,
      date: manifest.publishedAt.slice(0, 10), runUrl,
    });
    expect(() => releaseFactsFromManifest({ ...manifest, tag: 'v99.0.0' }, runUrl)).toThrow();
    expect(() => releaseFactsFromManifest({ ...manifest, dmg: { ...manifest.dmg, sha256: 'invalid' } }, runUrl)).toThrow();
  });
  it('adds the Windows installer to the download blocks and records of a two-platform release', () => {
    const windows = { file: 'RecordStuff-1.2.0-x64-unsigned-setup.exe', size: 98765432, sha256: 'e'.repeat(64) };
    const two: ReleaseFacts = { ...facts, version: '1.2.0', tag: 'v1.2.0', file: 'RecordStuff-1.2.0-arm64-selfsigned.dmg', windows };
    for (const lang of ['en', 'zh-TW'] as const) {
      const block = renderDownloadSection(lang, two);
      expect(block).toContain(renderDownloadSection(lang, { ...two, windows: undefined }));
      expect(block).toContain(`https://github.com/EricTsai83/recordstuff/releases/download/v1.2.0/${windows.file}`);
      expect(block).toContain('98,765,432 bytes');
      expect(block).toContain(windows.sha256);
      const record = renderVerificationRecord(lang, two);
      expect(record).toContain(windows.file);
      expect(record).toContain(windows.sha256);
    }
    expect(renderDownloadSection('en', two)).toContain('capture has not been verified on Windows hardware');
    expect(renderVerificationRecord('en', two)).toMatch(/^# macOS and Windows 1\.2\.0 release verification/);
    expect(renderVerificationRecord('zh-TW', two)).toMatch(/^# macOS 與 Windows 1\.2\.0 發布驗證/);
    expect(renderVerificationRecord('en', facts)).toMatch(/^# macOS 0\.1\.2 release verification/);
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

describe('release tool failures', () => {
  it('always names why a command failed', () => {
    expect(failureReason({ error: new Error('spawnSync gh ENOBUFS'), stderr: '', status: null, signal: 'SIGTERM' })).toBe('spawnSync gh ENOBUFS');
    expect(failureReason({ stderr: '  HTTP 404  \n', status: 1, signal: null })).toBe('HTTP 404');
    expect(failureReason({ stderr: '', status: 2, signal: null })).toBe('exit status 2');
    expect(failureReason({ stderr: null, status: null, signal: 'SIGKILL' })).toBe('killed by SIGKILL');
  });
  it('marks only a version newer than every published stable release as latest', () => {
    const published = [{ tag_name: 'v1.2.0' }, { tag_name: 'v1.3.0-rc.1', prerelease: true }, { tag_name: 'v9.0.0', draft: true }];
    expect(latestFlag('1.3.0', published)).toBe('--latest');
    expect(latestFlag('1.1.5', published)).toBe('--latest=false');
    expect(latestFlag('1.4.0-rc.1', published)).toBe('--prerelease');
    expect(latestFlag('1.0.0', [])).toBe('--latest');
    expect(latestFlag('1.3.1', [{ tag_name: 'v1.3.0+rebuild' }])).toBe('--latest');
  });

  it('forces a busy detach and removes only an unmounted mount point, without throwing', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const calls: string[][] = [];
      const removed: string[] = [];
      const busyOnce = (args: string[]) => { calls.push(args); if (calls.length === 1) throw new Error('Resource busy'); };
      releaseMount('/tmp/m', true, busyOnce, dir => removed.push(dir));
      expect(calls).toEqual([['detach', '/tmp/m'], ['detach', '-force', '/tmp/m']]);
      expect(removed).toEqual(['/tmp/m']);

      removed.length = 0;
      expect(() => releaseMount('/tmp/m', true, () => { throw new Error('Resource busy'); }, dir => removed.push(dir))).not.toThrow();
      expect(removed).toEqual([]);

      const never = vi.fn();
      expect(() => releaseMount('/tmp/m', false, never, () => { throw new Error('EROFS'); })).not.toThrow();
      expect(never).not.toHaveBeenCalled();
      expect(errors.mock.calls.map(([line]) => String(line))).toEqual([
        'hdiutil detach /tmp/m failed: Resource busy',
        'hdiutil detach /tmp/m failed: Resource busy',
        'hdiutil detach -force /tmp/m failed: Resource busy',
        '/tmp/m is still mounted; leaving the mount point in place',
        'could not remove mount point /tmp/m: EROFS',
      ]);
    } finally { errors.mockRestore(); }
  });
});
