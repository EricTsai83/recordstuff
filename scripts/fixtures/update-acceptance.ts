/** Only imported into a throwaway source copy by acceptance:updates. Never a production entry. */
import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Recorder } from '../../src/main/recorder';
import type { SettingsStore } from '../../src/main/settings';
import type { AppTray } from '../../src/main/tray';
import { trayModel, type TrayModel } from '../../src/main/tray-model';
import { settingsView } from '../../src/main/settings-model';
import type { AppAction, AppContext } from '../../src/main/ui-model';
import type { SettingsView } from '../../src/shared/settings-panel';
import { API_URL, DOWNLOAD_URL, FEED_URL, RELEASES_URL, fetchVersion, type UpdateChecker, type UpdateState } from '../../src/main/updates';
import type { RecordingState } from '../../src/shared/state';

export type Scenario = 'current' | 'newer' | 'older' | 'delayed' | 'offline' | 'http-fallback' | 'malformed' | 'prerelease' | 'architecture' | 'timeout';
export interface AcceptanceConfig { now: number; scenario: Scenario }
export interface AcceptanceSnapshot {
  pid: number; version: string; recording: RecordingState; update: UpdateState; model: TrayModel;
  /** What the settings window would show right now; the panel itself is not opened. */
  settings: SettingsView;
  hotkey: AppContext['hotkey'] | null;
  language: string; preference: { enabled: boolean; lastAttempt: number };
  calls: Array<{ url: string; scenario: Scenario }>; pending: number; aborted: number;
  opened: string[]; errors: string[];
}
interface Attached {
  recorder: Recorder; updates: UpdateChecker; settings: SettingsStore; tray: AppTray;
  handleAction: (action: AppAction) => Promise<void>;
}
export function configureAcceptance(dir: string) {
  const configPath = path.join(dir, 'config.json');
  let config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as AcceptanceConfig;
  const outputDir = path.join(dir, 'recordings');
  const userData = path.join(dir, 'user-data'), logs = path.join(dir, 'logs');
  for (const p of [outputDir, userData, logs, path.join(dir, 'requests'), path.join(dir, 'responses')]) fs.mkdirSync(p, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('logs', logs);
  const calls: AcceptanceSnapshot['calls'] = [];
  const opened: string[] = [], errors: string[] = [];
  let aborted = 0;
  const waiting = new Set<() => void>();
  const events = (value: unknown): void => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: Date.now(), ...value as object }) + '\n');
  shell.openExternal = async (url: string) => { opened.push(url); events({ type: 'open-external-intercepted', url }); };
  function persist(next: AcceptanceConfig): void {
    config = next;
    fs.writeFileSync(configPath, JSON.stringify(config));
  }
  const newer = `${BigInt(app.getVersion().split('.')[0]!) + 1n}.0.0`;
  function response(url: string, scenario: Scenario): Response {
    const version = scenario === 'older' ? '0.0.0' : ['newer', 'delayed'].includes(scenario) ? newer : app.getVersion();
    if (scenario === 'offline') throw new Error('acceptance: simulated offline');
    if (scenario === 'http-fallback' && url === FEED_URL) return new Response('', { status: 503 });
    if (scenario === 'malformed') return Response.json({});
    const actualVersion = scenario === 'prerelease' ? `${newer}-beta.1` : version;
    const arch = scenario === 'architecture' ? 'other' : process.arch;
    if (url === API_URL) return Response.json({ tag_name: `v${actualVersion}`, draft: false, prerelease: scenario === 'prerelease', assets: [{ name: `RecordStuff-${actualVersion}-${arch}-selfsigned.dmg` }] });
    if (url !== FEED_URL) throw new Error(`unexpected request ${url}`);
    return Response.json({ version: actualVersion, tag: `v${actualVersion}`, platform: `${process.platform}-${arch}`, architecture: arch,
      publishedAt: '2026-09-20T00:00:00Z', downloadUrl: DOWNLOAD_URL, releaseUrl: `${RELEASES_URL}/tag/v${actualVersion}`,
      dmg: { name: `RecordStuff-${actualVersion}-${arch}-selfsigned.dmg`, size: 123, sha256: 'a'.repeat(64) } });
  }
  async function request(url: string, init: RequestInit): Promise<Response> {
    const scenario = config.scenario;
    calls.push({ url, scenario }); events({ type: 'request', url, scenario });
    if (scenario === 'delayed' || scenario === 'timeout') {
      await new Promise<void>((resolve, reject) => {
        const signal = init.signal!;
        signal.throwIfAborted();
        const release = (): void => { waiting.delete(release); signal.removeEventListener('abort', abort); resolve(); };
        const abort = (): void => { waiting.delete(release); signal.removeEventListener('abort', abort); aborted++; events({ type: 'request-aborted' }); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        if (scenario === 'delayed') waiting.add(release);
      });
    }
    return response(url, scenario);
  }
  return {
    dir, outputDir, config: () => config, now: () => config.now,
    fetch: (signal: AbortSignal) => fetchVersion(process.platform, process.arch, signal, request),
    set: persist, release: () => { for (const release of [...waiting]) release(); },
    calls, opened, errors, pending: () => waiting.size, aborted: () => aborted, events,
  };
}
export function attachAcceptance(a: ReturnType<typeof configureAcceptance>, attached: Attached): void {
  const { recorder, updates, settings, tray, handleAction } = attached;
  // Notification delivery has its own acceptance runner. Do not let a save banner obscure the next capture's marker.
  tray.notifySaved = (savedPath: string) => a.events({ type: 'saved-notification-intercepted', path: savedPath });
  // Read the real AppTray context, not a second reconstruction of the production settings wiring.
  const context = (): AppContext => (tray as unknown as { options: { context: () => AppContext } }).options.context();
  const snapshot = (): AcceptanceSnapshot => ({
    pid: process.pid, version: app.getVersion(), recording: recorder.state, update: updates.state,
    model: trayModel(recorder.state, context()), settings: settingsView(recorder.state, context()),
    hotkey: context().hotkey ?? null, language: settings.language, preference: settings.updates,
    calls: [...a.calls], pending: a.pending(), aborted: a.aborted(), opened: [...a.opened], errors: [...a.errors],
  });
  recorder.subscribe(event => { if (event.type === 'state' || event.type === 'saved') a.events({ type: 'recorder', event }); });
  const seen = new Set(fs.readdirSync(path.join(a.dir, 'requests')));
  const timer = setInterval(() => {
    for (const name of fs.readdirSync(path.join(a.dir, 'requests'))) {
      if (!/^\d+\.json$/.test(name) || seen.has(name)) continue;
      seen.add(name);
      void (async () => {
        try {
          const command = JSON.parse(fs.readFileSync(path.join(a.dir, 'requests', name), 'utf8')) as { kind: string; action?: AppAction; config?: AcceptanceConfig };
          switch (command.kind) {
            case 'snapshot': break;
            case 'configure': if (!command.config) throw new Error('missing config'); a.set(command.config); break;
            case 'release': a.release(); break;
            case 'action': {
              if (!command.action) throw new Error('missing action');
              // Uses the production action handler. This does NOT claim a macOS click.
              const result = handleAction(command.action);
              if (command.action === 'checkUpdates') void result.catch(error => a.errors.push(String(error)));
              else await result;
              break;
            }
            case 'quit': break;
            default: throw new Error('unknown command');
          }
          const target = path.join(a.dir, 'responses', name);
          fs.writeFileSync(target + '.tmp', JSON.stringify({ ok: true, snapshot: snapshot() }));
          fs.renameSync(target + '.tmp', target);
          if (command.kind === 'quit') setImmediate(() => app.quit());
        } catch (error) {
          a.errors.push(String(error));
          const target = path.join(a.dir, 'responses', name);
          fs.writeFileSync(target + '.tmp', JSON.stringify({ ok: false, error: String(error) }));
          fs.renameSync(target + '.tmp', target);
        }
      })();
    }
  }, 25);
  app.on('will-quit', () => {
    clearInterval(timer);
    fs.writeFileSync(path.join(a.dir, 'stopped.json.tmp'), JSON.stringify(snapshot()));
    fs.renameSync(path.join(a.dir, 'stopped.json.tmp'), path.join(a.dir, 'stopped.json'));
  });
  fs.writeFileSync(path.join(a.dir, 'ready.json.tmp'), JSON.stringify(snapshot()));
  fs.renameSync(path.join(a.dir, 'ready.json.tmp'), path.join(a.dir, 'ready.json'));
}
