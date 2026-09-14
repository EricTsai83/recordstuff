import { describe, expect, it } from 'vitest';
import { assertPromotion, assertUnreleased, notes, validateDigest, validateTag } from './release.mts';

describe('release gates', () => {
  it('accepts only the exact stable package tag', () => {
    expect(() => validateTag('v0.1.1', '0.1.1')).not.toThrow();
    for (const tag of ['v0.1.0', '0.1.1', 'v0.1.1-beta', 'v0.1.1\n', 'v0.1.1;echo x']) {
      expect(() => validateTag(tag, '0.1.1')).toThrow();
    }
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
  it('permits promotion only for the manually accepted exact draft bytes', () => {
    const hash = 'a'.repeat(64);
    expect(() => assertPromotion('true', hash, hash, true)).not.toThrow();
    for (const accepted of [undefined, 'false', 'yes']) expect(() => assertPromotion(accepted, hash, hash, true)).toThrow();
    expect(() => assertPromotion('true', 'b'.repeat(64), hash, true)).toThrow();
    expect(() => assertPromotion('true', hash, hash, false)).toThrow();
  });
  it('preserves English self-signing instructions and commit-pinned bilingual guide links', () => {
    const body = notes('0.1.1', 'owner/repo', 'a'.repeat(40));
    expect(body).toContain('Open Anyway');
    expect(body).toContain('not notarized');
    expect(body).toContain(`/blob/${'a'.repeat(40)}/resources/INSTALL.zh-TW.md`);
    expect(body).toContain('Finder');
  });
});
