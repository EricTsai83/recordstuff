import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createIdentity } from './create-signing-identity.mts';

describe('encrypted signing identity creation', () => {
  it('creates a matching code-signing identity, protects its archive, and refuses overwrite', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'recordstuff-identity-test-')));
    const output = path.join(root, 'identity');
    const password = randomBytes(32).toString('hex');
    try {
      const result = createIdentity('RecordStuff Fixture', output, password, 2);
      const cert = new X509Certificate(readFileSync(path.join(output, 'certificate.pem')));
      expect(cert.verify(cert.publicKey)).toBe(true);
      expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.3');
      expect(cert.ca).toBe(false);
      expect(statSync(output).mode & 0o777).toBe(0o700);
      expect(readdirSync(output).sort()).toEqual(['certificate.pem', 'identity.json', 'identity.p12']);
      const unpack = spawnSync('/usr/bin/openssl', ['pkcs12', '-in', result.archive, '-nodes', '-nocerts', '-passin', 'env:FIXTURE_PASSWORD'], { encoding: 'utf8', env: { ...process.env, FIXTURE_PASSWORD: password } });
      expect(unpack.status).toBe(0);
      expect(cert.checkPrivateKey(createPrivateKey(unpack.stdout))).toBe(true);
      const wrong = spawnSync('/usr/bin/openssl', ['pkcs12', '-in', result.archive, '-noout', '-passin', 'pass:wrong'], { encoding: 'utf8' });
      expect(wrong.status).not.toBe(0);
      const original = readFileSync(result.archive);
      expect(() => createIdentity('RecordStuff Fixture', output, password)).toThrow();
      expect(readFileSync(result.archive)).toEqual(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects unsafe inputs without creating files', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'recordstuff-identity-input-')));
    try {
      const output = path.join(root, 'new');
      expect(() => createIdentity('Name/CN=Injected', output, 'long-enough-password')).toThrow();
      expect(() => createIdentity('Name', output, 'short')).toThrow();
      expect(() => createIdentity('Name', output, 'long-enough-password', 0)).toThrow();
      expect(readdirSync(root)).toEqual([]);
      writeFileSync(path.join(root, 'keep'), 'existing data');
      expect(() => createIdentity('Name', path.join(root, 'keep'), 'long-enough-password')).toThrow();
      expect(readFileSync(path.join(root, 'keep'), 'utf8')).toBe('existing data');
      expect(() => createIdentity('Name', path.resolve('identity-test-output'), 'long-enough-password')).toThrow('outside the project');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
