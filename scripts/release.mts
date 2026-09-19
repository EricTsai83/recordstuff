import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
/** Semver-style order: numeric core, then a pre-release sorts below its release; returns −1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => { const [core = '', pre] = v.split('-', 2); return { core: core.split('.').map(Number), pre }; };
  const x = split(a); const y = split(b);
  for (let i = 0; i < 3; i += 1) { const d = (x.core[i] ?? 0) - (y.core[i] ?? 0); if (d !== 0) return d < 0 ? -1 : 1; }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}
/** Rewrites only the top-level "version" value of a package.json text, keeping formatting. */
export function setPackageVersion(text: string, version: string): string {
  const next = text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) throw new Error('package.json has no top-level version field.');
  return next;
}
/** Replaces the block between `<!-- name:start -->` and `<!-- name:end -->` markers, keeping the markers. */
export function replaceMarked(text: string, name: string, block: string): string {
  const start = `<!-- ${name}:start -->`; const end = `<!-- ${name}:end -->`;
  const from = text.indexOf(start); const to = text.indexOf(end);
  if (from < 0 || to < 0 || to < from) throw new Error(`Markers ${start} … ${end} not found.`);
  return `${text.slice(0, from + start.length)}\n${block}\n${text.slice(to)}`;
}
export interface ReleaseFacts { version: string; tag: string; repository: string; sourceCommit: string; file: string; size: number; sha256: string; runUrl: string; publishedAt: string; date: string }
const bytes = (n: number) => n.toLocaleString('en-US');
/** README download paragraphs; the English and Chinese texts are maintained here so a release updates both. */
export function renderDownloadSection(lang: 'en' | 'zh-TW', f: ReleaseFacts): string {
  const base = `https://github.com/${f.repository}/releases`;
  const dmg = `${base}/download/${f.tag}/${f.file}`; const sums = `${base}/download/${f.tag}/SHA256SUMS`;
  return lang === 'en'
    ? `Download **[RecordStuff ${f.version} for macOS Apple silicon (arm64)](${dmg})** (${bytes(f.size)} bytes). [Release notes](${base}/tag/${f.tag}) · [SHA256SUMS](${sums}) · [Latest release](${base}/latest).\n\nSHA-256: \`${f.sha256}\`.`
    : `下載 **[RecordStuff ${f.version}：macOS Apple silicon（arm64）](${dmg})**（${bytes(f.size)} bytes）。[英文發行說明](${base}/tag/${f.tag}) · [SHA256SUMS](${sums}) · [最新版本](${base}/latest)。\n\nSHA-256：\`${f.sha256}\`。`;
}
/** Verification record skeleton: the facts CI knows, plus the sections a human must fill or leave marked as not recorded. */
export function renderVerificationRecord(lang: 'en' | 'zh-TW', f: ReleaseFacts): string {
  const release = `https://github.com/${f.repository}/releases/tag/${f.tag}`;
  if (lang === 'en') return `# macOS ${f.version} release verification

[English](${f.version}.md) | [繁體中文](../../zh-TW/verification/releases/${f.version}.md)

${f.date}: published from tag \`${f.tag}\` by the tag-triggered workflow. This record was generated by the workflow's record job from release metadata; the sections marked "fill in" are the maintainer's evidence and stay honest about what was and was not checked.

## Public release

[Workflow run](${f.runUrl}) built, signed, verified, published and re-verified the anonymous public download. Source commit \`${f.sourceCommit}\`. The [release](${release}) is public and was published at ${f.publishedAt}.

- File: \`${f.file}\`
- Size: ${bytes(f.size)} bytes
- SHA-256: \`${f.sha256}\`

## Local acceptance before tagging — fill in

State what was run on the tagged source before pushing the tag (\`pnpm start:app\`, recording length, playback, permission behavior, \`pnpm verify\` result). If nothing was run, say so.

## Not recorded

List checks that were not performed for this version.
`;
  return `# macOS ${f.version} 發布驗證

[English](../../../verification/releases/${f.version}.md) | [繁體中文](${f.version}.md)

${f.date}：由 tag 觸發的 workflow 從 \`${f.tag}\` 公開。本紀錄由 workflow 的 record job 依 release metadata 產生；標示「待填」的段落是維護者的證據，如實記錄做過與沒做過的檢查。

## 公開發布

[Workflow run](${f.runUrl}) 建置、簽署、驗證、公開並重驗匿名公開下載。source commit \`${f.sourceCommit}\`。[Release](${release}) 為公開，發布時間 ${f.publishedAt}。

- 檔案：\`${f.file}\`
- 大小：${bytes(f.size)} bytes
- SHA-256：\`${f.sha256}\`

## 打 tag 前的本機驗收 — 待填

寫明推送 tag 前在該原始碼上做了什麼（\`pnpm start:app\`、錄影長度、播放、權限行為、\`pnpm verify\` 結果）。若沒有做，照實寫。

## 未記錄

列出本版未執行的檢查。
`;
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
/** The tag is the version: the repository's package.json only records the last published version. */
function context(tag: string) {
  const version = tag.replace(/^v/, '');
  validateTag(tag, version);
  const sourceCommit = run('git', ['rev-parse', 'HEAD']);
  const repository = process.env.GITHUB_REPOSITORY ?? run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository.');
  return { tag, version, sourceCommit, repository };
}
/**
 * Context for verifying an already published tag from any checkout: the
 * version is the tag itself and the source commit is what the tag points to,
 * so the tooling can be newer than the release being checked.
 */
function contextFromTag(tag: string) {
  const version = tag.replace(/^v/, '');
  validateTag(tag, version);
  const repository = process.env.GITHUB_REPOSITORY ?? run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository.');
  const sourceCommit = api(`repos/${repository}/commits/${tag}`).sha as string;
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('Tag does not resolve to a commit.');
  return { tag, version, sourceCommit, repository };
}
type ReleaseContext = ReturnType<typeof context>;
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
function verifyDmg(directory: string, tag: string, c: ReleaseContext = context(tag)) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Release verification requires macOS arm64.');
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
function verifyCandidate(directory: string, tag: string, c: ReleaseContext = context(tag)) {
  const metadata = JSON.parse(readFileSync(path.join(directory, 'release.json'), 'utf8'));
  const actual = verifyDmg(directory, tag, c);
  for (const [key, value] of Object.entries(actual)) {
    if (metadata[key] !== value) throw new Error(`Candidate metadata mismatch: ${key}`);
  }
  if (readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8') !== `${actual.sha256}  ${actual.file}\n`) throw new Error('SHA256SUMS mismatch.');
  return actual;
}
function main() {
  const [mode, tag, directoryArg] = process.argv.slice(2);
  if (!tag || !['preflight', 'version', 'candidate', 'verify', 'publish', 'published', 'record'].includes(mode ?? '')) throw new Error('Usage: release.mts preflight|version|candidate|verify|publish|published|record vX.Y.Z [directory]');
  const packageJsonPath = path.join(root, 'package.json');
  const packageVersion = () => JSON.parse(readFileSync(packageJsonPath, 'utf8')).version as string;
  if (mode === 'version') {
    // Write the tag's version into the working tree so electron-builder stamps the App and DMG with it. Not committed here.
    const c = context(tag);
    writeFileSync(packageJsonPath, setPackageVersion(readFileSync(packageJsonPath, 'utf8'), c.version));
    console.log(`package.json version set to ${c.version} for this build.`);
    return;
  }
  if (mode === 'record') {
    // After a successful release: write the facts CI knows back into the repository (committed by the workflow).
    const c = contextFromTag(tag);
    const release = api(`repos/${c.repository}/releases/tags/${tag}`) as PublishedRelease & { html_url: string; published_at: string; prerelease: boolean };
    const file = `RecordStuff-${c.version}-arm64-selfsigned.dmg`;
    const asset = release.assets.find(a => a.name === file);
    if (release.draft || !asset || !asset.digest?.startsWith('sha256:')) throw new Error('Release is not public or its DMG digest is unavailable.');
    const facts: ReleaseFacts = { ...c, file, size: asset.size, sha256: asset.digest.slice('sha256:'.length), runUrl: process.env.RELEASE_RUN_URL ?? `https://github.com/${c.repository}/actions`, publishedAt: release.published_at, date: release.published_at.slice(0, 10) };
    const changed: string[] = [];
    const write = (rel: string, text: string) => { writeFileSync(path.join(root, rel), text); changed.push(rel); };
    for (const [rel, lang] of [['docs/verification/releases', 'en'], ['docs/zh-TW/verification/releases', 'zh-TW']] as const) {
      const target = `${rel}/${c.version}.md`;
      if (!existsSync(path.join(root, target))) write(target, renderVerificationRecord(lang, facts));
    }
    if (!release.prerelease) {
      if (compareVersions(packageVersion(), c.version) < 0) write('package.json', setPackageVersion(readFileSync(packageJsonPath, 'utf8'), c.version));
      for (const [rel, lang] of [['README.md', 'en'], ['README.zh-TW.md', 'zh-TW']] as const) {
        write(rel, replaceMarked(readFileSync(path.join(root, rel), 'utf8'), 'release-download', renderDownloadSection(lang, facts)));
      }
    }
    console.log(changed.length ? `Recorded ${tag}: ${changed.join(', ')}` : `Nothing to record for ${tag}.`);
    return;
  }
  if (mode === 'published') {
    // Files downloaded anonymously from the public release URL, checked with the tooling of this checkout.
    if (!directoryArg) throw new Error('Downloaded-assets directory is required.');
    const published = contextFromTag(tag);
    const directory = path.resolve(directoryArg);
    const metadata = verifyCandidate(directory, tag, published);
    const release = api(`repos/${published.repository}/releases/tags/${tag}`) as PublishedRelease;
    assertPublishedAssets(release, [metadata.file, 'SHA256SUMS', 'release.json'].map(name => {
      const local = path.join(directory, name);
      return { name, size: statSync(local).size, sha256: digest(local) };
    }));
    console.log(`Published ${tag} (${published.sourceCommit}) matches the verified bytes: ${metadata.sha256}`);
    return;
  }
  const c = context(tag);
  if (mode === 'preflight') {
    if (run('git', ['status', '--porcelain'])) throw new Error('Release source must be clean.');
    if (compareVersions(c.version, packageVersion()) < 0) throw new Error(`Tag ${tag} is older than the repository's last recorded version ${packageVersion()}.`);
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
