import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const signingSHA1 = '01B373511530BBF287CA35E54C10A5F017AAD637';
export function validateTag(tag: string, version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `v${version}`) throw new Error('Tag must match the stable package version.');
}
export function validateDigest(actual: string, expected: string) {
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error('Checksum mismatch.');
}
export function assertUnreleased(releases: { tag_name: string }[], tag: string) {
  if (releases.some(r => r.tag_name === tag)) throw new Error('Version already has a release (including drafts); refusing reuse.');
}
export function assertPromotion(accepted: string | undefined, expected: string, actual: string, draft: boolean) {
  if (accepted !== 'true') throw new Error('Manual installation/recording/playback/language acceptance is required.');
  validateDigest(actual, expected);
  if (!draft) throw new Error('Promotion requires an existing draft.');
}
const root = fileURLToPath(new URL('..', import.meta.url));
function run(command: string, args: string[], input?: string) {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`${command} ${args[0]} failed: ${r.stderr?.trim() ?? r.error?.message}`);
  return r.stdout.trim();
}
function api(endpoint: string, method = 'GET', payload?: unknown) {
  return JSON.parse(run('gh', ['api', endpoint, '--method', method, ...(payload ? ['--input', '-'] : [])], payload ? JSON.stringify(payload) : undefined));
}
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function context(tag: string) {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
  validateTag(tag, version);
  const sourceCommit = run('git', ['rev-parse', 'HEAD']);
  const repository = process.env.GITHUB_REPOSITORY ?? run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository.');
  return { tag, version, sourceCommit, repository };
}
function releases(repository: string) {
  return JSON.parse(run('gh', ['api', `repos/${repository}/releases`, '--paginate', '--slurp'])).flat();
}
export function notes(version: string, repository: string, commit: string) {
  const base = `https://github.com/${repository}/blob/${commit}/resources`;
  return `RecordStuff ${version} for Apple silicon Macs (arm64).

Install: open the DMG and drag RecordStuff onto the Applications folder, then eject the disk image. The DMG contains only the app and an Applications shortcut; the guides below are the installation documentation.

The app is self-signed and not notarized by Apple. First launch may require System Settings → Privacy & Security → Open Anyway. Recipients do not install certificates. Then allow Screen & System Audio Recording and relaunch when macOS asks.

Update manually: stop recording, quit RecordStuff from its menu, download the new DMG and drag the app into Applications, replacing the existing copy. The signing identity is unchanged, so settings and permissions carry over. There is no automatic updater.

Remove: quit the app and move RecordStuff.app from Applications to the Trash. Recordings, settings and logs stay on disk; the guide explains optional cleanup.

Guides: [English](${base}/INSTALL.md) · [Traditional Chinese](${base}/INSTALL.zh-TW.md).

Known limitation: clicking a recording notification may select the file without bringing Finder to the front.

Verify the download using SHA256SUMS. release.json records the source commit, version, platform, size, and signing certificate fingerprint.
`;
}
/** Visible root entries of a mounted release DMG: the App and the Applications link only (013). */
export const expectedDmgContents = ['Applications', 'RecordStuff.app'];
/** Hidden root files Finder/dmgbuild need for the window layout. dmg-builder merges the PNG pair into one `.background.tiff`; hidden directories are never permitted, so nothing can be tucked inside one. */
export const permittedHiddenDmgEntries = ['.DS_Store', '.VolumeIcon.icns', '.background.png', '.background.tiff'];
/** `root` is the mounted DMG root; every hidden entry must be a permitted regular file, not a directory or symlink. */
export function assertDmgContents(root: string) {
  const entries = readdirSync(root);
  const visible = entries.filter(n => !n.startsWith('.')).sort();
  if (JSON.stringify(visible) !== JSON.stringify(expectedDmgContents)) {
    throw new Error(`Unexpected mounted DMG contents: ${visible.join(', ') || '(empty)'}; expected ${expectedDmgContents.join(', ')}.`);
  }
  const hidden = entries.filter(n => n.startsWith('.') && !(permittedHiddenDmgEntries.includes(n) && lstatSync(path.join(root, n)).isFile()));
  if (hidden.length) throw new Error(`Unexpected hidden DMG entries: ${hidden.join(', ')}. Only Finder layout files may be hidden; documents and folders must not be bundled.`);
}
function verifyDmg(directory: string, tag: string) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Release verification requires macOS arm64.');
  const c = context(tag);
  const file = `RecordStuff-${c.version}-arm64-selfsigned.dmg`;
  const dmg = path.join(directory, file);
  if (!statSync(dmg).isFile()) throw new Error('Missing DMG.');
  run('hdiutil', ['verify', dmg]);
  const mount = mkdtempSync(path.join(tmpdir(), 'recordstuff-release-mount-'));
  let attached = false;
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg]);
    attached = true;
    assertDmgContents(mount);
    if (readlinkSync(path.join(mount, 'Applications')) !== '/Applications') throw new Error('Invalid Applications link.');
    const app = path.join(mount, 'RecordStuff.app');
    if (run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]) !== c.version) throw new Error('Packaged App version mismatch.');
    if (run('lipo', ['-archs', path.join(app, 'Contents/MacOS/RecordStuff')]) !== 'arm64') throw new Error('Packaged App architecture mismatch.');
    const check = spawnSync(process.execPath, [path.join(root, 'scripts/start-app.mjs'), '--verify-app', app], {
      cwd: root, encoding: 'utf8', env: { ...process.env, RECORDSTUFF_SIGN_IDENTITY: signingSHA1 },
    });
    if (check.status !== 0) throw new Error(`App signature/identity verification failed: ${check.stderr}`);
    return { ...c, platform: 'darwin-arm64', file, size: statSync(dmg).size, sha256: digest(dmg),
      signingCertificateSHA1: signingSHA1, appAsarSHA256: digest(path.join(app, 'Contents/Resources/app.asar')) };
  } finally {
    if (attached) run('hdiutil', ['detach', mount]);
    rmSync(mount, { recursive: true, force: true });
  }
}
function verifyCandidate(directory: string, tag: string) {
  const metadata = JSON.parse(readFileSync(path.join(directory, 'release.json'), 'utf8'));
  const actual = verifyDmg(directory, tag);
  for (const [key, value] of Object.entries(actual)) {
    if (metadata[key] !== value) throw new Error(`Candidate metadata mismatch: ${key}`);
  }
  if (readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8') !== `${actual.sha256}  ${actual.file}\n`) throw new Error('SHA256SUMS mismatch.');
  return actual;
}
function main() {
  const [mode, tag, directoryArg] = process.argv.slice(2);
  if (!tag || !['preflight', 'candidate', 'verify', 'draft', 'promote'].includes(mode ?? '')) throw new Error('Usage: release.mts preflight|candidate|verify|draft|promote vX.Y.Z [candidate-directory]');
  const c = context(tag);
  if (mode === 'preflight') {
    if (run('git', ['status', '--porcelain'])) throw new Error('Release source must be clean.');
    assertUnreleased(releases(c.repository), tag);
    console.log(`Preflight passed: ${tag} at ${c.sourceCommit}`);
    return;
  }
  if (!directoryArg) throw new Error('Candidate directory is required.');
  const directory = path.resolve(directoryArg);
  if (mode === 'candidate') {
    const metadata = verifyDmg(directory, tag);
    writeFileSync(path.join(directory, 'release.json'), `${JSON.stringify({ ...metadata, node: process.versions.node, pnpm: run('pnpm', ['--version']) }, null, 2)}\n`);
    writeFileSync(path.join(directory, 'SHA256SUMS'), `${metadata.sha256}  ${metadata.file}\n`);
    console.log(JSON.stringify(metadata));
    return;
  }
  const metadata = verifyCandidate(directory, tag);
  if (mode === 'verify') { console.log(`Verified ${metadata.file}: ${metadata.sha256}`); return; }
  const existing = releases(c.repository);
  if (mode === 'draft') {
    assertUnreleased(existing, tag);
    const refs = api(`repos/${c.repository}/git/matching-refs/tags/${tag}`) as { ref: string }[];
    if (refs.some(r => r.ref === `refs/tags/${tag}`)) {
      if (api(`repos/${c.repository}/commits/${tag}`).sha !== c.sourceCommit) throw new Error('Existing tag points to another commit.');
    } else {
      api(`repos/${c.repository}/git/refs`, 'POST', { ref: `refs/tags/${tag}`, sha: c.sourceCommit });
    }
    const body = path.join(directory, 'release-notes.md');
    writeFileSync(body, notes(c.version, c.repository, c.sourceCommit));
    run('gh', ['release', 'create', tag, '--repo', c.repository, '--verify-tag', '--draft', '--title', `RecordStuff ${c.version} — macOS arm64`, '--notes-file', body,
      ...[metadata.file, 'SHA256SUMS', 'release.json'].map(f => path.join(directory, f))]);
    console.log(`Created draft ${tag}; installation and manual acceptance are required before promotion.`);
  } else if (mode === 'promote') {
    const release = existing.find((r: { tag_name: string }) => r.tag_name === tag);
    assertPromotion(process.env.RELEASE_MANUAL_ACCEPTANCE, process.env.RELEASE_EXPECTED_SHA256 ?? '', metadata.sha256, release?.draft === true);
    if (api(`repos/${c.repository}/commits/${tag}`).sha !== c.sourceCommit) throw new Error('Tag source mismatch.');
    const assets = api(`repos/${c.repository}/releases/${release.id}/assets`) as { name: string; size: number; digest?: string }[];
    if (assets.length !== 3) throw new Error('Unexpected release assets.');
    for (const file of [metadata.file, 'SHA256SUMS', 'release.json']) {
      const asset = assets.find(a => a.name === file);
      const local = path.join(directory, file);
      if (!asset || asset.size !== statSync(local).size || asset.digest !== `sha256:${digest(local)}`) throw new Error('Remote asset changed or has no verifiable digest.');
    }
    api(`repos/${c.repository}/releases/${release.id}`, 'PATCH', { draft: false, make_latest: 'true' });
    console.log(`Published existing verified assets for ${tag}; no rebuild.`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
