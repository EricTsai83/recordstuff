import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { instrumentUpdateAcceptance, acceptanceExitCode, safeCaptureShortcut, createAcceptanceOutput, assertLockContract, type CaseResult, type LockSnapshot } from './update-acceptance.mts';
import { settingsView } from '../../src/main/settings-model';
import { trayModel } from '../../src/main/tray-model';
import type { AppContext } from '../../src/main/ui-model';
import type { UpdateState } from '../../src/main/updates';
import { DEFAULT_HOTKEY } from '../../src/shared/hotkey';
import { DEFAULT_QUALITY } from '../../src/shared/quality';
import type { RecordingState } from '../../src/shared/state';

describe('update acceptance boundary', () => {
  const source = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8');
  it('instruments the current application entry without adding controls to the original', () => {
    const instrumented = instrumentUpdateAcceptance(source, '/tmp/run with "quotes"');
    expect(instrumented).toContain('configureAcceptance("/tmp/run with \\"quotes\\"")');
    expect(instrumented).toContain('attachAcceptance(acceptance, { recorder, updates, settings, tray, handleAction })');
    expect(instrumented).toContain('now: acceptance.now');
    expect(instrumented).toContain('defaultOutputDir: acceptance.outputDir || defaultOutputDir()');
    expect(source).not.toContain('configureAcceptance');
    expect(fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8')).toBe(source);
  });
  it('fails closed when production wiring drifts or an anchor is duplicated', () => {
    expect(() => instrumentUpdateAcceptance(source.replace('localVersion: app.getVersion(), settled,', 'localVersion: "changed", settled,'), '/tmp/test')).toThrow('anchor changed');
    expect(() => instrumentUpdateAcceptance(source.replace('show: (savedPath, stoppedEarly) => tray.notifySaved(savedPath, stoppedEarly),', 'show: otherNotificationPath,'), '/tmp/test')).toThrow('anchor changed');
    expect(() => instrumentUpdateAcceptance(source + '\nlet currentLanguage: Language = DEFAULT_LANGUAGE;', '/tmp/test')).toThrow('anchor changed');
  });
  const c = (status: CaseResult['status'], required = true): CaseResult => ({ name: 'case', status, required, detail: '' });
  it('does not let missing, blocked or unexecuted required cases count as pass', () => {
    expect(acceptanceExitCode([])).toBe(2);
    expect(acceptanceExitCode([c('pass'), c('blocked')])).toBe(2);
    expect(acceptanceExitCode([c('pass'), c('not-run')])).toBe(2);
  });
  it('returns failure for a required failure even if other cases are blocked', () => {
    expect(acceptanceExitCode([c('blocked'), c('fail')])).toBe(1);
  });
  it('permits only explicitly scoped optional gaps', () => {
    expect(acceptanceExitCode([c('pass'), c('blocked', false)])).toBe(0);
    expect(acceptanceExitCode([c('blocked', false)])).toBe(2);
  });
});


describe('real shortcut ownership', () => {
  const hotkey = { enabled: true, registered: true, accelerator: 'CommandOrControl+Alt+Shift+R' };
  it('refuses to send keys when another app instance appears or registration was lost', () => {
    expect(() => safeCaptureShortcut(123, [123, 456], hotkey)).toThrow('Another');
    expect(() => safeCaptureShortcut(123, [456], hotkey)).toThrow('Another');
    expect(() => safeCaptureShortcut(123, [123], { ...hotkey, registered: false })).toThrow('does not own');
    expect(() => safeCaptureShortcut(123, [123], { ...hotkey, enabled: false })).toThrow('does not own');
    expect(() => safeCaptureShortcut(123, [123], null)).toThrow('does not own');
  });
  it('uses only the registered combination of the sole fixture', () => {
    expect(safeCaptureShortcut(123, [123], hotkey)).toBe(hotkey.accelerator);
  });
});


describe('acceptance output usage', () => {
  it('refuses an existing evidence directory and preserves its content without running an app', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recordstuff-existing-evidence-'));
    try {
      const marker = path.join(dir, 'keep.txt'); fs.writeFileSync(marker, 'existing evidence');
      expect(() => createAcceptanceOutput(dir)).toThrow();
      expect(fs.readFileSync(marker, 'utf8')).toBe('existing evidence');
      expect(fs.readdirSync(dir)).toEqual(['keep.txt']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('recording lock contract', () => {
  const context: AppContext = {
    platform: 'darwin', outputDir: '/tmp/recordings', homeDir: '/tmp', quality: DEFAULT_QUALITY, countdown: 3, language: 'en',
    hotkey: { ...DEFAULT_HOTKEY, registered: true }, updates: { state: { kind: 'idle' }, enabled: true },
    notifications: true, displays: [], display: { kind: 'primary' },
  };
  const recording: RecordingState = { type: 'recording', startedAt: '2026-09-26T00:00:00Z' };
  const offered: UpdateState = { kind: 'available', version: '2.0.0' };
  // Snapshots come from the production projections; the expectations come from product intent.
  const snap = (state: RecordingState, ctx: AppContext = context): LockSnapshot =>
    structuredClone({ recording: state, model: trayModel(state, ctx), settings: settingsView(state, ctx) });
  const group = (s: LockSnapshot, id: string) => s.settings.groups.find(g => g.id === id)!;
  const withUpdate = (state: UpdateState): AppContext => ({ ...context, updates: { state, enabled: true } });

  it('accepts real recording snapshots in both languages for every update state', () => {
    const states: UpdateState[] = [{ kind: 'idle' }, { kind: 'checking' }, { kind: 'checking', previous: offered }, offered, { kind: 'failed' }, { kind: 'current', checkedAt: 0 }];
    for (const language of ['en', 'zh-TW'] as const) for (const state of states) {
      expect(() => assertLockContract(snap(recording, { ...withUpdate(state), language })), `${language} ${state.kind}`).not.toThrow();
    }
  });

  it('rejects a busy snapshot that leaves a capture, notification or update control usable', () => {
    for (const state of [recording, { type: 'starting' }, { type: 'countdown', remaining: 2 }, { type: 'stopping' }] as RecordingState[]) {
      for (const id of ['screen', 'countdown', 'videoQuality', 'resolutionCap', 'frameRate', 'hotkey', 'notifications', 'updateChecks', 'updates']) {
        const s = snap(state, withUpdate(offered)); group(s, id).enabled = true;
        expect(() => assertLockContract(s), `${state.type} ${id}`).toThrow(`settings group ${id} while ${state.type}`);
      }
    }
    // The offered download is enabled by itself; only the group lock keeps it out of reach.
    expect(group(snap(recording, withUpdate(offered)), 'updates').choices.find(c => c.id === 'open')?.enabled).toBe(true);
  });

  it('rejects a snapshot that locks language, appearance or an About link', () => {
    for (const id of ['language', 'appearance', 'about']) {
      const s = snap(recording); group(s, id).enabled = false;
      expect(() => assertLockContract(s)).toThrow(`settings group ${id} while recording`);
    }
    for (const [id, choice] of [['language', 'zh-TW'], ['appearance', 'dark'], ['about', 'website'], ['about', 'source']]) {
      const s = snap(recording); group(s, id!).choices.find(c => c.id === choice)!.enabled = false;
      expect(() => assertLockContract(s)).toThrow(`settings choice ${id}/${choice} while recording`);
    }
  });

  it('refuses a group without a lock policy and a policy group the panel no longer offers', () => {
    const added = snap({ type: 'idle' }); added.settings.groups.push({ ...group(added, 'appearance'), id: 'newPreference' });
    expect(() => assertLockContract(added)).toThrow('without a lock policy: newPreference');
    const removed = snap(recording); removed.settings.groups = removed.settings.groups.filter(g => g.id !== 'appearance');
    expect(() => assertLockContract(removed)).toThrow('no longer offered: appearance');
  });

  it('requires REC, one enabled Stop, a greyed folder change and no update item while recording', () => {
    const history = { id: 'f', code: 'disk_full' as const, detail: '', occurredAt: '2026-09-26T00:00:00Z', outcome: 'empty' as const, acknowledged: false };
    expect(() => assertLockContract(snap(recording, { ...context, recordingResults: [history] }))).not.toThrow();
    const cases: Array<[string, (s: LockSnapshot) => void]> = [
      ['tray title while recording', s => { s.model.title = ''; }],
      ['one enabled Stop', s => { s.model.menu = s.model.menu.filter(i => i.kind === 'separator' || i.action !== 'stop'); }],
      ['one enabled Stop', s => { for (const i of s.model.menu) if (i.kind === 'item' && i.action === 'stop') i.enabled = false; }],
      ['output folder change enabled while recording', s => { s.model.menu.push({ kind: 'item', label: 'Change output folder', enabled: true, action: 'changeOutputDir' }); }],
      ['tray update action while recording', s => { s.model.menu.push({ kind: 'item', label: 'Check for updates…', enabled: false, action: 'checkUpdates' }); }],
      ['tray update action while recording', s => { s.model.menu.push({ kind: 'item', label: 'Update available: 2.0.0', enabled: false }); }],
    ];
    for (const [message, mutate] of cases) {
      const s = snap(recording); mutate(s);
      expect(() => assertLockContract(s)).toThrow(message);
    }
  });

  it('applies starting, counting down and saving their own tray contract', () => {
    for (const state of [{ type: 'starting' }, { type: 'countdown', remaining: 3 }, { type: 'stopping' }] as RecordingState[]) {
      const type = state.type;
      expect(() => assertLockContract(snap(state))).not.toThrow();
      const rec = snap(state); rec.model.title = 'REC';
      expect(() => assertLockContract(rec)).toThrow(`tray title while ${type}`);
      const ellipsis = snap(state); ellipsis.model.title = '…';
      expect(() => assertLockContract(ellipsis)).toThrow(`tray title while ${type}`);
      const stop = snap(state); stop.model.menu.unshift({ kind: 'item', label: 'Stop', enabled: true, action: 'stop' });
      expect(() => assertLockContract(stop)).toThrow(`no Stop while ${type}`);
    }
  });

  it('requires a settled recorder to unlock every group without demanding every choice', () => {
    const settled: RecordingState[] = [{ type: 'idle' }, { type: 'needsPermission', needsRelaunch: false }, { type: 'needsPermission', needsRelaunch: true }];
    for (const state of settled) {
      expect(() => assertLockContract(snap(state, withUpdate(offered)))).not.toThrow();
      const s = snap(state); group(s, 'videoQuality').enabled = false;
      expect(() => assertLockContract(s)).toThrow(`settings group videoQuality while ${state.type}`);
    }
    // Choices a settled model disables for their own reasons stay outside the lock contract.
    const idle: RecordingState = { type: 'idle' };
    const partial = snap(idle, { ...withUpdate({ kind: 'checking' }), platform: 'win32', display: { kind: 'display', id: '9', label: 'Gone' } });
    expect(group(partial, 'updates').choices.find(c => c.id === 'check')?.enabled).toBe(false);
    expect(() => assertLockContract(partial)).not.toThrow();
  });
});
