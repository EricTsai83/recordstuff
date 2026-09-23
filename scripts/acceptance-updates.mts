/** Packaged handler/model integration + optional real capture. Native Tray clicks are explicitly not claimed. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { prepareUpdateAcceptance, acceptanceExitCode, safeCaptureShortcut, createAcceptanceOutput, type CaseResult } from './lib/update-acceptance.mts';
import { acceleratorToKeystroke, keystrokeScript, materialOpenArgs } from './lib/acceptance.mts';
import { hasTool } from './lib/media-tools.mts';
import { readLogPairs, verifyRecording } from './lib/verify-recording.mts';
import type { AcceptanceSnapshot, AcceptanceConfig, Scenario } from './fixtures/update-acceptance';
import type { TrayMenuItem } from '../src/main/tray-model';
import type { AppAction } from '../src/main/ui-model';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DAY = 86_400_000;
const { values } = parseArgs({ args: process.argv.slice(2).filter(a => a !== '--'), options: {
  full: { type: 'boolean', default: false },
  'logic-only': { type: 'boolean', default: false }, out: { type: 'string' },
  'require-native-ui': { type: 'boolean', default: false },
} });
const parent = path.join(ROOT, 'docs/verification/measurements');
fs.mkdirSync(parent, { recursive: true });
const dir = values.out ? path.resolve(values.out) : fs.mkdtempSync(path.join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-updates-`));
if (values.out) {
  try { createAcceptanceOutput(dir); } // Never reuse/overwrite evidence from another run.
  catch (error) { console.error(`Cannot create new acceptance output directory ${dir}: ${String(error)}`); process.exit(2); }
}
const workspace = path.join(dir, 'workspace');
const cases: CaseResult[] = [];
const feedScenarios: Scenario[] = values.full
  ? ['older', 'http-fallback', 'malformed', 'prerelease', 'architecture', 'offline', 'timeout', 'current']
  : ['http-fallback', 'offline', 'current'];
const feedCase = values.full ? 'version filters, fallback, failure and recovery' : 'fallback, failure and recovery';
const requiredCases = ['preflight and isolation', 'build, sign, launch and initial check', 'manual checking, overlap and timestamp', feedCase, 'newer version and intercepted download action', 'language and preference survive real process restart', 'launch rate limit and due launch failure', ...(!values['logic-only'] ? ['real recording: deferred check and deferred result'] : []), 'shutdown cancels pending check'];
const protectedFiles = [path.join(ROOT, 'src/main/index.ts'), path.join(ROOT, 'package.json'), path.join(os.homedir(), 'Library/Application Support/recordstuff/settings.json')];
let config: AcceptanceConfig = { now: Date.now(), scenario: 'current' };
let sequence = 0, appMayBeRunning = false, cancelled = false;
let materialProfile: string | undefined;
let child: ReturnType<typeof spawn> | undefined;
const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };
delete env.ELECTRON_RUN_AS_NODE;
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const hash = (p: string): string => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const beforeHashes = protectedFiles.map(file => fs.existsSync(file) ? hash(file) : null);
class Blocked extends Error {}
function record(name: string, status: CaseResult['status'], detail: string, required = true): void {
  cases.push({ name, status, detail, required });
  console.log(`${status}: ${name} — ${detail}`);
}
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { if (cancelled) throw new Blocked('run interrupted'); await fn(); record(name, 'pass', 'Assertions passed; snapshots/events are retained.'); }
  catch (error) { record(name, error instanceof Blocked ? 'blocked' : 'fail', String(error)); throw error; }
}
async function wait<T>(read: () => Promise<T | undefined>, label: string, timeout = 30_000, cleanup = false): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (cancelled && !cleanup) throw new Blocked('run interrupted');
    const result = await read(); if (result !== undefined) return result;
    await pause(75);
  }
  throw new Error(`Timed out waiting for ${label} (${timeout} ms)`);
}
async function command(command: object, cleanup = false): Promise<AcceptanceSnapshot> {
  const name = `${++sequence}.json`, file = path.join(dir, 'requests', name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(command)); fs.renameSync(file + '.tmp', file);
  return wait(async () => {
    const response = path.join(dir, 'responses', name);
    if (!fs.existsSync(response)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(response, 'utf8')) as { ok: boolean; snapshot: AcceptanceSnapshot; error?: string };
    if (!parsed.ok) throw new Error(parsed.error);
    if ((command as { kind?: string }).kind !== 'quit') assert.deepEqual(parsed.snapshot.errors, []);
    return parsed.snapshot;
  }, `fixture command ${JSON.stringify(command)}`, 30_000, cleanup);
}
const snapshot = (): Promise<AcceptanceSnapshot> => command({ kind: 'snapshot' });
async function until(predicate: (s: AcceptanceSnapshot) => boolean, label: string, timeout = 30_000): Promise<AcceptanceSnapshot> {
  return wait(async () => { const s = await snapshot(); return predicate(s) ? s : undefined; }, label, timeout);
}
const action = (action: AppAction): Promise<AcceptanceSnapshot> => command({ kind: 'action', action });
async function scenario(scenario: Scenario, advance = 0): Promise<void> {
  config = { scenario, now: config.now + advance }; await command({ kind: 'configure', config });
}
function settingsChoice(s: AcceptanceSnapshot, group: string): { id: string; label: string } {
  const found = s.settings.groups.find(g => g.id === group);
  const checked = found?.choices.find(c => c.checked);
  assert(found && checked, `Settings group missing or unset: ${group}`);
  return { id: checked.id, label: checked.label };
}
function menuAction(s: AcceptanceSnapshot, action: AppAction): Exclude<TrayMenuItem, { kind: 'separator' }> {
  if (action === 'checkUpdates' || action === 'openUpdate') {
    const group = s.settings.groups.find(g => g.id === 'updates');
    const choice = group?.choices.find(c => c.id === (action === 'checkUpdates' ? 'check' : 'open'));
    assert(group && choice, `Settings update action missing: ${action}`);
    return { kind: 'item', action, label: choice.label, enabled: group.enabled && choice.enabled };
  }
  const item = s.model.menu.find(i => i.kind === 'item' && JSON.stringify(i.action) === JSON.stringify(action));
  assert(item && item.kind === 'item', `Menu action missing: ${JSON.stringify(action)}`);
  return item;
}
function assertNoUpdateActions(s: AcceptanceSnapshot): void {
  assert.equal(menuAction(s, 'checkUpdates').enabled, false);
  assert.equal(s.model.title, 'REC');
  const entries = s.model.menu.filter(i => i.kind !== 'separator');
  assert.equal(entries[1]?.kind === 'item' && entries[1].action, 'stop');
  assert(!JSON.stringify(s.model.menu).includes('Update available:'));
  // Recording locks every preference in the panel except the language.
  for (const group of s.settings.groups) assert.equal(group.enabled, group.id === 'language', `settings group ${group.id}`);
}
async function run(program: string, args: string[], cwd: string, label: string, timeout = 300_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const fd = fs.openSync(path.join(dir, `${label}.log`), 'a');
    const proc = child = spawn(program, args, { cwd, env, stdio: ['ignore', fd, fd], detached: true });
    fs.closeSync(fd);
    const timer = setTimeout(() => { try { if (proc.pid) process.kill(-proc.pid, 'SIGTERM'); } catch {} reject(new Error(`${label} timed out`)); }, timeout);
    proc.on('error', error => { clearTimeout(timer); child = undefined; reject(error); });
    proc.on('exit', code => { clearTimeout(timer); child = undefined; code === 0 ? resolve() : reject(new Error(`${label} exited ${code}; see ${label}.log`)); });
  });
}
async function start(build: boolean): Promise<void> {
  for (const file of ['ready.json', 'stopped.json']) fs.rmSync(path.join(dir, file), { force: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  appMayBeRunning = true; // Also cover open succeeding just before its parent times out.
  await run('pnpm', [build ? 'start:app' : 'open:app'], workspace, build ? 'build' : `reopen-${sequence}`);
  await wait(async () => fs.existsSync(path.join(dir, 'ready.json')) ? true : undefined, 'fixture ready');
  const s = await snapshot();
  assert.equal(s.recording.type === 'idle' || s.recording.type === 'needsPermission', true);
}
async function stop(cleanup = false): Promise<void> {
  if (!appMayBeRunning) return;
  // Production app.quit waits for Recorder.shutdown and saves a recording before exiting.
  if (fs.existsSync(path.join(dir, 'ready.json'))) {
    await command({ kind: 'quit' }, cleanup);
    await wait(async () => fs.existsSync(path.join(dir, 'stopped.json')) ? true : undefined, 'saved shutdown', 30_000, cleanup);
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'stopped.json'), 'utf8')) as AcceptanceSnapshot;
    assert(s.recording.type === 'idle' || s.recording.type === 'needsPermission', 'shutdown did not settle');
    await wait(async () => {
      try { process.kill(s.pid, 0); return undefined; } catch { return true; }
    }, 'owned fixture process exit', 30_000, cleanup);
  } else {
    // A failed build can be cleaned only after confirming no fixture executable exists.
    const r = spawnSync('pgrep', ['-f', path.join(workspace, 'dist/mac-arm64/RecordStuff.app/Contents/MacOS/RecordStuff')], { encoding: 'utf8' });
    if (r.status !== 1) throw new Error('Fixture has no control endpoint; left intact for manual cleanup.');
  }
  appMayBeRunning = false;
}
async function restart(): Promise<void> { await stop(); await start(false); }
async function sendShortcut(): Promise<void> {
  const state = await snapshot();
  const running = spawnSync('pgrep', ['-f', '(^|/)RecordStuff\\.app/Contents/MacOS/RecordStuff($| )'], { encoding: 'utf8' });
  if (running.status !== 0) throw new Blocked('Cannot confirm ownership of the running recording shortcut.');
  let accelerator: string;
  try { accelerator = safeCaptureShortcut(state.pid, running.stdout.trim().split('\n').map(Number), state.hotkey); }
  catch (error) { throw new Blocked(String(error)); }
  const key = acceleratorToKeystroke(accelerator);
  if (!key) throw new Blocked(`Cannot type accelerator ${accelerator} through System Events.`);
  const r = spawnSync('osascript', ['-e', keystrokeScript(key)], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) throw new Blocked(`System Events shortcut unavailable: ${r.stderr || r.error}`);
}
async function closeMaterial(): Promise<void> {
  if (!materialProfile) return;
  // Unique profile path generated by this run; never kill the user's browser instances.
  const profile = materialProfile;
  const result = spawnSync('pkill', ['-f', profile]);
  if (result.status !== 0 && result.status !== 1) throw new Error('Cannot close the owned material browser');
  await wait(async () => spawnSync('pgrep', ['-f', profile]).status === 1 ? true : undefined, 'material browser exit', 10_000, true);
  fs.rmSync(profile, { recursive: true, force: true });
  materialProfile = undefined;
}
function report(): void {
  const exit = acceptanceExitCode(cases);
  const data = { exitCode: exit, mode: values.full ? 'full' : 'smoke', feedScenarios, scope: values['logic-only'] ? 'packaged handler/model integration only' : 'packaged handler/model integration + real shortcut capture', cases, workspaceRetained: appMayBeRunning };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'report.md'), ['# Update acceptance', '', `Result: ${exit === 0 ? 'PASS for the stated scope' : exit === 2 ? 'BLOCKED / INCOMPLETE' : 'FAIL'}`, '', `Mode: ${data.mode}; feed scenarios: ${feedScenarios.join(", ")}. Scope: ${data.scope}. Actions use the production handler and real tray context; shell.openExternal is intercepted. Saved notifications are intercepted in the fixture to keep capture material unobscured. This is not native mouse/Tray, notification or visual-browser acceptance.`, '', ...cases.map(c => `- **${c.status}** ${c.name}${c.required ? '' : ' (outside required scope)'}: ${c.detail}`), '', 'Evidence: report.json, build.log, requests/, responses/, events.jsonl, logs/, and recording-verify.json when capture ran.', '', `Fixture left running: ${appMayBeRunning}. Recordings and logs are retained. No user settings were changed; no network disconnect, publication or installation was performed.`, ''].join('\n'));
  process.exitCode = exit;
  console.log(`Report: ${path.join(dir, 'report.md')}`);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  cancelled = true;
  if (child?.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch {}
});

try {
  await check('preflight and isolation', async () => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Blocked('Packaged acceptance currently requires macOS arm64.');
    const running = spawnSync('pgrep', ['-f', '(^|/)RecordStuff\\.app/Contents/MacOS/RecordStuff($| )'], { encoding: 'utf8' });
    if (running.status !== 1) throw new Blocked(`Quit RecordStuff before acceptance; never interrupt a user recording. ${running.stdout || running.stderr}`);
    if (!values['logic-only'] && (!hasTool('ffmpeg') || !hasTool('ffprobe') || !fs.existsSync('/Applications/Google Chrome.app'))) throw new Blocked('Real capture requires Chrome, ffmpeg and ffprobe.');
    fs.mkdirSync(workspace);
    prepareUpdateAcceptance(ROOT, workspace, dir);
    fs.mkdirSync(path.join(dir, 'requests'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'responses'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(), platform: process.platform, arch: process.arch, os: os.release(), sourceMain: hash(path.join(ROOT, 'src/main/index.ts')), instrumentedMain: hash(path.join(workspace, 'src/main/index.ts')), fixture: hash(path.join(ROOT, 'scripts/fixtures/update-acceptance.ts')) }, null, 2));
  });
  await check('build, sign, launch and initial check', async () => {
    await start(true);
    const s = await until(s => s.update.kind === 'current', 'initial check');
    assert.equal(s.calls.length, 1); assert.equal(s.preference.lastAttempt, config.now);
    const appPath = path.join(workspace, 'dist/mac-arm64/RecordStuff.app');
    fs.writeFileSync(path.join(dir, 'artifact.json'), JSON.stringify({ appPath, asarSha256: hash(path.join(appPath, 'Contents/Resources/app.asar')) }, null, 2));
  });
  await check('manual checking, overlap and timestamp', async () => {
    await scenario('delayed', 1000); const before = (await snapshot()).calls.length;
    await action('checkUpdates'); const busy = await until(s => s.pending === 1, 'pending check');
    assert.equal(busy.update.kind, 'checking'); assert.equal(menuAction(busy, 'checkUpdates').enabled, false);
    await action('checkUpdates'); assert.equal((await snapshot()).calls.length, before + 1);
    await command({ kind: 'release' }); await until(s => s.update.kind === 'available', 'newer result');
    await scenario('current', 1000); await action('checkUpdates');
    const current = await until(s => s.update.kind === 'current', 'current version');
    assert.equal(current.update.kind === 'current' && current.update.checkedAt, config.now);
    assert(current.settings.groups.find(g => g.id === 'updates')?.note?.includes(new Date(config.now).toLocaleString('en')));
  });
  await check(feedCase, async () => {
    for (const name of feedScenarios) {
      await scenario(name); const before = await snapshot();
      await action('checkUpdates');
      const s = await until(s => s.update.kind !== 'checking', name, 25_000);
      const ok = ['older', 'http-fallback', 'current'].includes(name);
      assert.equal(s.update.kind, ok ? 'current' : 'failed');
      assert.equal(s.calls.length - before.calls.length, ['older', 'current'].includes(name) ? 1 : 2);
      if (name === 'timeout') assert.equal(s.aborted - before.aborted, 2);
      if (name === 'offline') {
        assert.equal(menuAction(s, 'openUpdate').enabled, true);
        await action('openUpdate');
        assert.deepEqual((await snapshot()).opened.slice(before.opened.length), ['https://github.com/EricTsai83/recordstuff/releases']);
      }
    }
  });
  await check('newer version and intercepted download action', async () => {
    await scenario('newer'); await action('checkUpdates');
    const s = await until(s => s.update.kind === 'available', 'available version');
    assert(menuAction(s, 'openUpdate').label.includes(s.update.kind === 'available' ? s.update.version : 'missing'));
    await action('openUpdate'); assert.deepEqual((await snapshot()).opened.slice(s.opened.length), ['https://record.ericts.com/download']);
  });
  await check('language and preference survive real process restart', async () => {
    await action({ setLanguage: 'zh-TW' }); await action({ setUpdateChecks: false });
    await scenario('current', DAY + 1); await restart();
    const s = await snapshot(); assert.equal(s.language, 'zh-TW'); assert.equal(s.preference.enabled, false); assert.equal(s.calls.length, 0);
    assert.equal(menuAction(s, 'checkUpdates').label, '檢查更新…');
    // The settings panel projects the same committed values, in the same language.
    assert.equal(s.settings.title, '設定');
    assert.equal(settingsChoice(s, 'language').label, '繁體中文');
    assert.equal(settingsChoice(s, 'updateChecks').id, 'off');
    await action('checkUpdates'); await until(s => s.update.kind === 'current', 'manual while preference off');
    await action({ setLanguage: 'en' }); await action({ setUpdateChecks: true });
    const restored = await snapshot();
    assert.equal(settingsChoice(restored, 'language').id, 'en');
    assert.equal(settingsChoice(restored, 'updateChecks').id, 'on');
  });
  await check('launch rate limit and due launch failure', async () => {
    await restart(); assert.equal((await snapshot()).calls.length, 0);
    await scenario('current', DAY + 1); await restart(); await until(s => s.update.kind === 'current', 'due launch');
    assert.equal((await snapshot()).calls.length, 1);
    await scenario('offline', DAY + 1); await restart();
    const s = await until(s => s.calls.length === 2 && s.update.kind === 'idle', 'silent failed launch');
    assert.equal(menuAction(s, 'checkUpdates').label, 'Check for updates…');
    await restart(); assert.equal((await snapshot()).calls.length, 0); // Failed attempts are rate-limited too.
  });
  if (!values['logic-only']) await check('real recording: deferred check and deferred result', async () => {
    const before = await snapshot();
    if (before.recording.type !== 'idle') throw new Blocked('Screen/system-audio permission unavailable; not reset or bypassed.');
    materialProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'recordstuff-update-material-'));
    const material = spawnSync('open', materialOpenArgs(path.join(ROOT, 'scripts/test-material.html'), materialProfile), { timeout: 10_000 });
    assert.equal(material.status, 0); await pause(5000);
    await scenario('delayed'); const count = (await snapshot()).calls.length;
    await sendShortcut(); await until(s => s.recording.type === 'recording', 'real recording started');
    await action('checkUpdates'); const deferred = await snapshot();
    assert.equal(deferred.calls.length, count); assertNoUpdateActions(deferred);
    await pause(10_000); await sendShortcut();
    await until(s => s.recording.type === 'idle' && s.pending === 1, 'save then deferred request');
    // A second recording starts with a request already in flight. Release the result while recording.
    await sendShortcut(); await until(s => s.recording.type === 'recording', 'second recording started');
    await command({ kind: 'release' }); await pause(250);
    const hidden = await snapshot(); assert.equal(hidden.update.kind, 'checking'); assertNoUpdateActions(hidden);
    await pause(10_000); await sendShortcut();
    const saved = await until(s => s.recording.type === 'idle' && s.update.kind === 'available', 'saved and update published');
    assert.equal(menuAction(saved, 'openUpdate').enabled, true);
    await closeMaterial();
    const recordings = fs.readdirSync(path.join(dir, 'recordings')).filter(f => f.endsWith('.mp4'));
    assert.equal(recordings.length, 2);
    const results = recordings.map(name => {
      const file = path.join(dir, 'recordings', name);
      const result = verifyRecording(file, readLogPairs(path.join(dir, 'logs/recordstuff.log')), { expectedDurationSeconds: 10, sync: true });
      return { file, result };
    });
    fs.writeFileSync(path.join(dir, 'recording-verify.json'), JSON.stringify(results, null, 2));
    for (const r of results) {
      assert.equal(r.result.checks.filter(c => c.verdict === 'fail').length, 0, `Media integrity failure: ${r.file}`);
      assert((r.result.measurement.sync?.pairs ?? 0) >= 5, `Test material not captured cleanly: ${path.basename(r.file)}, ${r.result.measurement.sync ? `${r.result.measurement.sync.pairs} matched flash/beep pairs` : 'fewer than 3 matched flash/beep pairs; no reliable sync statistics'} (at least 5 required; syncAttempted=${r.result.measurement.syncAttempted}).`);
    }
  });
  else record('real recording', 'not-run', 'Explicit --logic-only scope; no capture claim.', false);
  await check('shutdown cancels pending check', async () => {
    await scenario('delayed'); await action('checkUpdates'); await until(s => s.pending === 1, 'request before shutdown');
    // A sticky fixture error must not prevent observing a successful, graceful quit.
    await assert.rejects(command({ kind: 'expected-invalid-command' }), /unknown command/);
    await stop();
    const stopped = JSON.parse(fs.readFileSync(path.join(dir, 'stopped.json'), 'utf8')) as AcceptanceSnapshot;
    assert.deepEqual(stopped.errors, ['Error: unknown command'], 'Unexpected error during shutdown');
    assert(stopped.aborted >= 1); assert.equal(stopped.update.kind, 'checking');
  });
} catch (error) {
  console.error(String(error));
} finally {
  try { await stop(true); record('fixture shutdown', 'pass', 'Owned app exited; no running recording or user app was killed.'); }
  catch (error) { record('fixture shutdown', 'fail', `Left fixture intact: ${String(error)}`); }
  try { await closeMaterial(); } catch (error) { record('material cleanup', 'fail', String(error)); }
  if (!appMayBeRunning) fs.rmSync(workspace, { recursive: true, force: true });
  for (const name of requiredCases) if (!cases.some(c => c.name === name)) record(name, 'not-run', 'An earlier failure/blocked prerequisite prevented execution.');
  const afterHashes = protectedFiles.map(file => fs.existsSync(file) ? hash(file) : null);
  record('source and user settings unchanged', JSON.stringify(beforeHashes) === JSON.stringify(afterHashes) ? 'pass' : 'fail', 'Compared source index, package manifest and real user settings before/after.');
  record('native Tray clicks / visible browser / subjective listening', 'blocked', 'Not exercised by the handler/model driver. Computer Use windowless Tray access previously returned -10005; manual/native-driver evidence is separate.', values['require-native-ui']);
  report();
}
