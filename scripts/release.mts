import { stableVersion } from "../src/shared/version.ts";
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchManifest } from './lib/release-manifest-client.mts';
import { assertManifestShape, assertWindowsRecord, carriesWindows, diffManifest, expectedAssetNames, expectedDmgName, expectedWindowsInstallerName, REPOSITORY, WINDOWS_PLATFORM, WINDOWS_RECORD, type ReleaseManifest, type WindowsReleaseJson } from './lib/release-manifest.mts';

export const signingSHA1 = '01B373511530BBF287CA35E54C10A5F017AAD637';
/** Stable `1.2.3` or pre-release `1.2.3-rc.1`; the tag is always `v` + version. */
export function validateTag(tag: string, version: string) {
  if (!stableVersion(version.split('-')[0]) || !/^\d+\.\d+\.\d+(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version) || tag !== `v${version}`) throw new Error('Tag must match the package version (vX.Y.Z or vX.Y.Z-suffix).');
}
/** Pre-release versions are published flagged as pre-release and never marked latest. */
export const isPrerelease = (version: string) => version.includes('-');
/**
 * The `gh release create` flag for `version`. GitHub's latest release is the
 * app's update fallback and the guides' download link, so it only moves
 * forward: a stable version published after a newer stable one stays historical.
 */
