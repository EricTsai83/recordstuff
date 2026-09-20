import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { instrumentUpdateAcceptance, acceptanceExitCode, safeCaptureShortcut, createAcceptanceOutput, type CaseResult } from './lib/update-acceptance.mts';

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
    expect(() => instrumentUpdateAcceptance(source.replace('show: (savedPath) => tray.notifySaved(savedPath),', 'show: otherNotificationPath,'), '/tmp/test')).toThrow('anchor changed');
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
