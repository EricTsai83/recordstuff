/** Build-only instrumentation. No production module imports this file or the fixture. */
import fs from "node:fs";
import path from "node:path";

function replaceOnce(source: string, from: string, to: string): string {
  if (source.split(from).length !== 2) throw new Error(`Acceptance source anchor changed: ${from}`);
  return source.replace(from, to);
}
export function instrumentUpdateAcceptance(source: string, runDir: string): string {
  source = replaceOnce(source, 'let currentLanguage: Language = DEFAULT_LANGUAGE;',
    `import { configureAcceptance, attachAcceptance } from "../../scripts/fixtures/update-acceptance";\nconst acceptance = configureAcceptance(${JSON.stringify(runDir)});\nlet currentLanguage: Language = DEFAULT_LANGUAGE;`);
  source = replaceOnce(source, 'defaultOutputDir: defaultOutputDir(),', 'defaultOutputDir: acceptance.outputDir || defaultOutputDir(),');
  source = replaceOnce(source, 'localVersion: app.getVersion(), settled,', 'localVersion: app.getVersion(), settled, now: acceptance.now,');
  source = replaceOnce(source, 'fetch: (signal) => fetchVersion(process.platform, process.arch, signal, (url, init) => net.fetch(url, init)),',
    'fetch: (signal) => acceptance.fetch(signal),');
  // Remove only the now-unused production imports from this throwaway copy.
  source = replaceOnce(source, '  net,\n', '');
  source = replaceOnce(source, 'UpdateChecker, fetchVersion, DOWNLOAD_URL', 'UpdateChecker, DOWNLOAD_URL');
  source = replaceOnce(source, '  updates.flush();\n  log(`ready;',
    '  attachAcceptance(acceptance, { recorder, updates, settings, tray, handleAction });\n  updates.flush();\n  log(`ready;');
  // The fixture intercepts this exact lazy call; stop if production bypasses it.
  source = replaceOnce(source, 'show: (savedPath) => tray.notifySaved(savedPath),', 'show: (savedPath) => tray.notifySaved(savedPath),');
  return source;
}
export function prepareUpdateAcceptance(root: string, workspace: string, runDir: string): void {
  for (const name of ['src', 'resources', 'build', 'scripts']) fs.cpSync(path.join(root, name), path.join(workspace, name), { recursive: true });
  for (const name of ['package.json', 'pnpm-lock.yaml', 'electron-builder.yml', 'electron-builder.local.yml', 'electron.vite.config.ts', 'tsconfig.node.json', 'tsconfig.web.json', 'tsconfig.base.json']) {
    fs.copyFileSync(path.join(root, name), path.join(workspace, name));
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
  const entry = path.join(workspace, 'src/main/index.ts');
  fs.writeFileSync(entry, instrumentUpdateAcceptance(fs.readFileSync(entry, 'utf8'), runDir));
}
export type CaseResult = { name: string; status: 'pass' | 'fail' | 'blocked' | 'not-run'; detail: string; required: boolean };
export function acceptanceExitCode(cases: CaseResult[]): number {
  if (cases.some(c => c.required && c.status === 'fail')) return 1;
  if (!cases.some(c => c.required) || cases.some(c => c.required && c.status !== 'pass')) return 2;
  return 0;
}

/** Do not send a system-wide shortcut unless it belongs to our sole fixture process. */
export function safeCaptureShortcut(pid: number, runningPids: number[], hotkey: { enabled: boolean; registered: boolean; accelerator: string } | null | undefined): string {
  if (runningPids.length !== 1 || runningPids[0] !== pid) throw new Error('Another RecordStuff process appeared; refusing global input.');
  if (!hotkey?.enabled || !hotkey.registered) throw new Error('Fixture does not own its recording shortcut.');
  return hotkey.accelerator;
}

/** Refuse existing evidence without invoking any app/build work. */
export function createAcceptanceOutput(dir: string): void {
  fs.mkdirSync(dir);
}