export function latestFlag(version: string, published: { tag_name: string; draft?: boolean; prerelease?: boolean }[]): '--prerelease' | '--latest' | '--latest=false' {
  if (isPrerelease(version)) return '--prerelease';
  const newer = published.some(r => !r.draft && !r.prerelease && stableVersion(r.tag_name.slice(1)) && compareVersions(r.tag_name.slice(1), version) > 0);
  return newer ? '--latest=false' : '--latest';
}
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
/** Semver order: numeric core, then a pre-release sorts below its release; build metadata (`+…`) is ignored. Returns −1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  // The pre-release is everything after the first hyphen; it may contain more hyphens (`rc-1`).
  const split = (version: string) => { const v = version.split('+')[0]!; const at = v.indexOf('-'); return { core: (at < 0 ? v : v.slice(0, at)).split('.').map(Number), pre: at < 0 ? undefined : v.slice(at + 1) }; };
  const x = split(a); const y = split(b);
  for (let i = 0; i < 3; i += 1) { const d = (x.core[i] ?? 0) - (y.core[i] ?? 0); if (d !== 0) return d < 0 ? -1 : 1; }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return comparePrerelease(x.pre, y.pre);
}
/** Semver pre-release precedence: dot-separated identifiers, numeric ones by value and below alphanumeric ones; a shorter prefix sorts first. */
function comparePrerelease(a: string, b: string): number {
  const xs = a.split('.'); const ys = b.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i += 1) {
    const p = xs[i]; const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pNumeric = /^\d+$/.test(p); const qNumeric = /^\d+$/.test(q);
    if (pNumeric && qNumeric) { const d = Number(p) - Number(q); if (d !== 0) return d < 0 ? -1 : 1; continue; }
    if (pNumeric !== qNumeric) return pNumeric ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
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
/** The committed stable download pointer: the website manifest, from which both README blocks are rendered. */
export const stableManifestPath = 'website/release-manifest.json';
/** Reads the stable pointer a stable record compares against; a missing or invalid one is never replaced by a guess. */
export function readStableManifest(file: string): ReleaseManifest {
  const remedy = `Restore ${stableManifestPath} from main, or regenerate it for the current stable release with \`pnpm site:manifest generate vX.Y.Z\`, then rerun record.`;
  const reason = (error: unknown) => { const message = error instanceof Error ? error.message : String(error); return /[.!?]$/.test(message) ? message : `${message}.`; };
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { throw new Error(`Cannot read the committed stable manifest ${stableManifestPath}: ${reason(error)} ${remedy}`); }
  try { return assertManifestShape(JSON.parse(text)); }
  catch (error) { throw new Error(`The committed stable manifest ${stableManifestPath} is invalid: ${reason(error)} ${remedy}`); }
}
/** What recording a verified stable release does to the stable download pointers. */
export type StablePointerOutcome = 'promoted' | 'unchanged' | 'historical-only';
/**
 * The committed stable manifest, not package.json, decides: a newer version
 * promotes, an older one is historical only, and the same version must carry
 * the same release identity and asset facts, so a retry cannot swap them.
 */
export function stablePointerOutcome(current: ReleaseManifest, candidate: ReleaseManifest): StablePointerOutcome {
  const order = compareVersions(candidate.version, current.version);
  if (order > 0) return 'promoted';
  if (order < 0) return 'historical-only';
  const differences = diffManifest(current, candidate);
  if (differences.length) throw new Error(`${candidate.tag} is already the recorded stable release with different facts; refusing to overwrite it:\n  ${differences.join('\n  ')}`);
  return 'unchanged';
}
export interface InstallerFacts { file: string; size: number; sha256: string }
export interface ReleaseFacts { version: string; tag: string; repository: string; sourceCommit: string; file: string; size: number; sha256: string; runUrl: string; publishedAt: string; date: string; windows?: InstallerFacts | undefined }
/** Stable documentation and the website share the same verified release snapshot. */
export function releaseFactsFromManifest(value: unknown, runUrl: string): ReleaseFacts {
  const manifest = assertManifestShape(value);
  return {
    version: manifest.version, tag: manifest.tag, repository: REPOSITORY,
    sourceCommit: manifest.sourceCommit, file: manifest.dmg.name,
    size: manifest.dmg.size, sha256: manifest.dmg.sha256,
    publishedAt: manifest.publishedAt, date: manifest.publishedAt.slice(0, 10), runUrl,
    ...(manifest.windows ? { windows: { file: manifest.windows.name, size: manifest.windows.size, sha256: manifest.windows.sha256 } } : {}),
  };
}
const bytes = (n: number) => n.toLocaleString('en-US');
/** README download paragraphs; the English and Chinese texts are maintained here so a release updates both. */
export function renderDownloadSection(lang: 'en' | 'zh-TW', f: ReleaseFacts): string {
  const base = `https://github.com/${f.repository}/releases`;
  const dmg = `${base}/download/${f.tag}/${f.file}`; const sums = `${base}/download/${f.tag}/SHA256SUMS`;
  const mac = lang === 'en'
    ? `Download **[RecordStuff ${f.version} for macOS Apple silicon (arm64)](${dmg})** (${bytes(f.size)} bytes). [Release notes](${base}/tag/${f.tag}) · [SHA256SUMS](${sums}) · [Latest release](${base}/latest).\n\nSHA-256: \`${f.sha256}\`.`
    : `下載 **[RecordStuff ${f.version}：macOS Apple silicon（arm64）](${dmg})**（${bytes(f.size)} bytes）。[英文發行說明](${base}/tag/${f.tag}) · [SHA256SUMS](${sums}) · [最新版本](${base}/latest)。\n\nSHA-256：\`${f.sha256}\`。`;
  if (!f.windows) return mac;
  const exe = `${base}/download/${f.tag}/${f.windows.file}`;
  return `${mac}\n\n${lang === 'en'
    ? `Windows: **[RecordStuff ${f.version} for Windows x64](${exe})** (${bytes(f.windows.size)} bytes), unsigned and built by CI; capture has not been verified on Windows hardware.\n\nSHA-256: \`${f.windows.sha256}\`.`
    : `Windows：**[RecordStuff ${f.version}：Windows x64](${exe})**（${bytes(f.windows.size)} bytes），未簽章、由 CI 建置；錄影尚未在 Windows 實機上驗證。\n\nSHA-256：\`${f.windows.sha256}\`。`}`;
}
/** Verification record skeleton: the facts CI knows, plus the sections a human must fill or leave marked as not recorded. */
export function renderVerificationRecord(lang: 'en' | 'zh-TW', f: ReleaseFacts): string {
  const release = `https://github.com/${f.repository}/releases/tag/${f.tag}`;
  const w = f.windows;
  if (lang === 'en') return `# ${w ? 'macOS and Windows' : 'macOS'} ${f.version} release verification

[English](${f.version}.md) | [繁體中文](../../zh-TW/verification/releases/${f.version}.md)

${f.date}: published from tag \`${f.tag}\` by the tag-triggered workflow. This record was generated by the workflow's record job from release metadata; the sections marked "fill in" are the maintainer's evidence and stay honest about what was and was not checked.

## Public release

[Workflow run](${f.runUrl}) built, signed, verified, published and re-verified the anonymous public download. Source commit \`${f.sourceCommit}\`. The [release](${release}) is public and was published at ${f.publishedAt}.

- File: \`${f.file}\`
- Size: ${bytes(f.size)} bytes
- SHA-256: \`${f.sha256}\`
${w ? `
Windows x64, unsigned; CI installed, checked and uninstalled it on a Windows runner, which proves no capture behaviour:

- File: \`${w.file}\`
- Size: ${bytes(w.size)} bytes
- SHA-256: \`${w.sha256}\`
` : ''}
## Local acceptance before tagging — fill in

