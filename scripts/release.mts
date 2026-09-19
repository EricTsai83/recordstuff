import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const signingSHA1 = '01B373511530BBF287CA35E54C10A5F017AAD637';
/** Stable `1.2.3` or pre-release `1.2.3-rc.1`; the tag is always `v` + version. */
export function validateTag(tag: string, version: string) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version) || tag !== `v${version}`) throw new Error('Tag must match the package version (vX.Y.Z or vX.Y.Z-suffix).');
}
/** Pre-release versions are published flagged as pre-release and never marked latest. */
export const isPrerelease = (version: string) => version.includes('-');
export function validateDigest(actual: string, expected: string) {
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error('Checksum mismatch.');
}
export function assertUnreleased(releases: { tag_name: string }[], tag: string) {
  if (releases.some(r => r.tag_name === tag)) throw new Error('Version already has a release (including drafts); refusing reuse.');
}
export interface PublishedRelease { draft: boolean; assets: { name: string; size: number; digest?: string | null }[] }
/** The public release must be exactly the verified files: same names, sizes and GitHub-computed SHA-256 digests. */
export function assertPublishedAssets(release: PublishedRelease, expected: { name: string; size: number; sha256: string }[]) {
  if (release.draft) throw new Error('Release is still a draft.');
  if (release.assets.length !== expected.length) throw new Error(`Expected ${expected.length} assets, found ${release.assets.length}.`);
  for (const file of expected) {
    const asset = release.assets.find(a => a.name === file.name);
    if (!asset) throw new Error(`Missing published asset ${file.name}.`);
    if (asset.size !== file.size) throw new Error(`Published ${file.name} has ${asset.size} bytes, verified file has ${file.size}.`);
    if (asset.digest !== `sha256:${file.sha256}`) throw new Error(`Published ${file.name} digest ${asset.digest ?? 'missing'} differs from verified sha256:${file.sha256}.`);
  }
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
  if (!tag || !['preflight', 'candidate', 'verify', 'publish', 'published'].includes(mode ?? '')) throw new Error('Usage: release.mts preflight|candidate|verify|publish|published vX.Y.Z [directory]');
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
  if (mode === 'published') {
    // The directory holds files downloaded anonymously from the public release URL; they passed verifyCandidate above.
    const release = api(`repos/${c.repository}/releases/tags/${tag}`) as PublishedRelease;
    assertPublishedAssets(release, [metadata.file, 'SHA256SUMS', 'release.json'].map(name => {
      const local = path.join(directory, name);
      return { name, size: statSync(local).size, sha256: digest(local) };
    }));
    console.log(`Published ${tag} matches the verified bytes: ${metadata.sha256}`);
    return;
  }
  // publish: the tag already exists (pushed by the maintainer); the release must not.
  assertUnreleased(releases(c.repository), tag);
  if (api(`repos/${c.repository}/commits/${tag}`).sha !== c.sourceCommit) throw new Error('Tag does not point to the verified source commit.');
  const body = path.join(directory, 'release-notes.md');
  writeFileSync(body, notes(c.version, c.repository, c.sourceCommit));
  const prerelease = isPrerelease(c.version);
  run('gh', ['release', 'create', tag, '--repo', c.repository, '--verify-tag', prerelease ? '--prerelease' : '--latest',
    '--title', `RecordStuff ${c.version} — macOS arm64`, '--notes-file', body,
    ...[metadata.file, 'SHA256SUMS', 'release.json'].map(f => path.join(directory, f))]);
  console.log(`Published ${tag}${prerelease ? ' as a pre-release' : ' as latest'} from verified candidate ${metadata.sha256}.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
