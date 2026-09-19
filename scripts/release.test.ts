import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDmgContents, assertUnreleased, isPrerelease, notes, validateDigest, validateTag } from './release.mts';

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
    expect(body).toContain('no automatic updater');
    expect(body).toContain('Remove');
    expect(body).toContain('Trash');
    expect(body).toContain(`/blob/${'a'.repeat(40)}/resources/INSTALL.md`);
    expect(body).toContain(`/blob/${'a'.repeat(40)}/resources/INSTALL.zh-TW.md`);
    expect(body).toContain('Finder');
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