State what was run on the tagged source before pushing the tag (\`pnpm start:app\`, recording length, playback, permission behavior, \`pnpm verify\` result). If nothing was run, say so.

## Not recorded

List checks that were not performed for this version.
`;
  return `# ${w ? 'macOS 與 Windows' : 'macOS'} ${f.version} 發布驗證

[English](../../../verification/releases/${f.version}.md) | [繁體中文](${f.version}.md)

${f.date}：由 tag 觸發的 workflow 從 \`${f.tag}\` 公開。本紀錄由 workflow 的 record job 依 release metadata 產生；標示「待填」的段落是維護者的證據，如實記錄做過與沒做過的檢查。

## 公開發布

[Workflow run](${f.runUrl}) 建置、簽署、驗證、公開並重驗匿名公開下載。source commit \`${f.sourceCommit}\`。[Release](${release}) 為公開，發布時間 ${f.publishedAt}。

- 檔案：\`${f.file}\`
- 大小：${bytes(f.size)} bytes
- SHA-256：\`${f.sha256}\`
${w ? `
Windows x64，未簽章；CI 在 Windows runner 上安裝、檢查並解除安裝，這不證明任何錄影行為：

- 檔案：\`${w.file}\`
- 大小：${bytes(w.size)} bytes
- SHA-256：\`${w.sha256}\`
` : ''}
## 打 tag 前的本機驗收 — 待填

寫明推送 tag 前在該原始碼上做了什麼（\`pnpm start:app\`、錄影長度、播放、權限行為、\`pnpm verify\` 結果）。若沒有做，照實寫。

## 未記錄

列出本版未執行的檢查。
`;
}
const root = fileURLToPath(new URL('..', import.meta.url));
/** Why a command failed: a spawn error, else its stderr, else how it exited; never an empty reason. */
export function failureReason(r: { error?: Error; stderr?: string | null; status: number | null; signal: NodeJS.Signals | null }): string {
  return r.error?.message ?? (r.stderr?.trim() || (r.signal ? `killed by ${r.signal}` : `exit status ${r.status}`));
}
function run(command: string, args: string[], input?: string) {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`${command} ${args[0]} failed: ${failureReason(r)}`);
  return r.stdout.trim();
}
/** pnpm is a `.cmd` shim on Windows, which Node starts only through a shell; the arguments are fixed. */
function pnpmVersion(): string {
  const r = spawnSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.error || r.status !== 0) throw new Error(`pnpm --version failed: ${failureReason(r)}`);
  return r.stdout.trim();
}
function api(endpoint: string, method = 'GET', payload?: unknown) {
  return JSON.parse(run('gh', ['api', endpoint, '--method', method, ...(payload ? ['--input', '-'] : [])], payload ? JSON.stringify(payload) : undefined));
}
/** Streams the file: a DMG is hashed without holding it in memory. */
async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
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
  return `RecordStuff ${version} for Apple silicon Macs (arm64)${carriesWindows(version) ? ' and Windows x64' : ''}.

## macOS

Install: open the DMG and drag RecordStuff onto the Applications folder, then eject the disk image. The DMG contains only the app and an Applications shortcut; the guides below are the installation documentation.

The app is self-signed and not notarized by Apple. If blocked after installing or updating, manually open System Settings → Privacy & Security, scroll down to Security, find RecordStuff and click Open Anyway. Done only dismisses the warning. Recipients do not install certificates. Then allow Screen & System Audio Recording and relaunch when macOS asks.

Update manually: stop recording, quit RecordStuff from its menu, download the new DMG and drag the app into Applications, replacing the existing copy. The signing identity is unchanged, so settings and permissions carry over. Use Check for updates… in Settings → General to find new releases; the optional launch check runs at most once per 24 hours. Downloads and installation remain manual.

Remove: quit the app and move RecordStuff.app from Applications to the Trash. Recordings, settings and logs stay on disk; the guide explains optional cleanup.

Guides: [Website Help](https://record.ericts.com/help) · [English](${base}/INSTALL.md) · [Traditional Chinese](${base}/INSTALL.zh-TW.md).

${carriesWindows(version) ? `
## Windows

Not verified on Windows hardware: CI builds this installer, installs it silently on a Windows runner, checks its version, architecture and files, and removes it again, but screen capture, system audio, notifications and the tray have not been tried on a Windows PC. Some wording still assumes macOS.

Install: run ${expectedWindowsInstallerName(version)}. It installs for the current user without an administrator prompt and adds a Start-menu shortcut. The installer is not code-signed, as its name says: if SmartScreen shows "Windows protected your PC", click More info → Run anyway.

Update manually: quit RecordStuff from its tray menu, then run the new installer; settings and recordings carry over. Check for updates… in Settings → General finds new releases.

Remove: Settings → Apps → Installed apps → RecordStuff → Uninstall. Recordings in Videos\\RecordStuff, settings and logs stay on disk.

