// Creates an encrypted identity archive; never modifies Keychain or release credentials.
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const passwordVariable = 'RECORDSTUFF_P12_PASSWORD';

function openssl(args: string[], password: string): void {
  const result = spawnSync('/usr/bin/openssl', args, {
    encoding: 'utf8', env: { ...process.env, [passwordVariable]: password },
  });
  // Do not echo arguments, environment, or tool diagnostics containing key material.
  if (result.error || result.status !== 0) throw new Error(`OpenSSL ${args[0]} failed; no identity was retained.`);
}

export function createIdentity(name: string, output: string, password: string, days = 3650) {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(name) || name !== name.trim()) {
    throw new Error('Use a unique 1–80 character name containing ASCII letters, numbers, spaces, dots, underscores or hyphens.');
  }
  if (password.length < 16 || /[\r\n\0]/.test(password)) throw new Error('Set RECORDSTUFF_P12_PASSWORD to at least 16 characters without newlines or NUL.');
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Validity must be 1–3650 days.');
  const requested = path.resolve(output);
  const parent = realpathSync(path.dirname(requested));
  const destination = path.join(parent, path.basename(requested));
  const relative = path.relative(projectRoot, destination);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Identity output must be outside the project directory.');
  }
  const git = spawnSync('git', ['-C', parent, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (git.status === 0) throw new Error('Identity output must be outside Git repositories.');
  // Exclusive directory creation rejects existing files, directories and symlinks.
  mkdirSync(destination, { mode: 0o700 });
  try {
    const config = path.join(destination, 'openssl.cnf');
    const key = path.join(destination, 'private-key.pem');
    const certificate = path.join(destination, 'certificate.pem');
    writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n', { mode: 0o600 });
    openssl(['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', String(days),
      '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-subj', `/CN=${name}`, '-config', config,
      '-passout', `env:${passwordVariable}`, '-keyout', key, '-out', certificate], password);
    const cert = new X509Certificate(readFileSync(certificate));
    const privateKey = createPrivateKey({ key: readFileSync(key), passphrase: password });
    if (cert.subject !== cert.issuer || !cert.verify(cert.publicKey) || !cert.checkPrivateKey(privateKey) ||
      !cert.keyUsage?.includes('1.3.6.1.5.5.7.3.3') || cert.ca) {
      throw new Error('Generated certificate failed self-signature, private-key or code-signing checks.');
    }
    const archive = path.join(destination, 'identity.p12');
    openssl(['pkcs12', '-export', '-inkey', key, '-in', certificate, '-name', name,
      '-passin', `env:${passwordVariable}`, '-passout', `env:${passwordVariable}`, '-out', archive], password);
    const metadata = { name, sha1: cert.fingerprint.replaceAll(':', ''), expires: cert.validTo };
    writeFileSync(path.join(destination, 'identity.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    rmSync(key);
    rmSync(config);
    return { ...metadata, archive };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: pnpm signing:create [--name "RecordStuff Dev"] [--output /private/location/new-directory]\nExisting certificates are preserved; creation requires RECORDSTUFF_P12_PASSWORD (16+ characters).\nCreates encrypted identity.p12 + public certificate.pem + identity.json outside Git. Does not import or change Keychain trust.');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('Identity setup requires macOS.');
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag || !['--name', '--output'].includes(flag) || !value || value.startsWith('--') || options.has(flag)) {
      throw new Error('Invalid arguments. Run pnpm signing:create --help.');
    }
    options.set(flag, value);
  }
  const name = options.get('--name') ?? 'RecordStuff Dev';
  // Search all certificates, not just valid identities: expired/orphaned certificates must not be replaced silently.
  const found = spawnSync('/usr/bin/security', ['find-certificate', '-a', '-p', '-c', name], { encoding: 'utf8' });
  if (found.error || (found.status !== 0 && found.status !== 44)) throw new Error('Could not inspect Keychain; refusing to create an identity.');
  if (found.stdout.trim()) {
    console.log(`Preserved existing Keychain certificate matching ${JSON.stringify(name)}. No new keys or files created.\nUse security find-identity -v -p codesigning to check usability; import the original identity when migrating machines.`);
    return;
  }
  const output = options.get('--output');
  if (!output) throw new Error('No existing certificate found. Supply --output outside Git and RECORDSTUFF_P12_PASSWORD to create one.');
  const result = createIdentity(name, output, process.env[passwordVariable] ?? '');
  console.log(`Created encrypted identity: ${result.archive}\nPublic SHA-1: ${result.sha1}\nExpires: ${result.expires}\nImport identity.p12 into Keychain and configure Code Signing trust before packaging. Keep this identity for subsequent builds.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : 'Identity creation failed.');
    process.exitCode = 1;
  }
}