## Verify
` : '\n'}
Verify the download using SHA256SUMS${carriesWindows(version) ? ' (on Windows, compare `Get-FileHash` output with its line)' : ''}. release.json records the source commit, version, platform, size, and signing certificate fingerprint${carriesWindows(version) ? `; ${WINDOWS_RECORD} records the same facts for the installer, which also carries a GitHub build-provenance attestation (\`gh attestation verify <file> --repo ${repository}\`)` : ''}.
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
async function verifyDmg(directory: string, tag: string, c: ReleaseContext = context(tag)) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Release verification requires macOS arm64.');
  const file = expectedDmgName(c.version);
  const dmg = path.join(directory, file);
  if (!existsSync(dmg) || !statSync(dmg).isFile()) throw new Error(`Missing DMG: ${file}.`);
  run('hdiutil', ['verify', dmg]);
  const mount = mkdtempSync(path.join(tmpdir(), 'recordstuff-release-mount-'));
  let attached = false;
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg]);
    attached = true;
    assertDmgContents(mount);
    const applications = path.join(mount, 'Applications');
    if (!lstatSync(applications).isSymbolicLink() || readlinkSync(applications) !== '/Applications') throw new Error('Invalid Applications link.');
    const app = path.join(mount, 'RecordStuff.app');
    if (run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]) !== c.version) throw new Error('Packaged App version mismatch.');
    if (run('lipo', ['-archs', path.join(app, 'Contents/MacOS/RecordStuff')]) !== 'arm64') throw new Error('Packaged App architecture mismatch.');
    const check = spawnSync(process.execPath, [path.join(root, 'scripts/start-app.mjs'), '--verify-app', app], {
      cwd: root, encoding: 'utf8', env: { ...process.env, RECORDSTUFF_SIGN_IDENTITY: signingSHA1 },
    });
    if (check.error || check.status !== 0) throw new Error(`App signature/identity verification failed: ${failureReason(check)}`);
    return { ...c, platform: 'darwin-arm64', file, size: statSync(dmg).size, sha256: await digest(dmg),
      signingCertificateSHA1: signingSHA1, appAsarSHA256: await digest(path.join(app, 'Contents/Resources/app.asar')) };
  } finally {
    releaseMount(mount, attached, args => run('hdiutil', args));
  }
}
/**
 * Never throws, so a cleanup problem cannot replace the verification result.
 * A busy volume gets one forced detach; the mount point is removed only once
 * nothing is mounted on it, and never recursively, which would walk into a
 * still-mounted read-only image and fail with EROFS.
 */
export function releaseMount(mount: string, attached: boolean, hdiutil: (args: string[]) => void, remove: (dir: string) => void = rmdirSync) {
  const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
  let detached = !attached;
  for (const args of attached ? [['detach', mount], ['detach', '-force', mount]] : []) {
    try { hdiutil(args); detached = true; break; }
    catch (cause) { console.error(`hdiutil ${args.join(' ')} failed: ${message(cause)}`); }
  }
  if (!detached) { console.error(`${mount} is still mounted; leaving the mount point in place`); return; }
  try { remove(mount); }
  catch (cause) { console.error(`could not remove mount point ${mount}: ${message(cause)}`); }
}
/** IMAGE_FILE_MACHINE_AMD64: the only Windows architecture published (design decisions). */
export const PE_MACHINE_X64 = 0x8664;
/** The COFF machine type of a PE image from its first bytes; throws for anything that is not a PE file. */
export function peMachine(head: Buffer): number {
  if (head.length < 0x40 || head.toString('latin1', 0, 2) !== 'MZ') throw new Error('Not a PE image (no MZ header).');
  const at = head.readUInt32LE(0x3c);
  if (at + 6 > head.length || head.toString('latin1', at, at + 4) !== 'PE\0\0') throw new Error('Not a PE image (no PE signature).');
  return head.readUInt16LE(at + 4);
}
function readHead(file: string, length = 4096): Buffer {
  const fd = openSync(file, 'r');
  try { const head = Buffer.alloc(length); return head.subarray(0, readSync(fd, head, 0, length, 0)); }
  finally { closeSync(fd); }
}
/** A Windows version resource holds four numbers, so `1.2.0` is stamped `1.2.0.0`; a pre-release may keep its own text. */
export function windowsVersionMatches(resource: string, version: string): boolean {
  return resource === version || resource === `${version.split(/[-+]/)[0]}.0`;
}
/** The uninstall registration NSIS writes for a per-user install. */
export interface UninstallEntry { DisplayName: string; DisplayVersion: string; QuietUninstallString: string; InstallLocation?: string }
/** `"C:\…\Uninstall RecordStuff.exe" /currentuser /S` → the executable and its arguments. */
export function splitCommandLine(line: string): [string, string[]] {
  const match = /^\s*"([^"]+)"\s*(.*)$/.exec(line) ?? /^\s*(\S+)\s*(.*)$/.exec(line);
  if (!match) throw new Error(`Cannot parse uninstall command ${JSON.stringify(line)}.`);
  return [match[1]!, match[2]!.split(/\s+/).filter(Boolean)];
}
/** The RecordStuff entries under HKCU (per-user) or HKLM (machine-wide) Uninstall keys. */
function uninstallEntries(hive: 'HKCU' | 'HKLM'): UninstallEntry[] {
  const out = powershell(`$e = @(Get-ItemProperty -Path '${hive}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'RecordStuff*' } | Select-Object DisplayName, DisplayVersion, QuietUninstallString, InstallLocation); ConvertTo-Json -InputObject $e -Compress`);
  return out ? JSON.parse(out) as UninstallEntry[] : [];
}
function powershell(script: string): string {
  // Windows PowerShell 5.1 cannot load its own modules with the PSModulePath a
  // PowerShell 7 parent (the runner's default shell) leaves behind.
  const { PSModulePath: _inherited, ...env } = process.env;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { cwd: root, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`powershell.exe failed: ${failureReason(r)}`);
  return r.stdout.trim();
}
const quotePs = (value: string) => `'${value.replaceAll("'", "''")}'`;
function authenticodeStatus(file: string): string {
  return powershell(`(Get-AuthenticodeSignature -LiteralPath ${quotePs(file)}).Status.ToString()`);
}
async function waitFor(what: string, done: () => boolean, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms / 1000} s waiting until ${what}.`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
const TRAY_ICONS = ['idle', 'busy', 'countdown', 'recording', 'warning'].map(state => `tray-${state}.ico`);
/**
 * Installs the unsigned per-user installer silently on this Windows machine,
 * checks what it installed and registered, and uninstalls it again. CI's
 * runner is disposable; a machine with RecordStuff already installed is refused
 * rather than overwritten. Nothing here starts the app, so it proves no capture.
 */
export async function verifyWindowsInstaller(directory: string, version: string) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows installer verification requires Windows x64.');
  const file = expectedWindowsInstallerName(version);
  const installer = path.join(directory, file);
  if (!existsSync(installer) || !statSync(installer).isFile()) throw new Error(`Missing Windows installer: ${file}.`);
  peMachine(readHead(installer)); // NSIS installers are 32-bit stubs; only the installed app must be x64.
  if (authenticodeStatus(installer) !== 'NotSigned') throw new Error(`The installer is expected to be unsigned, but its Authenticode status is ${authenticodeStatus(installer)}.`);
  if (uninstallEntries('HKCU').length || uninstallEntries('HKLM').length) throw new Error('RecordStuff is already installed on this machine; verify on a clean runner.');
  const shortcut = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'RecordStuff.lnk');
  const installed = spawnSync(installer, ['/S'], { encoding: 'utf8', timeout: 180_000 });
  if (installed.error || installed.status !== 0) throw new Error(`Silent install failed: ${failureReason(installed)}`);
  // Per user means HKCU only: an HKLM entry would have needed an administrator.
  if (uninstallEntries('HKLM').length) throw new Error('The installer registered a machine-wide uninstaller.');
  const [entry, ...extra] = uninstallEntries('HKCU');
  if (!entry || extra.length) throw new Error(`Expected one per-user uninstall entry, found ${extra.length + (entry ? 1 : 0)}.`);
  console.log(`Installed: ${JSON.stringify(entry)}`);
  if (entry.DisplayVersion !== version) throw new Error(`Registered version ${entry.DisplayVersion} differs from ${version}.`);
  const [uninstaller, uninstallArgs] = splitCommandLine(entry.QuietUninstallString);
  const location = entry.InstallLocation || path.dirname(uninstaller);
  let removed = false;
  try {
    const exe = path.join(location, 'RecordStuff.exe');
    if (!existsSync(exe)) throw new Error(`The install has no RecordStuff.exe in ${location}.`);
    if (peMachine(readHead(exe)) !== PE_MACHINE_X64) throw new Error('RecordStuff.exe is not an x64 executable.');
    const productVersion = powershell(`(Get-Item -LiteralPath ${quotePs(exe)}).VersionInfo.ProductVersion`);
    if (!windowsVersionMatches(productVersion, version)) throw new Error(`RecordStuff.exe product version ${productVersion} differs from ${version}.`);
    const signature = authenticodeStatus(exe);
    if (signature !== 'NotSigned') throw new Error(`RecordStuff.exe is expected to be unsigned, but its Authenticode status is ${signature}.`);
    const resources = path.join(location, 'resources');
    const missing = TRAY_ICONS.filter(name => !existsSync(path.join(resources, name)));
    if (missing.length) throw new Error(`The install lacks the tray icons ${missing.join(', ')}.`);
    if (!existsSync(shortcut)) throw new Error(`The install created no Start-menu shortcut at ${shortcut}; Windows notifications need it.`);
    const appAsarSHA256 = await digest(path.join(resources, 'app.asar'));
    const uninstalled = spawnSync(uninstaller, uninstallArgs, { encoding: 'utf8', timeout: 180_000 });
    if (uninstalled.error || uninstalled.status !== 0) throw new Error(`Silent uninstall failed: ${failureReason(uninstalled)}`);
    removed = true;
    // The NSIS uninstaller copies itself away and may return before it has finished.
    await waitFor('the uninstaller removed the app, its shortcut and its registration',
      () => !existsSync(exe) && !existsSync(shortcut) && uninstallEntries('HKCU').length === 0);
    return { platform: WINDOWS_PLATFORM, file, size: statSync(installer).size, sha256: await digest(installer), appAsarSHA256, signature: 'unsigned' as const };
  } finally {
    if (!removed) {
      const cleanup = spawnSync(uninstaller, uninstallArgs, { encoding: 'utf8', timeout: 180_000 });
      if (cleanup.error || cleanup.status !== 0) console.error(`Cleanup uninstall failed: ${failureReason(cleanup)}`);
    }
  }
}
/** The Windows record beside the installer, checked against the release and the installer's bytes. */
async function verifyWindowsCandidate(directory: string, c: { tag: string; version: string; repository: string; sourceCommit: string }) {
  const record = JSON.parse(readFileSync(path.join(directory, WINDOWS_RECORD), 'utf8')) as WindowsReleaseJson;
  assertWindowsRecord(record, c);
  const installer = path.join(directory, record.file);
  if (!existsSync(installer)) throw new Error(`Missing Windows installer: ${record.file}.`);
  if (statSync(installer).size !== record.size) throw new Error(`${record.file} has ${statSync(installer).size} bytes; ${WINDOWS_RECORD} records ${record.size}.`);
  if (await digest(installer) !== record.sha256) throw new Error(`${record.file} differs from the SHA-256 in ${WINDOWS_RECORD}.`);
  return record;
}
/** One `<sha256>  <file>` line per binary asset, so `shasum -a 256 -c` checks them all. */
export function sha256sums(entries: { file: string; sha256: string }[]): string {
  return entries.map(e => `${e.sha256}  ${e.file}\n`).join('');
}
function assertSums(directory: string, entries: { file: string; sha256: string }[]) {
  if (readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8') !== sha256sums(entries)) throw new Error('SHA256SUMS mismatch.');
}
/** The macOS candidate: the DMG's gates and its release.json. SHA256SUMS is checked by the caller, which knows the asset set. */
async function verifyCandidate(directory: string, tag: string, c: ReleaseContext = context(tag)) {
  const metadata = JSON.parse(readFileSync(path.join(directory, 'release.json'), 'utf8'));
  const actual = await verifyDmg(directory, tag, c);
  for (const [key, value] of Object.entries(actual)) {
    if (metadata[key] !== value) throw new Error(`Candidate metadata mismatch: ${key}`);
  }
  return actual;
}
async function main() {
  const [mode, tag, directoryArg] = process.argv.slice(2);
  const packageJsonPath = path.join(root, 'package.json');
  const packageVersion = () => JSON.parse(readFileSync(packageJsonPath, 'utf8')).version as string;
  if (mode === 'windows-smoke') {
    // CI on any branch: the installer `pnpm dist:win` just built for package.json's version; the argument is its directory.
    const facts = await verifyWindowsInstaller(path.resolve(tag ?? 'dist'), packageVersion());
    // The same record fields candidate-windows writes, so a branch run exercises them too.
    console.log(`Windows installer passed install, inspection and uninstall: ${JSON.stringify({ ...facts, node: process.versions.node, pnpm: pnpmVersion() })}`);
    return;
  }
  const modes = ['preflight', 'version', 'candidate', 'candidate-windows', 'verify', 'publish', 'published', 'published-windows', 'record', 'assets'];
  if (!tag || !modes.includes(mode ?? '')) throw new Error(`Usage: release.mts ${modes.join('|')} vX.Y.Z [directory], or windows-smoke [directory]`);
  if (mode === 'assets') {
    // The public assets of `tag`, one per line, for the workflow's anonymous download.
    const version = tag.replace(/^v/, '');
    validateTag(tag, version);
    console.log(expectedAssetNames(version).join('\n'));
    return;
  }
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
    const runUrl = process.env.RELEASE_RUN_URL ?? `https://github.com/${c.repository}/actions`;
    let facts: ReleaseFacts;
    let stable: { current: ReleaseManifest; manifest: ReleaseManifest; outcome: StablePointerOutcome } | undefined;
    if (isPrerelease(c.version)) {
      // Pre-releases get a historical record, never a stable download pointer.
      const release = api(`repos/${c.repository}/releases/tags/${tag}`) as PublishedRelease & { published_at: string; prerelease: boolean };
      const file = expectedDmgName(c.version);
      const asset = release.assets.find(a => a.name === file);
      if (release.draft || !release.prerelease || !asset || !asset.digest?.startsWith('sha256:')) throw new Error('Pre-release is not public or its DMG digest is unavailable.');
      let windows: InstallerFacts | undefined;
      if (carriesWindows(c.version)) {
        const name = expectedWindowsInstallerName(c.version);
        const installer = release.assets.find(a => a.name === name);
        if (!installer || !installer.digest?.startsWith('sha256:')) throw new Error('Pre-release has no Windows installer with a digest.');
        windows = { file: name, size: installer.size, sha256: installer.digest.slice('sha256:'.length) };
      }
      facts = { ...c, file, size: asset.size, sha256: asset.digest.slice('sha256:'.length), runUrl, publishedAt: release.published_at, date: release.published_at.slice(0, 10), windows };
    } else {
      // The committed pointer is read before the release is fetched, so an invalid one stops early.
      const current = readStableManifest(path.join(root, stableManifestPath));
      // Validate public release.json, checksums and assets once, then render every output.
      const manifest = await fetchManifest(tag);
      facts = releaseFactsFromManifest(manifest, runUrl);
      if (facts.sourceCommit !== c.sourceCommit) throw new Error('Published manifest source commit does not match the tag.');
      stable = { current, manifest, outcome: stablePointerOutcome(current, manifest) };
    }
    // Prepare all outputs before touching disk: invalid README markers or
    // unreadable inputs cannot leave an earlier output partially updated.
    // Only changed text is kept, so a retry that changes nothing writes nothing.
    const outputs = new Map<string, string>();
    const prepare = (rel: string, text: string) => {
      const file = path.join(root, rel);
      if (!existsSync(file) || readFileSync(file, 'utf8') !== text) outputs.set(rel, text);
    };
    for (const [rel, lang] of [['docs/verification/releases', 'en'], ['docs/zh-TW/verification/releases', 'zh-TW']] as const) {
      const target = `${rel}/${c.version}.md`;
      if (!existsSync(path.join(root, target))) prepare(target, renderVerificationRecord(lang, facts));
    }
    if (stable) {
      // package.json keeps its own rule: it follows the newest recorded stable version and never moves backward.
      if (compareVersions(packageVersion(), c.version) < 0) prepare('package.json', setPackageVersion(readFileSync(packageJsonPath, 'utf8'), c.version));
      // An equal retry keeps the committed manifest, including its verifiedAt.
      if (stable.outcome === 'promoted') prepare(stableManifestPath, `${JSON.stringify(stable.manifest, null, 2)}\n`);
      if (stable.outcome !== 'historical-only') {
        for (const [rel, lang] of [['README.md', 'en'], ['README.zh-TW.md', 'zh-TW']] as const) {
          prepare(rel, replaceMarked(readFileSync(path.join(root, rel), 'utf8'), 'release-download', renderDownloadSection(lang, facts)));
        }
      }
    }
    for (const [rel, text] of outputs) writeFileSync(path.join(root, rel), text);
    const changed = [...outputs.keys()];
    const outcome = !stable ? 'historical only: pre-releases never move the stable download pointers'
      : stable.outcome === 'promoted' ? `promoted: stable download pointers moved from ${stable.current.tag} to ${tag}`
      : stable.outcome === 'unchanged' ? `unchanged: ${tag} is already the stable release with the same facts`
      : `historical only: stable download pointers stay at the newer ${stable.current.tag}`;
    console.log(`Recorded ${tag} (${outcome}). ${changed.length ? `Wrote ${changed.join(', ')}.` : 'No file changed.'}`);
    return;
  }
  if (mode === 'published') {
    // Files downloaded anonymously from the public release URL, checked with the tooling of this checkout.
    if (!directoryArg) throw new Error('Downloaded-assets directory is required.');
    const published = contextFromTag(tag);
    const directory = path.resolve(directoryArg);
    const metadata = await verifyCandidate(directory, tag, published);
    // The Windows installer cannot be run here; its bytes, record and checksum line are checked, and published-windows runs it.
    const windows = carriesWindows(published.version) ? await verifyWindowsCandidate(directory, published) : undefined;
    assertSums(directory, windows ? [metadata, windows] : [metadata]);
    const release = api(`repos/${published.repository}/releases/tags/${tag}`) as PublishedRelease;
    // The binaries were just hashed; only the small files are hashed here.
    assertPublishedAssets(release, [
      { name: metadata.file, size: metadata.size, sha256: metadata.sha256 },
      ...(windows ? [{ name: windows.file, size: windows.size, sha256: windows.sha256 }] : []),
      ...await Promise.all(['SHA256SUMS', 'release.json', ...(windows ? [WINDOWS_RECORD] : [])].map(async name => {
        const local = path.join(directory, name);
        return { name, size: statSync(local).size, sha256: await digest(local) };
      })),
    ]);
    console.log(`Published ${tag} (${published.sourceCommit}) matches the verified bytes: ${metadata.sha256}${windows ? `, ${windows.sha256}` : ''}`);
    return;
  }
  if (mode === 'published-windows') {
    // On Windows: the anonymously downloaded installer is installed, inspected and removed again.
    if (!directoryArg) throw new Error('Downloaded-assets directory is required.');
    const published = contextFromTag(tag);
    if (!carriesWindows(published.version)) { console.log(`${tag} was published for macOS only; nothing to verify on Windows.`); return; }
    const directory = path.resolve(directoryArg);
    const record = await verifyWindowsCandidate(directory, published);
    if (!readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').split(/\r?\n/).includes(`${record.sha256}  ${record.file}`)) throw new Error(`SHA256SUMS does not list ${record.file} with its recorded SHA-256.`);
    const release = api(`repos/${published.repository}/releases/tags/${tag}`) as PublishedRelease;
    const asset = release.assets.find(a => a.name === record.file);
    if (release.draft || !asset || asset.size !== record.size || asset.digest !== `sha256:${record.sha256}`) throw new Error(`Published ${record.file} does not match its record.`);
    const facts = await verifyWindowsInstaller(directory, published.version);
    if (facts.appAsarSHA256 !== record.appAsarSHA256) throw new Error('The installed app.asar differs from the one recorded at build time.');
    console.log(`Published Windows installer for ${tag} installs, matches its record and uninstalls: ${record.sha256}`);
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
    const metadata = await verifyDmg(directory, tag, c);
    writeFileSync(path.join(directory, 'release.json'), `${JSON.stringify({ ...metadata, node: process.versions.node, pnpm: pnpmVersion() }, null, 2)}\n`);
    // The macOS build's own list; publish rewrites it with every binary asset.
    writeFileSync(path.join(directory, 'SHA256SUMS'), sha256sums([metadata]));
    console.log(JSON.stringify(metadata));
    return;
  }
  if (mode === 'candidate-windows') {
    const facts = await verifyWindowsInstaller(directory, c.version);
    const record = { tag: c.tag, version: c.version, sourceCommit: c.sourceCommit, repository: c.repository, ...facts,
      node: process.versions.node, pnpm: pnpmVersion() };
    assertWindowsRecord(record, c);
    writeFileSync(path.join(directory, WINDOWS_RECORD), `${JSON.stringify(record, null, 2)}\n`);
    console.log(JSON.stringify(record));
    return;
  }
  const metadata = await verifyCandidate(directory, tag, c);
  assertSums(directory, [metadata]);
  if (mode === 'verify') { console.log(`Verified ${metadata.file}: ${metadata.sha256}`); return; }
  // Every version after the last macOS-only one ships both platforms or nothing.
  const windows = carriesWindows(c.version) ? await verifyWindowsCandidate(directory, c) : undefined;
  if (windows) writeFileSync(path.join(directory, 'SHA256SUMS'), sha256sums([metadata, windows]));
  // publish: the tag already exists (pushed by the maintainer); the release must not.
  // One listing answers both "not yet released" and where latest must point.
  const existing = releases(c.repository);
  assertUnreleased(existing, tag);
  if (api(`repos/${c.repository}/commits/${tag}`).sha !== c.sourceCommit) throw new Error('Tag does not point to the verified source commit.');
  const body = path.join(directory, 'release-notes.md');
  writeFileSync(body, notes(c.version, c.repository, c.sourceCommit));
  const flag = latestFlag(c.version, existing);
  run('gh', ['release', 'create', tag, '--repo', c.repository, '--verify-tag', flag,
    '--title', `RecordStuff ${c.version} — macOS arm64${windows ? ' and Windows x64' : ''}`, '--notes-file', body,
    ...[metadata.file, 'SHA256SUMS', 'release.json', ...(windows ? [windows.file, WINDOWS_RECORD] : [])].map(f => path.join(directory, f))]);
  const as = { '--prerelease': ' as a pre-release', '--latest': ' as latest', '--latest=false': ' without moving latest' }[flag];
  console.log(`Published ${tag}${as} from verified candidates ${metadata.sha256}${windows ? ` and ${windows.sha256}` : ''}.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
